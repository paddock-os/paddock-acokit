/**
 * The SDK's non-visual core: where the coordinator is, how URL params are
 * read, and the formatters every overlay renders through.
 */
'use strict';

const { suite, test, eq, browserEnv, loadSdk } = require('./harness');

function mount(opts) {
    const env = browserEnv(opts);
    loadSdk('sdk/acokit.js', env);
    return env.window.ACOKit;
}

suite('core · apiBase', () => {
    test('defaults to the page host on the coordinator port', () => {
        eq(mount().apiBase(), 'http://localhost:3001');
    });

    test('honours a full URL in ?api=', () => {
        eq(mount({ search: '?api=https://box.example:8443' }).apiBase(), 'https://box.example:8443');
    });

    test('adds the scheme to a bare host:port', () => {
        // Without this a bare ?api= produced a URL whose "host:" the browser
        // parses as the SCHEME, and the request never leaves the page.
        eq(mount({ search: '?api=192.168.1.5:3001' }).apiBase(), 'http://192.168.1.5:3001');
    });

    test('inherits the shell\'s ?api= when embedded', () => {
        // Iframes in the orchestrator shell carry no query of their own, so
        // pointing the SHELL at another machine has to point its widgets too —
        // otherwise SSE follows the override while REST silently does not.
        const kit = mount({ search: '', parentSearch: '?api=10.0.0.9:3001&debug=1' });
        eq(kit.apiBase(), 'http://10.0.0.9:3001');
    });

    test('the overlay\'s own ?api= wins over the shell\'s', () => {
        const kit = mount({ search: '?api=127.0.0.1:9999', parentSearch: '?api=10.0.0.9:3001' });
        eq(kit.apiBase(), 'http://127.0.0.1:9999');
    });

    test('behind a reverse proxy, the API is the SAME ORIGIN', () => {
        // The deployed shape: nginx serves the overlays on :443 (or :80) and
        // routes /api/ to the coordinator on the internal network. Port 3001
        // is not published at all, so the dev default would point every
        // overlay at a port that refuses the connection.
        const kit = mount({ port: '', protocol: 'https:', hostname: 'overlays.example.com' });
        eq(kit.apiBase(), 'https://overlays.example.com');
    });

    test('a dev port still means the coordinator is on 3001', () => {
        // Locally the overlays are served by static_server on :3000 while the
        // coordinator listens on :3001 — two origins, on purpose.
        const kit = mount({ port: '3000' });
        eq(kit.apiBase(), 'http://localhost:3001');
    });

    test('?api= still wins over both', () => {
        const kit = mount({ search: '?api=10.0.0.9:3001', port: '', protocol: 'https:' });
        eq(kit.apiBase(), 'https://10.0.0.9:3001');
    });

    test('a shell with no override leaves the default alone', () => {
        eq(mount({ search: '', parentSearch: '?debug=1' }).apiBase(), 'http://localhost:3001');
    });

    test('when the coordinator serves the overlays, the API is its own origin', () => {
        // The standalone build: one process, one port, one URL for OBS.
        eq(mount({ port: '3001' }).apiBase(), 'http://localhost:3001');
    });

    test('a coordinator moved off 3001 keeps its overlays with it', () => {
        // The regression this guards: 3001 was hard-coded for every non-empty
        // port, so an operator told to move the port because 3001 was taken
        // got overlays that loaded fine and then sat on "Waiting for data…"
        // forever, talking to a port with nothing behind it.
        eq(mount({ port: '3002' }).apiBase(), 'http://localhost:3002');
        eq(mount({ port: '8080', hostname: '192.168.1.20' }).apiBase(), 'http://192.168.1.20:8080');
    });
});

suite('core · params', () => {
    test('reads the query string', () => {
        eq(mount({ search: '?demo=1&scale=1.5' }).params(), { demo: '1', scale: '1.5' });
    });

    test('also accepts params after the hash, for OBS', () => {
        eq(mount({ search: '', hash: '#demo=1' }).params().demo, '1');
    });

    test('the query string wins over the hash', () => {
        eq(mount({ search: '?demo=0', hash: '#demo=1' }).params().demo, '0');
    });
});

suite('core · formatters', () => {
    test('formatLapTime', () => {
        const f = mount().formatLapTime;
        eq(f(87472), '1:27.472');
        eq(f(0), '--:--.---', 'no time yet');
        eq(f(null), '--:--.---');
        eq(f(3661234), '61:01.234', 'over an hour keeps counting minutes');
        eq(f('1:23.456'), '1:23.456', 'already formatted passes through');
    });

    test('formatGap', () => {
        const f = mount().formatGap;
        eq(f(1199), '+1.199');
        eq(f(0), '+0.000', 'a real zero gap is not "no data"');
        eq(f(null), '', 'no data is empty');
        eq(f(undefined), '');
        eq(f(-5), '', 'negative is nonsense, not a lead');
        eq(f(75123), '+1:15.123');
    });

    test('escapeHtml', () => {
        const f = mount().escapeHtml;
        eq(f('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
        eq(f('O\'Ward & "Sons"'), 'O&#39;Ward &amp; &quot;Sons&quot;');
        eq(f(null), '');
        eq(f(0), '0', 'zero is a value, not absence');
    });
});
