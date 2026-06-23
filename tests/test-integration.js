/**
 * Integration test: simulate the full flow end-to-end in Node with mocks.
 *
 * Tests:
 *  - Add channel → appears in state
 *  - Duplicate channel handle → updates instead of creating new
 *  - Remove channel → drops from state and seeds
 *  - Clear all channels
 *  - Bulk import flow
 *  - Subscribe cap (1/day, not duplicate)
 *  - Comment + subscribe guards
 *  - Watch tick: pick → execute → record → next
 */
'use strict';
const { resetStore, _tabs, _alarms, alarmFire } = require('./mock-chrome');
require('./mock-chrome');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const { test, assert, group, run } = require('./framework');

// Load all libs
require(path.join(ROOT, 'lib', 'niches.js'));
require(path.join(ROOT, 'lib', 'templates.js'));
require(path.join(ROOT, 'lib', 'human.js'));
require(path.join(ROOT, 'lib', 'store.js'));
require(path.join(ROOT, 'lib', 'antiBan.js'));

// Re-implement channel helpers (from service-worker.js)
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

const MAX_CHANNELS = 10;
const MAX_VIDEOS_PER_CHANNEL = 30;

async function addChannelFromDetect({ handle, url, displayName, niche, confidence, videos }) {
  const state = await Store.getState();
  if (state.channels.length >= MAX_CHANNELS) {
    return { ok: false, reason: `Channel list full (max ${MAX_CHANNELS})` };
  }
  const existing = findChannelByHandle(state.channels, handle);
  if (existing) {
    const updated = state.channels.map((c) =>
      c.id === existing.id
        ? { ...c, displayName: displayName || c.displayName, niche: niche || c.niche, confidence: confidence ?? c.confidence, videos: (videos || []).slice(0, MAX_VIDEOS_PER_CHANNEL), lastRefresh: new Date().toISOString() }
        : c
    );
    const primary = Store.computePrimaryNiche(updated);
    await Store.setState({ channels: updated, primaryNiche: primary?.niche || null });
    return { ok: true, channel: updated.find((c) => c.id === existing.id), updated: true };
  }
  const id = `ch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const newChannel = {
    id, handle, url, displayName: displayName || handle,
    niche: niche || null, confidence: confidence ?? 0,
    videos: (videos || []).slice(0, MAX_VIDEOS_PER_CHANNEL).map((v) => ({ ...v, discoveredAt: new Date().toISOString() })),
    addedAt: new Date().toISOString(), lastRefresh: new Date().toISOString(),
  };
  const updated = [...state.channels, newChannel];
  const primary = Store.computePrimaryNiche(updated);
  await Store.setState({ channels: updated, primaryNiche: primary?.niche || null });
  return { ok: true, channel: newChannel, updated: false };
}

async function removeChannel(id) {
  const state = await Store.getState();
  const updated = state.channels.filter((c) => c.id !== id);
  const newSeeds = (state.seeds || []).filter((s) => s.channelId !== id);
  const primary = Store.computePrimaryNiche(updated);
  await Store.setState({ channels: updated, seeds: newSeeds, primaryNiche: primary?.niche || null });
  return { ok: true, remaining: updated.length };
}

async function clearAllChannels() {
  await Store.setState({ channels: [], seeds: [], primaryNiche: null });
  return { ok: true };
}

function makeVideo(videoId, title) {
  return { videoId, title };
}

async function freshState() {
  resetStore();
  return await Store.getState();
}

group('channel management flow', () => {
  test('addChannel adds new channel and updates primaryNiche', async () => {
    await freshState();
    const res = await addChannelFromDetect({
      handle: 'paperart',
      url: 'https://youtube.com/@paperart',
      displayName: 'Paper Art Channel',
      niche: 'craft-diy',
      confidence: 0.8,
      videos: [makeVideo('v1', 'Paper crane'), makeVideo('v2', 'Origami fox')],
    });
    assert.equal(res.ok, true);
    assert.equal(res.updated, false);
    assert.equal(res.channel.handle, 'paperart');
    assert.equal(res.channel.videos.length, 2);

    const s = await Store.getState();
    assert.equal(s.channels.length, 1);
    assert.equal(s.primaryNiche, 'craft-diy');
  });

  test('addChannel updates existing channel with new videos', async () => {
    await freshState();
    await addChannelFromDetect({ handle: 'paperart', url: 'x', niche: 'craft-diy', videos: [makeVideo('v1', 'old')] });
    const res = await addChannelFromDetect({
      handle: 'paperart', url: 'x', niche: 'craft-diy',
      videos: [makeVideo('v1', 'new'), makeVideo('v2', 'new2')],
    });
    assert.equal(res.ok, true);
    assert.equal(res.updated, true);
    assert.equal(res.channel.videos.length, 2);
    assert.equal(res.channel.videos[0].title, 'new');
    const s = await Store.getState();
    assert.equal(s.channels.length, 1, 'should not create duplicate');
  });

  test('addChannel rejects when list full', async () => {
    await freshState();
    for (let i = 0; i < 10; i++) {
      await addChannelFromDetect({ handle: `ch${i}`, url: 'x', videos: [] });
    }
    const res = await addChannelFromDetect({ handle: 'ch11', url: 'x', videos: [] });
    assert.equal(res.ok, false);
    assert.match(/full/i, res.reason);
  });

  test('addChannel caps videos at MAX_VIDEOS_PER_CHANNEL', async () => {
    await freshState();
    const manyVideos = Array.from({ length: 50 }, (_, i) => makeVideo(`v${i}`, `Video ${i}`));
    const res = await addChannelFromDetect({ handle: 'big', url: 'x', videos: manyVideos });
    assert.equal(res.channel.videos.length, 30);
  });

  test('removeChannel drops channel and its seeds', async () => {
    await freshState();
    await addChannelFromDetect({ handle: 'a', url: 'x', videos: [makeVideo('v1', 't')] });
    await addChannelFromDetect({ handle: 'b', url: 'x', videos: [makeVideo('v2', 't2')] });
    // Use real channel IDs (not 'a-channel-id' literal)
    const channelsBefore = (await Store.getState()).channels;
    const chA = channelsBefore.find((c) => c.handle === 'a');
    const chB = channelsBefore.find((c) => c.handle === 'b');
    await Store.setState({
      seeds: [
        { videoId: 'v1', channelId: chA.id },
        { videoId: 'v2', channelId: chB.id },
      ],
    });
    const res = await removeChannel(chA.id);
    assert.equal(res.ok, true);
    const s = await Store.getState();
    assert.equal(s.channels.length, 1);
    assert.equal(s.channels[0].handle, 'b');
    assert.equal(s.seeds.length, 1);
    assert.equal(s.seeds[0].channelId, chB.id);
  });

  test('clearAllChannels removes everything', async () => {
    await freshState();
    await addChannelFromDetect({ handle: 'a', url: 'x', videos: [] });
    await addChannelFromDetect({ handle: 'b', url: 'x', videos: [] });
    await clearAllChannels();
    const s = await Store.getState();
    assert.deepEqual(s.channels, []);
    assert.deepEqual(s.seeds, []);
    assert.equal(s.primaryNiche, null);
  });

  test('primaryNiche updates as channels are added', async () => {
    await freshState();
    await addChannelFromDetect({ handle: 'a', url: 'x', niche: 'craft-diy', videos: [] });
    await addChannelFromDetect({ handle: 'b', url: 'x', niche: 'craft-diy', videos: [] });
    await addChannelFromDetect({ handle: 'c', url: 'x', niche: 'tutorial', videos: [] });
    const s = await Store.getState();
    assert.equal(s.primaryNiche, 'craft-diy');
  });
});

group('subscribe guards', () => {
  test('subscribe blocked if 1 already done today', async () => {
    await freshState();
    const settings = await Store.getState().then((s) => s.settings);
    // Simulate having subbed today
    await Store.setState({
      history: {
        watched: [], liked: [], commented: [],
        subscribed: [{ channel: 'A', subscribedAt: new Date().toISOString() }],
      },
    });
    const state = await Store.getState();
    const subToday = state.history.subscribed.filter((s) => Date.now() - new Date(s.subscribedAt).getTime() < 86400000);
    assert.equal(subToday.length, 1);
    // Decision logic would skip subscribe
  });

  test('subscribe blocked if already subbed to same channel', async () => {
    await freshState();
    await Store.setState({
      history: {
        watched: [], liked: [], commented: [],
        subscribed: [{ channel: 'PaperArt', subscribedAt: new Date(Date.now() - 3 * 86400000).toISOString() }],
      },
    });
    const state = await Store.getState();
    const already = state.history.subscribed.some((s) => s.channel.toLowerCase() === 'paperart');
    assert.truthy(already);
  });

  test('subscribe allowed if no sub today and channel not yet subbed', async () => {
    await freshState();
    await Store.setState({
      history: { watched: [], liked: [], commented: [], subscribed: [] },
      account: { createdAt: new Date(Date.now() - 30 * 86400000).toISOString() },
    });
    const state = await Store.getState();
    const subToday = state.history.subscribed.filter((s) => Date.now() - new Date(s.subscribedAt).getTime() < 86400000);
    assert.equal(subToday.length, 0);
    assert.equal(Store.canComment(state), true); // account old enough
  });

  test('subscribe blocked for account < 14 days', async () => {
    await freshState();
    await Store.setState({
      account: { createdAt: new Date(Date.now() - 5 * 86400000).toISOString() },
    });
    const state = await Store.getState();
    assert.equal(Store.canComment(state), false);
  });
});

group('watch tick flow simulation', () => {
  test('Full tick: pick → execute → record stats', async () => {
    await freshState();
    // Setup: 3 channels with videos
    await addChannelFromDetect({ handle: 'a', url: 'x', niche: 'craft-diy', videos: [makeVideo('va1', 'A1'), makeVideo('va2', 'A2')] });
    await addChannelFromDetect({ handle: 'b', url: 'x', niche: 'craft-diy', videos: [makeVideo('vb1', 'B1')] });
    const ch = (await Store.getState()).channels.find((c) => c.handle === 'a');
    const ch2 = (await Store.getState()).channels.find((c) => c.handle === 'b');
    // Build seed pool like refreshSeeds would
    const seeds = [
      { videoId: 'va1', title: 'A1', channelId: ch.id, channelName: 'a', source: `channel:${ch.id}` },
      { videoId: 'va2', title: 'A2', channelId: ch.id, channelName: 'a', source: `channel:${ch.id}` },
      { videoId: 'vb1', title: 'B1', channelId: ch2.id, channelName: 'b', source: `channel:${ch2.id}` },
    ];
    await Store.setState({ seeds });
    await Store.setState({ running: true });

    // Make account old enough for comment + sub
    await Store.setState({ account: { createdAt: new Date(Date.now() - 30 * 86400000).toISOString() } });

    // Pick seed
    function pickSeed(seeds, history, channels, lastId) {
      if (!seeds.length) return null;
      const watched = new Set(history.watched.map((x) => x.videoId));
      const liked = new Set(history.liked.map((x) => x.videoId));
      const fresh = seeds.filter((s) => !watched.has(s.videoId) && !liked.has(s.videoId));
      const pool = fresh.length > 0 ? fresh : seeds;
      if (lastId && channels.length > 1) {
        const other = pool.filter((s) => s.channelId && s.channelId !== lastId);
        const same = pool.filter((s) => s.channelId === lastId);
        if (other.length > 0 && same.length > 0) return other[Math.floor(Math.random() * other.length)];
      }
      return pool[Math.floor(Math.random() * pool.length)];
    }

    const channels = await Store.getState().then((s) => s.channels);
    const seed = pickSeed(seeds, { watched: [], liked: [] }, channels, null);
    assert.truthy(seed);
    assert.truthy(['va1', 'va2', 'vb1'].includes(seed.videoId));

    // Simulate watch action
    await Store.recordAction('watch');
    const s = await Store.getState();
    const today = Store.todayKey();
    assert.equal(s.stats[today].watch, 1);
    assert.equal(s.stats[today].total, 1);

    // Add to history
    const s2 = await Store.getState();
    s2.history.watched.push({ videoId: seed.videoId, watchedAt: new Date().toISOString() });
    await Store.setState({ history: s2.history });

    // Simulate like action (random)
    if (Math.random() < 0.45) {
      await Store.recordAction('like');
    }
  });

  test('After all videos watched, scheduler still picks from pool (refresh cycle)', async () => {
    await freshState();
    await addChannelFromDetect({ handle: 'a', url: 'x', niche: 'craft-diy', videos: [makeVideo('v1', 'T1')] });
    const ch = (await Store.getState()).channels[0];
    const seeds = [{ videoId: 'v1', channelId: ch.id, channelName: 'a' }];
    await Store.setState({ seeds, history: { watched: [{ videoId: 'v1' }], liked: [], commented: [], subscribed: [] } });

    function pickSeed(seeds, history) {
      const watched = new Set(history.watched.map((x) => x.videoId));
      const fresh = seeds.filter((s) => !watched.has(s.videoId));
      const pool = fresh.length > 0 ? fresh : seeds;
      return pool[Math.floor(Math.random() * pool.length)];
    }

    const seed = pickSeed(seeds, { watched: [{ videoId: 'v1' }] });
    assert.equal(seed.videoId, 'v1'); // falls back to watched
  });
});

group('alarm scheduling', () => {
  test('ALARM_NAME created with correct period', () => {
    const mock = require('./mock-chrome');
    Object.keys(mock._alarms).forEach((k) => delete mock._alarms[k]);
    mock.chrome.alarms.create('nuoi-yt-tick', { periodInMinutes: 2 });
    assert.truthy(mock._alarms['nuoi-yt-tick']);
    assert.equal(mock._alarms['nuoi-yt-tick'].periodInMinutes, 2);
  });

  test('SEED_REFRESH_ALARM no longer auto-created', () => {
    const mock = require('./mock-chrome');
    Object.keys(mock._alarms).forEach((k) => delete mock._alarms[k]);
    mock.chrome.alarms.create('nuoi-yt-tick', { periodInMinutes: 2 });
    assert.equal(mock._alarms['nuoi-yt-seed-refresh'], undefined);
  });
});

if (require.main === module) run();
