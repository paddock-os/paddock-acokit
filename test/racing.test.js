/**
 * acokit-racing — the opt-in timing helpers.
 *
 * This is where a bug is invisible until it is on air: a clock that does not
 * start, a lap that completes twice, a sector that fires at the wrong moment.
 * All of it is pure logic over a clock, so all of it is testable — the harness
 * drives Date.now() by hand.
 */
'use strict';

const { suite, test, eq, ok, browserEnv, loadSdk } = require('./harness');

function mount() {
    const env = browserEnv();
    env.install();
    loadSdk('sdk/acokit-racing.js', env);
    return { env, R: env.window.ACOKitRacing };
}

suite('racing · formatters', () => {
    test('gearLabel maps the plugin encoding', () => {
        const { R, env } = mount();
        eq(R.gearLabel(0), 'R');
        eq(R.gearLabel(1), 'N');
        eq(R.gearLabel(2), '1', 'the plugin sends 1st as 2');
        eq(R.gearLabel(9), '8');
        env.restore();
    });

    test('fmtLap drops the minute when there is none', () => {
        const { R, env } = mount();
        eq(R.fmtLap(85553), '1:25.553');
        eq(R.fmtLap(59214), '59.214', 'under a minute: no leading 0:');
        eq(R.fmtLap(3599999), '59:59.999');
        env.restore();
    });

    test('fmtLap has one string for "no lap yet"', () => {
        const { R, env } = mount();
        eq(R.fmtLap(0), '--:--.---');
        eq(R.fmtLap(-1), '--:--.---');
        eq(R.fmtLap(NaN), '--:--.---');
        eq(R.fmtLap(undefined), '--:--.---');
        env.restore();
    });

    test('fmtSector is blank when there is nothing to show', () => {
        const { R, env } = mount();
        eq(R.fmtSector(23643), '23.643');
        eq(R.fmtSector(63643), '1:03.643', 'a long sector still reads right');
        eq(R.fmtSector(0), '', 'blank, not --:--, because it sits in a bar');
        env.restore();
    });
});

suite('racing · LapClock', () => {
    test('reads zero until the first packet', () => {
        const { R, env } = mount();
        eq(new R.LapClock().ms(), 0);
        env.restore();
    });

    test('holds the last value and advances with the wall clock', () => {
        const { R, env } = mount();
        const c = new R.LapClock();
        c.update(10000);
        eq(Math.round(c.ms()), 10000);
        env.advance(100);
        eq(Math.round(c.ms()), 10100, 'interpolates between packets at ~1x');
        env.restore();
    });

    test('clamps a stalled feed instead of running away', () => {
        // Telemetry stops (paused replay, plugin died). Without the clamp the
        // clock would keep counting for ever and show a nonsense lap time.
        const { R, env } = mount();
        const c = new R.LapClock();
        c.update(10000);
        env.advance(10000);
        eq(Math.round(c.ms()), 10250, 'capped at 250ms past the last packet');
        env.restore();
    });

    test('tracks a slow-motion replay', () => {
        // Half-speed playback: 100ms of wall time carries 50ms of lap time.
        // The clock should converge on that rate rather than sprinting ahead.
        const { R, env } = mount();
        const c = new R.LapClock();
        let lap = 10000;
        c.update(lap);
        for (let i = 0; i < 20; i++) {
            env.advance(100);
            lap += 50;
            c.update(lap);
        }
        ok(c.rate < 0.75, `rate converged towards 0.5, got ${c.rate.toFixed(3)}`);
        env.restore();
    });
});

suite('racing · LapWatcher', () => {
    /** Feed a series of {lapTimeMs, …} packets and record the callbacks. */
    function watch(packets, opts) {
        const { R, env } = mount();
        const events = [];
        const w = new R.LapWatcher({
            onStart: () => events.push('start'),
            onComplete: (ms) => events.push('complete:' + ms),
            ...(opts || {}),
        });
        packets.forEach(p => w.feed(typeof p === 'number' ? { lapTimeMs: p } : p));
        env.restore();
        return { events, w };
    }

    test('the first crossing starts, it does not complete', () => {
        // Arming matters: an overlay that mounts mid-lap has no idea how much
        // of that lap it missed, so the first line crossing is a start.
        const { events } = watch([20000, 40000, 60000, 100]);
        eq(events, ['start']);
    });

    test('the second crossing completes with the plugin total', () => {
        const { events } = watch([
            20000, 60000, { lapTimeMs: 100 },                        // arm
            20000, 60000, { lapTimeMs: 100, completedLapMs: 84321 }, // full lap
        ]);
        eq(events, ['start', 'complete:84321']);
    });

    test('without a plugin total it falls back to the last clock value', () => {
        const { events } = watch([20000, 60000, 100, 20000, 84000, 100]);
        eq(events, ['start', 'complete:84000']);
    });

    test('a lapEvent bump counts as a crossing even if the clock did not reset', () => {
        const { events } = watch([
            { lapTimeMs: 20000, lapEvent: 0 },
            { lapTimeMs: 40000, lapEvent: 0 },
            { lapTimeMs: 41000, lapEvent: 1 },   // the plugin says: new lap
        ]);
        eq(events, ['start']);
    });

    test('a normally growing lap never looks like a crossing', () => {
        const { events } = watch([1000, 5000, 20000, 45000, 83000]);
        eq(events, []);
    });

    test('a tiny dip is not a crossing', () => {
        // Telemetry jitter can walk the clock backwards a few ms; only a real
        // reset (a big drop from a big number) is a lap.
        const { events } = watch([20000, 19900, 20100]);
        eq(events, []);
    });
});

suite('racing · SectorTimer', () => {
    const SECTORS = [23643, 37435, 24475];   // 85.553s total

    test('each sector fires once, in order', () => {
        const { R, env } = mount();
        const st = new R.SectorTimer(SECTORS);
        eq(st.update(10000), []);
        eq(st.update(23643), [0], 'exactly on the boundary counts');
        eq(st.update(30000), []);
        eq(st.update(61078), [1]);
        eq(st.update(85553), [2]);
        eq(st.update(90000), [], 'no repeats');
        env.restore();
    });

    test('a jump forward fires everything it passed', () => {
        // Scrubbing a replay must not leave sectors silently unfired.
        const { R, env } = mount();
        const st = new R.SectorTimer(SECTORS);
        eq(st.update(90000), [0, 1, 2]);
        env.restore();
    });

    test('fill is the 0..1 progress inside the current sector', () => {
        const { R, env } = mount();
        const st = new R.SectorTimer(SECTORS);
        eq(st.fill(0, 0), 0);
        eq(Math.round(st.fill(0, 23643 / 2) * 100), 50);
        eq(st.fill(0, 23643), 1);
        eq(st.fill(1, 0), 0, 'a sector not started yet is empty');
        eq(Math.round(st.fill(1, 23643 + 37435 / 2) * 100), 50);
        eq(st.fill(2, 999999), 1, 'never past full');
        env.restore();
    });

    test('a completed sector stays full', () => {
        const { R, env } = mount();
        const st = new R.SectorTimer(SECTORS);
        st.update(85553);
        eq(st.fill(0, 0), 1, 'done means done, whatever the clock says now');
        env.restore();
    });

    test('reset re-arms for the next lap', () => {
        const { R, env } = mount();
        const st = new R.SectorTimer(SECTORS);
        st.update(90000);
        st.reset();
        eq(st.update(23643), [0]);
        env.restore();
    });

    test('total is the sum, for a progress bar', () => {
        const { R, env } = mount();
        eq(new R.SectorTimer(SECTORS).total, 85553);
        env.restore();
    });
});
