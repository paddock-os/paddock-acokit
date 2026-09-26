#!/usr/bin/env node
/**
 * Runs the Python plugin suite from the Node side, so `npm test` covers the
 * whole kit rather than only the half written in JavaScript.
 *
 * It runs the suite once PER COPY of the plugin. A project installs its own
 * copy into AC (the folder name is what shows up in AC's UI Modules list, so
 * it cannot simply be the engine's), which means this code lives twice — and
 * the last time the two drifted, the installed one had a lesson the engine
 * copy lacked for months, precisely because the tests only looked at one.
 * Testing the file that does not run is worse than not testing: it reads as
 * covered.
 *
 * The engine's copy is always tested. Point ACOKIT_PLUGIN_COPIES at your own
 * installed copies (separated like PATH: `;` on Windows, `:` elsewhere) and
 * the suite runs against each of them too:
 *
 *   ACOKIT_PLUGIN_COPIES=../apps/python/myleague/myleague.py npm run test:plugin
 *
 * Needs a Python 3 on PATH. Without one it SKIPS LOUDLY and exits 0 — a
 * missing interpreter is not a failure, but it must never look like a pass.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const KIT = path.join(__dirname, '..');
const SUITE = path.join(KIT, 'plugin', 'test', 'test_plugin.py');

// Every copy worth testing: the engine's, plus any a project installs.
const extra = (process.env.ACOKIT_PLUGIN_COPIES || '').split(path.delimiter).filter(Boolean);
const COPIES = [
    { label: 'engine', file: path.join(KIT, 'plugin', 'acokit_telemetry', 'acokit_telemetry.py') },
    ...extra.map(f => ({ label: 'installed', file: path.resolve(f) })),
];
for (const c of COPIES) {
    if (!fs.existsSync(c.file)) {
        console.log(`  FAIL  plugin · ${c.label} (${c.file} does not exist)`);
        process.exit(1);
    }
}

function findPython() {
    for (const bin of ['python3', 'python', 'py']) {
        const probe = spawnSync(bin, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
        if (probe.status === 0 && String(probe.stdout).trim().startsWith('3')) return bin;
    }
    return null;
}

const python = findPython();
if (!python) {
    console.log('  SKIP  plugin (python3 not found on PATH — the AC plugin suite did not run)\n');
    process.exit(0);
}

let total = 0, failed = 0;
for (const copy of COPIES) {
    const run = spawnSync(python, [SUITE], {
        encoding: 'utf8',
        env: { ...process.env, ACOKIT_PLUGIN: copy.file, ACOKIT_PLUGIN_COPIES: COPIES.map(c => c.file).join(path.delimiter) },
    });
    const out = (run.stdout || '') + (run.stderr || '');
    const ran = Number((out.match(/Ran (\d+) tests?/) || [, 0])[1]);
    total += ran;
    if (run.status === 0) {
        console.log(`  ok    plugin · ${copy.label.padEnd(10)} ${path.basename(copy.file).padEnd(24)} ${'.'.repeat(Math.min(ran, 40))}`);
    } else {
        failed++;
        console.log(`  FAIL  plugin · ${copy.label} (${path.basename(copy.file)})`);
        console.log(out.split('\n').filter(l => /^(FAIL|ERROR|AssertionError|\s+File|\s{4}\S)/.test(l)).slice(0, 20).join('\n'));
    }
}

console.log(`\n  ${total} passed, ${failed ? 'failures in ' + failed + ' copy/copies' : '0 failed'}\n`);
process.exit(failed ? 1 : 0);
