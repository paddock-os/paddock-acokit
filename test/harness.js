/**
 * acokit test harness — zero dependencies, Node stdlib only
 * =========================================================
 * The kit ships with no build step and no framework, and its tests keep that
 * promise: `node test/run.js` and nothing else.
 *
 * Two things live here:
 *
 *   1. A minimal assertion + suite API (`suite`, `test`, `eq`, `ok`, `throws`).
 *   2. A browser stub good enough to load the browser SDK files in Node —
 *      window/document/location/postMessage plus a MANUALLY DRIVEN clock.
 *
 * The manual clock is the point. Render loops are the part of an overlay most
 * likely to break and the hardest to eyeball, so the stub makes frames
 * something a test advances by hand:
 *
 *   const env = browserEnv({ search: '?scale=2' });
 *   env.frame();          // run one requestAnimationFrame callback
 *   env.advance(500);     // move Date.now() forward without running frames
 */
'use strict';

// ─── assertions ──────────────────────────────────────────────────────────────

const suites = [];
let current = null;

function suite(name, fn) {
    current = { name, tests: [] };
    suites.push(current);
    fn();
    current = null;
}

function test(name, fn) {
    if (!current) throw new Error('test() outside of suite()');
    current.tests.push({ name, fn });
}

class AssertionError extends Error {}

function eq(actual, expected, msg) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) throw new AssertionError((msg ? msg + ': ' : '') + `expected ${e}, got ${a}`);
}

function ok(value, msg) {
    if (!value) throw new AssertionError(msg || `expected truthy, got ${JSON.stringify(value)}`);
}

function throws(fn, msg) {
    try { fn(); } catch (_) { return; }
    throw new AssertionError(msg || 'expected a throw');
}

/**
 * Run fn with console.error/warn muted. Tests that deliberately exercise the
 * SDK's "a handler threw, keep going" paths would otherwise bury the results
 * under stack traces that mean everything is working.
 */
function quiet(fn) {
    const e = console.error, w = console.warn;
    console.error = () => {}; console.warn = () => {};
    try { return fn(); } finally { console.error = e; console.warn = w; }
}

// ─── browser stub ────────────────────────────────────────────────────────────

/**
 * Build a fake window/document pair and return it plus the controls a test
 * needs. `parentSearch` makes the window look embedded in a shell whose URL
 * carries those params — the orchestrator case.
 */
