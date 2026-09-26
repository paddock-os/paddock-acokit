# acokit data schema

Everything an overlay receives. The coordinator wraps each message as
`{ EventType, Message }` on the wire; the SDK unwraps it and gives you
`Message` as the event `detail`.

## SSE event types

| EventType | SDK event | When | `detail` |
|---|---|---|---|
| `TELEMETRY` | `telemetry` | ~30 Hz | focused-car physics (below) |
| `PLUGIN_STATE` | `state` | ~1 Hz | director/spectator state (below) |
| `SYNC` | `sync` | on connect | `{ plugin: { telemetry, spectated, lastTelemetryAt, lastStateAt } }` — the SDK also re-emits the nested telemetry/state as `telemetry`/`state` |
| *(anything else)* | `raw` | — | the full `{ EventType, Message }` envelope |

`kit.telemetry` and `kit.state` always hold the latest of each.

## `telemetry` payload (TELEMETRY, ~30 Hz)

The focused car's live physics. Field names match the in-game plugin.

| Field | Type | Notes |
|---|---|---|
| `speedKmh` | number | km/h |
| `gear` | int | **0 = Reverse, 1 = Neutral, 2 = 1st gear, …** (`acsys.CS.Gear` encoding) |
| `rpm` | int | engine RPM |
| `throttle` | 0..1 | |
| `brake` | 0..1 | |
| `clutch` | 0..1 | |
| `steer` | number | radians (normalise yourself if you want ±1) |
| `drs` | number | `> 0.5` ⇒ DRS open. **0 in replays** (AC doesn't record modded DRS); works live. |
| `splinePosition` | 0..1 | normalised lap fraction (track position) |
| `lapTimeMs` | int | current lap elapsed, ms (works for the focused car, live and replay) |
| `lastLapMs` | int | last lap, ms. **0 in replays** — prefer `completedLapMs`. |
| `bestLapMs` | int | best lap, ms. **0 in replays.** |
| `lapCount` | int | completed laps. **0 in replays.** |
| `completedLapMs` | int | EXACT last completed lap, reconstructed per-frame by the plugin. **Works in replays.** |
| `lapEvent` | int | counter bumped on each completion — watch it change to trigger a lap reveal |
| `tyreTemp` | number[4] | core temps FL, FR, RL, RR (°C) |
| `pitLimiter` | bool | not exposed by base AC; `false` unless a CSP path is added |
| `drsAvail` | bool | diagnostic: does this AC build expose `acsys.CS.DRS` |

### Replay caveat (important)

AC does **not** record some modded/live-only values in replays. In a replay,
`lastLapMs` / `bestLapMs` / `lapCount` / `drs` read **0**. What still works:
`speedKmh`, `gear`, `rpm`, `throttle`, `brake`, `splinePosition`, `lapTimeMs`,
and `completedLapMs`/`lapEvent` (the plugin reconstructs the exact lap total
from the live lap clock). For replay clips, drive overlays from those and
hardcode anything AC can't give you (e.g. tyre compound, sector splits).

## `state` payload (PLUGIN_STATE, ~1 Hz)

Slow-changing director/spectator context.

| Field | Type | Notes |
|---|---|---|
| `spectatedDriver` | string | display name of the focused car's driver |
| `spectatedCarId` | int | AC car id |
| `carModel` | string | car folder name |
| `isInPit` | bool | focused car in the pits |
| `currentTire` | string | AC compound short name (e.g. `"C5"`, `"Soft"`). **Mapping is mod-specific** — don't assume. |
| `completedLaps` | int | (0 in replay) |
| `iCurrentTime` | int | current lap time, ms |
| `iLastTime` | int | last lap, ms (0 in replay) |
| `iBestTime` | int | best lap, ms (0 in replay) |
| `sessionFlag` | string | `none` / `yellow` / `blue` / `black` / `white` / `checkered` / `penalty` (read from `acpmf_graphics`; session-wide) |
| `yellowFlag` | bool | convenience: `sessionFlag === 'yellow'` |

## Orchestrator-shell messages (postMessage)

When an overlay is embedded in a shell page, these flow between them:

| message | direction | meaning |
|---|---|---|
| `{type:'SHELL_OVERLAY_READY'}` | child → shell | child is listening; replay the cached SYNC **and its current visibility** |
| `{type:'SCALE_CAPABLE', overlay}` | child → shell | child scales itself; shell should answer with SET_SCALE |
| `{type:'SET_SCALE', value}` | shell → child | apply this numeric scale |
| `{type:'OVERLAY_SHOW', overlay}` | shell → child | you are on screen now |
| `{type:'OVERLAY_HIDE', overlay}` | shell → child | you are off screen now |
| `{type:'THEME_SET', theme}` | shell → child | switch to this theme, live |
| `{EventType, Message}` | shell → child | a forwarded coordinator event |

The SDK handles all of these for you: `new ACOKit()` for the data, and
`ACOverlay.init(id, opts)` for the rest. If you write your own shell instead of
starting from `overlays/_orchestrator-template.html`, three of these have rules
that are easy to miss — see
[BUILDING-OVERLAYS §4](BUILDING-OVERLAYS.md#4-orchestrator-shells-one-connection-many-overlays):

- **Visibility is not optional.** A hidden iframe keeps running; fading it out
  saves nothing. `OVERLAY_HIDE` is what stops a child's render loops, and
  `OVERLAY_SHOW` is the only correct cue for a one-shot intro — every iframe
  loads when OBS starts, long before anyone sees it.
- **Send the initial state, even when it is "hidden"**, or a widget that starts
  off screen is never told and runs for the whole broadcast unseen.
- **Replay on `SHELL_OVERLAY_READY`, in whichever direction is current.** A
  child announces itself when ready, which can be after you already sent its
  visibility.
