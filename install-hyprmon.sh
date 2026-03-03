#!/usr/bin/env bash
set -euo pipefail
# hyprmon installer (Cinnamon extension)
# File: install-hyprmon.sh
# Brief: Copies (or symlinks) the current repo folder into Cinnamon's extensions directory.
#
# Usage:
#   ./install-hyprmon.sh              # default: copy via rsync
#   ./install-hyprmon.sh --copy       # same as default
#   ./install-hyprmon.sh --symlink    # dev mode: symlink repo into extensions dir
#   ./install-hyprmon.sh --remove     # remove installed extension folder (does not touch repo)
#
# If needed, give exec permissions to the script (chmod +x ./install-hyprmon.sh)
#
# Notes:
# - After installing, enable/reload in:
#   System Settings -> Extensions -> hyprmon -> Enable
# - Optional Cinnamon restart (X11): `cinnamon --replace`
#   (Alt+F2 -> r is also common, but can't be triggered programmatically.)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

MODE="copy"
REMOVE="0"

for arg in "$@"; do
  case "$arg" in
    --copy) MODE="copy" ;;
    --symlink|--link|--dev) MODE="symlink" ;;
    --remove|--uninstall) REMOVE="1" ;;
    -h|--help)
      sed -n '1,160p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg"
      echo "Run: $0 --help"
      exit 2
      ;;
  esac
done

if [[ ! -f "$SCRIPT_DIR/metadata.json" ]]; then
  echo "ERROR: metadata.json not found in: $SCRIPT_DIR"
  echo "Run this from the hyprmon repo root."
  exit 1
fi

UUID="$(
  python3 - <<'PY' 2>/dev/null || true
import json
with open("metadata.json","r",encoding="utf-8") as f:
    print(json.load(f).get("uuid",""))
PY
)"
if [[ -z "$UUID" ]]; then
  UUID="hyprmon@og-yona"
fi

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
DEST_BASE="$DATA_HOME/cinnamon/extensions"
DEST="$DEST_BASE/$UUID"

if [[ "$REMOVE" == "1" ]]; then
  if [[ -e "$DEST" || -L "$DEST" ]]; then
    echo "Removing: $DEST"
    rm -rf "$DEST"
    echo "Removed."
  else
    echo "Nothing to remove at: $DEST"
  fi
  exit 0
fi

mkdir -p "$DEST_BASE"

echo "Repo:  $SCRIPT_DIR"
echo "UUID:  $UUID"
echo "Dest:  $DEST"
echo "Mode:  $MODE"

if [[ "$MODE" == "symlink" ]]; then
  rm -rf "$DEST"
  ln -s "$SCRIPT_DIR" "$DEST"
  echo "Symlink created."
else
  mkdir -p "$DEST"
  # Copy everything needed for Cinnamon to run the extension, plus docs.
  # Excludes VCS and typical junk.
  rsync -a --delete \
    --exclude '.git/' \
    --exclude '.github/' \
    --exclude '.vscode/' \
    --exclude '*.swp' \
    --exclude '*~' \
    --exclude '__pycache__/' \
    "$SCRIPT_DIR/" "$DEST/"
  echo "Files copied."
fi

cat <<EOF

Next steps:
1) Enable the extension:
   - System Settings -> Extensions -> "hyprmon" -> Enable

2) Configure:
   - System Settings -> Extensions -> "hyprmon" -> Configure

Installed to:
  $DEST

EOF

# ---- Optional Cinnamon restart prompt ----
# We can only do a safe "restart" on X11 via `cinnamon --replace`.
# On Wayland sessions, there is no equivalent; user must log out/in.
SESSION_TYPE="${XDG_SESSION_TYPE:-unknown}"

can_restart="0"
if [[ "$SESSION_TYPE" == "x11" ]] && command -v cinnamon >/dev/null 2>&1; then
  can_restart="1"
fi

# Only prompt if stdin is a TTY (interactive).
if [[ -t 0 ]]; then
  if [[ "$can_restart" == "1" ]]; then
    echo "Cinnamon session type: $SESSION_TYPE"
    echo "Optional: restart Cinnamon now (X11) using: cinnamon --replace"
    read -r -p "Restart Cinnamon now? [y/N] " ans
    ans="${ans:-N}"
    if [[ "$ans" =~ ^[Yy]$ ]]; then
      echo "Restarting Cinnamon (X11) ..."
      # Run detached so the script can exit cleanly even if the terminal is affected.
      nohup cinnamon --replace >/tmp/hyprmon-cinnamon-replace.log 2>&1 &
      disown || true
      echo "Requested Cinnamon restart. Log: /tmp/hyprmon-cinnamon-replace.log"
    else
      echo "Skipped Cinnamon restart."
      echo "If needed: disable+enable the extension, or run: cinnamon --replace"
    fi
  else
    echo "Cinnamon restart not offered (session type: $SESSION_TYPE)."
    echo "If changes don't apply: disable+enable the extension, or log out/in."
  fi
else
  echo "Non-interactive install: skipping Cinnamon restart prompt."
  echo "If changes don't apply: disable+enable the extension, or (X11) run: cinnamon --replace"
fi
