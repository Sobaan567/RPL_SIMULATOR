import { useState, useEffect, useRef } from "react";
import {
  Activity,
  BarChart3,
  Bot,
  Download,
  Flame,
  Gauge,
  Info,
  Layers,
  LocateFixed,
  Map as MapIcon,
  Menu,
  MousePointer2,
  Play,
  Plus,
  Radar,
  Radio,
  RotateCcw,
  Send,
  Settings2,
  Sparkles,
  StepForward,
  Tag,
  Trash2,
  Wrench,
  Zap,
} from "lucide-react";

const BATTERY_CAP = 100;
const INF = 9999;
const BASE_STATION_ID = "__base_station__";
const DODAG_REPAIR_MIN_RANGE = 330;
const API_BASE = import.meta.env.VITE_API_BASE || "http://127.0.0.1:8000";
const CHAT_ENDPOINT = import.meta.env.VITE_CHAT_ENDPOINT || (import.meta.env.PROD ? "/api/chat/gemini" : `${API_BASE}/chat/gemini`);
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function getBaseStationPos(W, H) {
  return { x: Math.max(110, W - 115), y: Math.max(75, Math.min(130, H * 0.14)) };
}

function makeNode(id, x, y, is_root = false, opts = {}) {
  const energy = Math.max(0, Math.min(BATTERY_CAP, opts.energy ?? BATTERY_CAP));
  return {
    id, x, y, is_root,
    rank: is_root ? 0 : INF,
    parent: null, children: [],
    energy, energy_pct: energy,
    joined: is_root, flags: [],
    traffic_rx: 0, traffic_tx: 0, etx: 1,
    r: 22, pulse: 0,
    manual: opts.manual || null,
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
      const target = nodeMap[s.to];
      const manual = target?.manual;
      const manualRank = manual
        ? Math.max(senderRank + 1, manual.rank + manual.baseDistance / 120 + Math.max(0, 100 - manual.energy) / 35)
        : null;
      const proposed = manualRank !== null ? +manualRank.toFixed(2) : of_mode === "hop" ? senderRank + 1 : +(senderRank + 1).toFixed(2);
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
  const dataTimerRef = useRef(null);
  const baseStationRef = useRef(null);

  const [nodes,      setNodes]      = useState([]);
  const [baseStation,setBaseStation]= useState(null);
  const [pkts,       setPkts]       = useState([]);
  const [ripples,    setRipples]    = useState([]);
  const [selNode,    setSelNode]    = useState(null);
  const [hovNode,    setHovNode]    = useState(null);
  const [hovBaseStation,setHovBaseStation]= useState(false);
  const [phase,      setPhase]      = useState("idle");
  const [ofMode,     setOfMode]     = useState("hop");
  const [mode,       setMode]       = useState("sel");
  const [showRange,  setShowRange]  = useState(true);
  const [showLinks,  setShowLinks]  = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [showETX,    setShowETX]    = useState(false);
  const [showHeatmap,setShowHeatmap]= useState(true);
  const [theme,      setTheme]      = useState("dark");
  const [manualInsert,setManualInsert]= useState(false);
  const [manualRank, setManualRank] = useState(2);
  const [manualDistance,setManualDistance]= useState(180);
  const [manualEnergy,setManualEnergy]= useState(75);
  const [simRunning, setSimRunning] = useState(false);
  const [speed,      setSpeed]      = useState(5);
  const [hotspots,   setHotspots]   = useState([]);
  const [analytics,  setAnalytics]  = useState(null);
  const [energyReport,setEnergyReport]= useState(null);
  const [mlStatus,   setMlStatus]   = useState("idle");
  const [actions,    setActions]    = useState([]);
  const [activeTab,  setActiveTab]  = useState("nodes");
  const [dioCount,   setDioCount]   = useState(0);
  const [daoCount,   setDaoCount]   = useState(0);
  const [dataCount,  setDataCount]  = useState(0);
  const [ackCount,   setAckCount]   = useState(0);
  const [stepCount,  setStepCount]  = useState(0);
  const [radioRange, setRadioRange] = useState(200);
  const [nodeCounter,setNodeCounter]= useState(12);
  const [scenarioLog,setScenarioLog]= useState([]);
  const [chatOpen,   setChatOpen]   = useState(false);
  const [chatInput,  setChatInput]  = useState("");
  const [chatBusy,   setChatBusy]   = useState(false);
  const [chatError,  setChatError]  = useState("");
  const [chatMessages,setChatMessages]= useState([
    { role: "assistant", text: "Hi, I am your Gemini RPL assistant. Ask me about the network, energy, hotspots, or what to click next." },
  ]);
  const [guideOpen,  setGuideOpen]  = useState(false);
  const [guideStep,  setGuideStep]  = useState(0);
  const [guideRunning,setGuideRunning]= useState(false);
  const [panelOpen,  setPanelOpen]  = useState(true);
  const [isCompact,  setIsCompact]  = useState(false);
  const [comparison, setComparison] = useState(null);
  // Execution log
  const [execLog,    setExecLog]    = useState([]);   // array of wave objects
  const [activeStep, setActiveStep] = useState(null); // highlighted step index
  const execLogRef = useRef(null);

  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { baseStationRef.current = baseStation; }, [baseStation]);
  useEffect(() => {
    const syncViewport = () => {
      const compact = window.innerWidth < 980;
      setIsCompact(compact);
      setPanelOpen(open => compact ? false : open);
    };
    syncViewport();
    window.addEventListener("resize", syncViewport);
    return () => window.removeEventListener("resize", syncViewport);
  }, []);

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
    setPkts([]); setRipples([]); setAnalytics(null); setEnergyReport(null); setMlStatus("idle");
    setDioCount(0); setDaoCount(0); setDataCount(0); setAckCount(0); setStepCount(0);
    setScenarioLog([]);
    setExecLog([]); setActiveStep(null);
    setGuideRunning(false); setGuideStep(0);
    stepsRef.current = []; stepIdxRef.current = 0;
    setSimRunning(false);
    if (animTimerRef.current) { clearInterval(animTimerRef.current); animTimerRef.current = null; }
    if (dataTimerRef.current) { clearInterval(dataTimerRef.current); dataTimerRef.current = null; }
  }

  useEffect(() => { setTimeout(initNodes, 120); }, []);

  function currentBaseStation(W, H) {
    return baseStationRef.current || baseStation || getBaseStationPos(W, H);
  }

  function isDeadNode(n) {
    return !n?.is_root && (n.dead || n.energy <= 0 || n.energy_pct <= 0);
  }

  function normalizeDeadNodes(ns) {
    const deadIds = new Set(ns.filter(isDeadNode).map(n => n.id));
    return ns.map(n => {
      const dead = deadIds.has(n.id);
      const parentGone = n.parent && deadIds.has(n.parent);
      return {
        ...n,
        dead,
        energy: dead ? 0 : n.energy,
        energy_pct: dead ? 0 : n.energy_pct,
        rank: dead ? INF : n.rank,
        parent: dead || parentGone ? null : n.parent,
        children: dead ? [] : (n.children || []).filter(c => !deadIds.has(c)),
        joined: dead ? false : n.joined,
        flags: dead ? [...new Set([...(n.flags || []), "dead"])] : (n.flags || []).filter(f => f !== "dead"),
      };
    });
  }

  function rebuildDodagPreservingEnergy(ns, range = radioRange) {
    const copy = normalizeDeadNodes(ns).map(n => ({
      ...n,
      rank: isDeadNode(n) ? INF : n.is_root ? 0 : INF,
      parent: null,
      children: [],
      joined: !isDeadNode(n) && n.is_root,
      etx: isDeadNode(n) ? 1 : n.etx,
      pulse: isDeadNode(n) ? Date.now() : n.pulse,
    }));
    const liveNodes = copy.filter(n => !isDeadNode(n));
    const rebuildRank = (s, r) => {
      if (ofMode === "hop") return s.rank + 1;
      const d = dist(s, r) / range;
      return +(s.rank + 1 + 2.4 * d * d).toFixed(2);
    };

    for (let pass = 0; pass < liveNodes.length; pass += 1) {
      let changed = false;
      liveNodes.filter(s => s.rank !== INF).forEach(s => {
        liveNodes.filter(o => o.id !== s.id && !o.is_root && dist(s, o) < range).forEach(nb => {
          const nr = rebuildRank(s, nb);
          if (nr < nb.rank) {
            nb.rank = nr;
            nb.parent = s.id;
            nb.joined = true;
            nb.etx = calcETX(s, nb, range);
            nb.pulse = Date.now();
            changed = true;
          }
        });
      });
      if (!changed) break;
    }

    copy.forEach(n => { n.children = []; });
    copy.forEach(n => {
      if (!n.parent || isDeadNode(n)) return;
      const parent = copy.find(p => p.id === n.parent && !isDeadNode(p));
      if (parent && !parent.children.includes(n.id)) parent.children.push(n.id);
    });
    return copy;
  }

  function applyDeadNodeRebuild(ns, reason = "battery depleted") {
    const normalized = normalizeDeadNodes(ns);
    const deadIds = normalized.filter(isDeadNode).map(n => n.id);
    if (!deadIds.length) return { nodes: normalized, deadIds };
    const repairRange = Math.max(radioRange, DODAG_REPAIR_MIN_RANGE);
    setRadioRange(repairRange);
    const rebuilt = rebuildDodagPreservingEnergy(normalized, repairRange);
    setPhase("done");
    stepsRef.current = [];
    stepIdxRef.current = 0;
    setSimRunning(false);
    if (selNode && deadIds.includes(selNode.id)) setSelNode(null);
    setExecLog(p => [...p, {
      wave: p.length + 1,
      type: "FIX",
      msg: `Node ${deadIds.join(", ")} is dead (${reason}). DODAG was rebuilt using remaining node battery levels.`,
    }]);
    setActiveStep(execLog.length);
    setScenarioLog(p => [{
      msg: `Dead node removed from routing: ${deadIds.join(", ")}. DODAG rebuilt with current batteries.`,
      color: "#ef4444",
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    }, ...p].slice(0, 8));
    return { nodes: rebuilt, deadIds };
  }

  function resetDodag() {
    if (animTimerRef.current) { clearInterval(animTimerRef.current); animTimerRef.current = null; }
    setNodes(p => normalizeDeadNodes(p).map(n => ({ ...n, rank: n.is_root && !isDeadNode(n) ? 0 : INF, parent: null, children: [], joined: n.is_root && !isDeadNode(n), flags: isDeadNode(n) ? ["dead"] : [], traffic_rx: 0, traffic_tx: 0, etx: 1, pulse: 0 })));
    resetStats();
  }

  function calcRank(s, r, range = radioRange) {
    if (r.manual) {
      const distanceCost = r.manual.baseDistance / 120;
      const energyPenalty = Math.max(0, 100 - r.manual.energy) / 35;
      return +Math.max(s.rank + 1, r.manual.rank + distanceCost + energyPenalty).toFixed(2);
    }
    if (ofMode === "hop") return s.rank + 1;
    const d = dist(s, r) / range;
    return +(s.rank + 1 + 2.4 * d * d).toFixed(2);
  }
  function calcETX(s, r, range = radioRange) {
    const d = dist(s, r) / range;
    return +(1 + 2.4 * d * d).toFixed(2);
  }

  function buildSteps(ns, range = radioRange) {
    const liveNodes = ns.filter(n => !isDeadNode(n));
    const roots = liveNodes.filter(n => n.is_root);
    const visited = new Set(roots.map(r => r.id));
    const q = [...roots], steps = [];
    while (q.length) {
      const s = q.shift();
      liveNodes.filter(o => o.id !== s.id && dist(s, o) < range).forEach(nb => {
        steps.push({ from: s.id, to: nb.id });
        if (!visited.has(nb.id)) { visited.add(nb.id); q.push(nb); }
      });
    }
    return steps;
  }

  function execStep(steps, ns, range = radioRange) {
    if (stepIdxRef.current >= steps.length) return null;
    const { from, to } = steps[stepIdxRef.current++];
    const s = ns.find(n => n.id === from), r = ns.find(n => n.id === to);
    if (!s || !r || isDeadNode(s) || isDeadNode(r)) return { from, to, improved: false };
    const nr = calcRank(s, r, range);
    const improved = nr < r.rank;
    if (improved) {
      if (r.parent) { const op = ns.find(n => n.id === r.parent); if (op) op.children = op.children.filter(c => c !== r.id); }
      r.rank = nr; r.parent = s.id; r.joined = true; r.pulse = Date.now();
      r.etx = calcETX(s, r, range);
      if (!s.children.includes(r.id)) s.children.push(r.id);
      s.energy = Math.max(0, s.energy - 0.06); r.energy = Math.max(0, r.energy - 0.025);
      s.energy_pct = +s.energy.toFixed(1); r.energy_pct = +r.energy.toFixed(1);
      s.traffic_tx++; r.traffic_rx++;
    }
    return { from, to, improved, rank: r.rank };
  }

  function spawnPkt(fromId, toId, color, label) {
    const ns = nodesRef.current;
    const cv = cvRef.current;
    const rect = cv?.getBoundingClientRect();
    const canvasW = rect?.width || cv?.offsetWidth || 680;
    const canvasH = rect?.height || cv?.offsetHeight || 560;
    const s = fromId === BASE_STATION_ID && cv
      ? currentBaseStation(canvasW, canvasH)
      : ns.find(n => n.id === fromId);
    const r = toId === BASE_STATION_ID && cv
      ? currentBaseStation(canvasW, canvasH)
      : ns.find(n => n.id === toId);
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
    if (nodesRef.current.some(isDeadNode)) {
      resetStats();
      const repairRange = Math.max(radioRange, DODAG_REPAIR_MIN_RANGE);
      setRadioRange(repairRange);
      const ns = normalizeDeadNodes(nodesRef.current).map(n => ({
        ...n,
        rank: isDeadNode(n) ? INF : n.is_root ? 0 : INF,
        parent: null,
        children: [],
        joined: !isDeadNode(n) && n.is_root,
        traffic_rx: 0,
        traffic_tx: 0,
        etx: 1,
        pulse: 0,
      }));
      const steps = buildSteps(ns, repairRange);
      stepsRef.current = steps;
      stepIdxRef.current = 0;
      setNodes(ns);
      setPhase("building");
      setSimRunning(true);
      setExecLog(generateExecLog(ns));
      setActiveStep(0);
      const delay = Math.max(55, 280 - speed * 24);
      animTimerRef.current = setInterval(() => {
        if (stepIdxRef.current >= steps.length) {
          clearInterval(animTimerRef.current); animTimerRef.current = null;
          setSimRunning(false); setPhase("done");
          setTimeout(() => {
            ns.forEach((n, i) => {
              if (n.parent && !isDeadNode(n)) {
                setTimeout(() => { spawnPkt(n.id, n.parent, "#f59e0b", "DAO"); setDaoCount(c => c + 1); }, i * 85);
              }
            });
            computeAnalytics(ns); detectHotspots(ns);
            setActiveStep(prev => prev !== null ? Math.max(prev, 1) : 1);
          }, 300);
          return;
        }
        const result = execStep(stepsRef.current, ns, repairRange);
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
      setExecLog([{
        wave: 1,
        type: "DIO",
        msg: "Dead node ignored. Root sends DIO again; live nodes select parents by rank through valid neighbors.",
      }, {
        wave: 2,
        type: "DAO",
        msg: "Joined nodes return DAO upward to their selected parents.",
      }, { wave: 3, type: "DONE" }]);
      return;
    }
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
    if (nodesRef.current.some(isDeadNode)) {
      const repairRange = Math.max(radioRange, DODAG_REPAIR_MIN_RANGE);
      if (phase !== "building" || !stepsRef.current.length) {
        setRadioRange(repairRange);
        const seed = normalizeDeadNodes(nodesRef.current).map(n => ({
          ...n,
          rank: isDeadNode(n) ? INF : n.is_root ? 0 : INF,
          parent: null,
          children: [],
          joined: !isDeadNode(n) && n.is_root,
          traffic_rx: 0,
          traffic_tx: 0,
          etx: 1,
          pulse: 0,
        }));
        stepsRef.current = buildSteps(seed, repairRange);
        stepIdxRef.current = 0;
        setNodes(seed);
        setPhase("building");
        setExecLog([{
          wave: 1,
          type: "DIO",
          msg: "Dead node ignored. DIO repair started through live neighbors.",
        }, {
          wave: 2,
          type: "DAO",
          msg: "DAO returns upward after parent selection.",
        }, { wave: 3, type: "DONE" }]);
        setActiveStep(0);
        return;
      }
      const ns = nodesRef.current.map(n => ({ ...n, children: [...(n.children || [])] }));
      if (stepIdxRef.current >= stepsRef.current.length) {
        setPhase("done");
        ns.forEach((n, i) => {
          if (n.parent && !isDeadNode(n)) {
            setTimeout(() => { spawnPkt(n.id, n.parent, "#f59e0b", "DAO"); setDaoCount(c => c + 1); }, i * 70);
          }
        });
        computeAnalytics(ns);
        detectHotspots(ns);
        setActiveStep(2);
        return;
      }
      const result = execStep(stepsRef.current, ns, repairRange);
      if (result?.improved) {
        spawnPkt(result.from, result.to, "#3b82f6", "DIO");
        const rn = ns.find(n => n.id === result.to);
        if (rn) spawnRipple(rn.x, rn.y, "#22c55e");
      } else if (result) {
        spawnPkt(result.from, result.to, "#1e3a5f", "DIO");
      }
      setNodes([...ns]);
      setDioCount(c => c + 1); setStepCount(c => c + 1);
      setActiveStep(0);
      return;
    }
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

  function isRelayHotspot(n, includeTrafficPressure = false) {
    if (!includeTrafficPressure || n.is_root || isDeadNode(n)) return false;
    const childCount = n.children?.length || 0;
    const t = n.traffic_rx + n.traffic_tx;
    const relayLoad = childCount >= 2 || n.traffic_tx >= 4;
    const forwardingPressure = childCount >= 2 && (t >= childCount + 1 || n.energy < 96);
    const trafficSkew = t >= 4 && n.traffic_rx / Math.max(1, t) > 0.5;
    return relayLoad && (forwardingPressure || trafficSkew);
  }

  function computeAnalytics(ns, opts = {}) {
    const includeTrafficPressure = opts.includeTrafficPressure || false;
    const liveNodes = ns.filter(n => !isDeadNode(n));
    const total = liveNodes.length || 1, joined = liveNodes.filter(n => n.joined || n.is_root).length;
    const energies = liveNodes.map(n => n.energy);
    const avgE = energies.reduce((a, b) => a + b, 0) / energies.length;
    const ranked = liveNodes.filter(n => n.rank !== INF).map(n => n.rank);
    const avgR = ranked.length ? ranked.reduce((a, b) => a + b, 0) / ranked.length : 0;
    const hs = ns.filter(n => isRelayHotspot(n, includeTrafficPressure));
    const crit = ns.filter(n => n.energy < 15 && !n.is_root && !isDeadNode(n));
    const health = Math.round((joined / total * 40) + (avgE / BATTERY_CAP * 35) + Math.max(0, 25 - hs.length * 8));
    setAnalytics({ joined, total, joinPct: +(joined / total * 100).toFixed(1), avgEnergy: +avgE.toFixed(1), minEnergy: +Math.min(...energies).toFixed(1), hotspotCount: hs.length, criticalCount: crit.length, avgRank: +avgR.toFixed(2), maxRank: ranked.length ? Math.max(...ranked) : 0, health });
  }

  function detectHotspots(ns, opts = {}) {
    const includeTrafficPressure = opts.includeTrafficPressure || false;
    const hs = ns.filter(n => {
      const overloadedRelay = isRelayHotspot(n, includeTrafficPressure);
      return !isDeadNode(n) && !n.is_root && (overloadedRelay || n.energy < 15);
    }).map(n => ({
      node_id: n.id,
      flags: [
        ...(isRelayHotspot(n, includeTrafficPressure) ? ["hotspot"] : []),
        ...(n.energy < 15 && !n.is_root && !isDeadNode(n) ? ["low_energy"] : []),
      ],
      traffic_rx: n.traffic_rx, energy_pct: +n.energy.toFixed(1), children: n.children.length,
    }));
    setHotspots(hs);
  }

  function resolveIssues() {
    const acts = [];
    const copy = nodesRef.current.map(n => ({ ...n, children: [...(n.children || [])] }));
    const affected = hotspots.filter(h => copy.some(n => n.id === h.node_id && !n.is_root));

    affected.forEach(h => {
      const node = copy.find(n => n.id === h.node_id);
      if (!node || !node.children.length) return;

      const toMove = h.flags.includes("low_energy")
        ? [...node.children]
        : node.children.slice(0, Math.ceil(node.children.length / 2));

      toMove.forEach(cid => {
        const child = copy.find(n => n.id === cid);
        if (!child) return;

        const descendants = new Set();
        const collectDesc = id => {
          copy.filter(n => n.parent === id).forEach(n => {
            descendants.add(n.id);
            collectDesc(n.id);
          });
        };
        collectDesc(child.id);

        const candidates = copy.filter(o =>
          !isDeadNode(o) &&
          o.id !== node.id &&
          o.id !== child.id &&
          !descendants.has(o.id) &&
          dist(child, o) < radioRange &&
          o.rank !== INF &&
          o.energy > 20
        );
        if (!candidates.length) return;

        const best = candidates.reduce((a, b) => calcRank(a, child) < calcRank(b, child) ? a : b);
        node.children = node.children.filter(c => c !== cid);
        child.parent = best.id;
        child.rank = calcRank(best, child);
        child.etx = calcETX(best, child);
        child.pulse = Date.now();
        if (!best.children.includes(cid)) best.children.push(cid);
        acts.push({ child: cid, from: node.id, to: best.id, reason: h.flags[0] });
      });
    });

    if (!acts.length) {
      setExecLog(p => [...p, {
        wave: p.length + 1,
        type: "FIX",
        msgs: [],
        msg: "No alternate parent was available within radio range for the current hotspot.",
      }]);
      setActiveStep(execLog.length);
      return;
    }

    setNodes(copy);
    setActions(acts);
    setTimeout(() => { computeAnalytics(copy, { includeTrafficPressure: true }); detectHotspots(copy, { includeTrafficPressure: true }); }, 50);
    // Append resolution steps to exec log
    const resEntry = {
      wave: execLog.length + 1, type: "FIX",
      msgs: acts.map(a => ({ node: a.child, from: a.from, to: a.to, reason: a.reason })),
    };
    setExecLog(p => [...p, resEntry]);
    setActiveStep(execLog.length);
  }

  function localEnergyPrediction(ns) {
    const predictions = ns.map(n => {
      if (isDeadNode(n)) {
        return {
          id: n.id,
          previous_energy: 0,
          predicted_drain: 0,
          predicted_energy: 0,
          energy_pct: 0,
          model: "frontend_ml_fallback",
        };
      }
      const relayPressure = Math.max(0, n.children.length - 1) * 1.15;
      const predictedDrain = +Math.min(18, (n.children.length * 1.15) + relayPressure + (n.traffic_rx * 0.16) + (n.traffic_tx * 0.2) + (n.is_root ? 0.85 : 0) + 0.55).toFixed(3);
      const predictedEnergy = +Math.max(0, n.energy - predictedDrain).toFixed(3);
      return {
        id: n.id,
        previous_energy: +n.energy.toFixed(3),
        predicted_drain: predictedDrain,
        predicted_energy: predictedEnergy,
        energy_pct: +(predictedEnergy / BATTERY_CAP * 100).toFixed(1),
        model: "frontend_ml_fallback",
      };
    });
    return {
      model: "frontend_ml_fallback",
      predictions,
      summary: {
        avg_energy: predictions.length ? +(predictions.reduce((a, p) => a + p.predicted_energy, 0) / predictions.length).toFixed(2) : 0,
        min_energy: predictions.length ? +Math.min(...predictions.map(p => p.predicted_energy)).toFixed(2) : 0,
        total_predicted_drain: +predictions.reduce((a, p) => a + p.predicted_drain, 0).toFixed(2),
        node_count: predictions.length,
      },
    };
  }

  function buildDrainTrafficLoad(ns) {
    const load = {};
    ns.forEach(n => { load[n.id] = { rx: 0, tx: 0 }; });
    const sources = ns.filter(n => !isDeadNode(n) && !n.is_root && n.joined && n.parent);
    const leaves = sources.filter(n => !ns.some(o => !isDeadNode(o) && o.parent === n.id));
    const senders = (leaves.length ? leaves : sources).slice(0, 8);
    senders.forEach(sender => {
      const route = getPathToRoot(sender.id, ns);
      route.forEach(([from, to]) => {
        if (load[from]) load[from].tx += 1;
        if (load[to]) load[to].rx += 1;
        if (load[to]) load[to].tx += 0.5;
      });
      [...route].reverse().forEach(([from, to]) => {
        if (load[to]) load[to].tx += 0.5;
        if (load[from]) load[from].rx += 0.5;
      });
    });
    return load;
  }

  async function drainEnergy() {
    const current = nodesRef.current;
    setActiveTab("ml");
    const trafficLoad = buildDrainTrafficLoad(current);
    const pressuredNodes = current.map(n => ({
      ...n,
      traffic_rx: n.traffic_rx + (trafficLoad[n.id]?.rx || 0),
      traffic_tx: n.traffic_tx + (trafficLoad[n.id]?.tx || 0),
    }));
    setMlStatus("running");
    let report;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1200);
      const res = await fetch(`${API_BASE}/ml/predict_energy_drain`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cycles: 1,
          data_packets: 1,
          ack_packets: 1,
          nodes: pressuredNodes.map(n => ({
            id: n.id,
            is_root: n.is_root,
            energy: n.energy,
            children_count: n.children.length,
            traffic_rx: n.traffic_rx,
            traffic_tx: n.traffic_tx,
            joined: n.joined || n.is_root,
          })),
        }),
      });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`ML backend returned ${res.status}`);
      report = await res.json();
      setMlStatus("backend");
    } catch (err) {
      report = localEnergyPrediction(pressuredNodes);
      setMlStatus("fallback");
    }

    const fallbackReport = localEnergyPrediction(pressuredNodes);
    const fallbackById = new globalThis.Map(fallbackReport.predictions.map(p => [p.id, p]));
    const rawPredictions = Array.isArray(report.predictions) && report.predictions.length ? report.predictions : fallbackReport.predictions;
    const predictions = rawPredictions.map(p => {
      const fallback = fallbackById.get(p.id);
      if (!fallback) return p;
      const predictedDrain = Math.max(Number(p.predicted_drain) || 0, fallback.predicted_drain);
      const predictedEnergy = +Math.max(0, (fallback.previous_energy ?? 100) - predictedDrain).toFixed(3);
      return {
        ...p,
        previous_energy: fallback.previous_energy,
        predicted_drain: +predictedDrain.toFixed(3),
        predicted_energy: predictedEnergy,
        energy_pct: +(predictedEnergy / BATTERY_CAP * 100).toFixed(1),
      };
    });
    report = {
      ...fallbackReport,
      ...report,
      predictions,
      summary: {
        avg_energy: predictions.length ? +(predictions.reduce((a, p) => a + p.predicted_energy, 0) / predictions.length).toFixed(2) : 0,
        min_energy: predictions.length ? +Math.min(...predictions.map(p => p.predicted_energy)).toFixed(2) : 0,
        total_predicted_drain: +predictions.reduce((a, p) => a + p.predicted_drain, 0).toFixed(2),
        node_count: predictions.length,
      },
    };

    const byId = new globalThis.Map(report.predictions.map(p => [p.id, p]));
    const nextNodes = pressuredNodes.map(n => {
      const p = byId.get(n.id);
      if (!p) return n;
      return {
        ...n,
        energy: p.predicted_energy,
        energy_pct: p.energy_pct,
        pulse: Date.now(),
      };
    });

    const { nodes: routedNodes, deadIds } = applyDeadNodeRebuild(nextNodes, "battery depleted during drain");

    setNodes(routedNodes);
    setEnergyReport(report);
    setTimeout(() => { detectHotspots(routedNodes, { includeTrafficPressure: true }); computeAnalytics(routedNodes, { includeTrafficPressure: true }); }, 80);
    const source = report.model === "frontend_ml_fallback" ? "frontend fallback" : "backend ML model";
    const drainEntry = {
      wave: execLog.length + 1,
      type: "DRAIN",
      msg: `ML energy calculation completed by ${source}: ${report.summary.node_count} nodes, total predicted drain ${report.summary.total_predicted_drain}.${deadIds.length ? ` Dead nodes removed: ${deadIds.join(", ")}.` : ""}`,
    };
    setExecLog(p => [...p, drainEntry]);
    setActiveStep(execLog.length);
    setTimeout(() => transmitDataToBase({ includeAck: true, reason: "drain" }), 260);
  }

  function getPathToRoot(startId, ns = nodesRef.current) {
    const path = [];
    const seen = new Set();
    let cur = ns.find(n => n.id === startId);
    while (cur && !isDeadNode(cur) && !cur.is_root && cur.parent && !seen.has(cur.id)) {
      seen.add(cur.id);
      path.push([cur.id, cur.parent]);
      cur = ns.find(n => n.id === cur.parent);
    }
    return cur?.is_root ? path : [];
  }

  function getRouteNodeIds(startId, ns = nodesRef.current) {
    const hops = getPathToRoot(startId, ns);
    if (!hops.length) return [];
    return [startId, ...hops.map(([, parent]) => parent)];
  }

  function logScenario(msg, color = "#f59e0b") {
    const entry = { msg, color, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) };
    setScenarioLog(p => [entry, ...p].slice(0, 8));
    setExecLog(p => [...p, { wave: p.length + 1, type: "DATA", msg }]);
    setActiveStep(execLog.length);
  }

  function recalcAfterScenario(nextNodes) {
    const { nodes: routedNodes } = applyDeadNodeRebuild(nextNodes, "battery depleted during scenario");
    setNodes(routedNodes);
    setTimeout(() => { detectHotspots(routedNodes, { includeTrafficPressure: true }); computeAnalytics(routedNodes, { includeTrafficPressure: true }); }, 80);
  }

  function selectedOrWeakestNode(ns = nodesRef.current) {
    const selected = selNode ? ns.find(n => n.id === selNode.id && !n.is_root && !isDeadNode(n)) : null;
    if (selected) return selected;
    return [...ns].filter(n => !n.is_root && !isDeadNode(n)).sort((a, b) => a.energy - b.energy)[0] || null;
  }

  function drainSelectedNode() {
    const target = selectedOrWeakestNode();
    if (!target) return;
    const next = nodesRef.current.map(n => n.id === target.id
      ? { ...n, energy: Math.max(0, n.energy - 35), energy_pct: Math.max(0, n.energy_pct - 35), pulse: Date.now() }
      : n);
    recalcAfterScenario(next);
    logScenario(`Failure drill: ${target.id} lost 35% battery and should be watched for parent re-election.`, "#ef4444");
  }

  function killSelectedNode() {
    const target = selectedOrWeakestNode();
    if (!target) return;
    const next = nodesRef.current.map(n => {
      if (n.id === target.id) return { ...n, dead: true, energy: 0, energy_pct: 0, joined: false, parent: null, children: [], flags: ["dead", "low_energy"], pulse: Date.now() };
      if (n.parent === target.id) return { ...n, parent: null, rank: INF, joined: false, etx: 1, pulse: Date.now() };
      return { ...n, children: (n.children || []).filter(c => c !== target.id) };
    });
    recalcAfterScenario(next);
    logScenario(`Node failure: ${target.id} was taken offline; direct children became orphaned until the next Run/Step.`, "#ef4444");
  }

  function burstTraffic() {
    const ns = nodesRef.current;
    const target = (selNode && ns.find(n => n.id === selNode.id && !n.is_root)) || ns.find(n => hotspots.some(h => h.node_id === n.id)) || ns.find(n => !n.is_root && n.children.length);
    if (!target) return;
    const next = ns.map(n => n.id === target.id
      ? { ...n, traffic_rx: n.traffic_rx + 12, traffic_tx: n.traffic_tx + Math.max(4, n.children.length * 3), energy: Math.max(0, n.energy - 8), energy_pct: Math.max(0, n.energy_pct - 8), pulse: Date.now() }
      : n);
    recalcAfterScenario(next);
    logScenario(`Traffic burst: ${target.id} received relay pressure and may become a hotspot.`, "#f59e0b");
  }

  function jamRadioRange() {
    setRadioRange(r => Math.max(100, r - 45));
    logScenario("Radio jamming drill: communication range was reduced. Run again to see isolated nodes.", "#f59e0b");
  }

  function randomFailure() {
    const candidates = nodesRef.current.filter(n => !n.is_root);
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    if (!target) return;
    setSelNode(target);
    const next = nodesRef.current.map(n => n.id === target.id
      ? { ...n, energy: Math.max(0, n.energy - 35), energy_pct: Math.max(0, n.energy_pct - 35), pulse: Date.now() }
      : n);
    recalcAfterScenario(next);
    logScenario(`Random failure drill selected ${target.id} and reduced its battery by 35%.`, "#ef4444");
  }

  function transmitDataToBase({ includeAck = true, reason = "manual" } = {}) {
    if (dataTimerRef.current) { clearInterval(dataTimerRef.current); dataTimerRef.current = null; }
    const ns = nodesRef.current;
    const sources = ns.filter(n => !isDeadNode(n) && !n.is_root && n.joined && n.parent);
    const leaves = sources.filter(n => !ns.some(o => !isDeadNode(o) && o.parent === n.id));
    const senders = (leaves.length ? leaves : sources).slice(0, 6);
    const root = ns.find(n => n.is_root);
    const routes = senders.map(n => {
      const route = getPathToRoot(n.id, ns);
      if (route.length && root) route.push([root.id, BASE_STATION_ID]);
      return route;
    }).filter(route => route.length);
    const dataHops = routes.flatMap((route, i) => route.map((hop, j) => ({ hop, delay: i * 5 + j })))
      .sort((a, b) => a.delay - b.delay)
      .map(x => x.hop);
    const ackHops = includeAck
      ? routes.flatMap((route, i) => [...route].reverse().map(([from, to], j) => ({ hop: [to, from], delay: dataHops.length + 3 + i * 5 + j })))
        .sort((a, b) => a.delay - b.delay)
        .map(x => x.hop)
      : [];
    const hops = [
      ...dataHops.map(hop => ({ hop, kind: "DATA" })),
      ...ackHops.map(hop => ({ hop, kind: "ACK" })),
    ];

    if (!hops.length) return;
    setPhase(p => p === "idle" ? "done" : p);
    setExecLog(p => [...p, {
      wave: p.length + 1,
      type: "DATA",
      msg: reason === "drain"
        ? `Drain created traffic: ${senders.length} sensor ${senders.length === 1 ? "node" : "nodes"} sent DATA to the Base Station, then received ACK replies.`
        : `${senders.length} sensor ${senders.length === 1 ? "node" : "nodes"} sent DATA through the DODAG root to the Base Station and received ACK replies.`,
    }]);
    setActiveStep(execLog.length);

    let idx = 0;
    dataTimerRef.current = setInterval(() => {
      const item = hops[idx++];
      const [from, to] = item?.hop || [];
      if (!from || !to) {
        clearInterval(dataTimerRef.current);
        dataTimerRef.current = null;
        return;
      }
      const isAck = item.kind === "ACK";
      spawnPkt(from, to, isAck ? "#a855f7" : "#06b6d4", isAck ? "ACK" : "DATA");
      if (to === BASE_STATION_ID && cvRef.current) {
        const rect = cvRef.current.getBoundingClientRect();
        const base = currentBaseStation(rect.width || 680, rect.height || 560);
        spawnRipple(base.x, base.y, "#06b6d4");
      }
      if (isAck) setAckCount(c => c + 1);
      else setDataCount(c => c + 1);
    }, 170);
  }

  function addNodeClick() {
    const cv = cvRef.current;
    const W = cv?.offsetWidth || 680, H = cv?.offsetHeight || 560;
    const id = `0x${nodeCounter.toString(16).toUpperCase().padStart(4, "0")}`;
    if (manualInsert) {
      addManualNode();
      return;
    }
    const angle = Math.random() * Math.PI * 2, r = 80 + Math.random() * 180;
    setNodes(p => [...p, makeNode(id, Math.max(40, Math.min(W - 40, W / 2 + Math.cos(angle) * r)), Math.max(40, Math.min(H - 40, H / 2 + Math.sin(angle) * r)))]);
    setNodeCounter(c => c + 1);
  }

  function makeManualNodeAt(x, y) {
    const id = `0x${nodeCounter.toString(16).toUpperCase().padStart(4, "0")}`;
    const energy = Math.max(1, Math.min(100, Number(manualEnergy) || 1));
    const baseDistance = Math.max(40, Math.min(520, Number(manualDistance) || 40));
    const rank = Math.max(1, Math.min(50, Number(manualRank) || 1));
    return makeNode(id, x, y, false, {
      energy,
      manual: { rank, baseDistance, energy },
    });
  }

  function addManualNode(point = null) {
    const cv = cvRef.current;
    const rect = cv?.getBoundingClientRect();
    const W = rect?.width || cv?.offsetWidth || 680;
    const H = rect?.height || cv?.offsetHeight || 560;
    const base = currentBaseStation(W, H);
    const distance = Math.max(40, Math.min(520, Number(manualDistance) || 40));
    const angle = point ? Math.atan2(point.y - base.y, point.x - base.x) : (-Math.PI * 0.72 + (nodeCounter % 7) * 0.36);
    const x = Math.max(45, Math.min(W - 45, base.x + Math.cos(angle) * distance));
    const y = Math.max(45, Math.min(H - 45, base.y + Math.sin(angle) * distance));
    setNodes(p => [...p, makeManualNodeAt(x, y)]);
    setNodeCounter(c => c + 1);
  }

  function applyPreset(kind) {
    const cv = cvRef.current;
    const rect = cv?.getBoundingClientRect();
    const W = rect?.width || cv?.offsetWidth || 900;
    const H = rect?.height || cv?.offsetHeight || 600;
    const cx = W / 2;
    let rows;

    if (kind === "healthy") rows = DEFAULT_NODES(W, H);
    else if (kind === "dense") rows = [
      { id: "0x0001", x: cx, y: 72, is_root: true },
      ...Array.from({ length: 18 }, (_, i) => {
        const ring = i < 6 ? 145 : i < 12 ? 255 : 365;
        const angle = -Math.PI / 2 + (i % 6) * (Math.PI * 2 / 6) + (i >= 6 ? 0.22 : 0);
        return { id: `0x${(i + 2).toString(16).toUpperCase().padStart(4, "0")}`, x: Math.max(50, Math.min(W - 55, cx + Math.cos(angle) * ring)), y: Math.max(55, Math.min(H - 55, 250 + Math.sin(angle) * ring * .62)) };
      }),
    ];
    else if (kind === "sparse") rows = [
      { id: "0x0001", x: cx, y: 80, is_root: true },
      { id: "0x0002", x: cx - 230, y: 210 },
      { id: "0x0003", x: cx + 220, y: 215 },
      { id: "0x0004", x: cx - 330, y: 390 },
      { id: "0x0005", x: cx - 40, y: 390 },
      { id: "0x0006", x: cx + 330, y: 390 },
      { id: "0x0007", x: cx + 80, y: 525 },
    ];
    else if (kind === "low") rows = DEFAULT_NODES(W, H).map((n, i) => ({ ...n, energy: i === 0 ? 100 : Math.max(18, 58 - i * 3) }));
    else rows = [
      { id: "0x0001", x: cx, y: 75, is_root: true },
      { id: "0x0002", x: cx - 80, y: 205 },
      { id: "0x0003", x: cx + 80, y: 205 },
      { id: "0x0004", x: cx - 120, y: 335 },
      { id: "0x0005", x: cx - 60, y: 440 },
      { id: "0x0006", x: cx + 30, y: 440 },
      { id: "0x0007", x: cx + 115, y: 335 },
      { id: "0x0008", x: cx + 190, y: 465 },
      { id: "0x0009", x: cx - 210, y: 465 },
    ];

    const next = rows.map(r => makeNode(r.id, r.x, r.y, r.is_root || false, { energy: r.energy ?? BATTERY_CAP }));
    setNodes(next);
    setNodeCounter(next.length + 1);
    resetStats();
    setScenarioLog([{ msg: `Preset loaded: ${kind}. Run the DODAG to inspect routing behavior.`, color: "#38bdf8", time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }]);
    setActiveTab("nodes");
  }

  function simulateFormation(modeName) {
    const copy = nodesRef.current.map(n => ({ ...n, children: [] }));
    const roots = copy.filter(n => n.is_root);
    const q = [...roots];
    const visited = new Set(roots.map(r => r.id));
    let messages = 0;
    const rankFor = (s, r) => {
      if (r.manual) {
        const distanceCost = r.manual.baseDistance / 120;
        const energyPenalty = Math.max(0, 100 - r.manual.energy) / 35;
        return +Math.max(s.rank + 1, r.manual.rank + distanceCost + energyPenalty).toFixed(2);
      }
      if (modeName === "hop") return s.rank + 1;
      const d = dist(s, r) / radioRange;
      return +(s.rank + 1 + 2.4 * d * d).toFixed(2);
    };

    while (q.length) {
      const s = q.shift();
      copy.filter(o => o.id !== s.id && dist(s, o) < radioRange).forEach(nb => {
        messages += 1;
        const nr = rankFor(s, nb);
        if (nr < nb.rank) {
          if (nb.parent) {
            const oldParent = copy.find(n => n.id === nb.parent);
            if (oldParent) oldParent.children = oldParent.children.filter(c => c !== nb.id);
          }
          nb.parent = s.id;
          nb.rank = nr;
          nb.joined = true;
          if (!s.children.includes(nb.id)) s.children.push(nb.id);
        }
        if (!visited.has(nb.id)) {
          visited.add(nb.id);
          q.push(nb);
        }
      });
    }

    const joined = copy.filter(n => n.joined || n.is_root).length;
    const ranked = copy.filter(n => n.rank !== INF).map(n => n.rank);
    const relays = copy.filter(n => n.children.length).length;
    const maxChildren = Math.max(0, ...copy.map(n => n.children.length));
    return {
      mode: modeName === "hop" ? "OF0 Hop" : "MRHOF ETX",
      joined,
      links: copy.filter(n => n.parent).length,
      avgRank: ranked.length ? +(ranked.reduce((a, b) => a + b, 0) / ranked.length).toFixed(2) : 0,
      maxRank: ranked.length ? Math.max(...ranked) : 0,
      messages,
      relays,
      maxChildren,
    };
  }

  function compareModes() {
    const result = { hop: simulateFormation("hop"), etx: simulateFormation("etx") };
    setComparison(result);
    setActiveTab("lab");
  }

  function exportReport() {
    const report = {
      generated_at: new Date().toISOString(),
      phase,
      objective_function: ofMode,
      radio_range: radioRange,
      counters: { dioCount, daoCount, dataCount, ackCount, stepCount },
      analytics,
      hotspots,
      energy_report: energyReport,
      scenario_log: scenarioLog,
      comparison,
      nodes: nodesRef.current.map(n => ({
        id: n.id,
        is_root: n.is_root,
        rank: n.rank === INF ? null : n.rank,
        parent: n.parent,
        children: n.children,
        energy_pct: n.energy_pct,
        traffic_rx: n.traffic_rx,
        traffic_tx: n.traffic_tx,
        joined: n.joined || n.is_root,
      })),
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `rpl-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function runGuidedDemo() {
    if (guideRunning) return;
    setGuideOpen(true);
    setGuideRunning(true);
    setGuideStep(0);
    setActiveTab("execlog");
    resetDodag();
    setTimeout(() => { setGuideStep(1); animate(); }, 250);
    setTimeout(() => { setGuideStep(2); transmitDataToBase(); }, 3600);
    setTimeout(() => { setGuideStep(3); drainEnergy(); setActiveTab("ml"); }, 5200);
    setTimeout(() => { setGuideStep(4); resolveIssues(); setActiveTab("analytics"); }, 7600);
    setTimeout(() => { setGuideStep(5); compareModes(); setGuideRunning(false); }, 9000);
  }

  // ── CANVAS DRAW ──
  useEffect(() => {
    const cv = cvRef.current; if (!cv) return;
    const ctx = cv.getContext("2d");
    const rect = cv.getBoundingClientRect();
    const W = rect.width || cv.width, H = rect.height || cv.height;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.canvasFill; ctx.fillRect(0, 0, W, H);
    const nowMs = Date.now();

    ctx.save();
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, theme === "soft" ? "rgba(255,255,255,.62)" : "rgba(8,22,34,.44)");
    bg.addColorStop(0.58, theme === "soft" ? "rgba(231,242,250,.55)" : "rgba(7,18,29,.26)");
    bg.addColorStop(1, theme === "soft" ? "rgba(238,246,251,.64)" : "rgba(4,10,18,.36)");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const quietGlow = ctx.createRadialGradient(W * .5, H * .28, 0, W * .5, H * .28, Math.max(W, H) * .64);
    quietGlow.addColorStop(0, theme === "soft" ? "rgba(56,189,248,.10)" : "rgba(56,189,248,.08)");
    quietGlow.addColorStop(1, "rgba(56,189,248,0)");
    ctx.fillStyle = quietGlow;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = C.gridLine; ctx.lineWidth = 0.5;
    for (let x = 0; x < W; x += 40) {
      ctx.globalAlpha = x % 120 === 0 ? .48 : .25;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y < H; y += 40) {
      ctx.globalAlpha = y % 120 === 0 ? .48 : .25;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    ctx.restore();

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
        grad.addColorStop(0, C.rangeFill); grad.addColorStop(1, "rgba(59,130,246,0)");
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
          ctx.strokeStyle = C.linkGhost;
          ctx.beginPath(); ctx.moveTo(nodes[i].x, nodes[i].y); ctx.lineTo(nodes[j].x, nodes[j].y); ctx.stroke();
        }
      }
      ctx.restore();
    }

    if (showHeatmap && energyReport?.predictions?.length) {
      const predictions = new Map(energyReport.predictions.map(p => [p.id, p]));
      nodes.forEach(n => {
        const p = predictions.get(n.id);
        if (!p) return;
        const drainPressure = Math.min(1, p.predicted_drain / 4);
        const lowEnergyPressure = Math.min(1, (100 - p.energy_pct) / 100);
        const pressure = Math.max(drainPressure, lowEnergyPressure);
        const radius = 38 + pressure * 54 + Math.max(0, n.children.length - 1) * 8;
        const color = p.energy_pct < 25 ? [239, 68, 68] : p.energy_pct < 50 ? [245, 158, 11] : [34, 197, 94];
        const grad = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, radius);
        grad.addColorStop(0, `rgba(${color[0]},${color[1]},${color[2]},${0.26 + pressure * 0.16})`);
        grad.addColorStop(0.46, `rgba(${color[0]},${color[1]},${color[2]},${0.12 + pressure * 0.10})`);
        grad.addColorStop(1, `rgba(${color[0]},${color[1]},${color[2]},0)`);
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(n.x, n.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });
    }

    const baseStation = currentBaseStation(W, H);
    const rootNode = nodes.find(n => n.is_root);
    if (rootNode) {
      ctx.save();
      ctx.setLineDash([8, 7]);
      ctx.strokeStyle = "rgba(6,182,212,0.58)";
      ctx.lineWidth = 2.2;
      const mx = (rootNode.x + baseStation.x) / 2;
      const my = (rootNode.y + baseStation.y) / 2 - 46;
      ctx.beginPath();
      ctx.moveTo(rootNode.x, rootNode.y);
      ctx.quadraticCurveTo(mx, my, baseStation.x, baseStation.y);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.translate(baseStation.x, baseStation.y);
    const towerGlow = hovBaseStation ? 0.34 : 0.22;
    const bodyGrad = ctx.createLinearGradient(-46, 0, 46, 58);
    bodyGrad.addColorStop(0, theme === "soft" ? "rgba(255,255,255,0.94)" : "rgba(14,165,233,0.28)");
    bodyGrad.addColorStop(0.52, theme === "soft" ? "rgba(226,246,253,0.9)" : "rgba(8,47,73,0.72)");
    bodyGrad.addColorStop(1, theme === "soft" ? "rgba(207,250,254,0.86)" : "rgba(15,23,42,0.82)");

    const halo = ctx.createRadialGradient(0, -30, 5, 0, -30, 92);
    halo.addColorStop(0, `rgba(34,211,238,${towerGlow})`);
    halo.addColorStop(0.55, `rgba(14,165,233,${towerGlow * 0.38})`);
    halo.addColorStop(1, "rgba(14,165,233,0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, -24, 92, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowColor = "#38bdf8";
    ctx.shadowBlur = hovBaseStation ? 30 : 16;
    ctx.fillStyle = bodyGrad;
    ctx.strokeStyle = hovBaseStation ? "#22d3ee" : "rgba(125,211,252,0.92)";
    ctx.lineWidth = hovBaseStation ? 2.8 : 2;
    ctx.beginPath();
    ctx.roundRect(-46, 4, 92, 56, 10);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.fillStyle = theme === "soft" ? "rgba(8,145,178,0.12)" : "rgba(6,182,212,0.18)";
    ctx.beginPath();
    ctx.roundRect(-34, 15, 68, 28, 7);
    ctx.fill();
    ctx.strokeStyle = "rgba(125,211,252,0.42)";
    ctx.stroke();

    ctx.strokeStyle = "#7dd3fc";
    ctx.lineWidth = 3.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(0, 4);
    ctx.lineTo(0, -68);
    ctx.moveTo(-30, 4);
    ctx.lineTo(0, -38);
    ctx.lineTo(30, 4);
    ctx.moveTo(-23, -48);
    ctx.lineTo(0, -68);
    ctx.lineTo(23, -48);
    ctx.moveTo(-18, -27);
    ctx.lineTo(18, -27);
    ctx.moveTo(-23, -9);
    ctx.lineTo(23, -9);
    ctx.stroke();

    ctx.fillStyle = theme === "soft" ? "#e0faff" : "#082f49";
    ctx.strokeStyle = "#67e8f9";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(-18, -1, 36, 12, 5);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#06b6d4";
    ctx.beginPath();
    ctx.arc(0, -69, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#cffafe";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    for (let i = 0; i < 4; i++) {
      const pulse = ((nowMs / 900) + i * 0.22) % 1;
      ctx.globalAlpha = (hovBaseStation ? 0.42 : 0.3) * (1 - pulse * 0.7);
      ctx.lineWidth = 2.2 - i * 0.25;
      ctx.beginPath();
      ctx.arc(0, -69, 18 + i * 13 + pulse * 18, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    ctx.fillStyle = theme === "soft" ? "#0f172a" : "#ecfeff";
    ctx.font = "900 10px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("BASE", 0, 25);
    ctx.fillText("STATION", 0, 38);

    ctx.fillStyle = hovBaseStation ? "#cffafe" : "#67e8f9";
    ctx.font = "800 8px system-ui, sans-serif";
    ctx.beginPath();
    ctx.roundRect(-23, 48, 46, 14, 7);
    ctx.fillStyle = hovBaseStation ? "rgba(8,145,178,0.9)" : "rgba(8,47,73,0.78)";
    ctx.fill();
    ctx.fillStyle = "#ecfeff";
    ctx.fillText("DRAG", 0, 55);
    ctx.restore();

    nodes.forEach(n => {
      if (!n.parent || isDeadNode(n)) return;
      const par = nodes.find(x => x.id === n.parent); if (!par || isDeadNode(par)) return;
      const ang = Math.atan2(par.y - n.y, par.x - n.x);
      const sx = n.x + Math.cos(ang) * (n.r + 2), sy = n.y + Math.sin(ang) * (n.r + 2);
      const tx = par.x - Math.cos(ang) * (par.r + 3), ty = par.y - Math.sin(ang) * (par.r + 3);
      const isIssue = hotspots.some(h => h.node_id === par.id);
      const lc = isIssue ? "#f59e0b" : "#22c55e";
      const cx = (sx + tx) / 2 + Math.sin(ang) * 18;
      const cy = (sy + ty) / 2 - Math.cos(ang) * 18;
      ctx.save(); ctx.setLineDash([]);
      ctx.shadowColor = lc; ctx.shadowBlur = 8; ctx.lineWidth = 2.2; ctx.strokeStyle = lc + "dd";
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.quadraticCurveTo(cx, cy, tx, ty); ctx.stroke();
      const flow = ((nowMs / 900) + n.id.charCodeAt(n.id.length - 1) * .07) % 1;
      const qx = (1 - flow) * (1 - flow) * sx + 2 * (1 - flow) * flow * cx + flow * flow * tx;
      const qy = (1 - flow) * (1 - flow) * sy + 2 * (1 - flow) * flow * cy + flow * flow * ty;
      ctx.shadowColor = lc;
      ctx.shadowBlur = 8;
      ctx.fillStyle = lc;
      ctx.beginPath();
      ctx.arc(qx, qy, 2.4, 0, Math.PI * 2);
      ctx.fill();
      const ax = tx - Math.cos(ang) * 3, ay = ty - Math.sin(ang) * 3;
      ctx.beginPath(); ctx.moveTo(ax, ay);
      ctx.lineTo(ax - Math.cos(ang - .42) * 9, ay - Math.sin(ang - .42) * 9);
      ctx.lineTo(ax - Math.cos(ang + .42) * 9, ay - Math.sin(ang + .42) * 9);
      ctx.closePath(); ctx.fillStyle = lc; ctx.fill(); ctx.shadowBlur = 0;
      if (showETX && n.rank !== INF) {
        ctx.font = "9px monospace"; ctx.fillStyle = "#64748b";
        ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ctx.fillText(n.etx?.toFixed(2), cx, cy - 3);
      }
      ctx.restore();
    });

    if (selNode) {
      const route = getPathToRoot(selNode.id, nodes);
      if (route.length) {
        const selectedIds = new Set(getRouteNodeIds(selNode.id, nodes));
        const root = nodes.find(n => n.is_root);
        const routeHops = root ? [...route, [root.id, BASE_STATION_ID]] : route;
        routeHops.forEach(([fromId, toId]) => {
          const from = fromId === BASE_STATION_ID ? baseStation : nodes.find(n => n.id === fromId);
          const to = toId === BASE_STATION_ID ? baseStation : nodes.find(n => n.id === toId);
          if (!from || !to) return;
          const ang = Math.atan2(to.y - from.y, to.x - from.x);
          const sx = from.x + Math.cos(ang) * 30;
          const sy = from.y + Math.sin(ang) * 30;
          const tx = to.x - Math.cos(ang) * 30;
          const ty = to.y - Math.sin(ang) * 30;
          ctx.save();
          ctx.strokeStyle = "#38bdf8";
          ctx.shadowColor = "#38bdf8";
          ctx.shadowBlur = 16;
          ctx.lineWidth = 5;
          ctx.lineCap = "round";
          ctx.setLineDash([10, 7]);
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(tx, ty);
          ctx.stroke();
          ctx.restore();
        });
        nodes.filter(n => selectedIds.has(n.id)).forEach(n => {
          ctx.save();
          ctx.strokeStyle = "#bae6fd";
          ctx.lineWidth = 3;
          ctx.shadowColor = "#38bdf8";
          ctx.shadowBlur = 14;
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r + 12, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        });
      }
    }

    pkts.forEach(p => {
      const ease = p.t < .5 ? 2 * p.t * p.t : 1 - 2 * (1 - p.t) * (1 - p.t);
      const px = p.fx + (p.tx - p.fx) * ease, py = p.fy + (p.ty - p.fy) * ease;
      const al = p.t < .12 ? p.t / .12 : p.t > .82 ? (1 - p.t) / .18 : 1;
      const ang = Math.atan2(p.ty - p.fy, p.tx - p.fx);
      ctx.save(); ctx.globalAlpha = al;
      const trail = ctx.createLinearGradient(px - Math.cos(ang) * 34, py - Math.sin(ang) * 34, px, py);
      trail.addColorStop(0, p.color + "00");
      trail.addColorStop(1, p.color + "aa");
      ctx.strokeStyle = trail;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 10;
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(px - Math.cos(ang) * 34, py - Math.sin(ang) * 34);
      ctx.lineTo(px, py);
      ctx.stroke();
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
      const isDead = isDeadNode(n);
      const isSel = selNode?.id === n.id, isHov = hovNode?.id === n.id && !isSel;
      const pAge = (now - (n.pulse || 0)) / 650;
      let col = isDead ? "#475569" : n.is_root ? "#ef4444" : n.joined ? "#22c55e" : "#334155";
      if (isHs) col = "#f59e0b"; if (isCrit) col = "#ef4444";

      ctx.save();
      if (pAge < 1 && n.pulse) {
        ctx.globalAlpha = (1 - pAge) * 0.35;
        ctx.beginPath(); ctx.arc(n.x, n.y, nr + 15 * (1 - pAge), 0, Math.PI * 2);
        ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;
      }
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,.28)";
      ctx.shadowBlur = 12;
      ctx.fillStyle = "rgba(0,0,0,.20)";
      ctx.beginPath();
      ctx.ellipse(n.x, n.y + nr + 8, nr * 0.78, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.shadowColor = col;
      ctx.shadowBlur = isSel ? 20 : isHov ? 13 : (n.joined || n.is_root) ? 7 : 3;
      ctx.save();
      const aura = ctx.createRadialGradient(n.x, n.y, nr * .4, n.x, n.y, nr + (isSel || isHov ? 42 : 28));
      aura.addColorStop(0, col + (isSel || isHov ? "22" : "12"));
      aura.addColorStop(.54, col + "08");
      aura.addColorStop(1, col + "00");
      ctx.fillStyle = aura;
      ctx.beginPath();
      ctx.arc(n.x, n.y, nr + (isSel || isHov ? 42 : 28), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      if (!n.is_root && !isDead) {
        const ep = n.energy_pct / BATTERY_CAP;
        ctx.beginPath(); ctx.arc(n.x, n.y, nr + 6, -Math.PI / 2, -Math.PI / 2 + ep * Math.PI * 2);
        ctx.strokeStyle = ep > 0.5 ? "#22c55e" : ep > 0.25 ? "#f59e0b" : "#ef4444";
        ctx.lineWidth = 3; ctx.setLineDash([]); ctx.shadowBlur = 0; ctx.stroke();
      }
      if (isSel) {
        ctx.beginPath(); ctx.arc(n.x, n.y, nr + 9, 0, Math.PI * 2);
        ctx.strokeStyle = "#60a5fa"; ctx.lineWidth = 2; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
      }
      const g = ctx.createRadialGradient(n.x - nr * .3, n.y - nr * .3, 2, n.x, n.y, nr);
      if (isDead)      { g.addColorStop(0, "#64748b"); g.addColorStop(1, "#1f2937"); }
      else if (isHs)   { g.addColorStop(0, "#fcd34d"); g.addColorStop(1, "#d97706"); }
      else if (isCrit) { g.addColorStop(0, "#f87171"); g.addColorStop(1, "#dc2626"); }
      else if (n.is_root) { g.addColorStop(0, "#ff6b6b"); g.addColorStop(1, "#dc2626"); }
      else if (n.joined)  { g.addColorStop(0, "#4ade80"); g.addColorStop(1, "#15803d"); }
      else { g.addColorStop(0, "#475569"); g.addColorStop(1, "#1e293b"); }
      ctx.beginPath(); ctx.arc(n.x, n.y, nr, 0, Math.PI * 2);
      ctx.fillStyle = g; ctx.fill();
      ctx.strokeStyle = isSel ? "#bae6fd" : col + "dd"; ctx.lineWidth = 1.6; ctx.setLineDash([]); ctx.stroke();
      ctx.save();
      ctx.globalAlpha = .38;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.ellipse(n.x - nr * .28, n.y - nr * .34, nr * .34, nr * .18, -0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.shadowBlur = 0;
      ctx.font = n.is_root ? "700 13px system-ui, sans-serif" : "700 11px system-ui, sans-serif";
      ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(isDead ? "X" : n.is_root ? "R" : n.rank === INF ? "?" : ofMode === "hop" ? String(n.rank) : n.rank.toFixed(1), n.x, n.y);
      if (showLabels) {
        ctx.font = "10px ui-monospace, Consolas, monospace"; ctx.fillStyle = isDead ? "#94a3b8" : isSel ? "#bfdbfe" : "#64748b";
        ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText(isDead ? `${n.id} DEAD` : n.id, n.x, n.y + nr + 4);
      }
      if (n.manual) {
        ctx.font = "bold 9px system-ui, sans-serif";
        ctx.fillStyle = "#c4b5fd";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.beginPath();
        ctx.roundRect(n.x - 11, n.y - nr - 17, 22, 12, 4);
        ctx.fillStyle = "rgba(88,28,135,.82)";
        ctx.fill();
        ctx.fillStyle = "#ddd6fe";
        ctx.fillText("MAN", n.x, n.y - nr - 11);
      }
      if (isHs || isCrit) { ctx.font = "12px sans-serif"; ctx.fillText(isCrit ? "⚡" : "🔥", n.x + nr * .8, n.y - nr * .8); }
      ctx.restore();
    });
  }, [nodes, baseStation, selNode, hovNode, hovBaseStation, hotspots, showRange, showLinks, showLabels, showETX, showHeatmap, energyReport, ofMode, radioRange, pkts, ripples, theme]);

  useEffect(() => {
    if (pkts.length) setPkts(p => p.map(x => ({ ...x, t: Math.min(1, x.t + 0.04) })));
    if (ripples.length) setRipples(p => p.map(x => ({ ...x, t: Math.min(1, x.t + 0.055) })).filter(x => x.t < 1));
  }, [pkts.length, ripples.length]);

  function resize() {
    const area = areaRef.current; if (!area) return;
    const r = area.getBoundingClientRect();
    if (cvRef.current) {
      const dpr = window.devicePixelRatio || 1;
      cvRef.current.width = Math.max(1, Math.round(r.width * dpr));
      cvRef.current.height = Math.max(1, Math.round(r.height * dpr));
      cvRef.current.style.width = `${r.width}px`;
      cvRef.current.style.height = `${r.height}px`;
    }
    setBaseStation(p => p || getBaseStationPos(r.width || 680, r.height || 560));
  }
  useEffect(() => { resize(); window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, []);

  function getPos(e) {
    const cv = cvRef.current; const r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function hitNode(x, y) { return nodesRef.current.slice().reverse().find(n => dist({ x, y }, n) < n.r + 8); }
  function hitBaseStation(x, y) {
    const cv = cvRef.current;
    const rect = cv?.getBoundingClientRect();
    const base = currentBaseStation(rect?.width || 680, rect?.height || 560);
    return x >= base.x - 54 && x <= base.x + 54 && y >= base.y - 92 && y <= base.y + 70;
  }

  function onMouseMove(e) {
    const { x, y } = getPos(e);
    const hoveringBase = hitBaseStation(x, y);
    setHovBaseStation(hoveringBase);
    setHovNode(hoveringBase ? null : hitNode(x, y) || null);
    if (dragRef.current === BASE_STATION_ID) {
      const cv = cvRef.current;
      const rect = cv?.getBoundingClientRect();
      const W = rect?.width || 680, H = rect?.height || 560;
      setBaseStation({
        x: Math.max(50, Math.min(W - 50, x - dragOff.current.x)),
        y: Math.max(85, Math.min(H - 58, y - dragOff.current.y)),
      });
    } else if (dragRef.current) {
      setNodes(p => p.map(n => n.id === dragRef.current ? { ...n, x: x - dragOff.current.x, y: y - dragOff.current.y } : n));
    }
    if (cvRef.current) cvRef.current.style.cursor = mode === "add" ? "crosshair" : mode === "rem" ? "not-allowed" : (hoveringBase || hitNode(x, y)) ? "grab" : "default";
  }
  function onMouseDown(e) {
    const { x, y } = getPos(e);
    const onBase = hitBaseStation(x, y);
    const h = onBase ? null : hitNode(x, y);
    if (mode === "add") {
      if (!h && !onBase) {
        if (manualInsert) addManualNode({ x, y });
        else {
          const id = `0x${nodeCounter.toString(16).toUpperCase().padStart(4, "0")}`;
          setNodes(p => [...p, makeNode(id, x, y)]);
          setNodeCounter(c => c + 1);
        }
      }
      return;
    }
    if (mode === "rem") { if (h) { if (h.is_root && nodes.filter(n => n.is_root).length <= 1) return; setNodes(p => p.filter(n => n.id !== h.id)); } return; }
    if (onBase) {
      const cv = cvRef.current;
      const rect = cv?.getBoundingClientRect();
      const base = currentBaseStation(rect?.width || 680, rect?.height || 560);
      setSelNode(null);
      dragRef.current = BASE_STATION_ID;
      dragOff.current = { x: x - base.x, y: y - base.y };
      return;
    }
    if (h) { setSelNode(h); dragRef.current = h.id; dragOff.current = { x: x - h.x, y: y - h.y }; }
    else { setSelNode(null); dragRef.current = null; }
  }
  function onMouseUp() { dragRef.current = null; }

  const selN = selNode ? nodes.find(n => n.id === selNode.id) : null;
  const phBadge = { idle: ["#475569","IDLE"], building: ["#3b82f6","RUNNING"], done: ["#22c55e","DONE"] }[phase] || ["#475569","IDLE"];
  const riskNode = energyReport?.predictions?.length
    ? [...energyReport.predictions]
        .filter(p => !isDeadNode(nodes.find(n => n.id === p.id)))
        .sort((a, b) => (b.predicted_drain + (100 - b.energy_pct) * 0.04) - (a.predicted_drain + (100 - a.energy_pct) * 0.04))[0]
    : null;

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
      if (entry.msg) return entry.msg;
      return entry.msgs.map(m => `Node ${shortId(m.node)} re-elected: ${shortId(m.from)} → ${shortId(m.to)} (${m.reason}).`).join(" ");
    }
    if (entry.type === "DRAIN") {
      return entry.msg;
    }
    if (entry.type === "DATA") {
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
      DATA:  { bg: "#0e7490", color: "#ecfeff", label: "DATA" },
    };
    return map[type] || { bg: "#334155", color: "#fff", label: type };
  }

  async function sendChatMessage(e, quickText = "") {
    e?.preventDefault();
    const text = (quickText || chatInput).trim();
    if (!text || chatBusy) return;

    const nextMessages = [...chatMessages, { role: "user", text }];
    setChatMessages(nextMessages);
    setChatInput("");
    setChatBusy(true);
    setChatError("");

    const context = {
      phase,
      objectiveFunction: ofMode,
      radioRange,
      nodeCount: nodes.length,
      joinedNodes: nodes.filter(n => n.joined || n.is_root).length,
      selectedNode: selNode ? {
        id: selNode.id,
        rank: selNode.rank,
        parent: selNode.parent,
        energy_pct: selNode.energy_pct,
        children: selNode.children?.length || 0,
        routeToRoot: getRouteNodeIds(selNode.id),
      } : null,
      counters: { dioCount, daoCount, dataCount, ackCount, stepCount },
      analytics,
      hotspots,
      energyReport,
      scenarioLog,
      mlStatus,
    };

    try {
      const res = await fetch(CHAT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages, simulator_context: context }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Gemini chat failed");
      setChatMessages([...nextMessages, { role: "assistant", text: data.reply || "No reply received." }]);
    } catch (err) {
      const errorText = err.message || "Could not contact Gemini.";
      setChatError(errorText);
      setChatMessages([...nextMessages, {
        role: "assistant",
        text: `Gemini could not answer because the backend returned: ${errorText}`,
      }]);
    } finally {
      setChatBusy(false);
    }
  }

  function explainCurrentSimulation() {
    setChatOpen(true);
    sendChatMessage(null, "Explain the current RPL simulation state like a demo narrator. Include DODAG status, selected node route, hotspot risk, ML energy risk, and the next best action.");
  }

  const palettes = {
    dark: {
      bg: "#050a12", bg2: "#071723", bg3: "#102236", bg4: "#0d1c2a",
      br: "rgba(125,211,252,.22)", br2: "rgba(45,212,191,.42)",
      tx: "#f4fbff", tx2: "#b7c8d8", tx3: "#71869b",
      ac: "#38bdf8", ok: "#34d399", warn: "#fbbf24", err: "#fb7185",
      rootBg: "linear-gradient(135deg,#07111b 0%,#081a25 48%,#07101a 100%)",
      topBg: "linear-gradient(180deg,rgba(8,24,36,.94),rgba(6,14,24,.88))",
      panelBg: "linear-gradient(180deg,rgba(8,24,36,.96),rgba(6,14,24,.95))",
      railBg: "linear-gradient(180deg,rgba(8,24,36,.95),rgba(6,14,24,.92))",
      canvasShellBg: "linear-gradient(135deg,rgba(5,10,18,.42),rgba(8,28,38,.30) 48%,rgba(7,15,24,.40))",
      canvasFill: "#07111b",
      gridLine: "rgba(125,211,252,0.055)",
      rangeFill: "rgba(45,212,191,0.075)",
      linkGhost: "rgba(56,189,248,0.14)",
      overlayBg: "linear-gradient(180deg,rgba(8,25,37,.86),rgba(5,10,18,.74))",
      overlayBgStrong: "linear-gradient(180deg,rgba(9,28,42,.96),rgba(6,14,24,.88))",
      manualBg: "linear-gradient(180deg,rgba(34,22,56,.96),rgba(7,17,29,.9))",
      minimapBg: "rgba(6,16,24,0.82)",
      creditBg: "linear-gradient(180deg,rgba(9,28,42,.72),rgba(6,14,24,.62))",
      rowAlt: "rgba(16,34,54,.55)",
      rowBorder: "rgba(125,211,252,.08)",
      disabledBg: "rgba(20,35,48,.32)",
      sideBg: "rgba(10,27,39,.55)",
      sideActiveBg: "linear-gradient(180deg,rgba(45,212,191,.22),rgba(56,189,248,.12))",
      sideActiveTx: "#7dd3fc",
      tabActive: "#67e8f9",
      logoSub: "#5eead4",
      controlBg: "rgba(8,25,37,.62)",
      cardBg: "linear-gradient(180deg,rgba(16,34,54,.64),rgba(8,20,34,.48))",
      subtleShadow: "0 14px 34px rgba(0,0,0,.24)",
      panelShadow: "-14px 0 34px rgba(0,0,0,.20)",
      railShadow: "10px 0 34px rgba(0,0,0,.20)",
    },
    soft: {
      bg: "#f7fbff", bg2: "#edf5fb", bg3: "#e7f0f8", bg4: "#f2f7fb",
      br: "#c8d9e8", br2: "#93b4cc",
      tx: "#172536", tx2: "#40566e", tx3: "#73869b",
      ac: "#2563eb", ok: "#16a34a", warn: "#d97706", err: "#dc2626",
      rootBg: "linear-gradient(180deg,#f8fcff 0%,#edf6fb 48%,#e4eef7 100%)",
      topBg: "linear-gradient(180deg,rgba(255,255,255,.96),rgba(235,245,252,.94))",
      panelBg: "linear-gradient(180deg,rgba(250,253,255,.98),rgba(237,246,252,.96))",
      railBg: "linear-gradient(180deg,rgba(250,253,255,.98),rgba(231,242,250,.94))",
      canvasShellBg: "radial-gradient(circle at 50% 28%,rgba(255,255,255,.78),rgba(230,241,249,.82) 48%,rgba(215,229,241,.78))",
      canvasFill: "#eef7fb",
      gridLine: "rgba(37,99,235,0.12)",
      rangeFill: "rgba(37,99,235,0.10)",
      linkGhost: "rgba(37,99,235,0.18)",
      overlayBg: "linear-gradient(180deg,rgba(255,255,255,.9),rgba(236,246,252,.82))",
      overlayBgStrong: "linear-gradient(180deg,rgba(255,255,255,.95),rgba(232,244,251,.9))",
      manualBg: "linear-gradient(180deg,rgba(252,250,255,.96),rgba(241,236,252,.9))",
      minimapBg: "rgba(250,253,255,0.92)",
      creditBg: "linear-gradient(180deg,rgba(255,255,255,.78),rgba(235,245,252,.72))",
      rowAlt: "#eef6fb",
      rowBorder: "#d7e5f1",
      disabledBg: "rgba(202,218,232,.35)",
      sideBg: "rgba(255,255,255,.58)",
      sideActiveBg: "linear-gradient(180deg,#dbeafe,#eef6ff)",
      sideActiveTx: "#1d4ed8",
      tabActive: "#2563eb",
      logoSub: "#0e7490",
      controlBg: "rgba(255,255,255,.72)",
      cardBg: "rgba(255,255,255,.62)",
      subtleShadow: "0 10px 28px rgba(88,116,143,.14)",
      panelShadow: "-12px 0 30px rgba(88,116,143,.12)",
      railShadow: "8px 0 26px rgba(88,116,143,.10)",
    },
  };
  const C = palettes[theme];
  const guideSteps = [
    "Load the lab and reset network state.",
    "Build the DODAG with DIO and DAO routing messages.",
    "Send DATA traffic to the Base Station and return ACKs.",
    "Drain energy, score ML risk, and reveal hotspot pressure.",
    "Repair overloaded parents through local parent re-election.",
    "Compare OF0 Hop Count with MRHOF ETX.",
  ];
  const hoverInfo = hovNode ? {
    node: hovNode,
    issue: hotspots.find(h => h.node_id === hovNode.id),
    route: getRouteNodeIds(hovNode.id).join(" -> ") || "not joined",
  } : null;
  const statusBanner = mlStatus === "running"
    ? { color: C.warn, title: "ML ENERGY PREDICTION", detail: "Estimating drain and hotspot risk" }
    : phase === "building"
      ? { color: C.ac, title: "BUILDING DODAG", detail: "DIO propagation and parent selection active" }
      : phase === "done" && hotspots.length > 0
        ? { color: C.warn, title: `${hotspots.length} NETWORK ISSUE${hotspots.length > 1 ? "S" : ""}`, detail: "Hotspot repair is available" }
        : phase === "done"
          ? { color: C.ok, title: "NETWORK READY", detail: "DODAG formed and traffic can flow" }
          : { color: C.tx3, title: "SIMULATOR IDLE", detail: "Run or step to build the network" };
  const selectStyle = {
    fontSize:10,
    padding:"6px 9px",
    borderRadius:9,
    border:`1px solid ${C.br}`,
    background:C.controlBg,
    color:C.tx2,
    cursor:"pointer",
    outline:"none",
  };
  const topStatStyle = {
    display:"inline-flex",
    alignItems:"center",
    gap:4,
    padding:"5px 8px",
    borderRadius:10,
    background:C.controlBg,
    border:`1px solid ${C.br}`,
    whiteSpace:"nowrap",
  };
  const iconSize = 15;
  const panelVisible = panelOpen || !isCompact;

  function Btn({ children, onClick, disabled, color, title, icon: Icon }) {
    return (
      <button type="button" title={title} onClick={onClick} disabled={disabled}
        style={{ display:"inline-flex",alignItems:"center",gap:7,padding:"8px 12px",minHeight:36,borderRadius:10,border:`1px solid ${disabled?C.br:(color||C.ac)+"72"}`,cursor:disabled?"not-allowed":"pointer",fontSize:11,fontWeight:850,color:disabled?C.tx3:(color||C.ac),background:disabled?C.disabledBg:`linear-gradient(180deg,${(color||C.ac)+"2c"},${(color||C.ac)+"10"})`,whiteSpace:"nowrap",opacity:disabled?0.52:1,boxShadow:disabled?"none":`0 10px 28px ${(color||C.ac)+"18"}, inset 0 1px 0 rgba(255,255,255,.06)`,transition:"transform .16s ease, border-color .16s ease, background .16s ease",pointerEvents:"auto" }}>
        {Icon ? <Icon size={iconSize} strokeWidth={2.3} /> : null}
        {children}
      </button>
    );
  }
  function SideBtn({ icon, active, onClick, title }) {
    return (
      <button type="button" title={title} onClick={onClick}
        style={{ width:40,height:40,borderRadius:12,border:`1px solid ${active?C.ac:C.br}`,background:active?C.sideActiveBg:C.sideBg,color:active?C.sideActiveTx:C.tx3,cursor:"pointer",fontSize:15,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:active?`0 0 24px ${C.ac}2b, inset 0 1px 0 rgba(255,255,255,.08)`:"inset 0 1px 0 rgba(255,255,255,.04)",transition:"background .16s ease, color .16s ease, border-color .16s ease",pointerEvents:"auto" }}>
        {icon}
      </button>
    );
  }
  function TabBtn({ id, label, badge }) {
    const a = activeTab === id;
    return (
      <button type="button" onClick={() => setActiveTab(id)}
        style={{ flex:1,padding:"12px 2px",fontSize:9,fontWeight:a?900:650,color:a?C.tabActive:C.tx3,background:a?`linear-gradient(180deg,${C.ac}18,transparent)`: "transparent",border:"none",borderBottom:`2px solid ${a?C.ac:"transparent"}`,cursor:"pointer",letterSpacing:".06em",textTransform:"uppercase",position:"relative",display:"flex",alignItems:"center",justifyContent:"center",gap:4,transition:"background .16s ease, color .16s ease" }}>
        {label}
        {badge ? <span style={{ fontSize:8,padding:"0px 4px",borderRadius:6,background:C.warn,color:"#000",fontWeight:700 }}>{badge}</span> : null}
      </button>
    );
  }

  return (
    <div style={{ display:"flex",flexDirection:"column",height:"100vh",background:C.rootBg,fontFamily:"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",color:C.tx,fontSize:12,letterSpacing:0,overflow:"hidden" }}>

      {/* TOP BAR */}
      <div style={{ display:"flex",alignItems:"center",minHeight:72,background:C.topBg,borderBottom:`1px solid ${C.br}`,padding:"11px 16px",gap:10,flexShrink:0,boxShadow:C.subtleShadow,backdropFilter:"blur(16px)",flexWrap:"wrap",position:"relative",zIndex:20,pointerEvents:"auto" }}>
        <div style={{ display:"flex",alignItems:"center",gap:10,marginRight:4,minWidth:190 }}>
          <div style={{ width:38,height:38,borderRadius:12,background:"linear-gradient(135deg,#22d3ee,#34d399 48%,#a78bfa)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,boxShadow:"0 14px 34px rgba(45,212,191,.28), inset 0 1px 0 rgba(255,255,255,.32)" }}><Radio size={19} color="#041014" strokeWidth={2.8} /></div>
          <div>
            <div style={{ fontSize:16,fontWeight:950,letterSpacing:0,lineHeight:1.15 }}>RPL Web Simulator</div>
            <div style={{ fontSize:9,color:C.logoSub,letterSpacing:".08em",fontWeight:800 }}>RFC 6550 / ML ENERGY ROUTING</div>
          </div>
        </div>
        <div style={{ width:1,height:26,background:C.br }} />
        <Btn onClick={animate} disabled={simRunning} color={C.ok} icon={Play}>Run</Btn>
        <Btn onClick={stepOne} disabled={simRunning} color={C.ac} icon={StepForward}>Step</Btn>
        <Btn onClick={resetDodag} color={C.err} icon={RotateCcw}>Reset</Btn>
        <div style={{ width:1,height:26,background:C.br }} />
        <Btn onClick={transmitDataToBase} disabled={simRunning || !nodes.some(n=>!isDeadNode(n)&&!n.is_root&&n.joined&&n.parent)} color="#06b6d4" icon={Send}>Send Data</Btn>
        <Btn onClick={drainEnergy} disabled={phase!=="done"||mlStatus==="running"} color={C.warn} icon={Zap}>{mlStatus==="running"?"ML...":"Drain"}</Btn>
        <Btn onClick={resolveIssues} disabled={phase!=="done"||hotspots.length===0} color="#a855f7" icon={Wrench}>Fix</Btn>
        <Btn onClick={runGuidedDemo} disabled={guideRunning || simRunning} color="#22d3ee" icon={Sparkles}>{guideRunning ? "Tour..." : "Tour"}</Btn>
        <Btn onClick={exportReport} color="#14b8a6" icon={Download}>Report</Btn>
        <Btn onClick={explainCurrentSimulation} disabled={chatBusy} color="#38bdf8" icon={Bot}>AI Explain</Btn>
        <div style={{ width:1,height:26,background:C.br }} />
        <label style={{ fontSize:10,color:C.tx3,display:"flex",alignItems:"center",gap:5 }}>OF:
          <select value={ofMode} onChange={e=>{setOfMode(e.target.value);resetDodag();}} style={selectStyle}>
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
        <label style={{ fontSize:10,color:C.tx3,display:"flex",alignItems:"center",gap:5 }}>Theme:
          <select value={theme} onChange={e=>setTheme(e.target.value)} style={selectStyle}>
            <option value="dark">Dark</option>
            <option value="soft">Soft Light</option>
          </select>
        </label>
        {isCompact && <Btn onClick={()=>setPanelOpen(v=>!v)} color={C.tx2} icon={Menu}>{panelOpen ? "Hide Panel" : "Panel"}</Btn>}
        <span style={{ fontSize:10,padding:"3px 10px",borderRadius:10,background:phBadge[0]+"22",color:phBadge[0],border:`1px solid ${phBadge[0]}44`,fontWeight:700,letterSpacing:".06em" }}>{phBadge[1]}</span>
        <div style={{ display:"flex",gap:6,fontSize:10,color:C.tx3,flexWrap:"wrap" }}>
          <span style={topStatStyle}>DIO <b style={{ color:C.ac }}>{dioCount}</b></span>
          <span style={topStatStyle}>DAO <b style={{ color:C.warn }}>{daoCount}</b></span>
          <span style={topStatStyle}>DATA <b style={{ color:"#06b6d4" }}>{dataCount}</b></span>
          <span style={topStatStyle}>ACK <b style={{ color:"#a855f7" }}>{ackCount}</b></span>
          <span style={topStatStyle}>Steps <b style={{ color:C.tx2 }}>{stepCount}</b></span>
        </div>
      </div>

      {/* MAIN */}
      <div style={{ display:"flex",flex:1,minHeight:0 }}>

        {/* LEFT TOOLBAR */}
        <div style={{ width:64,background:C.railBg,borderRight:`1px solid ${C.br}`,display:"flex",flexDirection:"column",alignItems:"center",padding:"14px 0",gap:8,flexShrink:0,boxShadow:C.railShadow,position:"relative",zIndex:10,pointerEvents:"auto",backdropFilter:"blur(14px)" }}>
          <SideBtn icon={<MousePointer2 size={17} />} active={mode==="sel"} onClick={()=>setMode("sel")} title="Select & drag" />
          <SideBtn icon={<Plus size={18} />} active={mode==="add"} onClick={()=>setMode(mode==="add"?"sel":"add")} title="Click canvas to add node" />
          <SideBtn icon={<Trash2 size={17} />} active={mode==="rem"} onClick={()=>setMode(mode==="rem"?"sel":"rem")} title="Click node to remove" />
          <div style={{ width:28,height:1,background:C.br,margin:"4px 0" }} />
          <SideBtn icon={<Settings2 size={17} />} active={manualInsert} onClick={()=>{setManualInsert(v=>!v);setMode("add");}} title="Manual insertion: rank, base distance, energy" />
          <SideBtn icon={<LocateFixed size={17} />} active={false} onClick={addNodeClick} title="Add node randomly" />
          <div style={{ width:28,height:1,background:C.br,margin:"4px 0" }} />
          <SideBtn icon={<Radio size={17} />} active={showRange} onClick={()=>setShowRange(v=>!v)} title="Toggle radio range" />
          <SideBtn icon={<Layers size={17} />} active={showLinks} onClick={()=>setShowLinks(v=>!v)} title="Toggle radio links" />
          <SideBtn icon={<Tag size={17} />} active={showLabels} onClick={()=>setShowLabels(v=>!v)} title="Toggle labels" />
          <SideBtn icon={<Gauge size={17} />} active={showETX} onClick={()=>setShowETX(v=>!v)} title="Toggle ETX" />
          <SideBtn icon={<Radar size={17} />} active={showHeatmap} onClick={()=>setShowHeatmap(v=>!v)} title="Toggle ML energy heatmap" />
        </div>

        {/* CANVAS */}
        <div ref={areaRef} style={{ flex:1,position:"relative",overflow:"hidden",background:C.canvasShellBg }}>
          <canvas ref={cvRef} style={{ position:"absolute",top:0,left:0,width:"100%",height:"100%",display:"block",imageRendering:"auto" }}
            onMouseMove={onMouseMove} onMouseDown={onMouseDown} onMouseUp={onMouseUp}
            onMouseLeave={()=>{ setHovNode(null); setHovBaseStation(false); if(cvRef.current) cvRef.current.style.cursor="default"; }} />

          {hoverInfo && (
            <div style={{ position:"absolute",left:Math.min(Math.max(12, hoverInfo.node.x + 24), Math.max(12, (cvRef.current?.offsetWidth || 680) - 238)),top:Math.min(Math.max(12, hoverInfo.node.y - 86), Math.max(12, (cvRef.current?.offsetHeight || 560) - 154)),width:214,background:C.overlayBgStrong,border:`1px solid ${hoverInfo.issue ? C.warn+"88" : C.br}`,borderRadius:8,padding:"10px 11px",boxShadow:C.subtleShadow,backdropFilter:"blur(12px)",pointerEvents:"none",zIndex:8,textAlign:"left" }}>
              <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,marginBottom:8 }}>
                <span style={{ fontFamily:"monospace",fontSize:12,color:hoverInfo.node.is_root?C.err:C.tx,fontWeight:900 }}>{hoverInfo.node.id}</span>
                <span style={{ fontSize:8,padding:"2px 6px",borderRadius:6,background:isDeadNode(hoverInfo.node)?"#64748b22":hoverInfo.issue?C.warn+"22":C.ok+"22",color:isDeadNode(hoverInfo.node)?"#94a3b8":hoverInfo.issue?C.warn:C.ok,fontWeight:900 }}>{isDeadNode(hoverInfo.node) ? "dead" : hoverInfo.issue ? hoverInfo.issue.flags.join(" + ") : hoverInfo.node.joined ? "joined" : "unjoined"}</span>
              </div>
              {[["Rank", isDeadNode(hoverInfo.node) ? "null" : hoverInfo.node.rank === INF ? "inf" : hoverInfo.node.rank],["Parent", isDeadNode(hoverInfo.node) ? "null" : hoverInfo.node.parent || "none"],["Battery", `${Math.round(hoverInfo.node.energy_pct)}%`],["Children", isDeadNode(hoverInfo.node) ? 0 : hoverInfo.node.children.length],["TX/RX", `${hoverInfo.node.traffic_tx}/${hoverInfo.node.traffic_rx}`]].map(([k,v]) => (
                <div key={k} style={{ display:"flex",justifyContent:"space-between",fontSize:10,lineHeight:1.8,color:C.tx3 }}>
                  <span>{k}</span><b style={{ color:C.tx2,fontFamily:k==="Parent"?"monospace":"inherit" }}>{v}</b>
                </div>
              ))}
              <div style={{ marginTop:6,paddingTop:6,borderTop:`1px solid ${C.br}`,fontSize:9,color:C.tx3,lineHeight:1.45,overflowWrap:"anywhere" }}>Route: {hoverInfo.route}</div>
            </div>
          )}

          <div style={{ position:"absolute",right:14,bottom:14,width:"min(286px, calc(100% - 28px))",background:C.overlayBgStrong,border:`1px solid ${statusBanner.color}88`,borderRadius:14,padding:"12px 14px",boxShadow:`0 18px 54px ${statusBanner.color}2e, inset 0 1px 0 rgba(255,255,255,.09)`,backdropFilter:"blur(18px)",pointerEvents:"none",display:"flex",alignItems:"center",gap:12,overflow:"hidden" }}>
            <span style={{ position:"absolute",left:0,top:0,bottom:0,width:4,background:statusBanner.color,boxShadow:`0 0 24px ${statusBanner.color}` }} />
            <span style={{ width:12,height:12,borderRadius:"50%",background:statusBanner.color,boxShadow:`0 0 22px ${statusBanner.color}` }} />
            <div style={{ textAlign:"left",minWidth:0 }}>
              <div style={{ fontSize:10,fontWeight:950,color:statusBanner.color,letterSpacing:".09em",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{statusBanner.title}</div>
              <div style={{ fontSize:10,color:C.tx2,marginTop:3 }}>{statusBanner.detail}</div>
            </div>
          </div>

          {phase === "building" && (
            <div style={{ display:"none",position:"absolute",top:12,left:"50%",transform:"translateX(-50%)",background:"#1e40af",color:"#bfdbfe",fontSize:11,fontWeight:700,padding:"6px 20px",borderRadius:20,border:"1px solid #3b82f6",pointerEvents:"none",letterSpacing:".06em" }}>
              ⬡ DIO PROPAGATION IN PROGRESS
            </div>
          )}
          {phase === "done" && hotspots.length > 0 && (
            <div style={{ display:"none",position:"absolute",top:12,left:"50%",transform:"translateX(-50%)",background:"#78350f",color:"#fde68a",fontSize:11,fontWeight:700,padding:"6px 20px",borderRadius:20,border:"1px solid #f59e0b",pointerEvents:"none" }}>
              ⚠ {hotspots.length} ISSUE{hotspots.length>1?"S":""} — CLICK 🔧 FIX
            </div>
          )}

          {guideOpen && (
            <div style={{ position:"absolute",top:12,left:"50%",transform:"translateX(-50%)",width:"min(430px, calc(100% - 28px))",background:C.overlayBgStrong,border:`1px solid ${C.ac}66`,borderRadius:8,padding:"10px 12px",boxShadow:C.subtleShadow,backdropFilter:"blur(12px)",zIndex:9,textAlign:"left" }}>
              <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,marginBottom:8 }}>
                <div style={{ display:"flex",alignItems:"center",gap:8,color:C.tx,fontWeight:900,fontSize:11 }}><Sparkles size={15} color="#22d3ee" /> Guided Demo</div>
                <button type="button" onClick={()=>{setGuideOpen(false);setGuideRunning(false);}} style={{ border:`1px solid ${C.br}`,background:C.controlBg,color:C.tx2,borderRadius:6,cursor:"pointer",fontSize:10,padding:"3px 7px" }}>Close</button>
              </div>
              <div style={{ display:"grid",gridTemplateColumns:`repeat(${guideSteps.length}, 1fr)`,gap:5,marginBottom:8 }}>
                {guideSteps.map((_, i) => <div key={i} style={{ height:5,borderRadius:4,background:i<=guideStep?C.ac:C.br }} />)}
              </div>
              <div style={{ fontSize:12,color:C.tx2,lineHeight:1.5 }}>{guideSteps[guideStep] || guideSteps[0]}</div>
            </div>
          )}

          {/* Stats overlay */}
          <div style={{ position:"absolute",top:12,left:12,background:C.overlayBg,border:`1px solid ${C.br2}`,borderRadius:14,padding:"12px 15px",fontSize:10,color:C.tx3,lineHeight:1.9,boxShadow:C.subtleShadow,backdropFilter:"blur(18px)" }}>
            <div style={{ color:C.tx2,fontWeight:850,marginBottom:4,letterSpacing:".08em",fontSize:9,display:"flex",alignItems:"center",gap:6 }}><Activity size={12} color={C.ac} /> NETWORK</div>
            <div>Nodes <span style={{ color:C.tx,float:"right",marginLeft:18 }}>{nodes.filter(n=>!isDeadNode(n)).length}</span></div>
            <div>Joined <span style={{ color:C.ok,float:"right" }}>{nodes.filter(n=>!isDeadNode(n)&&(n.joined||n.is_root)).length}</span></div>
            <div>Links <span style={{ color:C.ac,float:"right" }}>{nodes.filter(n=>!isDeadNode(n)&&n.parent).length}</span></div>
            {nodes.some(isDeadNode)&&<div>Dead <span style={{ color:"#94a3b8",float:"right" }}>{nodes.filter(isDeadNode).length}</span></div>}
            {hotspots.length>0&&<div>Issues <span style={{ color:C.warn,float:"right" }}>{hotspots.length}</span></div>}
            {analytics&&<div>Health <span style={{ color:analytics.health>70?C.ok:C.warn,float:"right" }}>{analytics.health}/100</span></div>}
          </div>

          {riskNode && (
            <div style={{ position:"absolute",top:12,right:12,width:220,background:C.overlayBgStrong,border:"1px solid rgba(6,182,212,0.42)",borderRadius:12,padding:"11px 13px",boxShadow:C.subtleShadow,backdropFilter:"blur(14px)" }}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8 }}>
                <span style={{ fontSize:9,color:"#67e8f9",fontWeight:800,letterSpacing:".08em" }}>ML RISK RADAR</span>
                <span style={{ width:8,height:8,borderRadius:"50%",background:mlStatus==="backend"?"#22c55e":"#f59e0b",boxShadow:`0 0 14px ${mlStatus==="backend"?"#22c55e":"#f59e0b"}` }} />
              </div>
              <div style={{ display:"flex",alignItems:"baseline",justifyContent:"space-between",gap:10 }}>
                <div>
                  <div style={{ fontFamily:"monospace",fontSize:16,color:C.tx,fontWeight:800 }}>{riskNode.id}</div>
                  <div style={{ fontSize:9,color:C.tx3,marginTop:2 }}>highest predicted drain</div>
                </div>
                <div style={{ textAlign:"right" }}>
                  <div style={{ fontSize:18,color:riskNode.energy_pct<30?C.err:C.warn,fontWeight:900 }}>-{riskNode.predicted_drain}</div>
                  <div style={{ fontSize:9,color:C.tx3 }}>{riskNode.energy_pct}% left</div>
                </div>
              </div>
              <div style={{ height:6,borderRadius:4,background:C.br,overflow:"hidden",marginTop:9 }}>
                <div style={{ height:"100%",width:`${riskNode.energy_pct}%`,background:riskNode.energy_pct>50?C.ok:riskNode.energy_pct>25?C.warn:C.err,borderRadius:4 }} />
              </div>
            </div>
          )}

          {manualInsert && (
            <div style={{ position:"absolute",top:riskNode?150:12,right:12,width:250,background:C.manualBg,border:"1px solid rgba(168,85,247,.45)",borderRadius:8,padding:"11px 12px",boxShadow:C.subtleShadow,backdropFilter:"blur(10px)" }}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:9 }}>
                <span style={{ fontSize:9,color:"#c4b5fd",fontWeight:900,letterSpacing:".08em" }}>MANUAL INSERT</span>
                <span style={{ fontSize:8,color:C.tx3 }}>click canvas or insert</span>
              </div>
              {[
                ["Rank", manualRank, setManualRank, 1, 50],
                ["Base distance", manualDistance, setManualDistance, 40, 520],
                ["Energy", manualEnergy, setManualEnergy, 1, 100],
              ].map(([label,value,setter,min,max]) => (
                <label key={label} style={{ display:"grid",gridTemplateColumns:"80px 1fr 44px",alignItems:"center",gap:8,fontSize:10,color:C.tx3,marginBottom:8 }}>
                  <span>{label}</span>
                  <input type="range" min={min} max={max} value={value} onChange={e=>setter(+e.target.value)} style={{ width:"100%",accentColor:"#a855f7" }} />
                  <input type="number" min={min} max={max} value={value} onChange={e=>setter(+e.target.value)} style={{ width:44,boxSizing:"border-box",background:C.bg3,border:`1px solid ${C.br}`,borderRadius:5,color:C.tx,fontSize:10,padding:"3px 4px" }} />
                </label>
              ))}
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:7,marginTop:10 }}>
                <Btn onClick={()=>addManualNode()} color="#a855f7">Insert Node</Btn>
                <Btn onClick={()=>setManualInsert(false)} color={C.tx3}>Close</Btn>
              </div>
              <div style={{ marginTop:9,fontSize:9,color:C.tx3,lineHeight:1.5 }}>
                Manual rank is combined with base distance and energy penalty during DODAG parent selection.
              </div>
            </div>
          )}

          {/* Legend */}
          <div style={{ position:"absolute",bottom:12,left:12,background:C.overlayBg,border:`1px solid ${C.br}`,borderRadius:14,padding:"10px 13px",fontSize:10,color:C.tx3,lineHeight:2,boxShadow:C.subtleShadow,backdropFilter:"blur(18px)" }}>
            {[["#ef4444","R = DODAG root"],["#06b6d4","Tower = Base Station"],["#22c55e","● Joined node (rank)"],["#334155","● Unjoined node"],["#64748b","X Dead / ignored"],["#f59e0b","🔥 Hotspot / relay"],["#3b82f6","→ DIO packet"],["#f59e0b","→ DAO packet"],["#06b6d4","→ DATA to base"],["#a855f7","← ACK from base"]].map(([c,l])=>(
              <div key={l} style={{ display:"flex",alignItems:"center",gap:6 }}><div style={{ width:8,height:8,borderRadius:"50%",background:c,flexShrink:0 }} /><span>{l}</span></div>
            ))}
          </div>

          {/* Minimap */}
          <svg style={{ position:"absolute",bottom:12,right:12,width:136,height:90,borderRadius:12,border:`1px solid ${C.br}`,background:C.minimapBg,boxShadow:C.subtleShadow,backdropFilter:"blur(14px)" }}>
            {(()=>{
              if(!nodes.length) return null;
              const xs=nodes.map(n=>n.x),ys=nodes.map(n=>n.y);
              const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
              const sc=Math.min(104/(maxX-minX||1),64/(maxY-minY||1));
              const ox=(120-(maxX-minX)*sc)/2-minX*sc,oy=(80-(maxY-minY)*sc)/2-minY*sc;
              const rect=cvRef.current?.getBoundingClientRect();
              const base=currentBaseStation(rect?.width||680,rect?.height||560);
              return<>
                {nodes.filter(n=>n.parent && !isDeadNode(n)).map(n=>{const p=nodes.find(x=>x.id===n.parent);if(!p || isDeadNode(p))return null;return<line key={n.id} x1={n.x*sc+ox} y1={n.y*sc+oy} x2={p.x*sc+ox} y2={p.y*sc+oy} stroke="#22c55e77" strokeWidth={1}/>;}) }
                {nodes.filter(n=>n.is_root).map(n=><line key="base-link" x1={n.x*sc+ox} y1={n.y*sc+oy} x2={base.x*sc+ox} y2={base.y*sc+oy} stroke="#06b6d499" strokeWidth={1} strokeDasharray="3 3"/>)}
                {nodes.map(n=><circle key={n.id} cx={n.x*sc+ox} cy={n.y*sc+oy} r={3} fill={isDeadNode(n)?"#64748b":n.is_root?"#ef4444":n.joined?"#22c55e":"#334155"} stroke={selNode?.id===n.id?"#60a5fa":"none"} strokeWidth={1.5}/>)}
                <rect x={base.x*sc+ox-3} y={base.y*sc+oy-3} width={6} height={6} rx={1.5} fill="#06b6d4" />
              </>;
            })()}
          </svg>

          <div style={{ position:"absolute",bottom:12,left:"50%",transform:"translateX(-50%)",background:C.creditBg,border:`1px solid ${C.br}`,borderRadius:999,padding:"7px 16px",color:C.tx2,fontSize:11,fontWeight:800,boxShadow:C.subtleShadow,pointerEvents:"none",zIndex:5,backdropFilter:"blur(12px)" }}>
            Made By Syed Sobaan Najmi
          </div>

        </div>

        {/* RIGHT PANEL */}
        {panelVisible && <div style={{ width:isCompact?"min(100vw, 380px)":348,position:isCompact?"absolute":"relative",right:0,top:isCompact?0:"auto",bottom:isCompact?0:"auto",height:isCompact?"100%":"auto",zIndex:isCompact?60:"auto",background:C.panelBg,borderLeft:`1px solid ${C.br}`,display:"flex",flexDirection:"column",flexShrink:0,boxShadow:C.panelShadow,backdropFilter:"blur(16px)" }}>
          <div style={{ display:"flex",borderBottom:`1px solid ${C.br}`,flexShrink:0 }}>
            <TabBtn id="nodes" label="Nodes" />
            <TabBtn id="inspector" label="Inspect" />
            <TabBtn id="execlog" label="Exec Log" badge={execLog.length||null} />
            <TabBtn id="analytics" label="Stats" />
            <TabBtn id="ml" label="ML" />
            <TabBtn id="scenario" label="Scenario" />
            <TabBtn id="lab" label="Lab" />
          </div>

          <div style={{ flex:1,overflow:"hidden auto" }}>

            {/* NODES TABLE */}
            {activeTab==="nodes" && (
              <>
              <div style={{ display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,padding:12,borderBottom:`1px solid ${C.br}` }}>
                {[
                  ["Nodes", nodes.filter(n=>!isDeadNode(n)).length, C.tx],
                  ["Joined", nodes.filter(n=>!isDeadNode(n)&&(n.joined||n.is_root)).length, C.ok],
                  ["Issues", hotspots.length, hotspots.length ? C.warn : C.tx3],
                ].map(([label,value,color]) => (
                  <div key={label} style={{ padding:"9px 10px",borderRadius:8,background:C.cardBg,border:`1px solid ${C.br}` }}>
                    <div style={{ fontSize:9,color:C.tx3,fontWeight:700,letterSpacing:".06em",textTransform:"uppercase" }}>{label}</div>
                    <div style={{ marginTop:3,fontSize:18,lineHeight:1,fontWeight:900,color }}>{value}</div>
                  </div>
                ))}
              </div>
              <table style={{ width:"100%",borderCollapse:"collapse",fontSize:10 }}>
                <thead>
                  <tr style={{ background:C.bg3,position:"sticky",top:0,zIndex:1 }}>
                    {["ID","Rank","Parent","Batt","State"].map(h=>(
                      <th key={h} style={{ padding:"8px 9px",textAlign:"left",color:C.tx3,fontWeight:800,letterSpacing:".05em",borderBottom:`1px solid ${C.br}`,fontSize:9 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {nodes.map((n,i)=>{
                    const hs=hotspots.find(h=>h.node_id===n.id);
                    const dead = isDeadNode(n);
                    return(
                      <tr key={n.id} onClick={()=>{setSelNode(n);setActiveTab("inspector");}}
                        style={{ background:selNode?.id===n.id?C.bg3:i%2===0?"transparent":C.rowAlt,cursor:"pointer",borderBottom:`1px solid ${C.rowBorder}` }}>
                        <td style={{ padding:"5px 7px",color:dead?C.tx3:n.is_root?C.err:C.tx2,fontFamily:"monospace",fontSize:9 }}>{n.id}</td>
                        <td style={{ padding:"5px 7px",color:dead?C.tx3:n.rank===INF?C.tx3:"#60a5fa",fontWeight:700 }}>{dead?"null":n.rank===INF?"∞":n.rank}</td>
                        <td style={{ padding:"5px 7px",color:C.tx3,fontFamily:"monospace",fontSize:8 }}>{dead?"null":n.parent||"—"}</td>
                        <td style={{ padding:"5px 7px" }}>
                          <div style={{ display:"flex",alignItems:"center",gap:3 }}>
                            <div style={{ width:28,height:4,borderRadius:2,background:C.br,overflow:"hidden" }}>
                              <div style={{ height:"100%",width:`${n.energy_pct}%`,background:dead?"#64748b":n.energy_pct>50?C.ok:n.energy_pct>25?C.warn:C.err,borderRadius:2 }} />
                            </div>
                            <span style={{ color:C.tx3,fontSize:8 }}>{Math.round(n.energy_pct)}%</span>
                          </div>
                        </td>
                        <td style={{ padding:"5px 7px" }}>
                          <span style={{ fontSize:8,padding:"1px 5px",borderRadius:4,background:dead?"#64748b22":n.joined?"#16a34a22":"#33415522",color:dead?"#94a3b8":n.joined?"#4ade80":C.tx3 }}>
                            {dead ? "dead" : <>{n.manual?"M ":""}{hs?(hs.flags.includes("hotspot")?"🔥 ":"⚡ "):""}{n.joined?"joined":"—"}</>}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </>
            )}

            {/* INSPECTOR */}
            {activeTab==="inspector" && (
              <div style={{ padding:12 }}>
                {selN ? (
                  <>
                    <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:12,paddingBottom:10,borderBottom:`1px solid ${C.br}` }}>
                      <div style={{ width:38,height:38,borderRadius:8,background:isDeadNode(selN)?"#475569":selN.is_root?"#dc2626":selN.joined?"#15803d":C.bg3,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:800,color:"#fff" }}>
                        {isDeadNode(selN)?"X":selN.is_root?"R":selN.rank===INF?"?":selN.rank}
                      </div>
                      <div>
                        <div style={{ fontSize:13,fontWeight:700,fontFamily:"monospace" }}>{selN.id}</div>
                        <div style={{ fontSize:10,color:isDeadNode(selN)?"#94a3b8":selN.is_root?C.err:selN.joined?C.ok:C.tx3 }}>{isDeadNode(selN)?"Dead / ignored":selN.is_root?"DODAG Root":selN.joined?"Joined":"Unjoined"}</div>
                      </div>
                    </div>
                    {[["Node Type",isDeadNode(selN)?"Dead Node":selN.is_root?"Border Router":"Sensor Node"],["Rank",isDeadNode(selN)?"null":selN.rank===INF?"∞":selN.rank],["Preferred Parent",isDeadNode(selN)?"null":selN.parent||"None (root)"],["Children",isDeadNode(selN)?0:selN.children?.length||0],["ETX",selN.is_root||isDeadNode(selN)?"N/A":selN.etx?.toFixed(3)],["RX pkts",selN.traffic_rx],["TX pkts",selN.traffic_tx]].map(([k,v])=>(
                      <div key={k} style={{ display:"flex",justifyContent:"space-between",marginBottom:7,fontSize:11 }}>
                        <span style={{ color:C.tx3 }}>{k}</span>
                        <span style={{ color:C.tx2,fontWeight:500,fontFamily:"monospace" }}>{String(v)}</span>
                      </div>
                    ))}
                    {selN.manual && (
                      <div style={{ marginTop:10,padding:9,borderRadius:8,background:"rgba(88,28,135,.22)",border:"1px solid rgba(168,85,247,.35)" }}>
                        <div style={{ fontSize:9,color:"#c4b5fd",letterSpacing:".06em",fontWeight:800,marginBottom:6 }}>MANUAL METRICS</div>
                        {[["Input Rank",selN.manual.rank],["Base Distance",selN.manual.baseDistance],["Input Energy",`${selN.manual.energy}%`]].map(([k,v])=>(
                          <div key={k} style={{ display:"flex",justifyContent:"space-between",fontSize:10,marginBottom:5 }}>
                            <span style={{ color:C.tx3 }}>{k}</span>
                            <span style={{ color:"#ddd6fe",fontWeight:700 }}>{v}</span>
                          </div>
                        ))}
                      </div>
                    )}
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
                <div style={{ fontSize:14,fontWeight:700,color:C.tx,marginBottom:14,letterSpacing:0 }}>Execution Log</div>
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
                    <div style={{ display:"grid",gridTemplateColumns:"112px 1fr",gap:12,alignItems:"center",marginBottom:14,padding:12,borderRadius:12,background:C.cardBg,border:`1px solid ${C.br}` }}>
                      <div style={{ position:"relative",width:104,height:104 }}>
                        <svg width="104" height="104" viewBox="0 0 104 104">
                          <circle cx="52" cy="52" r="42" fill="none" stroke={C.br} strokeWidth="10" />
                          <circle cx="52" cy="52" r="42" fill="none" stroke={analytics.health>70?C.ok:analytics.health>40?C.warn:C.err} strokeWidth="10" strokeLinecap="round" strokeDasharray={`${Math.max(0,Math.min(100,analytics.health))*2.64} 264`} transform="rotate(-90 52 52)" />
                        </svg>
                        <div style={{ position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column" }}>
                          <div style={{ fontSize:31,fontWeight:950,color:analytics.health>70?C.ok:analytics.health>40?C.warn:C.err,lineHeight:1 }}>{analytics.health}</div>
                          <div style={{ fontSize:8,color:C.tx3,fontWeight:800,letterSpacing:".08em" }}>HEALTH</div>
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize:12,fontWeight:900,color:C.tx,marginBottom:8 }}>Network Dashboard</div>
                        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:7 }}>
                          {[["Join",`${analytics.joinPct}%`,C.ok],["Energy",`${analytics.avgEnergy.toFixed(1)}%`,C.ac],["Hotspots",analytics.hotspotCount,analytics.hotspotCount?C.warn:C.ok],["Critical",analytics.criticalCount,analytics.criticalCount?C.err:C.ok]].map(([label,value,color])=>(
                            <div key={label} style={{ padding:8,borderRadius:8,background:C.bg3,border:`1px solid ${C.br}` }}>
                              <div style={{ fontSize:8,color:C.tx3,fontWeight:800,letterSpacing:".06em" }}>{label}</div>
                              <div style={{ marginTop:3,fontSize:15,fontWeight:900,color }}>{value}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                    {[["Join Rate",`${analytics.joined}/${analytics.total} (${analytics.joinPct}%)`,C.ok],["Avg Energy",`${analytics.avgEnergy.toFixed(1)}%`,C.ac],["Min Energy",`${analytics.minEnergy.toFixed(1)}%`,C.ac],["Hotspots",analytics.hotspotCount,analytics.hotspotCount>0?C.warn:C.ok],["Critical",analytics.criticalCount,analytics.criticalCount>0?C.err:C.ok],["Avg Rank",analytics.avgRank,C.tx2],["Max Rank",analytics.maxRank,C.tx2],["Total DIO",dioCount,C.ac],["Total DAO",daoCount,C.warn],["Total DATA",dataCount,"#06b6d4"],["Total ACK",ackCount,"#a855f7"]].map(([k,v,c])=>(
                      <div key={k} style={{ display:"flex",justifyContent:"space-between",marginBottom:7,fontSize:11 }}>
                        <span style={{ color:C.tx3 }}>{k}</span>
                        <span style={{ color:c||C.tx2,fontWeight:600 }}>{String(v)}</span>
                      </div>
                    ))}
                    {energyReport && (
                      <div style={{ marginTop:12,paddingTop:10,borderTop:`1px solid ${C.br}` }}>
                        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8 }}>
                          <div style={{ fontSize:9,color:C.tx3,letterSpacing:".06em" }}>ML ENERGY</div>
                          <span style={{ fontSize:8,padding:"2px 6px",borderRadius:5,background:(mlStatus==="backend"?"#0e7490":"#92400e")+"55",color:mlStatus==="backend"?"#67e8f9":"#fde68a",fontWeight:700 }}>
                            {mlStatus==="backend"?"BACKEND ML":"FALLBACK"}
                          </span>
                        </div>
                        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:8 }}>
                          <div style={{ padding:7,borderRadius:6,background:C.bg3 }}>
                            <div style={{ fontSize:8,color:C.tx3 }}>Total Drain</div>
                            <div style={{ fontSize:13,color:"#f59e0b",fontWeight:800 }}>{energyReport.summary.total_predicted_drain}</div>
                          </div>
                          <div style={{ padding:7,borderRadius:6,background:C.bg3 }}>
                            <div style={{ fontSize:8,color:C.tx3 }}>Min Energy</div>
                            <div style={{ fontSize:13,color:"#60a5fa",fontWeight:800 }}>{energyReport.summary.min_energy}</div>
                          </div>
                        </div>
                        <div style={{ display:"flex",flexDirection:"column",gap:5,maxHeight:150,overflow:"auto",paddingRight:2 }}>
                          {energyReport.predictions.map(p => (
                            <div key={p.id} style={{ display:"grid",gridTemplateColumns:"52px 1fr 48px",alignItems:"center",gap:7,fontSize:9,color:C.tx3 }}>
                              <span style={{ fontFamily:"monospace",color:C.tx2 }}>{p.id}</span>
                              <div style={{ height:5,borderRadius:3,background:C.br,overflow:"hidden" }}>
                                <div style={{ height:"100%",width:`${p.energy_pct}%`,background:p.energy_pct>50?C.ok:p.energy_pct>25?C.warn:C.err,borderRadius:3 }} />
                              </div>
                              <span style={{ color:p.energy_pct>25?C.tx2:C.err,fontWeight:700,textAlign:"right" }}>-{p.predicted_drain}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
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

            {activeTab==="ml" && (
              <div style={{ padding:12 }}>
                <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12 }}>
                  <div>
                    <div style={{ fontSize:14,fontWeight:900,color:C.tx }}>ML Energy Model</div>
                    <div style={{ fontSize:10,color:C.tx3,marginTop:2 }}>{mlStatus==="backend"?"Backend prediction active":mlStatus==="fallback"?"Frontend fallback active":"Run Drain to score nodes"}</div>
                  </div>
                  <Btn onClick={drainEnergy} disabled={phase!=="done"||mlStatus==="running"} color={C.warn}>{mlStatus==="running"?"ML...":"Score"}</Btn>
                </div>
                {energyReport ? (
                  <>
                    <div style={{ display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:7,marginBottom:12 }}>
                      {[["Avg",energyReport.summary.avg_energy,C.ac],["Min",energyReport.summary.min_energy,C.warn],["Drain",energyReport.summary.total_predicted_drain,C.err]].map(([label,value,color])=>(
                        <div key={label} style={{ padding:9,borderRadius:8,background:C.cardBg,border:`1px solid ${C.br}` }}>
                          <div style={{ fontSize:8,color:C.tx3,fontWeight:800 }}>{label}</div>
                          <div style={{ marginTop:4,fontSize:16,fontWeight:900,color }}>{value}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
                      {[...energyReport.predictions].sort((a,b)=>b.predicted_drain-a.predicted_drain).map(p=>{
                        const node = nodes.find(n=>n.id===p.id);
                        const risk = p.energy_pct < 25 ? "HIGH" : p.energy_pct < 50 || p.predicted_drain > 2 ? "MED" : "LOW";
                        const color = risk==="HIGH"?C.err:risk==="MED"?C.warn:C.ok;
                        return (
                          <div key={p.id} onClick={()=>{ if(node){ setSelNode(node); setActiveTab("inspector"); } }} style={{ padding:9,borderRadius:8,background:C.bg3,border:`1px solid ${C.br}`,cursor:"pointer" }}>
                            <div style={{ display:"flex",justifyContent:"space-between",gap:8,alignItems:"center",marginBottom:7 }}>
                              <span style={{ fontFamily:"monospace",fontSize:11,color:C.tx,fontWeight:800 }}>{p.id}</span>
                              <span style={{ fontSize:8,padding:"2px 6px",borderRadius:5,background:color+"22",color,fontWeight:900 }}>{risk}</span>
                            </div>
                            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:7,fontSize:9,color:C.tx3,marginBottom:7 }}>
                              <span>Drain <b style={{ color:C.warn }}>{p.predicted_drain}</b></span>
                              <span>Energy <b style={{ color:C.tx2 }}>{p.energy_pct}%</b></span>
                              <span>Children <b style={{ color:C.tx2 }}>{node?.children?.length||0}</b></span>
                            </div>
                            <div style={{ height:5,borderRadius:3,background:C.br,overflow:"hidden" }}>
                              <div style={{ height:"100%",width:`${p.energy_pct}%`,background:color,borderRadius:3 }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                ) : (
                  <div style={{ color:C.tx3,fontSize:11,lineHeight:1.8 }}>Drain the network to generate per-node energy predictions and risk ranking.</div>
                )}
              </div>
            )}

            {activeTab==="scenario" && (
              <div style={{ padding:12 }}>
                <div style={{ marginBottom:12 }}>
                  <div style={{ fontSize:14,fontWeight:900,color:C.tx }}>Failure Scenarios</div>
                  <div style={{ fontSize:10,color:C.tx3,marginTop:2 }}>Select a node first, or the simulator picks a risky node.</div>
                </div>
                <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12 }}>
                  <Btn onClick={drainSelectedNode} color={C.warn}>Drain Node</Btn>
                  <Btn onClick={killSelectedNode} color={C.err}>Kill Node</Btn>
                  <Btn onClick={burstTraffic} color="#06b6d4">Traffic Burst</Btn>
                  <Btn onClick={jamRadioRange} color="#f97316">Jam Radio</Btn>
                  <Btn onClick={randomFailure} color="#a855f7">Random Fault</Btn>
                  <Btn onClick={()=>{ resetDodag(); setActiveTab("nodes"); }} color={C.tx3}>Clear Drill</Btn>
                </div>
                <div style={{ padding:10,borderRadius:8,background:C.cardBg,border:`1px solid ${C.br}`,marginBottom:12 }}>
                  <div style={{ display:"flex",justifyContent:"space-between",fontSize:10,marginBottom:6 }}><span style={{ color:C.tx3 }}>Selected</span><b style={{ color:C.tx2,fontFamily:"monospace" }}>{selN?.id||"none"}</b></div>
                  <div style={{ display:"flex",justifyContent:"space-between",fontSize:10,marginBottom:6 }}><span style={{ color:C.tx3 }}>Route hops</span><b style={{ color:C.tx2 }}>{selN ? Math.max(0,getRouteNodeIds(selN.id).length-1) : 0}</b></div>
                  <div style={{ display:"flex",justifyContent:"space-between",fontSize:10 }}><span style={{ color:C.tx3 }}>Range</span><b style={{ color:C.tx2 }}>{radioRange}px</b></div>
                </div>
                <div style={{ fontSize:9,color:C.tx3,letterSpacing:".06em",fontWeight:800,marginBottom:7 }}>DRILL LOG</div>
                <div style={{ display:"flex",flexDirection:"column",gap:7 }}>
                  {scenarioLog.length ? scenarioLog.map((entry,i)=>(
                    <div key={i} style={{ padding:8,borderRadius:7,background:C.bg3,border:`1px solid ${C.br}`,fontSize:10,color:C.tx3,lineHeight:1.5 }}>
                      <span style={{ color:entry.color,fontWeight:800 }}>{entry.time}</span> {entry.msg}
                    </div>
                  )) : <div style={{ color:C.tx3,fontSize:11,lineHeight:1.8 }}>Run a failure scenario to watch routing, energy, and hotspot behavior change.</div>}
                </div>
              </div>
            )}

            {activeTab==="lab" && (
              <div style={{ padding:12 }}>
                <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,marginBottom:12 }}>
                  <div>
                    <div style={{ fontSize:14,fontWeight:900,color:C.tx }}>Simulation Lab</div>
                    <div style={{ fontSize:10,color:C.tx3,marginTop:2 }}>Presets, tour, comparison, and export.</div>
                  </div>
                  <Btn onClick={runGuidedDemo} disabled={guideRunning || simRunning} color="#22d3ee" icon={Sparkles}>Tour</Btn>
                </div>

                <div style={{ fontSize:9,color:C.tx3,letterSpacing:".06em",fontWeight:800,marginBottom:7 }}>SCENARIO PRESETS</div>
                <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14 }}>
                  <Btn onClick={()=>applyPreset("healthy")} color={C.ok} icon={Activity}>Healthy</Btn>
                  <Btn onClick={()=>applyPreset("dense")} color={C.ac} icon={MapIcon}>Dense</Btn>
                  <Btn onClick={()=>applyPreset("sparse")} color="#06b6d4" icon={Radio}>Sparse</Btn>
                  <Btn onClick={()=>applyPreset("low")} color={C.warn} icon={Zap}>Low Battery</Btn>
                  <Btn onClick={()=>applyPreset("hotspot")} color={C.err} icon={Flame}>Hotspot</Btn>
                  <Btn onClick={compareModes} color="#a855f7" icon={BarChart3}>Compare OF</Btn>
                </div>

                <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14 }}>
                  <Btn onClick={exportReport} color="#14b8a6" icon={Download}>Export JSON</Btn>
                  <Btn onClick={()=>setGuideOpen(v=>!v)} color={C.tx2} icon={Info}>{guideOpen?"Hide Tour":"Tour Card"}</Btn>
                </div>

                {comparison ? (
                  <div style={{ display:"flex",flexDirection:"column",gap:9 }}>
                    {Object.values(comparison).map(item => (
                      <div key={item.mode} style={{ padding:10,borderRadius:8,background:C.cardBg,border:`1px solid ${C.br}` }}>
                        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8 }}>
                          <span style={{ fontSize:12,fontWeight:900,color:C.tx }}>{item.mode}</span>
                          <span style={{ fontSize:8,padding:"2px 6px",borderRadius:5,background:C.ac+"22",color:C.ac,fontWeight:900 }}>{item.joined}/{nodes.length} joined</span>
                        </div>
                        {[["Links", item.links],["Avg Rank", item.avgRank],["Max Rank", item.maxRank],["DIO Messages", item.messages],["Relay Nodes", item.relays],["Max Children", item.maxChildren]].map(([k,v]) => (
                          <div key={k} style={{ display:"flex",justifyContent:"space-between",fontSize:10,lineHeight:1.8,color:C.tx3 }}>
                            <span>{k}</span><b style={{ color:C.tx2 }}>{v}</b>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ padding:10,borderRadius:8,background:C.cardBg,border:`1px solid ${C.br}`,fontSize:11,color:C.tx3,lineHeight:1.7 }}>
                    Use Compare OF to score the current topology under OF0 Hop Count and MRHOF ETX without changing the live canvas.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>}
      </div>

      <div style={{ position:"fixed",right:18,bottom:18,zIndex:80,display:"flex",flexDirection:"column",alignItems:"flex-end",gap:10,pointerEvents:"none" }}>
        {chatOpen && (
          <div style={{ width:"min(380px, calc(100vw - 36px))",height:"min(560px, calc(100vh - 108px))",background:C.panelBg,border:`1px solid ${C.br2}`,borderRadius:8,boxShadow:"0 22px 70px rgba(0,0,0,.36)",display:"flex",flexDirection:"column",overflow:"hidden",pointerEvents:"auto" }}>
            <div style={{ padding:"12px 13px",borderBottom:`1px solid ${C.br}`,display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,background:C.topBg }}>
              <div style={{ minWidth:0 }}>
                <div style={{ fontSize:12,fontWeight:900,color:C.tx,lineHeight:1.2 }}>Gemini Network Chat</div>
                <div style={{ fontSize:9,color:C.tx3,fontWeight:700,letterSpacing:".05em",textTransform:"uppercase" }}>Gemini 2.5 Flash</div>
              </div>
              <div style={{ display:"flex",gap:6,alignItems:"center" }}>
                <button type="button" onClick={() => { setChatError(""); setChatMessages([{ role: "assistant", text: "Hi, I am your Gemini RPL assistant. Ask me about the network, energy, hotspots, or what to click next." }]); }} title="Clear chat"
                  style={{ height:30,padding:"0 9px",borderRadius:7,border:`1px solid ${C.br}`,background:C.controlBg,color:C.tx3,cursor:"pointer",fontSize:10,fontWeight:800 }}>Clear</button>
                <button type="button" onClick={() => setChatOpen(false)} title="Close chat"
                  style={{ width:30,height:30,borderRadius:7,border:`1px solid ${C.br}`,background:C.controlBg,color:C.tx2,cursor:"pointer",fontSize:16,lineHeight:1 }}>x</button>
              </div>
            </div>

            <div style={{ flex:1,overflow:"auto",padding:12,display:"flex",flexDirection:"column",gap:9,background:"rgba(0,0,0,.08)" }}>
              {chatMessages.map((msg, idx) => {
                const mine = msg.role === "user";
                return (
                  <div key={idx} style={{ alignSelf:mine?"flex-end":"flex-start",maxWidth:"86%",padding:"9px 10px",borderRadius:8,border:`1px solid ${mine ? C.ac+"66" : C.br}`,background:mine ? `linear-gradient(180deg,${C.ac}33,${C.ac}18)` : C.cardBg,color:C.tx2,fontSize:11,lineHeight:1.55,textAlign:"left",whiteSpace:"pre-wrap",overflowWrap:"anywhere" }}>
                    {msg.text}
                  </div>
                );
              })}
              {chatBusy && (
                <div style={{ alignSelf:"flex-start",padding:"9px 10px",borderRadius:8,border:`1px solid ${C.br}`,background:C.cardBg,color:C.tx3,fontSize:11 }}>
                  Thinking...
                </div>
              )}
            </div>

            {chatError && (
              <div style={{ padding:"7px 12px",borderTop:`1px solid ${C.br}`,color:C.warn,fontSize:10,textAlign:"left",background:C.bg3 }}>
                {chatError}
              </div>
            )}

            <div style={{ padding:"9px 10px 0",display:"grid",gridTemplateColumns:"1fr 1fr",gap:7,background:C.topBg }}>
              {[
                ["Explain Network", "Explain the current RPL network state, including DODAG formation, hotspots, and energy risk."],
                ["Selected Node", selNode ? `Explain selected node ${selNode.id}, its route, rank, parent, energy, and risks.` : "Tell me which node to select and why."],
                ["Suggest Fix", "Suggest the best repair actions for the current simulation issues."],
                ["ML Risk", "Explain the ML energy prediction and highest-risk nodes in this simulation."],
              ].map(([label, prompt]) => (
                <button key={label} type="button" disabled={chatBusy} onClick={e => sendChatMessage(e, prompt)}
                  style={{ minHeight:30,borderRadius:7,border:`1px solid ${C.br}`,background:C.controlBg,color:C.tx2,cursor:chatBusy?"not-allowed":"pointer",fontSize:10,fontWeight:800,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>
                  {label}
                </button>
              ))}
            </div>

            <form onSubmit={sendChatMessage} style={{ padding:10,borderTop:`1px solid ${C.br}`,display:"grid",gridTemplateColumns:"1fr auto",gap:8,background:C.topBg }}>
              <textarea
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendChatMessage(e);
                  }
                }}
                placeholder="Ask Gemini about this RPL network..."
                rows={2}
                style={{ resize:"none",minHeight:42,maxHeight:90,borderRadius:8,border:`1px solid ${C.br}`,background:C.controlBg,color:C.tx,fontSize:11,lineHeight:1.35,padding:"9px 10px",outline:"none",fontFamily:"inherit",letterSpacing:0 }}
              />
              <button type="submit" disabled={chatBusy || !chatInput.trim()}
                style={{ width:54,borderRadius:8,border:`1px solid ${chatBusy || !chatInput.trim() ? C.br : C.ac+"88"}`,background:chatBusy || !chatInput.trim() ? C.disabledBg : `linear-gradient(180deg,${C.ac}33,${C.ac}18)`,color:chatBusy || !chatInput.trim() ? C.tx3 : C.ac,fontSize:11,fontWeight:900,cursor:chatBusy || !chatInput.trim() ? "not-allowed" : "pointer" }}>
                Send
              </button>
            </form>
          </div>
        )}

        <button type="button" onClick={() => setChatOpen(open => !open)} title="Open Gemini chat"
          style={{ width:58,height:58,borderRadius:29,border:`1px solid ${C.ac+"88"}`,background:"linear-gradient(135deg,#06b6d4,#2563eb 48%,#7c3aed)",color:"#fff",boxShadow:"0 16px 42px rgba(37,99,235,.34)",fontSize:20,fontWeight:950,cursor:"pointer",pointerEvents:"auto" }}>
          AI
        </button>
      </div>
    </div>
  );
}
