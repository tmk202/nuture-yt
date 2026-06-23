/**
 * Tests for lib/store.js — uses mock chrome.storage.
 * Each test calls freshState() to reset.
 */
'use strict';
const { resetStore } = require('./mock-chrome');
require('./mock-chrome');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const { test, assert, group, run } = require('./framework');

require(path.join(ROOT, 'lib', 'store.js'));

function freshState() {
  resetStore();
}

function defaultSettings() {
  return {
    activeHours: { start: 8, end: 23 },
    actionsPerDay: { min: 8, max: 20 },
    ratios: { comment: 0.15, like: 0.45, subscribe: 0.05, watch: 1.0 },
    watch: { maxSeconds: 600 },
    cooldownAfterCheckpointHours: 24,
    newAccount: { noCommentDays: 14, actionMultiplier: 0.5 },
  };
}

group('lib/store', () => {
  test('getState returns DEFAULT_STATE when storage empty', async () => {
    freshState();
    const s = await Store.getState();
    assert.truthy(s.settings, 'missing settings');
    assert.truthy(s.account, 'missing account');
    assert.deepEqual(s.channels, []);
    assert.equal(s.running, false);
  });

  test('MAX_CHANNELS exported and is 10', () => {
    assert.equal(Store.MAX_CHANNELS, 10);
  });

  test('accountAgeDays returns 0 for fresh account', async () => {
    freshState();
    const s = await Store.getState();
    assert.equal(Store.accountAgeDays(s), 0);
  });

  test('accountAgeDays returns N for account created N days ago', async () => {
    freshState();
    const s = await Store.getState();
    s.account.createdAt = new Date(Date.now() - 5 * 86400000).toISOString();
    assert.equal(Store.accountAgeDays(s), 5);
  });

  test('canComment false for account < 14 days', async () => {
    freshState();
    const s = await Store.getState();
    s.account.createdAt = new Date(Date.now() - 5 * 86400000).toISOString();
    assert.equal(Store.canComment(s), false);
  });

  test('canComment true for account >= 14 days', async () => {
    freshState();
    const s = await Store.getState();
    s.account.createdAt = new Date(Date.now() - 30 * 86400000).toISOString();
    assert.equal(Store.canComment(s), true);
  });

  test('isInActiveHours with explicit hour override', async () => {
    freshState();
    const s = await Store.getState();
    s.settings.activeHours = { start: 0, end: 24 };
    // isInActiveHours takes settings object, not state
    assert.equal(Store.isInActiveHours(s.settings), true);
  });

  test('isInActiveHours false when range excludes current hour', async () => {
    freshState();
    const s = await Store.getState();
    s.settings.activeHours = { start: 14, end: 14 };
    let trueCount = 0;
    for (let i = 0; i < 10; i++) {
      if (Store.isInActiveHours(s.settings)) trueCount++;
    }
    assert.truthy(trueCount <= 1, `expected <=1 true, got ${trueCount}`);
  });

  test('canAct blocked with all-day-off settings', async () => {
    freshState();
    const s = await Store.getState();
    s.settings.activeHours = { start: 0, end: 0 };
    const r = Store.canAct(s);
    assert.equal(r.allowed, false);
  });

  test('canAct allowed with always-on settings and empty stats', async () => {
    freshState();
    const s = await Store.getState();
    s.settings.activeHours = { start: 0, end: 24 };
    const r = Store.canAct(s);
    assert.equal(r.allowed, true);
  });

  test('canAct blocked when daily cap reached', async () => {
    freshState();
    const s = await Store.getState();
    s.settings.activeHours = { start: 0, end: 24 };
    const today = Store.todayKey();
    s.stats[today] = { watch: 20, like: 0, comment: 0, subscribe: 0, total: 20 };
    const r = Store.canAct(s);
    assert.equal(r.allowed, false);
    assert.match(/cap reached/i, r.reason);
  });

  test('canAct blocked during checkpoint cooldown (when cap not reached)', async () => {
    freshState();
    const s = await Store.getState();
    s.settings.activeHours = { start: 0, end: 24 };
    // No stats yet (total=0), but checkpoint just happened
    s.lastCheckpointAt = new Date().toISOString();
    const r = Store.canAct(s);
    assert.equal(r.allowed, false);
    assert.match(/checkpoint/i, r.reason);
  });

  test('canAct allowed after 24h cooldown', async () => {
    freshState();
    const s = await Store.getState();
    s.settings.activeHours = { start: 0, end: 24 };
    s.lastCheckpointAt = new Date(Date.now() - 25 * 3600000).toISOString();
    const r = Store.canAct(s);
    assert.equal(r.allowed, true);
  });

  test('dailyActionCap reduced for new account', async () => {
    freshState();
    const s = await Store.getState();
    s.account.createdAt = new Date(Date.now() - 5 * 86400000).toISOString();
    const cap = Store.dailyActionCap(s);
    assert.truthy(cap < s.settings.actionsPerDay.max, `expected reduced cap, got ${cap}`);
  });

  test('dailyActionCap full for old account', async () => {
    freshState();
    const s = await Store.getState();
    s.account.createdAt = new Date(Date.now() - 60 * 86400000).toISOString();
    const cap = Store.dailyActionCap(s);
    assert.equal(cap, s.settings.actionsPerDay.max);
  });

  test('recordAction increments today stat (clean state)', async () => {
    freshState();
    await Store.setState({ stats: {} });
    await Store.recordAction('watch');
    const s = await Store.getState();
    const today = Store.todayKey();
    assert.equal(s.stats[today].watch, 1);
    assert.equal(s.stats[today].total, 1);
  });

  test('recordAction multiple actions accumulate (clean state)', async () => {
    freshState();
    await Store.setState({ stats: {} });
    await Store.recordAction('watch');
    await Store.recordAction('watch');
    await Store.recordAction('like');
    const s = await Store.getState();
    const today = Store.todayKey();
    assert.equal(s.stats[today].watch, 2);
    assert.equal(s.stats[today].like, 1);
    assert.equal(s.stats[today].total, 3);
  });

  test('recordCheckpoint sets lastCheckpointAt', async () => {
    freshState();
    await Store.recordCheckpoint();
    const s = await Store.getState();
    assert.truthy(s.lastCheckpointAt);
  });

  test('computePrimaryNiche returns null for empty list', () => {
    assert.equal(Store.computePrimaryNiche([]), null);
  });

  test('computePrimaryNiche picks most common niche', () => {
    const channels = [
      { niche: 'craft-diy' },
      { niche: 'craft-diy' },
      { niche: 'craft-diy' },
      { niche: 'tutorial' },
      { niche: 'lifestyle' },
    ];
    const r = Store.computePrimaryNiche(channels);
    assert.equal(r.niche, 'craft-diy');
    assert.equal(r.count, 3);
    assert.equal(r.total, 5);
  });

  test('computePrimaryNiche tie-breaks by first occurrence', () => {
    const channels = [
      { niche: 'craft-diy' },
      { niche: 'tutorial' },
      { niche: 'craft-diy' },
      { niche: 'tutorial' },
    ];
    const r = Store.computePrimaryNiche(channels);
    assert.equal(r.niche, 'craft-diy');
  });

  test('setState persists across getState calls', async () => {
    freshState();
    await Store.setState({ running: true });
    const s = await Store.getState();
    assert.equal(s.running, true);
  });
});

if (require.main === module) run();
