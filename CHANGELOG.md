# CHANGELOG
Changelog for hyprmon -project.

## v0.686 Add per workspace toggleable auto-window-opacity

### Added/Updated
  - New module: window-opacity.js
      - Auto-opacity engine (focused/unfocused/fullscreen-maximized)
      - Dialog/utility inclusion flags
      - Signal-driven + interval refresh
      - Restores all window opacity on destroy
  - Extended side/workspace state: side-state.js
      - Added opacityDisabled per workspace
      - Added APIs:
          - isOpacityDisabled(wsIndex)
          - setOpacityDisabled(wsIndex, disabled)
  - Persisted migration/defaults: tiling-state-io.js
      - Workspace defaults now include opacityDisabled: false
      - Migrates older state by defaulting missing opacityDisabled to false
  - Settings added: settings-schema.json
      - autoOpacityEnabled
      - opacityFullscreenMaximized
      - opacityFocused
      - opacityUnfocused
      - opacityRefreshIntervalMs
      - opacityAffectDialogs
      - opacityAffectUtilityWindows
      - opacityToggleHotkey (default <Super>o)
  - Hotkey integration: hotkeys.js
      - Added hyprmon-toggle-opacity -> toggleOpacityOnActiveWorkspace
  - Application wiring: application.js
      - Instantiates WindowOpacity module
      - Binds opacity settings changes to module refresh/restart
      - Added per-workspace toggle method:
          - #toggleOpacityOnActiveWorkspace()
      - Added side-state wrappers for opacity enable/disable checks

### Behavior now

  - Global auto-opacity is controlled by settings (autoOpacityEnabled).
  - Per-workspace override works via hotkey:
      - Workspace N: auto-opacity DISABLED/ENABLED
  - Per-workspace toggle is persisted in tiling state.

## v0.6853 Refactor Step 4 - window-grabs.js & fix side-switch focus

### 1. Extracted window-grabs.js

  - New file: window-grabs.js
  - Provides:
      - connectWindowGrabs(signalManager, handlers)
      - isResizeGrabOp(op)
      - isMoveGrabOp(op)
  - application.js now delegates grab-op event wiring to this module via callback handlers.
  - Old in-class #isResizeGrabOp, #isMoveGrabOp, and large #connectWindowGrabs signal body
    were replaced by a thin orchestration wrapper.

###  2. Fixed side-switch focus behavior

  - sideviews.js switchActiveWorkspaceSide(...) now requests focus on the target side after
    switching.
  - Added app callback:
      - focusWindowOnSide(wsIndex, sideIndex) in application.js
      - Selects a window from target side and activates it (random pick from eligible
        windows).
  - This addresses the bug where focus stayed on the old side after side change.

## v0.6852 Refactor Step 3 - extract side-state.js
### Added side-state.js
      - class SideState
      - Owns:
          - workspace/side normalization and migration-safe shape handling
          - active side getters/setters
          - per-window side mapping
          - side/monitor tree access
          - BSP tree get/set
          - workspace/side tree clearing
          - per-workspace gapsDisabled state

### Updated application.js
      - Added #sideState delegate initialization.
      - Replaced large internal state methods with thin wrappers:
          - #getWorkspaceState, #getActiveSideIndex, #setActiveSideIndex
          - #getWindowSide, #setWindowSide, #deleteWindowSide
          - #ensureSideState, #getSideMonState, #getWsMonState
          - #isGapsDisabled, #setGapsDisabled
          - #getBspTree, #setBspTree
          - #clearSideTrees, #clearWorkspaceTrees
      - Keeps existing call sites unchanged, so behavior remains stable.
      - destroy() now nulls #sideState.

