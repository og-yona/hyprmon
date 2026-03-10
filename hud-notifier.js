/* hud-notifier.js */

const Clutter = imports.gi.Clutter;
const St = imports.gi.St;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;

class HudNotifier {
    #getSettingsData;
    #getActiveMonitorIndex;

    #box = null;
    #label = null;
    #timer = 0;
    #lastSoundAt = 0;

    constructor(getSettingsData, getActiveMonitorIndex) {
        this.#getSettingsData = getSettingsData;
        this.#getActiveMonitorIndex = getActiveMonitorIndex;
    }

    destroy() {
        if (this.#timer) {
            try { Mainloop.source_remove(this.#timer); } catch (e) {}
            this.#timer = 0;
        }
        try {
            if (this.#box) this.#box.destroy();
        } catch (e) {}
        this.#box = null;
        this.#label = null;
    }

    #getConfig() {
        const sd = this.#getSettingsData ? (this.#getSettingsData() || Object.create(null)) : Object.create(null);
        const rawMs = Number(sd.hudNotifyTimeoutMs?.value ?? 900);
        const timeoutMs = Math.max(120, Math.min(5000, Math.floor(Number.isFinite(rawMs) ? rawMs : 900)));
        const rawPos = String(sd.hudNotifyPosition?.value || 'top-center').trim().toLowerCase();
        const position = (rawPos === 'bottom-center' || rawPos === 'active-monitor')
            ? rawPos
            : 'top-center';
        return {
            timeoutMs,
            position,
            hudSoundEnabled: !!sd.hudNotifySoundEnabled?.value,
            sideviewSoundEnabled: !!sd.sideviewChangeSoundEnabled?.value,
            soundTheme: String(sd.hudNotifySoundTheme?.value || 'message-new-instant').trim() || 'message-new-instant',
        };
    }

    #shouldPlaySound(opts, cfg) {
        const o = (opts && typeof opts === 'object') ? opts : Object.create(null);
        if (o.silent === true || o.playSound === false) return false;
        if (o.playSound === true) return true;

        const category = String(o.category || '').trim().toLowerCase();
        if (category === 'sideview') return !!(cfg.sideviewSoundEnabled || cfg.hudSoundEnabled);
        return !!cfg.hudSoundEnabled;
    }

    #playSound(soundTheme = 'message-new-instant') {
        const now = Date.now();
        if ((now - this.#lastSoundAt) < 90) return;
        this.#lastSoundAt = now;

        try {
            const sp = (global.display && typeof global.display.get_sound_player === 'function')
                ? global.display.get_sound_player()
                : null;
            if (sp && typeof sp.play_from_theme === 'function') {
                sp.play_from_theme(soundTheme, 'hyprmon', null);
                return;
            }
        } catch (e) {}

        try {
            if (global.display && typeof global.display.beep === 'function') global.display.beep();
        } catch (e) {}
    }

    #ensure() {
        if (this.#box && this.#label) return;
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
            this.#box = box;
            this.#label = label;
        } catch (e) {
            this.#box = null;
            this.#label = null;
        }
    }

    #position() {
        if (!this.#box) return;
        try {
            const cfg = this.#getConfig();
            let mon = global.display.get_primary_monitor();
            if (cfg.position === 'active-monitor' && this.#getActiveMonitorIndex) {
                const m = this.#getActiveMonitorIndex();
                if (m !== null && Number.isFinite(m)) mon = Number(m);
            }
            const r = global.display.get_monitor_geometry(mon);
            const w = this.#box.get_width();
            const x = r.x + Math.floor((r.width - w) / 2);
            const y = (cfg.position === 'bottom-center')
                ? (r.y + r.height - 56 - this.#box.get_height())
                : (r.y + 56);
            this.#box.set_position(x, y);
        } catch (e) {}
    }

    notify(message, opts = null) {
        const text = String(message || '').trim();
        if (!text) return;

        this.#ensure();
        const cfg = this.#getConfig();
        const playSound = this.#shouldPlaySound(opts, cfg);
        if (this.#box && this.#label) {
            try {
                this.#label.set_text(text);
                this.#box.show();
                this.#box.opacity = 255;
                this.#box.queue_relayout();
                this.#position();
                if (this.#timer) {
                    Mainloop.source_remove(this.#timer);
                    this.#timer = 0;
                }
                if (playSound) this.#playSound(cfg.soundTheme);
                this.#timer = Mainloop.timeout_add(cfg.timeoutMs, () => {
                    this.#timer = 0;
                    try { if (this.#box) this.#box.hide(); } catch (e) {}
                    return false;
                });
                return;
            } catch (e) {}
        }

        // fallback
        try {
            if (Main.notify) {
                if (playSound) this.#playSound(cfg.soundTheme);
                Main.notify('hyprmon', text);
                return;
            }
        } catch (e) {}
        global.log(`hyprmon: ${text}`);
    }
}

module.exports = { HudNotifier };
/* hud-notifier.js END */
