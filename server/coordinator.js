/**
 * AC Overlay Kit — minimal coordinator
 * ====================================
 * The generic "engine" backend. Zero dependencies (Node stdlib only).
 *
 * Responsibilities (and NOTHING else — no league/points/championship logic):
 *   1. Serve overlay static files.
 *   2. Receive the AC telemetry plugin's POSTs:
 *        POST /api/plugin/telemetry   (~30Hz car physics of the focused car)
 *        POST /api/plugin/state       (~1Hz  director/spectator state)
 *   3. Fan those out to overlays over Server-Sent Events:
 *        GET  /api/events             (sends a SYNC snapshot on connect, then
 *                                       streams TELEMETRY / PLUGIN_STATE)
 *
 * Env:
 *   PORT        (default 3001)
 *   HTTP_BIND   (default 127.0.0.1 — loopback so LAN can't POST; use 0.0.0.0
 *               only behind a firewall/Docker mapping)
 *   STATIC_ROOT (default the project root, i.e. the parent of /server)
 *   ADMIN_TOKEN (optional — if set, mutating POSTs need X-Admin-Token; the
 *               /api/plugin/* endpoints stay open since AC's Python can't set
 *               headers and lives on the same loopback)
 *
 * Build your own endpoints/state on top by editing this file — it is meant to
 * be forked. The contract overlays rely on is just the SSE event shapes above.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { SSEHub, sendJSON, handleBody } = require('./transport');

const PORT = parseInt(process.env.PORT || '3001', 10);
const BIND = process.env.HTTP_BIND || '127.0.0.1';
const ROOT = process.env.STATIC_ROOT || path.resolve(__dirname, '..');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

// ─── In-memory state (the whole "model") ────────────────────────────────────
const state = {
    plugin: { telemetry: null, spectated: null, lastTelemetryAt: 0, lastStateAt: 0 },
};

// ─── SSE transport (shared engine module) ───────────────────────────────────
const hub = new SSEHub();
const broadcast = (evt) => hub.broadcast(evt);
function syncSnapshot() {
    return { EventType: 'SYNC', Message: { plugin: state.plugin } };
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function authed(req) {
    if (!ADMIN_TOKEN) return true;
    return req.headers['x-admin-token'] === ADMIN_TOKEN;
}

// ─── HTTP server ────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    // SSE stream — send the snapshot on connect, then stream broadcasts.
    if (p === '/api/events' && req.method === 'GET') {
        hub.addClient(req, res, (r) => hub.send(r, syncSnapshot()));
        return;
    }

    // Plugin ingestion (kept open even with ADMIN_TOKEN — see header note)
    if (p === '/api/plugin/telemetry' && req.method === 'POST') {
        return handleBody(req, res, (body) => {
            if (state.plugin.lastTelemetryAt === 0) console.log('[acokit] first telemetry packet received');
            state.plugin.telemetry = body;
            state.plugin.lastTelemetryAt = Date.now();
            broadcast({ EventType: 'TELEMETRY', Message: body });
            sendJSON(res, { ok: true });
        });
    }
    if (p === '/api/plugin/state' && req.method === 'POST') {
        return handleBody(req, res, (body) => {
            if (state.plugin.lastStateAt === 0) console.log('[acokit] first state packet received');
            state.plugin.spectated = body;
            state.plugin.lastStateAt = Date.now();
            broadcast({ EventType: 'PLUGIN_STATE', Message: body });
            sendJSON(res, { ok: true });
        });
    }

    // Live snapshot for polling/debugging
    if (p === '/api/live' && req.method === 'GET') return sendJSON(res, state.plugin);

    // Example custom mutating endpoint (guarded). Broadcasts an arbitrary event.
    if (p === '/api/broadcast' && req.method === 'POST') {
        if (!authed(req)) return sendJSON(res, { error: 'unauthorized' }, 401);
        return handleBody(req, res, (body) => {
            if (body && body.EventType) broadcast(body);
            sendJSON(res, { ok: true });
        });
    }

    // ─── Static files ───────────────────────────────────────────────────────
    if (req.method === 'GET') return serveStatic(p, res);

    res.writeHead(404); res.end('Not found');
});

function serveStatic(reqPath, res) {
    let filePath = path.join(ROOT, decodeURIComponent(reqPath));
    if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.stat(filePath, (err, st) => {
        if (err) {
            if (!path.extname(filePath) && fs.existsSync(filePath + '.html')) filePath += '.html';
            else { res.writeHead(404); return res.end('Not found'); }
        } else if (st.isDirectory()) filePath = path.join(filePath, 'index.html');
        fs.readFile(filePath, (e2, data) => {
            if (e2) { res.writeHead(404); return res.end('Not found'); }
            const ext = path.extname(filePath).toLowerCase();
            const cacheable = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf'].includes(ext);
            res.writeHead(200, {
                'Content-Type': MIME[ext] || 'application/octet-stream',
                'Cache-Control': cacheable ? 'public, max-age=3600' : 'no-cache',
            });
            res.end(data);
        });
    });
}

server.listen(PORT, BIND, () => {
    console.log('[acokit] coordinator on http://' + BIND + ':' + PORT + '  (root: ' + ROOT + ')');
    if (!ADMIN_TOKEN) console.log('[acokit] ADMIN_TOKEN not set — /api/broadcast is open. Fine for local use.');
});
