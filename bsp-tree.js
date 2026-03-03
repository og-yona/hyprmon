/* bsp-tree.js */
// Minimal BSP tree for v0.2/v0.3.
// v0.4 adds helpers for live resize (update split ratios).
// v0.5 adds remove/insert primitives for “detach + insert-on-drop”.
// Node forms:
//  - leaf:  { type: 'leaf', win: '123' }
//  - split: { type: 'split', axis: 'x'|'y', ratio: 0.5, a: <node>, b: <node> }
//
// Rules:
//  - rect computation is deterministic (a then b traversal)
//  - insertion splits largest leaf along longer axis, old leaf in a, new in b
//  - removal prunes empty branches (split with 1 child collapses)

function isLeaf(n) {
    return !!n && n.type === 'leaf';
}
 
function clamp(v, lo, hi) {
    const x = Number(v);
    if (!Number.isFinite(x)) return lo;
    return Math.max(lo, Math.min(hi, x));
}

function cloneNode(n) {
    if (!n) return null;
    if (n.type === 'leaf') return { type: 'leaf', win: String(n.win) };
    return {
        type: 'split',
        axis: n.axis === 'y' ? 'y' : 'x',
        ratio: typeof n.ratio === 'number' ? n.ratio : 0.5,
        a: cloneNode(n.a),
        b: cloneNode(n.b),
    };
}

function rectArea(r) {
    return r && r.width > 0 && r.height > 0 ? (r.width * r.height) : 0;
}

function splitRectByAxis(r, axis, ratio) {
    const rr = Math.max(0.05, Math.min(0.95, Number(ratio) || 0.5));
    if (axis === 'y') {
        const h1 = Math.max(1, Math.floor(r.height * rr));
        const h2 = Math.max(1, r.height - h1);
        return [
            { x: r.x, y: r.y, width: r.width, height: h1 },
            { x: r.x, y: r.y + h1, width: r.width, height: h2 },
        ];
    }
    // axis x
    const w1 = Math.max(1, Math.floor(r.width * rr));
    const w2 = Math.max(1, r.width - w1);
    return [
        { x: r.x, y: r.y, width: w1, height: r.height },
        { x: r.x + w1, y: r.y, width: w2, height: r.height },
    ];
}

function computeRectsFromBspTree(tree, workArea) {
    const rectByKey = Object.create(null);
    const keysInOrder = [];
    const rectsInOrder = [];

    function rec(node, rect) {
        if (!node) return;
        if (isLeaf(node)) {
            const k = String(node.win);
            rectByKey[k] = rect;
            keysInOrder.push(k);
            rectsInOrder.push(rect);
            return;
        }
        if (node.type !== 'split') return;

        const axis = node.axis === 'y' ? 'y' : 'x';
        const ratio = typeof node.ratio === 'number' ? node.ratio : 0.5;
        const [ra, rb] = splitRectByAxis(rect, axis, ratio);

        rec(node.a, ra);
        rec(node.b, rb);
    }

    if (tree && workArea) {
        rec(tree, { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height });
    }

    return { rectByKey, keysInOrder, rectsInOrder };
}

function leafKeySet(tree, out = new Set()) {
    if (!tree) return out;
    if (isLeaf(tree)) {
        out.add(String(tree.win));
        return out;
    }
    leafKeySet(tree.a, out);
    leafKeySet(tree.b, out);
    return out;
}

function pruneMissing(tree, allowedSet) {
    if (!tree) return null;
    if (isLeaf(tree)) {
        return allowedSet.has(String(tree.win)) ? tree : null;
    }
    if (tree.type !== 'split') return null;

    const a = pruneMissing(tree.a, allowedSet);
    const b = pruneMissing(tree.b, allowedSet);

    if (!a && !b) return null;
    if (!a) return b;
    if (!b) return a;

    return { ...tree, a, b };
}

function replaceLeaf(tree, targetKey, newNode) {
    if (!tree) return null;
    if (isLeaf(tree)) {
        return String(tree.win) === String(targetKey) ? newNode : tree;
    }
    if (tree.type !== 'split') return tree;
    const a = replaceLeaf(tree.a, targetKey, newNode);
    const b = replaceLeaf(tree.b, targetKey, newNode);
    return { ...tree, a, b };
}
 
// Remove one leaf by key and collapse now-empty splits.
// Returns { tree, changed }.
function removeLeafByKey(tree, targetKey) {
    const t = String(targetKey);
    const before = JSON.stringify(tree || null);

    function rec(node) {
        if (!node) return null;
        if (isLeaf(node)) {
            return String(node.win) === t ? null : node;
        }
        if (node.type !== 'split') return node;

        const a = rec(node.a);
        const b = rec(node.b);

        if (!a && !b) return null;
        if (!a) return b;
        if (!b) return a;
        return { ...node, a, b };
    }

    const next = rec(cloneNode(tree));
    const after = JSON.stringify(next || null);
    return { tree: next, changed: before !== after };
}

