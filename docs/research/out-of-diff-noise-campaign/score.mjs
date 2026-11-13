import fs from 'node:fs';
const cand = JSON.parse(fs.readFileSync(process.env.TEMP + '/corpus-cand.json', 'utf8'));
const tok = (s) => new Set(String(s ?? '').toLowerCase().match(/[a-z_][a-z0-9_]{3,}/g) ?? []);
const jac = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i || 1); };
const load = (r, a) => { const p = `out/${r}-${a}/result.json`; return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p)) : null; };
const best = (cf, res) => {
  let b = { s: 0 };
  for (const f of res.findings ?? []) {
    const files = [f._primaryFile, ...(f.affectedFiles ?? [])].filter(Boolean);
    if (!files.some((x) => x === cf.pf || String(x).endsWith(cf.pf))) continue;
    const s = jac(tok(cf.detail_snapshot), tok(`${f.detail} ${f.risk} ${f.recommendation}`));
    if (s > b.s) b = { s, scope: f.scope ?? 'in-diff', sev: f.severity };
  }
  return b;
};
const rows = [];
for (const c of cand) {
  const rid = c.rid.slice(0, 8);
  const row = { rid, pf: c.pf.split('/').pop(), sev: c.severity };
  for (const a of ['off', 'overlap', 'referenced']) {
    const r = load(rid, a);
    const v = r ? best(c, r) : null;
    row[a] = v ? `${v.s.toFixed(2)}${v.scope === 'pre-existing' ? 'P' : ''}` : 'n/a';
  }
  rows.push(row);
}
console.table(rows);
const runs = [...new Set(cand.map((c) => c.rid.slice(0, 8)))];
const t = [];
for (const r of runs) {
  const o = { rid: r };
  for (const a of ['off', 'overlap', 'referenced']) {
    const x = load(r, a);
    if (!x) { o[a] = 'n/a'; continue; }
    const f = x.findings ?? [];
    const pre = f.filter((y) => y.scope === 'pre-existing').length;
    o[a] = `${f.length - pre}+${pre}P $${(x._usage?.costUsd ?? 0).toFixed(2)}`;
  }
  t.push(o);
}
console.table(t);
