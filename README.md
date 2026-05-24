# RPL Network Simulator

A full-stack RPL (IPv6 Routing Protocol for Low-Power and Lossy Networks) simulator with:

- Live Demo: https://rpl-simulator-ef1e.vercel.app/

- React + Vite frontend
- FastAPI backend
- DODAG formation
- DIO / DAO / DATA / ACK packet animation
- Base Station tower visualization
- Hotspot detection and repair
- ML-style backend energy prediction
- Manual node insertion with rank, Base Station distance, and energy inputs
- Floating Gemini 2.5 Flash network assistant
- Selected-node route highlighting
- Failure and attack scenario controls
- Dedicated ML risk ranking panel

The simulator is designed to show how IoT sensor nodes join an RPL DODAG, forward traffic toward a root, send data to a Base Station, receive acknowledgements, lose energy, become hotspots, and recover through parent re-election.

## Algorithm Guide: What Each Algorithm Does

This project combines several routing, energy, and repair algorithms. Each one is responsible for a different part of the simulation.

| Algorithm / Logic | What It Does | Where You See It |
|---|---|---|
| `DODAG Formation` | Builds the RPL routing tree from the root node. The root sends DIO messages, nearby nodes join, choose parents, receive ranks, and then help spread DIO messages further. | Click `Run` or `Step`; blue DIO packets appear and nodes connect into a tree. |
| `OF0 - Hop Count` | Chooses routes mainly by the number of hops to the root. A node prefers the parent that gives it the lowest hop-based rank. | Use the `OF` control and select hop mode. |
| `MRHOF - ETX` | Chooses routes using link quality. Longer or weaker links get higher ETX cost, so nodes prefer more reliable paths instead of only the shortest hop count. | Use the `OF` control and select ETX mode; enable ETX labels to inspect link cost. |
| `Rank Calculation` | Calculates how far a node is from the root in routing cost. Lower rank means a better position in the DODAG. | Node table, node labels, selected-node inspector, and execution log. |
| `Preferred Parent Selection` | Decides which neighbor should become a node's parent. A node changes parent only when the new parent gives a better rank. | During DIO formation when lines appear between child and parent nodes. |
| `DAO Registration` | Sends route registration messages upward from joined nodes to their parents. This confirms upward routes back toward the root. | After DODAG formation; orange DAO packets travel child to parent. |
| `DATA Forwarding` | Sends application traffic from sensor nodes through their parent chain to the DODAG root, then to the Base Station. | Click `Send Data`; cyan DATA packets travel toward the Base Station. |
| `ACK Return Path` | Sends acknowledgement packets back from the Base Station through the root and parent chain to the original sensor node. | Purple ACK packets return after DATA traffic. |
| `Energy Drain Model` | Reduces node battery based on sending, receiving, idle cost, relay load, and traffic pressure. Relay nodes with many children lose more energy. | Energy rings around nodes, battery values in the node table, and Stats tab. |
| `ML-Style Energy Prediction` | Predicts how much energy each node will lose using features such as children count, RX packets, TX packets, root role, DATA packets, and ACK packets. | Click `Drain`; results appear in `Stats` and the `ML` tab. |
| `Hotspot Detection` | Finds nodes that are overloaded or low on energy. A node is risky when it forwards too much traffic or its battery becomes critical. | Warning node colors, issue banner, hotspot count, ML risk list, and heatmap. |
| `Hotspot Resolution / Repair` | Tries to move children away from overloaded or low-energy relay nodes. It searches for alternate parents in range, avoids loops, and recalculates rank and ETX. | Click `Fix`; repair actions appear in the execution log and Stats tab. |
| `Manual Node Insertion Logic` | Allows a manually inserted node to use custom rank, Base Station distance, and energy values when calculating its routing cost. | Use the `M` toolbar mode, enter values, then insert a node. |
| `Failure Scenario Logic` | Simulates network problems such as drained nodes, killed nodes, traffic bursts, radio jamming, and random faults. | Open the `Scenario` tab and run a drill. |
| `Route Highlighting` | Traces the selected node's path through its parents to the root and then to the Base Station. | Click any joined sensor node. |

## Project Structure

```text
rpl_simulator/
|-- backend/
|   |-- main.py              FastAPI backend and RPL engine
|   |-- requirements.txt     Python dependencies
|   `-- README.md
|-- rpl-frontend/
|   |-- src/
|   |   |-- RPLSimulator.jsx Main simulator UI and canvas logic
|   |   |-- App.jsx
|   |   `-- index.css
|   |-- package.json
|   `-- vite.config.js
`-- README.md
```

