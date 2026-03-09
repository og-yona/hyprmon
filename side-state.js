/* side-state.js */

class SideState {
    #getState;
    #onSave;
    #onClearWorkspaceLastLayout;

    constructor(getState, onSave, onClearWorkspaceLastLayout) {
        this.#getState = getState;
        this.#onSave = onSave;
        this.#onClearWorkspaceLastLayout = onClearWorkspaceLastLayout;
    }

    #state() {
        const s = this.#getState ? this.#getState() : null;
        if (!s || typeof s !== 'object') return null;
        if (!s.workspaces || typeof s.workspaces !== 'object') s.workspaces = Object.create(null);
        return s;
    }

    getWorkspaceState(wsIndex, create = false) {
        const state = this.#state();
        if (!state) return null;

        const wsKey = String(wsIndex);
        let ws = state.workspaces?.[wsKey] || null;
        if (!ws && create) {
            ws = {
                activeSide: 0,
                windowSides: Object.create(null),
                sides: Object.create(null),
                gapsDisabled: false,
                opacityDisabled: false
            };
            ws.sides['0'] = { monitors: Object.create(null) };
            state.workspaces[wsKey] = ws;
        }
        if (!ws) return null;

        if (ws.gapsDisabled === undefined) ws.gapsDisabled = false;
        if (ws.opacityDisabled === undefined) ws.opacityDisabled = false;
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

    getActiveSideIndex(wsIndex) {
        const ws = this.getWorkspaceState(wsIndex, true);
        return ws ? ws.activeSide : 0;
    }

    setActiveSideIndex(wsIndex, sideIndex) {
        const ws = this.getWorkspaceState(wsIndex, true);
        if (!ws) return 0;
        const next = Math.max(0, Math.floor(Number(sideIndex) || 0));
        ws.activeSide = next;
        if (!ws.sides[String(next)] || typeof ws.sides[String(next)] !== 'object')
            ws.sides[String(next)] = { monitors: Object.create(null) };
        if (this.#onSave) this.#onSave('active-side-changed');
        return next;
    }

    getWindowSide(wsIndex, winKey) {
        const ws = this.getWorkspaceState(wsIndex, true);
        if (!ws) return 0;
        const k = String(winKey || '');
        if (!k) return ws.activeSide;
        const raw = ws.windowSides[k];
        const n = Number(raw);
        return (Number.isFinite(n) && n >= 0) ? Math.floor(n) : 0;
    }

    setWindowSide(wsIndex, winKey, sideIndex) {
        const ws = this.getWorkspaceState(wsIndex, true);
        if (!ws) return;
        const k = String(winKey || '');
        if (!k) return;
        ws.windowSides[k] = Math.max(0, Math.floor(Number(sideIndex) || 0));
        if (this.#onSave) this.#onSave('window-side-changed');
    }

    deleteWindowSide(wsIndex, winKey) {
        const ws = this.getWorkspaceState(wsIndex, false);
        if (!ws) return;
        const k = String(winKey || '');
        if (!k) return;
        if (ws.windowSides && ws.windowSides[k] !== undefined) {
            delete ws.windowSides[k];
            if (this.#onSave) this.#onSave('window-side-deleted');
        }
    }

    ensureSideState(wsIndex, sideIndex) {
        const ws = this.getWorkspaceState(wsIndex, true);
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

    getSideMonState(wsIndex, sideIndex, monIndex, create = false) {
        const monKey = String(monIndex);
        const side = create
            ? this.ensureSideState(wsIndex, sideIndex)
            : this.getWorkspaceState(wsIndex, false)?.sides?.[String(Math.max(0, Math.floor(Number(sideIndex) || 0)))] || null;
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

    getWsMonState(wsIndex, monIndex, create = false) {
        return this.getSideMonState(wsIndex, this.getActiveSideIndex(wsIndex), monIndex, create);
    }

    isGapsDisabled(wsIndex) {
        const ws = this.getWorkspaceState(wsIndex, false);
        if (!ws || typeof ws !== 'object') return false;
        return !!ws.gapsDisabled;
    }

    setGapsDisabled(wsIndex, disabled) {
        const ws = this.getWorkspaceState(wsIndex, true);
        if (!ws) return;
        ws.gapsDisabled = !!disabled;
        if (this.#onSave) this.#onSave('gaps-toggle');
    }

    isOpacityDisabled(wsIndex) {
        const ws = this.getWorkspaceState(wsIndex, false);
        if (!ws || typeof ws !== 'object') return false;
        return !!ws.opacityDisabled;
    }

    setOpacityDisabled(wsIndex, disabled) {
        const ws = this.getWorkspaceState(wsIndex, true);
        if (!ws) return;
        ws.opacityDisabled = !!disabled;
        if (this.#onSave) this.#onSave('opacity-toggle');
    }

    getBspTree(wsIndex, monIndex, sideIndex = null) {
        const side = (sideIndex === null || sideIndex === undefined)
            ? this.getActiveSideIndex(wsIndex)
            : Math.max(0, Math.floor(Number(sideIndex) || 0));
        const st = this.getSideMonState(wsIndex, side, monIndex, false);
        return st ? (st.tree || null) : null;
    }

    setBspTree(wsIndex, monIndex, tree, sideIndex = null) {
        const side = (sideIndex === null || sideIndex === undefined)
            ? this.getActiveSideIndex(wsIndex)
            : Math.max(0, Math.floor(Number(sideIndex) || 0));
        const st = this.getSideMonState(wsIndex, side, monIndex, true);
        st.tree = tree || null;
        if (this.#onSave) this.#onSave('tree-changed');
    }

    clearSideTrees(wsIndex, sideIndex) {
        const side = this.ensureSideState(wsIndex, sideIndex);
        if (!side) return;
        side.monitors = Object.create(null);
        if (this.#onSave) this.#onSave('workspace-side-reset');
    }

    clearWorkspaceTrees(wsIndex, activeSideOnly = false) {
        const ws = this.getWorkspaceState(wsIndex, false);
        if (!ws) return;
        if (activeSideOnly) {
            this.clearSideTrees(wsIndex, this.getActiveSideIndex(wsIndex));
        } else {
            ws.sides = Object.create(null);
            ws.sides[String(this.getActiveSideIndex(wsIndex))] = { monitors: Object.create(null) };
            if (this.#onSave) this.#onSave('workspace-reset');
        }
        if (this.#onClearWorkspaceLastLayout) this.#onClearWorkspaceLastLayout(wsIndex);
    }
}

module.exports = { SideState };
/* side-state.js END */
