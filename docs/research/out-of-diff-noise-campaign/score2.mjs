import fs from 'node:fs';
const tok = (s) => new Set(String(s ?? '').toLowerCase().match(/[a-z_][a-z0-9_]{3,}/g) ?? []);
const jac = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i || 1); };
const load = (r, a) => { const p = `out/${r}-${a}/result.json`; return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p)) : null; };
const txt = (f) => tok(`${f.detail} ${f.risk} ${f.recommendation}`);
const fl = (f) => [f._primaryFile, ...(f.affectedFiles ?? [])].filter(Boolean);
const runs = ['8ec2d5e3', '0eaed211', '98f28921', '037c5d67', 'dc958e58', 'a882a4f0', 'b0a79bf3', '931cc7f3', '9435f4c4'];
const TH = Number(process.argv[2] ?? 0.2);
const tot = { overlap: [0, 0, 0, 0], referenced: [0, 0, 0, 0] }; // matched, labelled, matchedHM, labelledHM
const rows = [];
for (const r of runs) {
  const base = load(r, 'off');
  const labels = (base.findings ?? []).filter((f) => f.scope !== 'pre-existing');
  for (const a of ['overlap', 'referenced']) {
    const x = load(r, a);
    if (!x) continue;
    let m = 0, mh = 0, lh = 0;
    for (const L of labels) {
      const hm = L.severity === 'HIGH' || L.severity === 'MEDIUM';
      if (hm) lh++;
      const hit = (x.findings ?? []).some((f) => fl(f).some((p) => fl(L).includes(p)) && jac(txt(L), txt(f)) >= TH);
      if (hit) { m++; if (hm) mh++; }
    }
    tot[a][0] += m; tot[a][1] += labels.length; tot[a][2] += mh; tot[a][3] += lh;
    rows.push({ rid: r, arm: a, labelled: labels.length, matched: m, hmLabelled: lh, hmMatched: mh });
  }
}
console.table(rows);
// control: how often does baseline match ITSELF-rerun? use a882a4f0 vs 8ec2d5e3 impossible; report threshold only
console.log('threshold', TH, JSON.stringify(tot));
