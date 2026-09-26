# Building overlays with acokit

An overlay is just a transparent HTML page that loads `sdk/acokit.js`, subscribes
to events, and renders. Below are the patterns the SDK supports.

## 1. Minimal overlay

```html
<script src="../sdk/acokit.js"></script>
<script>
  const kit = new ACOKit();
  kit.on('telemetry', t => { /* t.speedKmh, t.gear, t.rpm, ... */ });
  kit.on('state',     s => { /* s.spectatedDriver, s.currentTire, ... */ });
</script>
```

`new ACOKit()` auto-detects the transport:
- standalone page → SSE to the coordinator,
- inside an orchestrator shell → `postMessage`,
- `?demo=1` → built-in lap simulator.

## 2. The overlay lifecycle

Everything an overlay needs that is *not* data — URL params, the scale
handshake, visibility, and a render loop that behaves — comes from one object:

```html
<script src="../sdk/acokit.js"></script>
<script src="../sdk/acokit-overlay.js"></script>
<script>
  const overlay = ACOverlay.init('my_overlay', { scaleVar: '--scale' });

  overlay.onShow(() => intro.play());     // fires when the shell reveals you
  overlay.onHide(() => intro.reset());
  overlay.loop(() => drawClock(), { hz: 10 });
</script>
```

**Scale.** Author at a fixed internal size and let the lifecycle scale it:

```css
:root { --scale: 1; }
#root { transform: scale(var(--scale)); transform-origin: top left; }
```

Standalone, `?scale=1.5` in the OBS Browser Source URL applies it. Inside a
shell, declaring `scaleVar` announces `SCALE_CAPABLE`, which makes the shell
drop its own `transform: scale()` on your iframe and push a number instead —
type stays hinted, borders stay 1px. (`ACOKit.setupScale()` is the same
handshake if you want it without the rest of the lifecycle.)

**Visibility.** A shell fades iframes out; it does not unload them. So:

- `overlay.visible` — can your pixels reach a viewer right now.
- `onShow` / `onHide` — fire on the transition. **A one-shot intro belongs in
  `onShow`, never at load**: inside a shell your iframe loads when OBS starts,
  which can be hours before anyone sees it.
- Standalone pages count as visible and never fire either callback, because no
  shell will ever tell them anything.

**Loops.** `overlay.loop(fn, { hz })` is a `requestAnimationFrame` loop that
pauses while the overlay is hidden and resumes on show — a widget nobody is
looking at should not cost a frame. `hz` throttles the callback while staying
in step with the compositor. Return `false` from `fn` to park the loop when
there is nothing new to draw, and call `handle.start()` when there is:

```js
const l = overlay.loop(() => { render(); return Date.now() - lastData < 1200; });
onData(() => l.start());
```

## 3. Demo mode (build without AC)

`?demo=1` runs a lap simulator that emits realistic `telemetry`/`state`. Use it
to build and style overlays with nothing running. Add a richer simulator by
forking `startDemo()` in `sdk/acokit.js`.

## 4. Orchestrator shells (one connection, many overlays)

For a full broadcast you usually want several overlays sharing ONE coordinator
connection. A shell page holds the `EventSource` and forwards every event to
embedded `<iframe>`s via `postMessage`:

```js
const es = new EventSource(API_BASE + '/api/events');
es.onmessage = e => {
  const msg = JSON.parse(e.data);
  for (const f of iframes) f.contentWindow.postMessage(msg, '*');
};
// replay the last SYNC to late-joining iframes that post SHELL_OVERLAY_READY
```

Each child overlay needs no changes — `new ACOKit()` detects it's in a shell
(`window.parent !== window`) and listens to `postMessage` instead of opening
its own SSE. Cache the last `SYNC` and replay it when a child sends
`SHELL_OVERLAY_READY`.

Start from `overlays/_orchestrator-template.html` rather than the snippet
above: it already handles the parts that are easy to get wrong.

**The shell also owns visibility.** Fading an iframe out does not stop it —
a hidden iframe keeps running — so the shell tells the child, and `ACOverlay`
does the rest (pausing loops, firing `onHide`):

```js
show('laptracker');        // → OVERLAY_SHOW to that widget
hide('speedo');            // → OVERLAY_HIDE
flash('fastest_lap', 8000); // show, then hide again
```

