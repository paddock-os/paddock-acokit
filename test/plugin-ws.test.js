/**
 * The fleet telemetry hub, over real WebSockets.
 *
 * This is the piece that turns "the director's machine feeds the coordinator"
 * into "eighteen drivers do, over the internet", so the tests are mostly about
 * the things that only matter once it IS the internet: nobody gets in without
 * a token, identity is the server's decision rather than the client's, one
 * driver cannot be knocked off the air by someone holding the same token, and
 * a car nobody is watching does not get to send at 30Hz.
 */
'use strict';

const http = require('http');
const WebSocket = require('ws');
const { suite, test, eq, ok } = require('./harness');
const { createTelemetryHub } = require('../server/plugin-ws');

const ROSTER = ['Alex Rivera', 'Nora Blake', 'Sam Castell'];
const TOKEN = 'league-secret';

/** A hub on an ephemeral port, with a typical league auth rule: token + roster. */
async function withHub(opts, fn) {
    opts = opts || {};
    const server = http.createServer();
    const hub = createTelemetryHub(Object.assign({
        server: server,
        helloTimeoutMs: opts.helloTimeoutMs || 400,
        staleMs: opts.staleMs === undefined ? 10000 : opts.staleMs,
        authenticate: (hello) => {
            if (hello.token !== TOKEN) return null;
            if (ROSTER.indexOf(hello.driver) < 0) return null;   // strict roster
            return { id: hello.driver, meta: { carId: hello.carId } };
        },
    }, opts.hub || {}));

    await new Promise(res => server.listen(0, '127.0.0.1', res));
    const port = server.address().port;
    try {
        return await fn({ hub, port, url: 'ws://127.0.0.1:' + port + '/api/plugin/ws' });
    } finally {
        await hub.close();
        await new Promise(res => server.close(res));
    }
}

/** Connect, optionally say hello, and collect what the server sends back. */
function connect(url, hello) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const received = [];
        const waiters = [];
        ws.on('message', (raw) => {
            let m; try { m = JSON.parse(String(raw)); } catch (_) { return; }
            received.push(m);
            for (let i = waiters.length - 1; i >= 0; i--) {
                if (waiters[i].match(m)) { waiters.splice(i, 1)[0].resolve(m); }
            }
        });
        ws.on('error', () => { /* close follows */ });
        ws.on('open', () => {
            if (hello) ws.send(JSON.stringify(Object.assign({ type: 'hello' }, hello)));
            resolve({
                ws: ws,
                received: received,
                send: (m) => ws.send(JSON.stringify(m)),
                /** Wait for the first message matching a predicate. */
                next: (match, ms) => new Promise((res, rej) => {
                    const hit = received.find(match);
                    if (hit) return res(hit);
                    const w = { match: match, resolve: res };
                    waiters.push(w);
                    setTimeout(() => {
                        const i = waiters.indexOf(w);
                        if (i >= 0) { waiters.splice(i, 1); rej(new Error('timed out waiting for a message')); }
                    }, ms || 1500);
                }),
                closed: new Promise(res => ws.on('close', (code) => res(code))),
                close: () => ws.close(),
            });
        });
        setTimeout(() => reject(new Error('connect timed out')), 3000);
    });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

suite('plugin-ws · admission', () => {
    test('a valid driver is welcomed', async () => {
        await withHub({}, async ({ hub, url }) => {
            const c = await connect(url, { token: TOKEN, driver: 'Nora Blake', carId: 7 });
            const w = await c.next(m => m.type === 'welcome');
            eq(w.id, 'Nora Blake');
            eq(hub.size, 1);
            eq(hub.get('Nora Blake').meta.carId, 7);
            c.close();
        });
    });

    test('a wrong token is refused', async () => {
        await withHub({}, async ({ hub, url }) => {
            const c = await connect(url, { token: 'guess', driver: 'Nora Blake' });
            const d = await c.next(m => m.type === 'denied');
            eq(d.reason, 'unauthorized');
            eq(hub.size, 0);
        });
    });

    test('a name outside the roster is refused even WITH the token', async () => {
        // The token is shared across the league, so it cannot be the only
        // check: the roster is what stops a leaked token becoming a free
        // broadcast slot for anybody.
        await withHub({}, async ({ hub, url }) => {
            const c = await connect(url, { token: TOKEN, driver: 'Some Randomer' });
            await c.next(m => m.type === 'denied');
            eq(hub.size, 0);
        });
    });

    test('telemetry sent before saying hello is ignored', async () => {
        await withHub({}, async ({ hub, url }) => {
            const c = await connect(url, null);
            c.send({ type: 't', data: { speedKmh: 300 } });
            await sleep(120);
            eq(hub.size, 0, 'no identity, no car');
        });
    });

    test('a silent connection is dropped rather than held open', async () => {
        await withHub({ helloTimeoutMs: 200 }, async ({ url }) => {
            const c = await connect(url, null);
            const d = await c.next(m => m.type === 'denied');
            eq(d.reason, 'no hello');
            const code = await c.closed;
            eq(code, 4001);
        });
    });

    test('garbage does not take the server down', async () => {
        await withHub({}, async ({ hub, url }) => {
            const c = await connect(url, null);
            c.ws.send('not json at all');
            c.ws.send(JSON.stringify([1, 2, 3]));
            c.send({ type: 'hello', token: TOKEN, driver: 'Nora Blake' });
            await c.next(m => m.type === 'welcome');
            eq(hub.size, 1);
            c.close();
        });
    });
});

