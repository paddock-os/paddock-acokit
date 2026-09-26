/**
 * acokit/sdk/acokit-overlay — the overlay lifecycle
 * =================================================
 * Every broadcast overlay needs the same four things, and before this module
 * every overlay hand-rolled all four:
 *
 *   1. URL parameters
 *   2. the scale handshake with the orchestrator shell
 *   3. visibility (the shell fades an iframe out; the overlay should know)
 *   4. a render loop that does not burn CPU for frames nobody sees
 *
 * Hand-rolling those produced 21 subtly different copies of the same 25 lines
 * and, more expensively, three bugs: a widget that ran its one-shot intro on
 * iframe load and had therefore already finished by the time it was shown, a
 * stopwatch frozen outside the shell because its loop was gated on a message
 * only the shell sends, and render loops left running behind a faded-out
 * iframe. All three are lifecycle mistakes, so the lifecycle is the fix.
 *
 *   <script src="../acokit/sdk/acokit.js"></script>
 *   <script src="../acokit/sdk/acokit-overlay.js"></script>
 *   ...
 *   const overlay = ACOverlay.init('weather_board', { scaleVar: '--wb-scale' });
 *   overlay.onShow(() => panel.classList.add('in'));
 *   overlay.onHide(() => panel.classList.remove('in'));
 *   overlay.loop(() => clockEl.textContent = now(), { hz: 10 });
 *
 * Requires acokit.js (for params + the scale handshake). Load it first; this
 * module degrades to its own equivalents if it is missing, so a page that
 * forgets the tag still works rather than throwing at load.
 */
