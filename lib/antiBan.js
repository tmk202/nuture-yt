/**
 * Anti-ban: helpers, chi nen doc state qua Store, khong tu sua.
 */
(function (global) {
  'use strict';

  function shouldDo(kind, settings) {
    return Math.random() < (settings.ratios[kind] || 0);
  }

  /**
   * Banned patterns cho comment (filter them trong executor).
   * Neu match, skip comment.
   */
  const BANNED_PATTERNS = [
    /https?:\/\//i,
    /sub\s+for\s+sub/i,
    /sub4sub/i,
    /check\s+(my|out)\s+(my\s+|out\s+)?(channel|video)/i,
    /\b(viagra|cialis|crypto|pump|forex)\b/i,
    /\b(earn|make)\s+\$\d+/i,
    /follow\s+me/i,
    /click\s+(my|here)/i,
    /👉/,
  ];

  global.AntiBan = { shouldDo, BANNED_PATTERNS };
})(typeof self !== 'undefined' ? self : this);
