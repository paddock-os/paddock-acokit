/**
 * The ACOKit client itself — `new ACOKit()`, which is the first line of the
 * README and until now the only thing in the kit verified purely by eye.
 *
 * Three transports, one envelope format, and a demo simulator. The transport
 * choice is implicit (it reads the page it is running in), which is exactly
 * the kind of convenience that needs pinning down.
 */
'use strict';

const { suite, test, eq, ok, browserEnv, loadSdk } = require('./harness');

function mount(opts) {
    const env = browserEnv(opts);
    env.install();
    loadSdk('sdk/acokit.js', env);
    return env;
}

/** Collect every event a kit emits, by type. */
function record(kit, types) {
    const seen = {};
    for (const t of types) {
        seen[t] = [];
        kit.on(t, (detail) => seen[t].push(detail));
    }
    return seen;
}

suite('client · transport choice', () => {
    test('a standalone page opens SSE to the coordinator', () => {
        const env = mount();
        const kit = new env.window.ACOKit();
        eq(env.sources.length, 1);
        eq(env.sources[0].url, 'http://localhost:3001/api/events');
        eq(kit.isInShell, false);
        env.restore();
    });

    test('?api= moves the stream, scheme and all', () => {
        const env = mount({ search: '?api=10.0.0.9:3001' });
        new env.window.ACOKit();
        eq(env.sources[0].url, 'http://10.0.0.9:3001/api/events');
        env.restore();
    });

    test('inside a shell it opens NO connection and asks for the snapshot', () => {
        // The whole point of the shell pattern: one SSE connection for twenty
        // widgets. A widget that opened its own would be twenty connections.
        const env = mount({ parentSearch: '' });
        const kit = new env.window.ACOKit();
        eq(env.sources.length, 0, 'no EventSource in shell mode');
        eq(kit.isInShell, true);
        ok(env.posted.some(m => m.type === 'SHELL_OVERLAY_READY'), 'announced itself so the shell replays SYNC');
        env.restore();
    });

    test('?demo=1 needs neither a coordinator nor a shell', () => {
        const env = mount({ search: '?demo=1' });
        const kit = new env.window.ACOKit();
        eq(env.sources.length, 0);
        eq(kit.isDemo, true);
        eq(kit.connected, true);
        env.restore();
    });

    test('a demo widget INSIDE a shell still announces itself', () => {
        // It wants no data from the shell, but SHELL_OVERLAY_READY is what
        // makes the shell replay its current visibility. Without it a widget
        // that starts hidden is never told so, and runs its loops for nobody.
        const env = mount({ search: '?demo=1', parentSearch: '' });
        new env.window.ACOKit();
        ok(env.posted.some(m => m.type === 'SHELL_OVERLAY_READY'));
        env.restore();
    });

    test('connect:false stays quiet until you ask', () => {
        const env = mount();
        const kit = new env.window.ACOKit({ connect: false });
        eq(env.sources.length, 0);
        kit.connect();
        eq(env.sources.length, 1);
        env.restore();
    });
});

suite('client · connection state', () => {
    test('connection events fire on open and on error, once each', () => {
        const env = mount();
        const kit = new env.window.ACOKit();
        const seen = record(kit, ['connection']);
        const es = env.sources[0];
        es.onopen();
        es.onopen();                                  // duplicate: not a change
        eq(seen.connection.map(c => c.connected), [true]);
        es.onerror();
        eq(seen.connection.map(c => c.connected), [true, false]);
        env.restore();
    });

    test('close() tears the stream down', () => {
        const env = mount();
        const kit = new env.window.ACOKit();
        const es = env.sources[0];
        es.onopen();
        kit.close();
        eq(es.closed, true);
        eq(kit.connected, false);
        env.restore();
    });

    test('close() also stops the demo simulator', () => {
        const env = mount({ search: '?demo=1' });
        const kit = new env.window.ACOKit();
        ok(env.intervalCount() > 0);
        kit.close();
        eq(env.intervalCount(), 0, 'a closed kit must not keep ticking');
        env.restore();
    });
});