suite('plugin-ws · one connection per driver', () => {
    test('a second connection for a LIVE driver is refused, not swapped', async () => {
        // Otherwise anyone with the league token could knock a driver off the
        // air simply by claiming their name.
        await withHub({}, async ({ hub, url }) => {
            const first = await connect(url, { token: TOKEN, driver: 'Alex Rivera' });
            await first.next(m => m.type === 'welcome');
            first.send({ type: 't', data: { speedKmh: 100 } });
            await sleep(50);

            const second = await connect(url, { token: TOKEN, driver: 'Alex Rivera' });
            const d = await second.next(m => m.type === 'denied');
            eq(d.reason, 'already connected');
            eq(hub.size, 1);
            ok(first.ws.readyState === first.ws.OPEN, 'the real driver stayed connected');
            first.close();
        });
    });

    test('a SILENT connection is displaced, so a crashed client can return', async () => {
        await withHub({ staleMs: 100 }, async ({ hub, url }) => {
            const ghost = await connect(url, { token: TOKEN, driver: 'Alex Rivera' });
            await ghost.next(m => m.type === 'welcome');
            await sleep(180);                       // goes quiet past staleMs

            const back = await connect(url, { token: TOKEN, driver: 'Alex Rivera' });
            await back.next(m => m.type === 'welcome');
            eq(hub.size, 1);
            const code = await ghost.closed;
            eq(code, 4010, 'the stale one was told why it was replaced');
            back.close();
        });
    });

    test('disconnecting frees the identity', async () => {
        await withHub({}, async ({ hub, url }) => {
            const c = await connect(url, { token: TOKEN, driver: 'Nora Blake' });
            await c.next(m => m.type === 'welcome');
            c.close();
            await sleep(120);
            eq(hub.size, 0);
            eq(hub.has('Nora Blake'), false);
        });
    });
});

suite('plugin-ws · traffic follows the camera', () => {
    test('an unselected client is told to idle', async () => {
        await withHub({}, async ({ url }) => {
            const c = await connect(url, { token: TOKEN, driver: 'Nora Blake' });
            const w = await c.next(m => m.type === 'welcome');
            eq(w.selected, false);
            eq(w.hz, 2, 'idle rate until somebody points a camera at you');
            c.close();
        });
    });

    test('selecting a car raises ITS rate and lowers the previous one', async () => {
        await withHub({}, async ({ hub, url }) => {
            const a = await connect(url, { token: TOKEN, driver: 'Alex Rivera' });
            const b = await connect(url, { token: TOKEN, driver: 'Nora Blake' });
            await a.next(m => m.type === 'welcome');
            await b.next(m => m.type === 'welcome');

            hub.select('Alex Rivera');
            const up = await a.next(m => m.type === 'rate');
            eq(up.hz, 30);
            eq(up.selected, true);

            hub.select('Nora Blake');
            const down = await a.next(m => m.type === 'rate' && m.selected === false);
            eq(down.hz, 2, 'the car that left the camera goes quiet again');
            const bUp = await b.next(m => m.type === 'rate' && m.selected === true);
            eq(bUp.hz, 30);

            a.close(); b.close();
        });
    });

    test('a driver who connects while already selected starts at full rate', async () => {
        await withHub({}, async ({ hub, url }) => {
            const a = await connect(url, { token: TOKEN, driver: 'Alex Rivera' });
            await a.next(m => m.type === 'welcome');
            hub.select('Alex Rivera');
            await a.next(m => m.type === 'rate');
            a.close();
            await sleep(120);

            const again = await connect(url, { token: TOKEN, driver: 'Alex Rivera' });
            const w = await again.next(m => m.type === 'welcome');
            eq(w.selected, true, 'the camera did not move just because they reconnected');
            eq(w.hz, 30);
            again.close();
        });
    });

    test('selecting somebody who is not connected does not blank the camera', async () => {
        await withHub({}, async ({ hub, url }) => {
            const a = await connect(url, { token: TOKEN, driver: 'Alex Rivera' });
            await a.next(m => m.type === 'welcome');
            hub.select('Alex Rivera');
            hub.select('Sam Castell');           // never connected
            eq(hub.selected, 'Alex Rivera', 'kept the working feed');
            a.close();
        });
    });

    test('select(null) clears it', async () => {
        await withHub({}, async ({ hub, url }) => {
            const a = await connect(url, { token: TOKEN, driver: 'Alex Rivera' });
            await a.next(m => m.type === 'welcome');
            hub.select('Alex Rivera');
            hub.select(null);
            eq(hub.selected, null);
            a.close();
        });
    });
});

