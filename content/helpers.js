/**
 * DOM helpers: extract data tu YouTube page.
 */
(function (global) {
  'use strict';

  /**
   * Lay videoId tu URL hien tai.
   */
  function getCurrentVideoId() {
    const m = location.pathname.match(/^\/watch/);
    if (!m) return null;
    const url = new URL(location.href);
    return url.searchParams.get('v');
  }

  /**
   * Lay channel handle hoac ID tu URL.
   * Tra ve { kind: 'handle'|'id'|'custom', value } hoac null.
   */
  function getCurrentChannel() {
    const path = location.pathname;
    let m = path.match(/^\/@([\w.-]+)/);
    if (m) return { kind: 'handle', value: m[1] };
    m = path.match(/^\/channel\/([\w-]+)/);
    if (m) return { kind: 'id', value: m[1] };
    m = path.match(/^\/c\/([\w.-]+)/);
    if (m) return { kind: 'custom', value: m[1] };
    m = path.match(/^\/user\/([\w.-]+)/);
    if (m) return { kind: 'user', value: m[1] };
    return null;
  }

  /**
   * Lay cac video tren channel page (tab Videos).
   * Tra ve [{ videoId, title }].
   */
  function getChannelVideos() {
    const out = [];
    const anchors = document.querySelectorAll('a#video-title-link, a#thumbnail[href*="watch"]');
    anchors.forEach((a) => {
      const title = (a.textContent || a.getAttribute('aria-label') || a.getAttribute('title') || '').trim();
      const href = a.getAttribute('href') || '';
      const m = href.match(/[?&]v=([\w-]+)/);
      if (m && title) {
        out.push({ videoId: m[1], title: title.slice(0, 200) });
      }
    });
    return out;
  }

  /**
   * Get the title of the video currently being watched.
   */
  function getWatchTitle() {
    const el = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string, #title h1 yt-formatted-string');
    return (el?.textContent || '').trim();
  }

  /**
   * Get the channel name of the video currently being watched.
   */
  function getWatchChannelName() {
    const el = document.querySelector('ytd-channel-name a, #owner-name a, .ytd-video-owner-renderer a');
    return (el?.textContent || '').trim();
  }

  /**
   * Get the duration of the video currently being watched (in seconds).
   */
  function getWatchDurationSec() {
    const el = document.querySelector('.ytp-time-duration');
    if (!el) return 0;
    const txt = (el.textContent || '').trim();
    const parts = txt.split(':').map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
  }

  /**
   * Lay related videos tu watch page (sidebar).
   */
  function getRelatedVideos() {
    const out = [];
    document.querySelectorAll('ytd-compact-video-renderer').forEach((r) => {
      const a = r.querySelector('a#thumbnail');
      const title = a?.getAttribute('title') || r.querySelector('#video-title')?.textContent?.trim() || '';
      const href = a?.getAttribute('href') || '';
      const channelEl = r.querySelector('.ytd-channel-name');
      const channelName = (channelEl?.textContent || '').trim();
      const m = href.match(/[?&]v=([\w-]+)/);
      if (m && title) {
        out.push({ videoId: m[1], title: title.slice(0, 200), channelName: channelName.slice(0, 100) });
      }
    });
    return out;
  }

  /**
   * Like video: click like button neu chua like.
   * Tra ve 'liked' | 'already' | 'no_button' | 'error'.
   */
  async function clickLike() {
    const btn = document.querySelector('like-button-view-model button, button[aria-label*="Like" i]:not([aria-label*="Dislike"]):not([aria-label*="dislike"])');
    if (!btn) return 'no_button';
    if (btn.getAttribute('aria-pressed') === 'true') return 'already';
    try {
      btn.click();
      await new Promise((r) => setTimeout(r, 1000));
      return btn.getAttribute('aria-pressed') === 'true' ? 'liked' : 'error';
    } catch (e) {
      return 'error';
    }
  }

  /**
   * Subscribe: click sub button (rat han che).
   */
  async function clickSubscribe() {
    const btn = document.querySelector('button[aria-label*="Subscribe" i]');
    if (!btn) return 'no_button';
    const txt = (btn.textContent || '').toLowerCase();
    if (txt.includes('subscribed')) return 'already';
    try {
      btn.click();
      await new Promise((r) => setTimeout(r, 1500));
      return 'subscribed';
    } catch (e) {
      return 'error';
    }
  }

  /**
   * Post a single comment on the video currently being watched.
   * Returns 'posted' | 'no_box' | 'banned' | 'submit_failed' | 'error'.
   */
  async function postComment(text) {
    // New YouTube UI: comment box starts as a placeholder. Click to expand.
    // Step 1: find the simplebox placeholder
    let simplebox = document.querySelector('ytd-comment-simplebox-renderer');
    if (!simplebox) {
      try { chrome.storage.local.set({ lastCommentDebug: { reason: 'no_simplebox', ts: Date.now() } }); } catch (_) {}
      return 'no_box';
    }
    // Bring it into view first (helps trigger expansion in some YouTube builds)
    try { simplebox.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch (_) {}
    await new Promise((r) => setTimeout(r, 400));

    // Click on placeholder to expand the editor
    const placeholder = simplebox.querySelector('#placeholder-area') || simplebox;
    placeholder.click();
    simplebox.click();
    await new Promise((r) => setTimeout(r, 1500));

    // Step 2: wait for the actual editable area to appear (up to 8s)
    let box = null;
    for (let i = 0; i < 32; i++) {
      box = document.querySelector('#contenteditable-root, #content-text, [contenteditable="true"]');
      if (box) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!box) {
      try { chrome.storage.local.set({ lastCommentDebug: { reason: 'no_box_after_click', ts: Date.now() } }); } catch (_) {}
      return 'no_box';
    }

    // Click + focus
    box.click();
    box.focus();
    await new Promise((r) => setTimeout(r, 1000));

    // Step 3: insert text via paste event
    try {
      // Clear existing content
      box.innerHTML = '';
      // Use paste event (YouTube prefers this over typing)
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(box);
      sel.removeAllRanges();
      sel.addRange(range);

      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 2000));

      // Verify text is in box
      const current = (box.textContent || '').trim();
      if (current.length < 3) {
        // Fallback
        document.execCommand('insertText', false, text);
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch (e) {
      try { chrome.storage.local.set({ lastCommentDebug: { reason: 'paste_error', error: e.message, ts: Date.now() } }); } catch (_) {}
      return 'error';
    }

    // Step 4: wait for submit button to enable
    let submitBtn = null;
    for (let i = 0; i < 20; i++) {
      submitBtn = document.querySelector('#submit-button button, ytd-commentbox button[aria-label*="Comment" i]');
      if (submitBtn && !submitBtn.disabled) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!submitBtn || submitBtn.disabled) {
      try { chrome.storage.local.set({ lastCommentDebug: { reason: 'submit_not_enabled', textInBox: (box.textContent || '').trim().slice(0, 100), ts: Date.now() } }); } catch (_) {}
      return 'submit_failed';
    }

    try {
      submitBtn.click();
      await new Promise((r) => setTimeout(r, 3000));
      try { chrome.storage.local.set({ lastCommentDebug: { reason: 'posted', text: text.slice(0, 50), ts: Date.now() } }); } catch (_) {}
      return 'posted';
    } catch (e) {
      try { chrome.storage.local.set({ lastCommentDebug: { reason: 'click_error', error: e.message, ts: Date.now() } }); } catch (_) {}
      return 'error';
    }
  }

  /**
   * Check neu user da login YouTube.
   * - User NOT logged in: there's a "Sign in" button at top right
   * - User IS logged in: there's an avatar button at top right
   * The comment box selector is unreliable because it only renders after scrolling to it.
   */
  function isLoggedIn() {
    // Avatar button only exists when logged in
    if (document.querySelector('#avatar-btn, button#avatar-btn')) return true;
    // No sign-in button = logged in
    const hasSignInLink = document.querySelector(
      'a[href*="accounts.google.com/ServiceLogin"], a[aria-label*="Sign in" i], tp-yt-paper-button[aria-label*="Sign in" i]'
    );
    if (!hasSignInLink) return true;
    return false;
  }

  /**
   * Check CAPTCHA/checkpoint indicators.
   */
  function hasCheckpoint() {
    const text = document.body.textContent || '';
    return /sign\s+in\s+to\s+confirm/i.test(text) ||
           /unusual\s+traffic/i.test(text) ||
           /are\s+you\s+a\s+robot/i.test(text) ||
           /verify\s+you'?re\s+a\s+human/i.test(text);
  }

  global.YTHelpers = {
    getCurrentVideoId,
    getCurrentChannel,
    getChannelVideos,
    getWatchTitle,
    getWatchChannelName,
    getWatchDurationSec,
    getRelatedVideos,
    clickLike,
    clickSubscribe,
    postComment,
    isLoggedIn,
    hasCheckpoint,
  };
})(typeof self !== 'undefined' ? self : this);
