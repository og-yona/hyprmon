/* sideviews.js */

const Clutter = imports.gi.Clutter;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;

const { listAllMetaWindows } = require('./window-utils');
const { removeLeafByKey } = require('./bsp-tree');

class Sideviews {
    #ctx;

    #parkRestoreRectByKey = Object.create(null);
    #sideHiddenKeys = new Set();
    #sideHiddenModeByKey = Object.create(null); // key -> 'actor' | 'minimize'
    #sideFocusRedirectUntil = 0;

    constructor(ctx) {
        this.#ctx = ctx || Object.create(null);
    }

    #cfg() {
        const sd = this.#ctx.getSettingsData ? (this.#ctx.getSettingsData() || Object.create(null)) : Object.create(null);
        const rawDur = Number(sd.sideviewAnimateDurationMs?.value ?? 160);
        return {
            notifyOnFocusRedirect: (sd.sideviewNotifyOnFocusRedirect?.value !== false),
            animateSwitch: !!sd.sideviewAnimateSwitch?.value,
            animateDurationMs: Math.max(0, Math.min(600, Math.floor(Number.isFinite(rawDur) ? rawDur : 160))),
        };
    }

    #animateSideReveal(wsIndex, sideIndex, direction) {
        const cfg = this.#cfg();
        if (!cfg.animateSwitch || cfg.animateDurationMs <= 0) return;

        const dir = Number(direction) >= 0 ? 1 : -1;
        const dur = cfg.animateDurationMs;

        Mainloop.idle_add(() => {
            try {
                for (const w of listAllMetaWindows()) {
                    if (!w || w.window_type !== Meta.WindowType.NORMAL) continue;
                    if (this.#ctx.getWorkspaceIndexOfWindow(w) !== wsIndex) continue;

                    const k = String(this.#ctx.getWindowKey(w));
                    if (this.#ctx.getWindowSide(wsIndex, k) !== sideIndex) continue;
                    if (this.#ctx.isSticky(w)) continue;

                    const actor = (typeof w.get_compositor_private === 'function') ? w.get_compositor_private() : null;
                    if (!actor) continue;

                    let monW = 1920;
                    try {
                        const monIndex = this.#ctx.getMonitorIndexOfWindow(w);
                        if (monIndex !== null && monIndex !== undefined) {
                            const m = global.display.get_monitor_geometry(monIndex);
                            if (m && Number.isFinite(Number(m.width))) monW = Number(m.width);
                        }
                    } catch (e) {}

                    const dist = Math.max(64, Math.min(280, Math.floor(monW * 0.14)));
                    try { if (typeof actor.remove_all_transitions === 'function') actor.remove_all_transitions(); } catch (e) {}
                    try {
                        actor.translation_x = dir * dist;
                        if (typeof actor.ease === 'function') {
                            actor.ease({
                                translation_x: 0,
                                duration: dur,
                                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                            });
                        } else {
                            if (typeof actor.set_easing_duration === 'function') actor.set_easing_duration(dur);
                            if (typeof actor.set_easing_mode === 'function') actor.set_easing_mode(Clutter.AnimationMode.EASE_OUT_CUBIC);
                            actor.translation_x = 0;
                        }
                    } catch (e) {
                        try { actor.translation_x = 0; } catch (_) {}
                    }
                }
            } catch (e) {}
            return false;
        });
    }

    destroy() {
        try {
            for (const w of listAllMetaWindows()) {
                if (!w || w.window_type !== Meta.WindowType.NORMAL) continue;
                const k = String(this.#ctx.getWindowKey(w));
                if (!this.#sideHiddenKeys.has(k)) continue;
                const mode = String(this.#sideHiddenModeByKey[k] || '');
                if (mode === 'actor') {
                    try {
                        const actor = (typeof w.get_compositor_private === 'function') ? w.get_compositor_private() : null;
                        if (actor && typeof actor.show === 'function') actor.show();
                    } catch (e) {}
                } else if (mode === 'minimize') {
                    try {
                        if (typeof w.unminimize === 'function') {
                            const t = (typeof global.get_current_time === 'function') ? global.get_current_time() : Date.now();
                            w.unminimize(t);
                        }
                    } catch (e) {}
                }
            }
        } catch (e) {}

        this.#parkRestoreRectByKey = Object.create(null);
        try { this.#sideHiddenKeys.clear(); } catch (e) {}
        this.#sideHiddenModeByKey = Object.create(null);
        this.#sideFocusRedirectUntil = 0;
    }

    isWindowSideHiddenByKey(winKey) {
        return this.#sideHiddenKeys.has(String(winKey || ''));
    }

    forgetWindow(winKey) {
        const k = String(winKey || '');
        if (!k) return;
        delete this.#parkRestoreRectByKey[k];
        this.#sideHiddenKeys.delete(k);
        delete this.#sideHiddenModeByKey[k];
    }

    #getGlobalMonitorBounds() {
        let left = Infinity;
        let top = Infinity;
        let right = -Infinity;
        let bottom = -Infinity;
        let maxWidth = 0;
        let maxHeight = 0;

        const n = global.display.get_n_monitors();
        for (let i = 0; i < n; i++) {
            let r = null;
            try { r = global.display.get_monitor_geometry(i); } catch (e) {}
            if (!r) continue;
            left = Math.min(left, r.x);
            top = Math.min(top, r.y);
            right = Math.max(right, r.x + r.width);
            bottom = Math.max(bottom, r.y + r.height);
            maxWidth = Math.max(maxWidth, r.width || 0);
            maxHeight = Math.max(maxHeight, r.height || 0);
        }

        if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom)) {
            return { left: 0, top: 0, right: 1920, bottom: 1080, width: 1920, height: 1080, maxWidth: 1920, maxHeight: 1080 };
        }
        return {
            left, top, right, bottom,
            width: Math.max(1, right - left),
            height: Math.max(1, bottom - top),
            maxWidth: Math.max(1, maxWidth),
            maxHeight: Math.max(1, maxHeight),
        };
    }

    #getParkingRectForWindow(metaWindow, sideIndex, activeSide) {
        if (!metaWindow) return null;
        const side = Math.max(0, Math.floor(Number(sideIndex) || 0));
        const active = Math.max(0, Math.floor(Number(activeSide) || 0));
        if (side === active) return null;

        let fr = null;
        try { fr = metaWindow.get_frame_rect(); } catch (e) {}
        if (!fr) fr = { x: 0, y: 0, width: 900, height: 700 };

        let mon = null;
        try {
            const monIndex = (typeof metaWindow.get_monitor === 'function') ? metaWindow.get_monitor() : null;
            if (monIndex !== null && monIndex !== undefined) mon = global.display.get_monitor_geometry(monIndex);
        } catch (e) {}
        if (!mon) {
            const b = this.#getGlobalMonitorBounds();
            mon = { x: b.left, y: b.top, width: b.maxWidth, height: b.maxHeight };
        }

        const sliver = 8;
        const delta = Math.abs(side - active);
        const laneNudge = Math.min(80, Math.max(0, (delta - 1) * 20));
        const yMin = mon.y;
        const yMax = mon.y + Math.max(0, mon.height - Math.max(1, fr.height));
        const y = Math.max(yMin, Math.min(fr.y, yMax));

        if (side < active) {
            const x = (mon.x - fr.width + sliver) - laneNudge;
            return { x, y, width: fr.width, height: fr.height };
        }
        const x = (mon.x + mon.width - sliver) + laneNudge;
        return { x, y, width: fr.width, height: fr.height };
    }

    #restoreWindowFromParking(metaWindow) {
        if (!metaWindow) return false;
        const k = String(this.#ctx.getWindowKey(metaWindow));
        if (this.#ctx.isWindowBusyKey(k)) return false;

        if (this.#sideHiddenKeys.has(k)) {
            const mode = String(this.#sideHiddenModeByKey[k] || '');
            if (mode === 'actor') {
                try {
                    const actor = (typeof metaWindow.get_compositor_private === 'function') ? metaWindow.get_compositor_private() : null;
                    if (actor && typeof actor.show === 'function') actor.show();
                } catch (e) {}
            } else {
                try {
                    if (typeof metaWindow.unminimize === 'function') {
                        const t = (typeof global.get_current_time === 'function') ? global.get_current_time() : Date.now();
                        metaWindow.unminimize(t);
                    }
                } catch (e) {}
            }
            this.#sideHiddenKeys.delete(k);
            delete this.#sideHiddenModeByKey[k];
        }

        const r = this.#parkRestoreRectByKey[k] || null;
        if (!r) return false;
        try {
            this.#ctx.suppressWindowGeomSignals(metaWindow, 450);
            if (typeof metaWindow.move_frame === 'function') metaWindow.move_frame(false, r.x, r.y);
            else metaWindow.move_resize_frame(false, r.x, r.y, r.width, r.height);
            delete this.#parkRestoreRectByKey[k];
            return true;
        } catch (e) {}
        return false;
    }

    #parkWindowForSide(metaWindow, wsIndex, sideIndex, activeSide) {
        if (!metaWindow || metaWindow.window_type !== Meta.WindowType.NORMAL) return false;
        if (this.#ctx.isSticky(metaWindow)) return false;

        const winWs = this.#ctx.getWorkspaceIndexOfWindow(metaWindow);
        if (winWs === null || winWs !== wsIndex) return false;

        const side = Math.max(0, Math.floor(Number(sideIndex) || 0));
        const active = Math.max(0, Math.floor(Number(activeSide) || 0));
        if (side === active) return this.#restoreWindowFromParking(metaWindow);

        const pr = this.#getParkingRectForWindow(metaWindow, side, active);
        if (!pr) return false;

        const k = String(this.#ctx.getWindowKey(metaWindow));
        if (this.#ctx.isWindowBusyKey(k)) return false;
        if (!this.#parkRestoreRectByKey[k]) {
            try {
                const fr = metaWindow.get_frame_rect();
                this.#parkRestoreRectByKey[k] = { x: fr.x, y: fr.y, width: fr.width, height: fr.height };
            } catch (e) {}
        }

        try {
            this.#ctx.suppressWindowGeomSignals(metaWindow, 450);
            if (typeof metaWindow.move_frame === 'function') metaWindow.move_frame(false, pr.x, pr.y);
            else metaWindow.move_resize_frame(false, pr.x, pr.y, pr.width, pr.height);

            let parkedOk = false;
            try {
                const fr2 = metaWindow.get_frame_rect();
                const monIndex = (typeof metaWindow.get_monitor === 'function') ? metaWindow.get_monitor() : null;
                const mon = (monIndex !== null && monIndex !== undefined) ? global.display.get_monitor_geometry(monIndex) : null;
                if (fr2 && mon) {
                    const left = Math.max(fr2.x, mon.x);
                    const right = Math.min(fr2.x + fr2.width, mon.x + mon.width);
                    const top = Math.max(fr2.y, mon.y);
                    const bottom = Math.min(fr2.y + fr2.height, mon.y + mon.height);
                    const visW = Math.max(0, right - left);
                    const visH = Math.max(0, bottom - top);
                    const visArea = visW * visH;
                    const fullArea = Math.max(1, fr2.width * fr2.height);
                    parkedOk = (visArea / fullArea) <= 0.12;
                }
            } catch (e) {}

            if (!parkedOk) {
                let hidden = false;
                try {
                    const actor = (typeof metaWindow.get_compositor_private === 'function') ? metaWindow.get_compositor_private() : null;
                    if (actor && typeof actor.hide === 'function') {
                        actor.hide();
                        hidden = true;
                        this.#sideHiddenModeByKey[k] = 'actor';
                    }
                } catch (e) {}
                if (!hidden) {
                    try { if (typeof metaWindow.minimize === 'function') metaWindow.minimize(); } catch (e) {}
                    this.#sideHiddenModeByKey[k] = 'minimize';
                }
                this.#sideHiddenKeys.add(k);
            } else {
                this.#sideHiddenKeys.delete(k);
                delete this.#sideHiddenModeByKey[k];
            }
            return true;
        } catch (e) {}
        return false;
    }

    parkInactiveSideWindows(wsIndex) {
        const activeSide = this.#ctx.getActiveSideIndex(wsIndex);
        for (const w of listAllMetaWindows()) {
            if (!w || w.window_type !== Meta.WindowType.NORMAL) continue;
            if (this.#ctx.getWorkspaceIndexOfWindow(w) !== wsIndex) continue;
            if (this.#ctx.isSticky(w)) continue;
            const k = String(this.#ctx.getWindowKey(w));
            const side = this.#ctx.getWindowSide(wsIndex, k);
            this.#parkWindowForSide(w, wsIndex, side, activeSide);
        }
    }

    restoreActiveSideWindows(wsIndex) {
        const activeSide = this.#ctx.getActiveSideIndex(wsIndex);
        for (const w of listAllMetaWindows()) {
            if (!w || w.window_type !== Meta.WindowType.NORMAL) continue;
            if (this.#ctx.getWorkspaceIndexOfWindow(w) !== wsIndex) continue;
            const k = String(this.#ctx.getWindowKey(w));
            if (this.#ctx.getWindowSide(wsIndex, k) !== activeSide) continue;
            this.#restoreWindowFromParking(w);
        }
    }

    switchActiveWorkspaceSide(delta) {
        const wsIndex = this.#ctx.getActiveWorkspaceIndex();
        const oldSide = this.#ctx.getActiveSideIndex(wsIndex);
        const rawNext = oldSide + Math.floor(Number(delta) || 0);
        const nextSide = Math.max(0, rawNext);
        if (nextSide === oldSide) return;

        this.#ctx.setActiveSideIndex(wsIndex, nextSide);
        this.restoreActiveSideWindows(wsIndex);
        this.parkInactiveSideWindows(wsIndex);
        this.#animateSideReveal(wsIndex, nextSide, nextSide - oldSide);
        this.#ctx.clearWorkspaceLastLayout(wsIndex);

        if (this.#ctx.isTilingEnabled(wsIndex)) this.#ctx.scheduleRetileBurst(wsIndex, 'side-switch');
        else this.#ctx.syncTileBorders(wsIndex, 'side-switch-disabled', false);

        if (typeof this.#ctx.focusWindowOnSide === 'function') {
            Mainloop.idle_add(() => {
                try { this.#ctx.focusWindowOnSide(wsIndex, nextSide); } catch (e) {}
                return false;
            });
        }

        this.#ctx.notify(`Workspace ${wsIndex + 1}: side ${nextSide + 1}`, { category: 'sideview' });
    }

    moveFocusedWindowToSideDelta(delta) {
        const w = this.#ctx.getFocusWindow();
        if (!w || w.window_type !== Meta.WindowType.NORMAL) return;
        if (this.#ctx.isSticky(w)) return;

        const wsIndex = this.#ctx.getWorkspaceIndexOfWindow(w);
        const monIndex = this.#ctx.getMonitorIndexOfWindow(w);
        if (wsIndex === null || monIndex === null) return;

        const k = String(this.#ctx.getWindowKey(w));
        const fromSide = this.#ctx.getWindowSide(wsIndex, k);
        const toSide = Math.max(0, fromSide + Math.floor(Number(delta) || 0));
        if (toSide === fromSide) return;

        const beforeTree = this.#ctx.getBspTree(wsIndex, monIndex, fromSide);
        const rem = removeLeafByKey(beforeTree, k);
        if (rem.changed) this.#ctx.setBspTree(wsIndex, monIndex, rem.tree, fromSide);

        this.#ctx.setWindowSide(wsIndex, k, toSide);
        const activeSide = this.#ctx.getActiveSideIndex(wsIndex);
        if (toSide === activeSide) {
            if (this.#ctx.isTilingEnabled(wsIndex)) {
                Mainloop.idle_add(() => { this.#ctx.insertWindowIntoLayout(w, 'side-move-visible', true); return false; });
            } else {
                this.#restoreWindowFromParking(w);
            }
        } else {
            this.#parkWindowForSide(w, wsIndex, toSide, activeSide);
            if (this.#ctx.isTilingEnabled(wsIndex)) this.#ctx.retileAfterDrag(wsIndex, 'side-move-hidden');
            this.#ctx.syncTileBorders(wsIndex, 'side-move-hidden', false);
        }

        this.#ctx.notify(`Window moved to side ${toSide + 1}`);
    }

    redirectFocusToWindowSideIfNeeded(metaWindow) {
        if (!metaWindow || metaWindow.window_type !== Meta.WindowType.NORMAL) return false;

        const wsIndex = this.#ctx.getWorkspaceIndexOfWindow(metaWindow);
        if (wsIndex === null) return false;
        if (wsIndex !== this.#ctx.getActiveWorkspaceIndex()) return false;

        const k = String(this.#ctx.getWindowKey(metaWindow));
        const targetSide = this.#ctx.getWindowSide(wsIndex, k);
        const activeSide = this.#ctx.getActiveSideIndex(wsIndex);
        if (targetSide === activeSide) return false;

        const now = Date.now();
        if (now < (this.#sideFocusRedirectUntil || 0)) return false;
        this.#sideFocusRedirectUntil = now + 450;

        this.#ctx.setActiveSideIndex(wsIndex, targetSide);
        this.restoreActiveSideWindows(wsIndex);
        this.parkInactiveSideWindows(wsIndex);
        this.#animateSideReveal(wsIndex, targetSide, targetSide - activeSide);
        this.#ctx.clearWorkspaceLastLayout(wsIndex);

        if (this.#ctx.isTilingEnabled(wsIndex)) this.#ctx.scheduleRetileBurst(wsIndex, 'focus-side-redirect');
        else this.#ctx.syncTileBorders(wsIndex, 'focus-side-redirect', false);

        if (this.#cfg().notifyOnFocusRedirect) {
            this.#ctx.notify(`Auto-switched to side ${targetSide + 1} (workspace ${wsIndex + 1})`, { category: 'sideview' });
        }
        return true;
    }
}

module.exports = { Sideviews };
/* sideviews.js END */
