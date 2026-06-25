/**
 * Background service worker (MV3).
 *
 * Responsibilities:
 *  - Set up chrome.alarms for periodic wake-ups
 *  - On wake-up: check canAct(), pick a seed, open a tab, send WATCH
 *  - Refresh seeds: pull videos from each competitor channel + search YouTube
 *  - Receive WATCH_DONE from executor, close tab, schedule next
 *
 * Data model:
 *  - state.channels: up to 10 competitor/target channels
 *  - state.seeds: combined video pool (channel videos + search-discovered)
 *  - state.primaryNiche: most common niche across channels (computed)
 *
 * State: read/written via Store (chrome.storage.local)
 */

importScripts('../lib/niches.js', '../lib/templates.js', '../lib/human.js', '../lib/store.js', '../lib/antiBan.js');

const ALARM_NAME = 'nuoi-yt-tick';
const ALARM_PERIOD_MIN = 2; // wake up every 2 minutes
const SEED_REFRESH_ALARM = 'nuoi-yt-seed-refresh';
const SEED_REFRESH_PERIOD_MIN = 30;
const AUTO_DOWNLOAD_ALARM = 'nuoi-yt-auto-download';
const TABS_OPEN_TIMEOUT_MS = 8 * 60 * 1000; // 8 min max for 1 watch
const SEED_POOL_MAX = 200;
const SEED_MIN = 5;
const MAX_CHANNELS = 10;
const MAX_VIDEOS_PER_CHANNEL = 30; // keep first 30 videos per channel
const ACTIVITY_LOG_MAX = 500;        // keep last 500 events in active log
const ARCHIVE_THRESHOLD = 500;         // when active log hits this, archive the oldest
const ARCHIVE_CHUNK = 200;             // how many to archive at once
const ARCHIVE_MAX_COUNT = 5;           // keep at most 5 archive chunks (1000 archived events)
const ARCHIVE_FILE_PREFIX = 'youtube-nurture-log';

let _currentWatchTabId = null;
let _currentWatchTimeout = null;
// Per-tab tracking for parallel watches (avoids one watch's WATCH_DONE closing another's tab)
const _activeWatches = new Map(); // tabId → { timeout, videoId, startedAt }
let _lastPickedChannelId = null; // round-robin across channels

/**
 * Activity log: persist every meaningful event the extension takes, so the user can
 * later inspect what happened (debug + audit). Stored in state.activityLog.
 *
 * Event shape:
 *   { ts: number (ms epoch), type: string, level: 'info'|'warn'|'error',
 *     message: string, data: object (type-specific, optional) }
 *
 * Stored in storage as `activityLog` (active, last 500 events).
 * When the active log hits ARCHIVE_THRESHOLD, the oldest ARCHIVE_CHUNK events are
 * moved to `activityLogArchive` (a ring buffer of chunks, max 5 chunks).
 * The popup exposes a button to download any archive as a JSON file.
 *
 * Auto-archive flow: when log.length > ARCHIVE_THRESHOLD:
 *   1. take the oldest ARCHIVE_CHUNK events → wrap as { archivedAt, count, events }
 *   2. prepend to activityLogArchive
 *   3. trim activityLogArchive to ARCHIVE_MAX_COUNT chunks
 *   4. trim activityLog to last ACTIVITY_LOG_MAX events
 *   5. save both atomically
 */
async function logActivity(type, message, data = {}, level = 'info') {
  try {
    const event = {
      ts: Date.now(),
      type,
      level,
      message,
      ...(data && Object.keys(data).length ? { data } : {}),
    };
    const state = await Store.getState();
    const log = Array.isArray(state.activityLog) ? state.activityLog.slice() : [];
    const archive = Array.isArray(state.activityLogArchive) ? state.activityLogArchive.slice() : [];

    log.push(event);

    // Auto-archive: when log exceeds threshold, move the oldest chunk into the archive ring.
    let archivedNow = null;
    if (log.length > ARCHIVE_THRESHOLD) {
      // Take the oldest ARCHIVE_CHUNK events
      const toArchive = log.splice(0, ARCHIVE_CHUNK);
      archivedNow = {
        archivedAt: Date.now(),
        count: toArchive.length,
        firstTs: toArchive[0]?.ts,
        lastTs: toArchive[toArchive.length - 1]?.ts,
        events: toArchive,
      };
      archive.unshift(archivedNow);
      // Trim archive ring to ARCHIVE_MAX_COUNT chunks
      if (archive.length > ARCHIVE_MAX_COUNT) {
        archive.length = ARCHIVE_MAX_COUNT;
      }
      // Trim active log to ACTIVITY_LOG_MAX
      if (log.length > ACTIVITY_LOG_MAX) {
        log.splice(0, log.length - ACTIVITY_LOG_MAX);
      }
    } else if (log.length > ACTIVITY_LOG_MAX) {
      // Just trim if somehow over the cap (no archive)
      log.splice(0, log.length - ACTIVITY_LOG_MAX);
    }

    // Build a single setState patch (atomic write)
    const patch = { activityLog: log };
    if (archivedNow) patch.activityLogArchive = archive;

    // Fire-and-forget to avoid blocking the caller
    Store.setState(patch).catch((e) =>
      console.warn('[nuoi-yt] activity log write failed', e.message)
    );

    // Fire auto-download for the new archive (if enabled). Background — does not block logActivity.
    if (archivedNow) {
      const cfg = state.autoDownloadConfig || { enabled: false, onArchive: false, dailyHour: 3, clearAfterDownload: true };
      if (cfg.enabled && cfg.onArchive) {
        downloadAndClearArchive(0, cfg.clearAfterDownload !== false).catch((e) =>
          console.warn('[nuoi-yt] auto-download archive failed', e.message)
        );
      }
    }
  } catch (e) {
    // Never let logging break the main flow
    console.warn('[nuoi-yt] logActivity err', e.message);
  }
}

// =====================================================================
// Channel management
// =====================================================================

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

