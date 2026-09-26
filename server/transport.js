/**
 * acokit/server/transport — shared SSE + HTTP-JSON transport primitives
 * =====================================================================
 * The generic "engine" plumbing every coordinator needs, factored out so both
 * the minimal acokit coordinator AND a full league coordinator built on top of
 * it share ONE implementation instead of duplicating it.
 *
 * Zero dependencies (Node stdlib only). It deliberately knows nothing about
 * cars, drivers or race logic — it just moves bytes.
 *
 *   const { SSEHub, sendJSON, handleBody } = require('./transport');
 *   const hub = new SSEHub();
 *   // in your request handler:
 *   if (pathname === '/api/events') return hub.addClient(req, res, r => {
 *       hub.send(r, { EventType: 'SYNC', Message: myState });   // initial snapshot
 *   });
 *   // anywhere:
 *   hub.broadcast({ EventType: 'TELEMETRY', Message: body });
 */

class SSEHub {
    constructor(opts) {
        opts = opts || {};
        this.clients = new Set();
        this.pingMs = opts.pingMs || 30000;
        // Heartbeat keeps idle SSE connections alive across proxies / OBS CEF.
        this._ping = setInterval(() => {
            for (const c of this.clients) { try { c.write(': ping\n\n'); } catch (_) { this.clients.delete(c); } }
        }, this.pingMs);
        if (this._ping.unref) this._ping.unref();
    }

    get size() { return this.clients.size; }

    /** Send one event to ONE client (e.g. an on-connect snapshot). */
    send(res, data) { try { res.write('data: ' + JSON.stringify(data) + '\n\n'); } catch (_) {} }

    /** Push one event to ALL connected clients. */
    broadcast(data) {
        const line = 'data: ' + JSON.stringify(data) + '\n\n';
        for (const c of this.clients) { try { c.write(line); } catch (_) { this.clients.delete(c); } }
    }

    /**
     * Register an SSE client. Writes the standard event-stream headers, then
     * calls onConnect(res, hub) so the caller can stream its initial snapshot.
     * Cleans up on disconnect. Returns res.
     */
    addClient(req, res, onConnect) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'X-Accel-Buffering': 'no',   // disable buffering on any reverse proxy in front
        });
        res.write('retry: 2000\n\n');
        res.write(': connected\n\n');
        this.clients.add(res);
        if (typeof onConnect === 'function') { try { onConnect(res, this); } catch (_) {} }
        req.on('close', () => this.clients.delete(res));
        return res;
    }
}

function sendJSON(res, data, status) {
    res.writeHead(status || 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

/**
 * Read a JSON request body, with a hard size cap so an unauthenticated POST
 * can't grow the process heap without bound. Every coordinator payload is a
 * few KB at most; `maxBytes` is there for callers with unusual needs.
 */
function handleBody(req, res, callback, maxBytes) {
    const MAX_BODY = maxBytes || 64 * 1024;
    let body = '';
    let size = 0;
    req.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Payload too large' }));
            req.destroy();
            return;
        }
        body += chunk;
    });
    req.on('end', () => {
        // The size guard above already answered and killed the socket.
        if (res.writableEnded) return;
        try {
            callback(body ? JSON.parse(body) : {});
        } catch (e) {
            console.error('[transport] Error parsing body:', e.message);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON', message: e.message }));
        }
    });
}

module.exports = { SSEHub, sendJSON, handleBody };