(function (global) {
    'use strict';

    var Kit = global.ACOKit;

    function params() {
        if (Kit && typeof Kit.params === 'function') return Kit.params();
        var out = {};
        new URLSearchParams(global.location.search).forEach(function (v, k) { out[k] = v; });
        return out;
    }

    /**
     * One message listener per overlay instead of the three or four each page
     * used to attach, every one of them re-implementing the same envelope
     * guard. Handlers are keyed by message `type`.
     */
    function Router() {
        var handlers = {};
        global.addEventListener('message', function (ev) {
            var m = ev.data;
            if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
            var list = handlers[m.type];
            if (!list) return;
            for (var i = 0; i < list.length; i++) {
                try { list[i](m, ev); } catch (e) { console.error('[ACOverlay] handler for ' + m.type + ' threw', e); }
            }
        });
        this.on = function (type, fn) {
            (handlers[type] || (handlers[type] = [])).push(fn);
            return function off() {
                var list = handlers[type] || [];
                var i = list.indexOf(fn);
                if (i >= 0) list.splice(i, 1);
            };
        };
    }

    function Overlay(name, opts) {
        opts = opts || {};
        this.name = name;
        this.params = params();
        this.embedded = !!(global.parent && global.parent !== global);
        this._router = new Router();
        this._showFns = [];
        this._hideFns = [];
        this._loops = [];

        // Visibility is only ever reported by a shell, so it has THREE states,
        // not two: shown, hidden, and not-yet-told (null).
        //
        // Not-yet-told counts as visible for loops — standalone pages (a bare
        // OBS Browser Source, a ?demo preview) are visible by definition and
        // nobody will ever tell them otherwise; defaulting the other way is
        // exactly how a widget ends up frozen waiting for a message that never
        // comes. But it must NOT count as "already shown" for onShow, or a
        // one-shot widget whose first message is OVERLAY_SHOW would swallow
        // its own cue and never present.
        this._shellHidden = null;

        var self = this;
        this._router.on('OVERLAY_SHOW', function (m) {
            if (m.overlay && m.overlay !== self.name) return;
            if (self._shellHidden === false) return;     // already shown: not a transition
            self._shellHidden = false;
            self._loops.forEach(function (l) { l._resume(); });
            self._showFns.forEach(function (fn) { self._safe(fn, 'onShow'); });
        });
        this._router.on('OVERLAY_HIDE', function (m) {
            if (m.overlay && m.overlay !== self.name) return;
            if (self._shellHidden === true) return;
            self._shellHidden = true;
            self._loops.forEach(function (l) { l._pause(); });
            self._hideFns.forEach(function (fn) { self._safe(fn, 'onHide'); });
        });

        // ─── Scale ──────────────────────────────────────────────────────────
        // Overlays are authored at a fixed internal size. `scaleVar` is the CSS
        // custom property this overlay scales itself with; declaring it here is
        // what lets the shell drop its own transform: scale() on the iframe and
        // push a number instead, which keeps type hinted and borders 1px crisp.
        if (opts.scaleVar || opts.applyScale) {
            var apply = opts.applyScale || function (v) {
                document.documentElement.style.setProperty(opts.scaleVar, v);
            };
            if (Kit && typeof Kit.setupScale === 'function') {
                Kit.setupScale(name, apply);
            } else {
                var s0 = parseFloat(this.params.scale);
                if (!isNaN(s0) && s0 > 0) apply(s0);
                var announce = function () {
                    if (global.parent && global.parent !== global) {
                        try { global.parent.postMessage({ type: 'SCALE_CAPABLE', overlay: name }, '*'); } catch (e) {}
                    }
                };
                announce();
                global.addEventListener('load', announce);
                this._router.on('SET_SCALE', function (m) {
                    if (typeof m.value === 'number' && m.value > 0) apply(m.value);
                });
            }
        }
    }

    Overlay.prototype._safe = function (fn, what) {
        try { fn.call(this); } catch (e) { console.error('[ACOverlay] ' + what + ' threw', e); }
    };

    /** True when this overlay's pixels can actually reach a viewer. */
    Object.defineProperty(Overlay.prototype, 'visible', {
        get: function () { return !this.embedded || this._shellHidden !== true; }
    });

    /** Run fn when the shell reveals this overlay. Standalone never fires. */
    Overlay.prototype.onShow = function (fn) { this._showFns.push(fn); return this; };
    Overlay.prototype.onHide = function (fn) { this._hideFns.push(fn); return this; };

    /** Subscribe to any other postMessage type on the shared listener. */
    Overlay.prototype.on = function (type, fn) { return this._router.on(type, fn); };

    /**
     * A requestAnimationFrame loop that only runs while the overlay is
     * visible, optionally throttled.
     *
     *   const l = overlay.loop(draw, { hz: 10 });
     *   l.stop();
     *
     * `hz` throttles the callback while still riding rAF, so the loop stays in
     * step with the compositor instead of drifting the way setInterval does.
     * Loops start immediately unless { autostart: false }.
     *
     * Returning **false** from fn parks the loop until something calls
     * start() again — for the common "animate only while data is arriving"
     * case, where running at 60fps over a static field is as wasteful as
     * running behind a hidden iframe:
     *
     *   const l = overlay.loop(() => { draw(); return isFresh(); });
     *   onData(() => l.start());
     */
    Overlay.prototype.loop = function (fn, opts) {
        opts = opts || {};
        var self = this;
        var minGap = opts.hz ? (1000 / opts.hz) : 0;
        var rafId = null;
        var last = 0;
        var stopped = false;

        function frame() {
            rafId = null;
            if (stopped || !self.visible) return;
            var now = Date.now();
            if (!minGap || now - last >= minGap) {
                last = now;
                var keep;
                try { keep = fn(); } catch (e) { console.error('[ACOverlay] loop threw', e); }
                if (keep === false) return;          // parked until start()
            }
            rafId = global.requestAnimationFrame(frame);
        }

        var handle = {
            _resume: function () {
                if (stopped || rafId !== null || !self.visible) return;
                last = 0;
                rafId = global.requestAnimationFrame(frame);
            },
            /** Start or re-arm. No-op while hidden — the show handler resumes it. */
            start: function () { handle._resume(); },
            _pause: function () {
                if (rafId !== null) { global.cancelAnimationFrame(rafId); rafId = null; }
            },
            stop: function () {
                stopped = true;
                handle._pause();
                var i = self._loops.indexOf(handle);
                if (i >= 0) self._loops.splice(i, 1);
            },
            get running() { return rafId !== null; },
        };
        this._loops.push(handle);
        if (opts.autostart !== false) handle._resume();
        return handle;
    };

    var ACOverlay = {
        /** Create the lifecycle for this overlay. Call once, at script time. */
        init: function (name, opts) { return new Overlay(name, opts); },
        version: '0.3.0',
    };

    global.ACOverlay = ACOverlay;
})(typeof window !== 'undefined' ? window : this);
