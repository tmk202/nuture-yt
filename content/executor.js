/**
 * Watch / like / comment executor.
 * Nhan message tu background service worker:
 *  - { type: 'WATCH', videoId, options }
 *  - { type: 'STOP' }
 *
 * Thuc thi:
 *  1. Navigate den video (background da mo tab)
 *  2. Watch (play, scroll, like, comment)
 *  3. Gui message WATCH_DONE
 */
(function (global) {
  'use strict';

  let _abort = false;
  let _busy = false;

  /**
   * Detect and skip YouTube video ads (pre-roll / mid-roll).
   * YouTube's player marks ads via:
   *  - `.ytp-ad-player-overlay` (overlay shown during ad)
   *  - `.ytp-ad-text` ("Ad · X seconds" text)
   *  - `.video-ads` (the ad container)
   *  - `#movie_player` having class `ad-showing` or `ad-interrupting`
   * Skip button selectors:
   *  - `.ytp-ad-skip-button` (legacy)
   *  - `.ytp-ad-skip-button-modern` (newer redesign)
   *  - any `button[aria-label*="Skip" i]` inside `.ytp-ad-player-overlay`
   * If no skippable button appears (unskippable ad), fast-forward by jumping
   * `video.currentTime` close to the end of the ad — YouTube will skip to the
   * actual video content. This is the same trick used by most ad-skipper
   * extensions.
   *
   * Returns true if an ad was detected (and either skipped or fast-forwarded).
   */
  let _lastAdHandledAt = 0;
  function handleYouTubeAd() {
    try {
      // Throttle: don't re-handle the same ad more than once per 500ms
      if (Date.now() - _lastAdHandledAt < 500) return false;
      const player = document.querySelector('#movie_player');
      if (!player) return false;
      const playerClass = player.className || '';
      const isAd =
        playerClass.includes('ad-showing') ||
        playerClass.includes('ad-interrupting') ||
        !!document.querySelector('.ytp-ad-player-overlay') ||
        !!document.querySelector('.ytp-ad-text') ||
        !!document.querySelector('.video-ads');
      if (!isAd) return false;

      _lastAdHandledAt = Date.now();

      // 1. Try clicking a visible Skip Ad button
      const skipSelectors = [
        '.ytp-ad-skip-button',
        '.ytp-ad-skip-button-modern',
        '.ytp-skip-ad-button',
      ];
      for (const sel of skipSelectors) {
        const btn = document.querySelector(sel);
        if (btn && btn.offsetParent !== null) {
          try {
            btn.click();
            console.log(`[nuoi-yt] ad-skip: clicked ${sel}`);
            return true;
          } catch (e) { /* try next */ }
        }
      }
      // Also try generic skip button by aria-label inside the ad overlay
      const ariaSkip = document.querySelector('.ytp-ad-player-overlay button[aria-label*="Skip" i]');
      if (ariaSkip && ariaSkip.offsetParent !== null) {
        try {
          ariaSkip.click();
          console.log(`[nuoi-yt] ad-skip: clicked aria-skip button`);
          return true;
        } catch (e) { /* fall through */ }
      }

      // 2. No skippable button — fast-forward the ad by jumping to end of video.
      // YouTube's ad video element is separate; setting <video>.currentTime to a
      // large value causes YouTube to abort the ad and resume real content.
      //
      // Safety guard: only fast-forward when the video's duration looks like an
      // ad (< 90s). Real videos are usually 1–60+ minutes. This prevents the
      // case where `ad-showing` is briefly still set while YouTube has already
      // switched to the real video — without this guard, we'd jump the real
      // video to near its end and the watch would end after ~1 second.
      const v = document.querySelector('video');
      if (v && Number.isFinite(v.duration) && v.duration > 0 && v.duration < 90) {
        try {
          v.currentTime = Math.max(v.duration - 1, v.currentTime + 1);
          console.log(`[nuoi-yt] ad-skip: fast-forwarded unskippable ad to ${v.currentTime.toFixed(1)}s`);
          return true;
        } catch (e) { /* no-op */ }
      }
      if (v && v.duration >= 90) {
        // Looks like the real video, not an ad — don't fast-forward.
        console.log(`[nuoi-yt] ad-skip: skipping fast-forward (duration ${v.duration.toFixed(0)}s is too long for an ad)`);
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  async function executeWatch(opts) {
    if (_busy) return { ok: false, reason: 'already-busy' };
    _busy = true;
    _abort = false;

    const videoId = opts.videoId;
    // tabId is included by the SW so the executor can echo it back in the result.
    // Without it, the SW's onWatchDone can't tell which tab finished.
    const tabId = opts.tabId;
    const doLike = !!opts.like;
    const doComment = !!opts.comment;
    const commentText = opts.commentText || '';
    const doSubscribe = !!opts.subscribe;
    const subscribeChannel = opts.subscribeChannel || '';

    try {
      console.log(`[nuoi-yt] executor: start watch ${videoId}`);
      try { chrome.storage.local.set({ lastExecLog: { step: 'exec_start', videoId, ts: Date.now(), url: location.href } }); } catch (_) {}

      // 1. Wait for page ready
      await waitForVideo(videoId, 30000);
      try { chrome.storage.local.set({ lastExecLog: { step: 'video_ready', videoId, ts: Date.now() } }); } catch (_) {}
      if (_abort) return { ok: false, reason: 'aborted' };

      // 2. Check checkpoint
      if (YTHelpers.hasCheckpoint()) {
        console.warn('[nuoi-yt] executor: CHECKPOINT detected');
        await Store.recordCheckpoint();
        return { ok: false, reason: 'checkpoint' };
      }

      // 3. Check login
      if (!YTHelpers.isLoggedIn()) {
        console.warn('[nuoi-yt] executor: not logged in');
        return { ok: false, reason: 'not-logged-in' };
      }

      // 4. Get video info. Important: we must wait for any pre-roll ad to clear
      // before reading the duration — otherwise `.ytp-time-duration` shows the
      // ad's length (e.g. "0:30") instead of the real video length, and our
      // watch budget becomes absurdly short.
      const title = YTHelpers.getWatchTitle() || `video ${videoId}`;
      const channelName = YTHelpers.getWatchChannelName() || '';
      let duration = 0;
      // Step 1: Try to skip a pre-roll ad exactly ONCE. After this, we just
      // wait for the page to settle and read duration — we don't call the
      // skipper again here, because if YouTube is still transitioning from
      // the ad to the real video, `ad-showing` class might still be on the
      // player while the <video> element already has the real video loaded.
      // handleYouTubeAd has a safety guard to not fast-forward when duration
      // is too long for an ad, so re-calling is safe, but we still prefer
      // to keep this loop simple and only skip once.
      handleYouTubeAd();
      // Step 2: Poll for the real duration. We give the page up to 12 * 1.5s
      // = 18s to settle. If a pre-roll ad is unskippable, this is the time
      // budget for the user to be able to manually skip it.
      for (let i = 0; i < 12; i++) {
        await Human.sleep(1500);
        const candidate = YTHelpers.getWatchDurationSec() || 0;
        // Real videos are usually >= 30s. We accept the first value that
        // looks like a real video.
        if (candidate >= 30) {
          duration = candidate;
          break;
        }
      }
      if (duration < 30) {
        // Still suspicious. Wait longer and try once more.
        await Human.sleep(3000);
        duration = YTHelpers.getWatchDurationSec() || 0;
      }
      if (duration < 30) {
        // Last resort: use a safe default. This avoids calculating a tiny
        // watch budget when an ad was still active at read time.
        console.warn(`[nuoi-yt] executor: could not read real duration (got ${duration}s) — using fallback 300s`);
        duration = 300;
      }

      console.log(`[nuoi-yt] executor: "${title.slice(0, 60)}" by ${channelName}, ${duration}s`);

      // 5. Ensure video is playing. YouTube's autoplay policy blocks video.play() without a user gesture,
      // so we click the visible play button(s) instead. Order: large center overlay → control-bar play → fallback video.play().
      const player = document.querySelector('#movie_player, video');
      if (player) {
        try {
          // Tat autoplay next neu co
          const autoBtn = document.querySelector('button[aria-label*="Autoplay" i]');
          if (autoBtn && autoBtn.getAttribute('aria-pressed') === 'true') {
            autoBtn.click();
            await Human.sleep(Human.humanDelay(500, 1000));
          }
          const video = document.querySelector('video');
          if (video && video.paused) {
            // 1. Try the big center overlay play button (most reliable for fresh page loads)
            const bigPlay = document.querySelector('.ytp-large-play-button, button.ytp-large-play-button');
            if (bigPlay) {
              bigPlay.click();
              await Human.sleep(500);
            }
            // 2. Try the small control-bar play button if still paused
            if (video.paused) {
              const smallPlay = document.querySelector('.ytp-play-button, button.ytp-play-button');
              if (smallPlay) {
                smallPlay.click();
                await Human.sleep(500);
              }
            }
            // 3. Final fallback: programmatic play() (often blocked by autoplay policy but try)
            if (video.paused) {
              try { await video.play(); } catch (e) { /* autoplay blocked */ }
            }
            // 4. Wait briefly + verify it actually started
            await Human.sleep(800);
            if (video.paused) {
              console.warn('[nuoi-yt] executor: video still paused after play attempts — check console');
              // Try one more aggressive click on the play overlay
              try {
                document.querySelector('.ytp-large-play-button')?.click();
                await Human.sleep(500);
              } catch (_) {}
            } else {
              console.log(`[nuoi-yt] executor: video playing (${video.currentTime.toFixed(1)}s)`);
            }
          }
        } catch (e) {
          console.warn('[nuoi-yt] executor: play error', e.message);
        }
      }

      // 6. Watch loop
      let watchSec = Human.watchTimeCurve(duration);
      if (opts.quick) {
        watchSec = 8; // testing: 8s watch
        console.log(`[nuoi-yt] executor: QUICK MODE, watching only ${watchSec}s`);
      } else {
        console.log(`[nuoi-yt] executor: watching ${watchSec}s`);
      }
      const start = Date.now();
      let lastInteraction = Date.now();
      let adsHandled = 0;
      while ((Date.now() - start) / 1000 < watchSec) {
        if (_abort) return { ok: false, reason: 'aborted' };

        const elapsed = (Date.now() - start) / 1000;

        // Ad skipper: handle YouTube pre-roll / mid-roll video ads
        if (handleYouTubeAd()) {
          adsHandled++;
          // When we skip, don't count skipped time against watch budget —
          // we still need to spend real watch time on the actual video.
        }

        // Simulate pause 1-2 times
        if (Math.random() < 0.005) {
          try {
            const v = document.querySelector('video');
            if (v) {
              v.pause();
              await Human.sleep(Human.humanDelay(2000, 6000));
              await v.play().catch(() => {});
            }
          } catch (e) {}
        }

        // Scroll down to description/comments occasionally
        if (Math.random() < 0.008) {
          await Human.humanScroll('down', 300);
          await Human.sleep(Human.humanDelay(1500, 3000));
          await Human.humanScroll('up', 300);
        }

        // Dispatch mousemove events (extension can't move real mouse, but creates activity)
        if (Date.now() - lastInteraction > 30000) {
          try {
            const x = Math.random() * window.innerWidth;
            const y = Math.random() * window.innerHeight;
            document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
            lastInteraction = Date.now();
          } catch (e) {}
        }

        await Human.sleep(2000);
      }

      // 7. Record watched
      if (adsHandled > 0) {
        console.log(`[nuoi-yt] executor: handled ${adsHandled} ad(s) during watch`);
      }
      const state = await Store.getState();
      if (!state.history.watched.find((x) => x.videoId === videoId)) {
        state.history.watched.push({
          videoId,
          title,
          channel: channelName,
          watchedAt: new Date().toISOString(),
          duration,
        });
        // Trim history to last 200
        if (state.history.watched.length > 200) {
          state.history.watched = state.history.watched.slice(-200);
        }
        await Store.setState({ history: state.history });
      }
      await Store.recordAction('watch');
      try { chrome.storage.local.set({ lastExecLog: { step: 'after_watch_recorded', ts: Date.now() } }); } catch (_) {}

      // 8. Like (optional)
      if (doLike) {
        await Human.sleep(Human.humanDelay(1000, 3000));
        const r = await YTHelpers.clickLike();
        console.log(`[nuoi-yt] executor: like result=${r}`);
        if (r === 'liked') {
          const s = await Store.getState();
          if (!s.history.liked.find((x) => x.videoId === videoId)) {
            s.history.liked.push({ videoId, likedAt: new Date().toISOString() });
            await Store.setState({ history: s.history });
          }
          await Store.recordAction('like');
        }
      }

      // 9. Comment (optional)
      if (doComment && commentText) {
        try { chrome.storage.local.set({ lastExecLog: { step: 'comment_start', videoId, ts: Date.now() } }); } catch (_) {}
        await Human.sleep(Human.humanDelay(2000, 5000));

        // Force the comments section to render: scroll down in chunks until ytd-comments or simplebox is in DOM.
        // YouTube lazy-loads comments via IntersectionObserver — a single scrollIntoView call is unreliable.
        const scrollResult = await scrollUntilCommentsRender();
        try { chrome.storage.local.set({ lastExecLog: { step: 'scroll_done', scrollResult, ts: Date.now() } }); } catch (_) {}

        // Banned check
        for (const pat of AntiBan.BANNED_PATTERNS) {
          if (pat.test(commentText)) {
            console.warn('[nuoi-yt] comment hit banned pattern, skip');
            break;
          }
        }
        const r = await YTHelpers.postComment(commentText);
        try { chrome.storage.local.set({ lastExecLog: { step: 'post_comment_result', result: r, ts: Date.now() } }); } catch (_) {}
        console.log(`[nuoi-yt] executor: comment result=${r}`);
        if (r === 'posted') {
          const s = await Store.getState();
          const today = Store.todayKey();
          s.history.commented.push({ videoId, comment: commentText, date: today, ts: new Date().toISOString() });
          await Store.setState({ history: s.history });
          await Store.recordAction('comment');
        } else if (r === 'submit_failed' || r === 'no_box') {
          // Account may be restricted
          if (r === 'no_box' && !YTHelpers.isLoggedIn()) {
            await Store.recordCheckpoint();
          }
        }
      }

      // 10. Subscribe (optional — 5% ratio + 1/day cap)
      if (doSubscribe && subscribeChannel) {
        await Human.sleep(Human.humanDelay(3000, 6000));
        // Scroll back to top so the channel info bar is visible
        window.scrollTo({ top: 0, behavior: 'smooth' });
        await Human.sleep(Human.humanDelay(2000, 4000));

        // Safety: re-check not already subbed
        const stateNow = await Store.getState();
        const subToday = (stateNow.history.subscribed || []).filter((s) =>
          Date.now() - new Date(s.subscribedAt).getTime() < 86400000
        );
        const already = (stateNow.history.subscribed || []).some(
          (s) => s.channel && s.channel.toLowerCase() === subscribeChannel.toLowerCase()
        );
        if (subToday.length === 0 && !already) {
          const r = await YTHelpers.clickSubscribe();
          console.log(`[nuoi-yt] executor: subscribe result=${r}`);
          if (r === 'subscribed') {
            const s2 = await Store.getState();
            s2.history.subscribed.push({
              channel: subscribeChannel,
              videoId,
              subscribedAt: new Date().toISOString(),
            });
            await Store.setState({ history: s2.history });
            await Store.recordAction('subscribe');
          }
        }
      }

      console.log(`[nuoi-yt] executor: done ${videoId}`);
      return { ok: true, videoId, tabId, title };
    } catch (e) {
      console.error('[nuoi-yt] executor err', e);
      return { ok: false, videoId, tabId, reason: e.message };
    } finally {
      _busy = false;
    }
  }

  function waitForVideo(videoId, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (_abort) return reject(new Error('aborted'));
        const cur = YTHelpers.getCurrentVideoId();
        if (cur === videoId) return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for video'));
        setTimeout(check, 500);
      };
      check();
    });
  }

  /**
   * Force YouTube's lazy-loaded comments section to render.
   * YouTube's simplebox (comment input) is rendered only when ytd-comments' IntersectionObserver fires
   * after the section enters the viewport. This is finicky in headless / content-script environments.
   * Strategy:
   *  1. Wait for the page to be fully loaded (ytInitialData populated, video ready)
   *  2. Hard-scroll to bottom (window.scrollTo) — this is the most reliable trigger
   *  3. Keep polling for simplebox up to 20s
   * Returns: { ok, simplebox, editable, reason? }
   */
  async function scrollUntilCommentsRender() {
    const startedAt = Date.now();
    const totalDeadline = startedAt + 20000;
    const log = (data) => {
      try { chrome.storage.local.set({ scrollLog: { ...data, ts: Date.now() } }); } catch (_) {}
    };
    log({ step: 'start', scrollY: window.scrollY, scrollHeight: document.body.scrollHeight, clientHeight: document.documentElement.clientHeight });
    try {
      // Phase 1: aggressive scroll to bottom in 3 jumps
      // window.scrollTo is more reliable than scrollTop on YouTube's complex layout
      const sh = document.documentElement.scrollHeight;
      for (let i = 0; i < 3; i++) {
        try { window.scrollTo(0, sh); } catch (_) {}
        await Human.sleep(500);
        // Try documentElement too as fallback
        try { document.documentElement.scrollTop = sh; } catch (_) {}
        await Human.sleep(300);
      }
      log({ step: 'after_scroll', scrollY: window.scrollY, scrollHeight: document.body.scrollHeight, simpleboxNow: !!document.querySelector('ytd-comment-simplebox-renderer') });

      // Phase 2: poll for simplebox. If not found, try scroll-to-bottom again to retrigger IO.
      let lastScrollTrigger = Date.now();
      while (Date.now() < totalDeadline) {
        const simplebox = document.querySelector('ytd-comment-simplebox-renderer');
        if (simplebox) {
          log({ step: 'simplebox_found', waitedMs: Date.now() - startedAt });
          try { simplebox.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch (_) {}
          const editDeadline = Date.now() + 8000;
          while (Date.now() < editDeadline) {
            if (document.querySelector('#contenteditable-root, #content-text')) {
              log({ step: 'editable_found', waitedMs: Date.now() - startedAt });
              return { ok: true, simplebox: true, editable: true, waitedMs: Date.now() - startedAt };
            }
            await Human.sleep(300);
          }
          log({ step: 'editable_timeout', waitedMs: Date.now() - startedAt });
          return { ok: true, simplebox: true, editable: false, waitedMs: Date.now() - startedAt };
        }
        // Every 3s, re-trigger the IntersectionObserver by scrolling AND try clicking the empty #simple-box placeholder
        if (Date.now() - lastScrollTrigger > 3000) {
          try { window.scrollTo(0, document.documentElement.scrollHeight); } catch (_) {}
          try { document.querySelector('ytd-comments')?.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch (_) {}
          // Try to force the simplebox by clicking on the empty simple-box container
          const sbContainer = document.querySelector('#simple-box');
          if (sbContainer) {
            try { sbContainer.click(); } catch (_) {}
            try { sbContainer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); } catch (_) {}
          }
          lastScrollTrigger = Date.now();
        }
        await Human.sleep(400);
      }
      const commentsEl = document.querySelector('ytd-comments');
      log({ step: 'gave_up', hasComments: !!commentsEl, simpleBoxHTML: document.querySelector('#simple-box')?.innerHTML?.slice(0, 200) });
      return { ok: false, simplebox: false, editable: false, reason: 'simplebox_not_found', waitedMs: Date.now() - startedAt };
    } catch (e) {
      log({ step: 'error', error: e.message });
      return { ok: false, error: e.message, waitedMs: Date.now() - startedAt };
    }
  }

  // Listen messages tu background
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'WATCH') {
      // Run the watch in the background. We send the final result BOTH ways:
      //   1. sendResponse() — original mechanism (gets the result to the SW faster)
      //   2. chrome.runtime.sendMessage(WATCH_DONE) — backup so the SW always
      //      gets notified even if the tab is closed before sendResponse can be
      //      delivered (the error "channel closed before a response was
      //      received" happens otherwise).
      executeWatch(msg)
        .then((result) => {
          try { chrome.runtime.sendMessage({ type: 'WATCH_DONE', ...result }).catch(() => {}); } catch (_) {}
          try { sendResponse(result); } catch (_) {}
        })
        .catch((e) => {
          try { chrome.runtime.sendMessage({ type: 'WATCH_DONE', ok: false, reason: e.message }).catch(() => {}); } catch (_) {}
          try { sendResponse({ ok: false, reason: e.message }); } catch (_) {}
        });
      return true; // async response (channel stays open until sendResponse)
    }
    if (msg.type === 'STOP') {
      _abort = true;
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'PING') {
      sendResponse({ ok: true, busy: _busy });
      return false;
    }
  });

  global.YTExecutor = { executeWatch };
  console.log('[nuoi-yt] executor loaded');
})(typeof self !== 'undefined' ? self : this);
