/**
 * Theme resolution. The mechanism is engine-generic (a slug on a URL picks a
 * stylesheet); which tokens exist is the project's business, not the kit's.
 */
'use strict';

const { suite, test, eq, ok, quiet, browserEnv, loadSdk } = require('./harness');

/**
 * The theme loader reads its config off its own <script> tag and appends a
 * <link>, so the stub needs a currentScript with a dataset and a head that
 * records what was appended.
 */
function mount(opts) {
    opts = opts || {};
    const env = browserEnv(opts);
    const appended = [];
    env.document.head.appendChild = (el) => appended.push(el);
    env.document.currentScript = {
        src: 'http://localhost:3000/acokit/sdk/acokit-theme.js',
        dataset: opts.dataset || { themes: '../../themes' },
    };
    env.document.createElement = () => ({ _onerror: null, set onerror(f) { this._onerror = f; }, get onerror() { return this._onerror; } });
    loadSdk('sdk/acokit-theme.js', env);
    return { env, appended, link: appended[0], theme: env.window.ACOTheme };
}

suite('theme · resolution', () => {
    test('falls back to the default with no ?theme=', () => {
        const { theme, link } = mount();
        eq(theme.current, 'default');
        ok(link.href.endsWith('/themes/default.css'), link.href);
    });

    test('?theme= wins', () => {
        const { theme } = mount({ search: '?theme=classic' });
        eq(theme.current, 'classic');
    });

    test('an embedded overlay inherits the shell\'s theme', () => {
        const { theme } = mount({ search: '', parentSearch: '?theme=classic&debug=1' });
        eq(theme.current, 'classic');
    });

    test('the overlay\'s own theme wins over the shell\'s', () => {
        const { theme } = mount({ search: '?theme=wec', parentSearch: '?theme=classic' });
        eq(theme.current, 'wec');
    });

    test('data-default overrides the fallback name', () => {
        const { theme } = mount({ dataset: { themes: '../../themes', default: 'house-style' } });
        eq(theme.current, 'house-style');
    });

    test('the stylesheet path comes from data-themes', () => {
        const { link } = mount({ dataset: { themes: '/brand/looks' } });
        ok(link.href.endsWith('/brand/looks/default.css'), link.href);
    });
});

suite('theme · safety', () => {
    test('a path-traversal name is refused', () => {
        // The name comes off a URL, so it must never reach an href unchecked.
        const { theme } = mount({ search: '?theme=../../../etc/passwd' });
        eq(theme.current, 'default', 'fell back instead of building that path');
    });

    test('an absolute URL as a name is refused', () => {
        const { theme } = mount({ search: '?theme=http://evil.example/x' });
        eq(theme.current, 'default');
    });

    test('set() refuses the same nonsense at runtime', () => {
        const { theme } = mount();
        eq(theme.set('../secrets'), false);
        eq(theme.set(''), false);
        eq(theme.set(null), false);
        eq(theme.current, 'default');
    });
});

suite('theme · switching', () => {
    test('set() swaps the stylesheet and stamps the root', () => {
        const { theme, link, env } = mount();
        eq(theme.set('classic'), true);
        eq(theme.current, 'classic');
        ok(link.href.endsWith('classic.css'), link.href);
        eq(env.document.documentElement.getAttribute('data-theme'), 'classic');
    });

    test('a THEME_SET message switches it', () => {
        const { theme, env } = mount();
        env.dispatch('message', { type: 'THEME_SET', theme: 'classic' });
        eq(theme.current, 'classic');
    });

    test('a missing stylesheet falls back to the default', () => {
        const { theme, link } = mount({ search: '?theme=nonexistent' });
        eq(theme.current, 'nonexistent');
        quiet(() => link.onerror());
        eq(theme.current, 'default', 'a 404 must not leave a half-applied look');
    });
});
