#!/usr/bin/env bash
set -euo pipefail

UUID="${HYPRMON_UUID:-hyprmon@og-yona}"
BASE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/${UUID}/hooks"
STATUS_PATH="${BASE_DIR}/status.json"
COMMAND_PATH="${BASE_DIR}/command.json"

mkdir -p "$BASE_DIR"

usage() {
  cat <<'EOF'
Usage:
  hyprmon-hookctl.sh status-json
  hyprmon-hookctl.sh active-summary
  hyprmon-hookctl.sh tooltip
  hyprmon-hookctl.sh send <action> [workspace]

Examples:
  hyprmon-hookctl.sh send toggle-tiling
  hyprmon-hookctl.sh send toggle-gaps 2
  hyprmon-hookctl.sh send show-status
EOF
}

json_get() {
  local filter="$1"
  if command -v jq >/dev/null 2>&1; then
    jq -r "$filter" "$STATUS_PATH" 2>/dev/null || true
  else
    echo ""
  fi
}

status_json() {
  if [[ -f "$STATUS_PATH" ]]; then
    cat "$STATUS_PATH"
  else
    echo '{}'
  fi
}

active_summary() {
  if [[ ! -f "$STATUS_PATH" ]]; then
    echo "hyprmon?"
    return 0
  fi

  if command -v jq >/dev/null 2>&1; then
    local ws side tiling gaps opacity
    ws="$(json_get '.active.workspace // 1')"
    side="$(json_get '.active.activeSide // 1')"
    tiling="$(json_get 'if .active.tilingEnabled then "ON" else "OFF" end')"
    gaps="$(json_get 'if .active.gapsEnabled then "ON" else "OFF" end')"
    opacity="$(json_get 'if .active.opacityEnabled then "ON" else "OFF" end')"
    echo "WS${ws} S${side} T:${tiling} G:${gaps} O:${opacity}"
  else
    echo "hyprmon"
  fi
}

tooltip() {
  if [[ ! -f "$STATUS_PATH" ]]; then
    echo "Hyprmon status unavailable"
    return 0
  fi

  if command -v jq >/dev/null 2>&1; then
    jq -r '
      .active as $a |
      "Workspace: \($a.workspace)",
      "Side: \($a.activeSide)",
      "Auto-tiling: \(if $a.tilingEnabled then "ON" else "OFF" end)",
      "Gaps: \(if $a.gapsEnabled then "ON" else "OFF" end)",
      "Opacity: \(if $a.opacityEnabled then "ON" else "OFF" end)"
    ' "$STATUS_PATH" 2>/dev/null || echo "Hyprmon status parse error"
  else
    echo "Install jq for rich tooltip output"
  fi
}

send_action() {
  local action="$1"
  local workspace="${2:-}"
  local tmp
  tmp="$(mktemp "${BASE_DIR}/.command.XXXXXX.tmp")"

  if [[ -n "$workspace" ]]; then
    printf '{ "action": "%s", "workspace": %s }\n' "$action" "$workspace" >"$tmp"
  else
    printf '{ "action": "%s" }\n' "$action" >"$tmp"
  fi

  mv "$tmp" "$COMMAND_PATH"
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    status-json)
      status_json
      ;;
    active-summary)
      active_summary
      ;;
    tooltip)
      tooltip
      ;;
    send)
      if [[ $# -lt 2 ]]; then
        usage
        exit 2
      fi
      send_action "$2" "${3:-}"
      ;;
    *)
      usage
      exit 2
      ;;
  esac
}

main "$@"
