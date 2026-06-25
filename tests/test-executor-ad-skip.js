/**
 * Unit tests for content/executor.js handleYouTubeAd().
 *
 * The function reads from document.querySelector and writes to <video>.currentTime.
 * We mock both for each test, run handleYouTubeAd, and verify behavior.
 *
 * Covers the long-engaged-view ad case (5+ minute ads) that the old
 * v.duration < 90s safety guard incorrectly skipped.
 */
'use strict';
require('./mock-chrome');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const { test, assert, group, run } = require('./framework');

// Set up minimal globals the IIFE expects
global.self = global;
require(path.join(ROOT, 'content', 'executor.js'));

// ---- Mock helpers ----
function makeMockDoc(plan) {
  // plan: { playerClass, skipButton, skipButtonModern, adOverlay, adText, videoDuration, videoCurrentTime }
  const calls = { clicks: 0, dispatches: 0, sets: [] };
  const skipBtn = plan.skipButton !== false ? { click: () => { calls.clicks++; }, offsetParent: 1, dispatchEvent: () => { calls.dispatches++; } } : null;
  const skipModern = plan.skipButtonModern !== false ? { click: () => { calls.clicks++; }, offsetParent: 1, dispatchEvent: () => { calls.dispatches++; } } : null;
  const overlay = plan.adOverlay ? { present: true } : null;
  const adText = plan.adText ? { present: true } : null;
  const v = {
    duration: plan.videoDuration,
    paused: false,
  };
  Object.defineProperty(v, 'currentTime', {
    get() { return v._ct; },
    set(t) { calls.sets.push(t); v._ct = t; },
    configurable: true,
  });
  v._ct = plan.videoCurrentTime || 0;

  global.document = {
    querySelector(sel) {
      if (sel === '#movie_player') {
        return { className: plan.playerClass || '' };
      }
      if (sel === '.ytp-ad-skip-button') return skipBtn;
      if (sel === '.ytp-ad-skip-button-modern') return skipModern;
      if (sel === '.ytp-skip-ad-button') return null;
      if (sel === '.ytp-ad-player-overlay') return overlay || null;
      if (sel === '.ytp-ad-text') return adText || null;
      if (sel === '.ytp-ad-player-overlay button[aria-label*="Skip" i]') return null;
      if (sel === 'video') return v;
      return null;
    },
  };

  return { v, calls };
}

group('executor.handleYouTubeAd', () => {
  // Reset module-level ad throttle between tests so the 500ms throttle
  // doesn't make sequential tests silently return false.
  const reset = () => YTExecutor._resetAdThrottle();

  test('returns false when player does not have ad-showing class', () => {
    reset();
    const { calls } = makeMockDoc({ playerClass: '', videoDuration: 30 });
    const r = YTExecutor.handleYouTubeAd();
    assert.equal(r, false);
    assert.equal(calls.clicks, 0, 'no clicks expected');
    assert.equal(calls.sets.length, 0, 'no currentTime sets expected');
  });

  test('clicks skip button when ad is showing and skip button visible', () => {
    reset();
    const { calls } = makeMockDoc({
      playerClass: 'ad-showing',
      skipButton: true,
      videoDuration: 30,
    });
    const r = YTExecutor.handleYouTubeAd();
    assert.equal(r, true);
    assert.equal(calls.clicks, 1, 'expected 1 click on skip button');
    assert.equal(calls.sets.length, 0, 'no currentTime sets expected when skip button works');
  });

  test('REGRESSION: fast-forwards LONG (5+ min) unskippable ad when ad UI visible', () => {
    reset();
    // The HeyGen engaged-view ad bug: 312s ad, no skip button, ad overlay visible.
    // Old code with `v.duration < 90` guard would skip this. New code must fast-forward.
    const { calls } = makeMockDoc({
      playerClass: 'ad-showing',
      skipButton: false,           // no skip button at all
      skipButtonModern: false,
      adOverlay: true,             // "HeyGen AI Video Generator" overlay visible
      adText: true,                // "Sponsored" text visible
      videoDuration: 312,          // 5:12 — way longer than the old 90s guard
      videoCurrentTime: 12,
    });
    const r = YTExecutor.handleYouTubeAd();
    assert.equal(r, true, 'expected to handle the ad');
    assert.truthy(calls.sets.length > 0, 'expected currentTime to be set');
    const newT = calls.sets[calls.sets.length - 1];
    assert.truthy(newT > 12, `expected currentTime to advance, got ${newT}`);
    assert.equal(Math.round(newT), 312, `expected to jump to ~duration-0.5 (311.5), got ${newT}`);
  });

  test('REGRESSION: fast-forwards mid-length (60s) unskippable ad', () => {
    reset();
    const { calls } = makeMockDoc({
      playerClass: 'ad-showing',
      skipButton: false,
      skipButtonModern: false,
      adOverlay: true,
      videoDuration: 60,
      videoCurrentTime: 0,
    });
    const r = YTExecutor.handleYouTubeAd();
    assert.equal(r, true);
    const newT = calls.sets[calls.sets.length - 1];
    assert.truthy(newT >= 59, `expected jump to ~59.5s, got ${newT}`);
  });

  test('does NOT fast-forward when ad-showing but no ad UI visible (transition window)', () => {
    reset();
    // Safety: when the real video just loaded but player still has ad-showing
    // class for a moment, we must NOT jump the real video to its end.
    const { calls } = makeMockDoc({
      playerClass: 'ad-showing',
      skipButton: false,
      skipButtonModern: false,
      adOverlay: false,
      adText: false,
      videoDuration: 600,        // real video (10 min)
      videoCurrentTime: 100,
    });
    const r = YTExecutor.handleYouTubeAd();
    assert.equal(r, false, 'should not skip without ad UI');
    assert.equal(calls.sets.length, 0, 'no currentTime sets in transition window');
  });

  test('detects ad via ad-interrupting class (mid-roll ads)', () => {
    reset();
    const { calls } = makeMockDoc({
      playerClass: 'ad-interrupting',
      skipButton: false,
      skipButtonModern: false,
      adOverlay: true,
      videoDuration: 20,
      videoCurrentTime: 5,
    });
    const r = YTExecutor.handleYouTubeAd();
    assert.equal(r, true);
    assert.truthy(calls.sets.length > 0, 'expected currentTime set on mid-roll ad');
  });

  test('force-clicks grayed skip button (dispatchEvent) when countdown still running', () => {
    reset();
    // YouTube engaged-view ads show a "Skip Ad" button that's grayed for the
    // first ~30s. We try to click it via dispatchEvent to bypass any styling.
    const { calls } = makeMockDoc({
      playerClass: 'ad-showing',
      skipButton: false,
      skipButtonModern: true,
      adOverlay: true,
      videoDuration: 60,
      videoCurrentTime: 5,
    });
    const r = YTExecutor.handleYouTubeAd();
    assert.equal(r, true);
    assert.truthy(calls.clicks + calls.dispatches > 0, 'expected click or dispatch on skip button');
  });
});

if (require.main === module) run();
