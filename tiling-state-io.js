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
            // v2 sideviews:
            // Ensure shape:
            // {
            //   activeSide: number,
            //   windowSides: { [winKey]: sideIndex },
            //   sides: { [sideIndex]: { monitors: {...} } },
            //   gapsDisabled?: bool
            // }
            try {
                for (const wsKey in data.workspaces) {
                    const ws = data.workspaces[wsKey];
                    if (!ws || typeof ws !== 'object') {
                        data.workspaces[wsKey] = {
                            activeSide: 0,
                            windowSides: Object.create(null),
                            sides: Object.create(null),
                            gapsDisabled: false
                        };
                        data.workspaces[wsKey].sides['0'] = { monitors: Object.create(null) };
                        continue;
                    }
                    if (ws.gapsDisabled === undefined) ws.gapsDisabled = false;

                    if (!ws.windowSides || typeof ws.windowSides !== 'object') ws.windowSides = Object.create(null);

                    // migrate v1 { monitors: {...} } -> v2 { sides: { "0": { monitors } } }
                    const oldMonitors = (ws.monitors && typeof ws.monitors === 'object')
                        ? ws.monitors
                        : Object.create(null);
                    if (!ws.sides || typeof ws.sides !== 'object') ws.sides = Object.create(null);
                    if (!ws.sides['0'] || typeof ws.sides['0'] !== 'object') ws.sides['0'] = { monitors: oldMonitors };
                    else if (!ws.sides['0'].monitors || typeof ws.sides['0'].monitors !== 'object') ws.sides['0'].monitors = oldMonitors;

                    // normalize side entries
                    for (const sideKey in ws.sides) {
                        const side = ws.sides[sideKey];
                        if (!side || typeof side !== 'object') {
                            ws.sides[sideKey] = { monitors: Object.create(null) };
                            continue;
                        }
                        if (!side.monitors || typeof side.monitors !== 'object') side.monitors = Object.create(null);
                    }

                    const active = Number(ws.activeSide);
                    ws.activeSide = (Number.isFinite(active) && active >= 0) ? Math.floor(active) : 0;
                    if (!ws.sides[String(ws.activeSide)]) ws.sides[String(ws.activeSide)] = { monitors: Object.create(null) };

                    // keep legacy field harmlessly if present; runtime reads v2 fields.
                }
            } catch (e) {}
            // v0.64/v0.65: per-window flags (floating/sticky) persisted for extension reloads
            if (!data.windowFlags || typeof data.windowFlags !== 'object')
                data.windowFlags = Object.create(null);
            if (!data.version || data.version < 2) data.version = 2;

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
            const jsonData = JSON.stringify(state || { version: 2, workspaces: Object.create(null) }, null, 2);

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
