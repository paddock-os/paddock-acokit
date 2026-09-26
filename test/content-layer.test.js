/**
 * acokit-content — the seam where a league adds its identity.
 *
 * Two things worth protecting here. The roster is STRICT on purpose: an
 * unknown name returns null so an overlay skips the driver instead of
 * rendering a blank row with no team colour. And the tyre labeller is
 * explicitly mod-specific — one mod's C5 is another's medium — so its
 * fallbacks need to stay exactly as documented.
 */
'use strict';

const { suite, test, eq, ok, browserEnv, loadSdk } = require('./harness');

function mount(fetchImpl) {
    const env = browserEnv();
    if (fetchImpl) env.window.fetch = fetchImpl;
    loadSdk('sdk/acokit-content.js', env, { fetch: fetchImpl });
    return { env, C: env.window.ACOKitContent };
}

/** A fetch that answers one URL with one JSON body. */
function fakeFetch(body, ok_ = true, status = 200) {
    return async () => ({ ok: ok_, status, json: async () => body });
}

const GRID = {
    drivers: {
        'Lena Vogt': { team: 'Northline Racing', number: '1', color: '#1e41ff', logo: 'img/northline.png' },
        'Lando Norris': { team: 'McLaren', number: '4', color: '#ff8000', logo: 'img/mcl.png' },
    },
};

suite('content · roster loading', () => {
    test('loads the documented { drivers: … } shape', async () => {
        const { C } = mount(fakeFetch(GRID));
        const roster = await C.loadRoster('/x.json');
        eq(roster.loaded, true);
        eq(roster.meta('Lena Vogt').team, 'Northline Racing');
    });

    test('also accepts the bare map', async () => {
        const { C } = mount(fakeFetch(GRID.drivers));
        const roster = await C.loadRoster('/x.json');
        eq(roster.meta('Lando Norris').number, '4');
    });

    test('a failed fetch throws rather than loading an empty grid', async () => {
        // Silently ending up with an empty roster would make every overlay
        // skip every driver — a blank broadcast with no error anywhere.
        const { C } = mount(fakeFetch(null, false, 404));
        let threw = null;
        try { await C.loadRoster('/missing.json'); } catch (e) { threw = e; }
        ok(threw, 'expected a throw');
        ok(String(threw.message).includes('404'), threw && threw.message);
    });

    test('reloading replaces the grid instead of merging into it', async () => {
        const { env, C } = mount(fakeFetch(GRID));
        const roster = await C.loadRoster('/x.json');
        env.window.fetch = fakeFetch({ drivers: { 'Nora Blake': { team: 'Harbour GP' } } });
        await roster.load('/y.json');
        eq(roster.meta('Lena Vogt'), null, 'last season is gone');
        eq(roster.meta('Nora Blake').team, 'Harbour GP');
    });
});

suite('content · roster lookup', () => {
    async function loaded() {
        const { C } = mount(fakeFetch(GRID));
        return C.loadRoster('/x.json');
    }

    test('is strict: an unknown name is null, never a default', async () => {
        const roster = await loaded();
        eq(roster.meta('Some Randomer'), null);
    });

    test('empty input is null, not a crash', async () => {
        const roster = await loaded();
        eq(roster.meta(''), null);
        eq(roster.meta(null), null);
        eq(roster.meta(undefined), null);
    });

    test('matching ignores case, because upstream capitalisation drifts', async () => {
        const roster = await loaded();
        eq(roster.meta('lena vogt').team, 'Northline Racing');
        eq(roster.meta('LENA VOGT').team, 'Northline Racing');
    });

    test('index gives a stable roster order for sorting', async () => {
        const roster = await loaded();
        eq(roster.index('Lena Vogt'), 0);
        eq(roster.index('Lando Norris'), 1);
        eq(roster.index('Some Randomer'), Infinity, 'unknowns sort last, not first');
    });
});

suite('content · tyre labeller', () => {
    test('named compounds pass straight through', () => {
        const { C, env } = mount();
        const label = C.tyreLabeller();
        eq(label('Hard'), 'H');
        eq(label('medium'), 'M');
        eq(label('SOFT'), 'S');
        eq(label('Intermediate'), 'I');
        eq(label('wet'), 'W');
        env.restore && env.restore();
    });

    test('C-codes fall back to the Pirelli-ish convention', () => {
        const { C } = mount();
        const label = C.tyreLabeller();
        eq(label('C1'), 'H');
        eq(label('C2'), 'H');
        eq(label('C3'), 'M');
        eq(label('C4'), 'S');
        eq(label('C5'), 'SS');
    });

    test('overrides win, because the mapping is mod-specific', () => {
        // The whole reason this is a factory: one mod's C3 is another's soft.
        const { C } = mount();
        const label = C.tyreLabeller({ C3: 'H', C4: 'M', C5: 'S' });
        eq(label('C3'), 'H');
        eq(label('C4'), 'M');
        eq(label('C5'), 'S');
    });

    test('it finds the code inside a longer mod name', () => {
        const { C } = mount();
        const label = C.tyreLabeller();
        eq(label('mod_openwheel_2024_C4'), 'S');
    });

    test('anything unrecognised is "?" — never a wrong compound', () => {
        const { C } = mount();
        const label = C.tyreLabeller();
        eq(label('banana'), '?');
        eq(label(''), '?');
        eq(label(null), '?');
        eq(label(undefined), '?');
    });
});
