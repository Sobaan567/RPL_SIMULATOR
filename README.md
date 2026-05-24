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

The simulator is designed to show how IoT sensor nodes join an RPL DODAG, forward traffic toward a root, send data to a Base Station, receive acknowledgements, lose energy, become hotspots, and recover through parent re-election.

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

## Frontend Controls

Top bar:

- `Run`: build the DODAG automatically
- `Step`: execute DODAG formation step by step
- `Reset`: clear the current DODAG state
- `Send Data`: animate DATA to Base Station and ACK replies
- `Drain`: call backend ML energy calculation and animate DATA/ACK traffic
- `Fix`: attempt hotspot resolution
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
9. Open `Stats` and inspect `ML ENERGY`.
10. Watch the heatmap and ML Risk Radar.
11. Click `Fix` if hotspots appear.
12. Try manual insertion using the `M` toolbar button.

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
