/* bsp-resize.js */
// Helpers for v0.4 live “resize borders adjusts neighbors”.
//
// We operate on:
// - gapped tile rects (what user sees)
// - split parent rect (ungapped)
// and translate window frame geometry -> split ratio updates.

function clamp(v, lo, hi) {
    const x = Number(v);
    if (!Number.isFinite(x)) return lo;
    return Math.max(lo, Math.min(hi, x));
}

function halfGap(innerGapPx) {
    const g = Math.max(0, Math.floor(Number(innerGapPx) || 0));
    return {
        a: Math.floor(g / 2), // left/top pad on internal edges
        b: Math.ceil(g / 2),  // right/bottom pad on internal edges
        g
    };
}

// Pick the tile adjacent to myKey in direction dir:
// dir: 'E'|'W'|'N'|'S'
// rectByKey: gapped rects (what user sees)
function findAdjacentKey(rectByKey, myKey, dir, maxDistPx = 60, minOverlapPx = 30) {
    if (!rectByKey || !myKey) return null;
    const me = rectByKey[String(myKey)];
    if (!me) return null;

    const maxDist = Math.max(0, Math.floor(Number(maxDistPx) || 0));
    const minOv = Math.max(0, Math.floor(Number(minOverlapPx) || 0));

    let bestKey = null;
    let bestDist = Infinity;

    const myL = me.x;
    const myR = me.x + me.width;
    const myT = me.y;
    const myB = me.y + me.height;

    for (const k in rectByKey) {
        if (String(k) === String(myKey)) continue;
        const r = rectByKey[k];
        if (!r) continue;

        const rL = r.x;
        const rR = r.x + r.width;
        const rT = r.y;
        const rB = r.y + r.height;

        if (dir === 'E') {
            const dx = rL - myR;
            const ov = Math.min(myB, rB) - Math.max(myT, rT);
            if (ov < minOv) continue;
            if (dx < -2) continue;                 // tolerate tiny rounding overlap
            if (dx > maxDist) continue;
            if (dx < bestDist) { bestDist = dx; bestKey = String(k); }
        } else if (dir === 'W') {
            const dx = myL - rR;
            const ov = Math.min(myB, rB) - Math.max(myT, rT);
            if (ov < minOv) continue;
            if (dx < -2) continue;
            if (dx > maxDist) continue;
            if (dx < bestDist) { bestDist = dx; bestKey = String(k); }
        } else if (dir === 'S') {
            const dy = rT - myB;
            const ov = Math.min(myR, rR) - Math.max(myL, rL);
            if (ov < minOv) continue;
            if (dy < -2) continue;
            if (dy > maxDist) continue;
            if (dy < bestDist) { bestDist = dy; bestKey = String(k); }
        } else if (dir === 'N') {
            const dy = myT - rB;
            const ov = Math.min(myR, rR) - Math.max(myL, rL);
            if (ov < minOv) continue;
            if (dy < -2) continue;
            if (dy > maxDist) continue;
            if (dy < bestDist) { bestDist = dy; bestKey = String(k); }
        }
    }

    return bestKey;
}

// Given:
//  - split axis ('x'|'y')
//  - sideOfKey ('a'|'b') of the resized window relative to split
//  - parentRect of the split (ungapped)
//  - winFrameRect (actual window frame rect, generally matches gapped tile)
// Return raw ratio (0..1) before clamping.
function computeRatioFromWindowRect(axis, sideOfKey, parentRect, winFrameRect, innerGapPx) {
    if (!parentRect || !winFrameRect) return 0.5;
    const ax = (axis === 'y') ? 'y' : 'x';
    const side = (sideOfKey === 'b') ? 'b' : 'a';
    const hg = halfGap(innerGapPx);

    if (ax === 'x') {
        // split boundary X in parent coords
        const boundaryX = (side === 'a')
            ? (winFrameRect.x + winFrameRect.width + hg.b) // left side: add right pad
            : (winFrameRect.x - hg.a);                     // right side: subtract left pad
        const ratio = (boundaryX - parentRect.x) / Math.max(1, parentRect.width);
        return ratio;
    } else {
        const boundaryY = (side === 'a')
            ? (winFrameRect.y + winFrameRect.height + hg.b) // top side: add bottom pad
            : (winFrameRect.y - hg.a);                      // bottom side: subtract top pad
        const ratio = (boundaryY - parentRect.y) / Math.max(1, parentRect.height);
        return ratio;
    }
}

function clampRatioForParent(axis, parentRect, rawRatio, minPx = 120) {
    if (!parentRect) return clamp(rawRatio, 0.05, 0.95);
    const ax = (axis === 'y') ? 'y' : 'x';
    const len = ax === 'x' ? parentRect.width : parentRect.height;
    const min = Math.max(0, Math.floor(Number(minPx) || 0));
    if (!Number.isFinite(len) || len <= 2 * min || len <= 0) return 0.5;
    const lo = min / len;
    const hi = 1 - (min / len);
    return clamp(rawRatio, lo, hi);
}

module.exports = {
    findAdjacentKey,
    computeRatioFromWindowRect,
    clampRatioForParent,
};
/* bsp-resize.js END */