// Insert newKey by splitting an existing leaf (targetKey).
// axis:
//   - 'x' => vertical split (left/right)
//   - 'y' => horizontal split (top/bottom)
// newSide:
//   - axis 'x': 'left' | 'right'
//   - axis 'y': 'top'  | 'bottom'
//
// Returns { tree, changed, inserted }.
function insertKeyBySplittingLeaf(tree, targetKey, newKey, axis, ratio = 0.5, newSide = '') {
    const t = String(targetKey);
    const nk = String(newKey);
    const ax = (axis === 'y') ? 'y' : 'x';
    const rr = clamp(ratio, 0.05, 0.95);

    const before = JSON.stringify(tree || null);
    let inserted = false;

    function rec(node) {
        if (!node) return null;
        if (isLeaf(node)) {
            if (String(node.win) !== t) return node;

            inserted = true;
            const oldLeaf = { type: 'leaf', win: String(node.win) };
            const newLeaf = { type: 'leaf', win: nk };

            const side = String(newSide || '').toLowerCase();
            let a = oldLeaf, b = newLeaf;
            if (ax === 'x') {
                // left/right
                if (side === 'left') { a = newLeaf; b = oldLeaf; }
                else { a = oldLeaf; b = newLeaf; } // default right
            } else {
                // top/bottom
                if (side === 'top') { a = newLeaf; b = oldLeaf; }
                else { a = oldLeaf; b = newLeaf; } // default bottom
            }

            return { type: 'split', axis: ax, ratio: rr, a, b };
        }

        if (node.type !== 'split') return node;
        return { ...node, a: rec(node.a), b: rec(node.b) };
    }

    let next = rec(cloneNode(tree));

    // If tree was empty/null, treat as just a single leaf.
    if (!next) {
        next = { type: 'leaf', win: nk };
        inserted = true;
    }

    const after = JSON.stringify(next || null);
    return { tree: next, changed: before !== after, inserted };
}

function insertKeyBySplittingLargest(tree, newKey, workArea) {
    const k = String(newKey);
    if (!tree) return { type: 'leaf', win: k };

    // compute leaf rects and pick the largest leaf
    const { rectByKey, keysInOrder } = computeRectsFromBspTree(tree, workArea);
    if (!keysInOrder.length) return { type: 'leaf', win: k };

    let bestKey = keysInOrder[0];
    let bestArea = rectArea(rectByKey[bestKey]);

    for (let i = 1; i < keysInOrder.length; i++) {
        const kk = keysInOrder[i];
        const a = rectArea(rectByKey[kk]);
        if (a > bestArea) {
            bestArea = a;
            bestKey = kk;
        }
    }

    const leafRect = rectByKey[bestKey];
    const axis = (leafRect && leafRect.width >= leafRect.height) ? 'x' : 'y';

    const splitNode = {
        type: 'split',
        axis,
        ratio: 0.5,
        a: { type: 'leaf', win: String(bestKey) },
        b: { type: 'leaf', win: k },
    };

    return replaceLeaf(tree, bestKey, splitNode);
}

// v0.63: reconcile can optionally prefer a specific insertion target instead of "largest leaf".
// opts.insert(nextTree, newKey, workArea) -> { targetKey, axis, ratio, side } | null
// If it returns a spec and insertion succeeds, that is used; otherwise we fall back to splitting the largest leaf.
function reconcileBspTree(tree, winKeys, workArea, opts = null) {
    const wanted = (winKeys || []).map(String);
    const wantedSet = new Set(wanted);

    const before = JSON.stringify(tree || null);

    // remove vanished windows
    let next = pruneMissing(cloneNode(tree), wantedSet);

    // add new windows in deterministic order (caller provides stable order)
    const existing = leafKeySet(next);
    for (const k of wanted) {
        if (existing.has(k)) continue;

        let didPreferredInsert = false;
        if (opts && typeof opts.insert === 'function') {
            try {
                const spec = opts.insert(next, String(k), workArea);
                if (spec && spec.targetKey) {
                    const axis = spec.axis === 'y' ? 'y' : 'x';
                    const ratio = typeof spec.ratio === 'number' ? spec.ratio : 0.5;
                    const side = spec.side || '';
                    const ins = insertKeyBySplittingLeaf(next, spec.targetKey, String(k), axis, ratio, side);
                    if (ins && ins.inserted) {
                        next = ins.tree;
                        didPreferredInsert = true;
                    }
                }
            } catch (e) {
                // ignore and fall back
            }
        }

        if (!didPreferredInsert) next = insertKeyBySplittingLargest(next, k, workArea);
        existing.add(String(k));
    }

    const after = JSON.stringify(next || null);
    return { tree: next, changed: before !== after };
}

