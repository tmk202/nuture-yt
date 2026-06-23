/**
 * Tiny test framework + assert helpers. No external deps.
 *
 * Usage:
 *   const { test, assert, group } = require('./framework');
 *   test('add works', () => { assert.equal(1+1, 2); });
 */
'use strict';

const tests = [];
let currentGroup = 'default';

function test(name, fn) {
  tests.push({ name, fn, group: currentGroup });
}
function group(name, fn) {
  const prev = currentGroup;
  currentGroup = name;
  fn();
  currentGroup = prev;
}

// ---- Assertions ----
const assert = {
  equal(a, b, msg) {
    if (a !== b) throw new Error(`equal failed: ${a} !== ${b}${msg ? ' — ' + msg : ''}`);
  },
  notEqual(a, b, msg) {
    if (a === b) throw new Error(`notEqual failed: ${a} === ${b}${msg ? ' — ' + msg : ''}`);
  },
  deepEqual(a, b, msg) {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      throw new Error(`deepEqual failed: ${JSON.stringify(a)} !== ${JSON.stringify(b)}${msg ? ' — ' + msg : ''}`);
    }
  },
  truthy(v, msg) {
    if (!v) throw new Error(`truthy failed: ${v}${msg ? ' — ' + msg : ''}`);
  },
  falsy(v, msg) {
    if (v) throw new Error(`falsy failed: ${v}${msg ? ' — ' + msg : ''}`);
  },
  ok(v, msg) { assert.truthy(v, msg); },
  throws(fn, msg) {
    try { fn(); } catch (e) { return; }
    throw new Error(`throws failed: function did not throw${msg ? ' — ' + msg : ''}`);
  },
  inRange(v, lo, hi, msg) {
    if (v < lo || v > hi) throw new Error(`inRange failed: ${v} not in [${lo}, ${hi}]${msg ? ' — ' + msg : ''}`);
  },
  match(re, v, msg) {
    if (!re.test(String(v))) throw new Error(`match failed: ${v} !~ ${re}${msg ? ' — ' + msg : ''}`);
  },
};

// ---- Runner ----
async function run(filterGroups = null) {
  const filtered = filterGroups
    ? tests.filter((t) => filterGroups.some((g) => t.group === g || t.group.startsWith(g)))
    : tests;
  let passed = 0, failed = 0;
  const failures = [];
  for (const t of filtered) {
    try {
      await t.fn();
      passed++;
      console.log(`  \x1b[32m✓\x1b[0m ${t.name}`);
    } catch (e) {
      failed++;
      failures.push({ name: t.name, error: e });
      console.log(`  \x1b[31m✗\x1b[0m ${t.name}`);
      console.log(`    \x1b[31m${e.message}\x1b[0m`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed (${filtered.length} total)`);
  if (failed > 0) process.exit(1);
}

module.exports = { test, assert, group, run, tests };
