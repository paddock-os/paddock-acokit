/**
 * acokit-racing — OPTIONAL racing helpers for AC Overlay Kit
 * ==========================================================
 * The core SDK (acokit.js) is content-agnostic. This opt-in module adds the
 * reusable racing logic most timing overlays need — encapsulating the gotchas
 * learned building replay/pole-lap tools so you don't reinvent them:
 *
 *   ACOKitRacing.gearLabel(g)        plugin gear encoding → "R"/"N"/"1".."8"
 *   ACOKitRacing.fmtLap(ms)          "1:25.553"  /  "59.214"
 *   ACOKitRacing.fmtSector(ms)       "23.643"
 *   new ACOKitRacing.LapClock()      smooth 60fps lap clock (interpolates telemetry)
 *   new ACOKitRacing.LapWatcher(...)  detects S/F crossings: arm → start → complete
 *   new ACOKitRacing.SectorTimer([..]) hardcoded sectors driven by the live clock
 *
 * Load AFTER acokit.js. None of this is required to use the kit.
 */
(function (global) {
    'use strict';
    const R = {};
    const numOr = (v, d) => (typeof v === 'number' ? v : d);

    R.gearLabel = g => (g === 0 ? 'R' : g === 1 ? 'N' : String(g - 1));

    R.fmtLap = function (ms) {
        if (!Number.isFinite(ms) || ms <= 0) return '--:--.---';
        const m = Math.floor(ms / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        const mmm = Math.floor(ms % 1000);
        const tail = String(s).padStart(2, '0') + '.' + String(mmm).padStart(3, '0');
        return m > 0 ? (m + ':' + tail) : (s + '.' + String(mmm).padStart(3, '0'));
    };
    R.fmtSector = function (ms) {
        if (!Number.isFinite(ms) || ms <= 0) return '';
        const m = Math.floor(ms / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        const mmm = Math.floor(ms % 1000);
        return m > 0 ? (m + ':' + String(s).padStart(2, '0') + '.' + String(mmm).padStart(3, '0'))
            : (s + '.' + String(mmm).padStart(3, '0'));
    };

    /**
     * Smooth lap clock. Telemetry is ~20–30 Hz, which looks steppy; this
     * interpolates between packets and estimates the replay rate (so it tracks
     * slow-motion playback). update() on each telemetry packet; ms() at 60fps.
     */
    R.LapClock = class LapClock {
        constructor() { this.anchorMs = 0; this.anchorWall = 0; this.rate = 1; }
        update(lapTimeMs) {
            const now = Date.now();
            if (this.anchorWall > 0 && now > this.anchorWall && lapTimeMs >= this.anchorMs && (now - this.anchorWall) < 400) {
                const r = (lapTimeMs - this.anchorMs) / (now - this.anchorWall);
                if (r >= 0 && r <= 3) this.rate = this.rate * 0.6 + r * 0.4;
            }
            this.anchorMs = lapTimeMs; this.anchorWall = now;
        }
        ms() {
            if (!this.anchorWall) return 0;
            const dt = Math.min(Date.now() - this.anchorWall, 250); // clamp if telemetry stalls
            return this.anchorMs + this.rate * dt;
        }
    };

    /**
     * Lap watcher. A start/finish crossing is the lap clock resetting to ~0
     * (or `lapEvent` bumping). It "arms" on load and:
     *   • the FIRST crossing fires onStart()   — reveal + start counting from 0,
     *   • each LATER crossing fires onComplete(totalMs) — exact lap done.
     * `completedLapMs` (plugin-reconstructed) is used for the total when present,
     * else the last clock value before reset.
     *   const w = new LapWatcher({ onStart, onComplete });
     *   kit.on('telemetry', t => w.feed(t));
     */
    R.LapWatcher = class LapWatcher {
        constructor(opts) {
            opts = opts || {};
            this.shown = false; this.prevLap = 0; this.prevEvent = null;
            this.onStart = opts.onStart || function () {};
            this.onComplete = opts.onComplete || function () {};
        }
        feed(t) {
            const lap = numOr(t.lapTimeMs, 0), ev = numOr(t.lapEvent, -1);
            let crossed = (this.prevLap > 5000 && lap < this.prevLap - 2000);
            if (ev >= 0) {
                if (this.prevEvent === null) this.prevEvent = ev;
                else if (ev !== this.prevEvent) { this.prevEvent = ev; crossed = true; }
            }
            if (crossed) {
                if (!this.shown) { this.shown = true; this.onStart(); }
                else { const total = numOr(t.completedLapMs, 0) || this.prevLap; if (total > 5000) this.onComplete(total); }
            }
            this.prevLap = lap;
            return this.shown;
        }
    };

    /**
     * Hardcoded sectors driven by the live lap clock. AC doesn't expose the
     * spectated car's sector splits in replay, so for a known lap you bake them
     * in and let the clock fire them.
     *   const st = new SectorTimer([23643, 37435, 24475]);
     *   const newlyDone = st.update(lapClock.ms());   // → indices crossed this frame
     *   st.fill(i, lapClock.ms());                    // 0..1 progress for sector i
     */
    R.SectorTimer = class SectorTimer {
        constructor(sectorsMs) {
            this.sectors = (sectorsMs || [0, 0, 0]).slice(0, 3);
            this.cum = [this.sectors[0], this.sectors[0] + this.sectors[1], this.sectors[0] + this.sectors[1] + this.sectors[2]];
            this.total = this.cum[2];
            this.done = [false, false, false];
        }
        reset() { this.done = [false, false, false]; }
        update(lapMs) {
            const out = [];
            for (let i = 0; i < 3; i++) if (!this.done[i] && lapMs >= this.cum[i]) { this.done[i] = true; out.push(i); }
            return out;
        }
        fill(i, lapMs) {
            if (this.done[i]) return 1;
            const start = i === 0 ? 0 : this.cum[i - 1];
            return Math.max(0, Math.min(1, (lapMs - start) / (this.sectors[i] || 1)));
        }
    };

    R.version = '0.3.1';
    global.ACOKitRacing = R;
})(typeof window !== 'undefined' ? window : this);
