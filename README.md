# hyprmon

<center><img src=icon.png width=200 height=200></center>

**hyprmon** is a Linux Mint **Cinnamon (X11)** extension that adds a **toggleable, per-workspace auto‑tiling mode** inspired by Hyprland—without replacing Muffin or the rest of Cinnamon’s window manager.

The design goal is “Hypr-ish ergonomics” while staying pragmatic and lightweight on Cinnamon.

- UUID: `hyprmon@og-yona`
- Target: Cinnamon **6.2** (Linux Mint 22.3), **X11**

---

## Current state (v0.68)

hyprmon is usable as a daily-driver tiling workflow on Cinnamon.

### Core tiling
- **Per-workspace tiling toggle**
- **Per-monitor tiling** (each monitor tiles its own windows on that workspace)
- **Automatic reflow** on window open/close, workspace moves, monitor changes
- **Work area awareness**
  - respects Cinnamon panels
  - optional **extraTopGap / extraBottomGap**
- **Gaps**
  - `outerGap`, `innerGap`
  - **per-workspace gaps toggle** (hotkey)

### Stateful layout (BSP)
- **Persistent BSP tree** per workspace + monitor
- Stored at:
  - `~/.config/hyprmon@og-yona/tiling-state.json`
- Supports predictable layouts and stable ordering across reflows.

### “Hypr-ish” ergonomics
- **Drag behavior (detach + insert-on-drop)**
  - grab a tiled window → the layout closes the gap immediately
  - drop onto a tile → the target tile is split and the window is inserted
- **Live border resize adjusts neighbors (real-time)**
  - resizing a tiled window updates BSP ratios live
  - neighbors resize during the grab
  - final retile snaps everything cleanly on release
- **Keyboard ergonomics**
  - focus neighbor (←/→/↑/↓)
  - swap with neighbor
  - grow / shrink active tile by moving the split boundary
  - change shape with neighbor (toggle split axis for a symmetric pair)

### Window modes
- **Floating windows** (hyprmon-managed)
  - excluded from tiling everywhere
  - toggle per focused window
  - “de-float all” drops them back into tiling (if enabled)
- **Sticky windows**
  - sticky = appears on all workspaces (MetaWindow.stick)
  - sticky implies floating
  - sticky windows are forced **always-on-top** (best effort)
  - stacking is kept stable:
    - floating windows sit above tiled windows
    - sticky windows sit above floating windows

### Rules / safety clamps (v0.68)
- **Forced floating rules** (`forceFloatingRules`)
  - regex rules that match WM_CLASS or title
  - matching windows are ignored for tiling (remain floating)
  - useful for settings dialogs, special tools, etc.
- **Minimum tile size clamp** (`minTileSizePx`)
  - prevents keyboard resize and live border-resize from pushing any tile below the minimum
  - if the current layout is already below the minimum (too many windows), the clamp relaxes to avoid getting stuck

### Optional visuals
- **Tile border overlays** (active workspace only)
- Optional overlay animation (safe)
- Optional geometry animation (opt-in; may stutter on X11)

---

## Install

Cinnamon loads extensions from:

- `~/.local/share/cinnamon/extensions/<uuid>/`

### Option A: Install script (recommended)

From the repo root:

```bash
chmod +x ./install-hyprmon.sh
./install-hyprmon.sh
```

This copies the current folder into:

- `~/.local/share/cinnamon/extensions/hyprmon@og-yona/`

Dev mode (symlink the repo instead of copying):

```bash
./install-hyprmon.sh --symlink
```

Uninstall/remove:

```bash
./install-hyprmon.sh --remove
```

### Option B: Manual install (copy)

```bash
UUID="hyprmon@og-yona"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/cinnamon/extensions/$UUID"
mkdir -p "$(dirname "$DEST")"
rsync -a --delete ./ "$DEST/" \
  --exclude '.git/' --exclude '.github/' --exclude '.vscode/'
```

### Option C: Manual install (symlink, dev)

```bash
UUID="hyprmon@og-yona"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/cinnamon/extensions/$UUID"
rm -rf "$DEST"
ln -s "$(pwd)" "$DEST"
```

---

## Enable / Reload

1) Enable:
- **System Settings → Extensions → hyprmon → Enable**

2) Configure:
- **System Settings → Extensions → hyprmon → Configure**

If Cinnamon doesn’t pick up changes immediately (most likely needs cinnamon restart):
- Disable+Enable the extension in the Extensions UI, or
- Restart Cinnamon (X11): **Alt+F2 → `r` → Enter** (or `cinnamon --replace`), or
- Log out/in.

---

## Default hotkeys

(Defaults are defined in `settings-schema.json`.)

### Core
- Toggle tiling: **Super + T**
- Tile now (manual reflow): **Super + Shift + T**
- Reset layout: **Super + Shift + R**
- Toggle gaps (per workspace): **Super + G**

### Floating / sticky
- Toggle floating: **Super + V**
- De-float all: **Super + Shift + V**
- Toggle sticky: **Super + S**

### Keyboard navigation / layout editing
- Focus neighbor: **Super + Shift + Arrow**
- Swap with neighbor: **Super + Alt + Arrow**
- Grow active tile: **Super + Ctrl + Arrow**
- Shrink active tile: **Super + Ctrl + Shift + Arrow**
- Change shape with neighbor: **Super + Ctrl + Alt + Arrow**

---

## Forced floating rules

Setting: `forceFloatingRules`

Format:
- comma-separated or newline-separated regex rules
- optional prefixes:
  - `class:<regex>`
  - `title:<regex>`
- without prefix: matches both class and title
- lines starting with `#` are comments

Examples:

```text
# Keep control centers / settings floating
class:^(org\.gnome\.Settings|gnome-control-center)$

# Match common “Preferences” windows by title
title:Preferences
title:Settings
```

---

## Debugging

### Looking Glass logs
- Press **Alt+F2**
- Run: `lg`
- Open the **Logs** tab

### State file
- `~/.config/hyprmon@og-yona/tiling-state.json`

If behavior gets odd:
- Use **Reset layout** hotkey (default `Super+Shift+R`)
- Or delete the state file to reset everything.

---

## Known limitations & Issues/bugs

- X11 + Muffin sometimes ignore the first `move_resize_frame()` right after reload/startup for some apps.
  - hyprmon mitigates this with short “retile bursts” and a startup healing pass.
- No Wayland support (Cinnamon Wayland is experimental and uses different APIs).
- Dialogs/popups are intentionally left floating by heuristic (transient/attached dialog checks).
- Bug: Windows can be resized "too large" causing other windows not to shrink as small as intended, which may break the tiling behaviour on the workspace. 
- Bug: When moving windows from workspace to workspace, occasionally auto-tiling does not correctly resize the window on final target workspace.
- Bug: Overlays/borders are drawn from tiled windows on top of floating/sticky windows (and also over popups/prompts)
- Bug: Floating/sticky windows missing overlays (should draw them, as/if managed by hyprmon tiler)

---

## Credits

hyprmon started from patterns and WM integration ideas inspired by **Fancy Tiles**:
- https://github.com/BasGeertsema/fancytiles

The current codebase is focused on BSP tiling + Hyprland-like ergonomics on Cinnamon X11.

---

## License

GPL-3.0 (following the upstream inspiration’s approach).
