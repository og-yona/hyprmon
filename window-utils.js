/* window-utils.js */
// utility functions for windows

const Main = imports.ui.main;
const Panel = imports.ui.panel;
const Meta = imports.gi.Meta;

// get the screen area excluding the panels
function getUsableScreenArea(displayIdx) {
    // If we received a display index number, get the geometry
    if (typeof displayIdx !== 'number') {
        global.logError('getUsableScreenArea: displayIdx is not a number');
        return null;
    }

    const display = global.display.get_monitor_geometry(displayIdx);

    let top = display.y;
    let bottom = display.y + display.height;
    let left = display.x;
    let right = display.x + display.width;

    // Get panels for this display
    for (let panel of Main.panelManager.getPanelsInMonitor(displayIdx)) {
        if (!panel.isHideable()) {
            switch (panel.panelPosition) {
                case Panel.PanelLoc.top:
                    top += panel.height;
                    break;
                case Panel.PanelLoc.bottom:
                    bottom -= panel.height;
                    break;
                case Panel.PanelLoc.left:
                    left += panel.height;
                    break;
                case Panel.PanelLoc.right:
                    right -= panel.height;
                    break;
            }
        }
    }

    let width = Math.max(0, right - left);
    let height = Math.max(0, bottom - top);
    return { x: left, y: top, width: width, height: height };
}
 
// shrink a rect by outerGap on all sides (clamped)
function applyOuterGapToArea(area, outerGapPx) {
    const g = Math.max(0, Math.floor(Number(outerGapPx) || 0));
    if (!area) return null;
    return {
        x: area.x + g,
        y: area.y + g,
        width: Math.max(0, area.width - g * 2),
        height: Math.max(0, area.height - g * 2),
    };
}

// usable work area for tiling (panels excluded, then outer gap applied)
function getTilingWorkArea(displayIdx, outerGapPx) {
    const usable = getUsableScreenArea(displayIdx);
    return applyOuterGapToArea(usable, outerGapPx);
}

function _safeBool(value, fallback = false) {
    return typeof value === 'boolean' ? value : fallback;
}

function _workspaceIndexOfWindow(w) {
    try {
        const ws = w && w.get_workspace ? w.get_workspace() : null;
        if (ws && typeof ws.index === 'function') return ws.index();
        if (ws && typeof ws.get_workspace_index === 'function') return ws.get_workspace_index();
    } catch (e) {}
    return null;
}

function isWindowTileable(metaWindow) {
    if (!metaWindow) return false;

    try {
        // only normal app windows
        if (metaWindow.window_type !== Meta.WindowType.NORMAL) return false;

        // skip minimized
        if (_safeBool(metaWindow.minimized, false)) return false;
        if (typeof metaWindow.is_minimized === 'function' && metaWindow.is_minimized()) return false;

        // skip fullscreen
        if (_safeBool(metaWindow.fullscreen, false)) return false;
        if (typeof metaWindow.is_fullscreen === 'function' && metaWindow.is_fullscreen()) return false;

        // skip taskbar-less / special windows
        if (_safeBool(metaWindow.skip_taskbar, false)) return false;

        // skip sticky (shows on all workspaces) by default
        if (typeof metaWindow.is_on_all_workspaces === 'function' && metaWindow.is_on_all_workspaces()) return false;

        // skip transient/dialog-attached windows
        if (typeof metaWindow.get_transient_for === 'function' && metaWindow.get_transient_for()) return false;
        if (typeof metaWindow.is_attached_dialog === 'function' && metaWindow.is_attached_dialog()) return false;

        return true;
    } catch (e) {
        global.logError(`hyprmon: isWindowTileable error: ${e}`);
        return false;
    }
}

function listAllMetaWindows() {
    const actors = global.get_window_actors ? global.get_window_actors() : [];
    const wins = [];
    for (const a of actors) {
        const w = a && a.meta_window ? a.meta_window : null;
        if (w) wins.push(w);
    }
    return wins;
}

// list candidate windows on a workspace; optionally restrict to one monitor
function listTilingCandidates(workspaceIndex, monitorIndex = null) {
    const all = listAllMetaWindows();
    const out = [];

    for (const w of all) {
        if (!isWindowTileable(w)) continue;

        const wsIdx = _workspaceIndexOfWindow(w);
        if (wsIdx === null || wsIdx !== workspaceIndex) continue;

        if (monitorIndex !== null) {
            try {
                if (w.get_monitor && w.get_monitor() !== monitorIndex) continue;
            } catch (e) {
                continue;
            }
        }

        out.push(w);
    }

    return out;
}

