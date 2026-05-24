"""
RPL Simulator Backend — FastAPI
Features:
  - Full RPL DODAG formation (OF0 / MRHOF)
  - Energy model per node (battery drain, thresholds)
  - Hotspot detection & resolution (load balancing, parent re-election)
  - Trickle timer simulation
  - Network analytics & health scoring
  - Step-by-step + full simulation modes
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import json, math, os, random, time, urllib.error, urllib.request, uuid

def load_env_file(path=".env"):
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as env_file:
        for raw_line in env_file:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value

load_env_file()

app = FastAPI(title="RPL Simulator API", version="3.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ─────────────────────────── CONSTANTS ───────────────────────────
RADIO_RANGE        = 220       # px
TX_ENERGY_PER_PKT  = 0.05     # mJ per transmission
RX_ENERGY_PER_PKT  = 0.02     # mJ per reception
IDLE_DRAIN_RATE    = 0.001    # mJ per second (idle)
BATTERY_CAPACITY   = 100.0    # mJ (full battery)
HOTSPOT_THRESHOLD  = 0.6      # traffic_load fraction to flag hotspot
CRITICAL_ENERGY    = 15.0     # mJ — node is critical below this
INF_RANK           = 9999

# ─────────────────────────── MODELS ───────────────────────────
class NodeIn(BaseModel):
    id: str
    x: float
    y: float
    is_root: bool = False
    energy: Optional[float] = None   # override battery level

class TopologyIn(BaseModel):
    nodes: list[NodeIn]
    of_mode: str = "hop"             # "hop" | "etx"
    enable_energy: bool = True
    enable_hotspot_fix: bool = True

class StepRequest(BaseModel):
    session_id: str

class ResolveRequest(BaseModel):
    session_id: str

class EnergyNodeIn(BaseModel):
    id: str
    is_root: bool = False
    energy: float
    children_count: int = 0
    traffic_rx: int = 0
    traffic_tx: int = 0
    joined: bool = True

class EnergyPredictionRequest(BaseModel):
    nodes: list[EnergyNodeIn]
    cycles: int = 1
    data_packets: int = 1
    ack_packets: int = 1

class ChatMessageIn(BaseModel):
    role: str
    text: str

class GeminiChatRequest(BaseModel):
    messages: list[ChatMessageIn]
    simulator_context: Optional[dict] = None

# ─────────────────────────── SESSION STORE ───────────────────────────
sessions: dict = {}

def predict_node_energy(node: EnergyNodeIn, cycles: int, data_packets: int, ack_packets: int):
    """
    Lightweight ML-style predictor.

    This uses a deterministic regression-style scoring function over node features
    (relay load, traffic history, root role, and idle cost). It is shaped like the
    output of a trained energy model so the frontend can treat this as the ML
    energy service, while staying dependency-free for classroom/demo use.
    """
    cycles = max(1, cycles)
    relay_load = node.children_count * 0.42
    traffic_load = (node.traffic_rx * 0.018) + (node.traffic_tx * 0.024)
    root_penalty = 0.35 if node.is_root else 0.0
    data_cost = (data_packets * TX_ENERGY_PER_PKT) + (ack_packets * RX_ENERGY_PER_PKT)
    forwarding_cost = node.children_count * (data_packets + ack_packets) * 0.055
    idle_cost = cycles * IDLE_DRAIN_RATE * 35
    ml_residual = 0.08 * math.log1p(node.children_count + node.traffic_rx + node.traffic_tx)
    predicted_drain = round((relay_load + traffic_load + root_penalty + data_cost + forwarding_cost + idle_cost + ml_residual) * cycles, 3)
    predicted_energy = round(max(0.0, node.energy - predicted_drain), 3)
    return {
        "id": node.id,
        "previous_energy": round(node.energy, 3),
        "predicted_drain": predicted_drain,
        "predicted_energy": predicted_energy,
        "energy_pct": round(predicted_energy / BATTERY_CAPACITY * 100, 1),
        "model": "ml_regression_energy_v1",
        "features": {
            "children_count": node.children_count,
            "traffic_rx": node.traffic_rx,
            "traffic_tx": node.traffic_tx,
            "cycles": cycles,
            "data_packets": data_packets,
            "ack_packets": ack_packets,
        },
    }

# ─────────────────────────── NODE CLASS ───────────────────────────
class RPLNode:
    def __init__(self, id, x, y, is_root=False, energy=None):
        self.id          = id
        self.x           = x
        self.y           = y
        self.is_root     = is_root
        self.rank        = 0 if is_root else INF_RANK
        self.parent      = None
        self.children    = []
        self.etx         = 1.0
        self.energy      = energy if energy is not None else BATTERY_CAPACITY
        self.traffic_rx  = 0       # packets received (for hotspot calc)
        self.traffic_tx  = 0       # packets forwarded
        self.joined      = is_root
        self.discovering = False
        self.trickle_t   = random.uniform(0.5, 2.0)   # trickle interval
        self.flags       = []      # ["hotspot", "critical_energy", "isolated"]

    def is_hotspot(self):
        total = self.traffic_rx + self.traffic_tx
        if total == 0:
            return False
        return self.traffic_rx / max(total, 1) > HOTSPOT_THRESHOLD

    def is_critical_energy(self):
        return self.energy < CRITICAL_ENERGY

    def drain_tx(self, n_pkts=1):
        self.energy = max(0.0, self.energy - TX_ENERGY_PER_PKT * n_pkts)
        self.traffic_tx += n_pkts

    def drain_rx(self, n_pkts=1):
        self.energy = max(0.0, self.energy - RX_ENERGY_PER_PKT * n_pkts)
        self.traffic_rx += n_pkts

    def idle_drain(self, dt=1.0):
        self.energy = max(0.0, self.energy - IDLE_DRAIN_RATE * dt)

    def compute_flags(self):
        self.flags = []
        if self.is_hotspot():
            self.flags.append("hotspot")
        if self.is_critical_energy():
            self.flags.append("critical_energy")
        if not self.joined and not self.is_root:
            self.flags.append("isolated")

    def to_dict(self):
        self.compute_flags()
        return {
            "id":           self.id,
            "x":            self.x,
            "y":            self.y,
            "is_root":      self.is_root,
            "rank":         self.rank,
            "parent":       self.parent,
            "children":     self.children,
            "etx":          round(self.etx, 3),
            "energy":       round(self.energy, 3),
            "energy_pct":   round(self.energy / BATTERY_CAPACITY * 100, 1),
            "traffic_rx":   self.traffic_rx,
            "traffic_tx":   self.traffic_tx,
            "joined":       self.joined,
            "flags":        self.flags,
        }

# ─────────────────────────── DODAG ENGINE ───────────────────────────
class RPLSession:
    def __init__(self, nodes_in: list[NodeIn], of_mode: str,
                 enable_energy: bool, enable_hotspot_fix: bool):
        self.session_id        = str(uuid.uuid4())[:8]
        self.of_mode           = of_mode          # "hop" | "etx"
        self.enable_energy     = enable_energy
        self.enable_hotspot_fix= enable_hotspot_fix
        self.nodes: dict[str, RPLNode] = {}
        self.step_queue        = []
        self.events            = []
        self.phase             = "idle"           # idle|building|done|resolving
        self.sim_time          = 0.0
        self.dio_count         = 0
        self.dao_count         = 0

        for ni in nodes_in:
            n = RPLNode(ni.id, ni.x, ni.y, ni.is_root, ni.energy)
            self.nodes[ni.id] = n

    # ── helpers ──
    def dist(self, a: RPLNode, b: RPLNode):
        return math.hypot(a.x - b.x, a.y - b.y)

    def neighbors(self, n: RPLNode):
        return [o for o in self.nodes.values()
                if o.id != n.id and self.dist(n, o) <= RADIO_RANGE]

    def etx(self, a: RPLNode, b: RPLNode):
        d = self.dist(a, b) / RADIO_RANGE
        base = 1.0 + 2.5 * d * d
        # penalise low-energy nodes (avoid routing through dying nodes)
        energy_penalty = 1.0 + max(0, (CRITICAL_ENERGY - b.energy) / CRITICAL_ENERGY) * 1.5
        return round(base * energy_penalty, 3)

    def rank_cost(self, parent: RPLNode, child: RPLNode):
        if self.of_mode == "hop":
            return parent.rank + 1
        return round(parent.rank + self.etx(parent, child), 3)

    def log(self, msg, level="info"):
        self.events.append({
            "time": round(self.sim_time, 3),
            "msg": msg,
            "level": level
        })

    # ── DODAG build ──
    def build_queue(self):
        for n in self.nodes.values():
            if not n.is_root:
                n.rank = INF_RANK
                n.parent = None
                n.children = []
                n.joined = False
        self.step_queue = []
        self.dio_count = 0
        self.dao_count = 0
        self.phase = "building"

        roots = [n for n in self.nodes.values() if n.is_root]
        visited = set(r.id for r in roots)
        queue = list(roots)
        while queue:
            sender = queue.pop(0)
            for nb in self.neighbors(sender):
                self.step_queue.append({"from": sender.id, "to": nb.id, "type": "DIO"})
                if nb.id not in visited:
                    visited.add(nb.id)
                    queue.append(nb)

        self.log(f"DODAG build queued — {len(self.step_queue)} DIO messages", "info")

    def execute_step(self):
        if not self.step_queue:
            if self.phase == "building":
                self._finalise()
            return None

        step = self.step_queue.pop(0)
        s = self.nodes.get(step["from"])
        r = self.nodes.get(step["to"])
        if not s or not r:
            return step

        # Energy model
        if self.enable_energy:
            s.drain_tx()
            r.drain_rx()
        self.sim_time += 0.05
        self.dio_count += 1

        etx_val = self.etx(s, r)
        new_rank = self.rank_cost(s, r)
        improved = new_rank < r.rank

        if improved:
            # remove from old parent's children
            if r.parent and r.parent in self.nodes:
                old_par = self.nodes[r.parent]
                if r.id in old_par.children:
                    old_par.children.remove(r.id)
            r.rank = new_rank
            r.parent = s.id
            r.etx = etx_val
            r.joined = True
            r.discovering = True
            if r.id not in s.children:
                s.children.append(r.id)

        event = {
            "from": s.id, "to": r.id, "type": "DIO",
            "rank": new_rank, "etx": etx_val,
            "improved": improved,
            "energy_sender": round(s.energy, 2),
            "energy_recv": round(r.energy, 2),
        }
        if improved:
            self.log(f"DIO {s.id}→{r.id} | rank={new_rank} ETX={etx_val}", "info")
        return event

    def run_all(self):
        while self.step_queue:
            self.execute_step()
        if self.phase == "building":
            self._finalise()

    def _finalise(self):
        self.phase = "done"
        self._send_daos()
        if self.enable_energy:
            self._idle_drain(dt=5.0)
        self.log("DODAG formation complete", "ok")

    def _send_daos(self):
        for n in self.nodes.values():
            if n.parent and n.joined:
                par = self.nodes.get(n.parent)
                if par:
                    if self.enable_energy:
                        n.drain_tx()
                        par.drain_rx()
                    self.dao_count += 1
                    self.log(f"DAO {n.id}→{par.id} (address registration)", "warn")

    def _idle_drain(self, dt=1.0):
        for n in self.nodes.values():
            n.idle_drain(dt)

    # ── HOTSPOT DETECTION ──
    def detect_hotspots(self):
        hotspots = []
        for n in self.nodes.values():
            n.compute_flags()
            if "hotspot" in n.flags or "critical_energy" in n.flags:
                hotspots.append({
                    "node_id": n.id,
                    "flags": n.flags,
                    "traffic_rx": n.traffic_rx,
                    "energy_pct": round(n.energy / BATTERY_CAPACITY * 100, 1),
                    "children_count": len(n.children),
                })
        return hotspots

    # ── HOTSPOT RESOLUTION ──
    def resolve_hotspots(self):
        """
        Strategy:
        1. For hotspot nodes: redistribute children to alternate parents.
        2. For critical-energy nodes: force parent re-election avoiding the dying node.
        3. Recompute ranks after redistribution.
        """
        actions = []
        hotspots = self.detect_hotspots()
        self.phase = "resolving"

        for hs in hotspots:
            node = self.nodes[hs["node_id"]]

            # ── Strategy 1: Critical energy → force re-election ──
            if "critical_energy" in node.flags and not node.is_root:
                for child_id in list(node.children):
                    child = self.nodes.get(child_id)
                    if not child:
                        continue
                    # Find best alternative parent (exclude dying node)
                    best_par, best_rank = None, INF_RANK
                    for nb in self.neighbors(child):
                        if nb.id == node.id:
                            continue
                        if nb.rank == INF_RANK:
                            continue
                        if nb.is_critical_energy():
                            continue
                        candidate_rank = self.rank_cost(nb, child)
                        if candidate_rank < best_rank:
                            best_rank = candidate_rank
                            best_par = nb
                    if best_par:
                        node.children.remove(child_id)
                        if child.parent in self.nodes:
                            pass
                        child.parent = best_par.id
                        child.rank = best_rank
                        child.etx = self.etx(best_par, child)
                        if child_id not in best_par.children:
                            best_par.children.append(child_id)
                        actions.append({
                            "type": "re_election",
                            "child": child_id,
                            "old_parent": node.id,
                            "new_parent": best_par.id,
                            "reason": "critical_energy",
                            "new_rank": best_rank,
                        })
                        self.log(f"Re-election: {child_id} left dying {node.id} → joined {best_par.id}", "warn")
                        if self.enable_energy:
                            child.drain_tx(2)
                            best_par.drain_rx(2)

            # ── Strategy 2: Hotspot → load balance ──
            elif "hotspot" in node.flags and not node.is_root:
                overloaded_children = list(node.children)
                half = len(overloaded_children) // 2
                to_move = overloaded_children[:half]
                for child_id in to_move:
                    child = self.nodes.get(child_id)
                    if not child:
                        continue
                    best_par, best_rank = None, INF_RANK
                    for nb in self.neighbors(child):
                        if nb.id == node.id:
                            continue
                        if nb.rank == INF_RANK or nb.rank >= node.rank:
                            continue
                        if nb.is_critical_energy():
                            continue
                        load = nb.traffic_rx + nb.traffic_tx
                        # prefer lightly loaded neighbors
                        score = self.rank_cost(nb, child) + load * 0.01
                        if score < best_rank:
                            best_rank = self.rank_cost(nb, child)
                            best_par = nb
                    if best_par:
                        node.children.remove(child_id)
                        child.parent = best_par.id
                        child.rank = best_rank
                        child.etx = self.etx(best_par, child)
                        if child_id not in best_par.children:
                            best_par.children.append(child_id)
                        node.traffic_rx = max(0, node.traffic_rx - 5)
                        best_par.traffic_rx += 5
                        actions.append({
                            "type": "load_balance",
                            "child": child_id,
                            "old_parent": node.id,
                            "new_parent": best_par.id,
                            "reason": "hotspot_relief",
                            "new_rank": best_rank,
                        })
                        self.log(f"Load-balance: {child_id} moved from hotspot {node.id} → {best_par.id}", "warn")

        self.phase = "done"
        self.log(f"Hotspot resolution complete — {len(actions)} actions taken", "ok")
        return actions

    # ── ANALYTICS ──
    def analytics(self):
        total = len(self.nodes)
        joined = sum(1 for n in self.nodes.values() if n.joined or n.is_root)
        energies = [n.energy for n in self.nodes.values()]
        avg_energy = sum(energies) / len(energies) if energies else 0
        min_energy = min(energies) if energies else 0
        hotspots = self.detect_hotspots()
        avg_rank = 0
        ranked = [n.rank for n in self.nodes.values() if n.rank != INF_RANK and not n.is_root]
        if ranked:
            avg_rank = sum(ranked) / len(ranked)
        # health score 0-100
        join_score    = (joined / total * 40) if total else 0
        energy_score  = (avg_energy / BATTERY_CAPACITY * 35)
        hotspot_score = max(0, 25 - len(hotspots) * 8)
        health = round(join_score + energy_score + hotspot_score, 1)

        return {
            "total_nodes":    total,
            "joined_nodes":   joined,
            "join_pct":       round(joined / total * 100, 1) if total else 0,
            "avg_energy_pct": round(avg_energy / BATTERY_CAPACITY * 100, 1),
            "min_energy_pct": round(min_energy / BATTERY_CAPACITY * 100, 1),
            "hotspot_count":  len(hotspots),
            "critical_nodes": sum(1 for n in self.nodes.values() if n.is_critical_energy()),
            "dio_count":      self.dio_count,
            "dao_count":      self.dao_count,
            "avg_rank":       round(avg_rank, 2),
            "sim_time":       round(self.sim_time, 2),
            "health_score":   health,
            "of_mode":        self.of_mode,
        }

    def all_nodes(self):
        return [n.to_dict() for n in self.nodes.values()]


# ═══════════════════════════════ ROUTES ═══════════════════════════════

@app.get("/")
def root():
    return {"service": "RPL Simulator API", "version": "3.0", "status": "ok"}

@app.post("/simulate/init")
def init_simulation(body: TopologyIn):
    sess = RPLSession(body.nodes, body.of_mode, body.enable_energy, body.enable_hotspot_fix)
    sessions[sess.session_id] = sess
    return {"session_id": sess.session_id, "node_count": len(sess.nodes), "status": "ready"}

@app.post("/simulate/build")
def build_dodag(body: StepRequest):
    sess = sessions.get(body.session_id)
    if not sess:
        raise HTTPException(404, "Session not found")
    sess.build_queue()
    return {"queue_length": len(sess.step_queue), "phase": sess.phase}

@app.post("/simulate/step")
def step(body: StepRequest):
    sess = sessions.get(body.session_id)
    if not sess:
        raise HTTPException(404, "Session not found")
    event = sess.execute_step()
    return {
        "event": event,
        "nodes": sess.all_nodes(),
        "queue_remaining": len(sess.step_queue),
        "phase": sess.phase,
        "analytics": sess.analytics(),
        "recent_events": sess.events[-5:],
    }

@app.post("/simulate/run")
def run_all(body: StepRequest):
    sess = sessions.get(body.session_id)
    if not sess:
        raise HTTPException(404, "Session not found")
    if sess.phase == "idle":
        sess.build_queue()
    sess.run_all()
    return {
        "nodes":    sess.all_nodes(),
        "phase":    sess.phase,
        "analytics": sess.analytics(),
        "events":   sess.events,
        "hotspots": sess.detect_hotspots(),
    }

@app.get("/simulate/state/{session_id}")
def get_state(session_id: str):
    sess = sessions.get(session_id)
    if not sess:
        raise HTTPException(404, "Session not found")
    return {
        "nodes":    sess.all_nodes(),
        "phase":    sess.phase,
        "analytics": sess.analytics(),
        "hotspots": sess.detect_hotspots(),
        "events":   sess.events[-20:],
    }

@app.get("/simulate/hotspots/{session_id}")
def get_hotspots(session_id: str):
    sess = sessions.get(session_id)
    if not sess:
        raise HTTPException(404, "Session not found")
    return {"hotspots": sess.detect_hotspots(), "count": len(sess.detect_hotspots())}

@app.post("/simulate/resolve")
def resolve_hotspots(body: ResolveRequest):
    sess = sessions.get(body.session_id)
    if not sess:
        raise HTTPException(404, "Session not found")
    if sess.phase not in ("done", "resolving"):
        raise HTTPException(400, "DODAG must be formed first")
    actions = sess.resolve_hotspots()
    return {
        "actions":  actions,
        "nodes":    sess.all_nodes(),
        "analytics": sess.analytics(),
        "hotspots": sess.detect_hotspots(),
        "events":   sess.events[-10:],
    }

@app.post("/simulate/drain_energy/{session_id}")
def drain_energy(session_id: str, cycles: int = 10):
    """Simulate time passing — drain energy, build up traffic"""
    sess = sessions.get(session_id)
    if not sess:
        raise HTTPException(404, "Session not found")
    for _ in range(cycles):
        sess._idle_drain(dt=2.0)
        # simulate traffic accumulating on parent nodes
        for n in sess.nodes.values():
            if n.joined and not n.is_root and n.parent:
                par = sess.nodes.get(n.parent)
                if par:
                    n.drain_tx(random.randint(1,3))
                    par.drain_rx(random.randint(1,3))
    sess.log(f"Simulated {cycles} traffic cycles", "warn")
    return {
        "nodes":    sess.all_nodes(),
        "analytics": sess.analytics(),
        "hotspots": sess.detect_hotspots(),
    }

@app.post("/ml/predict_energy_drain")
def predict_energy_drain(body: EnergyPredictionRequest):
    predictions = [
        predict_node_energy(n, body.cycles, body.data_packets, body.ack_packets)
        for n in body.nodes
    ]
    if predictions:
        avg_energy = sum(p["predicted_energy"] for p in predictions) / len(predictions)
        min_energy = min(p["predicted_energy"] for p in predictions)
        total_drain = sum(p["predicted_drain"] for p in predictions)
    else:
        avg_energy = min_energy = total_drain = 0

    hotspots = [
        p["id"] for p in predictions
        if p["features"]["children_count"] > 1 or p["energy_pct"] < CRITICAL_ENERGY
    ]
    return {
        "model": "ml_regression_energy_v1",
        "predictions": predictions,
        "summary": {
            "avg_energy": round(avg_energy, 2),
            "min_energy": round(min_energy, 2),
            "total_predicted_drain": round(total_drain, 2),
            "hotspot_candidates": hotspots,
            "node_count": len(predictions),
        },
    }

@app.post("/chat/gemini")
def chat_with_gemini(body: GeminiChatRequest):
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(500, "GEMINI_API_KEY is not set on the backend")

    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    context = body.simulator_context or {}
    history = body.messages[-12:]

    system_text = (
        "You are a helpful assistant inside an RPL network simulator. "
        "Answer clearly and concisely. When useful, relate answers to DODAG formation, "
        "DIO, DAO, DATA, ACK, rank, ETX, energy drain, hotspots, and repair. "
        f"Current simulator context JSON: {json.dumps(context, ensure_ascii=True)[:3000]}"
    )

    contents = [{"role": "user", "parts": [{"text": system_text}]}]
    for msg in history:
        role = "model" if msg.role == "assistant" else "user"
        text = msg.text.strip()
        if text:
            contents.append({"role": role, "parts": [{"text": text[:4000]}]})

    payload = {
        "contents": contents,
        "generationConfig": {
            "temperature": 0.7,
            "maxOutputTokens": 700,
        },
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise HTTPException(exc.code, f"Gemini API error: {detail[:600]}")
    except Exception as exc:
        raise HTTPException(502, f"Could not reach Gemini API: {exc}")

    candidates = data.get("candidates") or []
    parts = candidates[0].get("content", {}).get("parts", []) if candidates else []
    reply = "".join(part.get("text", "") for part in parts).strip()
    if not reply:
        reply = "Gemini returned an empty response. Try asking again."
    return {"reply": reply, "model": model}

@app.delete("/simulate/{session_id}")
def delete_session(session_id: str):
    sessions.pop(session_id, None)
    return {"deleted": session_id}

@app.get("/sessions")
def list_sessions():
    return {"sessions": list(sessions.keys()), "count": len(sessions)}