async function addChannelFromDetect({ handle, url, displayName, niche, confidence, videos }) {
  const state = await Store.getState();
  if (state.channels.length >= MAX_CHANNELS) {
    return { ok: false, reason: `Channel list full (max ${MAX_CHANNELS}). Remove one first.` };
  }
  const existing = findChannelByHandle(state.channels, handle);
  if (existing) {
    // Update existing channel with fresh data
    const updated = state.channels.map((c) =>
      c.id === existing.id
        ? {
            ...c,
            displayName: displayName || c.displayName,
            niche: niche || c.niche,
            confidence: confidence ?? c.confidence,
            videos: (videos || []).slice(0, MAX_VIDEOS_PER_CHANNEL).map((v) => ({
              ...v,
              discoveredAt: new Date().toISOString(),
            })),
            lastRefresh: new Date().toISOString(),
          }
        : c
    );
    const primary = Store.computePrimaryNiche(updated);
    await Store.setState({ channels: updated, primaryNiche: primary?.niche || null });
    await logActivity('channel_refreshed', `Refreshed @${handle} (${niche || existing.niche || '?'})`, {
      handle, niche, videoCount: (videos || []).length, channelId: existing.id,
    });
    return { ok: true, channel: updated.find((c) => c.id === existing.id), updated: true };
  }
  const id = `ch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const newChannel = {
    id,
    handle,
    url,
    displayName: displayName || handle,
    niche: niche || null,
    confidence: confidence ?? 0,
    videos: (videos || []).slice(0, MAX_VIDEOS_PER_CHANNEL).map((v) => ({
      ...v,
      discoveredAt: new Date().toISOString(),
    })),
    addedAt: new Date().toISOString(),
    lastRefresh: new Date().toISOString(),
    // New competitor channel → auto-subscribe on next watch from this channel.
    // Cleared by onWatchDone after a successful subscribe.
    pendingSubscribe: true,
  };
  const updated = [...state.channels, newChannel];
  const primary = Store.computePrimaryNiche(updated);
  await Store.setState({ channels: updated, primaryNiche: primary?.niche || null });
  await logActivity('channel_added', `Added @${handle} (${niche || '?'}, ${(videos || []).length} videos)`, {
    handle, displayName, niche, videoCount: (videos || []).length, channelId: id,
  });
  return { ok: true, channel: newChannel, updated: false };
}

async function removeChannel(id) {
  const state = await Store.getState();
  const removed = state.channels.find((c) => c.id === id);
  const updated = state.channels.filter((c) => c.id !== id);
  // Also drop seeds from this channel
  const newSeeds = (state.seeds || []).filter((s) => s.channelId !== id);
  const primary = Store.computePrimaryNiche(updated);
  await Store.setState({
    channels: updated,
    seeds: newSeeds,
    primaryNiche: primary?.niche || null,
  });
  if (removed) {
    await logActivity('channel_removed', `Removed @${removed.handle}`, {
      handle: removed.handle, channelId: id,
    });
  }
  return { ok: true, remaining: updated.length };
}

async function clearAllChannels() {
  await Store.setState({ channels: [], seeds: [], primaryNiche: null });
  return { ok: true };
}

/**
 * INIT: set up alarms khi install/startup.
 */
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[nuoi-yt] installed');
  // Set default state neu chua co
  const state = await Store.getState();
  if (!state.account.createdAt || state.account.createdAt === new Date(0).toISOString()) {
    state.account.createdAt = new Date().toISOString();
    await Store.setState({ account: state.account });
  }
  await setupAlarms();
  await setupAutoDownloadAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[nuoi-yt] startup');
  await setupAlarms();
  await setupAutoDownloadAlarm();
});

async function setupAlarms() {
  await chrome.alarms.clear(ALARM_NAME).catch(() => {});
  await chrome.alarms.clear(SEED_REFRESH_ALARM).catch(() => {});
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MIN });
  // SEED_REFRESH_ALARM no longer auto-set. Seed refresh is manual only
  // (user clicks "Refresh all" or "Refresh seeds" button). This keeps the
  // extension completely passive — no background tabs open unless user
  // explicitly requests refresh.
  console.log('[nuoi-yt] alarms set (tick only)');
}

/**
 * Main tick: check whether an action can run.
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await tick();
  }
  if (alarm.name === AUTO_DOWNLOAD_ALARM) {
    // Daily auto-download: dump everything and clear
    try {
      const state = await Store.getState();
      const cfg = state.autoDownloadConfig || {};
      if (cfg.enabled && cfg.daily) {
        await downloadAndClearAll(true);
        // Re-schedule for next day (chrome.alarms has a max period of ~1 day; we re-arm)
        await setupAutoDownloadAlarm();
      }
    } catch (e) {
      await logActivity('error', `Daily auto-download alarm failed: ${e.message}`, { stack: (e.stack || '').slice(0, 400) }, 'error');
    }
  }
  // SEED_REFRESH_ALARM no longer auto-created. Seed refresh is manual only.
});

  async function tick() {
    const tickId = `tk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
    try {
      const state = await Store.getState();
      if (!state.running) {
        return; // scheduler stopped by user — don't log to avoid noise
      }

      const check = Store.canAct(state);
      if (!check.allowed) {
        await logActivity('tick_skipped', `Tick skipped: ${check.reason}`, { reason: check.reason }, 'info');
        // Side-effect: if the daily cap was just hit, signal "done" to the multi-profile orchestrator.
        // The orchestrator (nurture-all.sh) polls for `~/.nuoi-yt/{profileId}-done-{date}.json` and switches profiles.
        if (check.reason && check.reason.startsWith('Daily cap')) {
          await signalProfileDone(state, check.reason);
        }
        return;
      }

      if (_currentWatchTabId) {
        // a watch is already in progress — silent skip
        return;
      }

      // Need at least 1 seed
      if (!state.seeds || state.seeds.length < 1) {
        await logActivity('tick_no_seeds', 'Tick fired but no seeds; refreshing', { tickId });
        await refreshSeeds();
        const s2 = await Store.getState();
        if (!s2.seeds || s2.seeds.length < 1) {
          await logActivity('tick_skipped', 'No seeds after refresh', { tickId }, 'warn');
          return;
        }
      }

      // Pick seed: prefer different channel than last pick (round-robin)
      const seed = pickSeed(state.seeds, state.history, state.channels, _lastPickedChannelId);
      if (!seed) {
        await logActivity('tick_no_seed', 'No eligible seed (all watched/liked?)', { tickId }, 'warn');
        return;
      }
      _lastPickedChannelId = seed.channelId || null;

      // Decide what actions to do (ratio)
      const settings = state.settings;
      const doLike = AntiBan.shouldDo('like', settings);
      const doComment = settings && Store.canComment(state) && AntiBan.shouldDo('comment', settings);

      // Pick comment text
      let commentText = null;
      if (doComment) {
        // 30% chance of short react
        const variant = Math.random() < 0.3 ? 'short' : 'normal';
        commentText = Templates.pickTemplate(variant);
      }

      // Subscribe: 5% ratio + 1/day cap + skip if already subbed + account > 14d
      // OR forced when the channel was just added (pendingSubscribe=true) — bypass
      // ratio and 1/day cap up to settings.subscribeBurstPerDay.
      let doSub = false;
      let subChannel = null;
      let forceSub = false;
      const seedChannel = (state.channels || []).find((c) => c.id === seed.channelId);
      if (seedChannel && seedChannel.pendingSubscribe) {
        // Forced subscribe for newly added competitor channel
        const subToday = (state.history.subscribed || []).filter((s) =>
          Date.now() - new Date(s.subscribedAt).getTime() < 86400000
        );
        const burstCap = Number(settings.subscribeBurstPerDay) || 5;
        const alreadySubbed = (state.history.subscribed || []).some(
          (s) => s.channel && seedChannel.displayName &&
                 s.channel.toLowerCase() === seedChannel.displayName.toLowerCase()
        );
        if (subToday.length < burstCap && !alreadySubbed && seedChannel.displayName) {
          doSub = true;
          forceSub = true;
          subChannel = seedChannel.displayName;
        }
      } else if (AntiBan.shouldDo('subscribe', settings) && Store.canComment(state)) {
        const subToday = (state.history.subscribed || []).filter((s) =>
          Date.now() - new Date(s.subscribedAt).getTime() < 86400000
        );
        const alreadySubbed = (state.history.subscribed || []).some(
          (s) => s.channelName && seed.channelName && s.channelName.toLowerCase() === seed.channelName.toLowerCase()
        );
        if (subToday.length === 0 && !alreadySubbed && seed.channelName) {
          doSub = true;
          subChannel = seed.channelName;
        }
      }

      await logActivity('tick_fired', `Tick fired → ${seed.title || seed.videoId}`, {
        tickId,
        videoId: seed.videoId,
        title: seed.title,
        channel: seed.channelName,
        source: seed.source,
        actions: { like: doLike, comment: doComment, subscribe: doSub },
        commentText: commentText ? commentText.slice(0, 60) : null,
      });

      await openAndWatch(seed.videoId, {
        like: doLike,
        comment: doComment,
        commentText,
        subscribe: doSub,
        subscribeChannel: subChannel,
        forceSubscribe: forceSub,
      });
    } catch (e) {
      await logActivity('error', `Tick error: ${e.message}`, { tickId, stack: (e.stack || '').slice(0, 600) }, 'error');
      console.error('[nuoi-yt] tick err', e);
    }
  }

/**
 * Pick 1 seed.
 * Priority:
 *  1. Fresh (not watched/liked) from a channel != lastPickedChannelId (round-robin)
 *  2. Fresh from any channel
 *  3. Any seed from a different channel than last pick
 *  4. Random seed (fallback)
 */