function swapLeavesByKey(tree, aKey, bKey) {
    const a = String(aKey);
    const b = String(bKey);
    const before = JSON.stringify(tree || null);

    function rec(n) {
        if (!n) return null;
        if (isLeaf(n)) {
            const w = String(n.win);
            if (w === a) return { ...n, win: b };
            if (w === b) return { ...n, win: a };
            return n;
        }
        if (n.type !== 'split') return n;
        return { ...n, a: rec(n.a), b: rec(n.b) };
    }

    const next = rec(cloneNode(tree));
    const after = JSON.stringify(next || null);
    return { tree: next, changed: before !== after };
}

function findKeyAtPoint(rectByKey, x, y) {
    if (!rectByKey) return null;
    const px = Number(x);
    const py = Number(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null;

    for (const k in rectByKey) {
        const r = rectByKey[k];
        if (!r) continue;
        if (px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height) {
            return String(k);
        }
    }
    return null;
}

// Update (immutably) a split node ratio by path.
// path: array of 'a'/'b' directions from root to the target split node.
function setSplitRatioAtPath(tree, path, newRatio) {
    if (!tree) return null;
    const p = Array.isArray(path) ? path : [];
    const rr = Math.max(0.05, Math.min(0.95, Number(newRatio) || 0.5));

    function rec(node, idx) {
        if (!node) return null;
        const n = cloneNode(node);
        if (idx >= p.length) {
            if (n.type === 'split') n.ratio = rr;
            return n;
        }
        if (n.type !== 'split') return n;
        const step = p[idx];
        if (step === 'a') n.a = rec(n.a, idx + 1);
        else if (step === 'b') n.b = rec(n.b, idx + 1);
        return n;
    }

    return rec(tree, 0);
}

// Find the split node (LCA) separating keyA and keyB.
// Returns:
//  { path, axis, rect, sideOfA }
//   - path: directions to reach THAT split node from root
//   - rect: parent rect of that split (in workArea coords)
//   - sideOfA: 'a' if A is in split.a subtree, else 'b'
function findSplitBetweenKeys(tree, workArea, keyA, keyB) {
    if (!tree || !workArea) return null;
    const A = String(keyA);
    const B = String(keyB);
    if (!A || !B || A === B) return null;

    function rec(node, rect, path) {
        if (!node) return { hasA: false, hasB: false, found: null };
        if (isLeaf(node)) {
            const k = String(node.win);
            return { hasA: k === A, hasB: k === B, found: null };
        }
        if (node.type !== 'split') return { hasA: false, hasB: false, found: null };

        const axis = node.axis === 'y' ? 'y' : 'x';
        const ratio = typeof node.ratio === 'number' ? node.ratio : 0.5;
        const [ra, rb] = splitRectByAxis(rect, axis, ratio);

        const left = rec(node.a, ra, path.concat('a'));
        if (left.found) return { hasA: true, hasB: true, found: left.found };
        const right = rec(node.b, rb, path.concat('b'));
        if (right.found) return { hasA: true, hasB: true, found: right.found };

        const hasA = left.hasA || right.hasA;
        const hasB = left.hasB || right.hasB;

        // This node is the first split where A and B are in different branches => LCA split.
        if ((left.hasA && right.hasB) || (left.hasB && right.hasA)) {
            const sideOfA = left.hasA ? 'a' : 'b';
            return {
                hasA: true,
                hasB: true,
                found: { path, axis, rect, sideOfA }
            };
        }

        return { hasA, hasB, found: null };
    }

    const rootRect = { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height };
    const r = rec(tree, rootRect, []);
    return r.found || null;
}

// Fallback: find the deepest split along the path to key that matches axisWanted.
// Returns { path, axis, rect, sideOfA } where sideOfA is key's side in that split.
function findNearestSplitForKey(tree, workArea, keyA, axisWanted) {
    if (!tree || !workArea) return null;
    const A = String(keyA);
    const want = axisWanted === 'y' ? 'y' : 'x';

    let best = null;
    let bestDepth = -1;

    function rec(node, rect, path, depth) {
        if (!node) return false;
        if (isLeaf(node)) return String(node.win) === A;
        if (node.type !== 'split') return false;

        const axis = node.axis === 'y' ? 'y' : 'x';
        const ratio = typeof node.ratio === 'number' ? node.ratio : 0.5;
        const [ra, rb] = splitRectByAxis(rect, axis, ratio);

        const hasAInA = rec(node.a, ra, path.concat('a'), depth + 1);
        const hasAInB = rec(node.b, rb, path.concat('b'), depth + 1);
        const has = hasAInA || hasAInB;

        if (has && axis === want) {
            if (depth > bestDepth) {
                bestDepth = depth;
                best = { path, axis, rect, sideOfA: hasAInA ? 'a' : 'b' };
            }
        }

        return has;
    }

    const rootRect = { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height };
    rec(tree, rootRect, [], 0);
    return best;
}

module.exports = {
    reconcileBspTree,
    computeRectsFromBspTree,
    swapLeavesByKey,
    removeLeafByKey,
    insertKeyBySplittingLeaf,
    findKeyAtPoint,
    setSplitRatioAtPath,
    findSplitBetweenKeys,
    findNearestSplitForKey,
};
/* bsp-tree.js END */