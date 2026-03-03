/* tile-borders.js */
// v0.61/v0.62: ultra-light tile border overlays (non-reactive).
//
// Design goals:
// - Only used for the ACTIVE workspace (Application enforces that).
// - Draw borders only (transparent inside).
// - Optional overlay-only animation (safe) via actor.ease when available.
// - No input handling (reactive=false).

const Clutter = imports.gi.Clutter;
const St = imports.gi.St;
const Main = imports.ui.main;

class TileBorders {
    #group = null;
    #byKey = Object.create(null); // key -> St.Widget
    #shown = false;

    #ensureGroup() {
        if (this.#group) return;
        this.#group = new Clutter.Actor({ reactive: false });
        // uiGroup is above windows; borders remain visible without touching window actors.
        Main.uiGroup.add_child(this.#group);
        this.#group.hide();
        this.#shown = false;
    }

    show() {
        this.#ensureGroup();
        if (this.#shown) return;
        try { this.#group.show(); } catch (e) {}
        this.#shown = true;
    }

    hide() {
        this.#ensureGroup();
        if (!this.#shown) return;
        try { this.#group.hide(); } catch (e) {}
        this.#shown = false;
    }

    clear() {
        for (const k in this.#byKey) {
            try { this.#byKey[k].destroy(); } catch (e) {}
        }
        this.#byKey = Object.create(null);
    }

    destroy() {
        try { this.clear(); } catch (e) {}
        if (this.#group) {
            try { this.#group.destroy(); } catch (e) {}
        }
        this.#group = null;
        this.#shown = false;
    }

    #styleFor(isActive, cfg) {
        const w = Math.max(0, Math.floor(Number(isActive ? cfg.activeWidth : cfg.inactiveWidth) || 0));
        const c = String(isActive ? cfg.activeColor : cfg.inactiveColor);
        const r = Math.max(0, Math.floor(Number(cfg.radius) || 0));
        // Transparent fill; border only.
        return `background-color: rgba(0,0,0,0); border: ${w}px solid ${c}; border-radius: ${r}px;`;
    }

    #moveResize(actor, rect, animate, durationMs) {
        const x = Math.round(rect.x);
        const y = Math.round(rect.y);
        const w = Math.max(0, Math.round(rect.width));
        const h = Math.max(0, Math.round(rect.height));

        if (!animate || durationMs <= 0 || typeof actor.ease !== 'function') {
            actor.set_position(x, y);
            actor.set_size(w, h);
            return;
        }

        // Best-effort; if this throws on some builds, we fall back silently in caller.
        actor.ease({
            x, y,
            width: w,
            height: h,
            duration: durationMs,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });
    }

    // rectByKey: { [key]: {x,y,width,height} }
    // focusedKey: string|null
    // cfg: { activeWidth, inactiveWidth, activeColor, inactiveColor, radius, animate, durationMs }
    sync(rectByKey, focusedKey, cfg) {
        this.#ensureGroup();
        if (!rectByKey || typeof rectByKey !== 'object') {
            this.clear();
            return;
        }

        const want = new Set(Object.keys(rectByKey).map(String));

        // Remove stale actors
        for (const k in this.#byKey) {
            if (!want.has(String(k))) {
                try { this.#byKey[k].destroy(); } catch (e) {}
                delete this.#byKey[k];
            }
        }

        // Create/update actors
        for (const k of want) {
            const rect = rectByKey[k];
            if (!rect) continue;

            let a = this.#byKey[k];
            if (!a) {
                a = new St.Widget({
                    reactive: false,
                    can_focus: false,
                    track_hover: false,
                    style: 'background-color: rgba(0,0,0,0);'
                });
                this.#byKey[k] = a;
                this.#group.add_child(a);
            }

            const isActive = (focusedKey !== null && String(k) === String(focusedKey));
            const style = this.#styleFor(isActive, cfg);

            try {
                if (a._hyprmonStyle !== style) {
                    a.set_style(style);
                    a._hyprmonStyle = style;
                }
            } catch (e) {
                // If styling fails for some reason, keep it non-fatal.
            }

            // Keep borders above each other deterministically: focused on top.
            try { a.raise_top(); } catch (e) {}

            try {
                this.#moveResize(a, rect, !!cfg.animate, Math.max(0, Math.floor(Number(cfg.durationMs) || 0)));
            } catch (e) {
                // Fallback: no animation
                try {
                    a.set_position(Math.round(rect.x), Math.round(rect.y));
                    a.set_size(Math.max(0, Math.round(rect.width)), Math.max(0, Math.round(rect.height)));
                } catch (e2) {}
            }
        }

        // Keep group above in uiGroup (best effort).
        try { this.#group.raise_top(); } catch (e) {}
    }
}

module.exports = { TileBorders };
/* tile-borders.js END */