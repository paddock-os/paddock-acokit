# Changelog

## 0.3.1 — overlays listen only to the shell that frames them

**Security**
- Every `message` listener in the browser SDK now checks who sent the message.
  Before, any window holding a handle on an overlay -- one that opened it with
  `window.open`, for instance -- could switch its theme (`THEME_SET`), show,
  hide or rescale it (`OVERLAY_SHOW`, `OVERLAY_HIDE`, `SET_SCALE`), or, in
  shell mode, feed it race data as if it were the orchestrator's relay.
  - `acokit-theme.js`, `acokit-overlay.js` (the shared router, and so every
    handler registered with `ACOverlay.on()`) and `ACOKit`'s `SET_SCALE`
    listener accept a message only from `window.parent`, and only when the page
    is actually framed.
  - `ACOKit`'s shell relay accepts envelopes only from `window.parent`.

**Changed**
- A page nobody frames no longer reacts to `THEME_SET`. Nothing in acokit sent
  it one: the orchestrator posts to its own `<iframe>`s. Use `?theme=` or
  `ACOTheme.set()` on a standalone page.
- The test harness's `dispatch()` sends a `message` from the page's parent, as
  a real shell does, and takes a third argument to play another window.

The AC plugin is unchanged and still reports `0.3.0`.

## 0.3.0 — fleet mode, and the first release from its own repository

acokit now lives at <https://github.com/paddock-os/paddock-acokit>. Earlier versions
were developed inside the league project it was extracted from.

**Added**
- `server/plugin-ws.js` — fleet ingestion. Every driver's AC holds one
  WebSocket to the coordinator and sends their own car; identity is the
  server's decision (`authenticate`), one live connection per identity, and
  the hub tells each client how fast to send so only the car on camera runs at
  30 Hz. See `docs/FLEET.md`.
- Fleet mode in the plugin (`FLEET_URL`, `FLEET_TOKEN`, `FLEET_MODE`): a
  hand-rolled, non-blocking RFC 6455 client, since AC's Python has no WebSocket
  library. `ws://` only, refused with a message for `wss://`.
- `ACOKIT_PLUGIN_COPIES` — run the plugin suite against your own installed
  copies of the plugin as well as the engine's, with a parity check between
  them.
- `THIRD_PARTY_NOTICES.md` for the bundled CPython extension modules.

**Changed**
- `ws` is declared as an optional peer dependency (and a dev dependency for the
  tests). The coordinator and the browser SDK still have no dependencies.
- `acokit-theme.js` falls back to a theme called `default` rather than a name
  from the original project. Pass `data-default` to choose another.
- `tools/plugin-monitor.html` is in English and escapes what it renders.
- `overlays/_orchestrator-template.html` resolves the coordinator with
  `ACOKit.apiBase()`, the same rule every widget uses.

**Fixed**
- `apiBase()` no longer assumes port 3001 for any page on a non-default port.
  When the coordinator serves the overlays itself on another port, the API is
  the page's own origin; only a page on the dev static port (3000) looks for a
  coordinator on 3001. A coordinator moved off 3001 used to leave every overlay
  waiting for data that was never coming.

## 0.2.0 — the lifecycle, and a way to trust it

**Added**
- `sdk/acokit-overlay.js` — the overlay lifecycle. `ACOverlay.init(name, opts)`
  owns URL params, the `SCALE_CAPABLE` handshake, visibility (`visible`,
  `onShow`, `onHide`) and `loop(fn, { hz })`: a `requestAnimationFrame` loop
  that pauses while a shell has the overlay hidden, throttles without drifting,
  and parks when the callback returns `false`. One message listener per
  document replaces the several each overlay used to attach.
- `sdk/acokit-theme.js` — theme loader. Resolves `?theme=<name>` (else the
  parent shell's, else a default) to `<data-themes>/<name>.css`, stamps
  `data-theme` on the root and switches live via `ACOTheme.set()` or a
  `THEME_SET` message. The kit ships no themes: which tokens exist is your
  project's decision, so point `data-themes` at your own directory.
- `test/` — the JS suite, zero dependencies, `npm test`. The browser SDK runs
  against a stub window whose clock and animation frames the test drives, so
  loop and visibility behaviour is verifiable instead of eyeballed.

**Fixed**
- `apiBase()` now inherits `?api=` from a parent orchestrator shell. Widgets
  embedded in a shell carry no query of their own, so pointing the shell at
  another machine moved its SSE while leaving every widget's REST call aimed at
  localhost.

**Notes**
- Visibility is three-state internally (shown / hidden / not-yet-told).
  Not-yet-told counts as visible for loops — a standalone overlay is visible by
  definition and no shell will ever tell it otherwise — but not as
  already-shown for `onShow`, or a one-shot widget whose first message is
  `OVERLAY_SHOW` would swallow its own cue.

## 0.1.0

First release — the generic engine, extracted from a working league overlay
system.

**Engine**
- `plugin/acokit_telemetry/` — in-game AC Python plugin reading the focused car
  (works in single-player, replay and multiplayer spectator). Bundles
  `_socket.pyd`; solves the `idna` codec issue; reconstructs the exact lap total
  per-frame so it works in replays; getattr-guarded reads.
- `server/coordinator.js` — minimal coordinator (Node stdlib only): plugin
  ingestion + static serving + SSE fan-out. No league logic.
- `sdk/acokit.js` — browser SDK: typed events, SSE/shell transport, scale
  handshake, built-in demo simulator. Fixes the `?api=host:port` scheme bug.

**Helpers (opt-in)**
- `sdk/acokit-racing.js` — `LapClock`, `LapWatcher`, `SectorTimer`, formatters.
- `sdk/acokit-content.js` — `Roster` (strict driver→identity) + `tyreLabeller`.

**Overlays & docs**
- `overlays/` — `_template`, `_orchestrator-template`, `example-speedo`,
  `example-laptracker`.
- `docs/` — `SCHEMA`, `BUILDING-OVERLAYS`, `PLUGIN`, `CONTENT-LAYER`.

Verified end-to-end: plugin endpoints → coordinator → SSE → SDK → overlays, plus
all examples in demo mode.
