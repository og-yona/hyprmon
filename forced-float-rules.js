/* forced-float-rules.js */

function compileForcedFloatRules(raw) {
    const text = String(raw || '');
    const out = [];

    const parts = text
        .split(/\n|,/g)
        .map(s => String(s || '').trim())
        .filter(s => s.length > 0 && !s.startsWith('#'));

    for (const p of parts) {
        let kind = 'any';
        let pat = p;

        const m = p.match(/^(class|title)\s*:\s*(.+)$/i);
        if (m) {
            kind = String(m[1]).toLowerCase();
            pat = String(m[2] || '').trim();
        }
        if (!pat) continue;

        try {
            out.push({ kind, re: new RegExp(pat, 'i') });
        } catch (e) {
            // ignore invalid regex
        }
    }

    return out;
}

module.exports = { compileForcedFloatRules };
/* forced-float-rules.js END */
