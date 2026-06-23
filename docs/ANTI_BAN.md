# Anti-ban Rules

## Golden principle

> **YouTube flags a pattern that doesn't look human — not any single action.**

## Six layers of anti-ban

### Layer 1: Schedule
- Active only during `activeHours` (default 8:00–23:00)
- After a checkpoint (CAPTCHA) → automatic 24h cooldown
- Configurable in the popup

### Layer 2: Action ratio (weighted random)
- watch: 100%
- like: 45%
- comment: 15%
- subscribe: 5%

Each action is chosen via weighted random → not every session likes / comments; the behavior is varied.

### Layer 3: Human-like timing
- Random delay between actions: 30s – 5 min
- Watch time: 30–90% of duration, max 10 min
- Pause / play 1–2 times during a video
- Scroll down to the description occasionally
- Dispatch mousemove events (YouTube doesn't track these, but it generates activity)

### Layer 4: Account age gate
- < 14 days: NO comments
- < 30 days: action cap × 0.5
- After 30 days, full capacity

### Layer 5: Banned content filter
Comments are skipped if they match:
- URLs (`https?://`)
- "sub for sub", "sub4sub"
- "check my channel", "check out my video"
- "follow me", "click here"
- Spam keywords (viagra, crypto, earn $X)
- 👉 emoji (common in spam)

### Layer 6: Fingerprint per Chrome profile
- Each Chrome profile has its own UA, fonts, hardware
- 1 profile = 1 account
- 5 accounts = 5 profiles

## Red flags to avoid

| Behavior | Risk | How we avoid it |
|---|---|---|
| Comment with link | Very high | Regex filter |
| Comment over 200 chars | Medium | Template length cap |
| Subscribe immediately on visit | High | 5% ratio, 1 sub / 24h guard |
| Watch < 20s then skip | Medium | `watchTimeCurve` min 20s |
| Repeated identical comments | High | 35 templates + 15 short react, random pick |
| Sign in to 5 accounts on 1 IP | High | Each account = 1 Chrome profile |

## When you get flagged

### 1. CAPTCHA / "Sign in to confirm"
- Solve it manually in any YouTube tab
- The service worker auto-records `recordCheckpoint()` → pauses the scheduler for 24h
- Resumes automatically after 24h

### 2. "This account has been flagged"
- Pause the scheduler in the popup (click Stop)
- Wait 48–72h
- Reduce `max actions/day` by 50% via the popup

### 3. Channel restricted (can't comment)
- The extension automatically skips failed comment attempts
- Switches to watch + like only
- No retries

### 4. Account suspended
- Create a new Chrome profile + new email
- Learn from the previous account: which action triggered the flag? Adjust ratios / caps accordingly

## Tuning over time

After 1 week of stable operation, gradually increase:

```js
actionsPerDay: { min: 12, max: 25 }
ratios: { comment: 0.20, like: 0.55, subscribe: 0.08 }
```

After 30 days of survival:

```js
actionsPerDay: { min: 15, max: 35 }
ratios: { comment: 0.25, like: 0.60, subscribe: 0.10 }
```

**Never:**
- Set comment ratio > 30%
- Exceed 50 actions/day
- Watch < 20s
- Include a link in any comment

## Magic numbers

| Param | Value | Reason |
|---|---|---|
| Watch min | 20s | YouTube counts views from ~30s, but lower still works |
| Watch max | 600s (10 min) | Avoid watching a single video too long (unnatural) |
| Comment min length | 1 char | Allows short reacts like "Awesome!" |
| Comment max length | 200 chars | Longer = suspicious |
| Daily comment cap | 3 | Safe limit for new accounts |
| Daily sub cap | 1 | YouTube flags subs quickly |
| Active hours | 8:00–23:00 | Simulates normal user hours |
| Checkpoint cooldown | 24h | Let YouTube "forget" |

## Watch time curve

```js
function watchTimeCurve(durationSec) {
  const cap = Math.min(durationSec, 600);
  const pct = rand(0.3, 0.9);  // 30% – 90%
  let watch = Math.floor(cap * pct);
  if (watch < 20) watch = Math.min(20, durationSec);
  return watch;
}
```

Why the 30–90% range:
- < 30%: YouTube marks as "skipped" → low quality signal
- > 90%: Too perfect, doesn't look human
- Random in between: introduces variance, no detectable pattern
