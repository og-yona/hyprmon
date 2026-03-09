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
        return { timeoutMs, position };
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

    notify(message) {
        const text = String(message || '').trim();
        if (!text) return;

        this.#ensure();
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
                const cfg = this.#getConfig();
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
                Main.notify('hyprmon', text);
                return;
            }
        } catch (e) {}
        global.log(`hyprmon: ${text}`);
    }
}

module.exports = { HudNotifier };
/* hud-notifier.js END */