// Apply inner gaps to a rect while keeping outer gap exact:
// - rects that touch workArea edges do NOT get inner-gap padding on that edge
function applyInnerGapsToRect(rect, workArea, innerGapPx) {
    if (!rect || !workArea) return rect;
    const g = Math.max(0, Math.floor(Number(innerGapPx) || 0));
    if (g <= 0) return rect;

    const EPS = 1; // tolerate rounding
    const halfA = Math.floor(g / 2);
    const halfB = Math.ceil(g / 2);

    const atLeft = Math.abs(rect.x - workArea.x) <= EPS;
    const atTop = Math.abs(rect.y - workArea.y) <= EPS;
    const atRight = Math.abs((rect.x + rect.width) - (workArea.x + workArea.width)) <= EPS;
    const atBottom = Math.abs((rect.y + rect.height) - (workArea.y + workArea.height)) <= EPS;

    const padL = atLeft ? 0 : halfA;
    const padT = atTop ? 0 : halfA;
    const padR = atRight ? 0 : halfB;
    const padB = atBottom ? 0 : halfB;

    return {
        x: rect.x + padL,
        y: rect.y + padT,
        width: Math.max(0, rect.width - padL - padR),
        height: Math.max(0, rect.height - padT - padB),
    };
}

function applyInnerGapsToRects(rects, workArea, innerGapPx) {
    return (rects || []).map(r => applyInnerGapsToRect(r, workArea, innerGapPx));
}

// Snap window to a node in the layout
function snapToRect(metaWindow, rect) {
    if (!metaWindow || !rect) {
        global.logError('No metaWindow or rect');
        return;
    }

    let clientRect = metaWindow.get_frame_rect();
    // Check if window is already at desired position and size
    if (clientRect.x === rect.x &&
        clientRect.y === rect.y &&
        clientRect.width === rect.width &&
        clientRect.height === rect.height) {
        return;
    }
 
    // If the window is maximized, Mutter will often ignore move/resize requests.
    // For autotiling workspaces, we force it back to a "normal" state first.
    try {
        // Unmaximize
        const maxH = _safeBool(metaWindow.maximized_horizontally, false);
        const maxV = _safeBool(metaWindow.maximized_vertically, false);
        if ((maxH || maxV) && typeof metaWindow.unmaximize === 'function') {
            // Prefer BOTH if available; otherwise try H|V
            if (Meta.MaximizeFlags && Meta.MaximizeFlags.BOTH !== undefined) {
                metaWindow.unmaximize(Meta.MaximizeFlags.BOTH);
            } else if (Meta.MaximizeFlags) {
                const flags =
                    (maxH ? Meta.MaximizeFlags.HORIZONTAL : 0) |
                    (maxV ? Meta.MaximizeFlags.VERTICAL : 0);
                metaWindow.unmaximize(flags);
            } else {
                // fallback: call without flags if some builds allow it
                metaWindow.unmaximize(0);
            }
        }
    } catch (e) {
        // non-fatal; still attempt move/resize
    }

    // v0.682: best-effort to undo "tiled-to-side" / snapping state.
    // Some Muffin/Mutter builds keep a tile mode that can resist move_resize_frame(),
    // especially after keyboard snap-to-half-screen.
    try {
        if (typeof metaWindow.untile === 'function') {
            metaWindow.untile();
        }
    } catch (e) {}
    try {
        if (typeof metaWindow.set_tile_mode === 'function' && Meta.TileMode && Meta.TileMode.NONE !== undefined) {
            metaWindow.set_tile_mode(Meta.TileMode.NONE);
        }
    } catch (e) {}
    try {
        if (typeof metaWindow.tile === 'function' && Meta.TileMode && Meta.TileMode.NONE !== undefined) {
            metaWindow.tile(Meta.TileMode.NONE);
        }
    } catch (e) {}

    metaWindow.move_resize_frame(
        false,
        rect.x, rect.y,
        rect.width, rect.height);
}

// Export the module
module.exports = {
    getUsableScreenArea,
    getTilingWorkArea,
    applyOuterGapToArea,
    applyInnerGapsToRect,
    applyInnerGapsToRects,
    listAllMetaWindows,
    isWindowTileable,
    listTilingCandidates,
    snapToRect
}; 
/* window-utils.js END */