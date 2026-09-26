#!/usr/bin/env node
/**
 * acokit test runner — `node test/run.js` (or `npm test` from acokit/).
 *
 * Discovers every *.test.js beside it, runs them, prints one line per suite
 * and exits non-zero on the first failure so CI (or a pre-push hook) can gate
 * on it. No dependencies, no config, no watch mode — the kit has no build
 * step and its tests should not need one either.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { suites, AssertionError } = require('./harness');

const only = process.argv[2];          // optional substring filter

for (const f of fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort()) {
    require(path.join(__dirname, f));
}

let passed = 0, failed = 0;
const failures = [];

async function main() {
for (const s of suites) {
    const tests = only ? s.tests.filter(t => (s.name + ' ' + t.name).includes(only)) : s.tests;
    if (!tests.length) continue;
    const marks = [];
    for (const t of tests) {
        try {
            await t.fn();
            passed++;
            marks.push('.');
        } catch (e) {
            failed++;
            marks.push('x');
            failures.push({ suite: s.name, test: t.name, err: e });
        }
    }
    const status = marks.includes('x') ? 'FAIL' : 'ok  ';
    console.log(`  ${status}  ${s.name.padEnd(42)} ${marks.join('')}`);
}

if (failures.length) {
    console.log('');
    for (const f of failures) {
        console.log(`  ${f.suite} → ${f.test}`);
        console.log(`      ${f.err instanceof AssertionError ? f.err.message : (f.err && f.err.stack) || f.err}`);
    }
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
}

main();
