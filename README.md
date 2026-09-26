# AC Overlay Kit (`acokit`)

A tiny, **dependency-free engine for building Assetto Corsa broadcast overlays**.
It gives you live telemetry of the car a director is *spectating* — in
single-player, replay **and** multiplayer spectator mode — and a clean way to
render it as transparent HTML overlays in OBS.

It is **content-agnostic**: it ships no drivers, teams, tyre rules, points or
league logic. It just delivers AC telemetry + director state. You build your
tools on top.

> acokit is the generic engine extracted from a league broadcast system that
> ran on air, and it is maintained by the [Paddock OS](https://github.com/paddock-os)
> team. It stands on its own: nothing here needs Paddock OS.

## The three pieces

```
   Assetto Corsa  ──(in-game Python plugin, ~30Hz)──►  Coordinator  ──(SSE)──►  Your overlays
   plugin/                                              server/                  overlays/ + sdk/
   acokit_telemetry                                     coordinator.js           acokit.js
```

| Piece | Folder | What it does |
|---|---|---|
| **Telemetry plugin** | `plugin/acokit_telemetry/` | In-game AC Python app. Reads the **focused** car (`ac.getFocusedCar`) and POSTs telemetry/state to the coordinator. Bundles `_socket.pyd` so AC's stripped Python can do networking. Tested with `ac`/`acsys` stubbed — see `plugin/test/`. |
| **Coordinator** | `server/coordinator.js` | ~130 lines of Node stdlib. Ingests the plugin's POSTs, serves your static overlays, and fans events out over Server-Sent Events. No race logic — fork it freely. |
| **Browser SDK** | `sdk/acokit.js` | `new ACOKit()` → typed events (`telemetry`, `state`, `sync`, `connection`). Handles SSE vs orchestrator-shell transport and a built-in demo simulator. |
| **Overlay lifecycle** | `sdk/acokit-overlay.js` | `ACOverlay.init(id, opts)` → the scale handshake, visibility (`visible`, `onShow`, `onHide`) and `loop(fn, {hz})`, a render loop that pauses while nobody can see it. |
| **Theme loader** (opt-in) | `sdk/acokit-theme.js` | `?theme=<name>` → your stylesheet, inherited from the shell, switchable live. The kit ships no themes; you point it at yours. |
| **Racing helpers** (opt-in) | `sdk/acokit-racing.js` | `LapClock` (smooth 60fps clock), `LapWatcher` (arm → start → complete), `SectorTimer` (hardcoded sectors), `gearLabel`/`fmtLap`/`fmtSector`. Load only if you want them. |
| **Content layer** (opt-in) | `sdk/acokit-content.js` | `Roster` (strict driver→team/colour/number/logo) + `tyreLabeller` (your mod's compound mapping). The seam for *your* league's identity. See [`docs/CONTENT-LAYER.md`](docs/CONTENT-LAYER.md). |
| **Fleet hub** (opt-in) | `server/plugin-ws.js` | Every driver's AC sends *their own* car over one WebSocket, and the car on camera is the only one sending at full rate. See [`docs/FLEET.md`](docs/FLEET.md). |

## Quick start

```bash
# 1. Run the coordinator (serves overlays + ingests telemetry, port 3001)
git clone https://github.com/paddock-os/acokit.git
cd acokit
node server/coordinator.js

# 2. Open an example overlay in a browser (or as an OBS Browser Source)
#    Demo mode needs no AC at all:
#    http://localhost:3001/overlays/example-speedo.html?demo=1

# 3. For live data, install the in-game plugin (see plugin/ and docs/PLUGIN.md),
#    enable it in AC → Settings → General → UI Modules, then open the overlay
#    WITHOUT ?demo=1.
```

The coordinator and the browser SDK have no dependencies at all: no
`npm install` is needed to run them.

## Build your own overlay in 60 seconds

Copy `overlays/_template.html`, then:

```html
<script src="../sdk/acokit.js"></script>
<script>
  const kit = new ACOKit();                              // auto: live / shell / ?demo=1
  kit.on('telemetry', t => speed.textContent = Math.round(t.speedKmh));
  kit.on('state',     s => name.textContent  = s.spectatedDriver);
</script>
```

That's the whole API surface for most overlays. Every field is in
[`docs/SCHEMA.md`](docs/SCHEMA.md). More patterns (scaling, orchestrator shells,
demo, hardcoding for replays) in [`docs/BUILDING-OVERLAYS.md`](docs/BUILDING-OVERLAYS.md).

## Why an in-game plugin (not the shared-memory reader)?

AC's `acpmf_*` shared memory only holds the **local player** car. A spectating
director has no car, so it reads a phantom of zeros. The only reliable source
for the **focused** car is AC's in-game Python API (`ac.getCarState`), which is
exactly what the plugin uses. See `plugin/acokit_telemetry/acokit_telemetry.py`
for the hard-won details (the `_socket.pyd` bundling, the `idna` codec issue,
the per-frame lap-time reconstruction that works in replays).

## Conventions baked in

- **Transparent overlays** — author at a fixed internal size; the lifecycle
  (`ACOverlay.init`) fits them to the OBS source (`?scale=1.5`) or to a shell.
- **Orchestrator shells** — one page holds the single SSE connection, forwards
  events to embedded overlay `<iframe>`s via `postMessage`, and owns their
  visibility (`show`/`hide`/`flash`). The SDK detects this automatically
  (`window.parent !== window`); a hidden widget pauses its render loops.
- **Themes** — `?theme=<name>` swaps a stylesheet of your tokens, inherited by
  every widget in a shell and switchable live.
- **Demo mode** — `?demo=1` runs a lap simulator so you can build and style
  overlays with zero AC running.
- **`?api=host:port`** — point an overlay at a coordinator on another machine.
- **`tools/plugin-monitor.html`** — when wiring the plugin up, this shows every
  field it sends and whether that field has EVER changed. AC does not populate
  everything in every mode, and this is how you find out which ones.

## What's included

```
sdk/acokit.js                          core SDK (transport, events, demo, scaling)
sdk/acokit-overlay.js                  overlay lifecycle (scale, visibility, render loops)
sdk/acokit-theme.js                    theme loader (?theme= → your stylesheet, live switching)
sdk/acokit-racing.js                   opt-in: LapClock, LapWatcher, SectorTimer, formatters
sdk/acokit-content.js                  opt-in: Roster + tyreLabeller (your league identity)
server/coordinator.js                  minimal coordinator (Node stdlib only)
server/transport.js                    SSE hub + JSON body helpers, shared by any coordinator
server/plugin-ws.js                    opt-in: fleet hub, one WebSocket per driver (needs `ws`)
plugin/acokit_telemetry/               in-game AC plugin (+ bundled _socket.pyd / select.pyd)
test/                                  the JS suite behind `npm test` (no framework)
plugin/test/                           the plugin suite (Python, ac/acsys stubbed)
tools/plugin-monitor.html              live view of what the plugin is really sending
content/drivers.sample.json            roster template (copy → content/drivers.json)
overlays/_template.html                starter overlay
overlays/_orchestrator-template.html   one-connection shell that fans out to iframes
overlays/example-speedo.html           speed / gear / rpm / throttle / brake / DRS HUD
overlays/example-laptracker.html       arming + smooth clock + hardcoded sectors (replay-ready)
docs/SCHEMA.md                         every event & field (with replay caveats)
docs/BUILDING-OVERLAYS.md              patterns: scale, demo, shells, replays, arming
docs/PLUGIN.md                         install + the AC-Python gotchas, all solved
docs/FLEET.md                          every driver sends their own car; traffic follows the camera
docs/CONTENT-LAYER.md                  add your league: roster, logos, tyres, points
```

Try them with no AC running:
- `…/overlays/example-speedo.html?demo=1`
- `…/overlays/example-laptracker.html?demo=1&s1=23.643&s2=37.435&s3=24.475&tyre=S`
- `…/overlays/_orchestrator-template.html?demo=1` (both, on one shell)

## Tests

```bash
npm install           # only for the fleet hub's tests: installs `ws`
npm test              # everything: the JS suite + the plugin suite
npm run test:js       # JS only
npm run test:plugin   # the AC plugin (needs python3)
node test/run.js loops        # run only suites/tests matching a substring
```

A couple of seconds, no test framework — Node stdlib for the kit, Python
stdlib for the plugin. The runner prints the counts; they are deliberately not
repeated here, because a number written into prose is wrong one commit later.
The browser SDK is loaded into a stub window whose **clock and animation frames a test drives by hand**,
so render loops — the part of an overlay hardest to eyeball and easiest to get
wrong — are pinned down properly:

```js
env.frame();          // run one requestAnimationFrame callback
env.advance(500);     // move Date.now() forward without running frames
env.pending();        // frames queued right now (a stopped loop queues none)
```

Every case in `test/overlay-lifecycle.test.js` is a bug that actually shipped:
a widget that never presented because its intro ran on iframe load, a stopwatch
frozen outside a shell because its loop waited for a message only a shell
sends, loops running behind a faded-out iframe. Add a case before fixing the
next one.

**If you install your own copy of the plugin** (you will: its folder name is
what AC's UI Modules list shows), test that copy too — the one that runs is the
one that matters:

```bash
ACOKIT_PLUGIN_COPIES=../apps/python/myleague/myleague.py npm run test:plugin
```

Every copy listed is run through the whole suite, plus a parity check that they
all still send the same fields.

## Status

`v0.3` — generic engine + overlay lifecycle + theming + fleet ingestion +
opt-in racing & content helpers + templates + examples + docs, with every
module covered by tests, the in-game plugin included. The engine is decoupled
from any league; add yours via the content layer
([`docs/CONTENT-LAYER.md`](docs/CONTENT-LAYER.md)).

Issues and pull requests are welcome. For a bug in the plugin, the traceback
from AC's console (Page Up) is the most useful thing you can attach.

## Licence

MIT — see [`LICENSE`](LICENSE). Fork it, rename it, ship your own tools.

The plugin bundles two compiled CPython 3.3 extension modules under the Python
Software Foundation License; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

Assetto Corsa is a trademark of Kunos Simulazioni. acokit is an independent
project and is not affiliated with or endorsed by Kunos Simulazioni.
