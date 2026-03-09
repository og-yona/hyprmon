/* window-grabs.js */

const Clutter = imports.gi.Clutter;
const Meta = imports.gi.Meta;

function isResizeGrabOp(op) {
    try {
        if (Meta.GrabOp.RESIZING !== undefined && op === Meta.GrabOp.RESIZING) return true;
        if (Meta.GrabOp.KEYBOARD_RESIZING !== undefined && op === Meta.GrabOp.KEYBOARD_RESIZING) return true;

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

function isMoveGrabOp(op) {
    if (op === Meta.GrabOp.MOVING) return true;
    try {
        if (Meta.GrabOp.KEYBOARD_MOVING !== undefined && op === Meta.GrabOp.KEYBOARD_MOVING) return true;
        if (Meta.GrabOp.MOVING_UNCONSTRAINED !== undefined && op === Meta.GrabOp.MOVING_UNCONSTRAINED) return true;
    } catch (e) {}
    return false;
}

function connectWindowGrabs(signalManager, handlers) {
    const h = handlers || Object.create(null);

    signalManager.connect(global.display, 'grab-op-begin', (display, screen, window, op) => {
        if (!window || window.window_type !== Meta.WindowType.NORMAL) return Clutter.EVENT_PROPAGATE;

        if (isResizeGrabOp(op)) {
            try { if (typeof h.onResizeBegin === 'function') h.onResizeBegin(window, op); } catch (e) {}
            return Clutter.EVENT_PROPAGATE;
        }

        if (isMoveGrabOp(op)) {
            try { if (typeof h.onMoveBegin === 'function') h.onMoveBegin(window, op); } catch (e) {}
            return Clutter.EVENT_PROPAGATE;
        }

        return Clutter.EVENT_PROPAGATE;
    });

    signalManager.connect(global.display, 'grab-op-end', (display, screen, window, op) => {
        if (!window || window.window_type !== Meta.WindowType.NORMAL) return Clutter.EVENT_PROPAGATE;

        if (isResizeGrabOp(op)) {
            try { if (typeof h.onResizeEnd === 'function') h.onResizeEnd(window, op); } catch (e) {}
            return Clutter.EVENT_PROPAGATE;
        }

        if (isMoveGrabOp(op)) {
            try { if (typeof h.onMoveEnd === 'function') h.onMoveEnd(window, op); } catch (e) {}
            return Clutter.EVENT_PROPAGATE;
        }

        return Clutter.EVENT_PROPAGATE;
    });
}

module.exports = { connectWindowGrabs, isResizeGrabOp, isMoveGrabOp };
/* window-grabs.js END */
