/**
 * Channel visitor detector.
 * Runs when the user visits a YouTube channel page.
 * Sends CHANNEL_VISITED message to background with channel info.
 * Background decides whether to add to channels list (user can accept/reject).
 *
 * Does NOT auto-add to channels list — that would be intrusive.
 */
(function (global) {
  'use strict';

  function detect() {
    const channel = YTHelpers.getCurrentChannel();
    if (!channel) return;
    const channelUrl = location.href.split('?')[0];
    // Just notify background — no DOM scraping, no auto-add.
    chrome.runtime.sendMessage({
      type: 'CHANNEL_VISITED',
      channel: {
        handle: channel.value,
        url: channelUrl,
      },
    }).catch(() => {});
    console.log(`[nuoi-yt] detector: visited ${channel.value}`);
  }

  let lastUrl = '';
  function checkAndRun() {
    const url = location.href;
    if (url === lastUrl) return;
    lastUrl = url;
    if (YTHelpers.getCurrentChannel()) {
      // Debounce 1s (no need to scroll/scrape)
      setTimeout(detect, 1000);
    }
  }

  let _interval = setInterval(checkAndRun, 1500);
  window.addEventListener('yt-navigate-finish', checkAndRun);

  global.YTDetector = { detect, checkAndRun };
  console.log('[nuoi-yt] detector loaded');
})(typeof self !== 'undefined' ? self : this);
