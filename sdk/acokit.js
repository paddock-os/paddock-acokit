/**
 * AC Overlay Kit (acokit) — browser SDK
 * =====================================
 * A tiny, dependency-free client for building Assetto Corsa broadcast overlays.
 *
 * It hides the transport and gives you typed events + the latest snapshot:
 *
 *   const kit = new ACOKit();                 // auto: SSE live, shell, or ?demo=1
 *   kit.on('telemetry', t => speedEl.textContent = Math.round(t.speedKmh));
 *   kit.on('state',     s => nameEl.textContent  = s.spectatedDriver);
 *
 * Transport (decided automatically):
 *   • Standalone page  → opens an EventSource to the coordinator (/api/events).
 *   • Inside an orchestrator shell (window.parent !== window) → receives the
 *     SAME events via window.postMessage from the parent (single-connection
 *     pattern), and announces SHELL_OVERLAY_READY so the shell replays SYNC.
 *   • ?demo=1 → runs a built-in lap simulator, no coordinator needed.
 *
 * Coordinator host:
 *   default  the page's own origin (or :3001 when the page is served from the
 *            dev static server on :3000 — see apiBase())
 *   override ?api=host:port  (scheme is added automatically)
 *
 * The kit is intentionally CONTENT-AGNOSTIC: it does not know about drivers,
 * tyre compounds, points or any league rules. It just delivers AC telemetry +
 * director state. Build your league logic on top.
 */