## How The Simulator Works

### 1. DODAG Formation

The red `R` node is the DODAG root. When you click `Run`, the simulator builds the DODAG by propagating DIO messages from the root to nearby nodes.

Each node chooses a preferred parent when the rank offered by a sender is better than its current rank. Once a node joins, it can help propagate DIO messages to other nodes.

Supported objective modes:

- `OF0 - Hop Count`: rank increases mostly by hop count.
- `MRHOF - ETX`: rank is influenced by link distance/quality.

### 2. DAO Registration

After the DODAG finishes, joined nodes send DAO packets upstream to their preferred parents. This represents upward route registration toward the root.

### 3. Base Station

The cyan tower is the Base Station. It is separate from the DODAG root.

Traffic path:

```text
Sensor node -> parent -> parent -> DODAG root -> Base Station
```

When the Base Station replies:

```text
Base Station -> DODAG root -> parent -> sensor node
```

### 4. DATA And ACK Packets

Click `Send Data` to animate application data going from sensor nodes to the Base Station.

Click `Drain` to show a more complete traffic cycle:

- cyan `DATA` packets travel toward the Base Station
- purple `ACK` packets return from the Base Station
- node energy is recalculated
- hotspot risk becomes visible

### 5. Energy Model

Every node has a battery value from `0` to `100`.

The frontend displays energy in three places:

- ring around each node
- node table battery column
- Stats tab

When energy drops, nodes can become critical. Relay nodes with many children lose energy faster because they forward more traffic.

### 6. Backend ML Energy Prediction

On `Drain`, the frontend sends node features to the backend:

- node id
- root status
- current energy
- number of children
- RX packet count
- TX packet count
- joined state
- data and ACK packet assumptions

The backend endpoint `/ml/predict_energy_drain` returns:

- previous energy
- predicted drain
- predicted remaining energy
- energy percentage
- model name
- feature values used

The frontend then updates every node with the backend prediction and shows the ML result in the `Stats` tab under `ML ENERGY`.

If the backend is not running, the frontend uses a fallback calculation so the demo still works, but the UI labels it as `FALLBACK`.

### 7. Hotspot Problem

A hotspot is a relay node that receives/forwards a lot of traffic. In this simulator, hotspot risk is shown using:

- warning color on the node
- issue banner
- Stats tab hotspot count
- ML Risk Radar
- ML heatmap layer

Click `Drain` after `Run` to create traffic and reveal hotspot behavior.

### 8. Fix / Resolution

Click `Fix` after hotspots appear.

The simulator tries to move children away from overloaded or low-energy relay nodes. It searches for alternate parents within radio range, avoids invalid loops, and updates rank/ETX for moved children.

If no alternate parent exists, the execution log reports that clearly.

### 9. ML Risk Heatmap

After an ML energy calculation, the canvas can show a heatmap around risky nodes:

- green glow: healthier energy state
- orange glow: medium risk
- red glow: high risk / critical energy

Use the heatmap toolbar button to toggle the heatmap.

### 10. Manual Insertion Feature

Use the `M` button in the left toolbar to enable manual node insertion.

You can enter:

- rank
- distance from Base Station
- energy

Then click `Insert Node`, or click on the canvas in add mode.

Manual nodes get a `MAN` badge. During DODAG formation, only these manually inserted nodes use the manual rank/distance/energy calculation.

Manual rank formula in the frontend:

```text
manual cost = input rank + base distance / 120 + energy penalty
energy penalty = (100 - energy) / 35
final rank = max(parent rank + 1, manual cost)
```

This means:

- lower input rank helps the node
- longer Base Station distance increases cost
- lower energy increases cost
- the child rank can never be less than `parent rank + 1`

### 11. Gemini Network Assistant

The floating `AI` button opens a Gemini 2.5 Flash chat assistant. It can explain the current simulation, selected node, hotspot risk, ML energy prediction, and repair options.

The assistant receives simulator context such as:

- current phase
- selected node and route
- DIO / DAO / DATA / ACK counters
- analytics
- hotspot list
- ML energy report
- recent failure scenario log

The top bar also includes `AI Explain`, which sends a one-click prompt asking Gemini to narrate the current network state and recommend the next action.

Production Vercel deployments use the serverless endpoint:

```text
/api/chat/gemini
```

Local development uses the FastAPI endpoint:

```text
http://127.0.0.1:8000/chat/gemini
```

### 12. Route Highlighting

Click any joined sensor node to highlight its route:

```text
selected node -> parent chain -> DODAG root -> Base Station
```

