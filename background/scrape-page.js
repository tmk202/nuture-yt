// Self-contained scrape function for executeScript injection.
// Reads ytInitialData and falls back to DOM scrape. All helpers inlined.
// Returns the result via window.__lastScrape; sets window.__lastScrapeErr on error.
(() => {
  const __G = (typeof self !== 'undefined' ? self : globalThis);
  try {
  const extractJsonObject = (text, startIdx) => {
    let depth = 0, inString = false, escape = false;
    for (let i = startIdx; i < text.length; i++) {
      const c = text[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return text.slice(startIdx, i + 1);
      }
    }
    return null;
  };
  const parseYtInitialData = (scriptText) => {
    const idx = scriptText.indexOf('ytInitialData');
    if (idx === -1) return null;
    const eq = scriptText.indexOf('=', idx);
    if (eq === -1) return null;
    let i = eq + 1;
    while (i < scriptText.length && /\s/.test(scriptText[i])) i++;
    if (scriptText[i] !== '{') return null;
    return extractJsonObject(scriptText, i);
  };
  const walkPath = (n, path) => {
    let cur = n;
    for (const p of path) {
      if (cur == null) return null;
      cur = cur[p];
    }
    if (typeof cur === 'string') return cur;
    if (cur?.simpleText) return cur.simpleText;
    if (cur?.runs) return cur.runs.map((r) => r.text).join('');
    return null;
  };
  const extractMicroformat = (data) => {
    const mf = data?.microformat?.playerMicroformatRenderer
      || data?.header?.c4TabbedHeaderRenderer?.microformat?.playerMicroformatRenderer;
    if (!mf) return null;
    return {
      title: walkPath(mf, ['title']),
      description: walkPath(mf, ['description', 'simpleText']) || walkPath(mf, ['description']),
      keywords: (mf.tags || []).slice(0, 20),
      category: walkPath(mf, ['category']),
      externalChannelId: walkPath(mf, ['externalChannelId']),
    };
  };
  // Merge user-defined custom niches (injected via window.__customNiches) into the built-in bank.
  // The SW's executeScript sets window.__customNiches = { id: { label, keywords, searchKeywords } } BEFORE
  // injecting this file. Custom niches override any built-in with the same id (shouldn't happen, since
  // ADD_NICHE refuses to overwrite built-in IDs).
  function buildNicheBank() {
    const builtIn = {
      gaming: { label: 'Gaming', keywords: ['gameplay', 'walkthrough', 'minecraft', 'roblox', 'fortnite', 'gta', 'esports', 'speedrun', 'review game', 'tips game', 'steam', 'ps5', 'xbox'] },
      'tech-review': { label: 'Tech Review', keywords: ['review', 'unbox', 'unboxing', 'hands on', 'first look', 'compared', ' vs ', 'benchmark', 'iphone', 'android', 'macbook', 'laptop', 'phone', 'gpu', 'cpu', 'teardown'] },
      tutorial: { label: 'Tutorial', keywords: ['tutorial', 'how to', 'guide', 'lesson', 'course', 'learn', 'step by step', 'beginner', 'tips for', 'coding', 'programming', 'excel'] },
      fitness: { label: 'Fitness', keywords: ['workout', 'fitness', 'gym', 'training', 'exercise', 'muscle', 'lift', 'cardio', 'bodybuilding', 'crossfit', 'fat loss', 'weight loss', 'home workout'] },
      food: { label: 'Food', keywords: ['recipe', 'cook', 'cooking', 'food', 'meal', 'baking', 'kitchen', 'chef', 'taste test', 'mukbang', 'street food', 'homemade'] },
      beauty: { label: 'Beauty', keywords: ['makeup', 'beauty', 'skincare', 'grwm', 'haul', 'cosmetics', 'foundation', 'lipstick', 'eyeshadow'] },
      finance: { label: 'Finance', keywords: ['stock', 'invest', 'trading', 'crypto', 'bitcoin', 'money', 'finance', 'budget', 'wealth', 'passive income', 'real estate'] },
      education: { label: 'Education', keywords: ['explained', 'science', 'history', 'psychology', 'documentary', 'facts', 'how does', 'why do', 'what is', 'did you know'] },
      lifestyle: { label: 'Lifestyle', keywords: ['vlog', 'day in my life', 'morning routine', 'challenge', 'prank', 'storytime', 'q&a', 'react', 'reaction', 'interview', 'behind the scenes', 'entertainment', 'epic', 'extreme', 'survive', 'survival', 'last to leave', '24 hour'] },
      supplement: { label: 'Supplement', keywords: ['supplement', 'protein', 'creatine', 'pre-workout', 'pre workout', 'whey', 'bcaa', 'fat burner', 'mass gainer', 'gym gear'] },
      'craft-diy': { label: 'Craft & DIY', keywords: ['origami', 'paper craft', 'paper art', 'kirigami', '3d paper', 'handmade', 'diy', 'art tutorial', 'drawing tutorial', 'watercolor', 'acrylic', 'sketch', 'painting'] },
    };
    // Layer in custom niches
    const custom = (typeof self !== 'undefined' && self.__customNiches) || (typeof globalThis !== 'undefined' && globalThis.__customNiches) || {};
    for (const [id, info] of Object.entries(custom)) {
      builtIn[id] = {
        label: info.label || id,
        keywords: info.keywords || [],
      };
    }
    return builtIn;
  }

  const NICHE_BANK = buildNicheBank();

  const scoreNiche = (videos, micro) => {
    const corpus = [];
    if (micro?.title) corpus.push(micro.title);
    if (micro?.description) corpus.push(micro.description);
    if (micro?.keywords?.length) corpus.push(micro.keywords.join(' '));
    for (const v of videos || []) corpus.push(v.title || '');
    const text = corpus.join(' ').toLowerCase();
    const scores = {};
    const matches = {};
    for (const [niche, kws] of Object.entries(NICHE_BANK)) {
      const hits = [];
      for (const kw of kws.keywords) {
        const idx = text.indexOf(kw.toLowerCase());
        if (idx !== -1) hits.push({ kw, idx });
      }
      if (hits.length > 0) {
        scores[niche] = hits.length;
        matches[niche] = hits;
      }
    }
    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const topNiche = sorted[0]?.[0] || 'lifestyle';
    const total = Math.max(videos?.length || 0, 1);
    const confidence = sorted[0] ? Math.min(1, sorted[0][1] / total) : 0;
    return { topNiche, confidence, scores, matches };
  };

  // ---- 1. Try ytInitialData JSON ----
  let jsonVideos = [];
  let jsonDebug = { found: false, scriptLen: 0, videoRenderers: 0, parseError: null };
  let nicheResult = null;
  try {
    const scripts = document.querySelectorAll('script');
    let parsed = null;
    for (const s of scripts) {
      const t = s.textContent || '';
      if (!t.includes('ytInitialData')) continue;
      jsonDebug.scriptLen = t.length;
      const jsonStr = parseYtInitialData(t);
      if (!jsonStr) continue;
      try {
        parsed = JSON.parse(jsonStr);
        jsonDebug.found = true;
        break;
      } catch (e) {
        jsonDebug.parseError = e.message;
      }
    }
    if (parsed) {
      const collected = [];
      const seen = new Set();
      const walk = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach(walk); return; }
        let vid = null;
        if (typeof n.videoId === 'string' && /^[A-Za-z0-9_-]{6,15}$/.test(n.videoId)) vid = n.videoId;
        else if (typeof n.contentId === 'string' && /^[A-Za-z0-9_-]{6,15}$/.test(n.contentId)) vid = n.contentId;
        if (vid) {
          let title = '';
          if (n.title?.runs) title = n.title.runs.map((r) => r.text).join('');
          else if (n.title?.simpleText) title = n.title.simpleText;
          else if (typeof n.title === 'string') title = n.title;
          else if (n.accessibility?.accessibilityData?.label) title = n.accessibility.accessibilityData.label;
          else if (n.metadata?.lockupMetadataViewModel?.title?.content) title = n.metadata.lockupMetadataViewModel.title.content;
          else if (n.metadata?.lockupMetadataViewModel?.title?.text) title = n.metadata.lockupMetadataViewModel.title.text;
          if (title && !seen.has(vid)) {
            seen.add(vid);
            collected.push({ videoId: vid, title: String(title).slice(0, 200) });
          }
        }
        for (const k of Object.keys(n)) walk(n[k]);
      };
      walk(parsed);
      const micro = extractMicroformat(parsed);
      nicheResult = scoreNiche(collected, micro);
      jsonDebug.videoRenderers = collected.length;
      jsonDebug.microformat = micro;
      jsonDebug.nicheScores = nicheResult.scores;
      jsonDebug.nicheMatches = nicheResult.matches;
      jsonVideos = collected.slice(0, 30);
    }
  } catch (e) {
    jsonDebug.parseError = e.message;
  }

  // ---- 2. Fallback: DOM scrape (walk-up) ----
  const seenDom = new Set();
  const domVideos = [];
  document.querySelectorAll('a[href*="/watch?v="]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    const m = href.match(/[?&]v=([\w-]+)/);
    if (!m || seenDom.has(m[1])) return;
    let title = (a.textContent || '').trim();
    if (!title) title = (a.getAttribute('aria-label') || '').trim();
    if (!title) title = (a.getAttribute('title') || '').trim();
    if (!title) {
      let parent = a.parentElement;
      let depth = 0;
      while (parent && depth < 8) {
        const h3 = parent.querySelector('h3');
        if (h3 && h3.textContent.trim().length > 3) { title = h3.textContent.trim(); break; }
        const yt = parent.querySelector('yt-formatted-string#video-title');
        if (yt && yt.textContent.trim().length > 3) { title = yt.textContent.trim(); break; }
        parent = parent.parentElement;
        depth++;
      }
    }
    if (title) {
      seenDom.add(m[1]);
      domVideos.push({ videoId: m[1], title: title.slice(0, 200) });
    }
  });

  const perSelector = {
    'a[href*="/watch?v="]': document.querySelectorAll('a[href*="/watch?v="]').length,
    'h3 inside rich item': document.querySelectorAll('ytd-rich-item-renderer h3').length,
    'yt-formatted-string#video-title': document.querySelectorAll('yt-formatted-string#video-title').length,
  };

  const videos = jsonVideos.length > 0 ? jsonVideos.slice(0, 30) : domVideos.slice(0, 30);
  const source = jsonVideos.length > 0 ? 'ytInitialData' : 'dom';

  const result = {
    url: location.href,
    pageTitle: document.title,
    source,
    jsonDebug,
    perSelector,
    videos,
    _version: 'walkup-v3-file',
    _domCount: domVideos.length,
  };
  if (nicheResult) {
    result.topNiche = nicheResult.topNiche;
    result.confidence = nicheResult.confidence;
  }
  __G.__lastScrape = result;
  return result;
  } catch (e) {
    try { __G.__lastScrapeErr = (e && e.message ? e.message : String(e)) + '\n' + ((e && e.stack) || '').slice(0, 1500); } catch (_) {}
    return null;
  }
})();
