/**
 * The overlay lifecycle — the part of the kit most likely to break an actual
 * broadcast, because every failure mode is silent: a widget that never
 * presents, a stopwatch that never ticks, a loop that never stops.
 *
 * Every case below is one that has really happened in this project.
 */
'use strict';

const { suite, test, eq, ok, quiet, browserEnv, loadSdk } = require('./harness');

/** Fresh window with acokit + the lifecycle loaded. */
function mount(opts) {
    const env = browserEnv(opts);
    env.install();
    loadSdk('sdk/acokit.js', env);
    loadSdk('sdk/acokit-overlay.js', env);
    return env;
}

suite('lifecycle · visibility', () => {
    test('standalone page is visible and stays visible', () => {
        const env = mount();                       // no parentSearch → top-level
        const o = env.window.ACOverlay.init('x');
        eq(o.embedded, false);
        eq(o.visible, true);
        env.dispatch('message', { type: 'OVERLAY_HIDE', overlay: 'x' });
        eq(o.visible, true, 'a shell message must not gate a page with no shell');
        env.restore();
    });

    test('embedded overlay is visible before the shell says anything', () => {
        const env = mount({ parentSearch: '' });
        const o = env.window.ACOverlay.init('x');
        eq(o.embedded, true);
        eq(o.visible, true, 'not-yet-told counts as visible');
        env.restore();
    });

    test('hide then show flips visibility', () => {
        const env = mount({ parentSearch: '' });
        const o = env.window.ACOverlay.init('x');
        env.dispatch('message', { type: 'OVERLAY_HIDE', overlay: 'x' });
        eq(o.visible, false);
        env.dispatch('message', { type: 'OVERLAY_SHOW', overlay: 'x' });
        eq(o.visible, true);
        env.restore();
    });

    test('a hide from a window that is not the shell is ignored', () => {
        const env = mount({ parentSearch: '' });
        const o = env.window.ACOverlay.init('x');
        env.dispatch('message', { type: 'OVERLAY_HIDE', overlay: 'x' }, {});
        eq(o.visible, true, 'only the parent of the frame may gate it');
        env.restore();
    });

    test('messages addressed to another overlay are ignored', () => {
        const env = mount({ parentSearch: '' });
        const o = env.window.ACOverlay.init('x');
        env.dispatch('message', { type: 'OVERLAY_HIDE', overlay: 'someone_else' });
        eq(o.visible, true);
        env.restore();
    });
});

suite('lifecycle · onShow / onHide', () => {
    test('onShow fires when SHOW is the FIRST message', () => {
        // The regression that made starting_grid never present: an initial
        // state of "visible" swallowed the first SHOW as a non-transition.
        const env = mount({ parentSearch: '' });
        const o = env.window.ACOverlay.init('grid');
        let shown = 0;
        o.onShow(() => shown++);
        env.dispatch('message', { type: 'OVERLAY_SHOW', overlay: 'grid' });
        eq(shown, 1);
        env.restore();
    });

    test('onShow does not fire twice for repeated SHOW', () => {
        const env = mount({ parentSearch: '' });
        const o = env.window.ACOverlay.init('grid');
        let shown = 0;
        o.onShow(() => shown++);
        env.dispatch('message', { type: 'OVERLAY_SHOW', overlay: 'grid' });
        env.dispatch('message', { type: 'OVERLAY_SHOW', overlay: 'grid' });
        eq(shown, 1);
        env.restore();
    });

    test('onHide fires on the transition, and only then', () => {
        const env = mount({ parentSearch: '' });
        const o = env.window.ACOverlay.init('x');
        let hidden = 0;
        o.onHide(() => hidden++);
        env.dispatch('message', { type: 'OVERLAY_HIDE', overlay: 'x' });
        env.dispatch('message', { type: 'OVERLAY_HIDE', overlay: 'x' });
        eq(hidden, 1);
        env.restore();
    });

    test('a throwing handler does not take the overlay down', () => {
        const env = mount({ parentSearch: '' });
        const o = env.window.ACOverlay.init('x');
        let second = 0;
        o.onShow(() => { throw new Error('boom'); });
        o.onShow(() => second++);
        quiet(() => env.dispatch('message', { type: 'OVERLAY_SHOW', overlay: 'x' }));
        eq(second, 1, 'the second handler still runs');
        env.restore();
    });
});