Three rules the template encodes, each learned the hard way:

1. **Send the initial state, even when it is "hidden".** A widget that starts
   off screen must still be told, or it runs its loops for the whole broadcast
   behind an invisible iframe. Track visibility as *unknown → shown/hidden*,
   not as a boolean starting at `false`.
2. **Replay the current state to late joiners.** A child announces
   `SHELL_OVERLAY_READY` when it is ready; that can arrive after you already
   sent its visibility. Send it again — in whichever direction is current. A
   missed `OVERLAY_SHOW` means a one-shot widget never performs at all.
3. **Answer `SCALE_CAPABLE` with `SET_SCALE`.** A child that scales itself
   (`ACOverlay.init(id, { scaleVar })`) says so; push it a number instead of
   CSS-scaling its iframe, and its type stays hinted and its borders 1px.

## 5. Point an overlay at another machine

`?api=192.168.1.50:3001` — the SDK adds the scheme for you. (A bare host is not
a valid `EventSource` URL; the SDK handles that.) Set it on a **shell** and the
embedded widgets inherit it, so one parameter moves the whole broadcast.

## 5b. Theming

The kit ships no themes — which colours exist and what they mean is your
project's decision, not the engine's. What it ships is the mechanism:

```html
<script src="../sdk/acokit-theme.js" data-themes="../../themes"></script>
```

`?theme=<name>` loads `<data-themes>/<name>.css` and stamps `data-theme` on
`<html>`. Embedded widgets inherit the shell's theme; `data-themes` is resolved
against the SCRIPT's URL, so one value is right for every page however deep.
Only `[a-z0-9-]` names are accepted — the value comes off a URL — and a
stylesheet that 404s falls back to the default rather than leaving a
half-applied look.

Switch live without reloading:

```js
ACOTheme.set('classic');   // in one overlay
setTheme('classic');       // in a shell: fans THEME_SET out to every widget
```

Write your overlay so a missing theme degrades instead of breaking: map local
variables onto tokens **with the current value as the fallback**.

```css
:root { --accent: var(--c-accent, #16c64a); }
```

## 6. Working with replays (the gotchas)

AC does not record some live-only values in replays. In a replay these read
**0**: `lastLapMs`, `bestLapMs`, `lapCount`, `drs`. What still works:
`speedKmh`, `gear`, `rpm`, `throttle`, `brake`, `splinePosition`, `lapTimeMs`,
and `completedLapMs` + `lapEvent` (the plugin reconstructs the exact lap total
from the live lap clock, frame-accurately).

Practical recipes for replay clips:

- **Exact lap total** — don't use `lastLapMs` (it's 0). Watch `lapEvent` change
  and read `completedLapMs`, or detect the `lapTimeMs` reset yourself.
- **Hardcode what AC can't give you.** For a known pole-lap onboard, bake in the
  tyre compound and the real sector splits (AC exposes neither for the spectated
  car in replay) and drive them off the live `lapTimeMs`:

  ```js
  const SECTORS_MS = [23643, 37435, 24475];          // real splits, from URL or const
  const CUM = [SECTORS_MS[0], SECTORS_MS[0]+SECTORS_MS[1], 0];
  kit.on('telemetry', t => {
    if (t.lapTimeMs >= CUM[0]) lightSector(0);        // sectors fire on the clock
    if (t.lapTimeMs >= CUM[1]) lightSector(1);
  });
  ```

- **"Arm on the start line."** Keep the overlay hidden after a reload until the
  car crosses the line (`lapTimeMs` resets from a big value to ~0), then reveal
  it and start counting from zero. Lets a director park the replay before the
  lap, reload, and have the overlay appear exactly on the line.

- **Smooth the clock.** Telemetry is ~20–30 Hz, which looks steppy. Interpolate
  with `requestAnimationFrame` between packets (`shown = last + rate*(now-anchor)`),
  estimating `rate` from consecutive packets so it tracks slow-motion playback.

## 7. Live-only: DRS

`t.drs > 0.5` means DRS is open. It is **0 in replays** (AC doesn't record modded
DRS) but reflects the real state live. `t.drsAvail` tells you whether the AC
build even exposes `acsys.CS.DRS`.
