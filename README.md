# YouTube Nurture — Chrome Extension

Automatically warm up a YouTube account: browse + like + comment on niche-relevant content. 1 Chrome profile = 1 account. Six layers of anti-ban protection.

> ⚠️ Use this to warm up real accounts with human-like behavior. Do not use for spam, view farming, or any activity that violates YouTube ToS.

## Installation

### Step 1: Load the extension
1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked** → select the `nuoi-youtube` folder
4. The "YouTube Nurture" icon will appear in the toolbar

### Step 2: Log in to YouTube
1. Open a new tab → go to `youtube.com`
2. Sign in with your Google account as normal
3. For multiple accounts: create a separate Chrome profile for each one
   - `chrome://settings/people` → **Add person** → install extension in each profile
   - **For multi-account automation, use `setup-profiles.sh` + `nurture-all.sh` instead** (see below)

### Step 3: Detect the target channel
1. Visit the channel you want to nurture (e.g. `https://www.youtube.com/@yourchannel`)
2. Click the extension icon → **Add this channel**
3. The extension scans 15–30 videos, identifies the niche (Gaming / Tech Review / Fitness / Food / Beauty / Finance / Education / Lifestyle / Supplement) and refreshes the seed pool

### Step 4: Start nurturing
1. Open the extension popup
2. Click **▶ Start nurturing**
3. The scheduler runs in the background:
   - Checks every 2 minutes whether an action is allowed
   - Refreshes the seed pool every 30 minutes (searches YouTube for niche content)
   - For each action: opens a new tab, watches 30–90% of the video, may like, may comment
4. The tab auto-closes after the watch completes

## Multi-profile orchestrator (multiple YouTube accounts)

To run many accounts in parallel without lifting a finger, use the two bash scripts in this folder:

| Script | What it does |
|---|---|
| `./setup-profiles.sh [N]` | One-time: create N Chrome profile directories, log into YouTube on each, set the profileId in the popup. |
| `./nurture-all.sh`        | Forever-loop: launches Chrome for each profile, waits for the daily-cap marker, switches to the next profile. |

### How it works

```
┌─ profile yt-01 ─────┐
│ Chrome launches     │
│ Extension runs      │  ← picks videos, watches, likes, comments
│ ...                 │
│ Daily cap hit       │  → writes ~/Downloads/nuoi-yt/yt-01-done-2026-06-23.json
└─────────────────────┘
       ↓ orchestrator sees marker
┌─ profile yt-02 ─────┐
│ Chrome launches     │
│ ...                 │
└─────────────────────┘
```

The extension signals "done for today" by writing a marker file via `chrome.downloads`. The orchestrator (`nurture-all.sh`) polls for that file and moves on.

### Setup (one time)

```bash
cd ~/Documents/nnt/CODE/nuoi-youtube
./setup-profiles.sh 5       # create 5 profiles (yt-01 .. yt-05)
# follow the prompts: log into YouTube, set profileId, fully quit Chrome between each
```

### Run

```bash
./nurture-all.sh                                    # cycle forever
./nurture-all.sh --max-cycles 2                     # stop after 2 full cycles
./nurture-all.sh --profile 'yt-0[123]'               # only specific profiles
./nurture-all.sh --marker-timeout 3600              # give up on a profile after 1h
```

### Important

- Each Chrome profile = its own Google login + cookie store. The extension's local storage is also per-profile, so each profile's stats / history / settings are independent.
- The `profileId` field in the popup ties a profile to the orchestrator's marker filename. Set it to match the directory name (e.g., `yt-01` for `profiles/yt-01/`).
- Markers are written into `~/Downloads/nuoi-yt/` (not a hidden `.nuoi-yt/` folder — `chrome.downloads` rejects leading-dot filenames). The orchestrator's `--marker-timeout` defaults to 2 hours; if a profile hasn't hit its cap in that time, the orchestrator kills Chrome and moves on (it'll re-launch that profile at the start of the next day).

## Daily use

Each day:
1. If using multi-profile orchestrator: just let `nurture-all.sh` run. It will switch profiles automatically.
2. If using a single profile: open Chrome (already logged in to YouTube), click the extension icon, click **▶ Start nurturing**.
3. Go about your day — the extension handles the rest

You don't need to keep a YouTube tab open. The extension opens its own tabs when needed.

## Settings (in popup)

| Setting | Default | Meaning |
|---|---|---|
| Active hours | 8:00 – 23:00 | Only run during this window |
| Max actions/day | 20 | Total action cap per day |

## Anti-ban rules

The system is safe by default. Key rules:

1. **Active hours only** (8:00–23:00 local time)
2. **New accounts (< 14 days):** NO comments. Action cap reduced 50% for < 30 days
3. **Max 3 comments/day**, 1 sub/day
4. **Watch time random 30–90%** of duration (max 10 minutes)
5. **Random delay 30s–5 min** between actions
6. **Pause/play 1–2 times** per video (simulates real viewing)
7. **Scroll down to comment area** occasionally
8. **Checkpoint detection:** scheduler auto-pauses for 24h on CAPTCHA / sign-in confirmation
9. **Banned content filter:** no links, no "sub for sub", no "check my channel"...

See `docs/ANTI_BAN.md` for details.

## Scaling

| Stage | Accounts | Actions/account/day | Warm-up period |
|---|---|---|---|
| Test | 1 | 5–10 (watch only) | First 14 days |
| Pilot | 2–3 | 8–15 (1–2 comments) | 30 days |
| SME | 5–10 | 15–20 (2–3 comments) | 60+ days |

For multiple accounts: create one Chrome profile per account and install the extension in each.

## Structure

```
nuoi-youtube/
├── manifest.json              # MV3 config
├── background/service-worker.js   # Scheduler (chrome.alarms)
├── content/
│   ├── helpers.js             # DOM utilities
│   ├── detector.js            # Channel → niche
│   └── executor.js            # Watch / like / comment actions
├── lib/
│   ├── store.js               # chrome.storage wrapper
│   ├── niches.js              # Niche database
│   ├── templates.js           # Comment templates (English)
│   ├── human.js               # Random timing
│   └── antiBan.js             # Banned patterns
├── popup/
│   ├── popup.html             # UI
│   ├── popup.js
│   └── popup.css
├── icons/                     # 16, 48, 128 px
└── docs/
    ├── ARCHITECTURE.md
    └── ANTI_BAN.md
```

## Customization

### Add a new niche
Edit `lib/niches.js` → add an entry to `NICHE_BANK` and `NICHE_KEYWORDS`.

### Edit comment templates
Edit `lib/templates.js` → modify `TEMPLATES` (full) or `SHORT_REACT` (short).

### Adjust schedule
Default values live in `lib/store.js` → `DEFAULT_STATE.settings`, or change via the popup.

## Troubleshooting

**Extension not working?**
- Open `chrome://extensions/` → check the extension is enabled
- Click "Service worker" → check console logs
- Check the popup shows "Outside active hours" (if outside 8:00–23:00, scheduler won't run)

**YouTube keeps asking you to sign in?**
- Your Chrome profile's YouTube cookies may have expired
- Sign in again in a regular YouTube tab
- The extension shares cookies with your Chrome profile

**Hit a CAPTCHA?**
- The extension auto-detects and applies a 24h cooldown
- Solve the CAPTCHA in any tab → extension resumes automatically

**Watch tab not loading?**
- The background creates tabs with `active: false`; videos still play in background
- If Chrome pauses background tabs: set `chrome://flags/#disable-background-timer-throttling` → Disabled