function pickSeed(seeds, history, channels, lastPickedChannelId) {
  if (!seeds || seeds.length === 0) return null;
  const watched = new Set(history.watched.map((x) => x.videoId));
  const liked = new Set(history.liked.map((x) => x.videoId));

  const fresh = seeds.filter((s) => !watched.has(s.videoId) && !liked.has(s.videoId));
  const pool = fresh.length > 0 ? fresh : seeds;

  // 0. PRIORITY: prefer videos from channels the user just added (pendingSubscribe).
  // We want to force-subscribe to all newly-added competitor channels.
  if (channels && channels.length > 0) {
    const pendingChannelIds = new Set(
      channels.filter((c) => c.pendingSubscribe).map((c) => c.id)
    );
    if (pendingChannelIds.size > 0) {
      const pendingSeeds = pool.filter((s) => s.channelId && pendingChannelIds.has(s.channelId));
      if (pendingSeeds.length > 0) {
        return pendingSeeds[Math.floor(Math.random() * pendingSeeds.length)];
      }
    }
  }

  // 1. Fresh from different channel
  if (lastPickedChannelId && channels && channels.length > 1) {
    const sameChannel = pool.filter((s) => s.channelId === lastPickedChannelId);
    const otherChannel = pool.filter((s) => s.channelId && s.channelId !== lastPickedChannelId);
    if (otherChannel.length > 0 && sameChannel.length > 0) {
      return otherChannel[Math.floor(Math.random() * otherChannel.length)];
    }
  }

  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Open tab, send WATCH, set timeout, listen WATCH_DONE.
 */
async function openAndWatch(videoId, opts) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  console.log(`[nuoi-yt] opening tab ${url} (like=${opts.like}, comment=${opts.comment})`);

  let tab;
  try {
    // Open in FOREGROUND so IntersectionObserver fires and YouTube fully renders the page.
    // active:true avoids background-tab throttling (lazy content won't render otherwise).
    tab = await chrome.tabs.create({ url, active: true });
  } catch (e) {
    await logActivity('error', `Tab create failed for ${videoId}: ${e.message}`, { videoId }, 'error');
    console.error('[nuoi-yt] tab create err', e);
    return;
  }

  // Per-tab tracking (so multiple parallel watches don't close each other)
  _activeWatches.set(tab.id, {
    videoId,
    startedAt: Date.now(),
    timeout: null,
    // Preserve opts for onWatchDone to clear pendingSubscribe on the channel we asked to subscribe to
    opts: { ...opts },
  });
  _currentWatchTabId = tab.id; // legacy single-slot for tick()'s busy check

  await logActivity('watch_started', `Opened watch tab for ${videoId}`, {
    videoId,
    tabId: tab.id,
    like: !!opts.like,
    comment: !!opts.comment,
    commentText: opts.commentText ? opts.commentText.slice(0, 80) : null,
    subscribe: !!opts.subscribe,
    subscribeChannel: opts.subscribeChannel,
  });

  // Timeout for THIS tab
  const timeout = setTimeout(async () => {
    console.warn(`[nuoi-yt] watch timeout for tab ${tab.id}, closing`);
    if (_activeWatches.has(tab.id)) {
      await logActivity('watch_timeout', `Watch timed out (${TABS_OPEN_TIMEOUT_MS/1000}s)`, { videoId, tabId: tab.id }, 'warn');
      chrome.tabs.remove(tab.id).catch(() => {});
      _activeWatches.delete(tab.id);
      if (_currentWatchTabId === tab.id) _currentWatchTabId = null;
    }
  }, TABS_OPEN_TIMEOUT_MS);
  _activeWatches.get(tab.id).timeout = timeout;

  // Wait for tab to load + send WATCH
  chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
    if (tabId !== tab.id) return;
    if (info.status === 'complete') {
      chrome.tabs.onUpdated.removeListener(listener);
      // Small delay cho content script setup
      setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, { type: 'WATCH', tabId: tab.id, videoId, ...opts }).catch((e) => {
          logActivity('error', `sendMessage WATCH failed: ${e.message}`, { videoId, tabId: tab.id }, 'error');
          console.warn('[nuoi-yt] sendMessage err', e.message);
        });
      }, 2500);
    }
  });
}

async function onWatchDone(result) {
  console.log('[nuoi-yt] WATCH_DONE', result);

  // Identify the correct tab to close. Priority:
  //   1. tabId in the result (set by executor from the WATCH message)
  //   2. videoId match in _activeWatches
  //   3. Only one active watch → use it
  //   4. Fallback: first key in _activeWatches
  let targetTabId = null;
  if (result.tabId && _activeWatches.has(result.tabId)) {
    targetTabId = result.tabId;
  } else if (result.videoId && _activeWatches.size > 0) {
    for (const [tid, entry] of _activeWatches.entries()) {
      if (entry.videoId === result.videoId) {
        targetTabId = tid;
        break;
      }
    }
    if (!targetTabId && _activeWatches.size === 1) {
      targetTabId = _activeWatches.keys().next().value;
    }
  } else if (_activeWatches.size === 1) {
    targetTabId = _activeWatches.keys().next().value;
  }

  let targetEntry = null;
  if (targetTabId !== null) {
    targetEntry = _activeWatches.get(targetTabId);
    if (targetEntry?.timeout) {
      clearTimeout(targetEntry.timeout);
    }
    _activeWatches.delete(targetTabId);
    // Wait a bit then close
    setTimeout(() => {
      chrome.tabs.remove(targetTabId).catch(() => {});
    }, 3000);
  }

  // Clear the legacy single-slot if it matches
  if (_currentWatchTabId === targetTabId) _currentWatchTabId = null;

  // Log the outcome
  if (result.ok) {
    await logActivity('watch_completed', `Watch done: ${result.title || result.videoId}`, {
      videoId: result.videoId,
      title: result.title,
      tabId: targetTabId,
      duration: targetEntry ? Date.now() - targetEntry.startedAt : null,
    });

    // If we asked to subscribe to a channel on this watch and the executor
    // recorded a successful subscribe, clear the channel's pendingSubscribe flag.
    const opts = targetEntry?.opts || {};
    if (opts.subscribeChannel) {
      try {
        const s2 = await Store.getState();
        const subbed = (s2.history.subscribed || []).some((s) =>
          s.channel &&
          s.channel.toLowerCase() === String(opts.subscribeChannel).toLowerCase()
        );
        if (subbed) {
          const target = String(opts.subscribeChannel).toLowerCase();
          const updated = (s2.channels || []).map((ch) => {
            if (ch.pendingSubscribe) {
              const dn = (ch.displayName || '').toLowerCase();
              const hh = (ch.handle || '').toLowerCase();
              if (dn === target || hh === target) {
                return { ...ch, pendingSubscribe: false, subscribedAt: new Date().toISOString() };
              }
            }
            return ch;
          });
          await Store.setState({ channels: updated });
        }
      } catch (e) {
        console.warn('[nuoi-yt] pendingSubscribe clear failed', e);
      }
    }
  } else {
    const level = result.reason === 'not-logged-in' ? 'error' : 'warn';
    await logActivity('watch_failed', `Watch failed (${result.reason || 'unknown'})`, {
      videoId: result.videoId,
      tabId: targetTabId,
      reason: result.reason,
    }, level);
  }

  if (!result.ok) {
    if (result.reason === 'checkpoint') {
      // already recorded by executor
    } else if (result.reason === 'not-logged-in') {
      await logActivity('scheduler_paused', 'Scheduler paused: user not logged in to YouTube', { reason: 'not-logged-in' }, 'warn');
      console.warn('[nuoi-yt] user not logged in to YouTube, pausing scheduler');
      await Store.setState({ running: false });
    }
  }
}

/**
 * Seed refresh (manual only — triggered by user clicking "Refresh all" or after add).
 *  1. Collect videos from all channels in state.channels (already-detected)
 *  2. Search YouTube for the primary niche to discover new videos (1 keyword)
 *
 * NO auto-refresh alarm. The extension is completely passive unless user clicks.
 */
async function refreshSeeds() {
  try {
    const state = await Store.getState();
    if (!state.channels || state.channels.length === 0) {
      console.log('[nuoi-yt] seed refresh: no channels yet');
      return;
    }

    const seen = new Set();
    const seeds = [];

    // 1. Pull videos from each channel
    for (const ch of state.channels) {
      for (const v of ch.videos || []) {
        if (!seen.has(v.videoId)) {
          seen.add(v.videoId);
          seeds.push({
            videoId: v.videoId,
            title: v.title,
            channelName: ch.displayName || ch.handle,
            channelId: ch.id,
            source: `channel:${ch.id}`,
          });
        }
      }
    }
    console.log(`[nuoi-yt] seed refresh: ${seeds.length} videos from ${state.channels.length} channels`);

    // 2. YouTube search discovery has been removed.
  // We used to search YouTube for primary-niche keywords to discover new videos.
  // Now we only use videos from the channels the user has explicitly added —
  // since the user curates their own competitor list, niche search isn't needed.
  // If you want to re-enable, set state.settings.seedSearchEnabled = true.

    const finalSeeds = seeds.slice(0, SEED_POOL_MAX);
    await Store.setState({ seeds: finalSeeds });
    console.log(`[nuoi-yt] seed refresh done: ${finalSeeds.length} total seeds`);
  } catch (e) {
    console.error('[nuoi-yt] seed refresh err', e);
  }
}

/**
 * Detect videos for a single channel. Opens tab, scrapes, closes.
 * Returns { videos: [...], niche, confidence, microformat } or null.
 */
