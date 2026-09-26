/**
 * acokit-content — OPTIONAL content layer for AC Overlay Kit
 * ==========================================================
 * The engine (plugin + coordinator + SDK) is content-agnostic: it knows cars
 * and physics, not *who* is driving or how a league scores. This opt-in module
 * is the seam where you add your league's identity — without touching the engine.
 *
 *   const roster = await ACOKitContent.loadRoster('../content/drivers.json');
 *   const m = roster.meta(state.spectatedDriver);     // {team,color,number,logo} or null
 *
 *   const label = ACOKitContent.tyreLabeller({ C2:'H', C3:'M', C4:'S' });
 *   label(state.currentTire);                          // mod/league-specific → H/M/S/SS/I/W
 *
 * Roster JSON shape (either form works):
 *   { "drivers": { "Lena Vogt": { "team":"Northline Racing", "number":"1",
 *                                       "color":"#1e41ff", "logo":"img/northline.png" } } }
 *   or just the inner  { "Lena Vogt": { ... } }
 */
(function (global) {
    'use strict';

    class Roster {
        constructor() { this.byName = {}; this.order = {}; this.loaded = false; }
        async load(url) {
            const res = await fetch(url);
            if (!res.ok) throw new Error('roster ' + res.status);
            const data = await res.json();
            const drivers = data && data.drivers ? data.drivers : (data || {});
            this.byName = {}; this.order = {};
            Object.keys(drivers).forEach((name, i) => {
                this.byName[name.toLowerCase()] = drivers[name];
                this.order[name.toLowerCase()] = i;
            });
            this.loaded = true;
            return this;
        }
        /** Strict lookup — returns null for unknown names (like a real roster). */
        meta(name) {
            if (!name) return null;
            return this.byName[String(name).toLowerCase()] || null;
        }
        /** Stable sort index (roster order), or Infinity if unknown. */
        index(name) {
            const k = String(name || '').toLowerCase();
            return (k in this.order) ? this.order[k] : Infinity;
        }
    }

    const C = {
        Roster: Roster,
        loadRoster(url) { return new Roster().load(url); },

        /**
         * Build a tyre-compound → label function. The base map covers named
         * compounds; pass overrides for your mod's C-codes (these are
         * LEAGUE/MOD-SPECIFIC — e.g. one mod's "C5" is another's Medium).
         *   const label = tyreLabeller({ C2:'H', C3:'M', C4:'S', C5:'S' });
         */
        tyreLabeller(overrides) {
            const base = {
                H: 'H', HARD: 'H', M: 'M', MEDIUM: 'M', S: 'S', SOFT: 'S',
                SS: 'SS', SUPERSOFT: 'SS', HYPERSOFT: 'SS',
                I: 'I', INTER: 'I', INTERMEDIATE: 'I', W: 'W', WET: 'W',
            };
            const map = Object.assign({}, base, overrides || {});
            return function (compound) {
                if (!compound) return '?';
                const c = String(compound).toUpperCase().trim();
                if (map[c]) return map[c];
                if (c.indexOf('C5') >= 0) return 'SS';
                if (c.indexOf('C4') >= 0) return 'S';
                if (c.indexOf('C3') >= 0) return 'M';
                if (c.indexOf('C1') >= 0 || c.indexOf('C2') >= 0) return 'H';
                return '?';
            };
        },
    };

    C.version = '0.3.0';
    global.ACOKitContent = C;
})(typeof window !== 'undefined' ? window : this);
