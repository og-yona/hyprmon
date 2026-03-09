/* hotkeys.js */

const Main = imports.ui.main;

class Hotkeys {
    #getSettingsData;
    #handlers;

    // key id -> settings key -> handler key
    static BINDINGS = [
        ['hyprmon-toggle-gaps', 'gapsToggleHotkey', 'toggleGapsOnActiveWorkspace'],
        ['hyprmon-toggle-opacity', 'opacityToggleHotkey', 'toggleOpacityOnActiveWorkspace'],

        ['hyprmon-focus-left', 'focusLeftHotkey', 'focusNeighborLeft'],
        ['hyprmon-focus-right', 'focusRightHotkey', 'focusNeighborRight'],
        ['hyprmon-focus-up', 'focusUpHotkey', 'focusNeighborUp'],
        ['hyprmon-focus-down', 'focusDownHotkey', 'focusNeighborDown'],

        ['hyprmon-swap-left', 'swapLeftHotkey', 'swapNeighborLeft'],
        ['hyprmon-swap-right', 'swapRightHotkey', 'swapNeighborRight'],
        ['hyprmon-swap-up', 'swapUpHotkey', 'swapNeighborUp'],
        ['hyprmon-swap-down', 'swapDownHotkey', 'swapNeighborDown'],

        ['hyprmon-grow-left', 'growLeftHotkey', 'growActiveLeft'],
        ['hyprmon-grow-right', 'growRightHotkey', 'growActiveRight'],
        ['hyprmon-grow-up', 'growUpHotkey', 'growActiveUp'],
        ['hyprmon-grow-down', 'growDownHotkey', 'growActiveDown'],

        ['hyprmon-shrink-left', 'shrinkLeftHotkey', 'shrinkActiveLeft'],
        ['hyprmon-shrink-right', 'shrinkRightHotkey', 'shrinkActiveRight'],
        ['hyprmon-shrink-up', 'shrinkUpHotkey', 'shrinkActiveUp'],
        ['hyprmon-shrink-down', 'shrinkDownHotkey', 'shrinkActiveDown'],

        ['hyprmon-change-shape-left', 'changeShapeLeftHotkey', 'changeShapeLeft'],
        ['hyprmon-change-shape-right', 'changeShapeRightHotkey', 'changeShapeRight'],
        ['hyprmon-change-shape-up', 'changeShapeUpHotkey', 'changeShapeUp'],
        ['hyprmon-change-shape-down', 'changeShapeDownHotkey', 'changeShapeDown'],

        ['hyprmon-side-prev', 'sideviewPrevHotkey', 'switchSidePrev'],
        ['hyprmon-side-next', 'sideviewNextHotkey', 'switchSideNext'],
        ['hyprmon-side-move-prev', 'moveWindowToPrevSideHotkey', 'moveWindowToPrevSide'],
        ['hyprmon-side-move-next', 'moveWindowToNextSideHotkey', 'moveWindowToNextSide'],

        ['hyprmon-toggle-tiling', 'tilingToggleHotkey', 'toggleTilingOnActiveWorkspace'],
        ['hyprmon-tile-now', 'tilingRetileHotkey', 'retileActiveWorkspace'],
        ['hyprmon-reset-layout', 'tilingResetHotkey', 'resetLayoutOnActiveWorkspace'],

        ['hyprmon-toggle-float', 'floatToggleHotkey', 'toggleFloatOnFocusedWindow'],
        ['hyprmon-defloat-all', 'defloatAllHotkey', 'defloatAllWindows'],
        ['hyprmon-toggle-sticky', 'stickyToggleHotkey', 'toggleStickyOnFocusedWindow'],
    ];

    constructor(getSettingsData, handlers) {
        this.#getSettingsData = getSettingsData;
        this.#handlers = handlers || Object.create(null);
    }

    disable() {
        for (const [id] of Hotkeys.BINDINGS) {
            try { Main.keybindingManager.removeHotKey(id); } catch (e) {}
        }
    }

    enable() {
        this.disable();

        const sd = this.#getSettingsData ? (this.#getSettingsData() || Object.create(null)) : Object.create(null);

        for (const [id, settingKey, handlerKey] of Hotkeys.BINDINGS) {
            const binding = String(sd?.[settingKey]?.value || '').trim();
            if (!binding) continue;

            const handler = this.#handlers[handlerKey];
            if (typeof handler !== 'function') continue;

            try { Main.keybindingManager.addHotKey(id, binding, handler); } catch (e) {}
        }
    }
}

module.exports = { Hotkeys };
/* hotkeys.js END */
