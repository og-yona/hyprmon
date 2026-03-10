/* external-hooks.js */

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Mainloop = imports.mainloop;

class ExternalHooks {
    #uuid;
    #ctx;

    #pollId = 0;
    #statusDirty = true;
    #lastStatusWriteAt = 0;

    #baseDir;
    #statusPath;
    #commandPath;
    #lastBadCommandText = '';
    #lastBadCommandAt = 0;

    constructor(uuid, ctx) {
        this.#uuid = String(uuid || '');
        this.#ctx = ctx || Object.create(null);

        const cfg = GLib.get_user_config_dir();
        this.#baseDir = `${cfg}/${this.#uuid}/hooks`;
        this.#statusPath = `${this.#baseDir}/status.json`;
        this.#commandPath = `${this.#baseDir}/command.json`;

        this.#ensureDir();
        this.requestStatusRefresh('init');

        this.#pollId = Mainloop.timeout_add(250, () => {
            this.#pollOnce();
            return true;
        });
    }

    destroy() {
        if (this.#pollId) {
            try { Mainloop.source_remove(this.#pollId); } catch (e) {}
            this.#pollId = 0;
        }
        // best-effort final status flush
        try { this.#writeStatusNow(); } catch (e) {}
    }

    getPaths() {
        return {
            baseDir: this.#baseDir,
            statusPath: this.#statusPath,
            commandPath: this.#commandPath,
        };
    }

    requestStatusRefresh(reason = '') {
        this.#statusDirty = true;
    }

    #ensureDir() {
        try {
            const dir = Gio.File.new_for_path(this.#baseDir);
            if (!dir.query_exists(null)) dir.make_directory_with_parents(null);
        } catch (e) {
            global.logError(`hyprmon: external-hooks ensureDir failed: ${e}`);
        }
    }

    #pollOnce() {
        this.#ensureDir();
        this.#consumeCommandFile();

        const now = Date.now();
        if (this.#statusDirty || (now - this.#lastStatusWriteAt) >= 1000) {
            this.#writeStatusNow();
        }
    }

    #writeStatusNow() {
        const snapshot = (this.#ctx.getStatusSnapshot && this.#ctx.getStatusSnapshot()) || null;
        if (!snapshot) return;

        const data = JSON.stringify(snapshot, null, 2);
        try {
            const file = Gio.File.new_for_path(this.#statusPath);
            file.replace_contents(
                data,
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
            this.#statusDirty = false;
            this.#lastStatusWriteAt = Date.now();
        } catch (e) {
            global.logError(`hyprmon: external-hooks write status failed: ${e}`);
        }
    }

    #consumeCommandFile() {
        let text = null;
        let file = null;
        try {
            file = Gio.File.new_for_path(this.#commandPath);
            if (!file.query_exists(null)) return;

            const [ok, contents] = file.load_contents(null);
            if (!ok) return;
            text = String(contents || '').trim();
        } catch (e) {
            global.logError(`hyprmon: external-hooks read command failed: ${e}`);
            return;
        }

        if (!text) return;

        let payload = null;
        try {
            payload = JSON.parse(text);
        } catch (e) {
            const now = Date.now();
            if (text !== this.#lastBadCommandText || (now - this.#lastBadCommandAt) > 2000) {
                global.logError(`hyprmon: external-hooks invalid command json: ${e}`);
                this.#lastBadCommandText = text;
                this.#lastBadCommandAt = now;
            }
            return;
        }

        this.#lastBadCommandText = '';
        this.#lastBadCommandAt = 0;

        // consume once (after successful parse)
        try {
            if (file && file.query_exists(null)) file.delete(null);
        } catch (e) {
            global.logError(`hyprmon: external-hooks delete command failed: ${e}`);
            return;
        }

        const list = Array.isArray(payload) ? payload : [payload];
        for (const cmd of list) this.#executeCommand(cmd);
        this.requestStatusRefresh('command-applied');
    }

    #parseWorkspaceIndex(cmd) {
        if (!cmd || typeof cmd !== 'object') return this.#ctx.getActiveWorkspaceIndex ? this.#ctx.getActiveWorkspaceIndex() : 0;

        const rawWsIndex2 = Number(cmd.ws);
        if (Number.isFinite(rawWsIndex2) && rawWsIndex2 >= 0) return Math.floor(rawWsIndex2);

        const rawIdx = Number(cmd.wsIndex);
        if (Number.isFinite(rawIdx) && rawIdx >= 0) return Math.floor(rawIdx);

        const rawWs = Number(cmd.workspace);
        if (Number.isFinite(rawWs) && rawWs > 0) return Math.floor(rawWs - 1);

        return this.#ctx.getActiveWorkspaceIndex ? this.#ctx.getActiveWorkspaceIndex() : 0;
    }

    #executeCommand(cmd) {
        if (typeof cmd === 'string') cmd = { action: cmd };
        if (!cmd || typeof cmd !== 'object') return;

        const action = String(cmd.action || '').trim().toLowerCase();
        if (!action) return;

        const wsIndex = this.#parseWorkspaceIndex(cmd);

        try {
            if (action === 'toggle-tiling' || action === 'toggle-autotiling' || action === 'toggle-autotile') {
                if (this.#ctx.toggleTilingForWorkspace) this.#ctx.toggleTilingForWorkspace(wsIndex);
                return;
            }
            if (action === 'toggle-gaps' || action === 'toggle-workspace-gaps') {
                if (this.#ctx.toggleGapsForWorkspace) this.#ctx.toggleGapsForWorkspace(wsIndex);
                return;
            }
            if (action === 'toggle-opacity' || action === 'toggle-auto-opacity') {
                if (this.#ctx.toggleOpacityForWorkspace) this.#ctx.toggleOpacityForWorkspace(wsIndex);
                return;
            }
            if (action === 'retile' || action === 'force-retile' || action === 'reset-layout') {
                if (this.#ctx.retileWorkspace) this.#ctx.retileWorkspace(wsIndex);
                return;
            }
            if (action === 'defloat-all') {
                if (this.#ctx.defloatAllWindows) this.#ctx.defloatAllWindows();
                return;
            }
            if (action === 'switch-side-next') {
                if (this.#ctx.switchSideDelta) this.#ctx.switchSideDelta(1);
                return;
            }
            if (action === 'switch-side-prev') {
                if (this.#ctx.switchSideDelta) this.#ctx.switchSideDelta(-1);
                return;
            }
            if (action === 'show-status') {
                if (this.#ctx.showActiveStatusHud) this.#ctx.showActiveStatusHud();
                return;
            }
            if (action === 'notify') {
                if (this.#ctx.notify) this.#ctx.notify(String(cmd.message || ''));
                return;
            }

            global.log(`hyprmon: external-hooks unknown action: ${action}`);
        } catch (e) {
            global.logError(`hyprmon: external-hooks execute action '${action}' failed: ${e}`);
        }
    }
}

module.exports = { ExternalHooks };
/* external-hooks.js END */
