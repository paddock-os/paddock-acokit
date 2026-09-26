/**
 * The engine transport: the SSE hub and the JSON body reader that BOTH
 * coordinators run on. Its failure modes are the unglamorous kind — a body
 * that never ends, a client that disconnected mid-broadcast — so they are
 * exactly what a test should pin down.
 */
'use strict';

const { EventEmitter } = require('events');
const { suite, test, eq, ok, quiet } = require('./harness');
const { SSEHub, sendJSON, handleBody } = require('../server/transport');

/** Minimal http.ServerResponse stand-in. */
function fakeRes() {
    return {
        status: null, headers: null, chunks: [], ended: false, writableEnded: false,
        writeHead(s, h) { this.status = s; this.headers = h; },
        write(c) { if (this.broken) throw new Error('EPIPE'); this.chunks.push(c); return true; },
        end(c) { if (c) this.chunks.push(c); this.ended = true; this.writableEnded = true; },
        get body() { return this.chunks.join(''); },
    };
}

function fakeReq() {
    const r = new EventEmitter();
    r.destroy = () => { r.destroyed = true; };
    return r;
}

suite('transport · handleBody', () => {
    test('parses a JSON body', () => {
        const req = fakeReq(), res = fakeRes();
        let got = null;
        handleBody(req, res, (b) => { got = b; });
        req.emit('data', '{"a":1}');
        req.emit('end');
        eq(got, { a: 1 });
    });

    test('an empty body is an empty object, not an error', () => {
        const req = fakeReq(), res = fakeRes();
        let got = 'untouched';
        handleBody(req, res, (b) => { got = b; });
        req.emit('end');
        eq(got, {});
    });

    test('invalid JSON answers 400 and never calls back', () => {
        const req = fakeReq(), res = fakeRes();
        let called = false;
        quiet(() => {
            handleBody(req, res, () => { called = true; });
            req.emit('data', '{nope');
            req.emit('end');
        });
        eq(called, false);
        eq(res.status, 400);
    });

    test('a body over the cap is refused with 413 and the socket destroyed', () => {
        const req = fakeReq(), res = fakeRes();
        let called = false;
        handleBody(req, res, () => { called = true; });
        req.emit('data', 'x'.repeat(64 * 1024 + 1));
        eq(res.status, 413);
        eq(req.destroyed, true, 'stop reading, do not just answer');
        req.emit('end');
        eq(called, false, 'the callback must not run after a refusal');
    });

    test('the cap counts the whole body, not one chunk', () => {
        const req = fakeReq(), res = fakeRes();
        handleBody(req, res, () => {});
        for (let i = 0; i < 64; i++) req.emit('data', 'x'.repeat(1024));
        eq(res.status, null, '64 KB exactly is still allowed');
        req.emit('data', 'x'.repeat(200));
        eq(res.status, 413, 'one byte past the cap is not');
    });

    test('the cap is caller-tunable', () => {
        const req = fakeReq(), res = fakeRes();
        handleBody(req, res, () => {}, 10);
        req.emit('data', 'x'.repeat(11));
        eq(res.status, 413);
    });
});

suite('transport · sendJSON', () => {
    test('defaults to 200 with a JSON content type', () => {
        const res = fakeRes();
        sendJSON(res, { ok: true });
        eq(res.status, 200);
        eq(res.headers['Content-Type'], 'application/json');
        eq(res.body, '{"ok":true}');
    });

    test('honours an explicit status', () => {
        const res = fakeRes();
        sendJSON(res, { error: 'nope' }, 404);
        eq(res.status, 404);
    });
});

suite('transport · SSEHub', () => {
    test('a client gets event-stream headers and the retry hint', () => {
        const hub = new SSEHub();
        const req = fakeReq(), res = fakeRes();
        hub.addClient(req, res);
        eq(res.headers['Content-Type'], 'text/event-stream');
        eq(res.headers['X-Accel-Buffering'], 'no', 'proxies must not buffer a stream');
        ok(res.body.includes('retry: 2000'));
        eq(hub.size, 1);
    });

    test('onConnect can push a snapshot to just that client', () => {
        const hub = new SSEHub();
        const a = fakeRes(), b = fakeRes();
        hub.addClient(fakeReq(), a);
        hub.addClient(fakeReq(), b, (res, h) => h.send(res, { EventType: 'SYNC' }));
        ok(b.body.includes('"EventType":"SYNC"'));
        ok(!a.body.includes('SYNC'), 'the other client must not see it');
    });

    test('broadcast reaches every client, framed as one SSE event', () => {
        const hub = new SSEHub();
        const a = fakeRes(), b = fakeRes();
        hub.addClient(fakeReq(), a);
        hub.addClient(fakeReq(), b);
        hub.broadcast({ EventType: '53', Message: { x: 1 } });
        for (const c of [a, b]) {
            ok(c.body.includes('data: {"EventType":"53","Message":{"x":1}}\n\n'));
        }
    });

    test('a disconnected client is dropped instead of throwing', () => {
        const hub = new SSEHub();
        const good = fakeRes(), broken = fakeRes();
        hub.addClient(fakeReq(), good);
        hub.addClient(fakeReq(), broken);
        broken.broken = true;
        hub.broadcast({ EventType: 'SYNC' });
        eq(hub.size, 1, 'the dead one is gone');
        ok(good.body.includes('SYNC'), 'the live one still got it');
    });

    test('closing the request removes the client', () => {
        const hub = new SSEHub();
        const req = fakeReq();
        hub.addClient(req, fakeRes());
        eq(hub.size, 1);
        req.emit('close');
        eq(hub.size, 0);
    });
});