## v0.6851 Refactor Step 2 - extract sideviews.js
  - Added new module: sideviews.js
      - Owns sideview state/behavior:
          - parking + restore geometry
          - hidden-window fallback (actor.hide / minimize)
          - side switch
          - move focused window to side
          - focus redirect to correct side
          - side-hidden tracking + cleanup
      - Public API used by Application:
          - destroy()
          - isWindowSideHiddenByKey(winKey)
          - forgetWindow(winKey)
          - restoreActiveSideWindows(wsIndex)
          - parkInactiveSideWindows(wsIndex)
          - switchActiveWorkspaceSide(delta)
          - moveFocusedWindowToSideDelta(delta)
          - redirectFocusToWindowSideIfNeeded(metaWindow)
  - Updated application.js
      - Imports and instantiates Sideviews with explicit callbacks.
      - Replaced large in-class sideview method block with thin delegating wrappers.
      - Replaced direct side-hidden state checks with delegate calls:
          - #onWindowNeedsRetile(...) uses isWindowSideHiddenByKey(...)
          - unmanaged cleanup uses forgetWindow(...)
      - destroy() now calls this.#sideviews.destroy() and no longer manages side-hidden
        internals directly.
      - Removed now-unused in-class sideview state fields and helper implementations.

## v0.6850a Refactor application.js monolith into modules step1

### Step 1 refactor is done: 
Application now delegates HUD notifications, hotkey registration, and forced-float rule parsing to separate modules.

