/* window-utils.js */
// utility functions for windows

const Main = imports.ui.main;
const Panel = imports.ui.panel;
const Meta = imports.gi.Meta;
  
// Per-monitor move/resize correction (learned).
// Some stacked-monitor layouts end up applying a consistent translation when calling move_resize_frame().
// We learn (dx,dy) per monitor by observing actual frame rects after a move.
let _moveAdjustByMon = Object.create(null); // monIndex -> { dx:number, dy:number }
 
// ---- coordinate normalization (stacked monitors can expose negative x/y, while window coords may be rebased) ----
let _coordSig = '';
let _coordShift = { dx: 0, dy: 0 };

function _rectContains(outer, inner, eps = 2) {
    if (!outer || !inner) return false;
    const e = Math.max(0, Math.floor(Number(eps) || 0));
    return (
        inner.x >= outer.x - e &&
        inner.y >= outer.y - e &&
        (inner.x + inner.width) <= (outer.x + outer.width) + e &&
        (inner.y + inner.height) <= (outer.y + outer.height) + e
    );
}

function _getMonitorGeometries() {
    const out = [];
    try {
        const n = global.display.get_n_monitors();
        for (let i = 0; i < n; i++) {
            const g = global.display.get_monitor_geometry(i);
            out.push({ x: g.x, y: g.y, width: g.width, height: g.height });
        }
    } catch (e) {}
    return out;
}

function _computeCoordShift() {
    const geoms = _getMonitorGeometries();
    const sig = geoms.map(g => `${g.x},${g.y},${g.width},${g.height}`).join('|');
    if (sig && sig === _coordSig) return _coordShift;
    _coordSig = sig;

    _coordShift = { dx: 0, dy: 0 };
    if (!geoms.length) return _coordShift;

    let minX = 0, minY = 0;
    for (const g of geoms) { minX = Math.min(minX, g.x); minY = Math.min(minY, g.y); }
    const cand = { dx: minX < 0 ? -minX : 0, dy: minY < 0 ? -minY : 0 };
    if (cand.dx === 0 && cand.dy === 0) return _coordShift;

    // Validate shift against real windows: if shifted monitor boxes contain more windows than raw boxes, enable shift.
    let okRaw = 0, okShift = 0, total = 0;
    try {
        const actors = global.get_window_actors ? global.get_window_actors() : [];
        for (const a of actors) {
            const w = a && a.meta_window ? a.meta_window : null;
            if (!w || w.window_type !== Meta.WindowType.NORMAL) continue;
            let mon = null; try { mon = w.get_monitor(); } catch (e) {}
            if (mon === null || mon < 0 || mon >= geoms.length) continue;
            let fr = null; try { fr = w.get_frame_rect(); } catch (e) {}
            if (!fr) continue;
            total++;
            const rawBox = geoms[mon];
            const shiftedBox = { x: rawBox.x + cand.dx, y: rawBox.y + cand.dy, width: rawBox.width, height: rawBox.height };
            if (_rectContains(rawBox, fr, 6)) okRaw++;
            if (_rectContains(shiftedBox, fr, 6)) okShift++;
        }
    } catch (e) {}

    // Require a clear win to avoid breaking setups that *do* use negative coords natively.
    if (total > 0) {
        // Old threshold (okShift > okRaw + 3) fails when there are only a few windows.
        const need = Math.max(1, Math.ceil(total * 0.6));
        if (okShift >= need && okShift > okRaw) _coordShift = cand;
    }
    return _coordShift;
}

function _applyCoordShift(rect) {
    const s = _computeCoordShift();
    if (!rect || (!s.dx && !s.dy)) return rect;
    return { x: rect.x + s.dx, y: rect.y + s.dy, width: rect.width, height: rect.height };
}