(function (global) {
    'use strict';

    // ─── URL params ────────────────────────────────────────────────────────
    function params() {
        const out = {};
        new URLSearchParams(global.location.search).forEach((v, k) => { out[k] = v; });
        // also accept params after the hash (#demo=1) for OBS convenience
        new URLSearchParams((global.location.hash || '').replace(/^#/, '')).forEach((v, k) => {
            if (!(k in out)) out[k] = v;
        });
        return out;
    }

    // The one deliberate two-origin setup: a static server such as
    // `npx serve . -l 3000` in front of a coordinator on 3001.
    const DEV_STATIC_PORT = '3000';
    const COORDINATOR_PORT = '3001';

    function apiBase() {
        let api = params().api;
        // Widgets embedded in an orchestrator shell carry no query of their
        // own — the shell's iframe srcs are bare. So an ?api= on the SHELL has
        // to reach them, or pointing the shell at another machine moves its
        // SSE while leaving every widget's REST call pointed at localhost.
        // Same-origin only; a cross-origin parent just throws and we ignore it.
        if (!api && global.parent && global.parent !== global) {
            try { api = new URLSearchParams(global.parent.location.search).get('api') || null; } catch (_) {}
        }
        if (api) {
            // A bare host like "localhost:3001" is NOT a valid URL — the browser
            // parses "localhost:" as the scheme and the request never leaves the
            // page. Prepend the page's scheme.
            return /^https?:\/\//.test(api) ? api : global.location.protocol + '//' + api;
        }
        // No override. Three shapes exist, and only ONE of them puts the API
        // somewhere other than where the page came from:
        //
        //   Development — the overlays come off a static server on :3000 while
        //   the coordinator listens separately on :3001. Two origins, on
        //   purpose. This is the exception, and the static port names it.
        //
        //   Deployed — a reverse proxy serves the overlays AND routes /api/ to
        //   the coordinator, all on one origin (port 80/443, so location.port
        //   is empty). The coordinator's own port is not published at all.
        //
        //   Standalone — the coordinator serves the overlays itself, on
        //   whatever port it was given. Same origin, and that port is NOT
        //   knowable from here: the packaged build tells an operator to move
        //   it whenever 3001 is taken. Hard-coding :3001 for every non-empty
        //   port is what left every overlay sitting on "Waiting for data…" the
        //   moment someone did exactly that.
        //
        // So: same origin unless we are on the dev static port. Anything
        // stranger passes ?api= explicitly.
        if (global.location.port === DEV_STATIC_PORT) {
            return global.location.protocol + '//' + global.location.hostname + ':' + COORDINATOR_PORT;
        }
        return global.location.origin;
    }

    // ─── Formatting helpers (generic racing) ────────────────────────────────
    function formatLapTime(ms) {
        if (typeof ms === 'string') return ms;
        if (!ms || ms <= 0) return '--:--.---';
        const m = Math.floor(ms / 60000);
        const s = (ms % 60000) / 1000;
        return m + ':' + s.toFixed(3).padStart(6, '0');
    }
    function formatGap(ms) {
        if (ms === null || ms === undefined || (typeof ms === 'number' && ms < 0)) return '';
        if (typeof ms === 'string') return ms;
        if (ms < 60000) return '+' + (ms / 1000).toFixed(3);
        const m = Math.floor(ms / 60000);
        const s = (ms % 60000) / 1000;
        return '+' + m + ':' + s.toFixed(3).padStart(6, '0');
    }
    function escapeHtml(v) {
        if (v === null || v === undefined) return '';
        return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ─── Scale handshake ─────────────────────────────────────────────────────
    // Overlays are authored at a fixed internal size and scaled to fit. Call
    // setupScale once: it applies ?scale= immediately, listens for SET_SCALE
    // from an orchestrator shell, and announces SCALE_CAPABLE to the parent so
    // the shell knows this overlay handles its own scaling.
    //   ACOKit.setupScale('my_overlay', v => root.style.setProperty('--scale', v));
    function setupScale(overlayName, apply) {
        const p = params();
        const s0 = parseFloat(p.scale);
        if (!isNaN(s0) && s0 > 0) apply(s0);
        function announce() {
            if (global.parent && global.parent !== global) {
                try { global.parent.postMessage({ type: 'SCALE_CAPABLE', overlay: overlayName }, '*'); } catch (_) {}
            }
        }
        announce();
        global.addEventListener('load', announce);
        global.addEventListener('message', (ev) => {
            // Only the shell that frames us.
            if (ev.source !== global.parent || global.parent === global) return;
            const d = ev.data;
            if (d && d.type === 'SET_SCALE' && typeof d.value === 'number' && d.value > 0) apply(d.value);
        });
    }

    // ─── Demo lap simulator ──────────────────────────────────────────────────
    // Emits plausible telemetry at ~30Hz so overlays preview without AC.
    function startDemo(emit, emitState) {
        const LAP = 84000;            // ~1:24 lap
        // Start near the END of an out-lap so the first S/F crossing (which
        // "arms" lap-tracker overlays) happens ~3s after load, not a lap later.
        let start = Date.now() - (LAP - 3000);
        let lapEvent = 0, tick = 0;
        const demoState = {
            spectatedDriver: 'Demo Driver', spectatedCarId: 0,
            carModel: 'demo_car', isInPit: false, currentTire: 'M',
            iCurrentTime: 0, iLastTime: 0, iBestTime: 0,
            sessionFlag: 'none', yellowFlag: false,
        };
        return setInterval(() => {
            let lap = Date.now() - start;
            if (lap >= LAP) { start = Date.now(); lap = 0; lapEvent++; }
            // Re-emit state ~1Hz (like the real plugin) so listeners attached
            // after construction still receive it.
            if (tick++ % 30 === 0) emitState(demoState);
            const f = lap / LAP;                       // lap fraction
            const speed = 120 + 160 * (0.5 + 0.5 * Math.sin(f * Math.PI * 6)); // 120..280-ish
            const gear = Math.max(1, Math.min(8, Math.round(speed / 35)));
            emit({
                speedKmh: speed,
                gear: gear + 1,                        // plugin gear encoding (0=R,1=N,2=1st)
                rpm: 4000 + Math.round((speed % 40) * 200),
                throttle: 0.5 + 0.5 * Math.sin(f * Math.PI * 8),
                brake: Math.max(0, -Math.sin(f * Math.PI * 8)) * 0.8,
                clutch: 0,
                drs: (f > 0.55 && f < 0.72) ? 1 : 0,   // a fake DRS zone
                steer: Math.sin(f * Math.PI * 10) * 0.4,
                splinePosition: f,
                lapTimeMs: lap,
                completedLapMs: LAP,
                lapEvent: lapEvent,
                tyreTemp: [85, 87, 84, 86],
            });
        }, 33);
    }

    // ─── Client ──────────────────────────────────────────────────────────────
    class ACOKit extends EventTarget {
        /**
         * @param {object} [opts]
         * @param {boolean} [opts.demo]   force demo mode (else auto from ?demo=1)
         * @param {boolean} [opts.connect=true] connect immediately
         */
        constructor(opts) {
            super();
            opts = opts || {};
            const p = params();
            this.telemetry = null;       // latest TELEMETRY payload
            this.state = null;           // latest PLUGIN_STATE payload
            this.connected = false;
            this._es = null;
            this.isDemo = opts.demo || p.demo === '1';
            this.isInShell = (global.parent !== global);
            if (opts.connect !== false) this.connect();
        }

        /** Convenience: kit.on('telemetry', t => ...). Returns an off() fn. */
        on(type, handler) {
            const wrapped = (e) => handler(e.detail, e);
            this.addEventListener(type, wrapped);
            return () => this.removeEventListener(type, wrapped);
        }

        connect() {
            if (this.isDemo) {
                this._demoTimer = startDemo(
                    (t) => this._dispatch('TELEMETRY', t),
                    (s) => this._dispatch('PLUGIN_STATE', s)
                );
                this._setConnected(true);
                // A demo overlay needs no data from the shell, but the shell
                // still needs to know it exists: SHELL_OVERLAY_READY is what
                // makes the shell replay this widget's CURRENT visibility to
                // it. Without it, a widget previewed inside a shell never
                // learns it is hidden and runs its loops for nobody.
                if (this.isInShell) this._announceReady();
                return;
            }
            if (this.isInShell) {
                global.addEventListener('message', (ev) => {
                    // The shell's relay is the live feed: only the frame's
                    // own parent may speak for it.
                    if (ev.source !== global.parent) return;
                    const d = ev.data;
                    if (!d || typeof d !== 'object' || !('EventType' in d)) return;
                    this._handle(d);
                });
                this._setConnected(true);
                this._announceReady();
                return;
            }
            const url = apiBase() + '/api/events';
            const es = new EventSource(url);
            this._es = es;
            es.onopen = () => this._setConnected(true);
            es.onerror = () => this._setConnected(false);     // EventSource auto-reconnects
            es.onmessage = (e) => {
                try { this._handle(JSON.parse(e.data)); } catch (_) {}
            };
        }

        close() {
            if (this._es) { this._es.close(); this._es = null; }
            if (this._demoTimer) { clearInterval(this._demoTimer); this._demoTimer = null; }
            this._setConnected(false);
        }

        /** Tell a parent shell we exist, so it can replay SYNC + visibility. */
        _announceReady() {
            try { global.parent.postMessage({ type: 'SHELL_OVERLAY_READY' }, '*'); } catch (_) {}
        }

        _setConnected(v) {
            if (this.connected === v) return;
            this.connected = v;
            this.dispatchEvent(new CustomEvent('connection', { detail: { connected: v } }));
        }

        // Translate a raw coordinator envelope {EventType, Message} into events.
        _handle(env) {
            const msg = env && env.Message;
            // 'message' fires for EVERY envelope, before the typed dispatch — so
            // a layer on top (e.g. a league's race-data client) can do its own
            // routing while still getting the engine's transport + reconnection.
            this.dispatchEvent(new CustomEvent('message', { detail: env }));
            switch (env && env.EventType) {
                case 'TELEMETRY':    this._dispatch('TELEMETRY', msg); break;
                case 'PLUGIN_STATE': this._dispatch('PLUGIN_STATE', msg); break;
                case 'SYNC':
                    // Full snapshot. Surface plugin sub-state if present.
                    this.dispatchEvent(new CustomEvent('sync', { detail: msg }));
                    if (msg && msg.plugin && msg.plugin.spectated) this._dispatch('PLUGIN_STATE', msg.plugin.spectated);
                    if (msg && msg.plugin && msg.plugin.telemetry) this._dispatch('TELEMETRY', msg.plugin.telemetry);
                    break;
                default:
                    this.dispatchEvent(new CustomEvent('raw', { detail: env }));
            }
        }

        _dispatch(type, payload) {
            if (!payload) return;
            if (type === 'TELEMETRY') { this.telemetry = payload; this.dispatchEvent(new CustomEvent('telemetry', { detail: payload })); }
            else if (type === 'PLUGIN_STATE') { this.state = payload; this.dispatchEvent(new CustomEvent('state', { detail: payload })); }
        }
    }

    // Static helpers
    ACOKit.params = params;
    ACOKit.apiBase = apiBase;
    ACOKit.formatLapTime = formatLapTime;
    ACOKit.formatGap = formatGap;
    ACOKit.escapeHtml = escapeHtml;
    ACOKit.setupScale = setupScale;
    ACOKit.version = '0.3.1';

    global.ACOKit = ACOKit;
})(typeof window !== 'undefined' ? window : this);
