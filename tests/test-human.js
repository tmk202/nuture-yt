/**
 * Unit tests for lib/human.js — random, delay, watch curve.
 */
'use strict';
require('./mock-chrome');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const { test, assert, group, run } = require('./framework');

// Load the lib (it self-registers to global)
require(path.join(ROOT, 'lib', 'human.js'));

group('lib/human', () => {
  test('rand(min,max) returns value in range', () => {
    for (let i = 0; i < 100; i++) {
      const v = Human.rand(5, 10);
      assert.inRange(v, 5, 10);
    }
  });

  test('randInt(min,max) returns integer in range', () => {
    for (let i = 0; i < 100; i++) {
      const v = Human.randInt(5, 10);
      assert.equal(Number.isInteger(v), true);
      assert.inRange(v, 5, 10);
    }
  });

  test('pick(arr) returns an element of the array', () => {
    const arr = ['a', 'b', 'c'];
    for (let i = 0; i < 50; i++) {
      assert.truthy(arr.includes(Human.pick(arr)));
    }
  });

  test('pick(empty) returns undefined', () => {
    assert.equal(Human.pick([]), undefined);
  });

  test('humanDelay(min,max) returns int in range', () => {
    for (let i = 0; i < 50; i++) {
      const v = Human.humanDelay(800, 2500);
      assert.equal(Number.isInteger(v), true);
      assert.inRange(v, 800, 2500);
    }
  });

  test('bigDelay returns 30s..5min (300000ms)', () => {
    for (let i = 0; i < 50; i++) {
      const v = Human.bigDelay();
      assert.inRange(v, 30000, 300000);
    }
  });

  test('watchTimeCurve caps at 600s for long videos', () => {
    for (let i = 0; i < 20; i++) {
      const v = Human.watchTimeCurve(3600);
      assert.inRange(v, 180, 600);
    }
  });

  test('watchTimeCurve respects minimum 20s for short videos', () => {
    for (let i = 0; i < 20; i++) {
      const v = Human.watchTimeCurve(30);
      assert.inRange(v, 20, 30);
    }
  });

  test('watchTimeCurve returns ~30-90% of duration for medium videos', () => {
    for (let i = 0; i < 30; i++) {
      const v = Human.watchTimeCurve(120);
      assert.inRange(v, 20, 108);
    }
  });

  test('weightedPick respects weights over many trials', () => {
    const counts = { A: 0, B: 0, C: 0 };
    const items = [
      { value: 'A', weight: 9 },
      { value: 'B', weight: 1 },
    ];
    for (let i = 0; i < 1000; i++) counts[Human.weightedPick(items)]++;
    // A:B ratio should be roughly 9:1
    assert.truthy(counts.A > counts.B * 5, `expected A > B*5, got A=${counts.A} B=${counts.B}`);
  });
});

if (require.main === module) run();
