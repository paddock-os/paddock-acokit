# Fleet mode: every driver sends their own car

The default setup is one AC on one machine — the director's — spectating and
posting the focused car to a coordinator on the same machine. Fleet mode is the
other shape: **every driver's AC connects to the league's coordinator over one
WebSocket and sends their own car**. The operator picks who is on camera, and
the director no longer needs AC open at all.

```
  driver 1's AC ──┐
  driver 2's AC ──┤  WebSocket      ┌─────────────┐   SSE    ┌──────────┐
  …               ├────────────────►│ coordinator ├─────────►│ overlays │
  driver 18's AC ─┘  /api/plugin/ws └─────────────┘          └──────────┘
                                          ▲
                                   the operator picks
                                   who is on camera
```

**Only the car on camera sends at 30 Hz.** The server tells each plugin how
fast to send: full rate for the selected car, 2 Hz for everybody else. Cutting
between cars costs the same with six drivers as with twenty.

## Server side

`server/plugin-ws.js` is a hub you mount on your own `http.Server`. It needs the
`ws` package, which is why the minimal coordinator does not load it:

```bash
npm install ws
```

```js
const http = require('http');
const { createTelemetryHub } = require('./plugin-ws');   // from a coordinator in server/

const server = http.createServer(/* your coordinator */);
const hub = createTelemetryHub({
    server,
    path: '/api/plugin/ws',
    // Return null to refuse. Return { id, meta } to admit: the id is decided
    // HERE, by the server, not taken from the client.
    authenticate: (hello) => {
        if (hello.token !== process.env.PLUGIN_TOKEN) return null;
        return roster.has(hello.driver) ? { id: hello.driver, meta: { carId: hello.carId } } : null;
    },
});

hub.on('telemetry', ({ id, payload, selected }) => {
    if (selected) broadcast({ EventType: 'TELEMETRY', Message: payload });
});
hub.on('state', ({ id, payload, selected }) => {
    if (selected) broadcast({ EventType: 'PLUGIN_STATE', Message: payload });
});

hub.select('Alex Rivera');   // put a car on camera; rates follow immediately
hub.snapshot();              // who is connected, and how fresh each one is
```

Events: `connect`, `disconnect`, `telemetry`, `state`, `select`, `rejected`.
Options with their defaults: `helloTimeoutMs: 5000`, `heartbeatMs: 10000`,
`fullHz: 30`, `idleHz: 2`, `staleMs: 10000`.

What the hub enforces, whatever `authenticate` does:

- **Nothing counts before `hello`.** A socket that does not introduce itself
  within `helloTimeoutMs` is closed (4001).
- **One connection per identity.** While a driver is connected *and sending*, a
  second connection with their identity is refused (4009) — so nobody holding
  the token can knock a real driver off the air. A connection that has gone
  silent for `staleMs` is replaced (4010), so a driver whose PC crashed can
  come straight back.
- **Half-open connections are reaped** by a ping every `heartbeatMs`.

### The wire protocol

| Direction | Message |
|---|---|
| plugin → hub | `{type:'hello', token, driver, carId, pluginVersion}` |
| plugin → hub | `{type:'t', data:<telemetry>}` and `{type:'s', data:<state>}` — the payloads in `SCHEMA.md` |
| hub → plugin | `{type:'welcome', id, hz, selected}` |
| hub → plugin | `{type:'rate', hz, selected}` — send at this rate from now on |
| hub → plugin | `{type:'denied', reason}`, then a close |

## What each driver installs

1. Copy `plugin/acokit_telemetry/` into `<AC>/apps/python/` (see `PLUGIN.md`).
2. Fill in three constants near the top of `acokit_telemetry.py`:

   ```python
   FLEET_URL   = "ws://overlays.example.com/api/plugin/ws"
   FLEET_TOKEN = "the-league-token"
   FLEET_MODE  = "driver"      # "driver" = my car;  "director" = the focused one
   ```

3. In AC: **Settings → General → UI Modules**, enable `acokit_telemetry`.
4. Check AC's console (Page Up):

   ```
   [acokit] fleet mode: connecting to ws://…
   [acokit] fleet link open to …
   [acokit] fleet: accepted as <name> at 2.0Hz
   ```

With `FLEET_URL` or `FLEET_TOKEN` empty the plugin stays in the local HTTP mode.
In `driver` mode it sends the car this machine is driving (`playerCarID` from
AC's graphics page), not whatever the camera happens to be on.

## Identity: what it protects and what it does not

AC's Python API exposes no Steam ID, so the only identity available from inside
the game is **the name AC reports**. Check it against a roster in
`authenticate`, as in the example above.

That guarantees:

- without the token, nobody gets in;
- with the token, you can only send as somebody on the roster;
- one connection per name, and a live driver cannot be displaced.

It does not guarantee that a leaked token cannot be used to take the slot of a
driver who is **not** connected. Rotate the token between seasons and hand it
out privately, not in a public channel.

## `ws://`, not `wss://`

The plugin speaks unencrypted `ws://` and refuses `wss://` with a message in the
console. TLS by hand on a non-blocking socket inside AC's Python 3.3.5 — driving
`do_handshake()` through retries, with no usable certificate store — is a lot of
fragile code running on the render thread of other people's PCs. Not having it
is better than having it wrong.

The consequence: **the token travels in clear**, and anyone who can observe a
driver's network can read it. Given what the token allows — sending telemetry
as somebody on the roster — that is a proportionate risk, but you should know
it. The way to encrypt is a local relay on the driver's PC that accepts
`ws://127.0.0.1` and speaks `wss://` outwards; acokit does not ship one.

## When something fails

| In AC's console | What is happening |
|---|---|
| `fleet refused: unauthorized` | Wrong token, or the name AC reports is not on your roster |
| `fleet refused: already connected` | That driver already has a live connection |
| Nothing at all | `FLEET_URL` or `FLEET_TOKEN` is empty: still in local HTTP mode |
| `wss:// is not supported` | Change the URL to `ws://` |
| `fleet mode needs struct/mmap` | This AC build's Python lacks them; fleet mode cannot run |
