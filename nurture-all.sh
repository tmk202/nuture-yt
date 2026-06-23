#!/usr/bin/env bash
#
# nurture-all.sh
# --------------
# Multi-profile orchestrator. Cycles through Chrome profiles, one YouTube
# account at a time. The extension writes a marker file when a profile
# hits its daily cap; this script sees the marker and moves to the next
# profile.
#
# Flow per profile:
#   1. Launch Chrome with --user-data-dir=PATH --load-extension=...
#   2. Extension runs in the background (auto-warm via alarms)
#   3. When extension hits daily cap, it writes:
#        ~/Downloads/nuoi-yt/<profileId>-done-YYYY-MM-DD.json
#   4. This script polls for that file. When seen, kill Chrome, move on.
#   5. When all profiles are done for today, wait until tomorrow, repeat.
#
# Usage:
#   ./nurture-all.sh                         # cycle all profiles forever
#   ./nurture-all.sh --max-cycles 2          # stop after 2 full cycles
#   ./nurture-all.sh --profile yt-0[12]      # only specific profiles (glob)
#   ./nurture-all.sh --marker-timeout 7200   # give up on a profile after 2h
#   ./nurture-all.sh --help
#
# Requirements: macOS, Google Chrome at /Applications, profiles set up via
# ./setup-profiles.sh.

set -euo pipefail

# --- Paths ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_PATH="$SCRIPT_DIR"
PROFILES_DIR="$EXT_PATH/profiles"
CHROME_APP="/Applications/Google Chrome.app"
MARKER_BASE_DIR="$HOME/Downloads/nuoi-yt"
LOG_FILE="$EXT_PATH/orchestrator.log"

# --- Defaults ---
MAX_CYCLES=0           # 0 = infinite
PROFILE_PATTERN="yt-*" # glob to find profile dirs
MARKER_TIMEOUT=7200    # seconds (2h) to wait for a single profile's marker
POLL_INTERVAL=30       # seconds between marker checks

# --- ANSI ---
B="\033[1m"; G="\033[32m"; Y="\033[33m"; C="\033[36m"; R="\033[31m"; D="\033[2m"; N="\033[0m"
log()  { printf "${C}[orch]${N} %b\n" "$*" | tee -a "$LOG_FILE" >/dev/null; printf "${C}[orch]${N} %b\n" "$*"; }
warn() { printf "${Y}[orch]${N} %b\n" "$*" | tee -a "$LOG_FILE" >/dev/null; printf "${Y}[orch]${N} %b\n" "$*"; }
err()  { printf "${R}[orch]${N} %b\n" "$*" | tee -a "$LOG_FILE" >/dev/null; printf "${R}[orch]${N} %b\n" "$*" >&2; }
ok()   { printf "${G}[orch]${N} %b\n" "$*" | tee -a "$LOG_FILE" >/dev/null; printf "${G}[orch]${N} %b\n" "$*"; }

# --- Parse args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-cycles)      MAX_CYCLES="$2"; shift 2;;
    --profile)         PROFILE_PATTERN="$2"; shift 2;;
    --marker-timeout)  MARKER_TIMEOUT="$2"; shift 2;;
    --poll-interval)   POLL_INTERVAL="$2"; shift 2;;
    --profiles-dir)    PROFILES_DIR="$2"; shift 2;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0;;
    *) err "Unknown arg: $1 (try --help)"; exit 1;;
  esac
done

# --- Pre-flight ---
[[ -d "$CHROME_APP" ]] || { err "Chrome not found at $CHROME_APP"; exit 1; }
[[ -d "$PROFILES_DIR" ]] || { err "Profiles dir not found: $PROFILES_DIR (run ./setup-profiles.sh first)"; exit 1; }
[[ -f "$EXT_PATH/manifest.json" ]] || { err "manifest.json not found in $EXT_PATH"; exit 1; }
mkdir -p "$MARKER_BASE_DIR"