#### New modules

  - hud-notifier.js
      - class HudNotifier
      - API: constructor(getSettingsData, getActiveMonitorIndex), notify(message), destroy()
      - Contains former HUD logic (#ensureHud/#positionHud/#getHudConfig/#notify behavior).
  - hotkeys.js
      - class Hotkeys
      - API: constructor(getSettingsData, handlers), enable(), disable()
      - Owns full hotkey map + (re)registration/removal.
  - forced-float-rules.js
      - compileForcedFloatRules(raw)
      - Owns parsing/compilation of regex rules.

#### Application orchestration changes

  - Updated imports and added delegates in application.js.
  - Application now instantiates:
      - this.#hudNotifier
      - this.#hotkeys
  - Kept internal call sites stable via delegating wrappers:
      - #disableTilingHotkeys() -> this.#hotkeys.disable()
      - #enableTilingHotkeys() -> this.#hotkeys.enable()
      - #notify() -> this.#hudNotifier.notify(...)
      - #compileForcedFloatRules() -> compileForcedFloatRules(...)
  - Added proper cleanup in destroy() for HUD delegate.

## v0.6845 Hyprmon now uses its own in-extension notification HUD instead of Cinnamon
  queued notifications.

  What changed in application.js:

  - Replaced Main.notify(...) path in #notify(...) with a custom St overlay banner.
  - Added overwrite behavior:
      - new message updates same HUD
      - prior timer is canceled
      - display duration resets (currently 900ms)
  - Added cleanup in destroy() so HUD/timer are always removed.
  - Kept Main.notify only as a fallback if HUD creation fails.

  Result:

  - No Cinnamon notification queue spam.
  - Fast actions now show only the latest message, immediately.
add two settings for this HUD:

 Two settings for HUD:
  1. timeout (ms)
  2. position (top-center, bottom-center, active-monitor).

## v0.6844 Avoid minimize animation when parking off-screen
  - Primary fallback for “can’t park off-screen” is now compositor actor hide/show:
      - hide inactive-side window with actor.hide()
      - restore with actor.show()
  - Minimize/unminimize is kept only as last resort if actor hide/show isn’t available.
  - Tracks per-window hidden mode (actor vs minimize) to restore correctly.
  - Cleanup on extension disable restores any side-hidden windows so none remain hidden.

## v0.6843 Fix sideview focus when alt-tab/click
Now when a focused window belongs to a different side on the active workspace:

  1. Hyprmon detects it in notify::focus-window.
  2. It switches activeSide to that window’s side.
  3. Restores that side’s windows and parks/hides inactive sides.
  4. Retiles/border-refreshes the workspace.

## v0.6842 Fixes
Muffin can clamp “off-screen” moves back on-screen, which is why parking is unreliable by itself.

  Implemented a stronger fallback in application.js:

  - If a parked window is still too visible after move, Hyprmon now hides it via minimize().
  - When that side becomes active again, Hyprmon restores it via unminimize(...).
  - Hidden-by-sideview windows are tracked separately so minimize signals don’t cause retile
    churn.

## v0.6841 Fixes
• Patched the likely root cause in parking behavior in application.js:

  1. Parking now uses monitor-local geometry, not global far-off coordinates.
  2. Parked windows are moved with move_frame(...) (not move_resize_frame(...)) to avoid WM re-placement side
     effects.
  3. Parking keeps a tiny 8px sliver on the source monitor edge so Muffin doesn’t shove windows onto primary.
  4. Restore also uses move_frame(...) to reduce cross-monitor jumping.

## v0.684 Sideviews
• Implemented Option A sideviews across the codebase.

###  What changed

####  1. State format + migration to version: 2 in tiling-state-io.js:

  - Added workspace shape support for activeSide, windowSides, and sides.
  - Migrates old workspaces[ws].monitors into workspaces[ws].sides["0"].monitors.
  - Preserves gapsDisabled and normalizes missing side structures.
  - Save fallback now writes version: 2.

####  2. Side-aware core behavior in application.js:

  - Added side state helpers:
      - #getWorkspaceState, #getActiveSideIndex, #setActiveSideIndex
      - #getWindowSide, #setWindowSide, #deleteWindowSide
      - #ensureSideState, #getSideMonState
      - Side-aware #getBspTree/#setBspTree, plus #clearSideTrees/#clearWorkspaceTrees.
  - #listManagedTilingCandidates now filters to active side only.
  - New windows inherit current workspace active side.
  - Workspace moves/unmanaged cleanup now updates per-workspace windowSides.
  - Retile path now restores active-side parked windows and parks inactive-side windows.

####  3. Off-screen parking (Option A) in application.js:

  - Added:
      - #getGlobalMonitorBounds, #getParkingStride, #getParkingRectForWindow
      - #parkWindowForSide, #parkInactiveSideWindows
      - #restoreWindowFromParking, #restoreActiveSideWindows
  - Uses large stride based on global monitor bounds to avoid landing on real monitors.

####  4. Side switching + move focused window between sides in application.js:

  - Added:
      - #switchActiveWorkspaceSide(delta)
      - #moveFocusedWindowToSideDelta(delta)
  - Side switch updates activeSide, parks/restores, retiles, refreshes borders, and notifies.
  - Move-to-side removes from source side tree, reassigns side, then inserts/parks depending on target side activity.

####  5. Hotkeys for sideviews in settings-schema.json and application.js:

  - Added schema keys:
      - sideviewPrevHotkey (<Super>Page_Up)
      - sideviewNextHotkey (<Super>Page_Down)
      - moveWindowToPrevSideHotkey (<Super><Shift>Page_Up)
      - moveWindowToNextSideHotkey (<Super><Shift>Page_Down)
  - Bound/unbound in hotkey registration logic.

## v0.683 Special colored overlays for sticky/floating & bugfixing

### 1) Fix: top-monitor windows shifted down vs overlays (stacked monitors)
Bug pattern strongly matches a coordinate-space mismatch between:
- the “work area / monitor geometry” you use to compute target rects, and
- what Muffin actually uses when applying move_resize_frame() in a vertical (“top/bottom”) layout.
The most robust fix is:
- 1. Stop deriving work-area from panels manually when possible; use Muffin’s own work-area APIs if available.
- 2. Add a lightweight coordinate normalization for setups where monitor geometries include negative x/y, but window frame coords are in a rebased space.
- 3. Make snapToRect() more deterministic (round coords + use user_op=true; optional one-shot correction for “big delta” cases).

### 2) Feature: special border colors for floating + sticky (with blended active)
Behavior
- Tiled windows: same as now (active/inactive colors from settings).
- Floating windows (hyprmon-managed): default “whitish green”.
- Sticky windows: default “dark magenta-ish”.
- Focused floating/sticky: blended between user active color and the special color.

### Notes / expected result
- The stacked-monitor “top windows shifted down into bottom monitor” should resolve primarily via the work-area API + coord normalization + snapToRect hardening.
- The float/sticky colored borders will appear only for hyprmon-managed floating/sticky (your #userFloatingKeys / #stickyKeys), and the focused one will use a blended color.

## v0.682 — Overlay stacking + floating overlays + recovery retile
Fixes / mitigations (best-effort on X11/Muffin):
- Overlays/borders now respect window stacking:
  - borders no longer draw over floating/sticky windows or over dialogs/popups
  - implementation: borders are inserted as siblings just above each window actor (not in Main.uiGroup)
- Floating/sticky windows managed by hyprmon now get overlays too (active workspace only)
  - borders follow floating windows while moving/resizing (overlay refresh debounce)
- “Force re-tile windows on the current workspace” becomes a recovery action:
  - clears BSP for the active workspace and rebuilds via retile burst
- Workspace moves now use retile bursts (reduces “half-screen stuck” survivors)
- Added best-effort “un-tile” in snapToRect() for keyboard snap-to-half-screen cases
- Monitor layout changes (monitors-changed) clear BSP trees for enabled workspaces and re-tile bursts

### Patch v0.682 (best-effort) — fixes/mitigations for the TODO-listed “quality breaking” bugs
This patch does three main things:
- 1. Overlays now follow each window’s stacking (so they don’t draw over floating/sticky windows or dialogs).
- 2. Floating/sticky windows managed by hyprmon get overlays too (and those overlays follow them while you move/resize).
- 3. “Force re-tile” becomes a recovery action (clears the BSP for the active workspace before rebuilding), plus more robust reflow on workspace moves and monitor changes.

Notes / expectations
- The overlay-on-top-of-everything bug is fundamentally caused by Main.uiGroup being above all windows. Moving borders into each window’s own compositor layer is the correct fix on Cinnamon/Muffin.
- Dialogs/popups are separate window actors and will naturally sit above the tiled window + its border sibling.
- The “snap to half screen” stubbornness varies by Muffin build; the untile/set_tile_mode/tile(NONE) block is intentionally try/catch heavy.

## v0.681 - Fix bugs with de-sticky/de-float hotkeys
What this changes (behavior)
- You can now un-float and un-sticky normally.
- Forced-float rules still block turning float/sticky ON for rule-matched/special windows (same as your current intent).
- If you unfloat the last floating/sticky window, hyprmon will still run a stacking sync to clear keep-above (fixes “stuck always-on-top” edge cases).

## Installer script & Update README.md
- Add: install-hyprmon.sh - hyprmon installer script (Cinnamon extension)
- Update/Rewrite README.md - hyprmon now "ready for daily drive"

## v0.68 Polishings/Fixes
- Sticky windows: Should also stick "always on top"(multiple stickys should not keep "fighting each other" though)
- Floating windows: Should always float over auto-tiled windows, sticky windows should be over floating windows 
- Better rules/fixes(?if any?)/verify:
  - per-app float rules (e.g. dialogs, settings windows)
  - ignore pinned/stickys / always-on-top / special windows
- When auto-tiling is on, can we prevent resizing any window so large, that other tiled windows "can not" shrink any further? (Edge case we propably can not account/fight for is when creating "too many windows" that they simply can not stack anymore(?), unless maybe they should be forced "floating" if they can not fit... but this would cause "problems" with "de-float" all..?)

### What this v0.68 patch does
- Sticky windows now also get always-on-top (best-effort make_above() / set_keep_above(true)), and on focus/retile we re-assert a stable stacking order so multiple stickies don’t “fight”.
- Floating windows are now treated as always-on-top relative to tiled windows, and sticky windows are always raised after floating (so stickies stay on top of floats).
- Adds per-app forced floating rules (forceFloatingRules) to ignore dialogs/settings/etc. without touching the user-float/sticky sets.
- Adds minimum tile size clamp (minTileSizePx): keyboard resize and live border resize refuse split changes that would push any tile under the minimum (if the current layout is already below minimum because there are too many windows, the clamp relaxes to avoid getting stuck).

Notes / limitations (intentionally lightweight)
- The “min tile size” clamp prevents persisting a resize that would violate the minimum. During mouse-resize, the active window can still temporarily overlap while you drag (we do not hard-constrain the compositor), but the split ratios won’t move past the limit and the end-of-grab retile will snap back into the legal layout.
- “Forced float because it’s always-on-top” applies only to windows pinned above by the WM/user; hyprmon’s own above-state is tracked separately so we can undo it safely on disable/unfloat.

## v0.671 “Shrink” hotkeys & "change shape" with neighbor 
- Same code path as Grow from 0.67: call #growActiveDir(oppositeDir) or add a separate sign.
- Hotkeys/Behaviour to enable changing shape with neighbour, allowing side-by-side-pair to turn top-bottom-pair.
- Notes (behavior implemented)
  - Shrink hotkeys call the same split-nudge path as Grow, but invert the ratio delta.
  - Change shape only applies when:
    - the neighbor exists in that direction,
    - the two tiles share a full border on that edge (same y+height for left/right, same x+width for up/down),
    - and the BSP split between them is a direct symmetric pair (the separating split has exactly two leaves: those two windows).
  - Shape toggle preserves the split ratio (size share) and uses deterministic ordering (key order) for the new axis.

## v0.67 - Hotkeys for resizing active window & changing focus
- Hotkeys for:
  - focus next/prev tile (left/right/up/down - default: shift+super+up/down/left/right) 
  - swap with neighbor (left/right/up/down - default: alt+super+up/down/left/right)
- Hotkeys for:
  - Grow active window from right edge towards right (default: ctrl + super + <right arrow>)
  - Grow active window from left edge towards left (default: ctrl + super + <left arrow>)
  - Grow active window from top edge towards up (default: ctrl + super + <up arrow>)
  - Grow active window from bottom edge towards down (default: ctrl + super + <down arrow>)
- The each functionality is quite self explanatory; 
 - Focus: Change focus from current window to next/neighbouring one, if any window on same screen there.
 - Swap: Change place with neighbour window, if any window on same screen there.
 - Grows: (trying to) make the active window bigger on key presses - causing our existing "resize neighbours" -behaviour - basically should behave as if the window was resized by mouse command. Should not be able to resize over gaps/monitor edges.

Notes on behavior
- Focus / Swap are strictly per active monitor (same screen), because neighbor detection uses the per-monitor rectByKey.
- Grow only works when there is a neighbor on that side, so it won’t “resize over monitor edges”. It simply moves the split boundary by resizeStepPx and lets your existing BSP/retile logic do the neighbor resize.
- Works with gaps on/off (v0.66) because it uses #effectiveGapsForWorkspace() and cached/derived gapped rects.

## v0.66 Toggle Window-Gaps on/off per workspace
What this patch does (v0.66)
- Adds Super+G hotkey to toggle gaps per workspace (only affects tiling-enabled workspaces).
- When gaps are disabled for a workspace:
  - outerGap = 0
  - innerGap = 0
  - (extraTopGap/extraBottomGap stay as-is, so your bar reserve space remains stable)
- The toggle is persisted in tiling-state.json under workspaces[ws].gapsDisabled, so it survives extension reloads.
- “Animation” of gaps shrinking/growing happens auto

## v0.6.5 (v0.64 + v0.65) floating + sticky windows (systemwide flags)

### v0.64 — Floating windows
- Adds hotkeys:
  - Toggle floating (focused window): **Super+V**
  - De-float all floating/sticky windows: **Super+Shift+V**
- A floating window is excluded from tiling on any workspace/monitor.
- Floating windows do not trigger tiling reflows (move/resize/workspace changes are ignored by hyprmon).
- Un-floating a window on a tiling-enabled workspace inserts it into the BSP like a drop:
  - split the tile under the window (center/overlap based), using the same split-side logic as drag insert.

### v0.65 — Sticky windows
- Adds hotkey:
  - Toggle sticky (all workspaces) for focused window: **Super+S**
- Sticky implies floating:
  - Sticky windows are marked floating and excluded from tiling.
  - They follow you across workspaces (MetaWindow.stick()).
- Un-sticky also un-floats; if the active workspace is tiling-enabled, the window is inserted into the BSP like a drop.
- “De-float all” also removes stickiness from sticky windows.

### Notes / behavior:
- Floating (Super+V): removes the focused window from the BSP (if it was tiled), and excludes it from tiling everywhere (any workspace/monitor). It no longer triggers reflows when moved/resized.
- Un-float (Super+V again): inserts the window into the BSP like a drop, based on its current position (center/overlap + pointer hint).
- De-float all (Super+Shift+V): clears floating for all hyprmon-flagged windows. If a window was sticky, it also gets un-stuck and is dropped into the current active workspace if tiling is enabled there.
- Sticky (Super+S): sticks the focused window to all workspaces and flags it floating (excluded from tiling). Un-sticky un-floats and drops it into tiling if enabled.

This patch intentionally keeps everything in application.js + settings, and persists flags in tiling-state.json only to survive extension reloads within the same session.

## v0.6.3 (v0.63) new windows split active tile / optional pointer placement

- Default: when a new window is created on a tiling-enabled workspace, the BSP inserts it by **splitting the focused tile** (active window) on the **active workspace**.
- Optional: if the configured modifier is held at creation time, the new window is inserted **like a drop under the mouse cursor** (splits the tile under the pointer using the same axis/side logic as drag insert).
- Non-active workspaces fall back to legacy behavior (split largest leaf), since “active tile” is undefined there.

## v0.6.2 (v0.61 + v0.62) tile borders + optional transitions (best-effort on X11)

### v0.61 — Tiled-window border (overlay)
- Adds per-tile border overlays for tiling-enabled workspaces (ACTIVE workspace only).
- Settings:
  - enable/disable overlays
  - active/inactive border width
  - active/inactive colors
  - rounded corners (radius)
- Updates on:
  - retile/layout changes
  - live resize ticks (keeps overlays aligned)
  - focus changes (active/inactive styling)
- Explicit perf rule: borders are cleared/hidden on workspace switch; inactive workspaces never keep overlays around.

### v0.62 — Optional visuals / transitions (best-effort on X11)
- Optional overlay-only animation (safe): animates overlay moves/resizes.
- Optional window-geometry animation (opt-in): short step-based interpolation (may stutter; disabled during grabs and live resize ticks).

### Notes on the behavior this patch implements (matches your constraints)
    • Borders are only drawn for the active workspace and are cleared/hidden on every workspace switch, so inactive workspaces do not keep overlays around.
    • Overlay updates happen only on:
        ◦ retile (layout changes)
        ◦ live resize ticks (no overlay animation there; they stay glued)
        ◦ focus changes (active/inactive style swap)
    • Transitions:
        ◦ Overlay-only animation uses actor.ease() when available; otherwise it falls back to immediate positioning.
        ◦ Geometry animation is opt-in, short, and disabled during live resize ticks and while a window is in grab-state (moving/resizing).

## v0.5 change drag n drop window behaviour to more smart one
**Old v0.3 behavior (swap-on-drop)**
- While moving a tiled window, you don’t change the tiled layout.
- On grab end you:
  - hit-test a target leaf
  - swapLeavesByKey(tree, myKey, targetKey)
  - retile

**New behavior (detach + insert-on-drop)**
- 1. On grab begin
  - the dragged window becomes “floating” (excluded from tiling)
  - the rest of the workspace retiles immediately “as if it was closed”
- 2. On grab end
  - pick a target tile under the drop point
  - split that target leaf into two children:
    - one child = target window
    - other child = dragged window
  - split axis + side are chosen based on the drop position (near left/right => vertical split; near top/bottom => horizontal split)
This is fundamentally “remove leaf” + “insert leaf by splitting a specific leaf”.

### Notes about this patch’s behavior:
- As soon as a move grab begins on a tiling-enabled workspace, the grabbed window is excluded from tiling (#floatingWindowKeys) and the workspace retiles on idle, so the gap closes immediately.
- On drop, the window is inserted by splitting the target tile. Axis/side are chosen from pointer position relative to the target rect; ratio is fixed at 0.5 (middle split).
- Trees are updated persistently: we remove the leaf at drag begin (removeLeafByKey) and insert/split at drag end (insertKeyBySplittingLeaf).
- If the destination workspace is not tiling-enabled, the window is simply unmanaged there (floating), and origin is re-enforced.
If you want the split decision to bias “top/bottom when dropped near top/bottom quarters” instead of strict nearest-edge (and to handle drops outside the rect more intuitively), that’s a small tweak in #chooseSplitFromPoint().

## v0.41 clean unused legacy fancytiles -code 
Notes on what this removes (so you can sanity-check behavior):
    • Removes layout editor (GridEditor + LayoutIO + LayoutNode tree + drawing helpers + presets + editor hotkey).
    • Removes Fancy Tiles snap-overlay / snapping modifiers behavior entirely.
    • Keeps only: per-workspace tiling, BSP persistence, drag-to-reorder, live border resize adjusting neighbors, and the gap/workarea logic.
(Layout editor + Fancy Tiles snapping code removed; hyprmon is BSP tiling only.)

## v0.4 realtime resize” implementation:

- Hooks grab-op begin/end for resize grab ops.
- During resize, it updates the BSP split ratio live (throttled to idle/frame), and retile-applies neighbors in realtime.
- On resize end, it snaps everything cleanly (like your move path).

This is implemented with:
- 1. New file: bsp-resize.js (pure helpers: neighbor picking + ratio math + clamping)
- 2. Changes: bsp-tree.js (find split between 2 windows, find nearest split, set ratio at path)
- 3. Changes: application.js (resize ctx, grab hooks, live update loop)

Notes / expected behavior
- Resizing a tiled window edge should now “pull” the border and adjacent tiles resize live.
- Corner resize (NE/NW/SE/SW) will attempt to update both axes, if it can find matching splits.
- While resizing, the active window is not snapped by us (to avoid pointer jitter). Neighbors are.
- On release, a normal retile enforces exact alignment.

If you want the resize to be even “stickier” / more Hyprland-like
- Two small knobs (optional) you can tweak later:
  - 1. minPx in clampRatioForParent(..., 120)
    - Increase to prevent tiny tiles; decrease to allow micro tiles.
  - 2. Math.abs(clamped - t.lastRatio) < 0.002 jitter threshold
    - Lower = more reactive; higher = smoother.

## v0.2/0.3 patch/fix2:

### 1) Add “Extra top gap” + “Extra bottom gap” settings. 
### 2) Make reload/startup tiling “heal” reliably + retile on any move/resize/maximize/minimize

### What you get after this patch
- The reload/startup overlap issue should largely disappear because:
  - startup healing retile runs even for non-active enabled workspaces
  - each enable/workspace-switch does a retile burst (several passes) to catch “ignored first resize” windows
- Extra top/bottom gap gives you deterministic control even when panel detection is imperfect.
- Any move/resize/maximize/minimize/fullscreen causes a retile when tiling is enabled, without feedback loops:
  - your own tiling changes are suppressed for ~350ms per window
  - live drags are not fought until grab ends

### Notes / if you still see rare startup weirdness

If a specific app consistently ignores move_resize_frame the first time after a Cinnamon reload, the next incremental step is to add a “verify after apply” check (compare actual frame rect vs target, and if any mismatch, schedule another burst). With the burst passes above, you’ll usually not need it.

## v0.2/0.3 patch/fix

### Patch that fixes all three:
- 1. Stable per-window identity key (uses get_stable_sequence() when available, otherwise assigns a persistent id via WeakMap, never get_user_time()).
- 2. More forgiving target selection: prefer pointer position, then center, then max overlap area.
- 3. More responsive re-tile after drag: run a re-tile on idle immediately, plus a short follow-up debounce.

### What this changes in behavior
- Reorder now uses a truly stable key, so swaps persist and don’t “snap back” due to key drift.
- Drop detection is less finicky (gap/edge drops still pick a target via overlap).
- After releasing the drag, tiling enforcement happens immediately on idle (feels instant), with a follow-up pass to handle windows that ignore the first resize right after a grab.

## v0.2 & 0.3

### What this implements

### v0.2 — Persist ordering + basic BSP split tree
- Per workspace + monitor BSP tree stored in ~/.config/hyprmon@og-yona/tiling-state.json
- On relayout:
  - reconcile candidate windows with the BSP tree (remove missing leaves, add new leaves by splitting largest leaf)
  - compute rects from BSP and apply inner gaps
- Adds Reset layout hotkey (default <Super><Shift>r) which clears BSP state for the current workspace and retiles.

### v0.3 — Drag-to-reorder tiles
- On tiling-enabled workspaces, MOVING drag is treated as reorder gesture:
  - on drag end, compute window center point
  - find tile rect containing it
  - swap the two leaves in the BSP tree
  - relayout (debounced)
- Snapping overlays are disabled on tiling-enabled workspaces to avoid conflicts (snapping still works on non-tiling workspaces as before).

# v0.1 MVP:

## 1) MVP v0.1 — “Auto tile + gaps + per-workspace toggle”
### 1.1 Per-workspace enable state
- Implement per-workspace state:
  - `enabledWorkspaces[wsIndex] = bool`
  - default behavior (all off)
- Hotkey:
  - “Toggle hyprmon tiling on current workspace”
  - optional: “Tile now” manual reflow hotkey
- Settings UI:
  - outer gap (px)
  - inner gap (px)
  - optional: enable on workspace N by default

### 1.2 Window enumeration + filtering
- For a given workspace:
  - list candidate windows (normal windows only)
  - exclude: minimized / fullscreen / skip-taskbar / transient dialogs (initial heuristic)
- Multi-monitor:
  - decide MVP scope:
    - (DO THIS: option A: tile per monitor independently)
    - (NOT THIS: option B: only tile on active monitor)
  - implement chosen approach

### 1.3 Work area + gap handling
- Compute usable work area:
  - respect panels (no overlap)
  - apply outer gap to edges
- Apply inner gaps between window rects

### 1.4 Layout engine v0 (simple predictable tiling)
Implement the simplest “good enough” algorithm first:
- Input: N windows + work area + gaps
- Output: array of rects
- Behavior target:
  - 1 → full
  - 2 → vertical split 50/50
  - 3 → split left (or right) half horizontally (consistent rule)
  - 4 → 2x2 grid
  - 5+ → keep splitting (choose a consistent heuristic: largest rect wins)

> Note: keep layout stateless initially if needed; stateful split ratios come later.

### 1.5 Apply geometry reliably
- Implement `applyRects(windows, rects)` using move/resize frame calls
- Add debounce:
  - coalesce multiple events (open/close/move) into one relayout pass
  - schedule relayout on idle / short timeout to avoid “new window ignores first resize”

### 1.6 Event hooks
When tiling enabled on workspace:
- On enable: tile all current windows there
- On window created/mapped: relayout
- On window closed/unmanaged: relayout
- On window moved to/from workspace: relayout
- On workspace switch:
  - if enabled, optionally “enforce tiling” immediately
  - if disabled, do nothing

### 1.7 MVP quality bar
- No flicker loops / resize storms
- Works for common apps (terminal, browser, files, editor)
- Does not break dialogs/popups (leave them floating)

Deliverable: **v0.1** usable daily for “toggle tiling → auto arrange/reflow”.

# 0) Project setup (day 0)
- Create repo: `hyprmon`
- Base extension skeleton (fork Fancy Tiles)
