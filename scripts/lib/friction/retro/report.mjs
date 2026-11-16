/**
 * @fileoverview Analysis composition + markdown rendering (plan
 * docs/plans/harness-retro.md §2 components 6–9). `analyseScan` turns a raw
 * `runScan` result into the ranked, inventory-checked candidate list and the
 * tripwire promotion pass that the scan artifact carries; the renderers print it.
 *
 * @module scripts/lib/friction/retro/report
 */
import { aggregateSessions, rankCandidates, canonicalSessions } from './aggregate.mjs';
import { buildHarnessInventory } from './inventory.mjs';
import { scanTripwires } from './memory-tripwires.mjs';

/**
 * @param {object} scan - a `runScan` result
 * @param {{decisions: {byFingerprint: Map<string, object>}, inventory: {docs: object[], errors: object[]}, memoryDir: string|null, top?: number}} ctx
 */
export function analyseScan(scan, { decisions, inventory: inv, memoryDir, top = 5 }) {
  // ONE canonical session set for every count this analysis reports (audit R3-H4/M5).
  const sessions = canonicalSessions(scan.sessions);
  const aggregates = aggregateSessions(sessions, scan.fingerprints);
  const ranked = rankCandidates(aggregates, { decisions: decisions.byFingerprint, top });
  const inventory = buildHarnessInventory(inv.docs);
  const candidates = ranked.candidates.map((c) => ({ ...c, identity: `fingerprint:${c.fingerprint}`, coveredBy: inventory.coverageFor(c.label) }));

  const sessionsByFingerprint = new Map();
  const occurrencesByFingerprint = new Map();
  for (const s of sessions) {
    for (const [fp, n] of Object.entries(s.counts)) {
      if (!sessionsByFingerprint.has(fp)) sessionsByFingerprint.set(fp, new Set());
      sessionsByFingerprint.get(fp).add(s.sessionKey);
      occurrencesByFingerprint.set(fp, (occurrencesByFingerprint.get(fp) ?? 0) + n);
    }
  }
  const tripwires = memoryDir
    ? scanTripwires({ memoryDir, fingerprints: scan.fingerprints, sessionsByFingerprint, occurrencesByFingerprint, idf: inventory.idf, decisions: decisions.byIdentity ?? new Map() })
    : [];
  const summary = {
    sessions: sessions.length,
    fingerprints: Object.keys(scan.fingerprints).length,
    strong: ranked.strongCount,
    weak: ranked.weakCount,
    oneOffs: ranked.oneOffs,
    beyondTop: ranked.beyondTop,
    enforcedSeen: ranked.enforced.length,
    previouslyRejected: ranked.previouslyRejected.length,
    promotionCandidates: tripwires.filter((t) => t.status === 'promotion-candidate').length,
    tripwiresWithoutEvidence: tripwires.filter((t) => t.status === 'no-evidence').length,
    inventoryErrors: inv.errors.length,
  };
  return { candidates, tripwires, summary, enforced: ranked.enforced, previouslyRejected: ranked.previouslyRejected };
}

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');

