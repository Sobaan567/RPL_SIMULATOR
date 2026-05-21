# RPL Simulator — Python Backend

## Setup & Run

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

API docs auto-generated at: http://localhost:8000/docs

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /simulate/init | Load topology, get session_id |
| POST | /simulate/build | Queue DIO messages |
| POST | /simulate/step | Execute one DIO step |
| POST | /simulate/run | Run full simulation |
| GET | /simulate/state/{id} | Get current network state |
| GET | /simulate/hotspots/{id} | Get hotspot nodes |
| POST | /simulate/resolve | Run hotspot + energy resolution |
| POST | /simulate/drain_energy/{id} | Simulate time passing |
| DELETE | /simulate/{id} | Clean up session |

## Models

### Energy Model
- Each node starts with 100 mJ battery
- TX costs 0.05 mJ/packet, RX costs 0.02 mJ/packet
- Idle drain: 0.001 mJ/sec
- Nodes below 15 mJ are flagged as `critical_energy`

### Hotspot Detection
- Nodes where rx/(rx+tx) > 60% are flagged as `hotspot`
- Heavy relay nodes accumulate high rx traffic

### Hotspot Resolution
- **Critical energy**: children re-elect to healthier parents
- **Load balance**: half of hotspot's children migrate to lighter neighbors
- ETX penalty applied to low-energy nodes (avoids routing through dying nodes)