suite('plugin-ws · data', () => {
    test('telemetry and state are kept per driver, not in one slot', async () => {
        // The whole reason this module exists: the HTTP ingest had a single
        // slot, so eighteen drivers would have overwritten each other.
        await withHub({}, async ({ hub, url }) => {
            const a = await connect(url, { token: TOKEN, driver: 'Alex Rivera' });
            const b = await connect(url, { token: TOKEN, driver: 'Nora Blake' });
            await a.next(m => m.type === 'welcome');
            await b.next(m => m.type === 'welcome');

            a.send({ type: 't', data: { speedKmh: 210 } });
            b.send({ type: 't', data: { speedKmh: 95 } });
            a.send({ type: 's', data: { currentTire: 'C3' } });
            await sleep(120);

            eq(hub.get('Alex Rivera').telemetry.speedKmh, 210);
            eq(hub.get('Nora Blake').telemetry.speedKmh, 95);
            eq(hub.get('Alex Rivera').state.currentTire, 'C3');
            a.close(); b.close();
        });
    });

    test('events carry the identity and whether that car is on camera', async () => {
        await withHub({}, async ({ hub, url }) => {
            const seen = [];
            hub.on('telemetry', d => seen.push(d));
            const a = await connect(url, { token: TOKEN, driver: 'Alex Rivera' });
            await a.next(m => m.type === 'welcome');
            hub.select('Alex Rivera');
            a.send({ type: 't', data: { speedKmh: 1 } });
            await sleep(120);
            eq(seen.length, 1);
            eq(seen[0].id, 'Alex Rivera');
            eq(seen[0].selected, true);
            a.close();
        });
    });

    test('the snapshot tells the operator who is live and how fresh', async () => {
        await withHub({}, async ({ hub, url }) => {
            const a = await connect(url, { token: TOKEN, driver: 'Alex Rivera', carId: 3 });
            await a.next(m => m.type === 'welcome');
            a.send({ type: 't', data: { speedKmh: 50 } });
            await sleep(120);
            const snap = hub.snapshot();
            eq(snap.cars.length, 1);
            eq(snap.cars[0].id, 'Alex Rivera');
            eq(snap.cars[0].meta.carId, 3);
            ok(snap.cars[0].telemetryAgeMs !== null && snap.cars[0].telemetryAgeMs < 2000);
            a.close();
        });
    });

    test('connect and disconnect are observable', async () => {
        await withHub({}, async ({ hub, url }) => {
            const events = [];
            hub.on('connect', d => events.push('connect:' + d.id));
            hub.on('disconnect', d => events.push('disconnect:' + d.id));
            const a = await connect(url, { token: TOKEN, driver: 'Nora Blake' });
            await a.next(m => m.type === 'welcome');
            a.close();
            await sleep(150);
            eq(events, ['connect:Nora Blake', 'disconnect:Nora Blake']);
        });
    });

    test('a rejected attempt is observable too, for the log', async () => {
        await withHub({}, async ({ hub, url }) => {
            const seen = [];
            hub.on('rejected', d => seen.push(d.reason));
            const c = await connect(url, { token: 'nope', driver: 'Nora Blake' });
            await c.next(m => m.type === 'denied');
            eq(seen, ['unauthorized']);
        });
    });
});
