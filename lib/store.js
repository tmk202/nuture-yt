/**
 * chrome.storage.local wrapper.
 * Dong bo cho state can doc thuong xuyen (settings, stats, niche).
 */
(function (global) {
  'use strict';

  function get(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, (res) => resolve(res));
    });
  }
  function set(obj) {
    return new Promise((resolve) => {
      chrome.storage.local.set(obj, () => resolve());
    });
  }
  function remove(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.remove(keys, () => resolve());
    });
  }
  function clear() {
    return new Promise((resolve) => {
      chrome.storage.local.clear(() => resolve());
    });
  }

  const DEFAULT_STATE = {
    settings: {
      activeHours: { start: 8, end: 23 },
      actionsPerDay: { min: 8, max: 20 },
      ratios: { comment: 0.15, like: 0.45, subscribe: 0.05, watch: 1.0 },
      watch: { maxSeconds: 600 },
      cooldownAfterCheckpointHours: 24,
      newAccount: { noCommentDays: 14, actionMultiplier: 0.5 },
      // When a channel is added, mark it pendingSubscribe=true and the next watch
      // from that channel will force-subscribe (bypassing the 1/day + 5% ratios).
      // subscribeBurstPerDay caps how many such forced subscribes we do per day (to avoid flagging).
      subscribeBurstPerDay: 5,
    },
    account: {
      createdAt: new Date().toISOString(), // first install
    },
    channels: [],        // [{ id, handle, url, displayName, niche, confidence, videos: [{videoId, title, discoveredAt}], addedAt, lastRefresh }]
    primaryNiche: null,  // most common niche across channels (computed)
    customNiches: {},   // user-defined niches: { id: { label, keywords, searchKeywords, createdAt } }
    deletedBuiltInNiches: [],  // default niche ids the user has hidden/removed from their view
    activityLog: [],    // persistent event log: [{ ts, type, level, message, data }] (active, last 500)
    activityLogArchive: [], // ring buffer of archived chunks: [{ archivedAt, count, firstTs, lastTs, events }] (max 5)
    autoDownloadConfig: {  // settings for auto-downloading log to ~/Downloads
      enabled: false,        // master switch
      onArchive: false,     // auto-download each new archive chunk when log fills up
      daily: false,         // scheduled daily dump (uses dailyHour)
      dailyHour: 3,         // 0-23, local time
      clearAfterDownload: true, // remove from storage after successful download
      filePrefix: 'youtube-nurture-log', // filename prefix
    },
    profileId: '',        // unique id for this Chrome profile (e.g., 'yt-1', 'alice-sg', 'acc-bob'). Used by nurture-all.sh orchestrator.
    profileDoneDate: '',  // YYYY-MM-DD of last time we wrote the profile-done marker (dedup signal)
    profileDoneAt: null,  // ms epoch of last marker write
    seeds: [],           // [{ videoId, title, channelName, source: 'channel:<id>' | 'search:...' }]
    history: {
      watched: [],       // [{ videoId, title, channel, channelId, watchedAt, duration }]
      liked: [],         // [{ videoId, likedAt }]
      commented: [],     // [{ videoId, comment, date, ts }]
      subscribed: [],    // [{ channel, channelId, subscribedAt }]
    },
    stats: {},           // { 'YYYY-MM-DD': { watch, like, comment, subscribe, total } }
    lastCheckpointAt: null,
    running: false,
  };

  const MAX_CHANNELS = 10;

  async function getState() {
    const res = await get(Object.keys(DEFAULT_STATE));
    // Deep-merge defaults with stored values, ALWAYS creating new nested objects
    // so callers can mutate state without affecting DEFAULT_STATE.
    const state = {};
    for (const k of Object.keys(DEFAULT_STATE)) {
      const def = DEFAULT_STATE[k];
      const stored = res[k];
      if (typeof def === 'object' && def !== null && !Array.isArray(def)) {
        state[k] = { ...def, ...(stored || {}) };
      } else if (stored !== undefined) {
        state[k] = stored;
      } else {
        state[k] = def;
      }
    }
    return state;
  }

  async function setState(patch) {
    await set(patch);
  }

  async function patchAndGet(patch) {
    await set(patch);
    return getState();
  }

  /**
   * Tinh so ngay tu createdAt.
   */
  function accountAgeDays(state) {
    const days = (Date.now() - new Date(state.account.createdAt).getTime()) / 86400000;
    return Math.floor(days);
  }

  function canComment(state) {
    return accountAgeDays(state) >= state.settings.newAccount.noCommentDays;
  }

  function isInActiveHours(settings) {
    const h = new Date().getHours();
    return h >= settings.activeHours.start && h < settings.activeHours.end;
  }

  function todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  function actionsToday(state) {
    return state.stats[todayKey()]?.total || 0;
  }

  function dailyActionCap(state) {
    const cap = state.settings.actionsPerDay.max;
    if (accountAgeDays(state) < 30) {
      return Math.max(2, Math.floor(cap * state.settings.newAccount.actionMultiplier));
    }
    return cap;
  }

  function canAct(state) {
    if (!isInActiveHours(state.settings)) {
      return { allowed: false, reason: `Outside active hours (${state.settings.activeHours.start}:00–${state.settings.activeHours.end}:00)` };
    }
    const used = actionsToday(state);
    const cap = dailyActionCap(state);
    if (used >= cap) {
      return { allowed: false, reason: `Daily cap reached (${used}/${cap})` };
    }
    if (state.lastCheckpointAt) {
      const hours = (Date.now() - new Date(state.lastCheckpointAt).getTime()) / 3600000;
      if (hours < state.settings.cooldownAfterCheckpointHours) {
        return { allowed: false, reason: `Cooldown after checkpoint (${Math.ceil(state.settings.cooldownAfterCheckpointHours - hours)}h left)` };
      }
    }
    return { allowed: true, remaining: cap - used, cap };
  }

  async function recordAction(kind) {
    const state = await getState();
    const t = todayKey();
    if (!state.stats[t]) state.stats[t] = { watch: 0, like: 0, comment: 0, subscribe: 0, total: 0 };
    state.stats[t][kind] = (state.stats[t][kind] || 0) + 1;
    state.stats[t].total = (state.stats[t].total || 0) + 1;
    await set({ stats: state.stats });
  }

  async function recordCheckpoint() {
    await set({ lastCheckpointAt: new Date().toISOString() });
  }

  global.Store = {
    get, set, remove, clear, getState, setState, patchAndGet,
    accountAgeDays, canComment, isInActiveHours, actionsToday, dailyActionCap, canAct,
    recordAction, recordCheckpoint, todayKey,
    MAX_CHANNELS,
    computePrimaryNiche,
  };

  /**
   * Compute primary niche = most common niche across channels.
   * Returns { niche, count, total, breakdown: { niche: count } } or null if no channels.
   */
  function computePrimaryNiche(channels) {
    if (!channels || channels.length === 0) return null;
    const counts = {};
    for (const c of channels) {
      if (c.niche) counts[c.niche] = (counts[c.niche] || 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) return null;
    return {
      niche: sorted[0][0],
      count: sorted[0][1],
      total: channels.length,
      breakdown: counts,
    };
  }
})(typeof self !== 'undefined' ? self : this);
