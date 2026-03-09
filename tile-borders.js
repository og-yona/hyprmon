/* tile-borders.js */
// v0.61/v0.62: ultra-light tile border overlays (non-reactive).
//
// Design goals:
// - Only used for the ACTIVE workspace (Application enforces that).
// - Draw borders only (transparent inside).
// - Optional overlay-only animation (safe) via actor.ease when available.
// - No input handling (reactive=false).
//
// v0.682:
// - Borders are no longer drawn in Main.uiGroup (which sits above ALL windows).
// - Each border actor is inserted as a sibling just ABOVE the window's own actor,
//   in whatever group/layer the compositor currently uses for that window.
//   This ensures borders:
//     * do NOT draw over dialogs/popups that are above the window
//     * do NOT draw over floating/sticky/always-on-top windows that are above tiled windows
//     * DO draw for floating/sticky windows (if Application includes them in the sync set)

const Clutter = imports.gi.Clutter;
const St = imports.gi.St;
const Main = imports.ui.main;

class TileBorders {
    // key -> { actor: St.Widget, parent: Clutter.Actor|null, anchor: Clutter.Actor|null, _style: string }
    #byKey = Object.create(null);
    #shown = false;

    show() {
        if (this.#shown) return;
        this.#shown = true;
        for (const k in this.#byKey) {
            try { this.#byKey[k].actor.show(); } catch (e) {}
        }
    }

    hide() {
        if (!this.#shown) return;
        this.#shown = false;
        for (const k in this.#byKey) {
            try { this.#byKey[k].actor.hide(); } catch (e) {}
        }
    }

    clear() {
        for (const k in this.#byKey) {
            try { this.#byKey[k].actor.destroy(); } catch (e) {}
        }
        this.#byKey = Object.create(null);
    }

    #clamp01(v) { const x = Number(v); return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 1; }
    #clamp255(v) { const x = Number(v); return Number.isFinite(x) ? Math.max(0, Math.min(255, x)) : 0; }

    #parseColor(s) {
        const str = String(s || '').trim();
        if (!str) return null;

        // rgba()/rgb()
        let m = str.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/i);
        if (m) {
            return {
                r: this.#clamp255(m[1]),
                g: this.#clamp255(m[2]),
                b: this.#clamp255(m[3]),
                a: this.#clamp01(m[4] !== undefined ? m[4] : 1),
            };
        }

        // #RRGGBB / #RRGGBBAA
        if (str.startsWith('#')) {
            const hex = str.slice(1);
            if (hex.length === 6 || hex.length === 8) {
                const r = parseInt(hex.slice(0, 2), 16);
                const g = parseInt(hex.slice(2, 4), 16);
                const b = parseInt(hex.slice(4, 6), 16);
                const a = (hex.length === 8) ? (parseInt(hex.slice(6, 8), 16) / 255) : 1;
                if ([r, g, b].every(n => Number.isFinite(n))) return { r, g, b, a: this.#clamp01(a) };
            }
        }

        return null;
    }

    #rgbaStr(c) {
        if (!c) return 'rgba(255,255,255,1)';
        return `rgba(${Math.round(this.#clamp255(c.r))},${Math.round(this.#clamp255(c.g))},${Math.round(this.#clamp255(c.b))},${this.#clamp01(c.a)})`;
    }

    #blend(a, b, t) {
        const tt = this.#clamp01(t);
        if (!a) return b;
        if (!b) return a;
        return {
            r: a.r * (1 - tt) + b.r * tt,
            g: a.g * (1 - tt) + b.g * tt,
            b: a.b * (1 - tt) + b.b * tt,
            a: a.a * (1 - tt) + b.a * tt,
        };
    }

    destroy() {
        try { this.clear(); } catch (e) {}
        this.#shown = false;
    }

    #styleFor(mode, isActive, cfg) {
        const w = Math.max(0, Math.floor(Number(isActive ? cfg.activeWidth : cfg.inactiveWidth) || 0));
        const baseActive = this.#parseColor(cfg.activeColor);
        const baseInactive = this.#parseColor(cfg.inactiveColor);
        const floatC = this.#parseColor(cfg.floatColor);
        const stickyC = this.#parseColor(cfg.stickyColor);

        let col = isActive ? baseActive : baseInactive;

        if (cfg.specialEnabled && (mode === 'floating' || mode === 'sticky')) {
            const special = (mode === 'sticky') ? stickyC : floatC;
            if (isActive) {
                // Blend: keep user's active slightly dominant.
                col = this.#blend(baseActive, special, 0.45);
            } else {
                col = special || col;
            }
        }

        const c = this.#rgbaStr(col);
        const r = Math.max(0, Math.floor(Number(cfg.radius) || 0));
        // Transparent fill; border only.
        return `background-color: rgba(0,0,0,0); border: ${w}px solid ${c}; border-radius: ${r}px;`;
    }
 
    #defaultParent() {
        // Prefer the compositor window group if available.
        try { if (global && global.window_group) return global.window_group; } catch (e) {}
        try { if (Main && Main.uiGroup) return Main.uiGroup; } catch (e) {}
        return null;
    }

