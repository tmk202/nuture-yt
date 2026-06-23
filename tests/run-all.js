/**
 * Run all test files in sequence. Exit non-zero on any failure.
 *
 * Usage:
 *   node tests/run-all.js          (run all)
 *   node tests/run-all.js --lib    (only lib tests)
 *   node tests/run-all.js --sw     (only service-worker + integration)
 */
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const groups = {
  lib: ['test-human.js', 'test-templates-antiBan.js', 'test-niches.js', 'test-store.js'],
  sw: ['test-service-worker.js', 'test-integration.js'],
};

const arg = process.argv[2] || 'all';
const files = arg === 'all'
  ? [...groups.lib, ...groups.sw]
  : (groups[arg.replace('--', '')] || []);

if (files.length === 0) {
  console.error('Unknown group:', arg);
  process.exit(1);
}

let totalPass = 0, totalFail = 0;

for (const f of files) {
  console.log(`\n\x1b[1m\x1b[36m=== ${f} ===\x1b[0m`);
  const result = spawnSync('node', [path.join(__dirname, f)], {
    stdio: 'inherit',
    cwd: ROOT,
  });
  if (result.status === 0) {
    totalPass++;
  } else {
    totalFail++;
  }
}

console.log(`\n\x1b[1m========================================\x1b[0m`);
console.log(`\x1b[1m${files.length - totalFail}/${files.length} test files passed\x1b[0m`);
if (totalFail > 0) {
  console.log(`\x1b[31m${totalFail} test file(s) failed\x1b[0m`);
  process.exit(1);
} else {
  console.log(`\x1b[32mAll tests passed!\x1b[0m`);
}
