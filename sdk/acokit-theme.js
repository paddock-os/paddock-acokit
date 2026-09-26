/**
 * acokit/sdk/acokit-theme — broadcast theme loader
 * ================================================
 * Put this in <head>, BEFORE any <style> that reads theme tokens:
 *
 *   <script src="../acokit/sdk/acokit-theme.js" data-themes="../../themes"></script>
 *
 * `data-themes` is resolved against THIS SCRIPT's URL, not the page's — so one
 * value is correct for every page that loads it, however deep. In the example
 * the script sits at /acokit/sdk/, so "../../themes" is /themes.
 *
 * It injects `<themesBase>/<name>.css` so an overlay's local variables — which
 * map onto theme tokens with their original value as a fallback — resolve
 * against the selected theme. Deliberately tiny, dependency-free and
 * synchronous: it runs before first paint, so there is no flash of the wrong
 * look on an OBS source that is already live.
 *
 * Resolution order:
 *   1. ?theme=<name> on this document's URL
 *   2. the theme of the parent orchestrator shell (embedded overlays inherit)
 *   3. DEFAULT_THEME
 *
 * The kit ships no themes of its own: which tokens exist and what they mean is
 * a decision for your project, not the engine. Point `data-themes` at your own
 * directory and the mechanism is yours. `data-default` overrides the fallback
 * name (default "default").
 *
 * Live switching (a shell fans this out to its iframes):
 *   window.ACOTheme.set('classic')
 *   iframe.contentWindow.postMessage({ type: 'THEME_SET', theme: 'x' }, '*')
 */
(function (global) {
    'use strict';

    var script = global.document && global.document.currentScript;
    var data = (script && script.dataset) || {};

    var DEFAULT_THEME = data.default || 'default';
    var THEMES_BASE = (data.themes || '../themes').replace(/\/+$/, '');
    // Theme names come from a URL, so they are never interpolated into a path
    // unchecked: only a lowercase slug can ever reach the href.
    var VALID = /^[a-z0-9-]{1,40}$/;

    function fromSearch(search) {
        try {
            var name = new URLSearchParams(search || '').get('theme');
            return (name && VALID.test(name)) ? name : null;
        } catch (_) { return null; }
    }

    function resolve() {
        var own = fromSearch(global.location.search);
        if (own) return own;
        // Embedded in an orchestrator shell: same origin, so we can read the
        // parent's URL. Cross-origin (or no parent) just falls through.
        if (global.parent && global.parent !== global) {
            try {
                var inherited = fromSearch(global.parent.location.search);
                if (inherited) return inherited;
            } catch (_) { /* cross-origin — ignore */ }
        }
        return DEFAULT_THEME;
    }

    // Resolve the stylesheet relative to THIS script rather than to the
    // document, so it works the same from an overlays/ folder, a nested tool
    // page, or wherever an OBS source happens to point.
    var base = (script && script.src) || '';
    function href(name) {
        try { return new URL(THEMES_BASE + '/' + name + '.css', base).href; }
        catch (_) { return THEMES_BASE + '/' + name + '.css'; }
    }

    var link = global.document.createElement('link');
    link.rel = 'stylesheet';
    link.id = 'aco-theme';
    var current = resolve();
    link.href = href(current);
    // If a theme file is missing, fall back to the default rather than leaving
    // the overlay on bare fallbacks with a half-applied look.
    link.onerror = function () {
        if (current !== DEFAULT_THEME) {
            console.warn('[theme] "' + current + '" failed to load — falling back to ' + DEFAULT_THEME);
            current = DEFAULT_THEME;
            link.href = href(DEFAULT_THEME);
        }
    };
    (global.document.head || global.document.documentElement).appendChild(link);

    function set(name) {
        if (!VALID.test(String(name || ''))) return false;
        if (name === current) return true;
        current = name;
        link.href = href(name);
        global.document.documentElement.setAttribute('data-theme', name);
        try {
            global.dispatchEvent(new CustomEvent('theme-change', { detail: { theme: name } }));
        } catch (_) { /* no CustomEvent in this host — the attribute is enough */ }
        return true;
    }

    global.document.documentElement.setAttribute('data-theme', current);

    global.addEventListener('message', function (ev) {
        var m = ev.data;
        if (m && typeof m === 'object' && m.type === 'THEME_SET') set(m.theme);
    });

    global.ACOTheme = {
        get current() { return current; },
        set: set,
        href: href,
        DEFAULT: DEFAULT_THEME,
        base: THEMES_BASE,
    };
})(typeof window !== 'undefined' ? window : this);