    #parentOf(actor) {
        try { return actor ? actor.get_parent() : null; } catch (e) {}
        return null;
    }

    #ensureAboveAnchor(borderActor, anchorActor) {
        if (!borderActor || !anchorActor) return;
        const pA = this.#parentOf(borderActor);
        const pB = this.#parentOf(anchorActor);
        if (!pA || !pB || pA !== pB) return;

        // Best-effort ways to place border just above anchor.
        try { borderActor.raise(anchorActor); return; } catch (e) {}
        try { pA.set_child_above_sibling(borderActor, anchorActor); return; } catch (e) {}
        try {
            // Some builds expose insert_child_above on the container.
            pA.remove_child(borderActor);
            pA.insert_child_above(borderActor, anchorActor);
            return;
        } catch (e) {}
    }

    #parentStageOffset(parent) {
        // Returns parent's transformed position in stage coords.
        try {
            if (parent && typeof parent.get_transformed_position === 'function') {
                const p = parent.get_transformed_position();
                // gjs returns [x,y]
                return [Math.round(p[0] || 0), Math.round(p[1] || 0)];
            }
        } catch (e) {}
        return [0, 0];
    }

    #moveResize(actor, rect, animate, durationMs, parent) {
        const [ox, oy] = this.#parentStageOffset(parent);
        const x = Math.round(rect.x - ox);
        const y = Math.round(rect.y - oy);
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

    // entriesByKey:
    //   { [key]: { rect:{x,y,width,height}, anchor?:Clutter.Actor|null } }
    // Also accepts legacy value = rect.
    // focusedKey: string|null
    // cfg: { activeWidth, inactiveWidth, activeColor, inactiveColor, radius, animate, durationMs }
    sync(entriesByKey, focusedKey, cfg) {
        if (!entriesByKey || typeof entriesByKey !== 'object') {
            this.clear();
            return;
        }

        const want = new Set(Object.keys(entriesByKey).map(String));

        // Remove stale actors
        for (const k in this.#byKey) {
            if (!want.has(String(k))) {
                try { this.#byKey[k].actor.destroy(); } catch (e) {}
                delete this.#byKey[k];
            }
        }

        // Create/update actors
        for (const k of want) {
            const entry = entriesByKey[k];
            const rect = (entry && entry.rect) ? entry.rect : entry;
            const anchor = (entry && entry.anchor) ? entry.anchor : null;
            if (!rect) continue;

            const mode = (entry && entry.mode) ? String(entry.mode) : 'tiled';
            let rec = this.#byKey[k];
            if (!rec) {
                const actor = new St.Widget({
                    reactive: false,
                    can_focus: false,
                    track_hover: false,
                    style: 'background-color: rgba(0,0,0,0);'
                });
                rec = { actor, parent: null, anchor: null, _style: '' };
                this.#byKey[k] = rec;
            }

            const isActive = (focusedKey !== null && String(k) === String(focusedKey));
            const style = this.#styleFor(mode, isActive, cfg);

            try {
                if (rec._style !== style) {
                    rec.actor.set_style(style);
                    rec._style = style;
                }
            } catch (e) {
                // If styling fails for some reason, keep it non-fatal.
            }

            // Ensure the actor is parented into the window's layer/group (best-effort).
            let parent = null;
            const anchorParent = anchor ? this.#parentOf(anchor) : null;
            if (anchorParent) parent = anchorParent;
            if (!parent) parent = this.#defaultParent();
            if (!parent) continue;

            if (rec.parent !== parent) {
                try {
                    if (rec.parent) rec.parent.remove_child(rec.actor);
                } catch (e) {}
                try { parent.add_child(rec.actor); } catch (e) {}
                rec.parent = parent;
            }
            rec.anchor = anchor;

            // Keep border just above the window actor (so it respects real stacking).
            if (anchor) this.#ensureAboveAnchor(rec.actor, anchor);

            try {
                this.#moveResize(rec.actor, rect, !!cfg.animate, Math.max(0, Math.floor(Number(cfg.durationMs) || 0)), rec.parent);
            } catch (e) {
                // Fallback: no animation
                try {
                    const [ox, oy] = this.#parentStageOffset(rec.parent);
                    rec.actor.set_position(Math.round(rect.x - ox), Math.round(rect.y - oy));
                    rec.actor.set_size(Math.max(0, Math.round(rect.width)), Math.max(0, Math.round(rect.height)));
                } catch (e2) {}
            }

            // Honor shown/hidden state.
            try { this.#shown ? rec.actor.show() : rec.actor.hide(); } catch (e) {}
        }
    }
}

module.exports = { TileBorders };
/* tile-borders.js END */