async function detectChannelVideos(targetUrl, handle) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url: targetUrl, active: false });
  } catch (e) {
    return null;
  }
  await waitForTabComplete(tab.id, 30000);
  await Human.sleep(5000);

  try {
    // Use file injection (NOT func:) because func: with our large function body
    // has serialization issues — Chrome silently returns null in some cases.
    // The file is self-contained and runs cleanly in the page context.
    // Step 1: inject custom niches into the page (if any) so scrape-page.js can merge them
    const stateForNiches = await Store.getState();
    const customNiches = stateForNiches.customNiches || {};
    if (Object.keys(customNiches).length > 0) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (niches) => { window.__customNiches = niches; },
        args: [customNiches],
      }).catch(() => {});
    }
    // Step 2: inject scrape-page.js
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['background/scrape-page.js'],
    });
    const r2 = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.__lastScrape || null,
    });
    return r2?.[0]?.result;
  } catch (e) {
    console.warn('[nuoi-yt] detect channel err', e.message);
    return null;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function scrapeSearchResults() {
  const out = [];
  const items = document.querySelectorAll('ytd-video-renderer, ytd-rich-item-renderer');
  items.forEach((v) => {
    const a = v.querySelector('a#video-title, a#thumbnail');
    const title = a?.textContent?.trim() || a?.getAttribute('title') || '';
    const href = a?.getAttribute('href') || '';
    const channelEl = v.querySelector('ytd-channel-name a, .ytd-channel-name');
    const channelName = (channelEl?.textContent || '').trim();
    const m = href.match(/[?&]v=([\w-]+)/);
    if (m && title) {
      out.push({
        videoId: m[1],
        title: title.slice(0, 200),
        channelName: channelName.slice(0, 100),
      });
    }
  });
  return out;
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) return resolve();
        if (tab.status === 'complete') return resolve();
        if (Date.now() - start > timeoutMs) return resolve();
        setTimeout(check, 500);
      });
    };
    check();
  });
}

