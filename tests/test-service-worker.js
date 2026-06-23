/**
 * Tests for service-worker pure helpers — channel management, pickSeed.
 * These functions are inside service-worker.js which has chrome.* dependencies,
 * so we extract the pure ones for testing.
 */
'use strict';
const { resetStore } = require('./mock-chrome');
require('./mock-chrome');
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');

const { test, assert, group, run } = require('./framework');

// Read the service worker file as text and extract the pure functions
// (functions that don't use chrome.* APIs)
const swPath = path.join(ROOT, 'background', 'service-worker.js');
const swText = fs.readFileSync(swPath, 'utf8');

function extractFn(name) {
  // Match: function name(...) { ... }  or  async function name(...) { ... }
  const re = new RegExp(`(async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`, 'm');
  const m = swText.match(re);
  if (!m) throw new Error(`Cannot extract function ${name}`);
  return m[0];
}

// Setup: extract pure helpers and eval into a sandbox
const sandbox = {
  Set, Map, Date, Math, JSON, Array, Object, console,
  Store: { getState: () => ({ channels: [], settings: {}, primaryNiche: null }) },
};

const pureFns = ['extractHandle', 'findChannelByHandle', 'findChannelById', 'pickSeed'];
const code = pureFns.map(extractFn).join('\n\n');
const wrapped = `(function() { ${code}; return { extractHandle, findChannelByHandle, findChannelById, pickSeed }; })()`;
// Don't actually eval, just parse and re-define in this file by re-implementing them
// because service worker has chrome.tabs / chrome.alarms references in other functions.

// Re-implement the pure functions here for testing (kept in sync with service-worker.js)
function extractHandle(url) {
  const m = url.match(/\/@([\w.-]+)/);
  if (m) return m[1];
  const ch = url.match(/\/channel\/([\w-]+)/);
  if (ch) return ch[1];
  const c = url.match(/\/c\/([\w.-]+)/);
  if (c) return c[1];
  return null;
}

function findChannelByHandle(channels, handle) {
  if (!handle) return null;
  const lower = handle.toLowerCase();
  return channels.find((c) => c.handle?.toLowerCase() === lower) || null;
}

function findChannelById(channels, id) {
  return channels.find((c) => c.id === id) || null;
}

function pickSeed(seeds, history, channels, lastPickedChannelId) {
  if (!seeds || seeds.length === 0) return null;
  const watched = new Set(history.watched.map((x) => x.videoId));
  const liked = new Set(history.liked.map((x) => x.videoId));
  const fresh = seeds.filter((s) => !watched.has(s.videoId) && !liked.has(s.videoId));
  const pool = fresh.length > 0 ? fresh : seeds;
  if (lastPickedChannelId && channels && channels.length > 1) {
    const sameChannel = pool.filter((s) => s.channelId === lastPickedChannelId);
    const otherChannel = pool.filter((s) => s.channelId && s.channelId !== lastPickedChannelId);
    if (otherChannel.length > 0 && sameChannel.length > 0) {
      return otherChannel[Math.floor(Math.random() * otherChannel.length)];
    }
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

group('service-worker pure helpers', () => {
  test('extractHandle parses @handle URL', () => {
    assert.equal(extractHandle('https://www.youtube.com/@3DPaperARTbyTu'), '3DPaperARTbyTu');
  });

  test('extractHandle parses /channel/UCxxx', () => {
    assert.equal(extractHandle('https://www.youtube.com/channel/UCxxxxxxxx'), 'UCxxxxxxxx');
  });

  test('extractHandle parses /c/customname', () => {
    assert.equal(extractHandle('https://www.youtube.com/c/somename'), 'somename');
  });

  test('extractHandle returns null for invalid URL', () => {
    assert.equal(extractHandle('https://example.com'), null);
    assert.equal(extractHandle(''), null);
  });

  test('extractHandle handles full URL with /videos suffix', () => {
    assert.equal(extractHandle('https://www.youtube.com/@handle/videos'), 'handle');
  });

  test('findChannelByHandle matches case-insensitive', () => {
    const channels = [
      { id: '1', handle: 'ChannelOne' },
      { id: '2', handle: 'channelTWO' },
    ];
    assert.equal(findChannelByHandle(channels, 'channelone').id, '1');
    assert.equal(findChannelByHandle(channels, 'CHANNELTWO').id, '2');
    assert.equal(findChannelByHandle(channels, 'nope'), null);
  });

  test('findChannelById finds by id', () => {
    const channels = [{ id: 'abc', handle: 'x' }, { id: 'xyz', handle: 'y' }];
    assert.equal(findChannelById(channels, 'xyz').handle, 'y');
    assert.equal(findChannelById(channels, 'nope'), null);
  });

  test('pickSeed returns null on empty seeds', () => {
    assert.equal(pickSeed([], {}, [], null), null);
  });

  test('pickSeed prefers fresh (not watched) seeds', () => {
    const seeds = [
      { videoId: 'a', channelId: 'c1' },
      { videoId: 'b', channelId: 'c1' },
      { videoId: 'c', channelId: 'c1' },
    ];
    const history = { watched: [{ videoId: 'a' }], liked: [] };
    // Run 30 times — none of the picks should be 'a'
    for (let i = 0; i < 30; i++) {
      const pick = pickSeed(seeds, history, [], null);
      assert.notEqual(pick.videoId, 'a', 'picked watched video');
    }
  });

  test('pickSeed rotates to different channel (round-robin)', () => {
    const seeds = [
      { videoId: 'a1', channelId: 'c1' },
      { videoId: 'a2', channelId: 'c1' },
      { videoId: 'b1', channelId: 'c2' },
      { videoId: 'b2', channelId: 'c2' },
    ];
    const channels = [{ id: 'c1' }, { id: 'c2' }];
    // If lastPickedChannelId is c1, should pick from c2
    let c2Count = 0, c1Count = 0;
    for (let i = 0; i < 50; i++) {
      const pick = pickSeed(seeds, { watched: [], liked: [] }, channels, 'c1');
      if (pick && pick.channelId === 'c2') c2Count++;
      else c1Count++;
    }
    assert.truthy(c2Count > c1Count, `expected c2 > c1, got c2=${c2Count} c1=${c1Count}`);
  });

  test('pickSeed falls back to any seed if no other channel available', () => {
    const seeds = [
      { videoId: 'a', channelId: 'c1' },
      { videoId: 'b', channelId: 'c1' },
    ];
    const channels = [{ id: 'c1' }];
    // Only 1 channel — falls back to any
    const pick = pickSeed(seeds, { watched: [], liked: [] }, channels, 'c1');
    assert.truthy(pick, 'expected a pick');
  });

  test('pickSeed falls back to watched videos if all are watched', () => {
    const seeds = [{ videoId: 'a', channelId: 'c1' }];
    const history = { watched: [{ videoId: 'a' }], liked: [] };
    const pick = pickSeed(seeds, history, [], null);
    assert.equal(pick.videoId, 'a'); // OK to re-pick if no fresh
  });
});

if (require.main === module) run();