# --- Discover profiles ---
mapfile -t PROFILES < <(find "$PROFILES_DIR" -maxdepth 1 -mindepth 1 -type d -name "$PROFILE_PATTERN" | sort)
if [[ ${#PROFILES[@]} -eq 0 ]]; then
  err "No profiles found in $PROFILES_DIR matching pattern '$PROFILE_PATTERN'"
  err "Run ./setup-profiles.sh first."
  exit 1
fi

# --- Cleanup on exit ---
cleanup() {
  local exit_code=$?
  log "Caught signal, cleaning up Chrome instances…"
  for PROFILE_DIR in "${PROFILES[@]}"; do
    pkill -f "user-data-dir=$PROFILE_DIR" 2>/dev/null || true
  done
  exit "$exit_code"
}
trap cleanup INT TERM

ok "Found ${#PROFILES[@]} profile(s):"
for p in "${PROFILES[@]}"; do printf "    %s\n" "${p##*/}"; done
log "Marker dir: $MARKER_BASE_DIR"
log "Log file: $LOG_FILE"
log "Marker timeout per profile: ${MARKER_TIMEOUT}s"
log "Max cycles: $([[ $MAX_CYCLES -eq 0 ]] && echo "infinite" || echo "$MAX_CYCLES")"
echo

# --- Helpers ---
is_chrome_running_for() {
  pgrep -f "user-data-dir=$1" > /dev/null 2>&1
}

clear_markers_for() {
  find "$MARKER_BASE_DIR" -maxdepth 1 -name "${1}-done-*.json" -type f -delete 2>/dev/null || true
}

wait_for_marker() {
  local profile_id="$1"
  local marker="$2"
  local waited=0
  while [[ ! -f "$marker" ]]; do
    sleep "$POLL_INTERVAL"
    waited=$((waited + POLL_INTERVAL))

    # If Chrome died, abort
    if ! is_chrome_running_for "$3"; then
      warn "[$profile_id] Chrome process is gone (waited ${waited}s). Aborting this profile."
      return 2
    fi

    if [[ $waited -ge $MARKER_TIMEOUT ]]; then
      warn "[$profile_id] Marker timeout after ${waited}s. Will kill Chrome and move on."
      return 1
    fi
  done
  return 0
}

launch_profile() {
  local profile_id="$1"
  local profile_dir="$2"
  log "[$profile_id] Launching Chrome…"
  open -na "$CHROME_APP" --args \
    --user-data-dir="$profile_dir" \
    --load-extension="$EXT_PATH" \
    --no-first-run \
    --no-default-browser-check \
    --disable-background-timer-throttling \
    --disable-features=TranslateUI \
    --noerrdialogs \
    "https://www.youtube.com/" \
    > /dev/null 2>&1
  # Give Chrome a moment to start
  sleep 3
}

kill_profile() {
  local profile_id="$1"
  local profile_dir="$2"
  if is_chrome_running_for "$profile_dir"; then
    log "[$profile_id] Killing Chrome…"
    pkill -f "user-data-dir=$profile_dir" 2>/dev/null || true
    # Give it time to clean up
    for _ in 1 2 3 4 5 6; do
      is_chrome_running_for "$profile_dir" || break
      sleep 1
    done
    if is_chrome_running_for "$profile_dir"; then
      warn "[$profile_id] Chrome still alive, force-killing…"
      pkill -9 -f "user-data-dir=$profile_dir" 2>/dev/null || true
    fi
  fi
}

# --- Main loop ---
cycle=0
while true; do
  cycle=$((cycle + 1))
  if [[ $MAX_CYCLES -gt 0 && $cycle -gt $MAX_CYCLES ]]; then
    ok "Completed $MAX_CYCLES cycle(s). Stopping."
    break
  fi
  echo
  ok "═══════════════════════════════════════════════════════════"
  ok "  Cycle $cycle — $(date '+%Y-%m-%d %H:%M:%S')"
  ok "═══════════════════════════════════════════════════════════"

  for PROFILE_DIR in "${PROFILES[@]}"; do
    PROFILE_ID="${PROFILE_DIR##*/}"
    TODAY=$(date '+%Y-%m-%d')
    MARKER="$MARKER_BASE_DIR/${PROFILE_ID}-done-${TODAY}.json"

    # Skip if marker exists (already done today)
    if [[ -f "$MARKER" ]]; then
      log "[$PROFILE_ID] Marker exists for today ($(basename "$MARKER")) — skipping"
      continue
    fi

    # Clear any stale markers from previous days for this profile
    clear_markers_for "$PROFILE_ID"

    # Launch
    launch_profile "$PROFILE_ID" "$PROFILE_DIR"

    # Wait for marker
    log "[$PROFILE_ID] Watching for marker: $MARKER"
    log "[$PROFILE_ID] (timeout in ${MARKER_TIMEOUT}s, polling every ${POLL_INTERVAL}s)"
    wait_for_marker "$PROFILE_ID" "$MARKER" "$PROFILE_DIR"
    case $? in
      0) ok "[$PROFILE_ID] ✓ Done! Marker written: $MARKER"; cat "$MARKER" 2>/dev/null | head -10;;
      1) warn "[$PROFILE_ID] Timeout — killing Chrome and moving on";;
      2) warn "[$PROFILE_ID] Chrome died — moving on";;
    esac

    # Kill Chrome
    kill_profile "$PROFILE_ID" "$PROFILE_DIR"

    # Brief pause between profiles
    sleep 5
  done

  # All profiles done for today. Wait until tomorrow.
  TODAY=$(date '+%Y-%m-%d')
  log "All profiles done for ${TODAY}. Sleeping until next day (00:05) or Ctrl+C…"
  while true; do
    NOW=$(date '+%Y-%m-%d')
    NOW_HM=$(date '+%H:%M')
    if [[ "$NOW" != "$TODAY" || "$NOW_HM" > "00:05" ]]; then
      ok "It's now $NOW $NOW_HM. Starting next cycle."
      break
    fi
    sleep 300  # check every 5 min
  done
done

ok "Orchestrator stopped."
