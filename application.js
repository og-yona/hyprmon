/* application.js
- The main script of the Extension
*/
const Clutter = imports.gi.Clutter;
const St = imports.gi.St;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const Settings = imports.ui.settings;
const SignalManager = imports.misc.signalManager;

const { getTilingWorkArea, listTilingCandidates, applyInnerGapsToRects, snapToRect, listAllMetaWindows } = require('./window-utils');
const { TilingStateIO } = require('./tiling-state-io');
const { reconcileBspTree, computeRectsFromBspTree, removeLeafByKey, insertKeyBySplittingLeaf, findKeyAtPoint, setSplitRatioAtPath, findSplitBetweenKeys, findNearestSplitForKey, swapLeavesByKey } = require('./bsp-tree');
const { findAdjacentKey, computeRatioFromWindowRect, clampRatioForParent } = require('./bsp-resize');
const { TileBorders } = require('./tile-borders');

// The application class is only constructed once and is the main entry
// of the extension.
class Application {
    
    #tilingStateIO;

    #signals = new SignalManager.SignalManager(null);

    #settings;
 
    // per-workspace tiling enable flags (wsIndex -> bool)
    #enabledWorkspaces = Object.create(null);
 
    // debounce timers per workspace (wsIndex -> sourceId)
    #retileTimers = Object.create(null);
 
    // tiling persistent state (v2 sideviews)
    // { version: 2, workspaces: {...}, windowFlags: { [winKey]: { floating?:bool, sticky?:bool } } }
    #tilingState = { version: 2, workspaces: Object.create(null), windowFlags: Object.create(null) };
    #saveStateTimer = 0;

    // last computed tile rects (used for drag-to-reorder target testing)
    // wsIndex -> mon -> { rectByKey: { [key]: rect }, keysInOrder: [key...] }
    #lastLayout = Object.create(null);

    // drag-to-reorder context (v0.3)
    #dragCtx = null;

    // resize-to-adjust-splits context (v0.4)
    #resizeCtx = null;
 
    // we attach per-window signals (unmanaged, workspace changes, monitor changes)
    // and keep a small guard so we don't double-track.
    #trackedSeq = new Set();

    // Stable per-window ids for builds where get_stable_sequence() is missing/0
    #winIdByMeta = new WeakMap();
    #nextWinId = 1;

    // When we apply tiling, windows emit size/position signals. Suppress those reflow triggers briefly.
    // key -> epochMs until suppressed
    #suppressGeomUntilByKey = Object.create(null);

    // Track windows currently being moved (mouse/keyboard grab) so we don't fight the live drag.
    #movingWindowKeys = new Set();
  
    // Track windows temporarily excluded from tiling (e.g. during move-grab for insert-on-drop).
    #floatingWindowKeys = new Set();

    // v0.64: user-floating windows (systemwide in-session flag; excluded from tiling everywhere)
    #userFloatingKeys = new Set();

    // v0.65: sticky windows (systemwide in-session flag; implies floating)
    #stickyKeys = new Set();

    // v0.68: stacking/always-on-top enforcement (best effort on X11/Muffin)
    // Track which windows hyprmon explicitly set "above", so we can undo safely.
    #hyprmonAboveKeys = new Set();
    #stackSyncTimer = 0;

    // v0.68: per-app forced floating rules
    #forcedFloatRules = []; // compiled [{ kind:'any'|'class'|'title', re:RegExp }]
 
    // Track windows currently being resized (grab). During live resize we drive our own relayout ticks.
    #resizingWindowKeys = new Set();

    // Retile bursts (startup / workspace switch) – token per workspace to avoid stacking bursts.
    #retileBurstToken = Object.create(null);
 
    // v0.61/v0.62: tile border overlays + optional animation
    #tileBorders = null;
 
    // v0.682: borders need their own lightweight refresh path (esp. for floating/sticky),
    // and a short suppression window during workspace switches to avoid drawing before windows appear.
    #borderRefreshTimer = 0;
    #borderSuppressUntil = 0;
    #borderSuppressTimer = 0;

    // v0.682: post-retile verification (fix "ignored resize" / half-screen survivors)
    #verifyTimerByWs = Object.create(null);
    #verifyTokenByWs = Object.create(null);
    #verifyLastRetileAtByWs = Object.create(null);

    // v0.62: opt-in geometry animation timers (key -> sourceId)
    #geomAnimByKey = Object.create(null);

    // lightweight in-extension notification HUD (overwrites previous message)
    #hudBox = null;
    #hudLabel = null;
    #hudTimer = 0;

    // v2 sideviews: remembered geometry before parking off-screen (key -> frameRect)
    #parkRestoreRectByKey = Object.create(null);
    // v2 sideviews: windows hidden by hyprmon because parking was clamped by WM
    #sideHiddenKeys = new Set();
    #sideHiddenModeByKey = Object.create(null); // key -> 'actor' | 'minimize'
    #sideFocusRedirectUntil = 0;
 
    // v0.63: remember last focused tile per workspace (and monitor) for "split active window"
    // wsIndex -> { key, monIndex, ts }
    #lastFocusByWs = Object.create(null);

    // v0.63: per-window creation hint captured at window-created time (key -> hint)
    #pendingNewWindowHintByKey = Object.create(null);

    // misc timers to cleanup on destroy
    #miscTimers = new Set();