/** Human-readable scan report. Always says what it scanned; UNMEASURED is loud. */
export function renderScanReport(a) {
  const lines = [];
  const head = a.measured
    ? `harness-retro scan ${a.scanId} — MEASURED`
    : `harness-retro scan ${a.scanId} — UNMEASURED (${a.reason}) — this is NOT a clean result`;
  lines.push(`# ${head}`, '');
  lines.push(`Scanned ${a.files.read}/${a.files.listed} transcript files (${a.files.readErrors} read errors, ${a.files.unparseableLines} unparseable lines) `
    + `→ ${a.summary.sessions ?? 0} sessions in scope, window ${a.requested.since} → ${a.requested.until}.`);
  lines.push(`Excluded: ${a.excluded.otherRepo} other-repo, ${a.excluded.unresolved} unresolved-repo; ${a.excluded.incomplete} incomplete (reported, not effect evidence).`);
  if (Number.isFinite(a.elapsedMs)) lines.push(`Cost: ${(a.elapsedMs / 1000).toFixed(1)} s wall, no model tokens (the scan is deterministic).`);
  // Coverage is separate from measurement (audit R3-M3): a measured scan can still
  // be unfit as effect-metric evidence.
  lines.push(`Coverage: ${a.completed ? 'complete' : 'INCOMPLETE — this scan is not effect-metric evidence (read/enumeration errors or an incomplete in-scope session)'}.`, '');
  if (a.summary?.inventoryErrors) lines.push(`WARNING: ${a.summary.inventoryErrors} harness surface(s) could not be read — "covered by" hints are incomplete.`, '');
  if (!a.measured) return `${lines.join('\n')}\n`;
  if (a.candidates.length === 0) {
    lines.push(`No NEW recurring failure (≥2 sessions) in ${a.summary.sessions} sessions — ${a.summary.oneOffs} one-off fingerprints counted, none ranked.`);
  } else {
    lines.push('| # | identity | kind | tool | sessions | occ | repos | rank | covered by | label |', '|---|---|---|---|---|---|---|---|---|---|');
    a.candidates.forEach((c, i) => {
      const cov = c.coveredBy.map((h) => `${h.surface}:${h.ref} (${h.score})`).join('; ') || '—';
      lines.push(`| ${i + 1} | \`${c.identity}\` | ${c.kind} | ${esc(c.tool)} | ${c.sessions} | ${c.occurrences} | ${c.repos} | ${c.rank} | ${esc(cov)} | ${esc(c.label)} |`);
    });
  }
  // Decided fingerprints that recurred are reported, not silently dropped (audit R3-H3).
  if (a.summary.enforcedSeen || a.summary.previouslyRejected) {
    lines.push('', `Also recurred but already decided (not re-ranked): ${a.summary.enforcedSeen} enforced, ${a.summary.previouslyRejected} previously rejected — run \`effect\` for the enforced ones.`);
  }
  const promos = a.tripwires.filter((t) => t.status === 'promotion-candidate');
  lines.push('', `Tripwires: ${promos.length} promotion candidate(s), ${a.summary.tripwiresWithoutEvidence} with no evidence in this window (no-evidence ≠ dead).`);
  for (const t of promos.slice(0, 10)) lines.push(`- \`${t.identity}\` — fired in ${t.firedSessions} sessions (${t.occurrences} occurrences, ${t.matchedFingerprints.length} fingerprints)`);
  return `${lines.join('\n')}\n`;
}

/** Proposal report for the human. */
export function renderProposals(envelope) {
  const lines = [`# harness-retro proposals — scan ${envelope.scanId}`, '', 'Propose, never apply: each change below needs a human yes, then lands as its own PR carrying its test and its registry entry.', ''];
  for (const p of envelope.proposals) {
    if (p.verdict !== 'propose') { lines.push(`## \`${p.identity}\` — ${p.verdict}`, '', p.reason, ...(p.coveredBy ? ['', `Covered by: ${p.coveredBy}`] : []), ''); continue; }
    lines.push(`## \`${p.identity}\` → ${p.layer}${p.coordinatorChore ? ' (coordinator chore → script)' : ''}`, '');
    lines.push(`**Failure prevented** — ${p.failurePrevented.summary} (seen in ${p.failurePrevented.sessions} sessions, ${p.failurePrevented.occurrences} occurrences).`, '');
    lines.push(`**Change** — ${p.change.description}`, '', `Files: ${p.change.files.map((f) => `\`${f}\``).join(', ')}`, '');
    lines.push(`**Positive control** — \`${p.positiveControl.test}\`: ${p.positiveControl.assertion}`, '');
    if (p.ladderJustification) lines.push(`**Why not a lower layer** — ${p.ladderJustification}`, '');
  }
  return `${lines.join('\n')}\n`;
}