The highlighted path helps show how RPL forwards application traffic through the DODAG before reaching the Base Station.

### 13. Failure And Attack Scenarios

The `Scenario` tab adds interactive stress tests:

- `Drain Node`: reduce the selected or weakest node battery
- `Kill Node`: take a selected or weak node offline and orphan direct children
- `Traffic Burst`: increase relay pressure to create hotspot behavior
- `Jam Radio`: reduce radio range to simulate degraded connectivity
- `Random Fault`: pick a random non-root node and drain it
- `Clear Drill`: reset the DODAG state

Scenario events are shown in a drill log and are also appended to the execution log.

### 14. ML Risk Panel

The `ML` tab ranks every node after `Drain` using predicted energy drain and remaining battery.

For each node it shows:

- risk level
- predicted drain
- remaining energy
- children count
- energy bar

Clicking a node in the ML ranking selects it for inspection and route highlighting.

## Frontend Controls

Top bar:

- `Run`: build the DODAG automatically
- `Step`: execute DODAG formation step by step
- `Reset`: clear the current DODAG state
- `Send Data`: animate DATA to Base Station and ACK replies
- `Drain`: call backend ML energy calculation and animate DATA/ACK traffic
- `Fix`: attempt hotspot resolution
- `AI Explain`: ask Gemini to explain the current simulation state
- `OF`: switch between hop count and ETX objective modes
- `Rng`: radio range
- `Spd`: animation speed

Left toolbar:

- select/drag nodes
- add nodes
- remove nodes
- manual insert mode
- add random node
- toggle radio range
- toggle radio links
- toggle labels
- toggle ETX labels
- toggle ML heatmap

Right panel:

- `Nodes`: node table
- `Inspect`: selected node details
- `Exec Log`: DIO/DAO/DATA/DRAIN/FIX events
- `Stats`: analytics, ML energy report, resolution log
- `ML`: per-node predicted drain and energy risk ranking
- `Scenario`: failure, traffic burst, and radio jamming drills

Floating assistant:

- `AI`: opens Gemini Network Chat
- `Explain Network`: summarize current DODAG, energy, and hotspot state
- `Selected Node`: explain the selected node and route
- `Suggest Fix`: recommend repair actions
- `ML Risk`: explain the energy prediction and risky nodes
- `Clear`: reset the chat transcript

## Backend Code Explanation: `backend/main.py`

`main.py` is the FastAPI backend. It contains the API routes, node model, RPL session engine, hotspot logic, analytics, and ML-style energy predictor.

### Imports And App Setup

The file imports:

- `FastAPI` for the web server
- `CORSMiddleware` so the React frontend can call the backend
- `BaseModel` for request validation
- `math`, `random`, `time`, `uuid` for simulation utilities

The app is created with:

```python
app = FastAPI(title="RPL Simulator API", version="3.0")
```

CORS is enabled for all origins so the Vite frontend can call `http://127.0.0.1:8000`.

### Constants

Important constants:

- `RADIO_RANGE`: default communication range
- `TX_ENERGY_PER_PKT`: energy cost for sending
- `RX_ENERGY_PER_PKT`: energy cost for receiving
- `IDLE_DRAIN_RATE`: background energy drain
- `BATTERY_CAPACITY`: max battery
- `HOTSPOT_THRESHOLD`: traffic ratio used to flag hotspots
- `CRITICAL_ENERGY`: low-energy threshold
- `INF_RANK`: unreachable rank value

### Request Models

Pydantic models define incoming JSON shapes:

- `NodeIn`: node topology input
- `TopologyIn`: complete topology/session request
- `StepRequest`: session id for step/run operations
- `ResolveRequest`: session id for hotspot repair
- `EnergyNodeIn`: node features for ML energy prediction
- `EnergyPredictionRequest`: ML energy prediction request
- `ChatMessageIn`: Gemini chat message input
- `GeminiChatRequest`: Gemini chat request with simulator context

### `RPLNode`

`RPLNode` represents one node in the network.

Important fields:

- `id`
- `x`, `y`
- `is_root`
- `rank`
- `parent`
- `children`
- `etx`
- `energy`
- `traffic_rx`
- `traffic_tx`
- `joined`
- `flags`

Important methods:

- `is_hotspot()`: checks whether RX traffic ratio is high
- `is_critical_energy()`: checks low battery
- `drain_tx()`: subtracts TX energy
- `drain_rx()`: subtracts RX energy
- `idle_drain()`: subtracts idle energy
- `compute_flags()`: updates hotspot/critical/isolated flags
- `to_dict()`: returns frontend-safe JSON

### `RPLSession`

