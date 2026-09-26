# The in-game telemetry plugin

`plugin/acokit_telemetry/` is an Assetto Corsa Python app that reads the
**focused** car and POSTs telemetry (~30 Hz) + state (~1 Hz) to the coordinator.

## Install

1. Copy the whole `acokit_telemetry/` folder into your AC install so you get:
   ```
   <AC>/apps/python/acokit_telemetry/acokit_telemetry.py
   <AC>/apps/python/acokit_telemetry/stdlib/     (_socket.pyd, select.pyd — 32-bit)
   <AC>/apps/python/acokit_telemetry/stdlib64/   (_socket.pyd, select.pyd — 64-bit)
   ```
   (Your AC may be under a non-default Steam library, e.g. `D:\SteamLibrary\...`.)
2. Launch AC → **Settings → General → UI Modules** → tick **`acokit_telemetry`** → Apply.
   If it doesn't appear, **restart AC** (Python apps are scanned at launch).
3. Run an acokit coordinator on `127.0.0.1:3001`.
4. Open AC's console (**Page Up**, or type `console` in the main menu) and look for:
   ```
   [acokit] Plugin loaded. Posting to 127.0.0.1:3001
   ```

## Why the bundled `.pyd` files?

AC ships a **stripped Python 3.3.5** that lacks the `_socket` C-extension on the
plugin path, so a plain `import socket` dies with
`ImportError: No module named '_socket'`. The fix (standard among AC networking
apps) is to bundle the compiled `_socket.pyd` (+ `select.pyd`) under
`stdlib/`/`stdlib64/` and prepend the right one to `sys.path` before importing
`socket`. The plugin does this at the top of the file. The bundled `.pyd`s here
are the stock CPython 3.3 x86/x64 extensions and work with any AC build
(PSF License — see `THIRD_PARTY_NOTICES.md`).

## Other gotchas already handled

- **`idna` codec missing.** `socket.connect(("127.0.0.1", port))` with a *str*
  host runs it through the `idna` text codec, which AC's Python lacks
  (`LookupError: unknown encoding: idna`). The plugin connects with a **bytes**
  host to skip that path.
- **Spectator phantom.** `acpmf_*` shared memory is the local player car (zeros
  for a spectator). The plugin reads the focused car via `ac.getCarState` instead.
- **Replay lap times.** `acsys.CS.LastLap/BestLap/LapCount` return 0 in replays.
  The plugin reconstructs the **exact** lap total every frame from the live lap
  clock (`total = prevLapTime − curLapTime + frameDelta`) and exposes it as
  `completedLapMs` + a `lapEvent` counter.
- **Crash-proof reads.** Every `acsys.CS.*` read goes through a `getattr`-guarded
  helper, so a build missing a member can't kill the telemetry stream.

## Configuration

Edit the constants at the top of `acokit_telemetry.py`:

| Const | Default | Meaning |
|---|---|---|
| `COORDINATOR_HOST` | `127.0.0.1` | where to POST |
| `COORDINATOR_PORT` | `3001` | coordinator port |
| `TELEMETRY_INTERVAL_S` | `1/30` | telemetry rate (raise if you see stutter) |
| `STATE_INTERVAL_S` | `1.0` | state rate |
| `FLEET_URL` | `""` | `ws://…` of a league coordinator; empty keeps the local HTTP mode (see [`FLEET.md`](FLEET.md)) |
| `FLEET_TOKEN` | `""` | the league token sent in the fleet handshake |
| `FLEET_MODE` | `"driver"` | `driver` sends the car this machine drives; `director` sends the focused one |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No `[acokit]` line in AC console | Plugin not enabled (UI Modules) or not restarted. |
| `ImportError: No module named '_socket'` | `stdlib64/` not copied next to the `.py`. |
| `coordinator unreachable, will retry` | Coordinator not running, or wrong host/port. |
| `acUpdate error: ...` traceback | A read failed — file an issue with the traceback. |
| Coordinator never logs "first telemetry packet" | AC is in a menu (no focused car) or plugin not posting. |
