/* window-opacity.js */

const Clutter = imports.gi.Clutter;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const SignalManager = imports.misc.signalManager;

class WindowOpacity {
    #signals = new SignalManager.SignalManager(null);
    #ctx;

    #timerId = 0;
    #refreshQueued = false;
    #refreshRunning = false;
    #refreshAgain = false;

    // winKey -> last requested opacity [0..255]
    #lastTargetByKey = Object.create(null);

    constructor(ctx) {
        this.#ctx = ctx || Object.create(null);
        this.#connectSignals();
        this.#restartTimer();
        this.refreshNow();
    }

    destroy() {
        this.#stopTimer();
        try { this.#signals.disconnectAllSignals(); } catch (e) {}
        this.restoreAll();
        this.#lastTargetByKey = Object.create(null);
    }

    onSettingsChanged() {
        this.#restartTimer();
        this.refreshSoon();
    }

    #getSettingsData() {
        return (this.#ctx.getSettingsData ? this.#ctx.getSettingsData() : null) || Object.create(null);
    }

    #cfg() {
        const sd = this.#getSettingsData();
        const clamp = (v, lo, hi, defv = 100) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return defv;
            return Math.max(lo, Math.min(hi, Math.floor(n)));
        };

        return {
            enabled: !!sd.autoOpacityEnabled?.value,
            fullscreenMaximizedOpacity: clamp(sd.opacityFullscreenMaximized?.value, 5, 100, 100),
            focusedOpacity: clamp(sd.opacityFocused?.value, 5, 100, 100),
            unfocusedOpacity: clamp(sd.opacityUnfocused?.value, 5, 100, 85),
            refreshIntervalMs: clamp(sd.opacityRefreshIntervalMs?.value, 100, 5000, 250),
            animateEnabled: !!sd.opacityAnimateEnabled?.value,
            animateDurationMs: clamp(sd.opacityAnimateDurationMs?.value, 0, 1000, 120),
            affectDialogs: !!sd.opacityAffectDialogs?.value,
            affectUtilityWindows: !!sd.opacityAffectUtilityWindows?.value,
        };
    }

    #connectSignals() {
        const c = (obj, sig, fn) => {
            try { this.#signals.connect(obj, sig, fn); } catch (e) {}
        };

        c(global.display, 'window-created', () => this.refreshSoon());
        c(global.display, 'notify::focus-window', () => this.refreshSoon());
        c(global.display, 'restacked', () => this.refreshSoon());
        c(global.display, 'monitors-changed', () => this.refreshSoon());

        c(global.window_manager, 'switch-workspace', () => this.refreshSoon());
        c(global.workspace_manager, 'active-workspace-changed', () => this.refreshSoon());

        c(global.screen, 'restacked', () => this.refreshSoon());
    }

    #stopTimer() {
        if (this.#timerId) {
            try { Mainloop.source_remove(this.#timerId); } catch (e) {}
            this.#timerId = 0;
        }
    }

    #restartTimer() {
        this.#stopTimer();
        const cfg = this.#cfg();
        this.#timerId = Mainloop.timeout_add(cfg.refreshIntervalMs, () => {
            this.refreshNow();
            return true;
        });
    }

    refreshSoon() {
        if (this.#refreshQueued) return;
        this.#refreshQueued = true;
        Mainloop.idle_add(() => {
            this.#refreshQueued = false;
            this.refreshNow();
            return false;
        });
    }

    refreshNow() {
        if (this.#refreshRunning) {
            this.#refreshAgain = true;
            return;
        }
        this.#refreshRunning = true;

        const cfg = this.#cfg();
        try {
            const actors = global.get_window_actors() || [];
            if (!actors.length) return;

            let focusedWindow = null;
            try { focusedWindow = global.display.focus_window; } catch (e) {}

            const activeWs = this.#ctx.getActiveWorkspaceIndex ? this.#ctx.getActiveWorkspaceIndex() : null;
            const seenKeys = new Set();

            for (const actor of actors) {
                this.#applyOpacityToActor(actor, focusedWindow, activeWs, cfg, seenKeys);
            }

            // prune stale keys for destroyed windows
            for (const k in this.#lastTargetByKey) {
                if (!seenKeys.has(k)) delete this.#lastTargetByKey[k];
            }
        } finally {
            this.#refreshRunning = false;
            if (this.#refreshAgain) {
                this.#refreshAgain = false;
                this.refreshSoon();
            }
        }
    }

    restoreAll() {
        const actors = global.get_window_actors() || [];
        for (const actor of actors) {
            try { actor.opacity = 255; }
            catch (e) {
                try { if (typeof actor.set_opacity === 'function') actor.set_opacity(255); } catch (_) {}
            }
        }
    }

    #applyOpacityToActor(actor, focusedWindow, activeWs, cfg, seenKeys) {
        if (!actor) return;

        let metaWindow = null;
        try { metaWindow = actor.meta_window; } catch (e) {}
        if (!metaWindow) return;

        const winKey = this.#windowKey(metaWindow);
        if (winKey) seenKeys.add(winKey);

        const wsIndex = this.#ctx.getWorkspaceIndexOfWindow ? this.#ctx.getWorkspaceIndexOfWindow(metaWindow) : null;
        if (!this.#shouldProcessWorkspace(metaWindow, wsIndex, activeWs)) return;

        if (winKey && this.#ctx.isWindowSideHiddenByKey && this.#ctx.isWindowSideHiddenByKey(winKey)) return;

        const wsOpacityEnabled = (wsIndex === null)
            ? true
            : !!(this.#ctx.isWorkspaceOpacityEnabled ? this.#ctx.isWorkspaceOpacityEnabled(wsIndex) : true);

        let target = 255;
        if (!cfg.enabled || !wsOpacityEnabled || !this.#shouldAffectWindow(metaWindow, cfg)) {
            target = 255;
        } else {
            const targetPercent = this.#pickOpacityForWindow(metaWindow, focusedWindow, cfg);
            target = this.#percentToOpacity(targetPercent);
        }

        this.#setActorOpacitySmart(actor, winKey, target, cfg);
    }

    #windowKey(metaWindow) {
        if (!metaWindow) return '';
        try {
            if (this.#ctx.getWindowKey) {
                const k = this.#ctx.getWindowKey(metaWindow);
                if (k !== null && k !== undefined) return String(k);
            }
        } catch (e) {}
        try {
            if (typeof metaWindow.get_stable_sequence === 'function') {
                const seq = Number(metaWindow.get_stable_sequence());
                if (Number.isFinite(seq) && seq > 0) return String(seq);
            }
        } catch (e) {}
        return '';
    }

    #shouldProcessWorkspace(metaWindow, wsIndex, activeWs) {
        if (activeWs === null || activeWs === undefined) return true;
        if (wsIndex === null || wsIndex === undefined) return true;
        if (wsIndex === activeWs) return true;

        // Skip off-workspace windows by default; this reduces churn/fighting when many windows exist.
        try { if (typeof metaWindow.is_on_all_workspaces === 'function') return !!metaWindow.is_on_all_workspaces(); } catch (e) {}
        return false;
    }

    #setActorOpacitySmart(actor, winKey, value, cfg) {
        const target = Math.max(0, Math.min(255, Math.floor(Number(value) || 255)));
        const key = String(winKey || '');
        const last = key ? this.#lastTargetByKey[key] : undefined;
        const cur = this.#getActorOpacity(actor);

        // Avoid reapplying identical targets on every refresh tick.
        if (last === target && Math.abs(cur - target) <= 2) return;

        const canAnimate =
            !!cfg.animateEnabled &&
            Number(cfg.animateDurationMs) > 0 &&
            Math.abs(cur - target) >= 3;

        let applied = false;
        if (canAnimate) applied = this.#setActorOpacityAnimated(actor, target, cfg.animateDurationMs);
        if (!applied) this.#setActorOpacity(actor, target);

        if (key) this.#lastTargetByKey[key] = target;
    }

    #getActorOpacity(actor) {
        try {
            const n = Number(actor.opacity);
            if (Number.isFinite(n)) return Math.max(0, Math.min(255, Math.floor(n)));
        } catch (e) {}
        return 255;
    }

    #setActorOpacityAnimated(actor, target, durationMs) {
        const dur = Math.max(0, Math.min(1000, Math.floor(Number(durationMs) || 0)));
        if (dur <= 0) return false;

        try {
            if (typeof actor.ease === 'function') {
                actor.ease({
                    opacity: target,
                    duration: dur,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
                return true;
            }
        } catch (e) {}

        try {
            if (typeof actor.set_easing_duration === 'function') actor.set_easing_duration(dur);
            if (typeof actor.set_easing_mode === 'function') actor.set_easing_mode(Clutter.AnimationMode.EASE_OUT_QUAD);
            actor.opacity = target;
            return true;
        } catch (e) {}

        return false;
    }

    #setActorOpacity(actor, value) {
        const v = Math.max(0, Math.min(255, Math.floor(Number(value) || 255)));
        try { if (typeof actor.remove_all_transitions === 'function') actor.remove_all_transitions(); } catch (e) {}
        try { actor.opacity = v; }
        catch (e) {
            try { if (typeof actor.set_opacity === 'function') actor.set_opacity(v); } catch (_) {}
        }
    }

    #shouldAffectWindow(metaWindow, cfg) {
        try { if (metaWindow.minimized) return false; } catch (e) {}

        let windowType = null;
        try { windowType = metaWindow.get_window_type(); } catch (e) { return false; }

        switch (windowType) {
            case Meta.WindowType.NORMAL:
                return true;
            case Meta.WindowType.DIALOG:
            case Meta.WindowType.MODAL_DIALOG:
                return !!cfg.affectDialogs;
            case Meta.WindowType.UTILITY:
                return !!cfg.affectUtilityWindows;
            default:
                return false;
        }
    }

    #pickOpacityForWindow(metaWindow, focusedWindow, cfg) {
        if (this.#isFullscreenOrFullyMaximized(metaWindow)) return cfg.fullscreenMaximizedOpacity;
        if (focusedWindow && metaWindow === focusedWindow) return cfg.focusedOpacity;
        return cfg.unfocusedOpacity;
    }

    #isFullscreenOrFullyMaximized(metaWindow) {
        try { if (metaWindow.fullscreen) return true; } catch (e) {}

        try {
            const flags = metaWindow.get_maximized();
            const horiz = (flags & Meta.MaximizeFlags.HORIZONTAL) !== 0;
            const vert = (flags & Meta.MaximizeFlags.VERTICAL) !== 0;
            return horiz && vert;
        } catch (e) {}
        return false;
    }

    #percentToOpacity(percent) {
        const p = Math.max(5, Math.min(100, Number(percent) || 100));
        return Math.round((p / 100) * 255);
    }
}

module.exports = { WindowOpacity };
/* window-opacity.js END */