`RPLSession` manages a complete network simulation.

It stores:

- session id
- objective function mode
- all nodes
- step queue
- event log
- phase
- DIO/DAO counts

Important methods:

#### `build_queue()`

Creates the DIO propagation queue. It starts from root nodes, finds neighbors, and queues DIO messages.

#### `execute_step()`

Runs one DIO step:

1. gets sender and receiver
2. applies TX/RX energy drain
3. computes ETX and rank
4. checks if receiver improves its rank
5. updates parent/children if improved
6. returns event data

#### `run_all()`

Runs all queued DIO steps until the DODAG is complete.

#### `_finalise()`

Marks the session as done, sends DAO messages, applies idle drain, and logs completion.

#### `_send_daos()`

Each joined node sends a DAO to its parent. Energy is drained for sender and receiver.

#### `detect_hotspots()`

Finds nodes with:

- hotspot traffic ratio
- critical energy

Returns hotspot details to the frontend.

#### `resolve_hotspots()`

Attempts to repair network issues:

- critical-energy relay nodes move children to healthier parents
- hotspot relay nodes move some children to less loaded neighbors
- ranks and ETX values are recomputed

#### `analytics()`

Computes network stats:

- joined nodes
- join percentage
- average energy
- minimum energy
- hotspot count
- critical node count
- DIO/DAO counts
- average rank
- health score

### ML Energy Prediction

The function `predict_node_energy()` is a lightweight ML-style predictor. It uses a deterministic regression-style formula based on:

- number of children
- RX traffic
- TX traffic
- root role
- data packets
- ACK packets
- idle cost
- residual load term

It returns predicted drain and remaining energy for each node.

The route `/ml/predict_energy_drain` runs this prediction for all nodes sent by the frontend.

### Gemini Chat

The FastAPI route `/chat/gemini` sends simulator-aware chat requests to Gemini 2.5 Flash. The backend reads:

```text
GEMINI_API_KEY
GEMINI_MODEL
```

from environment variables or `backend/.env`.

## API Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/` | Backend health/status |
| `POST` | `/simulate/init` | Create a simulation session |
| `POST` | `/simulate/build` | Queue DIO messages |
| `POST` | `/simulate/step` | Execute one DIO step |
| `POST` | `/simulate/run` | Run full DODAG simulation |
| `GET` | `/simulate/state/{session_id}` | Get session state |
| `GET` | `/simulate/hotspots/{session_id}` | Get hotspot list |
| `POST` | `/simulate/resolve` | Resolve hotspots |
| `POST` | `/simulate/drain_energy/{session_id}` | Backend session drain simulation |
| `POST` | `/ml/predict_energy_drain` | ML-style per-node energy prediction |
| `POST` | `/chat/gemini` | Gemini network assistant chat |
| `DELETE` | `/simulate/{session_id}` | Delete session |
| `GET` | `/sessions` | List active sessions |

## How To Run

Open two terminals.

### Terminal 1: Backend

From the project root:

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

For the floating Gemini chat bot, set your API key before starting the backend:

```powershell
$env:GEMINI_API_KEY="your-gemini-api-key"
python -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

On Vercel, add these Environment Variables to the frontend project:

```text
GEMINI_API_KEY=your-gemini-api-key
GEMINI_MODEL=gemini-2.5-flash
```

Backend URL:

```text
http://127.0.0.1:8000
```

API docs:

```text
http://127.0.0.1:8000/docs
```

### Terminal 2: Frontend

From the project root:

```bash
cd rpl-frontend
npm install
npm run dev
```

Frontend URL:

```text
http://127.0.0.1:5173
```

## Recommended Demo Flow

1. Start backend.
2. Start frontend.
3. Open `http://127.0.0.1:5173`.
4. Click `Run`.
5. Watch DIO and DAO formation.
6. Click `Send Data`.
7. Watch DATA go to the Base Station and ACK return.
8. Click `Drain`.
9. Open `ML` and inspect the ranked node risk list.
10. Click a node to highlight its route to the root and Base Station.
11. Open `Stats` and inspect `ML ENERGY`.
12. Watch the heatmap and ML Risk Radar.
13. Open `Scenario` and try `Traffic Burst`, `Drain Node`, or `Jam Radio`.
14. Click `Fix` if hotspots appear.
15. Click `AI Explain` or open the floating `AI` chat for a Gemini explanation.
16. Try manual insertion using the `M` toolbar button.

## Build Check

Frontend production build:

```bash
cd rpl-frontend
npm run build
```

Backend syntax check:

```bash
python -m py_compile backend/main.py
```
