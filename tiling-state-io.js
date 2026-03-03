/* tiling-state-io.js */
// Persist hyprmon tiling state (BSP tree) under ~/.config/<uuid>/tiling-state.json

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

class TilingStateIO {
    #uuid;

    constructor(uuid) {
        this.#uuid = uuid;
    }

    #dirPath() {
        const configDir = GLib.get_user_config_dir();
        return `${configDir}/${this.#uuid}`;
    }

    #filePath() {
        return `${this.#dirPath()}/tiling-state.json`;
    }

    #ensureDir() {
        const dir = Gio.File.new_for_path(this.#dirPath());
        if (!dir.query_exists(null)) {
            dir.make_directory_with_parents(null);
        }
    }

    loadState() {
        try {
            const file = Gio.File.new_for_path(this.#filePath());
            if (!file.query_exists(null)) return null;

            const [ok, contents] = file.load_contents(null);
            if (!ok) return null;

            const text = String(contents);
            const data = JSON.parse(text);

            // very light validation
            if (!data || typeof data !== 'object') return null;
            if (!data.workspaces || typeof data.workspaces !== 'object') {
                data.workspaces = Object.create(null);
            }
            // v0.66: per-workspace flags live under data.workspaces[wsKey]
            // Ensure shape: { monitors: {...}, gapsDisabled?: bool }
            try {
                for (const wsKey in data.workspaces) {
                    const ws = data.workspaces[wsKey];
                    if (!ws || typeof ws !== 'object') {
                        data.workspaces[wsKey] = { monitors: Object.create(null) };
                        continue;
                    }
                    if (!ws.monitors || typeof ws.monitors !== 'object') ws.monitors = Object.create(null);
                    if (ws.gapsDisabled === undefined) ws.gapsDisabled = false;
                }
            } catch (e) {}
            // v0.64/v0.65: per-window flags (floating/sticky) persisted for extension reloads
            if (!data.windowFlags || typeof data.windowFlags !== 'object')
                data.windowFlags = Object.create(null);
            if (!data.version) data.version = 1;

            return data;
        } catch (e) {
            global.logError(`hyprmon: loadState failed: ${e}`);
            return null;
        }
    }

    saveState(state) {
        try {
            this.#ensureDir();
            const file = Gio.File.new_for_path(this.#filePath());
            const jsonData = JSON.stringify(state || { version: 1, workspaces: Object.create(null) }, null, 2);

            const [success] = file.replace_contents(
                jsonData,
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );

            return !!success;
        } catch (e) {
            global.logError(`hyprmon: saveState failed: ${e}`);
            return false;
        }
    }
}

module.exports = { TilingStateIO };
/* tiling-state-io.js END */