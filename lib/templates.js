/**
 * Comment templates (English only).
 * Nuoi kenh ngoai, nhieu variant de trung lap thap.
 * No links, no "sub for sub", no "check my channel".
 */
(function (global) {
  'use strict';

  // Full templates — 7 nhom de tranh lap
  const TEMPLATES = [
    // React / appreciate
    'Great video, thanks for sharing!',
    'This was really helpful, I learned a lot.',
    'Awesome content as always.',
    'Loved this, exactly what I needed today.',
    'This hit different, thank you.',
    'Brilliant breakdown, saved for later.',
    'Such a clear explanation, well done.',
    'I keep coming back to this one, super insightful.',
    'You always deliver, much appreciated.',
    'Quality content, keep it up.',

    // Agree / validate
    'I have been saying this for years, glad someone made a video on it.',
    'Exactly my experience, glad to see it covered here.',
    'The middle part really resonated with me.',
    'Spot on, this is the take I have been looking for.',
    'You nailed the point about consistency.',

    // Question / engage
    'Could you do a follow-up on this?',
    'What would you recommend for someone just starting out?',
    'How long did it take you to see results?',
    'Any chance of a part 2 covering X?',
    'Where do you usually get your data from?',

    // Save / rewatch
    'Saving this to watch again later.',
    'Just shared this with my team, thanks!',
    'Sending this to a friend who needs to hear it.',
    'Bookmarking for the weekend.',

    // New viewer
    'New viewer here, definitely subscribing after this.',
    'Just found your channel, this is gold.',
    'Subscribed after this one, looking forward to more.',

    // Specific praise
    'The editing on this is so clean.',
    'The way you explained the middle section was chef\'s kiss.',
    'The ending hit hard, well said.',
    'Sound quality is great too, nice production.',

    // Personal
    'I have been struggling with this for a while, this cleared it up.',
    'Wish I had seen this 6 months ago.',
    'Made my morning, thanks for posting.',
  ];

  // Short react — ngan, nhu nguoi that gap gi
  const SHORT_REACT = [
    'Awesome!',
    'Thanks!',
    'So good',
    'Loved this',
    'Great content',
    'Insightful',
    'Helpful',
    'Underrated video',
    'Needed this',
    'Pure gold',
    'This!',
    'Same here',
    'Facts',
    'Agreed',
    'Wow',
  ];

  function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  /**
   * Pick 1 template. 30% short react, 70% full.
   * @param {string} [variant]  'short' | 'normal' (default 'normal')
   */
  function pickTemplate(variant = 'normal') {
    if (variant === 'short') return pickRandom(SHORT_REACT);
    let t = pickRandom(TEMPLATES);
    if (!/[.!?]$/.test(t)) t += '.';
    return t;
  }

  global.Templates = { pickTemplate, pickRandom };
})(typeof self !== 'undefined' ? self : this);
