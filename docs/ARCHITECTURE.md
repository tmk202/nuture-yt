# Architecture

## Pipeline

```
+--------------------------------------------------------------+
|                  Chrome profile (1 account)                  |
+--------------------------------------------------------------+
         |                                  |
         |                                  |
         v                                  v
+------------------+              +------------------------+
|  Popup UI        |              |  Background            |
|  (popup.html)    |  sendMessage |  Service Worker        |
|  - start/stop    | <----------> |  (service-worker.js)   |
|  - settings      |              |  - chrome.alarms (2m)  |
|  - stats         |              |  - scheduler logic     |
+------------------+              |  - tab management      |
                                  +------------------------+
                                           |
                                           | chrome.tabs.create
                                           v
                                  +------------------------+
                                  |  Watch Tab (auto)      |
                                  |  (created by SW)       |
                                  |  - /watch?v=xxxxx      |
                                  |  - active: false       |
                                  +------------------------+
                                           |
                                           | content script runs
                                           v
                                  +------------------------+
                                  |  Content Scripts       |
                                  |  - helpers.js          |
                                  |  - detector.js         |
                                  |  - executor.js         |
                                  |                        |
                                  |  Watch → Like → Comment|
                                  |  (random delays)       |
                                  +------------------------+
                                           |
                                           | sendMessage WATCH_DONE
                                           v
                                  (back to service worker)
                                           |
                                           v
                                  Tab auto-closes after 3s
```

## State

All state lives in `chrome.storage.local`:

| Key | Description |
|---|---|
| `settings` | Active hours, ratios, etc. |
| `account` | `{ createdAt }` for age calculation |
| `niche` | `{ niche, confidence, videos, detectedAt }` |
| `seeds` | `[{ videoId, title, channelName, source }]` |
| `history` | `{ watched, liked, commented, subscribed }` |
| `stats` | `{ 'YYYY-MM-DD': { watch, like, comment, subscribe, total } }` |
| `lastCheckpointAt` | ISO timestamp |
| `running` | boolean |

## Lifecycle

1. **Install:** `chrome.runtime.onInstalled` → create default state, set alarms
2. **Tick every 2 minutes:** `chrome.alarms[nuoi-yt-tick]` → check `canAct`, pick a seed, open a tab
3. **Tab load complete:** `chrome.tabs.onUpdated` → inject `WATCH` message
4. **Executor receives WATCH:** play video, watch 30–90% of duration, optional like / comment
5. **WATCH_DONE:** service worker closes the tab, schedules next tick

## Multi-account

Each account = 1 Chrome profile. Chrome profiles are isolated:
- Cookies
- LocalStorage
- Fingerprint (UA, fonts, hardware)
- chrome.storage

→ 1 Chrome profile = 1 account, natural anti-ban separation.
→ 5 accounts = 5 Chrome profiles (`chrome://settings/people` → Add person).

## Module breakdown

- **lib/store.js** — wraps `chrome.storage.local`. Provides `getState`, `setState`, `canAct`, `recordAction`, `recordCheckpoint`
- **lib/niches.js** — `NICHE_BANK` (niches + keywords) and `NICHE_KEYWORDS` (search queries)
- **lib/templates.js** — English comment templates, random pick
- **lib/human.js** — `rand`, `sleep`, `humanDelay`, `watchTimeCurve`, `humanScroll`, `humanType`
- **lib/antiBan.js** — `shouldDo(ratio)`, banned regex patterns
- **content/helpers.js** — `getCurrentVideoId`, `getCurrentChannel`, `clickLike`, `postComment`, ...
- **content/detector.js** — scans channel page, computes niche, saves
- **content/executor.js** — receives WATCH message, runs watch / like / comment loop
- **background/service-worker.js** — scheduler, tab management, message routing
- **popup/popup.html+js+css** — UI

## Extension points

- **Add a niche:** edit `lib/niches.js`
- **Add a comment template:** edit `lib/templates.js`
- **Custom ratios:** edit `lib/store.js` DEFAULT_STATE or change via the popup
- **Add a new action (e.g. share, save to playlist):** add a function in `content/helpers.js`, call it from `content/executor.js`, register a ratio in the store
- **Auto-detect when the user opens a channel page:** already wired in `content/detector.js` (auto-runs when URL matches a channel pattern)
