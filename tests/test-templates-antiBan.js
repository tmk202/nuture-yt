/**
 * Unit tests for lib/templates.js and lib/antiBan.js
 */
'use strict';
require('./mock-chrome');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const { test, assert, group, run } = require('./framework');

require(path.join(ROOT, 'lib', 'templates.js'));
require(path.join(ROOT, 'lib', 'antiBan.js'));

group('lib/templates', () => {
  test('pickTemplate returns a non-empty string', () => {
    const t = Templates.pickTemplate();
    assert.equal(typeof t, 'string');
    assert.truthy(t.length > 0);
  });

  test('pickTemplate short variant returns a short string', () => {
    for (let i = 0; i < 30; i++) {
      const t = Templates.pickTemplate('short');
      assert.equal(typeof t, 'string');
      // short react templates are 1-3 words typically
      assert.truthy(t.length < 40, `short template too long: "${t}"`);
    }
  });

  test('pickTemplate normal returns a sentence', () => {
    for (let i = 0; i < 30; i++) {
      const t = Templates.pickTemplate('normal');
      assert.truthy(t.length > 5, `template too short: "${t}"`);
      assert.truthy(t.length < 250, `template too long: "${t}"`);
    }
  });

  test('All templates are non-empty strings', () => {
    // Templates are private, but pickTemplate must never throw
    for (let i = 0; i < 100; i++) {
      const t = Templates.pickTemplate();
      assert.truthy(t && t.length > 0);
    }
  });

  test('Templates have variety (no single template > 20% in 100 picks)', () => {
    const counts = {};
    for (let i = 0; i < 100; i++) {
      const t = Templates.pickTemplate();
      counts[t] = (counts[t] || 0) + 1;
    }
    const max = Math.max(...Object.values(counts));
    assert.truthy(max <= 20, `one template appeared ${max}/100 times — too repetitive`);
  });
});

group('lib/antiBan', () => {
  test('BANNED_PATTERNS catches "https://" URLs', () => {
    const txt = 'Check this out https://example.com cool right?';
    const matched = AntiBan.BANNED_PATTERNS.some((p) => p.test(txt));
    assert.truthy(matched);
  });

  test('BANNED_PATTERNS catches "sub for sub"', () => {
    const matched = AntiBan.BANNED_PATTERNS.some((p) => p.test('sub for sub please'));
    assert.truthy(matched);
  });

  test('BANNED_PATTERNS catches "sub4sub"', () => {
    const matched = AntiBan.BANNED_PATTERNS.some((p) => p.test('sub4sub anyone?'));
    assert.truthy(matched);
  });

  test('BANNED_PATTERNS catches "check my channel"', () => {
    const matched = AntiBan.BANNED_PATTERNS.some((p) => p.test('check my channel out'));
    assert.truthy(matched);
  });

  test('BANNED_PATTERNS catches "check out my video"', () => {
    const matched = AntiBan.BANNED_PATTERNS.some((p) => p.test('check out my video'));
    assert.truthy(matched);
  });

  test('BANNED_PATTERNS catches "follow me"', () => {
    const matched = AntiBan.BANNED_PATTERNS.some((p) => p.test('please follow me'));
    assert.truthy(matched);
  });

  test('BANNED_PATTERNS catches "click here"', () => {
    const matched = AntiBan.BANNED_PATTERNS.some((p) => p.test('click here for more'));
    assert.truthy(matched);
  });

  test('BANNED_PATTERNS catches crypto spam', () => {
    const matched = AntiBan.BANNED_PATTERNS.some((p) => p.test('make $1000 with crypto'));
    assert.truthy(matched);
  });

  test('BANNED_PATTERNS catches 👉 emoji', () => {
    const matched = AntiBan.BANNED_PATTERNS.some((p) => p.test('cool video 👉 check it'));
    assert.truthy(matched);
  });

  test('BANNED_PATTERNS does NOT flag normal comments', () => {
    const normal = [
      'Great video, thanks for sharing!',
      'This was really helpful, I learned a lot.',
      'Loved this, exactly what I needed today.',
      'New viewer here, definitely subscribing after this.',
      'The editing on this is so clean.',
    ];
    for (const c of normal) {
      const matched = AntiBan.BANNED_PATTERNS.some((p) => p.test(c));
      assert.falsy(matched, `false positive on: "${c}"`);
    }
  });

  test('shouldDo respects ratio', () => {
    const settings = { ratios: { comment: 0.5, like: 0.5, subscribe: 0.5, watch: 1.0 } };
    let trueCount = 0;
    for (let i = 0; i < 1000; i++) if (AntiBan.shouldDo('comment', settings)) trueCount++;
    // Should be ~50% (with 0.5 ratio)
    assert.inRange(trueCount, 400, 600);
  });

  test('shouldDo returns false for missing kind', () => {
    const settings = { ratios: {} };
    assert.equal(AntiBan.shouldDo('nonexistent', settings), false);
  });
});

if (require.main === module) run();
