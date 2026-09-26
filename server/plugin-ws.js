/**
 * acokit/server/plugin-ws — telemetry ingest for a FLEET of sim clients
 * =====================================================================
 * The HTTP ingest (`POST /api/plugin/telemetry`) assumes one sender on
 * loopback: one car, no identity, no auth. That holds for a director
 * spectating on the same machine as the coordinator, and stops holding the
 * moment every driver in a league sends their own car over the internet.
 *
 * This is the other shape: one persistent WebSocket per client, each
 * authenticated, each keyed by an identity the SERVER decides — not the
 * client — and each told how fast to send.
 *
 *   const hub = createTelemetryHub({
 *       server,                       // your http.Server
 *       path: '/api/plugin/ws',
 *       authenticate: (hello) => {    // return null to refuse
 *           if (hello.token !== TOKEN) return null;
 *           return roster.has(hello.driver) ? { id: hello.driver, meta: {} } : null;
 *       },
 *   });
 *   hub.on('telemetry', ({ id, payload }) => …);
 *   hub.select('Alex Rivera');      // whoever is on camera
 *
 * RATE CONTROL is why `select` lives here. Eighteen cars at 30Hz is 540
 * messages a second to render one car's worth of pixels. The hub tells the
 * selected client to send at full rate and everyone else to idle, so traffic
 * follows the camera instead of the size of the grid.
 *
 * Needs the `ws` package — the kit's one optional dependency. The minimal
 * coordinator does not load this module, so only install `ws` if you use it.
 */
'use strict';

const { WebSocketServer } = require('ws');

const DEFAULTS = {
    path: '/api/plugin/ws',
    helloTimeoutMs: 5000,     // say who you are, promptly
    heartbeatMs: 10000,       // ping; a missed reply and you are gone
    fullHz: 30,
    idleHz: 2,
    staleMs: 10000,           // a silent connection may be displaced
};