suite('lifecycle · loops', () => {
    test('a loop runs while visible', () => {
        const env = mount({ parentSearch: '' });
        const o = env.window.ACOverlay.init('x');
        let n = 0;
        o.loop(() => n++);
        env.frame(3);
        eq(n, 3);
        env.restore();
    });

    test('a loop stops while hidden and resumes on show', () => {
        const env = mount({ parentSearch: '' });
        const o = env.window.ACOverlay.init('x');
        let n = 0;
        o.loop(() => n++);
        env.frame();
        eq(n, 1);
        env.dispatch('message', { type: 'OVERLAY_HIDE', overlay: 'x' });
        eq(env.pending(), 0, 'nothing queued while hidden');
        env.frame(5);
        eq(n, 1, 'no work done behind a faded-out iframe');
        env.dispatch('message', { type: 'OVERLAY_SHOW', overlay: 'x' });
        env.frame();
        eq(n, 2, 'resumed');
        env.restore();
    });

    test('a standalone loop keeps running with no shell to tell it to', () => {
        // The regression that froze pit_tracker's stopwatches outside the
        // shell: the loop was gated on a message only a shell ever sends.
        const env = mount();
        const o = env.window.ACOverlay.init('x');
        let n = 0;
        o.loop(() => n++);
        env.frame(4);
        eq(n, 4);
        env.restore();
    });

    test('hz throttles without stopping the loop', () => {
        const env = mount({ parentSearch: '' });
        const o = env.window.ACOverlay.init('x');
        let n = 0;
        o.loop(() => n++, { hz: 10 });      // 100ms between callbacks
        env.frame();                         // first frame always runs
        eq(n, 1);
        env.advance(30); env.frame();
        env.advance(30); env.frame();
        eq(n, 1, 'still inside the throttle window');
        env.advance(50); env.frame();
        eq(n, 2, 'fired once 100ms elapsed');
        env.restore();
    });

    test('returning false parks the loop until start()', () => {
        const env = mount({ parentSearch: '' });
        const o = env.window.ACOverlay.init('x');
        let n = 0, keep = true;
        const l = o.loop(() => { n++; return keep; });
        env.frame(2);
        eq(n, 2);
        keep = false;
        env.frame();                 // runs once more, returns false → parks
        eq(n, 3);
        eq(env.pending(), 0, 'parked: nothing queued');
        env.frame(3);
        eq(n, 3, 'stays parked');
        keep = true;
        l.start();
        env.frame();
        eq(n, 4, 're-armed');
        env.restore();
    });

    test('stop() is final — a later show does not resurrect it', () => {
        const env = mount({ parentSearch: '' });
        const o = env.window.ACOverlay.init('x');
        let n = 0;
        const l = o.loop(() => n++);
        env.frame();
        l.stop();
        env.dispatch('message', { type: 'OVERLAY_HIDE', overlay: 'x' });
        env.dispatch('message', { type: 'OVERLAY_SHOW', overlay: 'x' });
        env.frame(3);
        eq(n, 1);
        env.restore();
    });

    test('autostart:false waits for start()', () => {
        const env = mount({ parentSearch: '' });
        const o = env.window.ACOverlay.init('x');
        let n = 0;
        const l = o.loop(() => n++, { autostart: false });
        env.frame(2);
        eq(n, 0);
        l.start();
        env.frame();
        eq(n, 1);
        env.restore();
    });

    test('a throwing loop body does not kill the loop', () => {
        const env = mount({ parentSearch: '' });
        const o = env.window.ACOverlay.init('x');
        let n = 0;
        o.loop(() => { n++; throw new Error('boom'); });
        quiet(() => env.frame(3));
        eq(n, 3);
        env.restore();
    });
});

suite('lifecycle · scale handshake', () => {
    test('?scale= is applied immediately', () => {
        const env = mount({ search: '?scale=1.75' });
        env.window.ACOverlay.init('x', { scaleVar: '--s' });
        eq(env.style.getPropertyValue('--s'), '1.75');
        env.restore();
    });

    test('SCALE_CAPABLE is announced to the parent when embedded', () => {
        const env = mount({ parentSearch: '' });
        env.window.ACOverlay.init('leaderboard', { scaleVar: '--s' });
        ok(env.posted.some(m => m.type === 'SCALE_CAPABLE' && m.overlay === 'leaderboard'));
        env.restore();
    });

    test('nothing is announced when there is no shell', () => {
        const env = mount();
        env.window.ACOverlay.init('x', { scaleVar: '--s' });
        eq(env.posted.length, 0);
        env.restore();
    });

    test('SET_SCALE from the shell applies', () => {
        const env = mount({ parentSearch: '' });
        env.window.ACOverlay.init('x', { scaleVar: '--s' });
        env.dispatch('message', { type: 'SET_SCALE', value: 2.5 });
        eq(env.style.getPropertyValue('--s'), '2.5');
        env.restore();
    });

    test('SET_SCALE from a window that is not the shell is ignored', () => {
        const env = mount({ search: '?scale=1.2', parentSearch: '' });
        env.window.ACOverlay.init('x', { scaleVar: '--s' });
        env.dispatch('message', { type: 'SET_SCALE', value: 2.5 }, {});
        eq(env.style.getPropertyValue('--s'), '1.2');
        env.restore();
    });

    test('a nonsense SET_SCALE is ignored', () => {
        const env = mount({ search: '?scale=1.2', parentSearch: '' });
        env.window.ACOverlay.init('x', { scaleVar: '--s' });
        env.dispatch('message', { type: 'SET_SCALE', value: 0 });
        env.dispatch('message', { type: 'SET_SCALE', value: 'big' });
        eq(env.style.getPropertyValue('--s'), '1.2', 'kept the sane value');
        env.restore();
    });
});