// get the screen area excluding the panels
function getUsableScreenArea(displayIdx) {
    // If we received a display index number, get the geometry
    if (typeof displayIdx !== 'number') {
        global.logError('getUsableScreenArea: displayIdx is not a number');
        return null;
    }

    // Prefer compositor-provided work area (handles stacked monitors + struts correctly).
    try {
        if (global.display && typeof global.display.get_work_area_for_monitor === 'function') {
            const wa = global.display.get_work_area_for_monitor(displayIdx);
            return _applyCoordShift({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
        }
    } catch (e) {}
    try {
        // Some Muffin/Mutter builds expose get_monitor_workarea()
        if (global.display && typeof global.display.get_monitor_workarea === 'function') {
            const wa = global.display.get_monitor_workarea(displayIdx);
            return _applyCoordShift({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
        }
    } catch (e) {}
    try {
        // Shell-style layout manager API (best-effort)
        if (Main && Main.layoutManager && typeof Main.layoutManager.getWorkAreaForMonitor === 'function') {
            const wa = Main.layoutManager.getWorkAreaForMonitor(displayIdx);
            return _applyCoordShift({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
        }
    } catch (e) {}

    // Fallback: old panel-based approach
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
                    // left/right panels should use width; some objects expose width, fallback to height
                    left += (panel.width !== undefined ? panel.width : panel.height);
                    break;
                case Panel.PanelLoc.right:
                    right -= (panel.width !== undefined ? panel.width : panel.height);
                    break;
            }
        }
    }

    let width = Math.max(0, right - left);
    let height = Math.max(0, bottom - top);
    return _applyCoordShift({ x: left, y: top, width: width, height: height });
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
 
    // Determine monitor for per-monitor correction (best effort).
    let mon = null;
    try { if (typeof metaWindow.get_monitor === 'function') mon = metaWindow.get_monitor(); } catch (e) {}
    if (!Number.isFinite(mon)) mon = null;

    let adj = null;
    if (mon !== null) {
        adj = _moveAdjustByMon[String(mon)] || { dx: 0, dy: 0 };
        // keep sane bounds
        adj.dx = Number(adj.dx) || 0;
        adj.dy = Number(adj.dy) || 0;
        if (Math.abs(adj.dx) > 20000) adj.dx = 0;
        if (Math.abs(adj.dy) > 20000) adj.dy = 0;
    }

    const x = Math.round(rect.x);
    const y = Math.round(rect.y);
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));

    // Apply learned correction (request = desired - adj).
    const reqX0 = (adj ? (x - Math.round(adj.dx)) : x);
    const reqY0 = (adj ? (y - Math.round(adj.dy)) : y);

    // Keep the old, most reliable behavior: user_op=false.
    try { metaWindow.move_resize_frame(false, reqX0, reqY0, w, h); } catch (e) {}

    // Learn/adjust if the WM applied a translation (very common in stacked-monitor weirdness).
    try {
        const fr2 = metaWindow.get_frame_rect();
        if (fr2 && mon !== null) {
            const errX = Math.round(fr2.x - x);
            const errY = Math.round(fr2.y - y);

            const bigEnough = (Math.abs(errX) > 20) || (Math.abs(errY) > 20);
            const sane = (Math.abs(errX) < 20000) && (Math.abs(errY) < 20000);

            if (bigEnough && sane) {
                // err = actual - desired = (T - adj). Move adj toward T.
                const alpha = 0.65;
                adj.dx = (Number(adj.dx) || 0) + errX * alpha;
                adj.dy = (Number(adj.dy) || 0) + errY * alpha;
                _moveAdjustByMon[String(mon)] = adj;

                // One immediate retry using the updated correction (converges fast).
                const reqX1 = x - Math.round(adj.dx);
                const reqY1 = y - Math.round(adj.dy);
                try { metaWindow.move_resize_frame(false, reqX1, reqY1, w, h); } catch (e2) {}
            } else if (adj) {
                // Slowly decay correction when it no longer seems needed.
                const decay = 0.85;
                adj.dx *= decay;
                adj.dy *= decay;
                if (Math.abs(adj.dx) < 0.5) adj.dx = 0;
                if (Math.abs(adj.dy) < 0.5) adj.dy = 0;
                _moveAdjustByMon[String(mon)] = adj;
            }
        }
    } catch (e) {}
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