// ============ Message handlers (tu popup / content scripts) ============

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_STATUS') {
    handleGetStatus().then(sendResponse);
    return true;
  }
  if (msg.type === 'SET_RUNNING') {
    Store.setState({ running: !!msg.running }).then(() => {
      if (msg.running) {
        chrome.alarms.get(ALARM_NAME, (a) => {
          if (!a) chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MIN });
          chrome.alarms.create('nuoi-yt-tick-now', { delayInMinutes: 0.05 });
        });
      } else if (_currentWatchTabId) {
        chrome.tabs.sendMessage(_currentWatchTabId, { type: 'STOP' }).catch(() => {});
      }
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === 'DETECT_NOW' || msg.type === 'ADD_CHANNEL') {
    handleDetectFromUrl(msg.url, msg.niche || null).then(sendResponse);
    return true;
  }
  if (msg.type === 'ADD_NICHE') {
    handleAddNiche(msg.id, msg.label, msg.keywords).then(sendResponse);
    return true;
  }
  if (msg.type === 'DELETE_NICHE') {
    handleDeleteNiche(msg.nicheId).then(sendResponse);
    return true;
  }
  if (msg.type === 'RESTORE_DEFAULT_NICHE') {
    handleRestoreDefaultNiche(msg.nicheId).then(sendResponse);
    return true;
  }
  if (msg.type === 'GET_ACTIVITY_LOG') {
    // Return last N events. msg.limit optional (default 200, max 500).
    (async () => {
      const state = await Store.getState();
      const all = Array.isArray(state.activityLog) ? state.activityLog : [];
      const limit = Math.min(Math.max(parseInt(msg.limit, 10) || 200, 1), ACTIVITY_LOG_MAX);
      const slice = all.slice(-limit);
      sendResponse({ ok: true, events: slice, total: all.length, limit });
    })();
    return true;
  }
  if (msg.type === 'CLEAR_ACTIVITY_LOG') {
    (async () => {
      const state = await Store.getState();
      const count = (state.activityLog || []).length;
      // Drop active log but keep archives (separate concern)
      await Store.setState({ activityLog: [] });
      await logActivity('log_cleared', `Activity log cleared (was ${count} events; archives kept)`);
      sendResponse({ ok: true, cleared: count });
    })();
    return true;
  }
  if (msg.type === 'GET_ACTIVITY_ARCHIVE') {
    // Return metadata for all archive chunks (without full event payloads — popup fetches details on demand)
    (async () => {
      const state = await Store.getState();
      const archive = Array.isArray(state.activityLogArchive) ? state.activityLogArchive : [];
      const summary = archive.map((a, idx) => ({
        index: idx,
        archivedAt: a.archivedAt,
        count: a.count,
        firstTs: a.firstTs,
        lastTs: a.lastTs,
      }));
      sendResponse({ ok: true, archives: summary, total: archive.length });
    })();
    return true;
  }
  if (msg.type === 'GET_ARCHIVE_EVENTS') {
    // Return full events for a specific archive chunk
    (async () => {
      const state = await Store.getState();
      const archive = Array.isArray(state.activityLogArchive) ? state.activityLogArchive : [];
      const idx = parseInt(msg.index, 10);
      if (Number.isNaN(idx) || idx < 0 || idx >= archive.length) {
        sendResponse({ ok: false, reason: 'Invalid archive index' });
        return;
      }
      sendResponse({ ok: true, archive: archive[idx] });
    })();
    return true;
  }
  if (msg.type === 'DOWNLOAD_ARCHIVE') {
    // Save a specific archive (or all) as JSON file via chrome.downloads
    (async () => {
      try {
        const state = await Store.getState();
        const archive = Array.isArray(state.activityLogArchive) ? state.activityLogArchive : [];
        const active = Array.isArray(state.activityLog) ? state.activityLog : [];
        const includeActive = !!msg.includeActive;
        const which = msg.index;
        let payload;
        let filename;
        const tsStr = new Date().toISOString().replace(/[:.]/g, '-');
        if (which === 'all') {
          payload = {
            kind: 'all',
            exportedAt: new Date().toISOString(),
            archiveChunks: archive.length,
            activeEvents: includeActive ? active.length : 0,
            archives: archive,
          };
          if (includeActive) payload.active = active;
          filename = `${ARCHIVE_FILE_PREFIX}-all-${tsStr}.json`;
        } else {
          const idx = parseInt(which, 10);
          if (Number.isNaN(idx) || idx < 0 || idx >= archive.length) {
            sendResponse({ ok: false, reason: 'Invalid archive index' });
            return;
          }
          payload = {
            kind: 'archive',
            exportedAt: new Date().toISOString(),
            archiveIndex: idx,
            ...archive[idx],
          };
          filename = `${ARCHIVE_FILE_PREFIX}-archive-${idx}-${tsStr}.json`;
        }
        // Use data URL to write the file (no URL.createObjectURL since SW can't use that)
        const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(payload, null, 2));
        const downloadId = await chrome.downloads.download({
          url: dataUrl,
          filename: filename,
          saveAs: false, // auto-save to Downloads folder
        });
        await logActivity('log_downloaded', `Downloaded log to ${filename}`, {
          downloadId, filename, kind: which, eventCount: payload.events?.length || payload.archiveChunks,
        });
        sendResponse({ ok: true, downloadId, filename });
      } catch (e) {
        sendResponse({ ok: false, reason: e.message });
      }
    })();
    return true;
  }
  if (msg.type === 'CLEAR_ACTIVITY_ARCHIVE') {
    // Drop all archive chunks (but keep active log)
    (async () => {
      const state = await Store.getState();
      const dropped = (state.activityLogArchive || []).length;
      await Store.setState({ activityLogArchive: [] });
      await logActivity('log_archives_cleared', `Cleared ${dropped} archive chunk(s)`);
      sendResponse({ ok: true, dropped });
    })();
    return true;
  }
  if (msg.type === 'DELETE_ARCHIVE') {
    // Drop a single archive chunk
    (async () => {
      const state = await Store.getState();
      const archive = Array.isArray(state.activityLogArchive) ? state.activityLogArchive : [];
      const idx = parseInt(msg.index, 10);
      if (Number.isNaN(idx) || idx < 0 || idx >= archive.length) {
        sendResponse({ ok: false, reason: 'Invalid archive index' });
        return;
      }
      const removed = archive.splice(idx, 1)[0];
      await Store.setState({ activityLogArchive: archive });
      await logActivity('log_archive_deleted', `Deleted archive chunk ${idx} (${removed.count} events)`, {
        index: idx, count: removed.count,
      });
      sendResponse({ ok: true, removed: removed.count });
    })();
    return true;
  }
  if (msg.type === 'GET_AUTO_DOWNLOAD_CONFIG') {
    (async () => {
      const state = await Store.getState();
      sendResponse({ ok: true, config: state.autoDownloadConfig || {} });
    })();
    return true;
  }
  if (msg.type === 'UPDATE_AUTO_DOWNLOAD_CONFIG') {
    (async () => {
      const state = await Store.getState();
      const current = state.autoDownloadConfig || {};
      // Validate
      const next = {
        enabled: msg.config?.enabled !== undefined ? !!msg.config.enabled : !!current.enabled,
        onArchive: msg.config?.onArchive !== undefined ? !!msg.config.onArchive : !!current.onArchive,
        daily: msg.config?.daily !== undefined ? !!msg.config.daily : !!current.daily,
        dailyHour: Number.isInteger(msg.config?.dailyHour) ? Math.max(0, Math.min(23, msg.config.dailyHour)) : (current.dailyHour ?? 3),
        clearAfterDownload: msg.config?.clearAfterDownload !== undefined ? !!msg.config.clearAfterDownload : (current.clearAfterDownload !== false),
        // Filename prefix (defaults to ARCHIVE_FILE_PREFIX)
        filePrefix: msg.config?.filePrefix || current.filePrefix || ARCHIVE_FILE_PREFIX,
      };
      await Store.setState({ autoDownloadConfig: next });
      await setupAutoDownloadAlarm();
      await logActivity('auto_download_config', `Auto-download config updated`, next);
      sendResponse({ ok: true, config: next });
    })();
    return true;
  }
  if (msg.type === 'TRIGGER_AUTO_DOWNLOAD') {
    (async () => {
      try {
        // Force a daily-style download (active + archives) right now
        const result = await downloadAndClearAll(true);
        sendResponse({ ok: true, ...result });
      } catch (e) {
        sendResponse({ ok: false, reason: e.message });
      }
    })();
    return true;
  }
  if (msg.type === 'REFRESH_SEEDS') {
    refreshSeeds().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'REFRESH_ALL_CHANNELS') {
    refreshAllChannels().then((res) => sendResponse(res));
    return true;
  }
  if (msg.type === 'REFRESH_CHANNEL') {
    refreshOneChannel(msg.channelId).then((res) => sendResponse(res));
    return true;
  }
  if (msg.type === 'MARK_PENDING_SUBSCRIBE') {
    // Re-flag a channel as pendingSubscribe so the next watch from it will force-subscribe.
    // Used when the auto-subscribe failed or the user wants to re-trigger.
    (async () => {
      try {
        const state = await Store.getState();
        const updated = (state.channels || []).map((ch) =>
          ch.id === msg.channelId
            ? { ...ch, pendingSubscribe: true, subscribedAt: undefined }
            : ch
        );
        await Store.setState({ channels: updated });
        await logActivity('channel_flagged_resubscribe', `Re-flagged channel for force-subscribe`, {
          channelId: msg.channelId,
        });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, err: e.message });
      }
    })();
    return true;
  }
  if (msg.type === 'REMOVE_CHANNEL') {
    removeChannel(msg.channelId).then(sendResponse);
    return true;
  }
  if (msg.type === 'CLEAR_CHANNELS') {
    clearAllChannels().then(sendResponse);
    return true;
  }
  if (msg.type === 'BULK_IMPORT') {
    handleBulkImport(msg.urls).then(sendResponse);
    return true;
  }
  if (msg.type === 'RESET_STATS') {
    Store.setState({ stats: {}, history: { watched: [], liked: [], commented: [], subscribed: [] } })
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'UPDATE_SETTINGS') {
    Store.setState({ settings: msg.settings }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'GET_PROFILE_ID') {
    (async () => {
      const state = await Store.getState();
      sendResponse({ ok: true, profileId: state.profileId || '', profileDoneDate: state.profileDoneDate || '' });
    })();
    return true;
  }
  if (msg.type === 'SET_PROFILE_ID') {
    (async () => {
      // Sanitize: lowercase, replace unsafe chars with underscore
      const raw = (msg.profileId || '').toString().trim();
      const clean = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      if (!clean) {
        sendResponse({ ok: false, reason: 'profileId cannot be empty after sanitization' });
        return;
      }
      // Reset profileDoneDate when profileId changes, so the new profile gets its own signal
      const before = await Store.getState();
      const changed = before.profileId !== clean;
      await Store.setState({
        profileId: clean,
        // When user changes profileId, allow re-signaling today
        ...(changed ? { profileDoneDate: '', profileDoneAt: null } : {}),
      });
      await logActivity('profile_id_set', `Profile ID set to "${clean}"`, {
        profileId: clean, previousId: before.profileId || '', changed,
      });
      sendResponse({ ok: true, profileId: clean, changed });
    })();
    return true;
  }
  if (msg.type === 'WATCH_DONE') {
    // Persist to tick log for debugging
    const entry = { ts: Date.now(), ok: msg.ok, reason: msg.reason, videoId: msg.videoId, title: msg.title };
    chrome.storage.local.get(['tickLog'], (data) => {
      const log = (data.tickLog || []).slice(-49);
      log.push(entry);
      chrome.storage.local.set({ tickLog: log });
    });
    onWatchDone(msg);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'NICHE_DETECTED') {
    console.log('[nuoi-yt] NICHE_DETECTED', msg.niche?.niche);
    setTimeout(() => refreshSeeds(), 5000);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'CHANNEL_VISITED') {
    // User is on a channel page. Save as lastVisitedChannel for popup hint.
    Store.setState({ lastVisitedChannel: { ...msg.channel, at: Date.now() } })
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'TICK_NOW') {
    // Manual tick trigger for testing/debugging. Force running=true first if not set.
    // Optional: msg.quick = true → 8s watch (instead of curved 90-540s)
    (async () => {
      try {
        const before = await Store.getState();
        if (!before.running) {
          await Store.setState({ running: true });
        }
        // Find what the tick would pick
        const state = await Store.getState();
        const seed = pickSeed(state.seeds, state.history, state.channels, _lastPickedChannelId);
        if (!seed) {
          sendResponse({ ok: false, err: 'no eligible seed (history full or no seeds)' });
          return;
        }
        _lastPickedChannelId = seed.channelId || null;
        // Build the same opts as tick() does
        const settings = state.settings;
        const doLike = AntiBan.shouldDo('like', settings);
        const doComment = Store.canComment(state) && AntiBan.shouldDo('comment', settings);
        let commentText = null;
        if (doComment) {
          const variant = Math.random() < 0.3 ? 'short' : 'normal';
          commentText = Templates.pickTemplate(variant);
        }
        let doSub = false;
        let subChannel = null;
        let forceSub = false;
        const seedChannel = (state.channels || []).find((c) => c.id === seed.channelId);
        if (seedChannel && seedChannel.pendingSubscribe) {
          const subToday = (state.history.subscribed || []).filter((s) =>
            Date.now() - new Date(s.subscribedAt).getTime() < 86400000
          );
          const burstCap = Number(settings.subscribeBurstPerDay) || 5;
          const alreadySubbed = (state.history.subscribed || []).some(
            (s) => s.channel && seedChannel.displayName &&
                   s.channel.toLowerCase() === seedChannel.displayName.toLowerCase()
          );
          if (subToday.length < burstCap && !alreadySubbed && seedChannel.displayName) {
            doSub = true;
            forceSub = true;
            subChannel = seedChannel.displayName;
          }
        } else if (AntiBan.shouldDo('subscribe', settings) && Store.canComment(state)) {
          const subToday = (state.history.subscribed || []).filter((s) =>
            Date.now() - new Date(s.subscribedAt).getTime() < 86400000
          );
          const alreadySubbed = (state.history.subscribed || []).some(
            (s) => s.channelName && seed.channelName && s.channelName.toLowerCase() === seed.channelName.toLowerCase()
          );
          if (subToday.length === 0 && !alreadySubbed && seed.channelName) {
            doSub = true;
            subChannel = seed.channelName;
          }
        }
        // Log the tick (matches what tick() does, for activity log consistency)
        await logActivity('tick_fired', `Tick fired (manual) → ${seed.title || seed.videoId}`, {
          source: 'manual',
          videoId: seed.videoId,
          title: seed.title,
          channel: seed.channelName,
          source: seed.source,
          actions: { like: doLike, comment: doComment, subscribe: doSub, forceSubscribe: forceSub },
          commentText: commentText ? commentText.slice(0, 60) : null,
        });

        // Call openAndWatch directly (skip tick() wrapper so we can pass quick + see the picked seed)
        await openAndWatch(seed.videoId, {
          like: doLike,
          comment: doComment,
          commentText,
          subscribe: doSub,
          subscribeChannel: subChannel,
          forceSubscribe: forceSub,
          quick: !!msg.quick,
        });
        const after = await Store.getState();
        sendResponse({
          ok: true,
          ran: true,
          seed: { videoId: seed.videoId, title: seed.title?.slice(0, 60), channelName: seed.channelName, source: seed.source },
          actions: { like: doLike, comment: doComment, subscribe: doSub, commentText },
          running: after.running,
          today: after.today,
          currentWatchTabId: _currentWatchTabId,
        });
      } catch (e) {
        sendResponse({ ok: false, err: e.message });
      }
    })();
    return true;
  }
  if (msg.type === 'TICK_LOG') {
    // Return most recent console log from the SW (via storage hack)
    chrome.storage.local.get(['tickLog'], (data) => {
      sendResponse({ ok: true, log: data.tickLog || [] });
    });
    return true;
  }
  if (msg.type === 'TEST_WATCH') {
    // Force a watch on a specific videoId, bypass tick (no seeds/ratios needed)
    (async () => {
      const videoId = msg.videoId;
      if (!videoId) {
        sendResponse({ ok: false, err: 'videoId required' });
        return;
      }
      const state = await Store.getState();
      const doLike = msg.doLike ?? true;
      const doComment = msg.doComment ?? false;
      const commentText = msg.commentText || '';
      const doSubscribe = msg.doSubscribe ?? false;
      const subscribeChannel = msg.subscribeChannel || '';
      try {
        await openAndWatch(videoId, {
          like: doLike,
          comment: doComment,
          commentText,
          subscribe: doSubscribe,
          subscribeChannel,
          quick: !!msg.quick,
        });
        sendResponse({ ok: true, videoId, tabId: _currentWatchTabId });
      } catch (e) {
        sendResponse({ ok: false, err: e.message });
      }
    })();
    return true;
  }
});

