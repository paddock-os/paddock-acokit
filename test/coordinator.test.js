/**
 * The engine coordinator, end to end over a real socket.
 *
 * This one is not unit-testable in a stub: its whole job is HTTP. So the suite
 * boots it as a child process on an ephemeral port, talks to it, and kills it.
 * Still no dependencies — Node's own http client.
 *
 * What matters here is the stuff a fork will lean on without reading: that the
 * static server refuses to walk out of its root, that the plugin endpoints stay
 * open while the mutating one does not, and that an SSE client gets a snapshot
 * the moment it connects.
 */
'use strict';

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { suite, test, eq, ok } = require('./harness');

const COORD = path.join(__dirname, '..', 'server', 'coordinator.js');
const PORT = 34117;                    // unlikely to collide with a dev box
const BASE = `http://127.0.0.1:${PORT}`;

/** Boot a coordinator, run fn, then always kill it. */
async function withServer(env, fn) {
    const child = spawn(process.execPath, [COORD], {
        env: { ...process.env, PORT: String(PORT), HTTP_BIND: '127.0.0.1', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
        await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('coordinator did not start')), 8000);
            child.stdout.on('data', (d) => {
                if (String(d).includes('listening') || String(d).includes(String(PORT))) { clearTimeout(t); resolve(); }
            });
            child.on('exit', (code) => { clearTimeout(t); reject(new Error('exited ' + code)); });
        });
        return await fn();
    } finally {
        child.kill();
    }
}

function request(method, urlPath, { body, headers } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(BASE + urlPath, { method, headers }, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

/** Open the SSE stream and resolve with the first `n` events. */
function sse(n, trigger) {
    return new Promise((resolve, reject) => {
        const events = [];
        const req = http.get(BASE + '/api/events', (res) => {
            let buf = '';
            res.on('data', (c) => {
                buf += c;
                let i;
                while ((i = buf.indexOf('\n\n')) >= 0) {
                    const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
                    const m = chunk.match(/^data: (.*)$/m);
                    if (!m) continue;
                    try { events.push(JSON.parse(m[1])); } catch (_) {}
                    if (events.length >= n) { req.destroy(); resolve(events); }
                }
            });
            if (trigger) setTimeout(trigger, 50);
        });
        req.on('error', (e) => { if (events.length >= n) return; reject(e); });
        setTimeout(() => { req.destroy(); resolve(events); }, 5000);
    });
}

suite('coordinator · plugin ingestion', () => {
    test('telemetry is accepted, stored and broadcast', async () => {
        await withServer({}, async () => {
            const events = await sse(2, () =>
                request('POST', '/api/plugin/telemetry', { body: { speedKmh: 231 }, headers: { 'Content-Type': 'application/json' } }));
            eq(events[0].EventType, 'SYNC', 'a client gets the snapshot on connect');
            eq(events[1].EventType, 'TELEMETRY');
            eq(events[1].Message.speedKmh, 231);
            const live = JSON.parse((await request('GET', '/api/live')).body);
            eq(live.telemetry.speedKmh, 231, '/api/live reflects it too');
        });
    });

    test('director state rides the same path', async () => {
        await withServer({}, async () => {
            const events = await sse(2, () =>
                request('POST', '/api/plugin/state', { body: { spectatedDriver: 'Rivera' } }));
            eq(events[1].EventType, 'PLUGIN_STATE');
            eq(events[1].Message.spectatedDriver, 'Rivera');
        });
    });

    test('the snapshot carries what arrived before you connected', async () => {
        await withServer({}, async () => {
            await request('POST', '/api/plugin/telemetry', { body: { speedKmh: 99 } });
            const [snapshot] = await sse(1);
            eq(snapshot.EventType, 'SYNC');
            eq(snapshot.Message.plugin.telemetry.speedKmh, 99);
        });
    });
});

suite('coordinator · auth', () => {
    test('with no token set, the guarded endpoint is open', async () => {
        await withServer({}, async () => {
            const res = await request('POST', '/api/broadcast', { body: { EventType: 'X' } });
            eq(res.status, 200);
        });
    });

    test('with a token set, the guarded endpoint refuses without it', async () => {
        await withServer({ ADMIN_TOKEN: 's3cret' }, async () => {
            eq((await request('POST', '/api/broadcast', { body: { EventType: 'X' } })).status, 401);
            eq((await request('POST', '/api/broadcast', { body: { EventType: 'X' }, headers: { 'X-Admin-Token': 'wrong' } })).status, 401);
            eq((await request('POST', '/api/broadcast', { body: { EventType: 'X' }, headers: { 'X-Admin-Token': 's3cret' } })).status, 200);
        });
    });

    test('the plugin endpoints stay open even with a token — AC cannot send headers', async () => {
        await withServer({ ADMIN_TOKEN: 's3cret' }, async () => {
            eq((await request('POST', '/api/plugin/telemetry', { body: { speedKmh: 1 } })).status, 200);
        });
    });
});

suite('coordinator · static files', () => {
    test('serves a file from the root', async () => {
        await withServer({}, async () => {
            const res = await request('GET', '/sdk/acokit.js');
            eq(res.status, 200);
            ok(res.headers['content-type'].includes('javascript'), res.headers['content-type']);
            ok(res.body.includes('ACOKit'), 'looks like the SDK');
        });
    });

    test('an ENCODED traversal is refused', async () => {
        // This is the form the guard in serveStatic actually exists for.
        // A plain "/../x" never reaches it: `new URL()` normalises the path
        // away before the handler runs, so it resolves inside the root and is
        // served legitimately. Percent-encoding survives that normalisation
        // and only turns back into ".." at decodeURIComponent — which is why
        // the root check has to happen AFTER the decode, and why removing it
        // would be a real hole rather than a redundant line.
        await withServer({}, async () => {
            for (const attempt of ['/..%2f..%2fpackage.json', '/sdk%2f..%2f..%2fpackage.json', '/%2e%2e%2f%2e%2e%2fREADME.md']) {
                const res = await request('GET', attempt);
                eq(res.status, 403, `${attempt} should be forbidden`);
            }
        });
    });

    test('nothing outside the root is ever served, however it is spelled', async () => {
        // The repo-root package.json is the canary: it sits one level above
        // ROOT and, unlike acokit's own, it has a "dependencies" key.
        await withServer({}, async () => {
            for (const attempt of ['/../package.json', '/..%2fpackage.json', '/sdk/../../package.json', '/../../etc/passwd']) {
                const res = await request('GET', attempt);
                ok(!res.body.includes('"dependencies"'), `${attempt} leaked a file from outside the root`);
                ok(!res.body.includes('root:x:'), `${attempt} leaked /etc/passwd`);
            }
        });
    });

    test('unknown paths are 404, not a stack trace', async () => {
        await withServer({}, async () => {
            const res = await request('GET', '/nope/nothing-here.js');
            eq(res.status, 404);
        });
    });

    test('a non-GET on an unknown path is 404', async () => {
        await withServer({}, async () => {
            eq((await request('DELETE', '/whatever')).status, 404);
        });
    });
});
