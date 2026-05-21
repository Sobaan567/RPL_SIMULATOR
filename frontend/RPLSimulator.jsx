import { useState, useEffect, useRef } from "react";

const BATTERY_CAP = 100;
const INF = 9999;
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function makeNode(id, x, y, is_root = false) {
  return {
    id, x, y, is_root,
    rank: is_root ? 0 : INF,
    parent: null, children: [],
    energy: BATTERY_CAP, energy_pct: BATTERY_CAP,
    joined: is_root, flags: [],
    traffic_rx: 0, traffic_tx: 0, etx: 1,
    r: 22, pulse: 0,
    ipv6: `fd00::${id.replace(/[^0-9a-fA-F]/g,"").padStart(4,"0").slice(-4)}`,
  };
}

const DEFAULT_NODES = (W, H) => {
  const cx = W / 2, cy = H / 2;
  return [
    { id: "0x0001", x: cx,        y: 75,       is_root: true },
    { id: "0x0002", x: cx - 185,  y: 205 },
    { id: "0x0003", x: cx,        y: 195 },
    { id: "0x0004", x: cx + 185,  y: 205 },
    { id: "0x0005", x: cx - 270,  y: 335 },
    { id: "0x0006", x: cx - 110,  y: 340 },
    { id: "0x0007", x: cx + 80,   y: 340 },
    { id: "0x0008", x: cx + 265,  y: 335 },
    { id: "0x0009", x: cx - 190,  y: 460 },
    { id: "0x000A", x: cx + 25,   y: 465 },
    { id: "0x000B", x: cx + 215,  y: 460 },
  ];
};

// ── Build execution log waves from BFS result ──
function buildExecutionLog(steps, nodeMap, of_mode) {
  // Group steps into BFS waves
  const waves = [];
  const ranks = {};
  Object.values(nodeMap).forEach(n => { ranks[n.id] = n.is_root ? 0 : INF; });

  // wave = all steps from nodes at the same rank level
  const processed = new Set();
  let waveSteps = [];
  let currentSenders = new Set(Object.values(nodeMap).filter(n => n.is_root).map(n => n.id));

  let allSteps = [...steps];
  let waveNum = 1;

  while (allSteps.length > 0) {
    const waveItems = allSteps.filter(s => currentSenders.has(s.from));
    allSteps = allSteps.filter(s => !currentSenders.has(s.from));

    if (waveItems.length === 0) break;

    // Separate improvements from no-improvements
    const improvements = [];
    const noImprov = [];
    const nextSenders = new Set();
    const waveSimRanks = { ...ranks };

    waveItems.forEach(s => {
      const senderRank = waveSimRanks[s.from] ?? INF;
      const proposed = of_mode === "hop" ? senderRank + 1 : +(senderRank + 1).toFixed(2);
      if (proposed < (waveSimRanks[s.to] ?? INF)) {
        waveSimRanks[s.to] = proposed;
        improvements.push({ from: s.from, to: s.to, rank: proposed });
        nextSenders.add(s.to);
      } else {
        noImprov.push({ from: s.from, to: s.to });
      }
    });

    // Update ranks for next wave
    Object.assign(ranks, waveSimRanks);

    waves.push({ wave: waveNum++, improvements, noImprov, type: "DIO" });
    currentSenders = nextSenders;
    if (currentSenders.size === 0) break;
  }

  // DAO phase — reversed: leaves → root
  const daoWaves = [];
  const joined = Object.values(nodeMap).filter(n => !n.is_root);

  // Group by rank level descending
  const byRank = {};
  joined.forEach(n => {
    const r = ranks[n.id];
    if (r !== INF) { if (!byRank[r]) byRank[r] = []; byRank[r].push(n.id); }
  });
  const sortedRanks = Object.keys(byRank).map(Number).sort((a, b) => b - a);

  sortedRanks.forEach((r, i) => {
    const nodes = byRank[r];
    // find their parents
    const daoMsgs = nodes.map(nid => {
      // find parent from improvements
      let parentId = null;
      waves.forEach(w => w.improvements.forEach(imp => { if (imp.to === nid) parentId = imp.from; }));
      return { node: nid, parent: parentId || "root" };
    });
    daoWaves.push({ wave: waves.length + i + 1, msgs: daoMsgs, type: "DAO" });
  });

  // Final DONE step
  const done = { wave: waves.length + daoWaves.length + 1, type: "DONE" };

  return [...waves, ...daoWaves, done];
}