suite('client · envelope routing', () => {
    /** Push a coordinator envelope in over SSE. */
    function feed(env, envelope) {
        env.sources[0].onmessage({ data: JSON.stringify(envelope) });
    }

    test('TELEMETRY and PLUGIN_STATE become typed events and latest-value state', () => {
        const env = mount();
        const kit = new env.window.ACOKit();
        const seen = record(kit, ['telemetry', 'state']);
        feed(env, { EventType: 'TELEMETRY', Message: { speedKmh: 210 } });
        feed(env, { EventType: 'PLUGIN_STATE', Message: { spectatedDriver: 'Rivera' } });
        eq(seen.telemetry, [{ speedKmh: 210 }]);
        eq(seen.state, [{ spectatedDriver: 'Rivera' }]);
        eq(kit.telemetry.speedKmh, 210, 'the latest packet is readable without listening');
        eq(kit.state.spectatedDriver, 'Rivera');
        env.restore();
    });

    test('SYNC unpacks the plugin sub-state a late joiner missed', () => {
        // A widget that mounts mid-session gets everything from the snapshot,
        // not from waiting for the next live packet.
        const env = mount();
        const kit = new env.window.ACOKit();
        const seen = record(kit, ['sync', 'telemetry', 'state']);
        feed(env, {
            EventType: 'SYNC',
            Message: { session: { Name: 'Race' }, plugin: { telemetry: { speedKmh: 88 }, spectated: { spectatedDriver: 'Blake' } } },
        });
        eq(seen.sync.length, 1);
        eq(seen.sync[0].session.Name, 'Race');
        eq(seen.telemetry, [{ speedKmh: 88 }]);
        eq(seen.state, [{ spectatedDriver: 'Blake' }]);
        env.restore();
    });

    test('a SYNC without plugin data emits sync only', () => {
        const env = mount();
        const kit = new env.window.ACOKit();
        const seen = record(kit, ['sync', 'telemetry']);
        feed(env, { EventType: 'SYNC', Message: { session: {} } });
        eq(seen.sync.length, 1);
        eq(seen.telemetry.length, 0);
        env.restore();
    });

    test('unknown envelopes surface as raw instead of vanishing', () => {
        // A league layer rides on this: its own event types (ACSM's numeric
        // 200, 53, …) are meaningless to the engine, so they must still come
        // through.
        const env = mount();
        const kit = new env.window.ACOKit();
        const seen = record(kit, ['raw', 'message']);
        feed(env, { EventType: '53', Message: { CarID: 4 } });
        eq(seen.raw.length, 1);
        eq(seen.raw[0].EventType, '53');
        eq(seen.message.length, 1, 'message fires for EVERY envelope, before typing');
        env.restore();
    });

    test('malformed JSON does not take the connection down', () => {
        const env = mount();
        const kit = new env.window.ACOKit();
        const seen = record(kit, ['telemetry']);
        env.sources[0].onmessage({ data: '{not json' });
        feed(env, { EventType: 'TELEMETRY', Message: { speedKmh: 1 } });
        eq(seen.telemetry.length, 1, 'still delivering after the bad frame');
        env.restore();
    });

    test('an empty Message is ignored rather than dispatched as null', () => {
        const env = mount();
        const kit = new env.window.ACOKit();
        const seen = record(kit, ['telemetry']);
        feed(env, { EventType: 'TELEMETRY' });
        eq(seen.telemetry.length, 0);
        env.restore();
    });

    test('in shell mode the same envelopes arrive by postMessage', () => {
        const env = mount({ parentSearch: '' });
        const kit = new env.window.ACOKit();
        const seen = record(kit, ['telemetry']);
        env.dispatch('message', { EventType: 'TELEMETRY', Message: { speedKmh: 42 } });
        eq(seen.telemetry, [{ speedKmh: 42 }]);
        env.restore();
    });

    test('shell mode takes envelopes only from the shell itself', () => {
        // The relay is the live feed: another window must not be able to
        // speak for the race.
        const env = mount({ parentSearch: '' });
        const kit = new env.window.ACOKit();
        const seen = record(kit, ['telemetry']);
        env.dispatch('message', { EventType: 'TELEMETRY', Message: { speedKmh: 999 } }, {});
        eq(seen.telemetry.length, 0);
        env.restore();
    });

    test('shell mode ignores postMessages that are not envelopes', () => {
        // The same channel carries SET_SCALE, OVERLAY_SHOW, THEME_SET…
        const env = mount({ parentSearch: '' });
        const kit = new env.window.ACOKit();
        const seen = record(kit, ['raw', 'message']);
        env.dispatch('message', { type: 'SET_SCALE', value: 2 });
        env.dispatch('message', { type: 'OVERLAY_SHOW', overlay: 'x' });
        eq(seen.message.length, 0, 'lifecycle chatter is not race data');
        env.restore();
    });

    test('on() returns an unsubscribe', () => {
        const env = mount();
        const kit = new env.window.ACOKit();
        let n = 0;
        const off = kit.on('telemetry', () => n++);
        feed(env, { EventType: 'TELEMETRY', Message: { speedKmh: 1 } });
        off();
        feed(env, { EventType: 'TELEMETRY', Message: { speedKmh: 2 } });
        eq(n, 1);
        env.restore();
    });
});

suite('client · demo simulator', () => {
    test('it emits plausible telemetry without anything running', () => {
        const env = mount({ search: '?demo=1' });
        const kit = new env.window.ACOKit();
        const seen = record(kit, ['telemetry', 'state']);
        env.tickIntervals();
        eq(seen.telemetry.length, 1);
        const t = seen.telemetry[0];
        ok(t.speedKmh > 0 && t.speedKmh < 400, `speed in range, got ${t.speedKmh}`);
        ok(t.gear >= 1, 'gear uses the plugin encoding');
        ok(t.lapTimeMs >= 0);
        eq(t.tyreTemp.length, 4);
        env.restore();
    });

    test('state is re-emitted periodically for listeners that arrived late', () => {
        const env = mount({ search: '?demo=1' });
        const kit = new env.window.ACOKit();
        const seen = record(kit, ['state']);
        env.tickIntervals(31);
        ok(seen.state.length >= 1, 'state comes round again, ~1Hz like the real plugin');
        env.restore();
    });

    test('the lap wraps, so lap-watching overlays can be built on demo alone', () => {
        const env = mount({ search: '?demo=1' });
        const kit = new env.window.ACOKit();
        const seen = record(kit, ['telemetry']);
        env.tickIntervals();
        const first = seen.telemetry[0].lapEvent;
        env.advance(5000);            // the simulator starts 3s from the line
        env.tickIntervals();
        const after = seen.telemetry[seen.telemetry.length - 1].lapEvent;
        eq(after, first + 1, 'crossed the line exactly once');
        env.restore();
    });
});