async function handleGetStatus() {
  const state = await Store.getState();
  const today = Store.todayKey();
  const t = state.stats[today] || { watch: 0, like: 0, comment: 0, subscribe: 0, total: 0 };
  // Build built-in niche list (id + label + keywords) for the popup
  const builtInNiches = Object.entries(Niches.NICHE_BANK).map(([id, info]) => ({
    id,
    label: info.label || id,
    keywords: info.keywords || [],
  }));
  return {
    running: state.running,
    ageDays: Store.accountAgeDays(state),
    canComment: Store.canComment(state),
    isInActiveHours: Store.isInActiveHours(state.settings),
    canAct: Store.canAct(state),
    today: t,
    channels: state.channels || [],
    primaryNiche: state.primaryNiche,
    seedsCount: (state.seeds || []).length,
    lastCheckpointAt: state.lastCheckpointAt,
    currentWatchTabId: _currentWatchTabId,
    settings: state.settings,
    maxChannels: MAX_CHANNELS,
    lastVisitedChannel: state.lastVisitedChannel || null,
    builtInNiches,
    customNiches: state.customNiches || {},
    deletedBuiltInNiches: state.deletedBuiltInNiches || [],
    profileId: state.profileId || '',
    profileDoneDate: state.profileDoneDate || '',
    profileDoneAt: state.profileDoneAt || null,
  };
}

/**
 * Re-detect all channels sequentially. Used by "Refresh all" button.
 */
async function refreshAllChannels() {
  const state = await Store.getState();
  const results = [];
  for (const ch of state.channels) {
    try {
      const targetUrl = `https://www.youtube.com/@${ch.handle}/videos`;
      const r = await detectChannelVideos(targetUrl, ch.handle);
      if (r?.videos?.length) {
        const updated = (await Store.getState()).channels.map((c) =>
          c.id === ch.id
            ? { ...c, videos: r.videos.slice(0, MAX_VIDEOS_PER_CHANNEL), lastRefresh: new Date().toISOString() }
            : c
        );
        await Store.setState({ channels: updated });
        results.push({ id: ch.id, ok: true, videoCount: r.videos.length });
      } else {
        results.push({ id: ch.id, ok: false, reason: 'no videos' });
      }
    } catch (e) {
      results.push({ id: ch.id, ok: false, reason: e.message });
    }
    await Human.sleep(Human.humanDelay(2000, 5000));
  }
  await refreshSeeds();
  return { ok: true, results };
}

async function refreshOneChannel(channelId) {
  const state = await Store.getState();
  const ch = findChannelById(state.channels, channelId);
  if (!ch) return { ok: false, reason: 'channel not found' };
  const targetUrl = `https://www.youtube.com/@${ch.handle}/videos`;
  const r = await detectChannelVideos(targetUrl, ch.handle);
  if (!r?.videos?.length) return { ok: false, reason: 'no videos detected' };
  const updated = (await Store.getState()).channels.map((c) =>
    c.id === channelId
      ? { ...c, videos: r.videos.slice(0, MAX_VIDEOS_PER_CHANNEL), lastRefresh: new Date().toISOString() }
      : c
  );
  await Store.setState({ channels: updated });
  await refreshSeeds();
  return { ok: true, videoCount: r.videos.length };
}

/**
 * Bulk import: parse URL list (one per line), detect each, add to channels.
 * Stops at MAX_CHANNELS.
 */
async function handleBulkImport(urls) {
  if (!Array.isArray(urls) || urls.length === 0) {
    return { ok: false, reason: 'no urls provided' };
  }
  const results = [];
  for (const raw of urls) {
    const url = (raw || '').trim();
    if (!url) continue;
    if (!/youtube\.com/.test(url)) {
      results.push({ url, ok: false, reason: 'not a youtube url' });
      continue;
    }
    const state = await Store.getState();
    if (state.channels.length >= MAX_CHANNELS) {
      results.push({ url, ok: false, reason: `list full (max ${MAX_CHANNELS})` });
      break;
    }
    const handle = extractHandle(url);
    if (!handle) {
      results.push({ url, ok: false, reason: 'cannot parse handle' });
      continue;
    }
    if (findChannelByHandle(state.channels, handle)) {
      results.push({ url, ok: false, reason: 'duplicate' });
      continue;
    }
    const targetUrl = `https://www.youtube.com/@${handle}/videos`;
    const r = await detectChannelVideos(targetUrl, handle);
    if (r?.videos?.length) {
      const micro = r.microformat || {};
      const addRes = await addChannelFromDetect({
        handle,
        url: targetUrl,
        displayName: micro.title || handle,
        niche: r.topNiche,
        confidence: r.confidence,
        videos: r.videos,
      });
      results.push({ url, ok: addRes.ok, channel: addRes.channel, reason: addRes.reason });
    } else {
      results.push({ url, ok: false, reason: 'no videos' });
    }
    await Human.sleep(Human.humanDelay(2000, 5000));
  }
  await refreshSeeds();
  return { ok: true, results };
}

/**
 * Add or update a custom niche.
 * Validates id format, label non-empty, keywords non-empty.
 * Refuses to overwrite built-in niches.
 * Limit: 10 custom niches max.
 */
async function handleAddNiche(id, label, keywords) {
  if (!id || !label) {
    return { ok: false, reason: 'Need id and label' };
  }
  if (!Array.isArray(keywords)) keywords = [];
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) {
    return { ok: false, reason: 'ID must be lowercase letters/digits/dashes, start with letter or digit, max 41 chars' };
  }
  if (Niches.NICHE_BANK[id]) {
    // Allow only if the user previously removed (hid) this default niche — that means
    // they want to re-add it with their own keywords.
    const stateForHidden = await Store.getState();
    const hidden = stateForHidden.deletedBuiltInNiches || [];
    if (!hidden.includes(id)) {
      return { ok: false, reason: `"${id}" is a default niche. Either remove it first or pick a different ID.` };
    }
    // User is replacing a hidden default with their own version. Clear the hidden flag.
    await Store.setState({ deletedBuiltInNiches: hidden.filter((x) => x !== id) });
  }
  const state = await Store.getState();
  const custom = { ...(state.customNiches || {}) };
  // No cap — user-added niches behave like built-in and have no limit.
  // Reject if a channel currently uses this niche as 'unknown' or another custom name? Skip — allow overwrite.
  const cleanKeywords = keywords.map((k) => String(k).toLowerCase().trim()).filter(Boolean);
  custom[id] = {
    label,
    keywords: cleanKeywords,
    // searchKeywords kept for back-compat with any old logic; no longer used for YouTube search
    searchKeywords: cleanKeywords.slice(0, 4),
    createdAt: custom[id]?.createdAt || new Date().toISOString(),
  };
  const isUpdate = !!state.customNiches?.[id];
  await Store.setState({ customNiches: custom });
  // Recompute primary niche (channels tagged with this niche now count)
  const primary = Store.computePrimaryNiche(state.channels);
  await Store.setState({ primaryNiche: primary?.niche || null });
  await logActivity(isUpdate ? 'niche_updated' : 'niche_added', `${isUpdate ? 'Updated' : 'Created'} niche "${label}"`, {
    id, label, keywordCount: keywords.length,
  });
  return { ok: true, id };
}

