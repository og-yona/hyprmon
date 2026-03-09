# hyprmon

<center><img src=icon.png width=200 height=200></center>

**hyprmon** is a Linux Mint **Cinnamon (X11)** extension that adds a **toggleable, per-workspace auto-tiling workflow** with Hyprland-like ergonomics, while staying inside Cinnamon/Muffin.

- UUID: `hyprmon@og-yona`
- Target: Cinnamon `6.2` (Linux Mint 22.3), X11
- Current version: **v0.6862**

---

## Feature Overview

### 1. Core Tiling
- Per-workspace tiling enable/disable
- Per-monitor tiling (each monitor tiles its own windows)
- Automatic reflow on open/close/move/monitor/workspace events
- Work-area aware tiling (panel-aware)
- Extra reserved space controls: `extraTopGap`, `extraBottomGap`

### 2. BSP Layout Model
- Persistent BSP trees in `~/.config/hyprmon@og-yona/tiling-state.json`
- Stable window ordering and deterministic reconcile
- Recovery actions:
  - Manual retile/rebuild
  - Per-workspace layout reset

### 3. Sideviews (v0.684+)
Each real workspace can contain multiple virtual horizontal sideviews:
- One active sideview
- Any number of inactive sideviews
- Per-window side assignment
- Separate BSP trees per sideview

Behavior:
- Switching sideview re-tiles active side only
- Inactive side windows are parked/hidden (Muffin-safe fallback)
- Focusing a window from another side redirects to that side
- Side switch now focuses a window from the target side

### 4. Window Modes
- Floating mode per window (not auto-tiled, stays on top of auto-tiled windows)
- Sticky mode per window (sticky implies floating - also follows when changing workspace, always on top)
- Defloat-all helper
- Best-effort keep-above ordering for floating/sticky sets

### 5. Forced Floating Rules (v0.68)
Regex-based rules by class/title (`forceFloatingRules`) to keep selected apps out of tiling.

### 6. Keyboard Ergonomics (v0.67 / v0.671)
- Focus neighbor
- Swap neighbor
- Grow/Shrink active tile by split movement
- Change shape with symmetric neighbor (axis toggle)

### 7. Borders, Visuals, HUD
- Tile border overlays (active workspace only)
- Optional overlay animation / geometry animation
- Custom Hyprmon HUD notifications (non-queued, overwrite behavior)
  - configurable timeout
  - configurable position (`top-center`, `bottom-center`, `active-monitor`)

### 8. Auto Window Opacity (v0.686)
Integrated from `auto-window-opacity` and adapted to hyprmon:
- Focused/unfocused/fullscreen-maximized opacity levels
- Optional dialog/utility participation
- Refresh interval control
- Global enable switch
- **Per-workspace opacity toggle** (persisted)

---

## Install

Cinnamon extension path:
- `~/.local/share/cinnamon/extensions/<uuid>/`

### Option A (recommended)
```bash
chmod +x ./install-hyprmon.sh
./install-hyprmon.sh
```

Dev mode symlink:
```bash
./install-hyprmon.sh --symlink
```

Remove:
```bash
./install-hyprmon.sh --remove
```

### Option B (manual copy)
```bash
UUID="hyprmon@og-yona"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/cinnamon/extensions/$UUID"
mkdir -p "$(dirname "$DEST")"
rsync -a --delete ./ "$DEST/" \
  --exclude '.git/' --exclude '.github/' --exclude '.vscode/' --exclude 'auto-window-opacity/'
```

---

## Enable / Reload

1. Enable: **System Settings -> Extensions -> hyprmon -> Enable**
2. Configure: **System Settings -> Extensions -> hyprmon -> Configure**

If changes do not apply:
- Disable + Enable extension, or
- Restart Cinnamon on X11 (`Alt+F2`, then `r`), or
- Log out/in.

---

## Default Hotkeys

### Workspace / Layout
- Toggle tiling: `Super+T`
- Manual retile: `Super+Shift+T`
- Reset layout: `Super+Shift+R`
- Toggle gaps (workspace): `Super+G`

### Sideviews
- Previous side: `Super+Page_Up`
- Next side: `Super+Page_Down`
- Move focused window to previous side: `Super+Shift+Page_Up`
- Move focused window to next side: `Super+Shift+Page_Down`

### Floating / Sticky
- Toggle floating: `Super+V`
- Defloat all: `Super+Shift+V`
- Toggle sticky: `Super+S`

### Auto Opacity
- Toggle opacity on current workspace: `Super+O`

### Keyboard Tiling Ops
- Focus neighbor: `Super+Shift+Arrow`
- Swap neighbor: `Super+Alt+Arrow`
- Grow tile: `Super+Ctrl+Arrow`
- Shrink tile: `Super+Ctrl+Shift+Arrow`
- Change shape: `Super+Ctrl+Alt+Arrow`

(All defaults are configurable in `settings-schema.json`.)

---

## Forced Floating Rules

Setting: `forceFloatingRules`

Format:
- comma/newline separated regex lines
- optional prefixes:
  - `class:<regex>`
  - `title:<regex>`
- no prefix: matches both class and title
- `#` line prefix = comment

Example:
```text
# Keep settings apps floating
class:^(org\.gnome\.Settings|gnome-control-center)$

# Generic title-based rule
title:Preferences
```

---

## State File

Persistent state:
- `~/.config/hyprmon@og-yona/tiling-state.json`

Includes:
- Workspace tiling trees
- Sideview active side / per-window side mapping
- Workspace flags (`gapsDisabled`, `opacityDisabled`)
- Window flags (`floating`, `sticky`)

---

## Debugging

### Looking Glass
- `Alt+F2`, run `lg`, check **Logs** tab.

### Quick recovery
- Use layout reset hotkey (`Super+Shift+R`) on affected workspace
- Or delete state file and re-enable extension

---

## Limitations

- X11/Muffin behavior can vary by app/toolkit; hyprmon includes fallback passes for reliability.
- Wayland is not supported.
- Some transient/pop-up window types are intentionally excluded from tiling/opacity logic.

---

## Architecture (Current)

Main runtime is orchestrated by `application.js`, with extracted modules:
- `side-state.js`
- `sideviews.js`
- `window-grabs.js`
- `window-opacity.js`
- `hotkeys.js`
- `hud-notifier.js`
- `forced-float-rules.js`

---

## Credits

hyprmon was originally inspired by Fancy Tiles integration patterns:
- https://github.com/BasGeertsema/fancytiles

---

## License

GPL-3.0
