#!/usr/bin/env bash
#
# setup-profiles.sh
# -----------------
# One-time setup: create N Chrome profile directories and help you log into
# the corresponding YouTube account on each one. After setup, the orchestrator
# (nurture-all.sh) cycles through them.
#
# Usage:
#   ./setup-profiles.sh [COUNT]        # e.g. ./setup-profiles.sh 5
#   ./setup-profiles.sh                # interactive: asks for count
#
# What it does per profile:
#   1. Creates ~/Documents/nnt/CODE/nuoi-youtube/profiles/<id>/
#   2. Launches Chrome with --user-data-dir=PATH --load-extension=...
#   3. Waits for you to log into YouTube and set the profileId in the popup
#   4. You close Chrome when done
#
# Requirements: macOS, Google Chrome installed at /Applications.

set -euo pipefail

# --- Paths (relative to this script) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_PATH="$SCRIPT_DIR"
PROFILES_DIR="$EXT_PATH/profiles"
CHROME_APP="/Applications/Google Chrome.app"
EXT_ID="nokophffldhfbllbnojaghchilbnhijb"

# --- ANSI ---
B="\033[1m"  # bold
G="\033[32m" # green
Y="\033[33m" # yellow
C="\033[36m" # cyan
R="\033[31m" # red
D="\033[2m"  # dim
N="\033[0m"  # reset

log()  { printf "${C}[setup]${N} %b\n" "$*"; }
warn() { printf "${Y}[setup]${N} %b\n" "$*"; }
err()  { printf "${R}[setup]${N} %b\n" "$*" >&2; }
ok()   { printf "${G}[setup]${N} %b\n" "$*"; }

# --- Pre-flight ---
[[ -d "$CHROME_APP" ]] || { err "Chrome not found at $CHROME_APP"; exit 1; }
[[ -f "$EXT_PATH/manifest.json" ]] || { err "manifest.json not found in $EXT_PATH"; exit 1; }

# --- Get count ---
COUNT="${1:-}"
if [[ -z "$COUNT" ]]; then
  read -rp "$(printf "${B}How many YouTube profiles to set up? ${N}")" COUNT
fi
if ! [[ "$COUNT" =~ ^[0-9]+$ ]] || [[ "$COUNT" -lt 1 ]] || [[ "$COUNT" -gt 50 ]]; then
  err "Invalid count: $COUNT (must be 1–50)"
  exit 1
fi

# --- Prep profiles dir ---
mkdir -p "$PROFILES_DIR"
ok "Profiles dir: $PROFILES_DIR"
echo

# --- Make sure no other Chrome instance is running with the extension paths ---
# (We use --user-data-dir per profile, so this is safe to run even with personal Chrome open.)

for i in $(seq 1 "$COUNT"); do
  PROFILE_ID="yt-$(printf '%02d' "$i")"
  PROFILE_DIR="$PROFILES_DIR/$PROFILE_ID"

  echo "═════════════════════════════════════════════════════════════════"
  log "Profile ${B}$i${N} of $COUNT: ${B}$PROFILE_ID${N}"
  echo "═════════════════════════════════════════════════════════════════"
  echo

  if [[ -d "$PROFILE_DIR" && -f "$PROFILE_DIR/Default/Preferences" ]]; then
    warn "Profile dir already exists and looks initialized:"
    echo "    $PROFILE_DIR"
    read -rp "$(printf "    ${Y}Reuse it? [y/N]:${N} ")" REUSE
    case "$REUSE" in
      y|Y) log "Reusing existing profile dir";;
      *)
        read -rp "$(printf "    ${Y}Delete and recreate? [y/N]:${N} ")" RECREATE
        case "$RECREATE" in
          y|Y) rm -rf "$PROFILE_DIR"; mkdir -p "$PROFILE_DIR"; ok "Recreated";;
          *)   err "Skipped (and not reused — manual fix needed)"; continue;;
        esac
        ;;
    esac
  else
    mkdir -p "$PROFILE_DIR"
  fi
  echo

  echo "  ${B}Do this in the Chrome window that opens:${N}"
  echo "    1. Log into the YouTube account you want this profile to nurture"
  echo "    2. Click the ${B}YouTube Nurture${N} extension icon (puzzle piece → YT Nurture)"
  echo "    3. In the ${B}Chrome profile${N} section of the popup, type: ${B}$PROFILE_ID${N}"
  echo "    4. Click ${B}Save${N} — the status badge should turn green with ✓"
  echo "    5. (Optional) Add 5–10 competitor channels in the popup"
  echo "    6. When done, ${B}fully quit Chrome${N} (Cmd+Q) — close button is not enough"
  echo
  echo "  ${D}Tip: the extension will auto-warm this account. You can let it run"
  echo "       in the background or quit after saving the profileId.${N}"
  echo

  read -rp "  Press Enter to launch Chrome for $PROFILE_ID... " _
  echo

  # Launch Chrome with this profile + extension loaded
  open -na "$CHROME_APP" --args \
    --user-data-dir="$PROFILE_DIR" \
    --load-extension="$EXT_PATH" \
    --no-first-run \
    --no-default-browser-check \
    --disable-background-timer-throttling \
    --disable-features=TranslateUI \
    --noerrdialogs \
    "https://www.youtube.com/"

  log "Chrome launched. Open the extension popup to set the profileId."
  echo

  read -rp "  Press Enter after Chrome is fully quit to continue... " _
  echo

  # Make sure Chrome is really gone for this profile before moving on
  if pgrep -f "user-data-dir=$PROFILE_DIR" > /dev/null 2>&1; then
    warn "Chrome still running for $PROFILE_ID. Killing it…"
    pkill -f "user-data-dir=$PROFILE_DIR" || true
    sleep 2
  fi
  ok "Profile $PROFILE_ID done."
  echo
done

# --- Summary ---
echo "═════════════════════════════════════════════════════════════════"
ok "Setup complete! $COUNT profile(s) created:"
ls -1 "$PROFILES_DIR" 2>/dev/null | sed 's/^/    /'
echo
log "Next: run ${B}./nurture-all.sh${N} to start the orchestrator."
echo "═════════════════════════════════════════════════════════════════"
