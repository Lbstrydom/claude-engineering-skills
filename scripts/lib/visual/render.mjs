/**
 * @fileoverview Human + JSON rendering for /visual-audit (plan §3, §7). Pure.
 * Two panels mirror nav-audit: a contracted-surface scorecard + the findings list.
 * A static run prints the honesty banner ("paint findings require --verify").
 *
 * @module scripts/lib/visual/render
 */

const SEV_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3, info: 4 };

/**
 * @param {object} args
 * @param {boolean} args.staticMode
 * @param {string|null} [args.url]
 * @param {object[]} [args.findings]
 * @param {object[]} [args.diagnostics]
 * @param {object[]} [args.scorecard]
 * @param {string[]} [args.unverifiableSurfaces]
 * @param {string[]} [args.statesCollected]
 * @param {string[]} [args.warnings]
 * @param {number} [args.gateBlockers]
 * @returns {string}
 */
export function renderHuman({ staticMode, url = null, findings = [], diagnostics = [], scorecard = [], unverifiableSurfaces = [], statesCollected = [], warnings = [], gateBlockers = 0 }) {
  const L = [];
  L.push('═══════════════════════════════════════');
  if (staticMode) {
    L.push('  /visual-audit — STATIC (no browser)');
    L.push('  ⚠ Paint findings require a live run: `visual-audit --verify <url>`');
  } else {
    L.push('  /visual-audit — LIVE VERIFY');
    L.push(`  URL: ${url}`);
    L.push(`  States: ${statesCollected.join(', ') || '(none)'}`);
  }
  L.push('═══════════════════════════════════════');

  if (staticMode) {
    L.push('', `Source-coherence diagnostics (report-only): ${diagnostics.length}`);
    for (const d of diagnostics.slice(0, 20)) L.push(`  • [${d.class}] ${d.detail}`);
    if (diagnostics.length > 20) L.push(`  …and ${diagnostics.length - 20} more`);
    return L.join('\n');
  }

  // Scorecard
  L.push('', 'Contracted-surface scorecard:');
  if (!scorecard.length) L.push('  (no contracted surfaces)');
  for (const row of scorecard) {
    const mark = row.status === 'unverified' ? '🟡' : row.violations > 0 ? '🔴' : '🟢';
    L.push(`  ${mark} ${row.surfaceId} — ${row.status === 'unverified' ? 'UNVERIFIED (capture stall/empty)' : `${row.violations} violation(s)`}`);
  }

  // Findings
  const sorted = [...findings].sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
  const gated = sorted.filter((f) => f.gateEligible);
  L.push('', `Findings: ${findings.length} (${gated.length} gate-eligible)`);
  for (const f of sorted.slice(0, 40)) {
    const tag = f.gateEligible ? '⛔' : '·';
    const loc = [f.surfaceId, f.nodeKey, f.device, f.theme].filter(Boolean).join('/');
    L.push(`  ${tag} [${f.severity}] ${f.class} — ${loc}${f.property ? ` {${f.property}}` : ''}`);
    if (f.expected || f.actual) L.push(`      expected: ${f.expected ?? '—'} | actual: ${f.actual ?? '—'}`);
  }
  if (sorted.length > 40) L.push(`  …and ${sorted.length - 40} more`);

  if (unverifiableSurfaces.length) L.push('', `⚠ Unverifiable surfaces (degraded, not gated): ${unverifiableSurfaces.join(', ')}`);
  for (const w of warnings) L.push(`⚠ ${w}`);
  L.push('', gateBlockers > 0 ? `⛔ ${gateBlockers} gate-blocking finding(s) on the changed surface` : '✓ no gate-blocking findings on the changed surface');
  return L.join('\n');
}

/** Build the JSON envelope (the `--out`/`--format json` payload). */
export function buildJson({ staticMode, url, findings, diagnostics, scorecard, unverifiableSurfaces, statesCollected, warnings, gateBlockers }) {
  return {
    mode: staticMode ? 'static' : 'verify',
    url: url ?? null,
    statesCollected: statesCollected ?? [],
    findings: findings ?? [],
    diagnostics: diagnostics ?? [],
    scorecard: scorecard ?? [],
    unverifiableSurfaces: unverifiableSurfaces ?? [],
    warnings: warnings ?? [],
    gateBlockers: gateBlockers ?? 0,
  };
}

/** Build the per-surface scorecard from findings + capture status. */
export function buildScorecard(surfaces, findings, unverifiableSurfaces) {
  const unver = new Set(unverifiableSurfaces || []);
  const violationsBySurface = new Map();
  for (const f of findings || []) {
    if (!f.gateEligible) continue;
    violationsBySurface.set(f.surfaceId, (violationsBySurface.get(f.surfaceId) || 0) + 1);
  }
  return (surfaces || []).map((s) => ({
    surfaceId: s.id,
    status: unver.has(s.id) ? 'unverified' : 'verified',
    violations: violationsBySurface.get(s.id) || 0,
  }));
}
