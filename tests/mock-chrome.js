/**
 * Chrome API mock for Node.js tests.
 * Mocks: chrome.storage.local, chrome.alarms, chrome.tabs, chrome.runtime,
 *         chrome.scripting, chrome.permissions.
 *
 * Loaded before any extension code that uses chrome.* APIs.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ---------- In-memory storage ----------
const _store = {};
function getImpl(keys, cb) {
  let result = {};
  const list = Array.isArray(keys) ? keys : (keys ? [keys] : Object.keys(_store));
  for (const k of list) if (k in _store) result[k] = _store[k];
  if (cb) cb(result);
  return result;
}
function setImpl(obj, cb) {
  Object.assign(_store, obj);
  if (cb) cb();
}
function removeImpl(keys, cb) {
  const list = Array.isArray(keys) ? keys : [keys];
  for (const k of list) delete _store[k];
  if (cb) cb();
}
function clearImpl(cb) {
  for (const k of Object.keys(_store)) delete _store[k];
  if (cb) cb();
}

// ---------- Alarms ----------
const _alarms = {};
const _alarmListeners = [];
function alarmCreate(name, info) { _alarms[name] = { ...info, name }; }
function alarmGet(name, cb) { cb(_alarms[name] || null); }
function alarmClear(name, cb) { delete _alarms[name]; if (cb) cb(true); }
function alarmList(cb) { cb(Object.values(_alarms)); }
function alarmFire(name) {
  const alarm = _alarms[name];
  if (!alarm) return;
  for (const fn of _alarmListeners) fn(alarm);
}
function alarmAddListener(fn) { _alarmListeners.push(fn); }

// ---------- Tabs ----------
const _tabs = [];
let _nextTabId = 1;
function tabCreate(opts, cb) {
  const tab = { id: _nextTabId++, url: opts.url || 'about:blank', status: 'loading', active: opts.active !== false };
  _tabs.push(tab);
  if (cb) cb(tab);
  return tab;
}
function tabRemove(id, cb) {
  const idx = _tabs.findIndex((t) => t.id === id);
  if (idx >= 0) _tabs.splice(idx, 1);
  if (cb) cb(true);
}
function tabGet(id, cb) {
  const t = _tabs.find((x) => x.id === id);
  cb(t || null);
}
function tabUpdate(id, info, cb) {
  const t = _tabs.find((x) => x.id === id);
  if (t) Object.assign(t, info);
  if (cb) cb(t);
}

// ---------- Tabs update listener (fires when status changes) ----------
const _tabUpdateListeners = [];
function tabUpdateAddListener(fn) { _tabUpdateListeners.push(fn); }
function tabUpdateFire(tabId, info) {
  for (const fn of _tabUpdateListeners) fn(tabId, info, { tab: _tabs.find((t) => t.id === tabId) });
}

// ---------- Runtime ----------
const _runtimeListeners = [];
function runtimeAddListener(fn) { _runtimeListeners.push(fn); }
function runtimeSendMessage(msg, cb) {
  // Minimal: just resolve with empty
  if (cb) setTimeout(() => cb({ ok: true }), 10);
}
function runtimeOnMessageAddListener(fn) { _runtimeListeners.push(fn); }

// ---------- Scripting ----------
function scriptingExecuteScript(opts, cb) {
  // We don't actually run scripts in Node tests. Tests that need this
  // mock it specifically.
  if (cb) cb([{ result: null }]);
}

// ---------- Build chrome global ----------
global.chrome = {
  storage: { local: { get: getImpl, set: setImpl, remove: removeImpl, clear: clearImpl } },
  alarms: { create: alarmCreate, get: alarmGet, clear: alarmClear, list: alarmList, onAlarm: { addListener: alarmAddListener } },
  tabs: {
    create: tabCreate, remove: tabRemove, get: tabGet, update: tabUpdate,
    onUpdated: { addListener: tabUpdateAddListener },
  },
  runtime: {
    sendMessage: runtimeSendMessage,
    onMessage: { addListener: runtimeOnMessageAddListener },
    onInstalled: { addListener: (fn) => {} },
    onStartup: { addListener: (fn) => {} },
    lastError: null,
  },
  scripting: { executeScript: scriptingExecuteScript },
  permissions: { contains: () => true },
};

// Load self context (for lib files that use self/global)
global.self = global;

module.exports = {
  ROOT,
  chrome: global.chrome,
  _store,
  resetStore: () => { for (const k of Object.keys(_store)) delete _store[k]; },
  _alarms,
  _tabs,
  alarmFire,
  tabUpdateFire,
};
