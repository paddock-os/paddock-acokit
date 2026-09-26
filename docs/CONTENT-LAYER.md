# The content layer (build a branded league overlay)

acokit's engine is deliberately **content-agnostic** — it delivers AC telemetry
and nothing else. Your league's identity (who's driving, team colours, logos,
tyre rules, points) lives in a thin **content layer** on top. This keeps the
engine reusable and your branding swappable.

```
  ENGINE (generic, never edited per-league)        CONTENT (yours)
  ────────────────────────────────────────         ─────────────────────────
  plugin/acokit_telemetry   → focused-car data      content/drivers.json   roster
  server/coordinator.js     → transport + SSE        image/...              logos
  sdk/acokit.js             → events + transport     overlays/*.html        your branded overlays
  sdk/acokit-racing.js      → lap/sector/clock       (points/standings rules, if any)
  sdk/acokit-content.js     → roster + tyre mapping
```

## 1. A roster (driver → identity)

The engine gives you `state.spectatedDriver` (a name). Map it to identity with
an opt-in roster file. Copy `content/drivers.sample.json` → `content/drivers.json`:

```json
{ "drivers": { "Lena Vogt": { "team": "Northline Racing", "number": "1",
                                   "color": "#1e41ff", "logo": "image/northline.png" } } }
```

```html
<script src="../sdk/acokit.js"></script>
<script src="../sdk/acokit-content.js"></script>
<script>
  const kit = new ACOKit();
  let roster = null;
  ACOKitContent.loadRoster('../content/drivers.json').then(r => roster = r);

  kit.on('state', s => {
    const m = roster && roster.meta(s.spectatedDriver);   // null for unknown names
    if (!m) return;                                        // strict: skip unknowns
    nameEl.textContent  = s.spectatedDriver;
    numEl.textContent   = m.number;
    numEl.style.color   = m.color;
    logoEl.src          = m.logo;
  });
</script>
```

`roster.meta()` is **strict** — it returns `null` for names not in your grid, so
pseudo-entries (Safety Car, spectators) are skipped instead of rendering junk.
`roster.index()` gives a stable sort order if you build a timing tower.

## 2. Tyre compounds are league/mod-specific

AC reports a raw compound name (`"C5"`, `"Soft"`, …) and the meaning is **not**
universal — one mod's `C5` is another's Medium. Build a mapper for YOUR mod:

```js
const tyreLabel = ACOKitContent.tyreLabeller({ C2: 'H', C3: 'M', C4: 'S', C5: 'S' });
tyreLabel(state.currentTire);    // → 'H' | 'M' | 'S' | 'SS' | 'I' | 'W'
```

(In replays AC misreports the spectated car's compound anyway — for replay clips,
hardcode it, e.g. `?tyre=M`. See `BUILDING-OVERLAYS.md` §6.)

## 3. Points / standings / championship

These are pure league rules and the engine has no opinion. Keep them in your
content layer: a JSON of results + a small module that computes standings, or a
custom coordinator endpoint you add to `server/coordinator.js` (it's built to be
forked). The engine's only job is to *broadcast* whatever you compute — e.g.:

```js
// in your forked coordinator, after computing standings:
broadcast({ EventType: 'STANDINGS', Message: standings });
// in an overlay:
kit.on('raw', e => { if (e.EventType === 'STANDINGS') render(e.Message); });
```

## How far it goes

The league system this kit was extracted from is a full content layer on the
same engine: a strict `drivers.json`, team logos, a points table, championship
sync, and a dozen branded overlays (a timing tower with a "smart director", a
track map, a pit tracker, a penalty banner, …). None of that needed a change to
the engine — which is the test of whether the seam is in the right place.