/**
 * Delete a custom niche, or hide a built-in one. Channels tagged with a removed
 * niche keep the tag (display only) but stop being counted toward primaryNiche.
 *
 * If the user has a custom version of a default niche, the custom is deleted first
 * (and the hidden flag for the default is preserved if set).
 */
async function handleDeleteNiche(nicheId) {
  if (!nicheId) return { ok: false, reason: 'nicheId required' };
  const state = await Store.getState();
  const custom = { ...(state.customNiches || {}) };
  if (custom[nicheId]) {
    // User has a custom version (which may be overriding a default). Delete the custom.
    const removedLabel = custom[nicheId]?.label || nicheId;
    delete custom[nicheId];
    await Store.setState({ customNiches: custom });
    const primary = Store.computePrimaryNiche(state.channels);
    await Store.setState({ primaryNiche: primary?.niche || null });
    await logActivity('niche_deleted', `Deleted niche "${removedLabel}"`, { id: nicheId, label: removedLabel, type: Niches.NICHE_BANK[nicheId] ? 'user-override' : 'user' });
    return { ok: true, kind: Niches.NICHE_BANK[nicheId] ? 'user-override-deleted' : 'user-deleted' };
  }
  if (Niches.NICHE_BANK[nicheId]) {
    // Built-in (no custom override): hide it.
    const hidden = Array.from(new Set([...(state.deletedBuiltInNiches || []), nicheId]));
    await Store.setState({ deletedBuiltInNiches: hidden });
    const label = Niches.NICHE_BANK[nicheId]?.label || nicheId;
    await logActivity('niche_deleted', `Removed default niche "${label}"`, { id: nicheId, label, type: 'default' });
    const primary = Store.computePrimaryNiche(state.channels);
    await Store.setState({ primaryNiche: primary?.niche || null });
    return { ok: true, kind: 'default-hidden' };
  }
  return { ok: false, reason: `Niche "${nicheId}" not found` };
}

/**
 * Restore one or all hidden default niches.
 * msg.nicheId: specific id to restore, or 'all' to restore everything.
 */
async function handleRestoreDefaultNiche(nicheId) {
  const state = await Store.getState();
  const hidden = state.deletedBuiltInNiches || [];
  if (!nicheId || nicheId === 'all') {
    if (hidden.length === 0) return { ok: true, restored: 0 };
    await Store.setState({ deletedBuiltInNiches: [] });
    await logActivity('niches_restored', `Restored ${hidden.length} default niche(s)`, { ids: hidden });
    return { ok: true, restored: hidden.length };
  }
  if (!hidden.includes(nicheId)) return { ok: false, reason: `"${nicheId}" was not hidden` };
  const next = hidden.filter((id) => id !== nicheId);
  await Store.setState({ deletedBuiltInNiches: next });
  const label = Niches.NICHE_BANK[nicheId]?.label || nicheId;
  await logActivity('niche_restored', `Restored default niche "${label}"`, { id: nicheId, label });
  return { ok: true, restored: 1 };
}

async function handleDetectFromUrl(url, forceNiche = null) {
  const log = [];
  const t0 = Date.now();
  const logStep = (label, data) => {
    const entry = { t: Date.now() - t0, label, data };
    log.push(entry);
    console.log(`[nuoi-yt][detect +${entry.t}ms] ${label}`, data || '');
  };

  if (!url || !/youtube\.com/.test(url)) {
    return { ok: false, reason: 'invalid url', debug: log };
  }

  // Validate forceNiche if provided. Special value '__none__' means "don't tag a niche".
  let userChoseNoNiche = false;
  if (forceNiche) {
    if (forceNiche === '__none__') {
      userChoseNoNiche = true;
      logStep('forced_niche', { niche: '__none__' });
    } else {
      const state = await Store.getState();
      const builtInIds = Object.keys(Niches.NICHE_BANK);
      const customIds = Object.keys(state.customNiches || {});
      if (!builtInIds.includes(forceNiche) && !customIds.includes(forceNiche)) {
        return { ok: false, reason: `Unknown niche "${forceNiche}"`, debug: log };
      }
      logStep('forced_niche', { niche: forceNiche });
    }
  }

  // Normalize to /videos tab
  let targetUrl = url;
  let handle = url.match(/\/@([\w.-]+)/)?.[1];
  if (!handle) {
    const ch = url.match(/\/channel\/([\w-]+)/)?.[1];
    if (ch) {
      targetUrl = `https://www.youtube.com/channel/${ch}/videos`;
    } else {
      const c = url.match(/\/c\/([\w.-]+)/)?.[1];
      if (c) {
        targetUrl = `https://www.youtube.com/c/${c}/videos`;
      } else {
        return { ok: false, reason: 'cannot parse channel from url', debug: log };
      }
    }
  } else {
    targetUrl = url.includes('/videos') ? url : `https://www.youtube.com/@${handle}/videos`;
  }
  logStep('normalized_url', { input: url, output: targetUrl });

  let tab;
  try {
    tab = await chrome.tabs.create({ url: targetUrl, active: false });
    logStep('tab_created', { id: tab.id });
  } catch (e) {
    logStep('tab_create_failed', { error: e.message });
    return { ok: false, reason: e.message, debug: log };
  }

  await waitForTabComplete(tab.id, 30000);
  logStep('tab_complete');

  // Wait for SPA hydration
  await Human.sleep(5000);
  logStep('after_hydration_wait');

  // Pre-scroll
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        return new Promise((resolve) => {
          let n = 0;
          const tick = () => {
            window.scrollBy(0, 800);
            n++;
            if (n < 3) setTimeout(tick, 1000);
            else { window.scrollTo(0, 0); resolve(); }
          };
          tick();
        });
      },
    });
    logStep('prescroll_done');
  } catch (e) {
    logStep('prescroll_failed', { error: e.message });
  }
  await Human.sleep(2500);

  // Run scrape with debug info (file injection: avoids func: serialization issues)
  let debug = null;
  try {
    // Inject custom niches first so scrape-page.js can merge them into its NICHE_BANK
    const stateForNiches = await Store.getState();
    const customNiches = stateForNiches.customNiches || {};
    if (Object.keys(customNiches).length > 0) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (niches) => { window.__customNiches = niches; },
        args: [customNiches],
      }).catch(() => {});
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['background/scrape-page.js'],
    }).catch((e) => {
      logStep('executeScript_throw', { error: e.message });
    });
    const r2 = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.__lastScrape || null,
    });
    debug = r2?.[0]?.result;
    logStep('scrape_returned', {
      source: debug?.source,
      videoCount: debug?.videos?.length || 0,
      jsonFound: debug?.jsonDebug?.found,
      jsonVideoRenderers: debug?.jsonDebug?.videoRenderers,
      perSelector: debug?.perSelector,
    });
    if (debug?.videos?.length) {
      logStep('first_3_titles', debug.videos.slice(0, 3).map((v) => v.title));
    }
    console.log('[nuoi-yt][detect] FULL DEBUG:', JSON.stringify(debug, null, 2));

    if (debug?.videos?.length) {
      // Add as new channel (or update existing). forceNiche overrides auto-detect.
      // '__none__' or no niche detected → save with niche=null.
      const micro = debug.microformat || {};
      const displayName = micro.title || handle;
      const finalNiche = userChoseNoNiche ? null : (forceNiche || debug.topNiche);
      const addResult = await addChannelFromDetect({
        handle,
        url: targetUrl.split('?')[0],
        displayName,
        niche: finalNiche,
        confidence: userChoseNoNiche ? 0 : (forceNiche ? 1.0 : debug.confidence),
        videos: debug.videos,
      });
      chrome.tabs.remove(tab.id).catch(() => {});
      logStep('channel_add_result', addResult);
      setTimeout(() => refreshSeeds(), 2000);
      await chrome.storage.local.set({ lastDetectLog: { ts: Date.now(), log, debug } });
      if (addResult.ok) {
        return {
          ok: true,
          channel: addResult.channel,
          updated: addResult.updated,
          totalChannels: (await Store.getState()).channels.length,
        };
      }
      return { ok: false, reason: addResult.reason, debug: log };
    }

    // Fallback: diagnose
    const diag = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: diagnoseChannelPage,
    }).catch(() => null);
    const reason = diag?.[0]?.result || 'no videos found';
    logStep('failed', reason);
    await chrome.storage.local.set({ lastDetectLog: { ts: Date.now(), log, debug, reason } });
    return { ok: false, reason: JSON.stringify(reason), debug: log };
  } catch (e) {
    logStep('execute_failed', { error: e.message });
    return { ok: false, reason: e.message, debug: log };
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

/**
 * Auto-download helpers.
 * Two modes:
 *  - onArchive: triggered by logActivity() when an archive chunk is created
 *  - daily: scheduled by chrome.alarms (one shot at the configured hour each day)
 * Both clear the affected storage after a successful download so we don't fill up.
 */

function buildDownloadPayload(kind, archive, archiveIndex, active, includeActive) {
  const tsStr = new Date().toISOString().replace(/[:.]/g, '-');
  let payload, filename;
  if (kind === 'archive') {
    payload = {
      kind: 'archive',
      exportedAt: new Date().toISOString(),
      archiveIndex,
      ...archive,
    };
    filename = `${ARCHIVE_FILE_PREFIX}-archive-${archiveIndex}-${tsStr}.json`;
  } else {
    // 'all' (daily/manual): active + all archives
    payload = {
      kind: 'all',
      exportedAt: new Date().toISOString(),
      archiveChunks: archive.length,
      activeEvents: includeActive ? active.length : 0,
      archives: archive,
    };
    if (includeActive) payload.active = active;
    filename = `${ARCHIVE_FILE_PREFIX}-all-${tsStr}.json`;
  }
  return { payload, filename };
}

/**
 * Download a single archive to Downloads folder via chrome.downloads.
 * If clearAfterDownload is true, remove the archive from storage on success.
 * Returns { ok, downloadId, filename, error? }.
 */
async function downloadAndClearArchive(archiveIndex, clearAfterDownload = true) {
  const state = await Store.getState();
  const archive = Array.isArray(state.activityLogArchive) ? state.activityLogArchive : [];
  if (archiveIndex < 0 || archiveIndex >= archive.length) {
    return { ok: false, error: 'Invalid archive index' };
  }
  const target = archive[archiveIndex];
  const { payload, filename } = buildDownloadPayload('archive', target, archiveIndex);
  const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(payload, null, 2));
  let downloadId;
  try {
    downloadId = await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
  } catch (e) {
    await logActivity('auto_download_failed', `Auto-download archive ${archiveIndex} failed: ${e.message}`, { archiveIndex, error: e.message }, 'error');
    return { ok: false, error: e.message };
  }
  // Wait for download to complete (poll briefly)
  await waitForDownloadComplete(downloadId);
  // Remove the archive from storage (FIFO)
  if (clearAfterDownload) {
    archive.splice(archiveIndex, 1);
    await Store.setState({ activityLogArchive: archive });
  }
  await logActivity('auto_downloaded', `Auto-downloaded archive ${archiveIndex} → ${filename}${clearAfterDownload ? ' (cleared)' : ''}`, {
    downloadId, filename, kind: 'archive', index: archiveIndex, count: target.count, cleared: clearAfterDownload,
  });
  return { ok: true, downloadId, filename };
}