export default function RPLSimulator() {
  const cvRef   = useRef(null);
  const areaRef = useRef(null);
  const dragRef = useRef(null);
  const dragOff = useRef({ x: 0, y: 0 });
  const nodesRef = useRef([]);
  const stepsRef = useRef([]);
  const stepIdxRef = useRef(0);
  const animTimerRef = useRef(null);

  const [nodes,      setNodes]      = useState([]);
  const [pkts,       setPkts]       = useState([]);
  const [ripples,    setRipples]    = useState([]);
  const [selNode,    setSelNode]    = useState(null);
  const [hovNode,    setHovNode]    = useState(null);
  const [phase,      setPhase]      = useState("idle");
  const [ofMode,     setOfMode]     = useState("hop");
  const [mode,       setMode]       = useState("sel");
  const [showRange,  setShowRange]  = useState(true);
  const [showLinks,  setShowLinks]  = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [showETX,    setShowETX]    = useState(false);
  const [simRunning, setSimRunning] = useState(false);
  const [speed,      setSpeed]      = useState(5);
  const [hotspots,   setHotspots]   = useState([]);
  const [analytics,  setAnalytics]  = useState(null);
  const [actions,    setActions]    = useState([]);
  const [activeTab,  setActiveTab]  = useState("nodes");
  const [dioCount,   setDioCount]   = useState(0);
  const [daoCount,   setDaoCount]   = useState(0);
  const [stepCount,  setStepCount]  = useState(0);
  const [radioRange, setRadioRange] = useState(200);
  const [nodeCounter,setNodeCounter]= useState(12);
  // Execution log
  const [execLog,    setExecLog]    = useState([]);   // array of wave objects
  const [activeStep, setActiveStep] = useState(null); // highlighted step index
  const execLogRef = useRef(null);

  useEffect(() => { nodesRef.current = nodes; }, [nodes]);

  function addEvt(entries) {
    // entries can be string or {msg,lvl}
  }

  function initNodes() {
    const cv = cvRef.current;
    const W = cv?.offsetWidth || 680, H = cv?.offsetHeight || 560;
    const ns = DEFAULT_NODES(W, H).map(r => makeNode(r.id, r.x, r.y, r.is_root || false));
    setNodes(ns); resetStats();
  }

  function resetStats() {
    setPhase("idle"); setHotspots([]); setActions([]);
    setPkts([]); setRipples([]); setAnalytics(null);
    setDioCount(0); setDaoCount(0); setStepCount(0);
    setExecLog([]); setActiveStep(null);
    stepsRef.current = []; stepIdxRef.current = 0;
    setSimRunning(false);
    if (animTimerRef.current) { clearInterval(animTimerRef.current); animTimerRef.current = null; }
  }

  useEffect(() => { setTimeout(initNodes, 120); }, []);

  function resetDodag() {
    if (animTimerRef.current) { clearInterval(animTimerRef.current); animTimerRef.current = null; }
    setNodes(p => p.map(n => ({ ...n, rank: n.is_root ? 0 : INF, parent: null, children: [], joined: n.is_root, flags: [], traffic_rx: 0, traffic_tx: 0, etx: 1, pulse: 0 })));
    resetStats();
  }

  function calcRank(s, r) {
    if (ofMode === "hop") return s.rank + 1;
    const d = dist(s, r) / radioRange;
    return +(s.rank + 1 + 2.4 * d * d).toFixed(2);
  }
  function calcETX(s, r) {
    const d = dist(s, r) / radioRange;
    return +(1 + 2.4 * d * d).toFixed(2);
  }

  function buildSteps(ns) {
    const roots = ns.filter(n => n.is_root);
    const visited = new Set(roots.map(r => r.id));
    const q = [...roots], steps = [];
    while (q.length) {
      const s = q.shift();
      ns.filter(o => o.id !== s.id && dist(s, o) < radioRange).forEach(nb => {
        steps.push({ from: s.id, to: nb.id });
        if (!visited.has(nb.id)) { visited.add(nb.id); q.push(nb); }
      });
    }
    return steps;
  }

  function execStep(steps, ns) {
    if (stepIdxRef.current >= steps.length) return null;
    const { from, to } = steps[stepIdxRef.current++];
    const s = ns.find(n => n.id === from), r = ns.find(n => n.id === to);
    if (!s || !r) return { from, to, improved: false };
    const nr = calcRank(s, r);
    const improved = nr < r.rank;
    if (improved) {
      if (r.parent) { const op = ns.find(n => n.id === r.parent); if (op) op.children = op.children.filter(c => c !== r.id); }
      r.rank = nr; r.parent = s.id; r.joined = true; r.pulse = Date.now();
      r.etx = calcETX(s, r);
      if (!s.children.includes(r.id)) s.children.push(r.id);
      s.energy = Math.max(0, s.energy - 0.06); r.energy = Math.max(0, r.energy - 0.025);
      s.energy_pct = +s.energy.toFixed(1); r.energy_pct = +r.energy.toFixed(1);
      s.traffic_tx++; r.traffic_rx++;
    }
    return { from, to, improved, rank: r.rank };
  }

  function spawnPkt(fromId, toId, color, label) {
    const ns = nodesRef.current;
    const s = ns.find(n => n.id === fromId), r = ns.find(n => n.id === toId);
    if (!s || !r) return;
    const pid = Math.random();
    setPkts(p => [...p, { id: pid, fx: s.x, fy: s.y, tx: r.x, ty: r.y, t: 0, color, label }]);
    setTimeout(() => setPkts(p => p.filter(x => x.id !== pid)), 1000);
  }

  function spawnRipple(x, y, color) {
    const rid = Math.random();
    setRipples(p => [...p, { id: rid, x, y, t: 0, color }]);
    setTimeout(() => setRipples(p => p.filter(r => r.id !== rid)), 700);
  }

  // ── Generate full execution log upfront ──
  function generateExecLog(ns) {
    const nodeMap = {};
    ns.forEach(n => { nodeMap[n.id] = { ...n }; });
    const steps = buildSteps(ns);
    return buildExecutionLog(steps, nodeMap, ofMode);
  }

  function animate() {
    if (simRunning) return;
    resetDodag();
    setTimeout(() => {
      const ns = nodesRef.current.map(n => ({ ...n }));
      const steps = buildSteps(ns);
      stepsRef.current = steps; stepIdxRef.current = 0;

      // Generate execution log
      const log = generateExecLog(nodesRef.current);
      setExecLog(log);
      setActiveStep(0);

      setPhase("building"); setSimRunning(true);
      const delay = Math.max(55, 280 - speed * 24);
      let waveTracker = 0;

      animTimerRef.current = setInterval(() => {
        if (stepIdxRef.current >= steps.length) {
          clearInterval(animTimerRef.current); animTimerRef.current = null;
          setSimRunning(false); setPhase("done");
          // highlight DAO steps
          setActiveStep(prev => prev !== null ? prev + 1 : null);
          setTimeout(() => {
            const cur = nodesRef.current;
            cur.forEach((n, i) => {
              if (n.parent) setTimeout(() => { spawnPkt(n.id, n.parent, "#f59e0b", "DAO"); setDaoCount(c => c + 1); }, i * 85);
            });
            computeAnalytics(cur); detectHotspots(cur);
            // mark DONE step
            setActiveStep(log.length - 1);
          }, 300);
          return;
        }
        const result = execStep(stepsRef.current, ns);
        if (result?.improved) {
          spawnPkt(result.from, result.to, "#3b82f6", "DIO");
          const rn = ns.find(n => n.id === result.to);
          if (rn) spawnRipple(rn.x, rn.y, "#22c55e");
        } else if (result) {
          spawnPkt(result.from, result.to, "#1e3a5f", "DIO");
        }
        setNodes([...ns]);
        setDioCount(c => c + 1); setStepCount(c => c + 1);
      }, delay);
    }, 80);
  }

  function stepOne() {
    if (phase === "idle") {
      const ns = nodesRef.current.map(n => ({ ...n }));
      stepsRef.current = buildSteps(ns); stepIdxRef.current = 0;
      const log = generateExecLog(nodesRef.current);
      setExecLog(log); setActiveStep(0);
      setPhase("building");
    }
    const ns = nodesRef.current.map(n => ({ ...n }));
    if (stepIdxRef.current >= stepsRef.current.length) {
      setPhase("done"); computeAnalytics(ns); detectHotspots(ns);
      setActiveStep(prev => execLog.length - 1);
      return;
    }
    const result = execStep(stepsRef.current, ns);
    spawnPkt(result?.from || "", result?.to || "", result?.improved ? "#3b82f6" : "#1e3a5f", "DIO");
    if (result?.improved) {
      const rn = ns.find(n => n.id === result.to);
      if (rn) spawnRipple(rn.x, rn.y, "#22c55e");
    }
    setNodes([...ns]);
    setDioCount(c => c + 1); setStepCount(c => c + 1);
    // advance active step
    setActiveStep(prev => Math.min((prev || 0) + 1, execLog.length - 1));
  }

  function computeAnalytics(ns) {
    const total = ns.length, joined = ns.filter(n => n.joined || n.is_root).length;
    const energies = ns.map(n => n.energy);
    const avgE = energies.reduce((a, b) => a + b, 0) / energies.length;
    const ranked = ns.filter(n => n.rank !== INF).map(n => n.rank);
    const avgR = ranked.length ? ranked.reduce((a, b) => a + b, 0) / ranked.length : 0;
    const hs = ns.filter(n => { const t = n.traffic_rx + n.traffic_tx; return t > 0 && n.traffic_rx / t > 0.6; });
    const crit = ns.filter(n => n.energy < 15 && !n.is_root);
    const health = Math.round((joined / total * 40) + (avgE / BATTERY_CAP * 35) + Math.max(0, 25 - hs.length * 8));
    setAnalytics({ joined, total, joinPct: +(joined / total * 100).toFixed(1), avgEnergy: +avgE.toFixed(1), minEnergy: +Math.min(...energies).toFixed(1), hotspotCount: hs.length, criticalCount: crit.length, avgRank: +avgR.toFixed(2), maxRank: ranked.length ? Math.max(...ranked) : 0, health });
  }

  function detectHotspots(ns) {
    const hs = ns.filter(n => {
      const t = n.traffic_rx + n.traffic_tx;
      return (t > 0 && n.traffic_rx / t > 0.6) || (n.energy < 15 && !n.is_root);
    }).map(n => ({
      node_id: n.id,
      flags: [
        ...((t => t > 0 && n.traffic_rx / t > 0.6 ? ["hotspot"] : [])(n.traffic_rx + n.traffic_tx)),
        ...(n.energy < 15 && !n.is_root ? ["low_energy"] : []),
      ],
      traffic_rx: n.traffic_rx, energy_pct: +n.energy.toFixed(1), children: n.children.length,
    }));
    setHotspots(hs);
  }

  function resolveIssues() {
    const acts = [];
    setNodes(prev => {
      const copy = prev.map(n => ({ ...n }));
      hotspots.forEach(h => {
        const node = copy.find(n => n.id === h.node_id);
        if (!node || node.is_root) return;
        const toMove = h.flags.includes("low_energy") ? [...node.children] : node.children.slice(0, Math.ceil(node.children.length / 2));
        toMove.forEach(cid => {
          const child = copy.find(n => n.id === cid); if (!child) return;
          const candidates = copy.filter(o => o.id !== node.id && o.id !== cid && dist(child, o) < radioRange && o.rank !== INF && o.energy > 20);
          if (!candidates.length) return;
          const best = candidates.reduce((a, b) => calcRank(a, child) < calcRank(b, child) ? a : b);
          node.children = node.children.filter(c => c !== cid);
          child.parent = best.id; child.rank = calcRank(best, child);
          if (!best.children.includes(cid)) best.children.push(cid);
          acts.push({ child: cid, from: node.id, to: best.id, reason: h.flags[0] });
        });
      });
      return copy;
    });
    setActions(acts);
    setTimeout(() => { computeAnalytics(nodesRef.current); detectHotspots(nodesRef.current); }, 200);
    // Append resolution steps to exec log
    if (acts.length) {
      const resEntry = {
        wave: execLog.length + 1, type: "FIX",
        msgs: acts.map(a => ({ node: a.child, from: a.from, to: a.to, reason: a.reason })),
      };
      setExecLog(p => [...p, resEntry]);
      setActiveStep(execLog.length);
    }
  }

  function drainEnergy() {
    setNodes(prev => prev.map(n => {
      const drain = n.children.length * 0.9 + Math.random() * 0.6 + 0.3;
      const newE = Math.max(0, n.energy - drain);
      return { ...n, energy: newE, energy_pct: +newE.toFixed(1), traffic_rx: n.traffic_rx + n.children.length, traffic_tx: n.traffic_tx + 1 };
    }));
    setTimeout(() => { detectHotspots(nodesRef.current); computeAnalytics(nodesRef.current); }, 200);
    const drainEntry = { wave: execLog.length + 1, type: "DRAIN", msg: "Energy drain cycle simulated. Traffic load increased on relay nodes." };
    setExecLog(p => [...p, drainEntry]);
    setActiveStep(execLog.length);
  }

  function addNodeClick() {
    const cv = cvRef.current;
    const W = cv?.offsetWidth || 680, H = cv?.offsetHeight || 560;
    const id = `0x${nodeCounter.toString(16).toUpperCase().padStart(4, "0")}`;
    const angle = Math.random() * Math.PI * 2, r = 80 + Math.random() * 180;
    setNodes(p => [...p, makeNode(id, Math.max(40, Math.min(W - 40, W / 2 + Math.cos(angle) * r)), Math.max(40, Math.min(H - 40, H / 2 + Math.sin(angle) * r)))]);
    setNodeCounter(c => c + 1);
  }

  // ── CANVAS DRAW ──
  useEffect(() => {
    const cv = cvRef.current; if (!cv) return;
    const ctx = cv.getContext("2d");
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#060d1a"; ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = "rgba(59,130,246,0.05)"; ctx.lineWidth = 0.5;
    for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

    ripples.forEach(rp => {
      ctx.save(); ctx.globalAlpha = (1 - rp.t) * 0.55;
      ctx.beginPath(); ctx.arc(rp.x, rp.y, 18 + rp.t * 38, 0, Math.PI * 2);
      ctx.strokeStyle = rp.color; ctx.lineWidth = 2; ctx.stroke(); ctx.restore();
    });

    if (showRange) {
      const hl = (selNode ? nodes.find(n => n.id === selNode.id) : null) || hovNode;
      if (hl) {
        ctx.save();
        const grad = ctx.createRadialGradient(hl.x, hl.y, 0, hl.x, hl.y, radioRange);
        grad.addColorStop(0, "rgba(59,130,246,0.06)"); grad.addColorStop(1, "rgba(59,130,246,0)");
        ctx.beginPath(); ctx.arc(hl.x, hl.y, radioRange, 0, Math.PI * 2);
        ctx.fillStyle = grad; ctx.fill();
        ctx.setLineDash([6, 4]); ctx.lineWidth = 1; ctx.strokeStyle = "rgba(59,130,246,0.4)"; ctx.stroke();
        ctx.restore();
      }
    }

    if (showLinks) {
      ctx.save(); ctx.setLineDash([2, 6]); ctx.lineWidth = 0.6;
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        if (dist(nodes[i], nodes[j]) < radioRange) {
          ctx.strokeStyle = "rgba(59,130,246,0.1)";
          ctx.beginPath(); ctx.moveTo(nodes[i].x, nodes[i].y); ctx.lineTo(nodes[j].x, nodes[j].y); ctx.stroke();
        }
      }
      ctx.restore();
    }

    nodes.forEach(n => {
      if (!n.parent) return;
      const par = nodes.find(x => x.id === n.parent); if (!par) return;
      const ang = Math.atan2(par.y - n.y, par.x - n.x);
      const sx = n.x + Math.cos(ang) * (n.r + 2), sy = n.y + Math.sin(ang) * (n.r + 2);
      const tx = par.x - Math.cos(ang) * (par.r + 3), ty = par.y - Math.sin(ang) * (par.r + 3);
      const isIssue = hotspots.some(h => h.node_id === par.id);
      const lc = isIssue ? "#f59e0b" : "#22c55e";
      ctx.save(); ctx.setLineDash([]);
      ctx.shadowColor = lc; ctx.shadowBlur = 5; ctx.lineWidth = 2; ctx.strokeStyle = lc;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(tx, ty); ctx.stroke();
      const ax = tx - Math.cos(ang), ay = ty - Math.sin(ang);
      ctx.beginPath(); ctx.moveTo(ax, ay);
      ctx.lineTo(ax - Math.cos(ang - .42) * 9, ay - Math.sin(ang - .42) * 9);
      ctx.lineTo(ax - Math.cos(ang + .42) * 9, ay - Math.sin(ang + .42) * 9);
      ctx.closePath(); ctx.fillStyle = lc; ctx.fill(); ctx.shadowBlur = 0;
      if (showETX && n.rank !== INF) {
        ctx.font = "9px monospace"; ctx.fillStyle = "#64748b";
        ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ctx.fillText(n.etx?.toFixed(2), (sx + tx) / 2, (sy + ty) / 2 - 3);
      }
      ctx.restore();
    });

    pkts.forEach(p => {
      const ease = p.t < .5 ? 2 * p.t * p.t : 1 - 2 * (1 - p.t) * (1 - p.t);
      const px = p.fx + (p.tx - p.fx) * ease, py = p.fy + (p.ty - p.fy) * ease;
      const al = p.t < .12 ? p.t / .12 : p.t > .82 ? (1 - p.t) / .18 : 1;
      ctx.save(); ctx.globalAlpha = al;
      ctx.shadowColor = p.color; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.fillStyle = p.color; ctx.fill();
      ctx.shadowBlur = 0;
      ctx.font = "bold 7px sans-serif"; ctx.fillStyle = "#fff";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(p.label, px, py); ctx.restore();
    });

    const now = Date.now();
    nodes.forEach(n => {
      const nr = n.r;
      const isHs = hotspots.some(h => h.node_id === n.id && h.flags?.includes("hotspot"));
      const isCrit = hotspots.some(h => h.node_id === n.id && h.flags?.includes("low_energy"));
      const isSel = selNode?.id === n.id, isHov = hovNode?.id === n.id && !isSel;
      const pAge = (now - (n.pulse || 0)) / 650;
      let col = n.is_root ? "#ef4444" : n.joined ? "#22c55e" : "#334155";
      if (isHs) col = "#f59e0b"; if (isCrit) col = "#ef4444";

      ctx.save();
      if (pAge < 1 && n.pulse) {
        ctx.globalAlpha = (1 - pAge) * 0.35;
        ctx.beginPath(); ctx.arc(n.x, n.y, nr + 15 * (1 - pAge), 0, Math.PI * 2);
        ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;
      }
      ctx.shadowColor = col;
      ctx.shadowBlur = isSel ? 22 : isHov ? 14 : (n.joined || n.is_root) ? 8 : 3;
      if (!n.is_root) {
        const ep = n.energy_pct / BATTERY_CAP;
        ctx.beginPath(); ctx.arc(n.x, n.y, nr + 5, -Math.PI / 2, -Math.PI / 2 + ep * Math.PI * 2);
        ctx.strokeStyle = ep > 0.5 ? "#22c55e" : ep > 0.25 ? "#f59e0b" : "#ef4444";
        ctx.lineWidth = 3; ctx.setLineDash([]); ctx.shadowBlur = 0; ctx.stroke();
      }
      if (isSel) {
        ctx.beginPath(); ctx.arc(n.x, n.y, nr + 9, 0, Math.PI * 2);
        ctx.strokeStyle = "#60a5fa"; ctx.lineWidth = 2; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
      }
      const g = ctx.createRadialGradient(n.x - nr * .3, n.y - nr * .3, 2, n.x, n.y, nr);
      if (isHs)        { g.addColorStop(0, "#fcd34d"); g.addColorStop(1, "#d97706"); }
      else if (isCrit) { g.addColorStop(0, "#f87171"); g.addColorStop(1, "#dc2626"); }
      else if (n.is_root) { g.addColorStop(0, "#ff6b6b"); g.addColorStop(1, "#dc2626"); }
      else if (n.joined)  { g.addColorStop(0, "#4ade80"); g.addColorStop(1, "#15803d"); }
      else { g.addColorStop(0, "#475569"); g.addColorStop(1, "#1e293b"); }
      ctx.beginPath(); ctx.arc(n.x, n.y, nr, 0, Math.PI * 2);
      ctx.fillStyle = g; ctx.fill();
      ctx.strokeStyle = isSel ? "#60a5fa" : col + "cc"; ctx.lineWidth = 1.5; ctx.setLineDash([]); ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.font = n.is_root ? "bold 13px sans-serif" : "bold 11px monospace";
      ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(n.is_root ? "R" : n.rank === INF ? "?" : ofMode === "hop" ? String(n.rank) : n.rank.toFixed(1), n.x, n.y);
      if (showLabels) {
        ctx.font = "9px monospace"; ctx.fillStyle = isSel ? "#93c5fd" : "#475569";
        ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText(n.id, n.x, n.y + nr + 4);
      }
      if (isHs || isCrit) { ctx.font = "12px sans-serif"; ctx.fillText(isCrit ? "⚡" : "🔥", n.x + nr * .8, n.y - nr * .8); }
      ctx.restore();
    });
  }, [nodes, selNode, hovNode, hotspots, showRange, showLinks, showLabels, showETX, ofMode, radioRange, pkts, ripples]);

  useEffect(() => {
    if (pkts.length) setPkts(p => p.map(x => ({ ...x, t: Math.min(1, x.t + 0.04) })));
    if (ripples.length) setRipples(p => p.map(x => ({ ...x, t: Math.min(1, x.t + 0.055) })).filter(x => x.t < 1));
  }, [pkts.length, ripples.length]);

  function resize() {
    const area = areaRef.current; if (!area) return;
    const r = area.getBoundingClientRect();
    if (cvRef.current) { cvRef.current.width = r.width; cvRef.current.height = r.height; }
  }
  useEffect(() => { resize(); window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, []);

  function getPos(e) {
    const cv = cvRef.current; const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (cv.width / r.width), y: (e.clientY - r.top) * (cv.height / r.height) };
  }
  function hitNode(x, y) { return nodesRef.current.slice().reverse().find(n => dist({ x, y }, n) < n.r + 8); }

  function onMouseMove(e) {
    const { x, y } = getPos(e);
    setHovNode(hitNode(x, y) || null);
    if (dragRef.current) setNodes(p => p.map(n => n.id === dragRef.current ? { ...n, x: x - dragOff.current.x, y: y - dragOff.current.y } : n));
    if (cvRef.current) cvRef.current.style.cursor = mode === "add" ? "crosshair" : mode === "rem" ? "not-allowed" : hitNode(x, y) ? "grab" : "default";
  }
  function onMouseDown(e) {
    const { x, y } = getPos(e); const h = hitNode(x, y);
    if (mode === "add") { if (!h) { const id = `0x${nodeCounter.toString(16).toUpperCase().padStart(4, "0")}`; setNodes(p => [...p, makeNode(id, x, y)]); setNodeCounter(c => c + 1); } return; }
    if (mode === "rem") { if (h) { if (h.is_root && nodes.filter(n => n.is_root).length <= 1) return; setNodes(p => p.filter(n => n.id !== h.id)); } return; }
    if (h) { setSelNode(h); dragRef.current = h.id; dragOff.current = { x: x - h.x, y: y - h.y }; }
    else { setSelNode(null); dragRef.current = null; }
  }
  function onMouseUp() { dragRef.current = null; }

  const selN = selNode ? nodes.find(n => n.id === selNode.id) : null;
  const phBadge = { idle: ["#475569","IDLE"], building: ["#3b82f6","RUNNING"], done: ["#22c55e","DONE"] }[phase] || ["#475569","IDLE"];

  // Scroll active step into view
  useEffect(() => {
    if (activeStep !== null && execLogRef.current) {
      const el = execLogRef.current.querySelector(`[data-step="${activeStep}"]`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [activeStep]);

  // ── Execution log step renderer ──
  function renderStepText(entry) {
    if (entry.type === "DIO") {
      const lines = [];
      if (entry.improvements.length > 0) {
        // Group by sender
        const bySender = {};
        entry.improvements.forEach(imp => {
          if (!bySender[imp.from]) bySender[imp.from] = [];
          bySender[imp.from].push(imp);
        });
        Object.entries(bySender).forEach(([sender, imps]) => {
          const receivers = imps.map(i => `Node ${shortId(i.to)} selects parent ${shortId(sender)}, Rank=${i.rank}`).join(". ");
          lines.push(receivers);
        });
      }
      if (entry.noImprov.length > 0) {
        const senders = [...new Set(entry.noImprov.map(s => shortId(s.from)))].join(", ");
        lines.push(`DIO multicast from ${senders} (no rank improvements this wave).`);
      }
      return lines.join(" ");
    }
    if (entry.type === "DAO") {
      return entry.msgs.map(m => `Node ${shortId(m.node)} sends DAO upstream to preferred parent ${shortId(m.parent)}.`).join(" ");
    }
    if (entry.type === "DONE") {
      return "DODAG formation complete (downward DIO, upward DAO).";
    }
    if (entry.type === "FIX") {
      return entry.msgs.map(m => `Node ${shortId(m.node)} re-elected: ${shortId(m.from)} → ${shortId(m.to)} (${m.reason}).`).join(" ");
    }
    if (entry.type === "DRAIN") {
      return entry.msg;
    }
    return "";
  }

  function shortId(id) {
    if (!id) return "?";
    // Convert hex like 0x0001 → 1, 0x000A → 10 etc.
    const hex = id.replace(/^0x/i, "");
    return String(parseInt(hex, 16));
  }

  function typeBadge(type) {
    const map = {
      DIO:   { bg: "#1d4ed8", color: "#fff", label: "DIO" },
      DAO:   { bg: "#15803d", color: "#fff", label: "DAO" },
      DONE:  { bg: "#0891b2", color: "#fff", label: "DONE" },
      FIX:   { bg: "#7c3aed", color: "#fff", label: "FIX" },
      DRAIN: { bg: "#92400e", color: "#fde68a", label: "DRAIN" },
    };
    return map[type] || { bg: "#334155", color: "#fff", label: type };
  }

  const C = {
    bg: "#060d1a", bg2: "#0a1428", bg3: "#0f1e3a", bg4: "#111d35",
    br: "#1e3a5f", br2: "#253e5f",
    tx: "#e2e8f0", tx2: "#94a3b8", tx3: "#475569",
    ac: "#3b82f6", ok: "#22c55e", warn: "#f59e0b", err: "#ef4444",
  };

  function Btn({ children, onClick, disabled, color, title }) {
    return (
      <button title={title} onClick={onClick} disabled={disabled}
        style={{ display:"inline-flex",alignItems:"center",gap:4,padding:"5px 11px",borderRadius:6,border:`1px solid ${disabled?C.br:(color||C.ac)+"55"}`,cursor:disabled?"not-allowed":"pointer",fontSize:11,fontWeight:600,color:disabled?C.tx3:(color||C.ac),background:disabled?"transparent":(color||C.ac)+"12",whiteSpace:"nowrap",opacity:disabled?0.5:1 }}>
        {children}
      </button>
    );
  }
  function SideBtn({ icon, active, onClick, title }) {
    return (
      <button title={title} onClick={onClick}
        style={{ width:34,height:34,borderRadius:7,border:`1px solid ${active?C.ac:C.br}`,background:active?C.bg3:"transparent",color:active?"#60a5fa":C.tx3,cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center" }}>
        {icon}
      </button>
    );
  }
  function TabBtn({ id, label, badge }) {
    const a = activeTab === id;
    return (
      <button onClick={() => setActiveTab(id)}
        style={{ flex:1,padding:"8px 2px",fontSize:9,fontWeight:a?700:400,color:a?"#60a5fa":C.tx3,background:"none",border:"none",borderBottom:`2px solid ${a?C.ac:"transparent"}`,cursor:"pointer",letterSpacing:".05em",textTransform:"uppercase",position:"relative",display:"flex",alignItems:"center",justifyContent:"center",gap:4 }}>
        {label}
        {badge ? <span style={{ fontSize:8,padding:"0px 4px",borderRadius:6,background:C.warn,color:"#000",fontWeight:700 }}>{badge}</span> : null}
      </button>
    );
  }

  return (
    <div style={{ display:"flex",flexDirection:"column",height:"100vh",background:C.bg,fontFamily:"'IBM Plex Mono','Courier New',monospace",color:C.tx,fontSize:12,overflow:"hidden" }}>

      {/* TOP BAR */}
      <div style={{ display:"flex",alignItems:"center",height:50,background:C.bg2,borderBottom:`1px solid ${C.br}`,padding:"0 14px",gap:8,flexShrink:0 }}>
        <div style={{ display:"flex",alignItems:"center",gap:8,marginRight:6 }}>
          <div style={{ width:30,height:30,borderRadius:7,background:"linear-gradient(135deg,#3b82f6,#1d4ed8)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15 }}>⬡</div>
          <div>
            <div style={{ fontSize:13,fontWeight:700,letterSpacing:"-.01em" }}>RPL Web Simulator</div>
            <div style={{ fontSize:9,color:C.tx3,letterSpacing:".04em" }}>RFC 6550 · IoT Routing</div>
          </div>
        </div>
        <div style={{ width:1,height:26,background:C.br }} />
        <Btn onClick={animate} disabled={simRunning} color={C.ok}>▶ Run</Btn>
        <Btn onClick={stepOne} disabled={simRunning} color={C.ac}>⏭ Step</Btn>
        <Btn onClick={resetDodag} color={C.err}>↺ Reset</Btn>
        <div style={{ width:1,height:26,background:C.br }} />
        <Btn onClick={drainEnergy} disabled={phase!=="done"} color={C.warn}>⚡ Drain</Btn>
        <Btn onClick={resolveIssues} disabled={phase!=="done"||hotspots.length===0} color="#a855f7">🔧 Fix</Btn>
        <div style={{ width:1,height:26,background:C.br }} />
        <label style={{ fontSize:10,color:C.tx3,display:"flex",alignItems:"center",gap:5 }}>OF:
          <select value={ofMode} onChange={e=>{setOfMode(e.target.value);resetDodag();}} style={{ fontSize:10,padding:"3px 6px",borderRadius:5,border:`1px solid ${C.br}`,background:C.bg3,color:C.tx2,cursor:"pointer" }}>
            <option value="hop">OF0 – Hop Count</option>
            <option value="etx">MRHOF – ETX</option>
          </select>
        </label>
        <label style={{ fontSize:10,color:C.tx3,display:"flex",alignItems:"center",gap:5 }}>Rng:
          <input type="range" min={100} max={350} value={radioRange} onChange={e=>setRadioRange(+e.target.value)} style={{ width:65,accentColor:C.ac }} />
          <span style={{ color:C.tx2,minWidth:28 }}>{radioRange}</span>
        </label>
        <label style={{ fontSize:10,color:C.tx3,display:"flex",alignItems:"center",gap:5 }}>Spd:
          <input type="range" min={1} max={10} value={speed} onChange={e=>setSpeed(+e.target.value)} style={{ width:55,accentColor:C.ac }} />
        </label>
        <div style={{ flex:1 }} />
        <span style={{ fontSize:10,padding:"3px 10px",borderRadius:10,background:phBadge[0]+"22",color:phBadge[0],border:`1px solid ${phBadge[0]}44`,fontWeight:700,letterSpacing:".06em" }}>{phBadge[1]}</span>
        <div style={{ display:"flex",gap:8,fontSize:10,color:C.tx3 }}>
          <span>DIO <b style={{ color:C.ac }}>{dioCount}</b></span>
          <span>DAO <b style={{ color:C.warn }}>{daoCount}</b></span>
          <span>Steps <b style={{ color:C.tx2 }}>{stepCount}</b></span>
        </div>
      </div>

      {/* MAIN */}
      <div style={{ display:"flex",flex:1,minHeight:0 }}>

        {/* LEFT TOOLBAR */}
        <div style={{ width:48,background:C.bg2,borderRight:`1px solid ${C.br}`,display:"flex",flexDirection:"column",alignItems:"center",padding:"10px 0",gap:4,flexShrink:0 }}>
          <SideBtn icon="↖" active={mode==="sel"} onClick={()=>setMode("sel")} title="Select & drag" />
          <SideBtn icon="＋" active={mode==="add"} onClick={()=>setMode(mode==="add"?"sel":"add")} title="Click canvas to add node" />
          <SideBtn icon="－" active={mode==="rem"} onClick={()=>setMode(mode==="rem"?"sel":"rem")} title="Click node to remove" />
          <div style={{ width:28,height:1,background:C.br,margin:"4px 0" }} />
          <SideBtn icon="⊕" active={false} onClick={addNodeClick} title="Add node randomly" />
          <div style={{ width:28,height:1,background:C.br,margin:"4px 0" }} />
          <SideBtn icon="◎" active={showRange} onClick={()=>setShowRange(v=>!v)} title="Toggle radio range" />
          <SideBtn icon="⋯" active={showLinks} onClick={()=>setShowLinks(v=>!v)} title="Toggle radio links" />
          <SideBtn icon="𝐓" active={showLabels} onClick={()=>setShowLabels(v=>!v)} title="Toggle labels" />
          <SideBtn icon="ε" active={showETX} onClick={()=>setShowETX(v=>!v)} title="Toggle ETX" />
        </div>

        {/* CANVAS */}
        <div ref={areaRef} style={{ flex:1,position:"relative",overflow:"hidden" }}>
          <canvas ref={cvRef} style={{ position:"absolute",top:0,left:0,width:"100%",height:"100%" }}
            onMouseMove={onMouseMove} onMouseDown={onMouseDown} onMouseUp={onMouseUp}
            onMouseLeave={()=>{ setHovNode(null); if(cvRef.current) cvRef.current.style.cursor="default"; }} />

          {phase === "building" && (
            <div style={{ position:"absolute",top:12,left:"50%",transform:"translateX(-50%)",background:"#1e40af",color:"#bfdbfe",fontSize:11,fontWeight:700,padding:"6px 20px",borderRadius:20,border:"1px solid #3b82f6",pointerEvents:"none",letterSpacing:".06em" }}>
              ⬡ DIO PROPAGATION IN PROGRESS
            </div>
          )}
          {phase === "done" && hotspots.length > 0 && (
            <div style={{ position:"absolute",top:12,left:"50%",transform:"translateX(-50%)",background:"#78350f",color:"#fde68a",fontSize:11,fontWeight:700,padding:"6px 20px",borderRadius:20,border:"1px solid #f59e0b",pointerEvents:"none" }}>
              ⚠ {hotspots.length} ISSUE{hotspots.length>1?"S":""} — CLICK 🔧 FIX
            </div>
          )}

          {/* Stats overlay */}
          <div style={{ position:"absolute",top:12,left:12,background:"rgba(6,13,26,0.88)",border:`1px solid ${C.br}`,borderRadius:8,padding:"8px 12px",fontSize:10,color:C.tx3,lineHeight:1.9 }}>
            <div style={{ color:C.tx2,fontWeight:700,marginBottom:3,letterSpacing:".06em",fontSize:9 }}>NETWORK</div>
            <div>Nodes <span style={{ color:C.tx,float:"right",marginLeft:18 }}>{nodes.length}</span></div>
            <div>Joined <span style={{ color:C.ok,float:"right" }}>{nodes.filter(n=>n.joined||n.is_root).length}</span></div>
            <div>Links <span style={{ color:C.ac,float:"right" }}>{nodes.filter(n=>n.parent).length}</span></div>
            {hotspots.length>0&&<div>Issues <span style={{ color:C.warn,float:"right" }}>{hotspots.length}</span></div>}
            {analytics&&<div>Health <span style={{ color:analytics.health>70?C.ok:C.warn,float:"right" }}>{analytics.health}/100</span></div>}
          </div>

          {/* Legend */}
          <div style={{ position:"absolute",bottom:12,left:12,background:"rgba(6,13,26,0.88)",border:`1px solid ${C.br}`,borderRadius:8,padding:"8px 12px",fontSize:10,color:C.tx3,lineHeight:2 }}>
            {[["#ef4444","R = Root (border router)"],["#22c55e","● Joined node (rank)"],["#334155","● Unjoined node"],["#f59e0b","🔥 Hotspot / relay"],["#3b82f6","→ DIO packet"],["#f59e0b","→ DAO packet"]].map(([c,l])=>(
              <div key={l} style={{ display:"flex",alignItems:"center",gap:6 }}><div style={{ width:8,height:8,borderRadius:"50%",background:c,flexShrink:0 }} /><span>{l}</span></div>
            ))}
          </div>

          {/* Minimap */}
          <svg style={{ position:"absolute",bottom:12,right:12,width:120,height:80,borderRadius:8,border:`1px solid ${C.br}`,background:"rgba(6,13,26,0.92)" }}>
            {(()=>{
              if(!nodes.length) return null;
              const xs=nodes.map(n=>n.x),ys=nodes.map(n=>n.y);
              const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
              const sc=Math.min(104/(maxX-minX||1),64/(maxY-minY||1));
              const ox=(120-(maxX-minX)*sc)/2-minX*sc,oy=(80-(maxY-minY)*sc)/2-minY*sc;
              return<>
                {nodes.filter(n=>n.parent).map(n=>{const p=nodes.find(x=>x.id===n.parent);if(!p)return null;return<line key={n.id} x1={n.x*sc+ox} y1={n.y*sc+oy} x2={p.x*sc+ox} y2={p.y*sc+oy} stroke="#22c55e77" strokeWidth={1}/>;}) }
                {nodes.map(n=><circle key={n.id} cx={n.x*sc+ox} cy={n.y*sc+oy} r={3} fill={n.is_root?"#ef4444":n.joined?"#22c55e":"#334155"} stroke={selNode?.id===n.id?"#60a5fa":"none"} strokeWidth={1.5}/>)}
              </>;
            })()}
          </svg>

          <div style={{ position:"absolute",bottom:12,left:"50%",transform:"translateX(-50%)",background:C.bg2,border:`1px solid ${C.br}`,borderRadius:8,padding:"7px 16px",color:C.tx2,fontSize:12,fontWeight:800,pointerEvents:"none",zIndex:5 }}>
            Made By Sobaan
          </div>
        </div>

        {/* RIGHT PANEL */}
        <div style={{ width:295,background:C.bg2,borderLeft:`1px solid ${C.br}`,display:"flex",flexDirection:"column",flexShrink:0 }}>
          <div style={{ display:"flex",borderBottom:`1px solid ${C.br}`,flexShrink:0 }}>
            <TabBtn id="nodes" label="Nodes" />
            <TabBtn id="inspector" label="Inspect" />
            <TabBtn id="execlog" label="Exec Log" badge={execLog.length||null} />
            <TabBtn id="analytics" label="Stats" />
          </div>

          <div style={{ flex:1,overflow:"hidden auto" }}>

            {/* NODES TABLE */}
            {activeTab==="nodes" && (
              <table style={{ width:"100%",borderCollapse:"collapse",fontSize:10 }}>
                <thead>
                  <tr style={{ background:C.bg3,position:"sticky",top:0,zIndex:1 }}>
                    {["ID","Rank","Parent","Batt","State"].map(h=>(
                      <th key={h} style={{ padding:"6px 7px",textAlign:"left",color:C.tx3,fontWeight:600,letterSpacing:".05em",borderBottom:`1px solid ${C.br}`,fontSize:9 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {nodes.map((n,i)=>{
                    const hs=hotspots.find(h=>h.node_id===n.id);
                    return(
                      <tr key={n.id} onClick={()=>{setSelNode(n);setActiveTab("inspector");}}
                        style={{ background:selNode?.id===n.id?C.bg3:i%2===0?"transparent":"#0b1830",cursor:"pointer",borderBottom:`1px solid #0f1e3a` }}>
                        <td style={{ padding:"5px 7px",color:n.is_root?C.err:C.tx2,fontFamily:"monospace",fontSize:9 }}>{n.id}</td>
                        <td style={{ padding:"5px 7px",color:n.rank===INF?C.tx3:"#60a5fa",fontWeight:700 }}>{n.rank===INF?"∞":n.rank}</td>
                        <td style={{ padding:"5px 7px",color:C.tx3,fontFamily:"monospace",fontSize:8 }}>{n.parent||"—"}</td>
                        <td style={{ padding:"5px 7px" }}>
                          <div style={{ display:"flex",alignItems:"center",gap:3 }}>
                            <div style={{ width:28,height:4,borderRadius:2,background:C.br,overflow:"hidden" }}>
                              <div style={{ height:"100%",width:`${n.energy_pct}%`,background:n.energy_pct>50?C.ok:n.energy_pct>25?C.warn:C.err,borderRadius:2 }} />
                            </div>
                            <span style={{ color:C.tx3,fontSize:8 }}>{Math.round(n.energy_pct)}%</span>
                          </div>
                        </td>
                        <td style={{ padding:"5px 7px" }}>
                          <span style={{ fontSize:8,padding:"1px 5px",borderRadius:4,background:n.joined?"#16a34a22":"#33415522",color:n.joined?"#4ade80":C.tx3 }}>
                            {hs?(hs.flags.includes("hotspot")?"🔥 ":"⚡ "):""}{n.joined?"joined":"—"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {/* INSPECTOR */}
            {activeTab==="inspector" && (
              <div style={{ padding:12 }}>
                {selN ? (
                  <>
                    <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:12,paddingBottom:10,borderBottom:`1px solid ${C.br}` }}>
                      <div style={{ width:38,height:38,borderRadius:8,background:selN.is_root?"#dc2626":selN.joined?"#15803d":C.bg3,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:800,color:"#fff" }}>
                        {selN.is_root?"R":selN.rank===INF?"?":selN.rank}
                      </div>
                      <div>
                        <div style={{ fontSize:13,fontWeight:700,fontFamily:"monospace" }}>{selN.id}</div>
                        <div style={{ fontSize:10,color:selN.is_root?C.err:selN.joined?C.ok:C.tx3 }}>{selN.is_root?"DODAG Root":selN.joined?"Joined":"Unjoined"}</div>
                      </div>
                    </div>
                    {[["Node Type",selN.is_root?"Border Router":"Sensor Node"],["Rank",selN.rank===INF?"∞":selN.rank],["Preferred Parent",selN.parent||"None (root)"],["Children",selN.children?.length||0],["ETX",selN.is_root?"N/A":selN.etx?.toFixed(3)],["RX pkts",selN.traffic_rx],["TX pkts",selN.traffic_tx]].map(([k,v])=>(
                      <div key={k} style={{ display:"flex",justifyContent:"space-between",marginBottom:7,fontSize:11 }}>
                        <span style={{ color:C.tx3 }}>{k}</span>
                        <span style={{ color:C.tx2,fontWeight:500,fontFamily:"monospace" }}>{String(v)}</span>
                      </div>
                    ))}
                    {!selN.is_root && (
                      <div style={{ marginTop:10 }}>
                        <div style={{ fontSize:9,color:C.tx3,letterSpacing:".06em",marginBottom:5 }}>BATTERY</div>
                        <div style={{ height:8,borderRadius:4,background:C.br,overflow:"hidden" }}>
                          <div style={{ height:"100%",width:`${selN.energy_pct||100}%`,background:(selN.energy_pct||100)>50?C.ok:(selN.energy_pct||100)>25?C.warn:C.err,borderRadius:4,transition:"width .4s" }} />
                        </div>
                        <div style={{ fontSize:9,color:C.tx3,textAlign:"right",marginTop:3 }}>{(selN.energy_pct||100).toFixed(1)}%</div>
                      </div>
                    )}
                    <div style={{ marginTop:10,paddingTop:10,borderTop:`1px solid ${C.br}` }}>
                      <div style={{ fontSize:9,color:C.tx3,letterSpacing:".06em",marginBottom:4 }}>IPv6 ADDRESS</div>
                      <div style={{ fontFamily:"monospace",fontSize:10,color:"#60a5fa" }}>{selN.ipv6}</div>
                    </div>
                    {selN.children?.length>0 && (
                      <div style={{ marginTop:10 }}>
                        <div style={{ fontSize:9,color:C.tx3,letterSpacing:".06em",marginBottom:4 }}>CHILDREN ({selN.children.length})</div>
                        {selN.children.map(c=><div key={c} style={{ fontSize:10,color:C.tx3,fontFamily:"monospace",padding:"2px 0" }}>└ {c}</div>)}
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ color:C.tx3,fontSize:11,lineHeight:2,marginTop:6 }}>
                    Click a node to inspect.<br/>
                    <div style={{ marginTop:8,fontSize:10,color:"#334155",lineHeight:2.2 }}>
                      <div>• Drag to reposition nodes</div>
                      <div>• Ring = battery level</div>
                      <div>• Number = rank</div>
                      <div>• 🔥 = relay hotspot</div>
                      <div>• ⚡ = critical battery</div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ══ EXECUTION LOG ══ */}
            {activeTab==="execlog" && (
              <div style={{ padding:12 }}>
                <div style={{ fontSize:14,fontWeight:700,color:C.tx,marginBottom:14,letterSpacing:"-.01em" }}>Execution Log</div>
                {execLog.length===0 ? (
                  <div style={{ color:C.tx3,fontSize:11,lineHeight:2 }}>
                    Click ▶ Run or ⏭ Step to start the simulation.<br/>
                    Steps will appear here in real time.
                  </div>
                ) : (
                  <div ref={execLogRef} style={{ display:"flex",flexDirection:"column",gap:8 }}>
                    {execLog.map((entry,idx)=>{
                      const badge = typeBadge(entry.type);
                      const isActive = activeStep === idx;
                      const text = renderStepText(entry);
                      return (
                        <div key={idx} data-step={idx}
                          onClick={()=>setActiveStep(idx)}
                          style={{
                            padding:"10px 12px",
                            borderRadius:10,
                            border:`1px solid ${isActive ? (entry.type==="DIO"?"#3b82f6":entry.type==="DAO"?"#22c55e":entry.type==="DONE"?"#0891b2":entry.type==="FIX"?"#7c3aed":"#92400e") : C.br}`,
                            background: isActive ? C.bg3 : C.bg4,
                            cursor:"pointer",
                            transition:"border-color .2s, background .2s",
                          }}>
                          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6 }}>
                            <span style={{ fontSize:11,fontWeight:600,color:isActive?C.tx:C.tx2 }}>Step {entry.wave}</span>
                            <span style={{ fontSize:9,padding:"2px 8px",borderRadius:6,background:badge.bg,color:badge.color,fontWeight:700,letterSpacing:".05em" }}>{badge.label}</span>
                          </div>
                          <div style={{ fontSize:11,color:isActive?C.tx:C.tx3,lineHeight:1.7 }}>{text}</div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ANALYTICS */}
            {activeTab==="analytics" && (
              <div style={{ padding:12 }}>
                {analytics ? (
                  <>
                    <div style={{ textAlign:"center",marginBottom:14 }}>
                      <div style={{ fontSize:46,fontWeight:900,color:analytics.health>70?C.ok:analytics.health>40?C.warn:C.err,letterSpacing:"-3px",lineHeight:1 }}>{analytics.health}</div>
                      <div style={{ fontSize:9,color:C.tx3,letterSpacing:".1em",marginTop:4 }}>HEALTH SCORE</div>
                      <div style={{ height:5,borderRadius:3,background:C.br,margin:"8px 0 0",overflow:"hidden" }}>
                        <div style={{ height:"100%",width:`${analytics.health}%`,background:analytics.health>70?C.ok:C.warn,borderRadius:3 }} />
                      </div>
                    </div>
                    {[["Join Rate",`${analytics.joined}/${analytics.total} (${analytics.joinPct}%)`,C.ok],["Avg Energy",`${analytics.avgEnergy.toFixed(1)}%`,C.ac],["Min Energy",`${analytics.minEnergy.toFixed(1)}%`,C.ac],["Hotspots",analytics.hotspotCount,analytics.hotspotCount>0?C.warn:C.ok],["Critical",analytics.criticalCount,analytics.criticalCount>0?C.err:C.ok],["Avg Rank",analytics.avgRank,C.tx2],["Max Rank",analytics.maxRank,C.tx2],["Total DIO",dioCount,C.ac],["Total DAO",daoCount,C.warn]].map(([k,v,c])=>(
                      <div key={k} style={{ display:"flex",justifyContent:"space-between",marginBottom:7,fontSize:11 }}>
                        <span style={{ color:C.tx3 }}>{k}</span>
                        <span style={{ color:c||C.tx2,fontWeight:600 }}>{String(v)}</span>
                      </div>
                    ))}
                    {actions.length>0 && (
                      <div style={{ marginTop:10,paddingTop:10,borderTop:`1px solid ${C.br}` }}>
                        <div style={{ fontSize:9,color:C.tx3,letterSpacing:".06em",marginBottom:6 }}>RESOLUTION LOG</div>
                        {actions.map((a,i)=>(
                          <div key={i} style={{ marginBottom:6,padding:7,borderRadius:6,background:C.bg3,fontSize:10,color:C.tx3,fontFamily:"monospace" }}>
                            <span style={{ color:C.warn }}>● {a.reason}</span><br/>
                            {a.child}<br/>
                            <span style={{ fontSize:9 }}>{a.from} → {a.to}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : <div style={{ color:C.tx3,fontSize:11,lineHeight:2 }}>Run ▶ to generate analytics.</div>}
              </div>
            )}
          </div>
        </div>
      </div>
      <footer style={{ flexShrink:0,padding:"8px 14px",background:C.bg2,borderTop:`1px solid ${C.br}`,color:C.tx3,fontSize:11,fontWeight:700,textAlign:"center" }}>
        Made By Sobaan
      </footer>
    </div>
  );
}