function createTelemetryHub(opts) {
    const cfg = Object.assign({}, DEFAULTS, opts || {});
    if (!cfg.server) throw new Error('createTelemetryHub needs { server }');
    if (typeof cfg.authenticate !== 'function') throw new Error('createTelemetryHub needs { authenticate }');

    const cars = new Map();     // id -> { id, meta, telemetry, state, lastTelemetryAt, lastStateAt, since, ws }
    const listeners = {};
    let selectedId = null;

    const emit = (type, detail) => {
        for (const fn of (listeners[type] || [])) {
            try { fn(detail); } catch (e) { console.error('[plugin-ws] listener for ' + type + ' threw', e); }
        }
    };

    const send = (ws, msg) => {
        if (!ws || ws.readyState !== ws.OPEN) return;
        try { ws.send(JSON.stringify(msg)); } catch (_) {}
    };

    /** Tell one client how fast to send: full rate only when it is on camera. */
    function pushRate(car) {
        const selected = car.id === selectedId;
        send(car.ws, { type: 'rate', hz: selected ? cfg.fullHz : cfg.idleHz, selected: selected });
    }

    const wss = new WebSocketServer({ server: cfg.server, path: cfg.path });

    wss.on('connection', (ws, req) => {
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });

        let car = null;
        const remote = (req && req.socket && req.socket.remoteAddress) || '?';

        // Nothing is accepted until the client says who it is. An
        // unauthenticated socket that just sits there is a resource leak, so
        // it gets a deadline.
        const helloTimer = setTimeout(() => {
            if (!car) {
                send(ws, { type: 'denied', reason: 'no hello' });
                try { ws.close(4001, 'no hello'); } catch (_) {}
            }
        }, cfg.helloTimeoutMs);

        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(String(raw)); } catch (_) { return; }
            if (!msg || typeof msg !== 'object') return;

            if (!car) {
                if (msg.type !== 'hello') return;      // nothing else counts before hello
                let auth = null;
                try { auth = cfg.authenticate(msg, { remote: remote }); } catch (_) { auth = null; }
                if (!auth || !auth.id) {
                    clearTimeout(helloTimer);
                    send(ws, { type: 'denied', reason: 'unauthorized' });
                    try { ws.close(4003, 'unauthorized'); } catch (_) {}
                    emit('rejected', { remote: remote, hello: msg, reason: 'unauthorized' });
                    return;
                }

                // One connection per identity. A LIVE one is not displaced —
                // otherwise anyone holding the token could kick a real driver
                // off the air. A silent one is: a client whose PC crashed must
                // be able to come back without waiting out a TCP timeout.
                const existing = cars.get(auth.id);
                if (existing && existing.ws && existing.ws.readyState === existing.ws.OPEN) {
                    const lastHeard = Math.max(existing.lastTelemetryAt, existing.lastStateAt, existing.since);
                    if (Date.now() - lastHeard < cfg.staleMs) {
                        clearTimeout(helloTimer);
                        send(ws, { type: 'denied', reason: 'already connected' });
                        try { ws.close(4009, 'already connected'); } catch (_) {}
                        emit('rejected', { remote: remote, hello: msg, reason: 'duplicate' });
                        return;
                    }
                    send(existing.ws, { type: 'denied', reason: 'replaced by a newer connection' });
                    try { existing.ws.close(4010, 'replaced'); } catch (_) {}
                }

                clearTimeout(helloTimer);
                car = {
                    id: auth.id,
                    meta: auth.meta || {},
                    telemetry: null,
                    state: null,
                    lastTelemetryAt: 0,
                    lastStateAt: 0,
                    since: Date.now(),
                    ws: ws,
                };
                cars.set(car.id, car);
                const selected = car.id === selectedId;
                send(ws, { type: 'welcome', id: car.id, hz: selected ? cfg.fullHz : cfg.idleHz, selected: selected });
                emit('connect', { id: car.id, meta: car.meta, remote: remote });
                return;
            }

            if (msg.type === 't') {
                car.telemetry = msg.data || null;
                car.lastTelemetryAt = Date.now();
                emit('telemetry', { id: car.id, payload: car.telemetry, selected: car.id === selectedId });
            } else if (msg.type === 's') {
                car.state = msg.data || null;
                car.lastStateAt = Date.now();
                emit('state', { id: car.id, payload: car.state, selected: car.id === selectedId });
            }
        });

        ws.on('close', () => {
            clearTimeout(helloTimer);
            if (car && cars.get(car.id) === car) {
                cars.delete(car.id);
                emit('disconnect', { id: car.id, meta: car.meta });
            }
        });
        ws.on('error', () => { /* a close event follows */ });
    });

    // A half-open TCP connection looks alive for ever; ping so a client that
    // vanished frees its identity for the reconnect.
    const heartbeat = setInterval(() => {
        for (const ws of wss.clients) {
            if (ws.isAlive === false) { try { ws.terminate(); } catch (_) {} continue; }
            ws.isAlive = false;
            try { ws.ping(); } catch (_) {}
        }
    }, cfg.heartbeatMs);
    if (heartbeat.unref) heartbeat.unref();

    return {
        /** Subscribe: connect | disconnect | telemetry | state | select | rejected. */
        on(type, fn) {
            (listeners[type] || (listeners[type] = [])).push(fn);
            return function off() {
                const l = listeners[type] || [];
                const i = l.indexOf(fn);
                if (i >= 0) l.splice(i, 1);
            };
        },

        /** Put one car on camera (null = nobody). Rates follow immediately. */
        select(id) {
            const next = (id === null || id === undefined) ? null : (cars.has(id) ? id : selectedId);
            if (next === selectedId) return selectedId;
            const previous = selectedId;
            selectedId = next;
            if (previous && cars.has(previous)) pushRate(cars.get(previous));
            if (selectedId && cars.has(selectedId)) pushRate(cars.get(selectedId));
            emit('select', { id: selectedId, previous: previous });
            return selectedId;
        },

        get selected() { return selectedId; },
        get(id) { return cars.get(id) || null; },
        has(id) { return cars.has(id); },
        get size() { return cars.size; },

        /** Who is connected and how fresh each one is — for the operator UI. */
        snapshot() {
            const now = Date.now();
            return {
                selected: selectedId,
                cars: [...cars.values()].map(function (c) {
                    return {
                        id: c.id,
                        meta: c.meta,
                        selected: c.id === selectedId,
                        telemetryAgeMs: c.lastTelemetryAt ? now - c.lastTelemetryAt : null,
                        stateAgeMs: c.lastStateAt ? now - c.lastStateAt : null,
                        connectedForMs: now - c.since,
                    };
                }),
            };
        },

        close() {
            clearInterval(heartbeat);
            for (const ws of wss.clients) { try { ws.close(1001, 'server closing'); } catch (_) {} }
            return new Promise(function (res) { wss.close(res); });
        },
    };
}

module.exports = { createTelemetryHub };
