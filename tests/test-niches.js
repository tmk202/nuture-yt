/**
 * Unit tests for lib/niches.js
 */
'use strict';
require('./mock-chrome');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const { test, assert, group, run } = require('./framework');

require(path.join(ROOT, 'lib', 'niches.js'));

group('lib/niches', () => {
  test('NICHE_BANK has 11 niches', () => {
    const keys = Object.keys(Niches.NICHE_BANK);
    assert.equal(keys.length, 11, `expected 11 niches, got ${keys.length}: ${keys.join(',')}`);
  });

  test('Expected niches all present', () => {
    const expected = ['gaming', 'tech-review', 'tutorial', 'fitness', 'food', 'beauty', 'finance', 'education', 'lifestyle', 'supplement', 'craft-diy'];
    for (const n of expected) {
      assert.truthy(Niches.NICHE_BANK[n], `missing niche: ${n}`);
    }
  });

  test('Every niche has keywords array', () => {
    for (const [n, info] of Object.entries(Niches.NICHE_BANK)) {
      assert.truthy(Array.isArray(info.keywords), `${n} keywords not array`);
      assert.truthy(info.keywords.length > 0, `${n} has no keywords`);
    }
  });

  test('Every niche label is a non-empty string', () => {
    for (const [n, info] of Object.entries(Niches.NICHE_BANK)) {
      assert.equal(typeof info.label, 'string', `${n} label not string`);
      assert.truthy(info.label.length > 0, `${n} label empty`);
    }
  });

  test('NICHE_KEYWORDS has matching keys for every niche', () => {
    for (const n of Object.keys(Niches.NICHE_BANK)) {
      assert.truthy(Niches.NICHE_KEYWORDS[n], `NICHE_KEYWORDS missing for ${n}`);
      assert.truthy(Array.isArray(Niches.NICHE_KEYWORDS[n]), `${n} keywords not array`);
      assert.truthy(Niches.NICHE_KEYWORDS[n].length > 0, `${n} has no search keywords`);
    }
  });

  test('NICHE_KEYWORDS has fallback for unknown', () => {
    assert.truthy(Niches.NICHE_KEYWORDS.unknown);
    assert.truthy(Niches.NICHE_KEYWORDS.unknown.length > 0);
  });

  test('No Vietnamese characters in any niche (English-only)', () => {
    const hasVietnamese = (s) => /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i.test(s);
    for (const [n, info] of Object.entries(Niches.NICHE_BANK)) {
      for (const kw of info.keywords) {
        assert.falsy(hasVietnamese(kw), `VI keyword in ${n}: ${kw}`);
      }
      assert.falsy(hasVietnamese(info.label), `VI label in ${n}: ${info.label}`);
    }
    for (const [n, kws] of Object.entries(Niches.NICHE_KEYWORDS)) {
      for (const kw of kws) {
        assert.falsy(hasVietnamese(kw), `VI search keyword in ${n}: ${kw}`);
      }
    }
  });

  test('craft-diy niche includes relevant paper/origami keywords', () => {
    const kws = Niches.NICHE_BANK['craft-diy'].keywords;
    assert.truthy(kws.includes('paper art') || kws.includes('origami') || kws.includes('diy'));
  });

  test('gaming niche includes common gaming terms', () => {
    const kws = Niches.NICHE_BANK.gaming.keywords;
    assert.truthy(kws.includes('gameplay') || kws.includes('minecraft'));
  });
});

if (require.main === module) run();