    constructor(uuid) {
        this.#tilingStateIO = new TilingStateIO(uuid);
        this.#tilingState = this.#tilingStateIO.loadState() || { version: 2, workspaces: Object.create(null), windowFlags: Object.create(null) };
        if (!this.#tilingState.windowFlags || typeof this.#tilingState.windowFlags !== 'object')
            this.#tilingState.windowFlags = Object.create(null);

        this.#connectWindowGrabs();
        this.#connectTilingHooks();

        this.#settings = new Settings.ExtensionSettings(this, uuid);
        // v0.67
        for (const k of ['focusLeftHotkey','focusRightHotkey','focusUpHotkey','focusDownHotkey',
                         'swapLeftHotkey','swapRightHotkey','swapUpHotkey','swapDownHotkey',
                         'growLeftHotkey','growRightHotkey','growUpHotkey','growDownHotkey',
                         // v0.671
                         'shrinkLeftHotkey','shrinkRightHotkey','shrinkUpHotkey','shrinkDownHotkey',
                         'changeShapeLeftHotkey','changeShapeRightHotkey','changeShapeUpHotkey','changeShapeDownHotkey',
                         // v2 sideviews
                         'sideviewPrevHotkey','sideviewNextHotkey',
                         'moveWindowToPrevSideHotkey','moveWindowToNextSideHotkey']) {
            this.#settings.bindProperty(Settings.BindingDirection.IN, k, k, this.#enableTilingHotkeys);
        }

        // v0.66
        this.#settings.bindProperty(Settings.BindingDirection.IN, 'gapsToggleHotkey', 'gapsToggleHotkey', this.#enableTilingHotkeys);

        this.#settings.bindProperty(Settings.BindingDirection.IN, 'tilingToggleHotkey', 'tilingToggleHotkey', this.#enableTilingHotkeys);
        this.#settings.bindProperty(Settings.BindingDirection.IN, 'tilingRetileHotkey', 'tilingRetileHotkey', this.#enableTilingHotkeys);
        this.#settings.bindProperty(Settings.BindingDirection.IN, 'tilingResetHotkey', 'tilingResetHotkey', this.#enableTilingHotkeys);
        // v0.64/v0.65
        this.#settings.bindProperty(Settings.BindingDirection.IN, 'floatToggleHotkey', 'floatToggleHotkey', this.#enableTilingHotkeys);
        this.#settings.bindProperty(Settings.BindingDirection.IN, 'defloatAllHotkey', 'defloatAllHotkey', this.#enableTilingHotkeys);
        this.#settings.bindProperty(Settings.BindingDirection.IN, 'stickyToggleHotkey', 'stickyToggleHotkey', this.#enableTilingHotkeys);

        // v0.68: rules + safety clamps
        this.#settings.bindProperty(Settings.BindingDirection.IN, 'forceFloatingRules', 'forceFloatingRules', () => {
            this.#compileForcedFloatRules();
            this.#retileAllEnabledWorkspaces('forced-float-rules');
        });
        this.#settings.bindProperty(Settings.BindingDirection.IN, 'minTileSizePx', 'minTileSizePx', () => {
            const ws = this.#getActiveWorkspaceIndex();
            if (this.#isTilingEnabled(ws)) this.#scheduleRetileBurst(ws, 'min-tile-size');
        });

        // v0.61/v0.62: visuals settings -> refresh overlays immediately (best effort)
        const onVisualsChanged = () => {
            // Only update overlays on the active workspace to keep this lightweight.
            const ws = this.#getActiveWorkspaceIndex();
            this.#syncTileBorders(ws, 'settings-changed', false);
        };
        for (const k of [
            'tileBordersEnabled',
            'tileBorderActiveWidth', 'tileBorderInactiveWidth',
            'tileBorderActiveColor', 'tileBorderInactiveColor',
            'tileBorderRadius',
            'floatStickyBordersEnabled', 'floatBorderColor', 'stickyBorderColor',
            'overlayAnimate', 'overlayAnimateDurationMs',
            'geometryAnimate', 'geometryAnimateDurationMs',
        ]) {
            this.#settings.bindProperty(Settings.BindingDirection.IN, k, k, onVisualsChanged);
        }

        this.#applyDefaultWorkspaceEnable();
        this.#enableTilingHotkeys();
        this.#compileForcedFloatRules(); //v068
 
        this.#tileBorders = new TileBorders();
 
        // v0.64/v0.65: restore flags (best-effort; mainly for extension reload within session)
        this.#loadWindowFlagsFromState();
        this.#applyStickyFlagsToExistingWindows();
        this.#scheduleStackingSync('startup'); //v068

        // If the current workspace is configured enabled-by-default, enforce immediately.
        const wsIndex = this.#getActiveWorkspaceIndex();
        if (this.#isTilingEnabled(wsIndex)) {
            this.#scheduleRetileBurst(wsIndex, 'startup');
        }

        this.#scheduleStartupHealing();

        // Initial overlay state (hidden unless active ws is tiling-enabled + borders enabled).
        this.#syncTileBorders(wsIndex, 'startup', false);
    }

    destroy() {
        this.#disableTilingHotkeys();
        this.#signals.disconnectAllSignals();
        this.#signals = null;

        // cancel pending retiles
        for (const k in this.#retileTimers) {
            if (this.#retileTimers[k]) Mainloop.source_remove(this.#retileTimers[k]);
        }
        this.#retileTimers = Object.create(null);
 
        if (this.#saveStateTimer) {
            Mainloop.source_remove(this.#saveStateTimer);
            this.#saveStateTimer = 0;
        }

        for (const id of this.#miscTimers) {
            try { Mainloop.source_remove(id); } catch (e) {}
        }
        this.#miscTimers.clear();
 
        // v0.62: cancel any pending geometry animations
        try {
            for (const k in this.#geomAnimByKey) {
                const id = this.#geomAnimByKey[k];
                if (id) Mainloop.source_remove(id);
            }
        } catch (e) {}
        this.#geomAnimByKey = Object.create(null);

        try { if (this.#tileBorders) this.#tileBorders.destroy(); } catch (e) {}
        this.#tileBorders = null;

        if (this.#hudTimer) {
            try { Mainloop.source_remove(this.#hudTimer); } catch (e) {}
            this.#hudTimer = 0;
        }
        try {
            if (this.#hudBox) this.#hudBox.destroy();
        } catch (e) {}
        this.#hudBox = null;
        this.#hudLabel = null;
 
        // v0.682: cleanup border timers
        if (this.#borderRefreshTimer) {
            try { Mainloop.source_remove(this.#borderRefreshTimer); } catch (e) {}
            this.#borderRefreshTimer = 0;
        }
        if (this.#borderSuppressTimer) {
            try { Mainloop.source_remove(this.#borderSuppressTimer); } catch (e) {}
            this.#borderSuppressTimer = 0;
        }
        // v0.682: cleanup verify timers
        try {
            for (const k in this.#verifyTimerByWs) {
                const id = this.#verifyTimerByWs[k];
                if (id) Mainloop.source_remove(id);
            }
        } catch (e) {}
        this.#verifyTimerByWs = Object.create(null);

        // v0.68: undo "above" that hyprmon applied (best-effort cleanup)
        try {
            for (const w of listAllMetaWindows()) {
                if (!w || w.window_type !== Meta.WindowType.NORMAL) continue;
                const k = String(this.#windowKey(w));
                if (this.#hyprmonAboveKeys.has(k)) {
                    try { if (typeof w.unmake_above === 'function') w.unmake_above(); } catch (e) {}
                    try { if (typeof w.set_keep_above === 'function') w.set_keep_above(false); } catch (e) {}
                }
                // If we had sticky flags, also unstick when disabling the extension.
                if (this.#stickyKeys.has(k)) {
                    try { if (typeof w.unstick === 'function') w.unstick(); } catch (e) {}
                }
                // v2 sideviews: ensure we don't leave windows hidden on extension disable.
                if (this.#sideHiddenKeys.has(k)) {
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
            }
        } catch (e) {}
        this.#hyprmonAboveKeys.clear();
 
        // v0.63: clear hints
        this.#lastFocusByWs = Object.create(null);
        this.#pendingNewWindowHintByKey = Object.create(null);

        // v0.64/v0.65: clear flags (already persisted)
        try { this.#userFloatingKeys.clear(); } catch (e) {}
        try { this.#stickyKeys.clear(); } catch (e) {}
 
        if (this.#stackSyncTimer) { //v068
            try { Mainloop.source_remove(this.#stackSyncTimer); } catch (e) {}
            this.#stackSyncTimer = 0;
        }

        this.#saveTilingStateNow();

        this.#trackedSeq.clear();
        try { this.#floatingWindowKeys.clear(); } catch (e) {}
        try { this.#sideHiddenKeys.clear(); } catch (e) {}
        this.#sideHiddenModeByKey = Object.create(null);
    }
 
    #safeConnect(obj, signalName, cb) {
        try {
            this.#signals.connect(obj, signalName, cb);
            return true;
        } catch (e) {
            // keep logs low-noise; Cinnamon/Mutter builds differ in available signals
            return false;
        }
    }
 
    #disableTilingHotkeys() {
        Main.keybindingManager.removeHotKey('hyprmon-toggle-tiling');
        Main.keybindingManager.removeHotKey('hyprmon-tile-now');
        Main.keybindingManager.removeHotKey('hyprmon-reset-layout');
        // v0.64/v0.65
        Main.keybindingManager.removeHotKey('hyprmon-toggle-float');
        Main.keybindingManager.removeHotKey('hyprmon-defloat-all');
        Main.keybindingManager.removeHotKey('hyprmon-toggle-sticky');
        // v0.66
        Main.keybindingManager.removeHotKey('hyprmon-toggle-gaps');
        // v0.67
        Main.keybindingManager.removeHotKey('hyprmon-focus-left');
        Main.keybindingManager.removeHotKey('hyprmon-focus-right');
        Main.keybindingManager.removeHotKey('hyprmon-focus-up');
        Main.keybindingManager.removeHotKey('hyprmon-focus-down');
        Main.keybindingManager.removeHotKey('hyprmon-swap-left');
        Main.keybindingManager.removeHotKey('hyprmon-swap-right');
        Main.keybindingManager.removeHotKey('hyprmon-swap-up');
        Main.keybindingManager.removeHotKey('hyprmon-swap-down');
        Main.keybindingManager.removeHotKey('hyprmon-grow-left');
        Main.keybindingManager.removeHotKey('hyprmon-grow-right');
        Main.keybindingManager.removeHotKey('hyprmon-grow-up');
        Main.keybindingManager.removeHotKey('hyprmon-grow-down');
        // v0.671
        Main.keybindingManager.removeHotKey('hyprmon-shrink-left');
        Main.keybindingManager.removeHotKey('hyprmon-shrink-right');
        Main.keybindingManager.removeHotKey('hyprmon-shrink-up');
        Main.keybindingManager.removeHotKey('hyprmon-shrink-down');
        Main.keybindingManager.removeHotKey('hyprmon-change-shape-left');
        Main.keybindingManager.removeHotKey('hyprmon-change-shape-right');
        Main.keybindingManager.removeHotKey('hyprmon-change-shape-up');
        Main.keybindingManager.removeHotKey('hyprmon-change-shape-down');
        // v2 sideviews
        Main.keybindingManager.removeHotKey('hyprmon-side-prev');
        Main.keybindingManager.removeHotKey('hyprmon-side-next');
        Main.keybindingManager.removeHotKey('hyprmon-side-move-prev');
        Main.keybindingManager.removeHotKey('hyprmon-side-move-next');
    }

    #enableTilingHotkeys() {
        this.#disableTilingHotkeys();

        const gapsToggleBinding = (this.#settings.settingsData.gapsToggleHotkey?.value || '').trim();
        const toggleBinding = (this.#settings.settingsData.tilingToggleHotkey?.value || '').trim();
        const tileNowBinding = (this.#settings.settingsData.tilingRetileHotkey?.value || '').trim();
        const resetBinding = (this.#settings.settingsData.tilingResetHotkey?.value || '').trim();
        const floatBinding = (this.#settings.settingsData.floatToggleHotkey?.value || '').trim();
        const defloatAllBinding = (this.#settings.settingsData.defloatAllHotkey?.value || '').trim();
        const stickyBinding = (this.#settings.settingsData.stickyToggleHotkey?.value || '').trim();
        // v0.67 bindings
        const focusLeftBinding  = (this.#settings.settingsData.focusLeftHotkey?.value || '').trim();
        const focusRightBinding = (this.#settings.settingsData.focusRightHotkey?.value || '').trim();
        const focusUpBinding    = (this.#settings.settingsData.focusUpHotkey?.value || '').trim();
        const focusDownBinding  = (this.#settings.settingsData.focusDownHotkey?.value || '').trim();
        const swapLeftBinding   = (this.#settings.settingsData.swapLeftHotkey?.value || '').trim();
        const swapRightBinding  = (this.#settings.settingsData.swapRightHotkey?.value || '').trim();
        const swapUpBinding     = (this.#settings.settingsData.swapUpHotkey?.value || '').trim();
        const swapDownBinding   = (this.#settings.settingsData.swapDownHotkey?.value || '').trim();
        const growLeftBinding   = (this.#settings.settingsData.growLeftHotkey?.value || '').trim();
        const growRightBinding  = (this.#settings.settingsData.growRightHotkey?.value || '').trim();
        const growUpBinding     = (this.#settings.settingsData.growUpHotkey?.value || '').trim();
        const growDownBinding   = (this.#settings.settingsData.growDownHotkey?.value || '').trim();
        // v0.671 bindings
        const shrinkLeftBinding  = (this.#settings.settingsData.shrinkLeftHotkey?.value || '').trim();
        const shrinkRightBinding = (this.#settings.settingsData.shrinkRightHotkey?.value || '').trim();
        const shrinkUpBinding    = (this.#settings.settingsData.shrinkUpHotkey?.value || '').trim();
        const shrinkDownBinding  = (this.#settings.settingsData.shrinkDownHotkey?.value || '').trim();
        const shapeLeftBinding   = (this.#settings.settingsData.changeShapeLeftHotkey?.value || '').trim();
        const shapeRightBinding  = (this.#settings.settingsData.changeShapeRightHotkey?.value || '').trim();
        const shapeUpBinding     = (this.#settings.settingsData.changeShapeUpHotkey?.value || '').trim();
        const shapeDownBinding   = (this.#settings.settingsData.changeShapeDownHotkey?.value || '').trim();
        // v2 sideviews
        const sidePrevBinding = (this.#settings.settingsData.sideviewPrevHotkey?.value || '').trim();
        const sideNextBinding = (this.#settings.settingsData.sideviewNextHotkey?.value || '').trim();
        const sideMovePrevBinding = (this.#settings.settingsData.moveWindowToPrevSideHotkey?.value || '').trim();
        const sideMoveNextBinding = (this.#settings.settingsData.moveWindowToNextSideHotkey?.value || '').trim();

        if (gapsToggleBinding) {
            Main.keybindingManager.addHotKey(
                'hyprmon-toggle-gaps',
                gapsToggleBinding,
                this.#toggleGapsOnActiveWorkspace.bind(this)
            );
        }

        // v0.67 focus
        if (focusLeftBinding) Main.keybindingManager.addHotKey('hyprmon-focus-left', focusLeftBinding, () => this.#focusNeighborDir('W'));
        if (focusRightBinding) Main.keybindingManager.addHotKey('hyprmon-focus-right', focusRightBinding, () => this.#focusNeighborDir('E'));
        if (focusUpBinding) Main.keybindingManager.addHotKey('hyprmon-focus-up', focusUpBinding, () => this.#focusNeighborDir('N'));
        if (focusDownBinding) Main.keybindingManager.addHotKey('hyprmon-focus-down', focusDownBinding, () => this.#focusNeighborDir('S'));

        // v0.67 swap
        if (swapLeftBinding) Main.keybindingManager.addHotKey('hyprmon-swap-left', swapLeftBinding, () => this.#swapNeighborDir('W'));
        if (swapRightBinding) Main.keybindingManager.addHotKey('hyprmon-swap-right', swapRightBinding, () => this.#swapNeighborDir('E'));
        if (swapUpBinding) Main.keybindingManager.addHotKey('hyprmon-swap-up', swapUpBinding, () => this.#swapNeighborDir('N'));
        if (swapDownBinding) Main.keybindingManager.addHotKey('hyprmon-swap-down', swapDownBinding, () => this.#swapNeighborDir('S'));

        // v0.67 grow
        if (growLeftBinding) Main.keybindingManager.addHotKey('hyprmon-grow-left', growLeftBinding, () => this.#growActiveDir('W'));
        if (growRightBinding) Main.keybindingManager.addHotKey('hyprmon-grow-right', growRightBinding, () => this.#growActiveDir('E'));
        if (growUpBinding) Main.keybindingManager.addHotKey('hyprmon-grow-up', growUpBinding, () => this.#growActiveDir('N'));
        if (growDownBinding) Main.keybindingManager.addHotKey('hyprmon-grow-down', growDownBinding, () => this.#growActiveDir('S'));

        // v0.671 shrink (same path as grow, but inverted)
        if (shrinkLeftBinding) Main.keybindingManager.addHotKey('hyprmon-shrink-left', shrinkLeftBinding, () => this.#shrinkActiveDir('W'));
        if (shrinkRightBinding) Main.keybindingManager.addHotKey('hyprmon-shrink-right', shrinkRightBinding, () => this.#shrinkActiveDir('E'));
        if (shrinkUpBinding) Main.keybindingManager.addHotKey('hyprmon-shrink-up', shrinkUpBinding, () => this.#shrinkActiveDir('N'));
        if (shrinkDownBinding) Main.keybindingManager.addHotKey('hyprmon-shrink-down', shrinkDownBinding, () => this.#shrinkActiveDir('S'));

        // v0.671 change-shape (toggle split axis for a symmetric pair)
        if (shapeLeftBinding) Main.keybindingManager.addHotKey('hyprmon-change-shape-left', shapeLeftBinding, () => this.#changeShapeDir('W'));
        if (shapeRightBinding) Main.keybindingManager.addHotKey('hyprmon-change-shape-right', shapeRightBinding, () => this.#changeShapeDir('E'));
        if (shapeUpBinding) Main.keybindingManager.addHotKey('hyprmon-change-shape-up', shapeUpBinding, () => this.#changeShapeDir('N'));
        if (shapeDownBinding) Main.keybindingManager.addHotKey('hyprmon-change-shape-down', shapeDownBinding, () => this.#changeShapeDir('S'));

        // v2 sideviews
        if (sidePrevBinding) Main.keybindingManager.addHotKey('hyprmon-side-prev', sidePrevBinding, () => this.#switchActiveWorkspaceSide(-1));
        if (sideNextBinding) Main.keybindingManager.addHotKey('hyprmon-side-next', sideNextBinding, () => this.#switchActiveWorkspaceSide(1));
        if (sideMovePrevBinding) Main.keybindingManager.addHotKey('hyprmon-side-move-prev', sideMovePrevBinding, () => this.#moveFocusedWindowToSideDelta(-1));
        if (sideMoveNextBinding) Main.keybindingManager.addHotKey('hyprmon-side-move-next', sideMoveNextBinding, () => this.#moveFocusedWindowToSideDelta(1));

        if (toggleBinding) {
            Main.keybindingManager.addHotKey(
                'hyprmon-toggle-tiling',
                toggleBinding,
                this.#toggleTilingOnActiveWorkspace.bind(this)
            );
        }

        if (tileNowBinding) {
            Main.keybindingManager.addHotKey(
                'hyprmon-tile-now',
                tileNowBinding,
                this.#retileActiveWorkspace.bind(this)
            );
        }

        if (resetBinding) {
            Main.keybindingManager.addHotKey(
                'hyprmon-reset-layout',
                resetBinding,
                this.#resetLayoutOnActiveWorkspace.bind(this)
            );
        }

        if (floatBinding) {
            Main.keybindingManager.addHotKey(
                'hyprmon-toggle-float',
                floatBinding,
                this.#toggleFloatOnFocusedWindow.bind(this)
            );
        }

        if (defloatAllBinding) {
            Main.keybindingManager.addHotKey(
                'hyprmon-defloat-all',
                defloatAllBinding,
                this.#defloatAllWindows.bind(this)
            );
        }

        if (stickyBinding) {
            Main.keybindingManager.addHotKey(
                'hyprmon-toggle-sticky',
                stickyBinding,
                this.#toggleStickyOnFocusedWindow.bind(this)
            );
        }
    }

    #ensureHud() {
        if (this.#hudBox && this.#hudLabel) return;
        try {
            const box = new St.BoxLayout({
                vertical: false,
                reactive: false,
                visible: false
            });
            box.set_style(
                'padding: 8px 12px; ' +
                'border-radius: 10px; ' +
                'background-color: rgba(16,16,16,0.86);'
            );
            const label = new St.Label({
                text: '',
                y_align: Clutter.ActorAlign.CENTER
            });
            label.set_style('color: rgba(245,245,245,0.98); font-size: 11pt; font-weight: 600;');
            box.add_child(label);
            Main.uiGroup.add_child(box);
            this.#hudBox = box;
            this.#hudLabel = label;
        } catch (e) {
            this.#hudBox = null;
            this.#hudLabel = null;
        }
    }

    #positionHud() {
        if (!this.#hudBox) return;
        try {
            const cfg = this.#getHudConfig();
            let mon = global.display.get_primary_monitor();
            if (cfg.position === 'active-monitor') {
                const fw = this.#getFocusWindow();
                const m = this.#getMonitorIndexOfWindow(fw);
                if (m !== null && Number.isFinite(m)) mon = Number(m);
            }
            const r = global.display.get_monitor_geometry(mon);
            const w = this.#hudBox.get_width();
            const x = r.x + Math.floor((r.width - w) / 2);
            const y = (cfg.position === 'bottom-center')
                ? (r.y + r.height - 56 - this.#hudBox.get_height())
                : (r.y + 56);
            this.#hudBox.set_position(x, y);
        } catch (e) {}
    }

    #getHudConfig() {
        const sd = this.#settings?.settingsData || Object.create(null);
        const rawMs = Number(sd.hudNotifyTimeoutMs?.value ?? 900);
        const timeoutMs = Math.max(120, Math.min(5000, Math.floor(Number.isFinite(rawMs) ? rawMs : 900)));
        const rawPos = String(sd.hudNotifyPosition?.value || 'top-center').trim().toLowerCase();
        const position = (rawPos === 'bottom-center' || rawPos === 'active-monitor')
            ? rawPos
            : 'top-center';
        return { timeoutMs, position };
    }

    #notify(message) {
        const text = String(message || '').trim();
        if (!text) return;

        this.#ensureHud();
        if (this.#hudBox && this.#hudLabel) {
            try {
                this.#hudLabel.set_text(text);
                this.#hudBox.show();
                this.#hudBox.opacity = 255;
                this.#hudBox.queue_relayout();
                this.#positionHud();
                if (this.#hudTimer) {
                    Mainloop.source_remove(this.#hudTimer);
                    this.#hudTimer = 0;
                }
                const cfg = this.#getHudConfig();
                this.#hudTimer = Mainloop.timeout_add(cfg.timeoutMs, () => {
                    this.#hudTimer = 0;
                    try { if (this.#hudBox) this.#hudBox.hide(); } catch (e) {}
                    return false;
                });
                return;
            } catch (e) {}
        }

        // fallback if HUD creation fails
        try {
            if (Main.notify) {
                Main.notify('hyprmon', text);
                return;
            }
        } catch (e) {}
        global.log(`hyprmon: ${text}`);
    }

    #getActiveWorkspaceIndex() {
        const wm = global.workspace_manager;
        if (!wm) return 0;

        if (typeof wm.get_active_workspace_index === 'function') {
            return wm.get_active_workspace_index();
        }

        const ws = wm.get_active_workspace ? wm.get_active_workspace() : null;
        if (ws && typeof ws.index === 'function') {
            return ws.index();
        }

        return 0;
    }

    // ----- v0.68 forced-floating rules + "always on top" layering -----

    #compileForcedFloatRules() {
        const raw = String(this.#settings?.settingsData?.forceFloatingRules?.value || '');
        const out = [];

        const parts = raw
            .split(/\n|,/g)
            .map(s => String(s || '').trim())
            .filter(s => s.length > 0 && !s.startsWith('#'));

        for (const p of parts) {
            let kind = 'any';
            let pat = p;

            const m = p.match(/^(class|title)\s*:\s*(.+)$/i);
            if (m) {
                kind = String(m[1]).toLowerCase();
                pat = String(m[2] || '').trim();
            }
            if (!pat) continue;

            try {
                out.push({ kind, re: new RegExp(pat, 'i') });
            } catch (e) {
                // ignore invalid regex
            }
        }

        this.#forcedFloatRules = out;
    }

    #getMinTileSizePx() {
        const v = Number(this.#settings?.settingsData?.minTileSizePx?.value ?? 120);
        if (!Number.isFinite(v)) return 120;
        return Math.max(40, Math.floor(v));
    }

    #getWindowWmClass(metaWindow) {
        if (!metaWindow) return '';
        try { if (typeof metaWindow.get_wm_class === 'function') return String(metaWindow.get_wm_class() || ''); } catch (e) {}
        try { if (typeof metaWindow.get_wm_class_instance === 'function') return String(metaWindow.get_wm_class_instance() || ''); } catch (e) {}
        return '';
    }

    #getWindowTitle(metaWindow) {
        if (!metaWindow) return '';
        try { if (typeof metaWindow.get_title === 'function') return String(metaWindow.get_title() || ''); } catch (e) {}
        return '';
    }

    #isWindowAbove(metaWindow) {
        if (!metaWindow) return false;
        try { if (typeof metaWindow.is_above === 'function') return !!metaWindow.is_above(); } catch (e) {}
        try { if (typeof metaWindow.is_always_on_top === 'function') return !!metaWindow.is_always_on_top(); } catch (e) {}
        try { if (metaWindow.above !== undefined) return !!metaWindow.above; } catch (e) {}
        return false;
    }

    #setWindowAbove(metaWindow, wantAbove) {
        if (!metaWindow) return;
        const on = !!wantAbove;
        try {
            if (on) {
                if (typeof metaWindow.make_above === 'function') metaWindow.make_above();
                else if (typeof metaWindow.set_keep_above === 'function') metaWindow.set_keep_above(true);
            } else {
                if (typeof metaWindow.unmake_above === 'function') metaWindow.unmake_above();
                else if (typeof metaWindow.set_keep_above === 'function') metaWindow.set_keep_above(false);
            }
        } catch (e) {}
    }

    #raiseWindow(metaWindow) {
        if (!metaWindow) return false;
        try { if (typeof metaWindow.raise === 'function') { metaWindow.raise(); return true; } } catch (e) {}
        try {
            const actor = (typeof metaWindow.get_compositor_private === 'function') ? metaWindow.get_compositor_private() : null;
            if (actor && typeof actor.raise_top === 'function') { actor.raise_top(); return true; }
        } catch (e) {}
        return false;
    }

    // Forced-float = hyprmon will not include this window in tiling candidates.
    // Also used to "ignore pinned/always-on-top/special windows".
    #isForcedFloat(metaWindow) {
        if (!metaWindow || metaWindow.window_type !== Meta.WindowType.NORMAL) return false;

        const k = String(this.#windowKey(metaWindow));

        // hyprmon-managed floating/sticky are always excluded from tiling
        if (this.#userFloatingKeys.has(k) || this.#stickyKeys.has(k)) return true;

        // Ignore windows pinned above by the WM/user (always-on-top).
        // (We do NOT want to fight them with tiling.)
        const above = this.#isWindowAbove(metaWindow);
        if (above && !this.#hyprmonAboveKeys.has(k)) return true;

        // Ignore windows on all workspaces (special/sticky) that are not ours.
        try {
            if (typeof metaWindow.is_on_all_workspaces === 'function' && metaWindow.is_on_all_workspaces() && !this.#stickyKeys.has(k)) {
                return true;
            }
        } catch (e) {}

        // Regex rules
        const rules = this.#forcedFloatRules || [];
        if (!rules.length) return false;

        const cls = this.#getWindowWmClass(metaWindow);
        const title = this.#getWindowTitle(metaWindow);

        for (const r of rules) {
            if (!r || !r.re) continue;
            try {
                if (r.kind === 'class') { if (r.re.test(cls)) return true; }
                else if (r.kind === 'title') { if (r.re.test(title)) return true; }
                else { if (r.re.test(cls) || r.re.test(title)) return true; }
            } catch (e) {}
        }

        return false;
    }

    #listManagedTilingCandidates(wsIndex, monIndex) {
        let wins = listTilingCandidates(wsIndex, monIndex) || [];
        if (!wins.length) return wins;
        const activeSide = this.#getActiveSideIndex(wsIndex);
        return wins.filter(w => {
            if (this.#isForcedFloat(w)) return false;
            const k = String(this.#windowKey(w));
            return this.#getWindowSide(wsIndex, k) === activeSide;
        });
    }

    #retileAllEnabledWorkspaces(reason = '') {
        // Lightweight: only retile enabled workspaces (debounced). Avoid doing work for disabled ws.
        const enabledWs = Object.keys(this.#enabledWorkspaces)
            .map(k => parseInt(k, 10))
            .filter(n => Number.isFinite(n) && this.#enabledWorkspaces[n]);
        if (!enabledWs.length) return;
        for (const ws of enabledWs) this.#scheduleRetile(ws, reason || 'retile-all');
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

    #getParkingStride() {
        const b = this.#getGlobalMonitorBounds();
        return Math.max(b.maxWidth, b.width) + 1000;
    }

    #getParkingRectForWindow(metaWindow, sideIndex, activeSide) {
        if (!metaWindow) return null;
        const side = Math.max(0, Math.floor(Number(sideIndex) || 0));
        const active = Math.max(0, Math.floor(Number(activeSide) || 0));
        if (side === active) return null;

        let fr = null;
        try { fr = metaWindow.get_frame_rect(); } catch (e) {}
        if (!fr) fr = { x: 0, y: 0, width: 900, height: 700 };

        // IMPORTANT:
        // Muffin often clamps fully off-desktop coordinates back to a real monitor,
        // which caused windows to collapse/stack on primary. Keep a tiny sliver
        // on the window's *current monitor* so the WM keeps it logically there.
        let mon = null;
        try {
            const monIndex = (typeof metaWindow.get_monitor === 'function') ? metaWindow.get_monitor() : null;
            if (monIndex !== null && monIndex !== undefined) mon = global.display.get_monitor_geometry(monIndex);
        } catch (e) {}
        if (!mon) {
            const b = this.#getGlobalMonitorBounds();
            mon = { x: b.left, y: b.top, width: b.maxWidth, height: b.maxHeight };
        }

        const sliver = 8; // visible strip to avoid WM re-placement to primary monitor
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
        const k = String(this.#windowKey(metaWindow));
        if (this.#movingWindowKeys.has(k) || this.#resizingWindowKeys.has(k)) return false;
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
            this.#suppressWindowGeomSignals(metaWindow, 450);
            if (typeof metaWindow.move_frame === 'function') metaWindow.move_frame(false, r.x, r.y);
            else metaWindow.move_resize_frame(false, r.x, r.y, r.width, r.height);
            delete this.#parkRestoreRectByKey[k];
            return true;
        } catch (e) {}
        return false;
    }

    #parkWindowForSide(metaWindow, wsIndex, sideIndex, activeSide) {
        if (!metaWindow) return false;
        if (metaWindow.window_type !== Meta.WindowType.NORMAL) return false;
        if (this.#isSticky(metaWindow)) return false;

        const winWs = this.#getWorkspaceIndexOfWindow(metaWindow);
        if (winWs === null || winWs !== wsIndex) return false;

        const side = Math.max(0, Math.floor(Number(sideIndex) || 0));
        const active = Math.max(0, Math.floor(Number(activeSide) || 0));
        if (side === active) return this.#restoreWindowFromParking(metaWindow);

        const pr = this.#getParkingRectForWindow(metaWindow, side, active);
        if (!pr) return false;

        const k = String(this.#windowKey(metaWindow));
        if (this.#movingWindowKeys.has(k) || this.#resizingWindowKeys.has(k)) return false;
        if (!this.#parkRestoreRectByKey[k]) {
            try {
                const fr = metaWindow.get_frame_rect();
                this.#parkRestoreRectByKey[k] = { x: fr.x, y: fr.y, width: fr.width, height: fr.height };
            } catch (e) {}
        }

        try {
            this.#suppressWindowGeomSignals(metaWindow, 450);
            if (typeof metaWindow.move_frame === 'function') metaWindow.move_frame(false, pr.x, pr.y);
            else metaWindow.move_resize_frame(false, pr.x, pr.y, pr.width, pr.height);

            // If WM clamps back on-screen, force-hide via minimize as fallback.
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
                // Prefer compositor-actor hide to avoid taskbar-style minimize animation.
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

    #parkInactiveSideWindows(wsIndex) {
        const activeSide = this.#getActiveSideIndex(wsIndex);
        for (const w of listAllMetaWindows()) {
            if (!w || w.window_type !== Meta.WindowType.NORMAL) continue;
            if (this.#getWorkspaceIndexOfWindow(w) !== wsIndex) continue;
            if (this.#isSticky(w)) continue;
            const k = String(this.#windowKey(w));
            const side = this.#getWindowSide(wsIndex, k);
            this.#parkWindowForSide(w, wsIndex, side, activeSide);
        }
    }

    #restoreActiveSideWindows(wsIndex) {
        const activeSide = this.#getActiveSideIndex(wsIndex);
        for (const w of listAllMetaWindows()) {
            if (!w || w.window_type !== Meta.WindowType.NORMAL) continue;
            if (this.#getWorkspaceIndexOfWindow(w) !== wsIndex) continue;
            const k = String(this.#windowKey(w));
            if (this.#getWindowSide(wsIndex, k) !== activeSide) continue;
            this.#restoreWindowFromParking(w);
        }
    }

    #switchActiveWorkspaceSide(delta) {
        const wsIndex = this.#getActiveWorkspaceIndex();
        const oldSide = this.#getActiveSideIndex(wsIndex);
        const rawNext = oldSide + Math.floor(Number(delta) || 0);
        const nextSide = Math.max(0, rawNext);
        if (nextSide === oldSide) return;

        this.#setActiveSideIndex(wsIndex, nextSide);
        this.#restoreActiveSideWindows(wsIndex);
        this.#parkInactiveSideWindows(wsIndex);

        const wsKey = String(wsIndex);
        if (this.#lastLayout[wsKey]) delete this.#lastLayout[wsKey];

        if (this.#isTilingEnabled(wsIndex)) {
            this.#scheduleRetileBurst(wsIndex, 'side-switch');
        } else {
            this.#syncTileBorders(wsIndex, 'side-switch-disabled', false);
        }
        this.#notify(`Workspace ${wsIndex + 1}: side ${nextSide + 1}`);
    }

    #moveFocusedWindowToSideDelta(delta) {
        const w = this.#getFocusWindow();
        if (!w || w.window_type !== Meta.WindowType.NORMAL) return;
        if (this.#isSticky(w)) return;

        const wsIndex = this.#getWorkspaceIndexOfWindow(w);
        const monIndex = this.#getMonitorIndexOfWindow(w);
        if (wsIndex === null || monIndex === null) return;

        const k = String(this.#windowKey(w));
        const fromSide = this.#getWindowSide(wsIndex, k);
        const toSide = Math.max(0, fromSide + Math.floor(Number(delta) || 0));
        if (toSide === fromSide) return;

        const beforeTree = this.#getBspTree(wsIndex, monIndex, fromSide);
        const rem = removeLeafByKey(beforeTree, k);
        if (rem.changed) this.#setBspTree(wsIndex, monIndex, rem.tree, fromSide);

        this.#setWindowSide(wsIndex, k, toSide);
        const activeSide = this.#getActiveSideIndex(wsIndex);
        if (toSide === activeSide) {
            if (this.#isTilingEnabled(wsIndex)) {
                Mainloop.idle_add(() => { this.#insertWindowIntoLayout(w, 'side-move-visible', true); return false; });
            } else {
                this.#restoreWindowFromParking(w);
            }
        } else {
            this.#parkWindowForSide(w, wsIndex, toSide, activeSide);
            if (this.#isTilingEnabled(wsIndex)) this.#retileAfterDrag(wsIndex, 'side-move-hidden');
            this.#syncTileBorders(wsIndex, 'side-move-hidden', false);
        }

        this.#notify(`Window moved to side ${toSide + 1}`);
    }

    #redirectFocusToWindowSideIfNeeded(metaWindow) {
        if (!metaWindow || metaWindow.window_type !== Meta.WindowType.NORMAL) return false;

        const wsIndex = this.#getWorkspaceIndexOfWindow(metaWindow);
        if (wsIndex === null) return false;
        if (wsIndex !== this.#getActiveWorkspaceIndex()) return false;

        const k = String(this.#windowKey(metaWindow));
        const targetSide = this.#getWindowSide(wsIndex, k);
        const activeSide = this.#getActiveSideIndex(wsIndex);
        if (targetSide === activeSide) return false;

        const now = Date.now();
        if (now < (this.#sideFocusRedirectUntil || 0)) return false;
        this.#sideFocusRedirectUntil = now + 450;

        this.#setActiveSideIndex(wsIndex, targetSide);
        this.#restoreActiveSideWindows(wsIndex);
        this.#parkInactiveSideWindows(wsIndex);

        const wsKey = String(wsIndex);
        if (this.#lastLayout[wsKey]) delete this.#lastLayout[wsKey];

        if (this.#isTilingEnabled(wsIndex)) this.#scheduleRetileBurst(wsIndex, 'focus-side-redirect');
        else this.#syncTileBorders(wsIndex, 'focus-side-redirect', false);

        this.#notify(`Workspace ${wsIndex + 1}: side ${targetSide + 1}`);
        return true;
    }

    // Compute whether a given tree would violate minimum tile sizes.
    #treeRespectsMinSize(tree, workArea, innerGap, minPx) {
        if (!tree || !workArea) return true;
        const min = Math.max(20, Math.floor(Number(minPx) || 120));
        const rr = computeRectsFromBspTree(tree, workArea);
        const rects = rr.rectsInOrder || [];
        if (!rects.length) return true;
        const gapped = applyInnerGapsToRects(rects, workArea, innerGap);
        for (const r of gapped) {
            if (!r) continue;
            if (r.width < min || r.height < min) return false;
        }
        return true;
    }

    // Keep layering consistent:
    // - all hyprmon-floating windows are "above" normal tiled windows
    // - hyprmon-sticky windows are above hyprmon-floating windows
    // We enforce this deterministically to avoid "sticky windows fighting".
    #scheduleStackingSync(reason = '') {
        // Only bother if we have any managed floating/sticky OR any "above" state to undo.
        // (Important: un-floating the LAST floating window must still clear keep-above.)
        if ((this.#userFloatingKeys.size + this.#stickyKeys.size + this.#hyprmonAboveKeys.size) === 0) return;

        if (this.#stackSyncTimer) {
            try { Mainloop.source_remove(this.#stackSyncTimer); } catch (e) {}
            this.#stackSyncTimer = 0;
        }

        this.#stackSyncTimer = Mainloop.timeout_add(80, () => {
            this.#stackSyncTimer = 0;
            this.#syncStackingNow(reason);
            return false;
        });
    }

    #syncStackingNow(reason = '') {
        const wins = listAllMetaWindows().filter(w => w && w.window_type === Meta.WindowType.NORMAL);
        if (!wins.length) return;

        // Deterministic ordering to avoid "fighting"
        wins.sort((a, b) => this.#windowSortKey(a) - this.#windowSortKey(b));

        // 1) Ensure above flags match hyprmon state; undo only what hyprmon set.
        for (const w of wins) {
            const k = String(this.#windowKey(w));
            const wantAbove = this.#userFloatingKeys.has(k) || this.#stickyKeys.has(k);

            if (wantAbove) {
                this.#setWindowAbove(w, true);
                this.#hyprmonAboveKeys.add(k);
            } else if (this.#hyprmonAboveKeys.has(k)) {
                // Only undo if hyprmon previously set it.
                this.#setWindowAbove(w, false);
                this.#hyprmonAboveKeys.delete(k);
            }

            // Sticky should remain stuck (best-effort) and above.
            if (this.#stickyKeys.has(k)) {
                try { if (typeof w.stick === 'function') w.stick(); } catch (e) {}
            }
        }

        // 2) Order within "above" windows: float first, sticky last (so sticky is always topmost).
        const floats = wins.filter(w => {
            const k = String(this.#windowKey(w));
            return this.#userFloatingKeys.has(k) && !this.#stickyKeys.has(k);
        });
        const stickies = wins.filter(w => {
            const k = String(this.#windowKey(w));
            return this.#stickyKeys.has(k);
        });

        for (const w of floats) this.#raiseWindow(w);
        for (const w of stickies) this.#raiseWindow(w);
    }
 
    // ----- v0.64/v0.65 floating + sticky flags -----

    #loadWindowFlagsFromState() {
        try {
            const wf = this.#tilingState.windowFlags || Object.create(null);
            for (const k in wf) {
                const v = wf[k];
                if (!v || typeof v !== 'object') continue;
                const key = String(k);
                const isSticky = !!v.sticky;
                const isFloat = !!v.floating || isSticky;
                if (isFloat) this.#userFloatingKeys.add(key);
                if (isSticky) this.#stickyKeys.add(key);
            }
        } catch (e) {}
    }

    #setWindowFlags(key, floating, sticky) {
        const k = String(key || '');
        if (!k) return;

        const isSticky = !!sticky;
        const isFloat = !!floating || isSticky;

        if (isFloat) this.#userFloatingKeys.add(k);
        else this.#userFloatingKeys.delete(k);

        if (isSticky) this.#stickyKeys.add(k);
        else this.#stickyKeys.delete(k);

        if (!this.#tilingState.windowFlags || typeof this.#tilingState.windowFlags !== 'object')
            this.#tilingState.windowFlags = Object.create(null);

        if (!isFloat && !isSticky) {
            delete this.#tilingState.windowFlags[k];
        } else {
            this.#tilingState.windowFlags[k] = { floating: isFloat, sticky: isSticky };
        }

        this.#scheduleSaveTilingState('window-flags');
    }

    #isUserFloating(metaWindow) {
        if (!metaWindow) return false;
        const k = this.#windowKey(metaWindow);
        return this.#userFloatingKeys.has(String(k));
    }

    #isSticky(metaWindow) {
        if (!metaWindow) return false;
        const k = this.#windowKey(metaWindow);
        return this.#stickyKeys.has(String(k));
    }

    #applyStickyFlagsToExistingWindows() {
        // Best-effort: if state says sticky, enforce MetaWindow.stick().
        // (Primarily useful on extension reloads; no attempt is made to persist across full sessions.)
        try {
            for (const w of listAllMetaWindows()) {
                if (!w || w.window_type !== Meta.WindowType.NORMAL) continue;
                const k = this.#windowKey(w);
                if (!this.#stickyKeys.has(String(k))) continue;
                try { if (typeof w.stick === 'function') w.stick(); } catch (e) {}
                try { this.#setWindowAbove(w, true); this.#hyprmonAboveKeys.add(String(k)); } catch (e) {}
            }
        } catch (e) {}
    }

    #removeFromTreeIfPresent(metaWindow, wsIndex, monIndex) {
        if (!metaWindow) return false;
        if (wsIndex === null || monIndex === null) return false;
        if (!this.#isTilingEnabled(wsIndex)) return false;

        const k = this.#windowKey(metaWindow);
        const sideIndex = this.#getWindowSide(wsIndex, k);
        const beforeTree = this.#getBspTree(wsIndex, monIndex, sideIndex);
        const rem = removeLeafByKey(beforeTree, k);
        if (rem.changed) this.#setBspTree(wsIndex, monIndex, rem.tree, sideIndex);
        return rem.changed;
    }

    // Insert a (previously-floating) window into the BSP like a drop:
    // - base tree = current tiled windows (excluding all floating keys and excluding myKey)
    // - choose target tile by overlap / center (forgive pointer)
    // - split target leaf and insert myKey
    // Returns { wsIndex, monIndex, inserted }.
    #insertWindowIntoLayout(metaWindow, reason = '', scheduleRetile = true) {
        if (!metaWindow) return { wsIndex: null, monIndex: null, inserted: false };

        const wsIndex = this.#getWorkspaceIndexOfWindow(metaWindow);
        const monIndex = this.#getMonitorIndexOfWindow(metaWindow);
        if (wsIndex === null || monIndex === null) return { wsIndex, monIndex, inserted: false };
        if (!this.#isTilingEnabled(wsIndex)) return { wsIndex, monIndex, inserted: false };

        const myKey = String(this.#windowKey(metaWindow));
        const activeSide = this.#getActiveSideIndex(wsIndex);
        this.#setWindowSide(wsIndex, myKey, activeSide);

        const eg = this.#effectiveGapsForWorkspace(wsIndex);
        const outerGap = eg.outerGap;
        const innerGap = eg.innerGap;
        const workArea = this.#getTilingWorkAreaWithExtras(monIndex, outerGap);
        if (!workArea) return { wsIndex, monIndex, inserted: false };

        // Build "base" tiled list: exclude any floating windows (temp or user) and exclude myKey itself.
        let wins = this.#listManagedTilingCandidates(wsIndex, monIndex) || [];

        // Ensure my window is not accidentally in the base list.
        wins = wins.filter(w => String(this.#windowKey(w)) !== myKey);

        // Exclude all current floating windows (temp + user flags).
        wins = wins.filter(w => {
            const k = String(this.#windowKey(w));
            if (this.#floatingWindowKeys.has(k)) return false;
            if (this.#userFloatingKeys.has(k)) return false;
            return true;
        });

        wins.sort((a, b) => this.#windowSortKey(a) - this.#windowSortKey(b));
        const baseKeys = wins.map(w => String(this.#windowKey(w)));

        // Reconcile base tree.
        let baseTree = this.#getBspTree(wsIndex, monIndex);
        const rec = reconcileBspTree(baseTree, baseKeys, workArea);
        baseTree = rec.tree;
        if (rec.changed) this.#setBspTree(wsIndex, monIndex, baseTree);

        // Build hit rects from base tree (gapped).
        let hitRects = Object.create(null);
        let keysInOrder = [];
        if (baseTree) {
            const rr = computeRectsFromBspTree(baseTree, workArea);
            keysInOrder = rr.keysInOrder || [];
            const gappedRects = applyInnerGapsToRects(rr.rectsInOrder || [], workArea, innerGap);
            for (let i = 0; i < keysInOrder.length; i++) {
                hitRects[String(keysInOrder[i])] = gappedRects[i];
            }
        }

        // Decide target + split based on window geometry (center/overlap) and pointer as hint.
        let fr = null;
        try { fr = metaWindow.get_frame_rect(); } catch (e) {}
        if (!fr) return { wsIndex, monIndex, inserted: false };

        const cx = fr.x + fr.width / 2;
        const cy = fr.y + fr.height / 2;
        const [px0, py0] = global.get_pointer();

        // Use pointer if it is inside the workArea; otherwise fall back to window center.
        const inWorkArea =
            Number.isFinite(px0) && Number.isFinite(py0) &&
            px0 >= workArea.x && px0 <= (workArea.x + workArea.width) &&
            py0 >= workArea.y && py0 <= (workArea.y + workArea.height);
        const px = inWorkArea ? px0 : cx;
        const py = inWorkArea ? py0 : cy;

        const targetKey = this.#pickTargetKey(hitRects, px, py, fr);
        let chosenTarget = targetKey;
        if (!chosenTarget && keysInOrder.length) chosenTarget = keysInOrder[0];

        let insertedTree = baseTree;
        if (!chosenTarget) {
            insertedTree = { type: 'leaf', win: myKey };
        } else {
            const tr = hitRects[String(chosenTarget)] || null;
            const { axis, side } = this.#chooseSplitFromPoint(tr, px, py);
            const ins = insertKeyBySplittingLeaf(insertedTree, chosenTarget, myKey, axis, 0.5, side);
            insertedTree = ins.tree;

            if (!ins.inserted) {
                const leaf = { type: 'leaf', win: myKey };
                const ax = (axis === 'y') ? 'y' : 'x';
                const putFirst =
                    (ax === 'x' && side === 'left') ||
                    (ax === 'y' && side === 'top');
                insertedTree = putFirst
                    ? { type: 'split', axis: ax, ratio: 0.5, a: leaf, b: insertedTree }
                    : { type: 'split', axis: ax, ratio: 0.5, a: insertedTree, b: leaf };
            }
        }

        this.#setBspTree(wsIndex, monIndex, insertedTree);

        if (scheduleRetile) this.#retileAfterDrag(wsIndex, reason ? `${reason}-insert` : 'insert');
        return { wsIndex, monIndex, inserted: true };
    }

    #toggleFloatOnFocusedWindow() {
        const w = this.#getFocusWindow();
        if (!w || w.window_type !== Meta.WindowType.NORMAL) {
            this.#notify('No focused normal window to float');
            return;
        }

        const k = String(this.#windowKey(w));
        const ws = this.#getWorkspaceIndexOfWindow(w);
        const mon = this.#getMonitorIndexOfWindow(w);

        const isSticky = this.#stickyKeys.has(k);
        const isFloat = this.#userFloatingKeys.has(k);

        // Only block when trying to ENABLE floating on a currently non-floating window.
        // (We must still allow un-float / un-sticky even though #isForcedFloat() returns true for them.)
        if (!isSticky && !isFloat && this.#isForcedFloat(w)) { this.#notify('Window is force-floated/ignored by rules'); return; } 

        // If it's sticky, "toggle float" behaves as: unstick + unfloat (matches your spec for defloat-all too).
        if (isSticky) {
            this.#setWindowFlags(k, false, false);
            try { if (typeof w.unstick === 'function') w.unstick(); } catch (e) {}
            // Ensure it remains on the current workspace after unstick (best-effort).
            try {
                const wm = global.workspace_manager;
                const aws = wm && wm.get_active_workspace ? wm.get_active_workspace() : null;
                if (aws && typeof w.change_workspace === 'function') w.change_workspace(aws);
            } catch (e) {}

            // Insert back if tiling enabled.
            Mainloop.idle_add(() => { this.#insertWindowIntoLayout(w, 'unsticky', true); return false; });
            this.#notify('Window: sticky+floating DISABLED');
            this.#scheduleStackingSync('unsticky');
            return;
        }

        if (!isFloat) {
            // Enable floating: remove from tree if it was tiled, then close gap.
            this.#setWindowFlags(k, true, false);
            if (ws !== null && mon !== null) {
                const changed = this.#removeFromTreeIfPresent(w, ws, mon);
                if (changed) this.#retileAfterDrag(ws, 'float-on');
            }
            this.#notify('Window: floating ENABLED');
            this.#scheduleStackingSync('float-on');
            return;
        }

        // Disable floating: insert into BSP like a drop if tiling enabled.
        this.#setWindowFlags(k, false, false);
        Mainloop.idle_add(() => { this.#insertWindowIntoLayout(w, 'float-off', true); return false; });
        this.#notify('Window: floating DISABLED');
        this.#scheduleStackingSync('float-off');
    }

    #toggleStickyOnFocusedWindow() {
        const w = this.#getFocusWindow();
        if (!w || w.window_type !== Meta.WindowType.NORMAL) {
            this.#notify('No focused normal window to sticky');
            return;
        }

        const k = String(this.#windowKey(w));
        const ws = this.#getWorkspaceIndexOfWindow(w);
        const mon = this.#getMonitorIndexOfWindow(w);

        const isSticky = this.#stickyKeys.has(k);

        // Only block when trying to ENABLE sticky on a currently non-sticky window.
        // (We must still allow un-sticky even though #isForcedFloat() returns true for it.)
        if (!isSticky && this.#isForcedFloat(w)) { this.#notify('Window is force-floated/ignored by rules'); return; }

        if (!isSticky) {
            // Enable sticky => also floating.
            this.#setWindowFlags(k, true, true);
            try { if (typeof w.stick === 'function') w.stick(); } catch (e) {}
            try { this.#setWindowAbove(w, true); this.#hyprmonAboveKeys.add(String(k)); } catch (e) {}
            this.#scheduleStackingSync('sticky-on');

            // Remove from tiling if it was tiled, then close gap.
            if (ws !== null && mon !== null) {
                const changed = this.#removeFromTreeIfPresent(w, ws, mon);
                if (changed) this.#retileAfterDrag(ws, 'sticky-on');
            }
            this.#notify('Window: sticky (and floating) ENABLED');
            return;
        }

        // Disable sticky => also unfloat; then insert back if tiling enabled.
        this.#setWindowFlags(k, false, false);
        try { if (typeof w.unstick === 'function') w.unstick(); } catch (e) {}
        this.#scheduleStackingSync('sticky-off');
        try {
            const wm = global.workspace_manager;
            const aws = wm && wm.get_active_workspace ? wm.get_active_workspace() : null;
            if (aws && typeof w.change_workspace === 'function') w.change_workspace(aws);
        } catch (e) {}

        Mainloop.idle_add(() => { this.#insertWindowIntoLayout(w, 'sticky-off', true); return false; });
        this.#notify('Window: sticky+floating DISABLED');
    }

    #defloatAllWindows() {
        const affectedWs = new Set();
        const activeWs = this.#getActiveWorkspaceIndex();

        // Snapshot windows so we can operate deterministically.
        const wins = listAllMetaWindows().filter(w => w && w.window_type === Meta.WindowType.NORMAL);

        for (const w of wins) {
            const k = String(this.#windowKey(w));
            if (!this.#userFloatingKeys.has(k)) continue;

            const wasSticky = this.#stickyKeys.has(k);

            // Clear flags first (so it becomes eligible for insertion).
            this.#setWindowFlags(k, false, false);

            // If it was sticky, unstick and force to active workspace (best-effort),
            // so "defloat all" drops it where the user currently is (matches your v0.65 intent).
            if (wasSticky) {
                try { if (typeof w.unstick === 'function') w.unstick(); } catch (e) {}
                try {
                    const wm = global.workspace_manager;
                    const aws = wm && wm.get_active_workspace ? wm.get_active_workspace() : null;
                    if (aws && typeof w.change_workspace === 'function') w.change_workspace(aws);
                } catch (e) {}
            }

            // Insert into layout if tiling is enabled on the destination workspace.
            // For sticky windows, destination = active workspace. Otherwise, use its current ws.
            const ws = wasSticky ? activeWs : this.#getWorkspaceIndexOfWindow(w);
            if (ws !== null && this.#isTilingEnabled(ws)) {
                // Insert updates the BSP immediately; we retile once per affected ws at the end.
                const r = this.#insertWindowIntoLayout(w, 'defloat-all', false);
                if (r.wsIndex !== null) affectedWs.add(String(r.wsIndex));
            }
        }

        for (const wsKey of affectedWs) {
            const ws = parseInt(wsKey, 10);
            if (Number.isFinite(ws)) this.#retileAfterDrag(ws, 'defloat-all');
        }

        this.#notify('All floating/sticky windows: cleared');
        this.#scheduleStackingSync('defloat-all');
    }
 
    // ----- v0.63 new windows: split active tile, or pointer-placement when modifier held -----

    #getPointerWithMods() {
        try {
            const p = global.get_pointer ? global.get_pointer() : [0, 0, 0];
            const x = Number(p[0]);
            const y = Number(p[1]);
            const mods = (p && p.length >= 3) ? (Number(p[2]) || 0) : 0;
            return { x, y, mods };
        } catch (e) {}
        return { x: 0, y: 0, mods: 0 };
    }

    #maskForModifierName(name) {
        const s = String(name || '').trim().toLowerCase();
        if (!s) return 0;
        if (s === 'shift') return Clutter.ModifierType.SHIFT_MASK;
        if (s === 'ctrl' || s === 'control' || s === 'ctl') return Clutter.ModifierType.CONTROL_MASK;
        if (s === 'alt' || s === 'mod1') return Clutter.ModifierType.MOD1_MASK;
        if (s === 'super' || s === 'mod4' || s === 'meta' || s === 'win' || s === 'windows') return Clutter.ModifierType.MOD4_MASK;
        return 0;
    }

    #isNewWindowPointerMode(hint) {
        const modName = (this.#settings?.settingsData?.newWindowPointerModifier?.value || '').trim();
        if (!modName) return false;
        const mask = this.#maskForModifierName(modName);
        if (!mask) return false;
        const mods = Number(hint?.mods || 0) || 0;
        return (mods & mask) !== 0;
    }

    // Called for each missing window during reconcile (v0.63).
    // Returns insertion spec { targetKey, axis, ratio, side } or null to fall back to "largest leaf".
    #chooseInsertionForNewKey(wsIndex, monIndex, nextTree, workArea, innerGap, newKey) {
        const activeWs = this.#getActiveWorkspaceIndex();
        const isActiveWorkspace = (wsIndex === activeWs);
        const nk = String(newKey);

        // Pull (and possibly consume) the creation hint for this window.
        const hint = this.#pendingNewWindowHintByKey[nk] || null;
        const now = Date.now();
        if (hint && hint.ts && (now - hint.ts) > 2000) {
            delete this.#pendingNewWindowHintByKey[nk];
        }

        // If there is no existing layout to split, let fallback handle it (it will create a single leaf).
        if (!nextTree) return null;

        // Compute current leaf rects once (for membership + axis choice).
        const rr = computeRectsFromBspTree(nextTree, workArea);
        const keysInOrder = rr.keysInOrder || [];
        const rectByKeyUngapped = rr.rectByKey || Object.create(null);
        if (!keysInOrder.length) return null;

        // --- 1) Pointer placement (only on ACTIVE workspace) ---
        if (isActiveWorkspace && hint && this.#isNewWindowPointerMode(hint)) {
            const px = Number(hint.px);
            const py = Number(hint.py);

            // Build gapped rects (what user sees), then hit-test at pointer.
            const gappedRects = applyInnerGapsToRects(rr.rectsInOrder || [], workArea, innerGap);
            const hitRects = Object.create(null);
            for (let i = 0; i < keysInOrder.length; i++) hitRects[String(keysInOrder[i])] = gappedRects[i];

            const inWorkArea =
                Number.isFinite(px) && Number.isFinite(py) &&
                px >= workArea.x && px <= (workArea.x + workArea.width) &&
                py >= workArea.y && py <= (workArea.y + workArea.height);

            if (inWorkArea) {
                const targetKey = findKeyAtPoint(hitRects, px, py);
                if (targetKey && hitRects[String(targetKey)]) {
                    const tr = hitRects[String(targetKey)];
                    const { axis, side } = this.#chooseSplitFromPoint(tr, px, py);
                    delete this.#pendingNewWindowHintByKey[nk];
                    return { targetKey: String(targetKey), axis, ratio: 0.5, side };
                }
            }

            // pointer mode requested but couldn't find a tile; fall through to active-split
        }

        // --- 2) Split active tile (focused tile at creation time if available) ---
        // Only makes sense on ACTIVE workspace; otherwise keep legacy behavior (largest leaf).
        if (!isActiveWorkspace) {
            if (hint) delete this.#pendingNewWindowHintByKey[nk];
            return null;
        }

        // Prefer the focus key captured at creation time (prevents "new window already focused" feedback).
        let focusKey = hint?.focusKey ? String(hint.focusKey) : null;
        let focusMon = (hint && hint.focusMonIndex !== undefined) ? Number(hint.focusMonIndex) : null;

        if (!focusKey || focusKey === nk) {
            const remembered = this.#lastFocusByWs[String(wsIndex)] || null;
            focusKey = remembered?.key ? String(remembered.key) : null;
            focusMon = (remembered && remembered.monIndex !== undefined) ? Number(remembered.monIndex) : focusMon;
        }

        // Must split a tile that exists on this monitor's tree.
        if (!focusKey || focusKey === nk) {
            if (hint) delete this.#pendingNewWindowHintByKey[nk];
            return null;
        }
        if (Number.isFinite(focusMon) && focusMon !== monIndex) {
            if (hint) delete this.#pendingNewWindowHintByKey[nk];
            return null;
        }
        const fr = rectByKeyUngapped[String(focusKey)];
        if (!fr) {
            if (hint) delete this.#pendingNewWindowHintByKey[nk];
            return null;
        }

        const axis = (fr.width >= fr.height) ? 'x' : 'y';
        const side = (axis === 'x') ? 'right' : 'bottom';

        if (hint) delete this.#pendingNewWindowHintByKey[nk];
        return { targetKey: String(focusKey), axis, ratio: 0.5, side };
    }
 
    // ----- v0.61/v0.62 tile borders + optional transitions -----

    #getFocusWindow() {
        try {
            if (global.display && typeof global.display.get_focus_window === 'function') {
                return global.display.get_focus_window();
            }
        } catch (e) {}
        try { return global.display ? global.display.focus_window : null; } catch (e) {}
        return null;
    }

    #getBorderConfig() {
        const sd = this.#settings?.settingsData || Object.create(null);
        const enabled = !!(sd.tileBordersEnabled?.value);
        const activeW = Math.max(0, Math.floor(Number(sd.tileBorderActiveWidth?.value ?? 3)));
        const inactiveW = Math.max(0, Math.floor(Number(sd.tileBorderInactiveWidth?.value ?? 1)));
        const activeC = String(sd.tileBorderActiveColor?.value || 'rgba(136,192,208,1)');
        const inactiveC = String(sd.tileBorderInactiveColor?.value || 'rgba(216,222,233,0.45)');
        const specialEnabled = !!(sd.floatStickyBordersEnabled?.value);
        const floatC = String(sd.floatBorderColor?.value || 'rgba(225,255,240,0.82)');
        const stickyC = String(sd.stickyBorderColor?.value || 'rgba(120,30,120,0.82)');
        const radius = Math.max(0, Math.floor(Number(sd.tileBorderRadius?.value ?? 10)));

        const overlayAnimate = !!(sd.overlayAnimate?.value);
        const overlayDur = Math.max(0, Math.floor(Number(sd.overlayAnimateDurationMs?.value ?? 90)));

        return {
            enabled,
            activeW, inactiveW,
            activeC, inactiveC,
            specialEnabled, floatC, stickyC,
            radius,
            overlayAnimate,
            overlayDur,
        };
    }

    #getGeometryAnimConfig() {
        const sd = this.#settings?.settingsData || Object.create(null);
        const enabled = !!(sd.geometryAnimate?.value);
        const dur = Math.max(0, Math.floor(Number(sd.geometryAnimateDurationMs?.value ?? 90)));
        return { enabled, dur };
    }

    #clearTileBorders() {
        try { if (this.#tileBorders) this.#tileBorders.clear(); } catch (e) {}
    }

    // v0.682: refresh overlays only (no retile). Used for floating/sticky move/resize/minimize.
    #scheduleBorderRefreshActive(reason = '', delayMs = 40) {
        if (!this.#tileBorders) return;
        const delay = Math.max(0, Math.floor(Number(delayMs) || 0));
        if (this.#borderRefreshTimer) {
            try { Mainloop.source_remove(this.#borderRefreshTimer); } catch (e) {}
            this.#borderRefreshTimer = 0;
        }
        this.#borderRefreshTimer = Mainloop.timeout_add(delay, () => {
            this.#borderRefreshTimer = 0;
            const ws = this.#getActiveWorkspaceIndex();
            this.#syncTileBorders(ws, reason ? `overlay-refresh-${reason}` : 'overlay-refresh', false);
            return false;
        });
    }

    // v0.682: during workspace switches, don't draw borders until windows are actually visible.
    #suppressTileBorders(ms = 200, reason = '') {
        const dur = Math.max(0, Math.floor(Number(ms) || 0));
        this.#borderSuppressUntil = Date.now() + dur;
        try { if (this.#tileBorders) this.#tileBorders.hide(); } catch (e) {}

        if (this.#borderSuppressTimer) {
            try { Mainloop.source_remove(this.#borderSuppressTimer); } catch (e) {}
            this.#borderSuppressTimer = 0;
        }
        this.#borderSuppressTimer = Mainloop.timeout_add(dur + 30, () => {
            this.#borderSuppressTimer = 0;
            this.#scheduleBorderRefreshActive(reason ? `post-suppress-${reason}` : 'post-suppress', 0);
            return false;
        });
    }

    // v0.682: verify the compositor actually applied the layout; if not, do one extra enforcement pass.
    #scheduleVerifyWorkspace(wsIndex, reason = '') {
        const activeWs = this.#getActiveWorkspaceIndex();
        if (wsIndex !== activeWs) return;
        if (this.#movingWindowKeys.size > 0) return;
        if (this.#resizingWindowKeys.size > 0) return;

        const token = (this.#verifyTokenByWs[wsIndex] || 0) + 1;
        this.#verifyTokenByWs[wsIndex] = token;

        const existing = this.#verifyTimerByWs[wsIndex] || 0;
        if (existing) {
            try { Mainloop.source_remove(existing); } catch (e) {}
            this.#verifyTimerByWs[wsIndex] = 0;
        }

        this.#verifyTimerByWs[wsIndex] = Mainloop.timeout_add(180, () => {
            this.#verifyTimerByWs[wsIndex] = 0;
            if ((this.#verifyTokenByWs[wsIndex] || 0) !== token) return false;
            this.#verifyWorkspaceOnce(wsIndex, reason);
            return false;
        });
    }

    #verifyWorkspaceOnce(wsIndex, reason = '') {
        const wsKey = String(wsIndex);
        const byMon = this.#lastLayout?.[wsKey] || null;
        if (!byMon) return;

        // Merge expected rects for tiled windows.
        const expected = Object.create(null);
        for (const monKey in byMon) {
            const rbk = byMon[monKey]?.rectByKey || null;
            if (!rbk) continue;
            for (const k in rbk) expected[String(k)] = rbk[k];
        }
        const expKeys = Object.keys(expected);
        if (!expKeys.length) return;

        // Map current windows by key.
        const wins = listAllMetaWindows().filter(w => w && w.window_type === Meta.WindowType.NORMAL);
        const winByKey = new Map();
        for (const w of wins) winByKey.set(String(this.#windowKey(w)), w);

        const EPS = 4;
        let mismatched = 0;

        for (const k of expKeys) {
            if (this.#userFloatingKeys.has(String(k))) continue;
            const w = winByKey.get(String(k));
            if (!w) continue;
            if (this.#getWorkspaceIndexOfWindow(w) !== wsIndex) continue;
            try {
                if (w.minimized || (typeof w.is_minimized === 'function' && w.is_minimized())) continue;
            } catch (e) {}
            if (this.#isForcedFloat(w)) continue;

            let fr = null;
            try { fr = w.get_frame_rect(); } catch (e) {}
            if (!fr) continue;
            const tr = expected[String(k)];
            if (!tr) continue;

            const bad =
                Math.abs(fr.x - tr.x) > EPS ||
                Math.abs(fr.y - tr.y) > EPS ||
                Math.abs(fr.width - tr.width) > EPS ||
                Math.abs(fr.height - tr.height) > EPS;
            if (bad) { mismatched++; break; }
        }

        if (!mismatched) return;

        const now = Date.now();
        const last = this.#verifyLastRetileAtByWs[wsIndex] || 0;
        if ((now - last) < 900) return; // avoid loops
        this.#verifyLastRetileAtByWs[wsIndex] = now;

        // One extra enforcement pass usually fixes "snap/half-screen" survivors.
        this.#retileWorkspaceNow(wsIndex, false);
        this.#scheduleRetile(wsIndex, reason ? `verify-follow-${reason}` : 'verify-follow');
    }

    // Only ever draw borders for the ACTIVE workspace (explicit perf requirement).
    // If wsIndex is not active, this becomes a no-op (or clears/hides if asked).
    #syncTileBorders(wsIndex, reason = '', isLiveResizeTick = false) {
        if (!this.#tileBorders) return;

        const activeWs = this.#getActiveWorkspaceIndex();
        if (wsIndex !== activeWs) return;
 
        // v0.682: do not draw borders during the short workspace-switch settling window.
        if (Date.now() < (this.#borderSuppressUntil || 0)) {
            try { this.#tileBorders.hide(); } catch (e) {}
            return;
        }

        const cfg = this.#getBorderConfig();
        if (!cfg.enabled || !this.#isTilingEnabled(wsIndex)) {
            // Hide + clear so inactive workspaces do not “keep” overlays around.
            this.#tileBorders.hide();
            this.#tileBorders.clear();
            return;
        }

        const wsKey = String(wsIndex);
        const byMon = this.#lastLayout?.[wsKey] || null;

        // Map current windows by key so we can:
        // - drop overlays for closed/minimized windows even if lastLayout is stale
        // - add overlays for hyprmon-managed floating/sticky windows
        const wins = listAllMetaWindows().filter(w => w && w.window_type === Meta.WindowType.NORMAL);
        const winByKey = new Map();
        for (const w of wins) winByKey.set(String(this.#windowKey(w)), w);

        // Build overlay entries:
        // - tiled windows from lastLayout rects (gapped)
        // - + hyprmon-managed floating/sticky windows using their frame rect
        const entries = Object.create(null); // key -> { rect, anchor }

        if (byMon) {
            for (const monKey in byMon) {
                const rbk = byMon?.[monKey]?.rectByKey || null;
                if (!rbk) continue;
                for (const k in rbk) {
                    const key = String(k);
                    const w = winByKey.get(key);
                    if (!w) continue;
                    if (this.#getWorkspaceIndexOfWindow(w) !== wsIndex) continue;
                    if (this.#userFloatingKeys.has(key)) continue;
                    if (this.#isForcedFloat(w)) continue;
                    try {
                        if (w.minimized || (typeof w.is_minimized === 'function' && w.is_minimized())) continue;
                    } catch (e) {}

                    let anchor = null;
                    try { anchor = (typeof w.get_compositor_private === 'function') ? w.get_compositor_private() : null; } catch (e) {}
                    if (!anchor) continue;
                    entries[key] = { rect: rbk[key], anchor, mode: 'tiled' };
                }
            }
        }

        // v0.682: add overlays for hyprmon-managed floating/sticky windows on the active workspace.
        for (const w of wins) {
            const key = String(this.#windowKey(w));
            if (!this.#userFloatingKeys.has(key)) continue;
            try {
                if (w.minimized || (typeof w.is_minimized === 'function' && w.is_minimized())) continue;
            } catch (e) {}

            const isSticky = this.#stickyKeys.has(key) ||
                (() => { try { return (typeof w.is_on_all_workspaces === 'function' && w.is_on_all_workspaces()); } catch (e) { return false; } })();
            const onWs = (this.#getWorkspaceIndexOfWindow(w) === wsIndex);
            if (!isSticky && !onWs) continue;

            let fr = null;
            try { fr = w.get_frame_rect(); } catch (e) {}
            if (!fr) continue;
            let anchor = null;
            try { anchor = (typeof w.get_compositor_private === 'function') ? w.get_compositor_private() : null; } catch (e) {}
            if (!anchor) continue;

            let mode = 'floating';
            if (cfg.specialEnabled) {
                mode = isSticky ? 'sticky' : 'floating';
            }
            entries[key] = { rect: { x: fr.x, y: fr.y, width: fr.width, height: fr.height }, anchor, mode };
        }

        const keys = Object.keys(entries);
        if (!keys.length) {
            this.#tileBorders.hide();
            this.#tileBorders.clear();
            return;
        }

        const fw = this.#getFocusWindow();
        const focusedKey = fw ? String(this.#windowKey(fw)) : null;
        const focusInSet = (focusedKey && entries[focusedKey]) ? focusedKey : null;

        // During live resize ticks, do NOT animate overlays (keeps borders glued to edges).
        const animate = cfg.overlayAnimate && !isLiveResizeTick && cfg.overlayDur > 0;

        this.#tileBorders.show();
        this.#tileBorders.sync(entries, focusInSet, {
            activeWidth: cfg.activeW,
            inactiveWidth: cfg.inactiveW,
            activeColor: cfg.activeC,
            inactiveColor: cfg.inactiveC,
            specialEnabled: cfg.specialEnabled,
            floatColor: cfg.floatC,
            stickyColor: cfg.stickyC,
            radius: cfg.radius,
            animate,
            durationMs: cfg.overlayDur,
        });
    }

    // Minimal “best-effort” geometry animation:
    // - opt-in
    // - short duration
    // - disabled during live-resize ticks (and obviously during grabs)
    #cancelGeomAnim(winKey) {
        const k = String(winKey || '');
        const id = this.#geomAnimByKey[k] || 0;
        if (id) {
            try { Mainloop.source_remove(id); } catch (e) {}
        }
        this.#geomAnimByKey[k] = 0;
    }

    #unmaximizeIfNeeded(metaWindow) {
        if (!metaWindow) return;
        try {
            const maxH = !!metaWindow.maximized_horizontally;
            const maxV = !!metaWindow.maximized_vertically;
            if ((maxH || maxV) && typeof metaWindow.unmaximize === 'function') {
                if (Meta.MaximizeFlags && Meta.MaximizeFlags.BOTH !== undefined) {
                    metaWindow.unmaximize(Meta.MaximizeFlags.BOTH);
                } else if (Meta.MaximizeFlags) {
                    const flags =
                        (maxH ? Meta.MaximizeFlags.HORIZONTAL : 0) |
                        (maxV ? Meta.MaximizeFlags.VERTICAL : 0);
                    metaWindow.unmaximize(flags);
                } else {
                    metaWindow.unmaximize(0);
                }
            }
        } catch (e) {}
    }

    #animateWindowToRect(metaWindow, rect, durationMs) {
        if (!metaWindow || !rect) return;
        const k = this.#windowKey(metaWindow);
        this.#cancelGeomAnim(k);

        let start = null;
        try { start = metaWindow.get_frame_rect(); } catch (e) {}
        if (!start) return;

        if (start.x === rect.x && start.y === rect.y && start.width === rect.width && start.height === rect.height) {
            return;
        }

        this.#unmaximizeIfNeeded(metaWindow);

        const dur = Math.max(0, Math.floor(Number(durationMs) || 0));
        if (dur <= 0) {
            snapToRect(metaWindow, rect);
            return;
        }

        // Keep this VERY small to avoid stutter; still visible enough to feel “soft”.
        const steps = Math.max(2, Math.min(6, Math.round(dur / 18)));
        const interval = Math.max(10, Math.floor(dur / steps));
        let i = 0;

        // Suppress retile feedback loops while animating.
        this.#suppressWindowGeomSignals(metaWindow, dur + 500);

        const id = Mainloop.timeout_add(interval, () => {
            i++;
            const t = Math.min(1, i / steps);

            const nx = Math.round(start.x + (rect.x - start.x) * t);
            const ny = Math.round(start.y + (rect.y - start.y) * t);
            const nw = Math.round(start.width + (rect.width - start.width) * t);
            const nh = Math.round(start.height + (rect.height - start.height) * t);

            try { metaWindow.move_resize_frame(false, nx, ny, nw, nh); } catch (e) {}

            if (i >= steps) {
                this.#geomAnimByKey[String(k)] = 0;
                // Final snap to avoid any rounding drift.
                try { snapToRect(metaWindow, rect); } catch (e) {}
                return false;
            }
            return true;
        });

        this.#geomAnimByKey[String(k)] = id;
    }
 
    #scheduleSaveTilingState(reason = '') {
        if (this.#saveStateTimer) {
            Mainloop.source_remove(this.#saveStateTimer);
            this.#saveStateTimer = 0;
        }
        this.#saveStateTimer = Mainloop.timeout_add(250, () => {
            this.#saveStateTimer = 0;
            this.#saveTilingStateNow();
            return false;
        });
    }

    #saveTilingStateNow() {
        try {
            this.#tilingStateIO.saveState(this.#tilingState);
        } catch (e) {
            global.logError(`hyprmon: save tiling state failed: ${e}`);
        }
    }

    #getWorkspaceState(wsIndex, create = false) {
        const wsKey = String(wsIndex);
        let ws = this.#tilingState.workspaces?.[wsKey] || null;
        if (!ws && create) {
            ws = {
                activeSide: 0,
                windowSides: Object.create(null),
                sides: Object.create(null),
                gapsDisabled: false
            };
            ws.sides['0'] = { monitors: Object.create(null) };
            this.#tilingState.workspaces[wsKey] = ws;
        }
        if (!ws) return null;

        if (ws.gapsDisabled === undefined) ws.gapsDisabled = false;
        if (!ws.windowSides || typeof ws.windowSides !== 'object') ws.windowSides = Object.create(null);
        if (!ws.sides || typeof ws.sides !== 'object') ws.sides = Object.create(null);

        const active = Number(ws.activeSide);
        ws.activeSide = (Number.isFinite(active) && active >= 0) ? Math.floor(active) : 0;
        if (!ws.sides[String(ws.activeSide)] || typeof ws.sides[String(ws.activeSide)] !== 'object')
            ws.sides[String(ws.activeSide)] = { monitors: Object.create(null) };

        // v1 compatibility (runtime migration)
        if (ws.monitors && typeof ws.monitors === 'object') {
            if (!ws.sides['0'] || typeof ws.sides['0'] !== 'object') ws.sides['0'] = { monitors: Object.create(null) };
            if (!ws.sides['0'].monitors || typeof ws.sides['0'].monitors !== 'object') ws.sides['0'].monitors = ws.monitors;
        }

        return ws;
    }

    #getActiveSideIndex(wsIndex) {
        const ws = this.#getWorkspaceState(wsIndex, true);
        return ws ? ws.activeSide : 0;
    }

    #setActiveSideIndex(wsIndex, sideIndex) {
        const ws = this.#getWorkspaceState(wsIndex, true);
        if (!ws) return 0;
        const next = Math.max(0, Math.floor(Number(sideIndex) || 0));
        ws.activeSide = next;
        if (!ws.sides[String(next)] || typeof ws.sides[String(next)] !== 'object')
            ws.sides[String(next)] = { monitors: Object.create(null) };
        this.#scheduleSaveTilingState('active-side-changed');
        return next;
    }

    #getWindowSide(wsIndex, winKey) {
        const ws = this.#getWorkspaceState(wsIndex, true);
        if (!ws) return 0;
        const k = String(winKey || '');
        if (!k) return ws.activeSide;
        const raw = ws.windowSides[k];
        const n = Number(raw);
        return (Number.isFinite(n) && n >= 0) ? Math.floor(n) : 0;
    }

    #setWindowSide(wsIndex, winKey, sideIndex) {
        const ws = this.#getWorkspaceState(wsIndex, true);
        if (!ws) return;
        const k = String(winKey || '');
        if (!k) return;
        ws.windowSides[k] = Math.max(0, Math.floor(Number(sideIndex) || 0));
        this.#scheduleSaveTilingState('window-side-changed');
    }

    #deleteWindowSide(wsIndex, winKey) {
        const ws = this.#getWorkspaceState(wsIndex, false);
        if (!ws) return;
        const k = String(winKey || '');
        if (!k) return;
        if (ws.windowSides && ws.windowSides[k] !== undefined) {
            delete ws.windowSides[k];
            this.#scheduleSaveTilingState('window-side-deleted');
        }
    }

    #ensureSideState(wsIndex, sideIndex) {
        const ws = this.#getWorkspaceState(wsIndex, true);
        if (!ws) return null;
        const sideKey = String(Math.max(0, Math.floor(Number(sideIndex) || 0)));
        let side = ws.sides[sideKey];
        if (!side || typeof side !== 'object') {
            side = { monitors: Object.create(null) };
            ws.sides[sideKey] = side;
        }
        if (!side.monitors || typeof side.monitors !== 'object') side.monitors = Object.create(null);
        return side;
    }

    #getSideMonState(wsIndex, sideIndex, monIndex, create = false) {
        const monKey = String(monIndex);
        const side = create
            ? this.#ensureSideState(wsIndex, sideIndex)
            : this.#getWorkspaceState(wsIndex, false)?.sides?.[String(Math.max(0, Math.floor(Number(sideIndex) || 0)))] || null;
        if (!side) return null;
        if (!side.monitors || typeof side.monitors !== 'object') {
            if (!create) return null;
            side.monitors = Object.create(null);
        }
        let mon = side.monitors[monKey];
        if (!mon && create) {
            mon = { tree: null };
            side.monitors[monKey] = mon;
        }
        return mon || null;
    }

    #getWsMonState(wsIndex, monIndex, create = false) {
        return this.#getSideMonState(wsIndex, this.#getActiveSideIndex(wsIndex), monIndex, create);
    }
 
    // ----- v0.66 gaps toggle (per workspace) -----

    #isGapsDisabled(wsIndex) {
        const ws = this.#getWorkspaceState(wsIndex, false);
        if (!ws || typeof ws !== 'object') return false;
        return !!ws.gapsDisabled;
    }

    #setGapsDisabled(wsIndex, disabled) {
        const ws = this.#getWorkspaceState(wsIndex, true);
        if (!ws) return;
        ws.gapsDisabled = !!disabled;
        this.#scheduleSaveTilingState('gaps-toggle');
    }

    #effectiveGapsForWorkspace(wsIndex) {
        const gapsOff = this.#isGapsDisabled(wsIndex);
        const sd = this.#settings.settingsData || Object.create(null);
        const outer = Math.max(0, Math.floor(Number(sd.outerGap?.value ?? 0)));
        const inner = Math.max(0, Math.floor(Number(sd.innerGap?.value ?? 0)));
        return {
            outerGap: gapsOff ? 0 : outer,
            innerGap: gapsOff ? 0 : inner,
        };
    }

    #toggleGapsOnActiveWorkspace() {
        const wsIndex = this.#getActiveWorkspaceIndex();
        if (!this.#isTilingEnabled(wsIndex)) {
            this.#notify(`Workspace ${wsIndex + 1}: auto-tiling is disabled`);
            return;
        }
        const nextDisabled = !this.#isGapsDisabled(wsIndex);
        this.#setGapsDisabled(wsIndex, nextDisabled);
        this.#scheduleRetileBurst(wsIndex, 'gaps-toggle');
        this.#notify(`Workspace ${wsIndex + 1}: gaps ${nextDisabled ? 'DISABLED' : 'ENABLED'}`);
    }
 
    // ----- v0.67 keyboard focus/swap/grow helpers -----

    #activateWindow(metaWindow) {
        if (!metaWindow) return false;
        try {
            if (typeof metaWindow.activate === 'function') {
                const t = (typeof global.get_current_time === 'function') ? global.get_current_time() : Date.now();
                metaWindow.activate(t);
                return true;
            }
        } catch (e) {}
        return false;
    }

    #findMetaWindowByKey(winKey) {
        const k = String(winKey || '');
        if (!k) return null;
        try {
            for (const w of listAllMetaWindows()) {
                if (!w || w.window_type !== Meta.WindowType.NORMAL) continue;
                if (String(this.#windowKey(w)) === k) return w;
            }
        } catch (e) {}
        return null;
    }

    #getSplitRatioAtPath(tree, path) {
        try {
            let n = tree;
            const p = Array.isArray(path) ? path : [];
            for (const step of p) {
                if (!n || n.type !== 'split') return null;
                if (step === 'a') n = n.a;
                else if (step === 'b') n = n.b;
                else return null;
            }
            if (n && n.type === 'split' && typeof n.ratio === 'number') return n.ratio;
        } catch (e) {}
        return null;
    }

    // Returns ctx for the focused *tiled* window on a tiling-enabled workspace.
    // If focused window is floating/user-floating/not part of tiled set, returns null.
    #getActiveTileCtx() {
        const w = this.#getFocusWindow();
        if (!w || w.window_type !== Meta.WindowType.NORMAL) return null;
        if (this.#isForcedFloat(w)) return null;

        const wsIndex = this.#getWorkspaceIndexOfWindow(w);
        if (wsIndex === null || !this.#isTilingEnabled(wsIndex)) return null;

        // v0.64/v0.65: do nothing for user-floating/sticky windows.
        if (this.#isUserFloating(w)) return null;

        const myKey = String(this.#windowKey(w));
        if (this.#floatingWindowKeys.has(myKey)) return null; // temporarily detached (drag)

        const monIndex = this.#getMonitorIndexOfWindow(w);
        if (monIndex === null) return null;

        const eg = this.#effectiveGapsForWorkspace(wsIndex);
        const outerGap = eg.outerGap;
        const innerGap = eg.innerGap;
        const workArea = this.#getTilingWorkAreaWithExtras(monIndex, outerGap);
        if (!workArea) return null;

        // Build current tiled window key set for this ws+mon (exclude floating keys).
        let wins = this.#listManagedTilingCandidates(wsIndex, monIndex) || [];
        wins = wins.filter(win => {
            const k = String(this.#windowKey(win));
            if (this.#floatingWindowKeys.has(k)) return false;
            if (this.#userFloatingKeys.has(k)) return false;
            return true;
        });
        if (!wins.length) return null;

        wins.sort((a, b) => this.#windowSortKey(a) - this.#windowSortKey(b));
        const winKeys = wins.map(win => String(this.#windowKey(win)));
        if (!winKeys.includes(myKey)) return null;

        // Reconcile tree for deterministic ops.
        let tree = this.#getBspTree(wsIndex, monIndex);
        const rec = reconcileBspTree(tree, winKeys, workArea);
        tree = rec.tree;
        if (rec.changed) this.#setBspTree(wsIndex, monIndex, tree);
        if (!tree) return null;

        // Prefer cached lastLayout rects (what user just saw), else compute gapped rects from tree.
        const wsKey = String(wsIndex);
        const monKey = String(monIndex);
        let rectByKey = this.#lastLayout?.[wsKey]?.[monKey]?.rectByKey || null;
        if (!rectByKey) rectByKey = this.#buildGappedRectByKeyFromTree(tree, workArea, innerGap);
        if (!rectByKey || !rectByKey[myKey]) return null;

        return { w, wsIndex, monIndex, myKey, rectByKey, tree, workArea, innerGap, outerGap };
    }

    #neighborKeyInDir(ctx, dir) {
        if (!ctx || !ctx.rectByKey) return null;
        const d = String(dir || '').toUpperCase();
        if (!['E','W','N','S'].includes(d)) return null;

        const innerGap = Math.max(0, Math.floor(Number(ctx.innerGap) || 0));
        const maxDist = Math.max(40, innerGap + 60);
        const minOv = 18; // forgiving
        return findAdjacentKey(ctx.rectByKey, ctx.myKey, d, maxDist, minOv);
    }

    #focusNeighborDir(dir) {
        const ctx = this.#getActiveTileCtx();
        if (!ctx) return;

        const nk = this.#neighborKeyInDir(ctx, dir);
        if (!nk) return;

        const target = this.#findMetaWindowByKey(nk);
        if (target) this.#activateWindow(target);
    }

    #swapNeighborDir(dir) {
        const ctx = this.#getActiveTileCtx();
        if (!ctx) return;

        const nk = this.#neighborKeyInDir(ctx, dir);
        if (!nk) return;

        const sw = swapLeavesByKey(ctx.tree, ctx.myKey, String(nk));
        if (!sw || !sw.changed) return;

        this.#setBspTree(ctx.wsIndex, ctx.monIndex, sw.tree);
        this.#retileAfterDrag(ctx.wsIndex, `kbd-swap-${String(dir).toUpperCase()}`);

        // Keep focus on the same window after swap.
        Mainloop.idle_add(() => { try { this.#activateWindow(ctx.w); } catch (e) {} return false; });
    }

    #growActiveDir(dir) {
        this.#nudgeActiveDir(dir, +1);
    }

    #shrinkActiveDir(dir) {
        this.#nudgeActiveDir(dir, -1);
    }

    // mode: +1 => grow active toward dir, -1 => shrink active toward dir
    #nudgeActiveDir(dir, mode) {
        const ctx = this.#getActiveTileCtx();
        if (!ctx) return;

        const d = String(dir || '').toUpperCase();
        const axisWanted = this.#axisForDir(d);

        const nk = this.#neighborKeyInDir(ctx, d);
        if (!nk) return; // no neighbor on that side => cannot grow past edge

        let splitInfo = findSplitBetweenKeys(ctx.tree, ctx.workArea, ctx.myKey, String(nk));
        if (!splitInfo || splitInfo.axis !== axisWanted) return;

        const parentRect = splitInfo.rect;
        const parentLen = (splitInfo.axis === 'y') ? parentRect.height : parentRect.width;
        if (!Number.isFinite(parentLen) || parentLen <= 0) return;

        const stepPx = Math.max(4, Math.floor(Number(this.#settings?.settingsData?.resizeStepPx?.value ?? 32)));
        const delta = stepPx / Math.max(1, parentLen);
        const baseSign = (d === 'E' || d === 'S') ? +1 : -1; // grow-direction sign
        const sign = baseSign * (Number(mode) >= 0 ? 1 : -1);

        const curRatio = this.#getSplitRatioAtPath(ctx.tree, splitInfo.path);
        const base = (typeof curRatio === 'number') ? curRatio : 0.5;
        const raw = base + sign * delta;
        const minPx = this.#getMinTileSizePx();
        const clamped = clampRatioForParent(splitInfo.axis, parentRect, raw, minPx);

        if (Math.abs(clamped - base) < 0.0005) return;

        const nextTree = setSplitRatioAtPath(ctx.tree, splitInfo.path, clamped);

        // v0.68 safety clamp: prevent pushing other tiles under minimum size, if current layout is sane.
        const baseOk = this.#treeRespectsMinSize(ctx.tree, ctx.workArea, ctx.innerGap, minPx);
        if (baseOk && !this.#treeRespectsMinSize(nextTree, ctx.workArea, ctx.innerGap, minPx)) return;

        this.#setBspTree(ctx.wsIndex, ctx.monIndex, nextTree);

        // Retile applies the new ratios and drives the "resize neighbors" behavior.
        const tag = (Number(mode) >= 0) ? `kbd-grow-${d}` : `kbd-shrink-${d}`;
        this.#retileAfterDrag(ctx.wsIndex, tag);

        // Keep focus.
        Mainloop.idle_add(() => { try { this.#activateWindow(ctx.w); } catch (e) {} return false; });
    }
 
    // ----- v0.671 change-shape (toggle split axis with symmetric neighbor) -----

    #numKey(k) {
        const n = Number(String(k));
        return Number.isFinite(n) ? n : null;
    }

    #compareKeys(a, b) {
        const an = this.#numKey(a);
        const bn = this.#numKey(b);
        if (an !== null && bn !== null) return an - bn;
        const as = String(a), bs = String(b);
        if (as < bs) return -1;
        if (as > bs) return 1;
        return 0;
    }

    #splitNodeAtPath(tree, path) {
        try {
            let n = tree;
            const p = Array.isArray(path) ? path : [];
            for (const step of p) {
                if (!n || n.type !== 'split') return null;
                if (step === 'a') n = n.a;
                else if (step === 'b') n = n.b;
                else return null;
            }
            return n || null;
        } catch (e) {}
        return null;
    }

    #replaceNodeAtPath(tree, path, replacement) {
        const p = Array.isArray(path) ? path : [];
        function clone(n) {
            if (!n) return null;
            if (n.type === 'leaf') return { type: 'leaf', win: String(n.win) };
            return {
                type: 'split',
                axis: (n.axis === 'y') ? 'y' : 'x',
                ratio: (typeof n.ratio === 'number') ? n.ratio : 0.5,
                a: clone(n.a),
                b: clone(n.b)
            };
        }
        function rec(node, idx) {
            if (!node) return null;
            if (idx >= p.length) return clone(replacement);
            if (node.type !== 'split') return clone(node);
            const out = clone(node);
            const step = p[idx];
            if (step === 'a') out.a = rec(node.a, idx + 1);
            else if (step === 'b') out.b = rec(node.b, idx + 1);
            return out;
        }
        return rec(tree, 0);
    }

    // Full-border requirement (gapped rects):
    // - E/W: same y and same height (within eps)
    // - N/S: same x and same width (within eps)
    #rectsShareFullBorderOnDir(rA, rB, dir, eps = 3) {
        if (!rA || !rB) return false;
        const d = String(dir || '').toUpperCase();
        const e = Math.max(1, Math.floor(Number(eps) || 3));
        if (d === 'E' || d === 'W') {
            return (Math.abs(rA.y - rB.y) <= e) && (Math.abs(rA.height - rB.height) <= e);
        }
        if (d === 'N' || d === 'S') {
            return (Math.abs(rA.x - rB.x) <= e) && (Math.abs(rA.width - rB.width) <= e);
        }
        return false;
    }

    #changeShapeDir(dir) {
        const ctx = this.#getActiveTileCtx();
        if (!ctx) return;

        const d = String(dir || '').toUpperCase();
        const axisWanted = this.#axisForDir(d); // current adjacency axis

        const nk = this.#neighborKeyInDir(ctx, d);
        if (!nk) return;

        const rA = ctx.rectByKey[String(ctx.myKey)] || null;
        const rB = ctx.rectByKey[String(nk)] || null;
        if (!this.#rectsShareFullBorderOnDir(rA, rB, d, 3)) return;

        const splitInfo = findSplitBetweenKeys(ctx.tree, ctx.workArea, ctx.myKey, String(nk));
        if (!splitInfo || splitInfo.axis !== axisWanted) return;

        const node = this.#splitNodeAtPath(ctx.tree, splitInfo.path);
        if (!node || node.type !== 'split') return;
        if ((node.axis === 'y' ? 'y' : 'x') !== axisWanted) return;

        // Must be a symmetric pair: both sides are single leaves exactly {myKey,nk}.
        if (!node.a || !node.b) return;
        if (node.a.type !== 'leaf' || node.b.type !== 'leaf') return;
        const aKey = String(node.a.win);
        const bKey = String(node.b.win);
        const wantA = String(ctx.myKey);
        const wantB = String(nk);
        const matches =
            (aKey === wantA && bKey === wantB) ||
            (aKey === wantB && bKey === wantA);
        if (!matches) return;

        const newAxis = (axisWanted === 'x') ? 'y' : 'x';
        const ratio = (typeof node.ratio === 'number') ? node.ratio : 0.5; // preserve size split

        // Deterministic ordering for the new axis (ties common; use key order).
        const cmp = this.#compareKeys(wantA, wantB);
        const first = (cmp <= 0) ? wantA : wantB;
        const second = (cmp <= 0) ? wantB : wantA;

        const newNode = {
            type: 'split',
            axis: newAxis,
            ratio,
            a: { type: 'leaf', win: first },
            b: { type: 'leaf', win: second }
        };

        const nextTree = this.#replaceNodeAtPath(ctx.tree, splitInfo.path, newNode);
        if (!nextTree) return;

        this.#setBspTree(ctx.wsIndex, ctx.monIndex, nextTree);
        this.#retileAfterDrag(ctx.wsIndex, `kbd-shape-${d}`);
        Mainloop.idle_add(() => { try { this.#activateWindow(ctx.w); } catch (e) {} return false; });
    }

    #getBspTree(wsIndex, monIndex, sideIndex = null) {
        const side = (sideIndex === null || sideIndex === undefined)
            ? this.#getActiveSideIndex(wsIndex)
            : Math.max(0, Math.floor(Number(sideIndex) || 0));
        const st = this.#getSideMonState(wsIndex, side, monIndex, false);
        return st ? (st.tree || null) : null;
    }

    #setBspTree(wsIndex, monIndex, tree, sideIndex = null) {
        const side = (sideIndex === null || sideIndex === undefined)
            ? this.#getActiveSideIndex(wsIndex)
            : Math.max(0, Math.floor(Number(sideIndex) || 0));
        const st = this.#getSideMonState(wsIndex, side, monIndex, true);
        st.tree = tree || null;
        this.#scheduleSaveTilingState('tree-changed');
    }

    #clearSideTrees(wsIndex, sideIndex) {
        const side = this.#ensureSideState(wsIndex, sideIndex);
        if (!side) return;
        side.monitors = Object.create(null);
        this.#scheduleSaveTilingState('workspace-side-reset');
    }

    #clearWorkspaceTrees(wsIndex, activeSideOnly = false) {
        const ws = this.#getWorkspaceState(wsIndex, false);
        if (!ws) return;
        if (activeSideOnly) {
            this.#clearSideTrees(wsIndex, this.#getActiveSideIndex(wsIndex));
        } else {
            ws.sides = Object.create(null);
            ws.sides[String(this.#getActiveSideIndex(wsIndex))] = { monitors: Object.create(null) };
            this.#scheduleSaveTilingState('workspace-reset');
        }
        const wsKey = String(wsIndex);
        if (this.#lastLayout[wsKey]) delete this.#lastLayout[wsKey];
    }

    #applyDefaultWorkspaceEnable() {
        const raw = (this.#settings.settingsData.defaultEnabledWorkspaces?.value || '').trim();
        if (!raw) return;

        // "1, 3 5" -> [1,3,5] (1-based in UI)
        const parts = raw.split(/[\s,]+/).filter(Boolean);
        for (const part of parts) {
            const n = parseInt(part, 10);
            if (!Number.isFinite(n) || n <= 0) continue;
            const idx = n - 1;
            this.#enabledWorkspaces[idx] = true;
        }
    }

    #isTilingEnabled(wsIndex) {
        return !!this.#enabledWorkspaces[wsIndex];
    }

    #getExtraTopGap() {
        return Math.max(0, Math.floor(Number(this.#settings.settingsData.extraTopGap?.value ?? 0)));
    }

    #getExtraBottomGap() {
        return Math.max(0, Math.floor(Number(this.#settings.settingsData.extraBottomGap?.value ?? 0)));
    }

    #applyExtraVerticalGaps(area, extraTop, extraBottom) {
        if (!area) return null;
        const t = Math.max(0, Math.floor(Number(extraTop) || 0));
        const b = Math.max(0, Math.floor(Number(extraBottom) || 0));
        const h = Math.max(0, area.height - t - b);
        return { x: area.x, y: area.y + t, width: area.width, height: h };
    }

    #getTilingWorkAreaWithExtras(mon, outerGap) {
        const base = getTilingWorkArea(mon, outerGap);
        return this.#applyExtraVerticalGaps(base, this.#getExtraTopGap(), this.#getExtraBottomGap());
    }

    #suppressWindowGeomSignals(metaWindow, ms = 250) {
        if (!metaWindow) return;
        const k = this.#windowKey(metaWindow);
        const until = Date.now() + Math.max(0, Math.floor(Number(ms) || 0));
        this.#suppressGeomUntilByKey[k] = Math.max(this.#suppressGeomUntilByKey[k] || 0, until);
    }

    #isGeomSuppressed(metaWindow) {
        if (!metaWindow) return false;
        const k = this.#windowKey(metaWindow);
        const until = this.#suppressGeomUntilByKey[k] || 0;
        if (until <= Date.now()) return false;
        return true;
    }

    #onWindowNeedsRetile(metaWindow, reason) {
        if (!metaWindow) return;
        if (this.#sideHiddenKeys.has(String(this.#windowKey(metaWindow)))) return;
        // v0.64/v0.65: floating/sticky windows never trigger reflow.
        if (this.#isUserFloating(metaWindow)) return;
        // v0.68: forced-floating windows never trigger reflow.
        if (this.#isForcedFloat(metaWindow)) return;

        const ws = this.#getWorkspaceIndexOfWindow(metaWindow);
        if (ws === null) return;
        if (!this.#isTilingEnabled(ws)) return;

        // Don't react to our own move/resize storm.
        if (this.#isGeomSuppressed(metaWindow)) return;

        // Don't fight a live move (mouse/keyboard grab).
        const k = this.#windowKey(metaWindow);
        if (this.#movingWindowKeys.has(k)) return;
        if (this.#resizingWindowKeys.has(k)) return;

        this.#scheduleRetile(ws, reason);
    }

    // Burst retiles help after Cinnamon reload/startup and after workspace switches:
    // some windows ignore the first move/resize until their state settles.
    #scheduleRetileBurst(wsIndex, reason = '') {
        if (!this.#isTilingEnabled(wsIndex)) return;

        const token = (this.#retileBurstToken[wsIndex] || 0) + 1;
        this.#retileBurstToken[wsIndex] = token;

        const runLater = (delayMs, tag) => {
            const id = Mainloop.timeout_add(delayMs, () => {
                if (!this.#isTilingEnabled(wsIndex)) return false;
                if ((this.#retileBurstToken[wsIndex] || 0) !== token) return false;
                this.#retileWorkspaceNow(wsIndex, false);
                return false;
            });
            this.#miscTimers.add(id);
        };

        // immediate-ish + a couple of follow-ups
        const id0 = Mainloop.idle_add(() => {
            if (!this.#isTilingEnabled(wsIndex)) return false;
            if ((this.#retileBurstToken[wsIndex] || 0) !== token) return false;
            this.#retileWorkspaceNow(wsIndex, false);
            return false;
        });
        this.#miscTimers.add(id0);

        // keep your normal debounce behavior too
        this.#scheduleRetile(wsIndex, reason ? `${reason}-burst` : 'burst');

        runLater(250, 'burst-250');
        runLater(900, 'burst-900');
    }

    // One-time healing passes shortly after extension enable.
    // This fixes "workspace not active at startup" + "windows not settled yet" cases.
    #scheduleStartupHealing() {
        const enabledWs = Object.keys(this.#enabledWorkspaces)
            .map(k => parseInt(k, 10))
            .filter(n => Number.isFinite(n) && this.#enabledWorkspaces[n]);

        if (enabledWs.length === 0) return;

        const pass = (delay) => {
            const id = Mainloop.timeout_add(delay, () => {
                for (const ws of enabledWs) {
                    if (this.#isTilingEnabled(ws)) this.#scheduleRetileBurst(ws, `startup-heal-${delay}`);
                }
                return false;
            });
            this.#miscTimers.add(id);
        };

        pass(600);
        pass(1800);
    }
 
    #getWorkspaceIndexOfWindow(w) {
        try {
            const ws = w && w.get_workspace ? w.get_workspace() : null;
            if (ws && typeof ws.index === 'function') return ws.index();
        } catch (e) {}
        return null;
    }

    #getMonitorIndexOfWindow(w) {
        try {
            if (w && typeof w.get_monitor === 'function') return w.get_monitor();
        } catch (e) {}
        return null;
    }

    #trackWindow(metaWindow) {
        if (!metaWindow) return;
        if (metaWindow.window_type !== Meta.WindowType.NORMAL) return;

        // Track using a stable identity key (never user_time).
        const idKey = this.#getWindowIdentityKey(metaWindow);
        if (idKey && this.#trackedSeq.has(idKey)) return;
        if (idKey) this.#trackedSeq.add(idKey);

        let lastWs = this.#getWorkspaceIndexOfWindow(metaWindow);
        let lastMon = this.#getMonitorIndexOfWindow(metaWindow);

        // When a window goes away, reflow the workspace it was on.
        this.#safeConnect(metaWindow, 'unmanaged', () => {
            const aws = this.#getActiveWorkspaceIndex();
            const winKey = String(this.#windowKey(metaWindow));
            try { this.#setWindowFlags(this.#windowKey(metaWindow), false, false); } catch (e) {}
            if (lastWs !== null) this.#deleteWindowSide(lastWs, winKey);
            if (lastWs !== null) this.#scheduleRetile(lastWs, 'window-unmanaged');
            delete this.#parkRestoreRectByKey[winKey];
            this.#sideHiddenKeys.delete(winKey);
            delete this.#sideHiddenModeByKey[winKey];
            // v0.682: ensure overlays drop immediately for closed windows.
            this.#scheduleBorderRefreshActive('unmanaged', 0);
            // If the unmanaged window was on the active workspace, refresh overlays quickly.
            this.#syncTileBorders(aws, 'window-unmanaged', false);
        });

        // When moved to/from workspace, reflow both sides.
        // (Most builds expose notify::workspace; if not, this is harmlessly skipped.)
        this.#safeConnect(metaWindow, 'notify::workspace', () => {
            const winKey = String(this.#windowKey(metaWindow));
            if (this.#isUserFloating(metaWindow)) {
                const newWsFloat = this.#getWorkspaceIndexOfWindow(metaWindow);
                if (lastWs !== null) this.#deleteWindowSide(lastWs, winKey);
                if (newWsFloat !== null) this.#setWindowSide(newWsFloat, winKey, this.#getActiveSideIndex(newWsFloat));
                lastWs = newWsFloat;
                this.#scheduleBorderRefreshActive('floating-ws-change', 30);
                return;
            }
            const newWs = this.#getWorkspaceIndexOfWindow(metaWindow);
            if (newWs === lastWs) return;

            if (lastWs !== null) this.#deleteWindowSide(lastWs, winKey);
            if (newWs !== null) this.#setWindowSide(newWs, winKey, this.#getActiveSideIndex(newWs));

            if (lastWs !== null && this.#isTilingEnabled(lastWs)) this.#scheduleRetileBurst(lastWs, 'window-left-workspace');
            if (newWs !== null && this.#isTilingEnabled(newWs)) this.#scheduleRetileBurst(newWs, 'window-entered-workspace');

            lastWs = newWs;
        });

        // When moved between monitors (same workspace), reflow that workspace.
        this.#safeConnect(metaWindow, 'notify::monitor', () => {
            if (this.#isUserFloating(metaWindow)) {
                lastMon = this.#getMonitorIndexOfWindow(metaWindow);
                this.#scheduleBorderRefreshActive('floating-mon-change', 30);
                return;
            }
            const newMon = this.#getMonitorIndexOfWindow(metaWindow);
            if (newMon === lastMon) return;
            if (lastWs !== null && this.#isTilingEnabled(lastWs)) this.#scheduleRetileBurst(lastWs, 'window-monitor-changed');
            lastMon = newMon;
        });

        // Any geometry/state change should trigger retile on tiling-enabled workspaces.
        // (We suppress signals caused by our own tiling, and we ignore live grabs.)
        this.#safeConnect(metaWindow, 'position-changed', () => {
            if (this.#isUserFloating(metaWindow)) { this.#scheduleBorderRefreshActive('floating-move', 30); return; }
            if (this.#maybeHandleLiveResize(metaWindow)) return;
            this.#onWindowNeedsRetile(metaWindow, 'window-position-changed');
        });
        this.#safeConnect(metaWindow, 'size-changed', () => {
            if (this.#isUserFloating(metaWindow)) { this.#scheduleBorderRefreshActive('floating-resize', 30); return; }
            if (this.#maybeHandleLiveResize(metaWindow)) return;
            this.#onWindowNeedsRetile(metaWindow, 'window-size-changed');
        });

        // Some actions (minimize/maximize/fullscreen) may not reliably emit size/pos in all builds.
        this.#safeConnect(metaWindow, 'notify::minimized', () => {
            if (this.#isUserFloating(metaWindow)) { this.#scheduleBorderRefreshActive('floating-minimize', 0); return; }
            this.#onWindowNeedsRetile(metaWindow, 'window-minimized-changed');
        });
        this.#safeConnect(metaWindow, 'notify::maximized-horizontally', () => {
            if (this.#isUserFloating(metaWindow)) return;
            this.#onWindowNeedsRetile(metaWindow, 'window-maximize-changed');
        });
        this.#safeConnect(metaWindow, 'notify::maximized-vertically', () => {
            if (this.#isUserFloating(metaWindow)) return;
            this.#onWindowNeedsRetile(metaWindow, 'window-maximize-changed');
        });
        this.#safeConnect(metaWindow, 'notify::fullscreen', () => {
            if (this.#isUserFloating(metaWindow)) return;
            this.#onWindowNeedsRetile(metaWindow, 'window-fullscreen-changed');
        });

        // If a window becomes un-maximized/maximized by user actions, we do NOT auto-relayout
        // from these signals (would create storms). Instead, our snapToRect unmaximizes when needed.
    }
 
    #windowKey(metaWindow) {
        // stable for lifetime of the window (within session)
        return this.#getWindowIdentityKey(metaWindow);
    }

    #connectTilingHooks() {
        // Track existing windows so we get workspace/move/unmanaged hooks.
        try {
            for (const w of listAllMetaWindows()) {
                this.#trackWindow(w);
            }
        } catch (e) {}

        // New window mapped/created -> track + relayout that workspace (debounced)
        this.#safeConnect(global.display, 'window-created', (display, metaWindow) => {
            this.#trackWindow(metaWindow);
            const ws = this.#getWorkspaceIndexOfWindow(metaWindow);
            if (ws !== null) {
                const k = String(this.#windowKey(metaWindow));
                this.#setWindowSide(ws, k, this.#getActiveSideIndex(ws));
            }
            if (ws !== null && this.#isTilingEnabled(ws)) {
                if (this.#isForcedFloat(metaWindow)) return; // v068

                // v0.63: capture a creation hint so reconcile can place the new window:
                // - default: split the focused tile (active window) on the active workspace
                // - if modifier held: place like a drop under mouse cursor (split tile under pointer)
                try {
                    const k = this.#windowKey(metaWindow);
                    const mon = this.#getMonitorIndexOfWindow(metaWindow);
                    const p = this.#getPointerWithMods();

                    const remembered = this.#lastFocusByWs[String(ws)] || null;
                    // Capture focus-at-create to avoid "new window already focused" races.
                    const focusKey = (remembered && remembered.key) ? String(remembered.key) : null;
                    const focusMonIndex = (remembered && remembered.monIndex !== undefined) ? Number(remembered.monIndex) : null;

                    this.#pendingNewWindowHintByKey[String(k)] = {
                        ts: Date.now(),
                        px: p.x,
                        py: p.y,
                        mods: p.mods,
                        focusKey,
                        focusMonIndex
                    };
                } catch (e) {}

                // New windows may ignore first resize; schedule (debounced) is enough.
                this.#scheduleRetile(ws, 'window-created');
            }
            // Stacking can change when new windows appear; keep it consistent (throttled).
            this.#scheduleStackingSync('window-created');
        });

        // v0.682: monitor layout changes can desync per-monitor BSP + lastLayout.
        // Best-effort recovery: clear trees for enabled workspaces and re-tile bursts.
        this.#safeConnect(global.display, 'monitors-changed', () => {
            const enabledWs = Object.keys(this.#enabledWorkspaces)
                .map(k => parseInt(k, 10))
                .filter(n => Number.isFinite(n) && this.#enabledWorkspaces[n]);

            for (const ws of enabledWs) this.#clearWorkspaceTrees(ws);
            for (const ws of enabledWs) this.#scheduleRetileBurst(ws, 'monitors-changed');

            // Also clear/suppress overlays while windows remap.
            this.#clearTileBorders();
            try { if (this.#tileBorders) this.#tileBorders.hide(); } catch (e) {}
            this.#suppressTileBorders(260, 'monitors-changed');
        });

        // Workspace switch: if the new workspace is enabled, enforce tiling.
        const wm = global.workspace_manager;
        if (wm) {
            this.#safeConnect(wm, 'active-workspace-changed', () => {
                const wsIndex = this.#getActiveWorkspaceIndex();
                // v0.61: never keep borders from an inactive workspace around
                // (explicitly clear to avoid any processing/drawing on inactive workspaces).
                this.#clearTileBorders();
                try { if (this.#tileBorders) this.#tileBorders.hide(); } catch (e) {}
                this.#suppressTileBorders(220, 'workspace-switch');

                if (this.#isTilingEnabled(wsIndex)) {
                    this.#scheduleRetileBurst(wsIndex, 'workspace-switch');
                }
            });
        }

        // Focus changes -> active/inactive border styling refresh (active workspace only).
        this.#safeConnect(global.display, 'notify::focus-window', () => {
            try {
                const fw = this.#getFocusWindow();
                if (fw && this.#redirectFocusToWindowSideIfNeeded(fw)) {
                    // Side switch triggers its own follow-up focus notifications.
                    return;
                }
            } catch (e) {}

            // v0.63: remember last focused tile per workspace (monitor-aware)
            try {
                const w = this.#getFocusWindow();
                if (w) {
                    const ws = this.#getWorkspaceIndexOfWindow(w);
                    const mon = this.#getMonitorIndexOfWindow(w);
                    if (ws !== null && mon !== null && this.#isTilingEnabled(ws)) {
                        const k = this.#windowKey(w);
                        // ignore temporary floating windows in this heuristic
                        if (!this.#floatingWindowKeys.has(k) &&
                            !this.#userFloatingKeys.has(String(k))) {
                            this.#lastFocusByWs[String(ws)] = { key: String(k), monIndex: Number(mon), ts: Date.now() };
                        }
                    }
                }
            } catch (e) {}

            const ws = this.#getActiveWorkspaceIndex();
            this.#syncTileBorders(ws, 'focus-changed', false);

            // v0.68: keep sticky above floating even if a floating window is focused/raised by WM.
            this.#scheduleStackingSync('focus-changed');
        });
    }

    #getStableSeq(w) {
        try {
            if (w && typeof w.get_stable_sequence === 'function') {
                const v = w.get_stable_sequence();
                if (Number.isFinite(v) && v !== 0) return v;
            }
        } catch (e) {}
        return 0;
    }

    // Returns a stable identity string for the lifetime of the MetaWindow.
    // Never uses get_user_time() (it can change during interaction).
    #getWindowIdentityKey(w) {
        const seq = this.#getStableSeq(w);
        if (seq && seq !== 0) return String(seq);

        let id = this.#winIdByMeta.get(w);
        if (!id) {
            // Start far away from typical stable_sequence values to avoid collisions.
            id = 1000000000 + (this.#nextWinId++);
            this.#winIdByMeta.set(w, id);
        }
        return String(id);
    }

    #windowSortKey(w) {
        const seq = this.#getStableSeq(w);
        if (seq && seq !== 0) return seq;
        const k = this.#getWindowIdentityKey(w);
        const n = Number(k);
        return Number.isFinite(n) ? n : 0;
    }
 
    #resetLayoutOnActiveWorkspace() {
        const wsIndex = this.#getActiveWorkspaceIndex();
        if (!this.#isTilingEnabled(wsIndex)) {
            this.#notify(`Workspace ${wsIndex + 1}: auto-tiling is disabled`);
            return;
        }
        this.#clearWorkspaceTrees(wsIndex);
        this.#scheduleRetileBurst(wsIndex, 'reset-layout');
        this.#notify(`Workspace ${wsIndex + 1}: layout reset`);
    }

    #applyRects(windows, rects, skipKey = null, suppressMs = 350, allowGeomAnim = false) {
        const animCfg = this.#getGeometryAnimConfig();
        const n = Math.min(windows.length, rects.length);
        for (let i = 0; i < n; i++) {
            try {
                const w = windows[i];
                if (skipKey && this.#windowKey(w) === String(skipKey)) continue;
                this.#suppressWindowGeomSignals(w, suppressMs);
                const k = this.#windowKey(w);
                // Never animate while the user is actively moving/resizing this window.
                if (allowGeomAnim &&
                    animCfg.enabled &&
                    animCfg.dur > 0 &&
                    !this.#movingWindowKeys.has(k) &&
                    !this.#resizingWindowKeys.has(k)) {
                    this.#animateWindowToRect(w, rects[i], animCfg.dur);
                } else {
                    this.#cancelGeomAnim(k);
                    snapToRect(w, rects[i]);
                }
            } catch (e) {
                global.logError(`hyprmon: snapToRect failed: ${e}`);
            }
        }
    }

    #retileWorkspaceNow(wsIndex, debug = false) {
        if (!this.#isTilingEnabled(wsIndex)) return;

        this.#restoreActiveSideWindows(wsIndex);
        this.#parkInactiveSideWindows(wsIndex);

        const nMonitors = global.display.get_n_monitors();
        const eg = this.#effectiveGapsForWorkspace(wsIndex);
        const outerGap = eg.outerGap;
        const innerGap = eg.innerGap;

        for (let mon = 0; mon < nMonitors; mon++) {
            const workArea = this.#getTilingWorkAreaWithExtras(mon, outerGap);
            if (!workArea || workArea.width < 50 || workArea.height < 50) continue;

            // v0.5
            const wsKey = String(wsIndex);
            const monKey = String(mon);

            let wins = this.#listManagedTilingCandidates(wsIndex, mon);
            // Exclude temporarily-floating windows (detach during drag).
            if (wins.length) {
                wins = wins.filter(w => {
                    const k = String(this.#windowKey(w));
                    if (this.#floatingWindowKeys.has(k)) return false;
                    if (this.#userFloatingKeys.has(k)) return false;
                    return true;
                });
            }

            // If no tiled windows remain (e.g. user is dragging the last one),
            // update lastLayout to an empty layout so drop logic can detect “empty”.
            if (wins.length === 0) {
                if (!this.#lastLayout[wsKey]) this.#lastLayout[wsKey] = Object.create(null);
                this.#lastLayout[wsKey][monKey] = {
                    rectByKey: Object.create(null),
                    keysInOrder: [],
                    workArea: { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height },
                    innerGap,
                    outerGap,
                    ts: Date.now()
                };
                continue;
            }

            // v0.2: stable + stateful via BSP
            wins.sort((a, b) => this.#windowSortKey(a) - this.#windowSortKey(b));
            const winKeys = wins.map(w => this.#windowKey(w));

            const beforeTree = this.#getBspTree(wsIndex, mon);
            const { tree: nextTree, changed } = reconcileBspTree(beforeTree, winKeys, workArea, {
                insert: (nextTreeSoFar, newKey, wa) => {
                    // v0.63 insertion policy:
                    // - active workspace: split focused tile (or pointer placement if modifier held)
                    // - otherwise: fall back to "largest leaf"
                    return this.#chooseInsertionForNewKey(wsIndex, mon, nextTreeSoFar, wa, innerGap, newKey);
                }
            });
            if (changed) this.#setBspTree(wsIndex, mon, nextTree);

            const { keysInOrder, rectsInOrder, rectByKey } = computeRectsFromBspTree(nextTree, workArea);

            // map keys -> windows; then order by BSP leaf order
            const winByKey = new Map();
            for (const w of wins) winByKey.set(this.#windowKey(w), w);

            const orderedWins = [];
            const orderedRects = [];
            const orderedKeys = [];
            for (let i = 0; i < keysInOrder.length; i++) {
                const k = keysInOrder[i];
                const w = winByKey.get(k);
                const r = rectsInOrder[i];
                if (!w || !r) continue;
                orderedWins.push(w);
                orderedRects.push(r);
                orderedKeys.push(k);
            }

            // inner gaps (outer gap already baked into workArea)
            const gappedRects = applyInnerGapsToRects(orderedRects, workArea, innerGap);

            // store last layout for drag-to-reorder target testing
            if (!this.#lastLayout[wsKey]) this.#lastLayout[wsKey] = Object.create(null);
            const gappedByKey = Object.create(null);
            for (let i = 0; i < orderedKeys.length; i++) {
                gappedByKey[orderedKeys[i]] = gappedRects[i];
            }
            this.#lastLayout[wsKey][monKey] = {
                rectByKey: gappedByKey,
                keysInOrder: orderedKeys.slice(),
                workArea: { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height },
                innerGap,
                outerGap,
                ts: Date.now()
            };

            if (debug) {
                global.log(
                    `hyprmon: ws=${wsIndex + 1} mon=${mon} tile=${orderedWins.length} ` +
                    `workArea=(${workArea.x},${workArea.y} ${workArea.width}x${workArea.height}) ` +
                    `outerGap=${outerGap} innerGap=${innerGap}`
                );
                for (let i = 0; i < orderedWins.length; i++) {
                    let title = '';
                    try { title = orderedWins[i].get_title ? orderedWins[i].get_title() : ''; } catch (e) {}
                    const r = gappedRects[i];
                    global.log(`hyprmon:   -> ${title} rect=(${r.x},${r.y} ${r.width}x${r.height})`);
                }
            }

            // 1.5: apply geometry
            this.#applyRects(orderedWins, gappedRects, null, 350, true);
        }

        // v0.61/v0.62: keep borders aligned with the freshly computed layout (active workspace only).
        // (This is after all monitors were processed so we can merge the rect maps.)
        this.#syncTileBorders(wsIndex, 'retile', false);

        // v0.68: keep floating/sticky stacking consistent after geometry churn (throttled).
        this.#scheduleStackingSync('retile');

        // v0.682: verify compositor applied our geometry (active ws only)
        this.#scheduleVerifyWorkspace(wsIndex, 'retile');
    }
 
    // ----- v0.4 live resize helpers -----

    #isResizeGrabOp(op) {
        try {
            if (Meta.GrabOp.RESIZING !== undefined && op === Meta.GrabOp.RESIZING) return true;
            if (Meta.GrabOp.KEYBOARD_RESIZING !== undefined && op === Meta.GrabOp.KEYBOARD_RESIZING) return true;

            // Directional resize ops (common in Muffin/Mutter)
            const keys = [
                'RESIZING_N','RESIZING_S','RESIZING_E','RESIZING_W',
                'RESIZING_NE','RESIZING_NW','RESIZING_SE','RESIZING_SW',
            ];
            for (const k of keys) {
                if (Meta.GrabOp[k] !== undefined && op === Meta.GrabOp[k]) return true;
            }
        } catch (e) {}
        return false;
    }

    // Fallback inference if we only get Meta.GrabOp.RESIZING without direction.
    #inferResizeDirsFromPointer(metaWindow) {
        const dirs = [];
        try {
            const fr = metaWindow.get_frame_rect();
            const [px, py] = global.get_pointer();
            const threshold = 24; // px near edge
            if (Math.abs(px - fr.x) <= threshold) dirs.push('W');
            if (Math.abs(px - (fr.x + fr.width)) <= threshold) dirs.push('E');
            if (Math.abs(py - fr.y) <= threshold) dirs.push('N');
            if (Math.abs(py - (fr.y + fr.height)) <= threshold) dirs.push('S');
        } catch (e) {}
        // Ensure at least one direction
        return dirs.length ? dirs : ['E'];
    }

    #resizeDirsFromOp(op, metaWindow) {
        const dirs = [];
        try {
            const addIf = (name, ds) => {
                if (Meta.GrabOp[name] !== undefined && op === Meta.GrabOp[name]) {
                    for (const d of ds) dirs.push(d);
                }
            };
            addIf('RESIZING_E', ['E']);
            addIf('RESIZING_W', ['W']);
            addIf('RESIZING_N', ['N']);
            addIf('RESIZING_S', ['S']);
            addIf('RESIZING_NE', ['N','E']);
            addIf('RESIZING_NW', ['N','W']);
            addIf('RESIZING_SE', ['S','E']);
            addIf('RESIZING_SW', ['S','W']);

            // If it's the generic RESIZING / KEYBOARD_RESIZING, infer from pointer.
            if (!dirs.length) {
                if ((Meta.GrabOp.RESIZING !== undefined && op === Meta.GrabOp.RESIZING) ||
                    (Meta.GrabOp.KEYBOARD_RESIZING !== undefined && op === Meta.GrabOp.KEYBOARD_RESIZING)) {
                    return this.#inferResizeDirsFromPointer(metaWindow);
                }
            }
        } catch (e) {}
        return dirs.length ? dirs : this.#inferResizeDirsFromPointer(metaWindow);
    }

    #axisForDir(dir) {
        return (dir === 'E' || dir === 'W') ? 'x' : 'y';
    }

    #buildGappedRectByKeyFromTree(tree, workArea, innerGap) {
        const { rectByKey } = computeRectsFromBspTree(tree, workArea);
        const out = Object.create(null);
        for (const k in rectByKey) {
            const r = rectByKey[k];
            const gr = applyInnerGapsToRects([r], workArea, innerGap)[0];
            out[String(k)] = gr;
        }
        return out;
    }

    #beginResizeCtx(metaWindow, op) {
        if (!metaWindow) return false;
        const wsIndex = this.#getWorkspaceIndexOfWindow(metaWindow);
        if (this.#isUserFloating(metaWindow)) return false;
        if (wsIndex === null || !this.#isTilingEnabled(wsIndex)) return false;

        const monIndex = this.#getMonitorIndexOfWindow(metaWindow);
        if (monIndex === null) return false;

        const winKey = this.#windowKey(metaWindow);
        const eg = this.#effectiveGapsForWorkspace(wsIndex);
        const outerGap = eg.outerGap;
        const innerGap = eg.innerGap;
        const workArea = this.#getTilingWorkAreaWithExtras(monIndex, outerGap);
        if (!workArea) return false;

        // Ensure tree is reconciled before we pick targets.
        let wins = this.#listManagedTilingCandidates(wsIndex, monIndex);
        wins.sort((a, b) => this.#windowSortKey(a) - this.#windowSortKey(b));
        const winKeys = wins.map(w => this.#windowKey(w));

        let tree = this.#getBspTree(wsIndex, monIndex);
        const rec = reconcileBspTree(tree, winKeys, workArea);
        tree = rec.tree;
        if (rec.changed) this.#setBspTree(wsIndex, monIndex, tree);

        // Prefer lastLayout for adjacency (already matches what user saw),
        // but fall back to current-tree computed gapped rects.
        const wsKey = String(wsIndex);
        const monKey = String(monIndex);
        let rectByKey = this.#lastLayout?.[wsKey]?.[monKey]?.rectByKey || null;
        if (!rectByKey) rectByKey = this.#buildGappedRectByKeyFromTree(tree, workArea, innerGap);

        const dirs = this.#resizeDirsFromOp(op, metaWindow);

        const targets = [];
        for (const dir of dirs) {
            const axisWanted = this.#axisForDir(dir);
            const maxDist = Math.max(40, Math.floor(Number(innerGap) || 0) + 40);

            const neighborKey = findAdjacentKey(rectByKey, winKey, dir, maxDist, 30);

            let splitInfo = null;
            if (neighborKey) {
                splitInfo = findSplitBetweenKeys(tree, workArea, winKey, neighborKey);
                if (splitInfo && splitInfo.axis !== axisWanted) splitInfo = null;
            }
            if (!splitInfo) {
                splitInfo = findNearestSplitForKey(tree, workArea, winKey, axisWanted);
            }
            if (!splitInfo || splitInfo.axis !== axisWanted) continue;

            targets.push({
                dir,
                axis: splitInfo.axis,
                path: splitInfo.path,
                parentRect: splitInfo.rect,
                sideOfKey: splitInfo.sideOfA, // side for (winKey) in that split
                lastRatio: null,
            });
        }

        if (targets.length === 0) return false;

        this.#resizeCtx = {
            winKey,
            wsIndex,
            monIndex,
            targets,
            outerGap,
            innerGap,
            tickId: 0,
            latestFrame: null,
        };
        this.#resizingWindowKeys.add(winKey);
        return true;
    }

    #endResizeCtx(metaWindow) {
        const ctx = this.#resizeCtx;
        if (!ctx || !metaWindow) return false;
        const k = this.#windowKey(metaWindow);
        if (k !== ctx.winKey) return false;

        if (ctx.tickId) {
            try { Mainloop.source_remove(ctx.tickId); } catch (e) {}
            ctx.tickId = 0;
        }

        this.#resizeCtx = null;
        this.#resizingWindowKeys.delete(k);

        // Snap everything to the final clean layout (includes the resized window).
        this.#retileAfterDrag(ctx.wsIndex, 'resize-end');
        return true;
    }

    // Called from per-window position/size changed signals.
    // Returns true if it consumed the event for live resize.
    #maybeHandleLiveResize(metaWindow) {
        const ctx = this.#resizeCtx;
        if (!ctx || !metaWindow) return false;
        const k = this.#windowKey(metaWindow);
        if (k !== ctx.winKey) return false;

        try {
            ctx.latestFrame = metaWindow.get_frame_rect();
        } catch (e) {}

        if (!ctx.tickId) {
            ctx.tickId = Mainloop.idle_add(() => {
                ctx.tickId = 0;
                this.#applyLiveResizeTick(metaWindow);
                return false;
            });
        }

        return true;
    }

    #applyLiveResizeTick(metaWindow) {
        const ctx = this.#resizeCtx;
        if (!ctx || !metaWindow) return;
        if (this.#windowKey(metaWindow) !== ctx.winKey) return;
        if (!this.#isTilingEnabled(ctx.wsIndex)) return;

        const eg = this.#effectiveGapsForWorkspace(ctx.wsIndex);
        const outerGap = eg.outerGap;
        const innerGap = eg.innerGap;
        const workArea = this.#getTilingWorkAreaWithExtras(ctx.monIndex, outerGap);
        if (!workArea) return;

        // Current tree
        let tree = this.#getBspTree(ctx.wsIndex, ctx.monIndex);
        if (!tree) return;

        const fr = ctx.latestFrame || (() => {
            try { return metaWindow.get_frame_rect(); } catch (e) { return null; }
        })();
        if (!fr) return;

        let nextTree = tree;
        let changed = false;
        const minPx = this.#getMinTileSizePx();
        const baseOk = this.#treeRespectsMinSize(tree, workArea, innerGap, minPx);

        // Update ratios for targets (E/W affects axis x, N/S affects axis y).
        for (const t of ctx.targets) {
            const raw = computeRatioFromWindowRect(t.axis, t.sideOfKey, t.parentRect, fr, innerGap);
            const clamped = clampRatioForParent(t.axis, t.parentRect, raw, minPx);

            if (t.lastRatio !== null && Math.abs(clamped - t.lastRatio) < 0.002) {
                continue; // ignore tiny jitter
            }

            const cand = setSplitRatioAtPath(nextTree, t.path, clamped);
            // v0.68: if current layout respects min sizes, do not apply changes that would violate it.
            if (baseOk && !this.#treeRespectsMinSize(cand, workArea, innerGap, minPx)) {
                continue;
            }
            nextTree = cand;
            t.lastRatio = clamped;
            changed = true;
        }

        if (!changed) return;

        this.#setBspTree(ctx.wsIndex, ctx.monIndex, nextTree);

        // Apply live layout to neighbors (skip the actively resized window to avoid pointer-jitter).
        let wins = this.#listManagedTilingCandidates(ctx.wsIndex, ctx.monIndex);
        if (!wins.length) return;
        wins.sort((a, b) => this.#windowSortKey(a) - this.#windowSortKey(b));

        const { keysInOrder, rectsInOrder } = computeRectsFromBspTree(nextTree, workArea);
        const winByKey = new Map();
        for (const w of wins) winByKey.set(this.#windowKey(w), w);

        const orderedWins = [];
        const orderedRects = [];
        const orderedKeys = [];
        for (let i = 0; i < keysInOrder.length; i++) {
            const kk = keysInOrder[i];
            const w = winByKey.get(kk);
            const r = rectsInOrder[i];
            if (!w || !r) continue;
            orderedWins.push(w);
            orderedRects.push(r);
            orderedKeys.push(kk);
        }

        const gappedRects = applyInnerGapsToRects(orderedRects, workArea, innerGap);
        this.#applyRects(orderedWins, gappedRects, ctx.winKey, 200, false);

        // Update lastLayout to keep hit-testing accurate during/after resize.
        const wsKey = String(ctx.wsIndex);
        const monKey = String(ctx.monIndex);
        if (!this.#lastLayout[wsKey]) this.#lastLayout[wsKey] = Object.create(null);
        const gappedByKey = Object.create(null);
        for (let i = 0; i < orderedKeys.length; i++) {
            gappedByKey[orderedKeys[i]] = gappedRects[i];
        }
        this.#lastLayout[wsKey][monKey] = {
            rectByKey: gappedByKey,
            keysInOrder: orderedKeys.slice(),
            workArea: { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height },
            innerGap,
            outerGap,
            ts: Date.now()
        };

        // v0.61: live resize ticks must keep overlays glued to edges (no overlay animation here).
        this.#syncTileBorders(ctx.wsIndex, 'live-resize', true);
    }

    #isMoveGrabOp(op) {
        if (op === Meta.GrabOp.MOVING) return true;
        // Some Muffin/Mutter builds use these variants.
        try {
            if (Meta.GrabOp.KEYBOARD_MOVING !== undefined && op === Meta.GrabOp.KEYBOARD_MOVING) return true;
            if (Meta.GrabOp.MOVING_UNCONSTRAINED !== undefined && op === Meta.GrabOp.MOVING_UNCONSTRAINED) return true;
        } catch (e) {}
        return false;
    }

    #rectIntersectionArea(a, b) {
        if (!a || !b) return 0;
        const left = Math.max(a.x, b.x);
        const right = Math.min(a.x + a.width, b.x + b.width);
        const top = Math.max(a.y, b.y);
        const bottom = Math.min(a.y + a.height, b.y + b.height);
        const w = right - left;
        const h = bottom - top;
        return (w > 0 && h > 0) ? (w * h) : 0;
    }

    // Pick target tile key in a forgiving way:
    //  1) pointer position
    //  2) window center
    //  3) max overlap area
    #pickTargetKey(rectByKey, pointerX, pointerY, winRect) {
        if (!rectByKey) return null;

        const px = Number(pointerX);
        const py = Number(pointerY);
        if (Number.isFinite(px) && Number.isFinite(py)) {
            const k = findKeyAtPoint(rectByKey, px, py);
            if (k) return k;
        }

        if (winRect) {
            const cx = winRect.x + winRect.width / 2;
            const cy = winRect.y + winRect.height / 2;
            const k2 = findKeyAtPoint(rectByKey, cx, cy);
            if (k2) return k2;

            let bestKey = null;
            let bestA = 0;
            for (const k in rectByKey) {
                const a = this.#rectIntersectionArea(winRect, rectByKey[k]);
                if (a > bestA) {
                    bestA = a;
                    bestKey = k;
                } else if (a === bestA && a > 0 && bestKey !== null && String(k) < String(bestKey)) {
                    bestKey = k;
                } else if (a === bestA && a > 0 && bestKey === null) {
                    bestKey = k;
                }
            }
            return bestKey;
        }

        return null;
    }
 
    // Decide split axis + which side gets the dropped window, based on pointer position inside target rect.
    // Returns: { axis: 'x'|'y', side: 'left'|'right'|'top'|'bottom' }
    #chooseSplitFromPoint(targetRect, px, py) {
        if (!targetRect) return { axis: 'x', side: 'right' };
        const x = Number(px);
        const y = Number(py);
        const cx = targetRect.x + targetRect.width / 2;
        const cy = targetRect.y + targetRect.height / 2;
        const xx = Number.isFinite(x) ? x : cx;
        const yy = Number.isFinite(y) ? y : cy;

        const dL = Math.abs(xx - targetRect.x);
        const dR = Math.abs((targetRect.x + targetRect.width) - xx);
        const dT = Math.abs(yy - targetRect.y);
        const dB = Math.abs((targetRect.y + targetRect.height) - yy);

        if (Math.min(dL, dR) < Math.min(dT, dB)) {
            return { axis: 'x', side: (dL < dR) ? 'left' : 'right' };
        }
        return { axis: 'y', side: (dT < dB) ? 'top' : 'bottom' };
    }

    // After a user drag, enforce tiling *immediately* (idle), plus a short follow-up.
    #retileAfterDrag(wsIndex, reason = '') {
        if (!this.#isTilingEnabled(wsIndex)) return;

        Mainloop.idle_add(() => {
            this.#retileWorkspaceNow(wsIndex, false);
            // Follow-up pass for apps/frames that ignore the first resize right after grab end.
            this.#scheduleRetile(wsIndex, reason ? `${reason}-followup` : 'drag-followup');
            return false;
        });
    }

    // 1.5 debounce + "idle-ish" scheduling:
    // - coalesce multiple triggers into one pass
    // - run after a short delay so newly created windows accept move/resize
    #scheduleRetile(wsIndex, reason = '') {
        if (!this.#isTilingEnabled(wsIndex)) return;

        const existing = this.#retileTimers[wsIndex];
        if (existing) {
            Mainloop.source_remove(existing);
            this.#retileTimers[wsIndex] = 0;
        }

        // 60ms tends to be enough to avoid "new window ignores first resize"
        this.#retileTimers[wsIndex] = Mainloop.timeout_add(60, () => {
            this.#retileTimers[wsIndex] = 0;
            this.#retileWorkspaceNow(wsIndex, false);
            return false; // one-shot
        });
    }

    #toggleTilingOnActiveWorkspace() {
        const wsIndex = this.#getActiveWorkspaceIndex();
        const next = !this.#isTilingEnabled(wsIndex);
        this.#enabledWorkspaces[wsIndex] = next;

        this.#notify(`Workspace ${wsIndex + 1}: auto-tiling ${next ? 'ENABLED' : 'DISABLED'}`);

        if (next) {
            // 1.6: On enable, tile all current windows there
            this.#scheduleRetileBurst(wsIndex, 'enabled');
            this.#syncTileBorders(wsIndex, 'enabled', false);
        } else {
            // v0.61: disabling tiling on active workspace must hide borders immediately.
            this.#syncTileBorders(wsIndex, 'disabled', false);
        }
    }

    #retileActiveWorkspace() {
        const wsIndex = this.#getActiveWorkspaceIndex();
        if (!this.#isTilingEnabled(wsIndex)) {
            this.#notify(`Workspace ${wsIndex + 1}: auto-tiling is disabled`);
            return;
        }

        // v0.682: recovery semantics:
        // - clear current workspace BSP (handles monitor add/remove desync + "messed up layouts")
        // - rebuild via burst passes
        this.#clearWorkspaceTrees(wsIndex);
        this.#scheduleRetileBurst(wsIndex, 'manual-retile-recover');
        this.#notify(`Workspace ${wsIndex + 1}: layout rebuilt (recovery retile)`);
    }
 
    #onDragEndInsert(metaWindow, ctx) {
        if (!metaWindow || !ctx) return;

        const endWs = this.#getWorkspaceIndexOfWindow(metaWindow);
        const endMon = this.#getMonitorIndexOfWindow(metaWindow);

        if (endWs === null || endMon === null) {
            // Best effort cleanup
            try { this.#floatingWindowKeys.delete(ctx.winKey); } catch (e) {}
            try { this.#movingWindowKeys.delete(ctx.winKey); } catch (e) {}
            return;
        }

        // If destination workspace is not tiling-enabled, just stop managing this move.
        if (!this.#isTilingEnabled(endWs)) {
            try { this.#floatingWindowKeys.delete(ctx.winKey); } catch (e) {}
            try { this.#movingWindowKeys.delete(ctx.winKey); } catch (e) {}
            // Origin was already “gap-closed” at begin; ensure it’s clean if still enabled.
            if (this.#isTilingEnabled(ctx.wsIndex)) this.#retileAfterDrag(ctx.wsIndex, 'drag-end-dest-disabled');
            return;
        }

        const eg = this.#effectiveGapsForWorkspace(endWs);
        const outerGap = eg.outerGap;
        const innerGap = eg.innerGap;
        const workArea = this.#getTilingWorkAreaWithExtras(endMon, outerGap);
        if (!workArea) return;

        const myKey = String(ctx.winKey || this.#windowKey(metaWindow));
        const activeSide = this.#getActiveSideIndex(endWs);
        this.#setWindowSide(endWs, myKey, activeSide);

        // Reconcile destination tree against current tiled windows (excluding floating keys incl. myKey).
        let wins = this.#listManagedTilingCandidates(endWs, endMon);
        if (wins.length) {
            wins = wins.filter(w => !this.#floatingWindowKeys.has(this.#windowKey(w)));
        }
        wins.sort((a, b) => this.#windowSortKey(a) - this.#windowSortKey(b));
        const winKeys = wins.map(w => this.#windowKey(w));

        let nextTree = this.#getBspTree(endWs, endMon, activeSide);
        const rec = reconcileBspTree(nextTree, winKeys, workArea);
        nextTree = rec.tree;
        if (rec.changed) this.#setBspTree(endWs, endMon, nextTree, activeSide);

        // Build hit rects from the reconciled tree (gapped rects = what user sees).
        let hitRects = Object.create(null);
        let keysInOrder = [];
        if (nextTree) {
            const rr = computeRectsFromBspTree(nextTree, workArea);
            keysInOrder = rr.keysInOrder || [];
            const gappedRects = applyInnerGapsToRects(rr.rectsInOrder || [], workArea, innerGap);
            for (let i = 0; i < keysInOrder.length; i++) {
                hitRects[keysInOrder[i]] = gappedRects[i];
            }
        }

        const fr = metaWindow.get_frame_rect();
        const [px, py] = global.get_pointer();
        const targetKey = this.#pickTargetKey(hitRects, px, py, fr);

        let chosenTarget = targetKey;
        if (!chosenTarget && keysInOrder.length) chosenTarget = keysInOrder[0];

        // Decide insert behavior:
        // - no target => workspace/monitor empty => just make a single leaf
        // - target => split the target leaf and insert myKey on the chosen side
        let insertedTree = nextTree;
        if (!chosenTarget) {
            insertedTree = { type: 'leaf', win: myKey };
        } else {
            const tr = hitRects[String(chosenTarget)] || null;
            const { axis, side } = this.#chooseSplitFromPoint(tr, px, py);
            const ins = insertKeyBySplittingLeaf(insertedTree, chosenTarget, myKey, axis, 0.5, side);
            insertedTree = ins.tree;

            // Fallback if target leaf wasn't found (tree desync): split the whole layout.
            if (!ins.inserted) {
                const leaf = { type: 'leaf', win: myKey };
                const ax = (axis === 'y') ? 'y' : 'x';
                const putFirst =
                    (ax === 'x' && side === 'left') ||
                    (ax === 'y' && side === 'top');
                insertedTree = putFirst
                    ? { type: 'split', axis: ax, ratio: 0.5, a: leaf, b: insertedTree }
                    : { type: 'split', axis: ax, ratio: 0.5, a: insertedTree, b: leaf };
            }
        }

        // Commit tree, then re-enable tiling membership for this window.
        this.#setBspTree(endWs, endMon, insertedTree, activeSide);
        try { this.#floatingWindowKeys.delete(myKey); } catch (e) {}
        try { this.#movingWindowKeys.delete(myKey); } catch (e) {}

        // Retile destination, and origin too if moved across workspace/monitor.
        this.#retileAfterDrag(endWs, 'drag-insert');
        if (endWs !== ctx.wsIndex || endMon !== ctx.monIndex) {
            this.#retileAfterDrag(ctx.wsIndex, 'drag-cross-from');
        }
    }

    #connectWindowGrabs() {
        // start snapping when the user starts moving a window
        this.#signals.connect(global.display, 'grab-op-begin', (display, screen, window, op) => {
            if (window.window_type !== Meta.WindowType.NORMAL) return Clutter.EVENT_PROPAGATE;

            // v0.4: resizing on tiling-enabled workspaces updates BSP ratios live
            if (this.#isResizeGrabOp(op)) {
                if (this.#beginResizeCtx(window, op)) {
                    return Clutter.EVENT_PROPAGATE;
                }
                return Clutter.EVENT_PROPAGATE;
            }

            if (this.#isMoveGrabOp(op)) {
                const wsIndex = this.#getWorkspaceIndexOfWindow(window);
                const winKey = this.#windowKey(window);

                // v0.64/v0.65: user-floating/sticky windows are unmanaged by hyprmon during grabs.
                if (this.#userFloatingKeys.has(String(winKey))) return Clutter.EVENT_PROPAGATE;
                // v0.68: forced-float windows are unmanaged by hyprmon during grabs.
                if (this.#isForcedFloat(window)) return Clutter.EVENT_PROPAGATE;

                // v0.5: on tiling-enabled workspaces, MOVING becomes “detach + insert on drop”
                if (wsIndex !== null && this.#isTilingEnabled(wsIndex)) {
                    const monIndex = this.#getMonitorIndexOfWindow(window);
                    const sideIndex = this.#getWindowSide(wsIndex, winKey);

                    this.#movingWindowKeys.add(winKey);
                    this.#floatingWindowKeys.add(winKey);

                    // Persist removal immediately (old slot is gone).
                    if (monIndex !== null) {
                        const beforeTree = this.#getBspTree(wsIndex, monIndex, sideIndex);
                        const rem = removeLeafByKey(beforeTree, winKey);
                        if (rem.changed) this.#setBspTree(wsIndex, monIndex, rem.tree, sideIndex);
                    }

                    this.#dragCtx = {
                        winKey,
                        wsIndex,
                        monIndex,
                        sideIndex
                    };

                    // Close the gap immediately (retile without the dragged window).
                    Mainloop.idle_add(() => {
                        if (!this.#dragCtx || this.#dragCtx.winKey !== winKey) return false;
                        if (this.#isTilingEnabled(wsIndex)) this.#retileWorkspaceNow(wsIndex, false);
                        return false;
                    });

                    return Clutter.EVENT_PROPAGATE;
                }
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // stop snapping when the user stops moving a window
        this.#signals.connect(global.display, 'grab-op-end', (display, screen, window, op) => {
            if (window.window_type !== Meta.WindowType.NORMAL) return Clutter.EVENT_PROPAGATE;

            // v0.4: finish live resize session
            if (this.#isResizeGrabOp(op)) {
                // v0.64/v0.65: floating/sticky windows are not live-resized by tiler.
                try {
                    if (this.#userFloatingKeys.has(String(this.#windowKey(window)))) return Clutter.EVENT_PROPAGATE;
                } catch (e) {}
                if (this.#endResizeCtx(window)) {
                    return Clutter.EVENT_PROPAGATE;
                }
                return Clutter.EVENT_PROPAGATE;
            }

            if (this.#isMoveGrabOp(op)) {
                // v0.5 path: insert-on-drop
                if (this.#dragCtx) {
                    const ctx = this.#dragCtx;
                    this.#dragCtx = null;
                    // (do not delete keys here; onDragEndInsert does it after commit)
                    this.#onDragEndInsert(window, ctx);
                    return Clutter.EVENT_PROPAGATE;
                }

                // safety: in case we ever tracked the key without a ctx
                try {
                    const k = this.#windowKey(window);
                    this.#floatingWindowKeys.delete(k);
                    this.#movingWindowKeys.delete(k);
                } catch (e) {}
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }
}

module.exports = { Application };

/* application.js END */
