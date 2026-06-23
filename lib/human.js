/**
 * Human-like timing + DOM interactions.
 * Trong extension content script: khong the di chuyen chuot that (security),
 * nhung co the scroll, click DOM, focus, type qua DOM event.
 */
(function (global) {
  'use strict';

  function rand(min, max) {
    return Math.random() * (max - min) + min;
  }
  function randInt(min, max) {
    return Math.floor(rand(min, max + 1));
  }
  function pick(arr) {
    if (!arr || arr.length === 0) return undefined;
    return arr[Math.floor(Math.random() * arr.length)];
  }
  function weightedPick(items) {
    const total = items.reduce((s, i) => s + i.weight, 0);
    let r = Math.random() * total;
    for (const it of items) {
      r -= it.weight;
      if (r <= 0) return it.value;
    }
    return items[items.length - 1].value;
  }
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, Math.max(50, ms)));
  }
  function humanDelay(min = 800, max = 2500) {
    return Math.floor(rand(min, max));
  }
  function bigDelay() {
    return randInt(30_000, 300_000);
  }

  /**
   * Watch time curve: 30-90% duration, max 600s, min 20s.
   */
  function watchTimeCurve(durationSec) {
    const cap = Math.min(durationSec, 600);
    const pct = rand(0.3, 0.9);
    let watch = Math.floor(cap * pct);
    if (watch < 20) watch = Math.min(20, durationSec);
    return watch;
  }

  /**
   * Scroll page theo doan nho, co do tre.
   */
  async function humanScroll(direction = 'down', amount = 400) {
    const sign = direction === 'down' ? 1 : -1;
    const steps = randInt(4, 8);
    for (let i = 0; i < steps; i++) {
      window.scrollBy({ top: (amount / steps) * sign, behavior: 'smooth' });
      await sleep(rand(150, 500));
    }
  }

  /**
   * Click element voi delay nhu nguoi that.
   * Su dung DOM click() de tranh Playwright dispatch events khong can thiet.
   */
  async function humanClick(selector, root = document) {
    const el = root.querySelector(selector);
    if (!el) return false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(humanDelay(300, 800));
    el.click();
    await sleep(humanDelay(200, 500));
    return true;
  }

  /**
   * Type text vao input/textarea voi delay tung ky tu.
   */
  async function humanType(el, text) {
    el.focus();
    await sleep(humanDelay(200, 500));
    for (const ch of text) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keypress', { key: ch, bubbles: true }));
      // Insert ky tu
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        const start = el.selectionStart || 0;
        const end = el.selectionEnd || 0;
        el.value = el.value.slice(0, start) + ch + el.value.slice(end);
        el.setSelectionRange(start + 1, start + 1);
      } else {
        // contenteditable
        el.textContent = (el.textContent || '') + ch;
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
      await sleep(rand(40, 160));
      if (Math.random() < 0.06) await sleep(rand(300, 900));
    }
  }

  /**
   * Pause/Play video bang phim 'k'.
   */
  async function simulateKey(key) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    await sleep(50);
    document.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
  }

  global.Human = { rand, randInt, pick, weightedPick, sleep, humanDelay, bigDelay, watchTimeCurve, humanScroll, humanClick, humanType, simulateKey };
})(typeof self !== 'undefined' ? self : this);