/**
 * Download everything (active + all archives) and clear storage.
 * Used for daily scheduled dump + manual trigger.
 */
async function downloadAndClearAll(includeActive) {
  const state = await Store.getState();
  const archive = Array.isArray(state.activityLogArchive) ? state.activityLogArchive : [];
  const active = Array.isArray(state.activityLog) ? state.activityLog : [];
  if (archive.length === 0 && active.length === 0) {
    return { ok: true, skipped: true, reason: 'nothing to download' };
  }
  const { payload, filename } = buildDownloadPayload('all', archive, 0, active, includeActive);
  const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(payload, null, 2));
  let downloadId;
  try {
    downloadId = await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
  } catch (e) {
    await logActivity('auto_download_failed', `Daily/auto dump failed: ${e.message}`, { error: e.message }, 'error');
    return { ok: false, error: e.message };
  }
  await waitForDownloadComplete(downloadId);
  // Clear both storage buckets after successful download
  await Store.setState({ activityLog: [], activityLogArchive: [] });
  await logActivity('auto_downloaded', `Auto-downloaded all logs → ${filename} (cleared)`, {
    downloadId, filename, kind: 'all', activeCount: active.length, archiveCount: archive.length,
  });
  return { ok: true, downloadId, filename, activeCount: active.length, archiveCount: archive.length };
}

/**
 * Poll chrome.downloads until the download is complete (or 30s timeout).
 * Returns true on success, false on failure/timeout.
 */
/**
 * Multi-profile orchestrator support.
 *
 * The bash script `nurture-all.sh` runs the extension in N Chrome profiles in sequence.
 * When this profile hits the daily action cap, we write a marker file via chrome.downloads
 * to `~/Downloads/nuoi-yt/{profileId}-done-{YYYY-MM-DD}.json`. The orchestrator polls for
 * this file and switches to the next profile once it appears.
 *
 * We deduplicate per-day via state.profileDoneDate: if we already wrote the marker today
 * (for this profileId), we don't re-write it on every subsequent tick skip.
 */
const PROFILE_DONE_DIR = 'nuoi-yt';  // no leading dot — chrome.downloads rejects hidden folder names
const PROFILE_DONE_FILENAME = 'done.json'; // final path: ~/Downloads/nuoi-yt/{profileId}-done-{date}.json
async function signalProfileDone(state, reason) {
  try {
    const profileId = (state.profileId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    const today = Store.todayKey();
    if (state.profileDoneDate === today) {
      // Already signaled today
      return;
    }
    const payload = {
      profileId,
      date: today,
      reason: reason || 'cap_reached',
      actions: state.stats?.[today] || {},
      signaledAt: new Date().toISOString(),
    };
    const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(payload, null, 2));
    // Use a subfolder under Downloads so the orchestrator can glob it
    const filename = `${PROFILE_DONE_DIR}/${profileId}-done-${today}.json`;
    try {
      const downloadId = await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
      // Mark done so we don't re-write
      await Store.setState({ profileDoneDate: today, profileDoneAt: Date.now() });
      await logActivity('profile_done_signaled', `Signaled profile "${profileId}" done for ${today}`, {
        profileId, date: today, reason, downloadId, filename, todayCount: payload.actions?.total,
      });
    } catch (e) {
      // No downloads permission or other issue — silent fail
      console.warn('[nuoi-yt] signalProfileDone download failed', e.message);
    }
  } catch (e) {
    console.warn('[nuoi-yt] signalProfileDone err', e.message);
  }
}

async function waitForDownloadComplete(downloadId) {
  const start = Date.now();
  const timeoutMs = 30000;
  while (Date.now() - start < timeoutMs) {
    try {
      const items = await new Promise((resolve, reject) => {
        chrome.downloads.search({ id: downloadId }, (results) => {
          if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
          resolve(results || []);
        });
      });
      if (items.length > 0) {
        const state = items[0].state;
        if (state === 'complete') return true;
        if (state === 'error' || state === 'interrupted') return false;
      }
    } catch (e) {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Schedule the daily auto-download alarm. Uses one-shot alarms recomputed daily.
 * Period is set to 24h, but we recompute on each fire to honor timezone.
 */
async function setupAutoDownloadAlarm() {
  await chrome.alarms.clear(AUTO_DOWNLOAD_ALARM).catch(() => {});
  const state = await Store.getState();
  const cfg = state.autoDownloadConfig || {};
  if (!cfg.enabled || !cfg.daily) return;
  const hour = Math.max(0, Math.min(23, parseInt(cfg.dailyHour, 10) || 3));
  // Compute next fire: today at `hour:00` if still in the future, otherwise tomorrow
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  const delayMin = Math.max(1, Math.round((target.getTime() - now.getTime()) / 60000));
  await chrome.alarms.create(AUTO_DOWNLOAD_ALARM, { delayInMinutes: delayMin, periodInMinutes: 24 * 60 });
  await logActivity('auto_download_alarm_set', `Daily auto-download scheduled at ${hour}:00 (next fire in ${delayMin}m)`, { hour, delayMin });
}

function diagnoseChannelPage() {
  return {
    url: location.href,
    pageTitle: document.title,
    watchHrefCount: document.querySelectorAll('a[href*="watch"]').length,
    titleLinkCount: document.querySelectorAll('a#video-title-link').length,
    richItemCount: document.querySelectorAll('ytd-rich-item-renderer').length,
    gridVideoCount: document.querySelectorAll('ytd-grid-video-renderer').length,
    bodyTextSample: (document.body.textContent || '').slice(0, 300),
  };
}

// Alarm de trigger tick now
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'nuoi-yt-tick-now') {
    tick();
  }
});

console.log('[nuoi-yt] service worker loaded');