function browserEnv(opts) {
    opts = opts || {};
    const search = opts.search || '';
    const listeners = {};
    let now = opts.now || 1000000;
    let rafQueue = [];
    let rafSeq = 0;
    let intervals = [];
    let timeouts = [];
    let timerSeq = 0;

    const style = {
        _props: {},
        setProperty(k, v) { this._props[k] = String(v); },
        getPropertyValue(k) { return this._props[k] || ''; },
    };

    const doc = {
        documentElement: { style, _attrs: {}, setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k] || null; } },
        head: { appendChild() {} },
        currentScript: { src: 'http://localhost:3000/acokit/sdk/acokit-overlay.js' },
        createElement() { return { set src(v) { this._src = v; }, get src() { return this._src; } }; },
        addEventListener() {},
    };

    const win = {
        document: doc,
        location: {
            search,
            hash: opts.hash || '',
            protocol: opts.protocol || 'http:',
            hostname: opts.hostname || 'localhost',
            // '' means the default port for the scheme — i.e. the page is
            // served on 80/443, which is what a deployed site looks like.
            port: opts.port === undefined ? '3000' : opts.port,
            host: (opts.hostname || 'localhost') + ((opts.port === undefined ? '3000' : opts.port) ? ':' + (opts.port === undefined ? '3000' : opts.port) : ''),
            get origin() { return (opts.protocol || 'http:') + '//' + this.host; },
            get href() { return this.origin + '/overlays/x.html' + search; },
        },
        URLSearchParams,
        CustomEvent,
        EventTarget,
        console,
        addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
        removeEventListener(type, fn) {
            const l = listeners[type] || [];
            const i = l.indexOf(fn);
            if (i >= 0) l.splice(i, 1);
        },
        dispatch(type, data) {
            for (const fn of (listeners[type] || []).slice()) fn({ data, type });
        },
        requestAnimationFrame(fn) { rafQueue.push({ id: ++rafSeq, fn }); return rafSeq; },
        cancelAnimationFrame(id) { rafQueue = rafQueue.filter(f => f.id !== id); },
        // Intervals are recorded rather than run: the demo simulator ticks at
        // 30Hz for ever, which a test wants to step by hand, not endure.
        setInterval(fn, ms) { intervals.push({ id: ++timerSeq, fn, ms }); return timerSeq; },
        clearInterval(id) { intervals = intervals.filter(t => t.id !== id); },
        setTimeout(fn, ms) { timeouts.push({ id: ++timerSeq, fn, ms }); return timerSeq; },
        clearTimeout(id) { timeouts = timeouts.filter(t => t.id !== id); },
    };

    // Minimal EventSource: records the URL it was pointed at and lets a test
    // push server events in. The real one auto-reconnects; the SDK relies on
    // that, so there is nothing here to simulate beyond onopen/onerror.
    let sources = [];
    win.EventSource = function EventSource(url) {
        this.url = url;
        this.closed = false;
        this.onopen = this.onerror = this.onmessage = null;
        this.close = () => { this.closed = true; };
        sources.push(this);
    };
    win.self = win;
    win.window = win;

    // Embedded? Give it a parent that records what was posted upward.
    const posted = [];
    if (opts.parentSearch !== undefined) {
        win.parent = {
            location: { search: opts.parentSearch, href: 'http://localhost:3000/overlays/orchestrator.html' + opts.parentSearch },
            postMessage(msg) { posted.push(msg); },
        };
    } else {
        win.parent = win;      // standalone: parent === self, as in a top-level page
    }

    // Date.now is read by the SDK for loop throttling; make it advanceable.
    const realNow = Date.now;
    return {
        window: win,
        document: doc,
        posted,
        style,
        /** Run every currently queued rAF callback once (one "frame"). */
        frame(times) {
            for (let i = 0; i < (times || 1); i++) {
                const queue = rafQueue;
                rafQueue = [];
                for (const f of queue) f.fn(now);
            }
        },
        /** Move the clock without running frames. */
        advance(ms) { now += ms; },
        /** Frames pending right now — a loop that stopped queues nothing. */
        pending() { return rafQueue.length; },
        /** The EventSource instances the SDK opened. */
        get sources() { return sources; },
        /** Run every pending setInterval callback once. */
        tickIntervals(times) { for (let i = 0; i < (times || 1); i++) intervals.slice().forEach(t => t.fn()); },
        /** Run every pending setTimeout callback and clear them. */
        runTimeouts() { const q = timeouts; timeouts = []; q.forEach(t => t.fn()); },
        intervalCount() { return intervals.length; },
        install() { global.Date.now = () => now; },
        restore() { global.Date.now = realNow; },
        dispatch(type, data) { win.dispatch(type, data); },
    };
}

/** Load a browser SDK file against a stub window, returning what it exported. */
function loadSdk(file, env) {
    const fs = require('fs');
    const path = require('path');
    const vm = require('vm');
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const sandbox = {
        window: env.window,
        document: env.document,
        URLSearchParams,
        CustomEvent,
        EventTarget,
        console,
        Date: { now: () => Date.now() },
        // Delegated, not captured: a test may swap window.fetch after load.
        fetch: (...args) => (env.window.fetch
            ? env.window.fetch(...args)
            : Promise.reject(new Error("no fetch in the stub — pass one via env.window.fetch"))),
        EventSource: env.window.EventSource,
        setInterval: env.window.setInterval,
        clearInterval: env.window.clearInterval,
        setTimeout: env.window.setTimeout,
        clearTimeout: env.window.clearTimeout,
    };
    // The SDK files are IIFEs that take `typeof window !== 'undefined' ? window : this`.
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: file });
    return env.window;
}

module.exports = { suite, test, eq, ok, throws, quiet, browserEnv, loadSdk, suites, AssertionError };
