/**
 * Niches + keywords.
 * Detector: scan channel video titles + microformat description, score against NICHE_BANK.
 * SeedFinder: use NICHE_KEYWORDS to search YouTube for related videos.
 */
(function (global) {
  'use strict';

  const NICHE_BANK = {
    gaming: { label: 'Gaming', keywords: ['gameplay', 'walkthrough', 'minecraft', 'roblox', 'esports', 'review game', 'tips game', 'steam', 'ps5', 'xbox'] },
    'tech-review': { label: 'Tech Review', keywords: ['unboxing', 'review', 'iphone', 'samsung', 'laptop', 'flagship', 'comparison', 'benchmark', 'gpu', 'cpu'] },
    tutorial: { label: 'Tutorial', keywords: ['how to', 'guide', 'tutorial', 'step by step', 'beginner', 'learn', 'basics', 'diy', 'craft', 'paper', 'origami'] },
    fitness: { label: 'Fitness', keywords: ['gym', 'workout', 'protein', 'whey', 'bodybuilding', 'cutting', 'bulking', 'deadlift', 'squat', 'training'] },
    food: { label: 'Food', keywords: ['recipe', 'cooking', 'street food', 'food review', 'tasty', 'meal prep', 'kitchen'] },
    beauty: { label: 'Beauty', keywords: ['skincare', 'makeup', 'cosmetics review', 'sunscreen', 'serum', 'toner', 'routine'] },
    finance: { label: 'Finance', keywords: ['investing', 'stock market', 'crypto', 'savings', 'personal finance', 'fire', 'bitcoin', 'budget'] },
    education: { label: 'Education', keywords: ['lecture', 'learning', 'knowledge', 'science', 'explained', 'history', 'physics'] },
    lifestyle: { label: 'Lifestyle', keywords: ['vlog', 'daily life', 'routine', 'morning routine', 'a day in my life', 'minimalism'] },
    supplement: { label: 'Supplement', keywords: ['supplement', 'vitamin', 'omega', 'collagen', 'multivitamin', 'nootropics', 'pre-workout'] },
    'craft-diy': { label: 'Craft & DIY', keywords: ['paper art', 'origami', 'craft', 'diy', 'handmade', 'paper craft', '3d paper', 'kirigami', 'papercraft', 'quilling', 'scrapbook', 'paper', 'ninja', 'shorts'] },
  };

  const NICHE_KEYWORDS = {
    gaming: ['gameplay walkthrough', 'best games 2026', 'mobile game review', 'steam game review'],
    'tech-review': ['phone review 2026', 'laptop review', 'best budget phone', 'tech comparison'],
    tutorial: ['how to for beginners', 'tutorial basics', 'easy guide'],
    fitness: ['beginner gym workout', 'effective workout routine', 'protein whey review', 'training tips'],
    food: ['easy recipe', 'street food', 'food review', 'meal prep ideas'],
    beauty: ['skincare routine', 'best sunscreen 2026', 'serum review', 'makeup tutorial'],
    finance: ['investing for beginners', 'stock market basics', 'crypto for beginners', 'how to save money'],
    education: ['interesting facts', 'science explained', 'history you didn\'t know'],
    lifestyle: ['daily vlog', 'morning routine', 'minimalist living'],
    supplement: ['best supplement 2026', 'multivitamin review', 'omega 3 benefits', 'collagen for skin'],
    'craft-diy': ['paper art tutorial', 'origami for beginners', 'diy paper craft', '3d paper art', 'handmade craft ideas', 'paper shorts'],
    unknown: ['trending this week', 'popular videos'],
  };

  global.Niches = { NICHE_BANK, NICHE_KEYWORDS };
})(typeof self !== 'undefined' ? self : this);
