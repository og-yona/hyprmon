/* window-opacity.js */

const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const SignalManager = imports.misc.signalManager;

class WindowOpacity {
    #signals = new SignalManager.SignalManager(null);
    #ctx;

    #timerId = 0;
    #refreshQueued = false;

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
        const cfg = this.#cfg();
        const actors = global.get_window_actors() || [];
        if (!actors.length) return;

        let focusedWindow = null;
        try { focusedWindow = global.display.focus_window; } catch (e) {}

        for (const actor of actors) {
            this.#applyOpacityToActor(actor, focusedWindow, cfg);
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

    #applyOpacityToActor(actor, focusedWindow, cfg) {
        if (!actor) return;

        let metaWindow = null;
        try { metaWindow = actor.meta_window; } catch (e) {}
        if (!metaWindow) return;

        const wsIndex = this.#ctx.getWorkspaceIndexOfWindow ? this.#ctx.getWorkspaceIndexOfWindow(metaWindow) : null;
        const wsOpacityEnabled = (wsIndex === null)
            ? true
            : !!(this.#ctx.isWorkspaceOpacityEnabled ? this.#ctx.isWorkspaceOpacityEnabled(wsIndex) : true);

        if (!cfg.enabled || !wsOpacityEnabled || !this.#shouldAffectWindow(metaWindow, cfg)) {
            this.#setActorOpacity(actor, 255);
            return;
        }

        const targetPercent = this.#pickOpacityForWindow(metaWindow, focusedWindow, cfg);
        this.#setActorOpacity(actor, this.#percentToOpacity(targetPercent));
    }

    #setActorOpacity(actor, value) {
        const v = Math.max(0, Math.min(255, Math.floor(Number(value) || 255)));
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
