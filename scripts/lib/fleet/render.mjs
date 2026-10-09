/**
 * @fileoverview Pure text renderers for /fleet — kept out of the CLI so the CLI
 * stays a dispatcher. Input is the plain data `overlap.mjs` produced; output is
 * a string. An unqueried source is always rendered as "not queried (reason)",
 * never as an empty list.
 *
 * Train-result rendering belongs with the train (Cluster B).
 *
 * @module scripts/lib/fleet/render
 */

import { prWarnings } from './gh-facts.mjs';

const BANNER = (inv) => `registry incomplete: ${inv.length} record${inv.length === 1 ? '' : 's'} unreadable — claims may be missing`;

/** The optional PR-checks column's provenance line, or null when it is complete. */
function checksLine(prs) {
  const f = prs?.fields?.checks;
  if (!prs?.queried || !f) return null;
  if (!f.queried) return `PR checks: not queried (${f.reason ?? 'unknown reason'})`;
  if (f.missing > 0) return `PR checks: partial (${f.missing} unknown)`;
  return null;
}

function sourceLine(label, src) {
  if (!src?.queried) return `${label}: not queried (${src?.reason ?? 'unknown reason'})`;
  if (src.complete === false) return `${label}: ${src.reason ?? 'list may be incomplete'}`;
  if (src.partial) return `${label}: partial — some per-branch counts unavailable`;
  return null;
}

/** Sources that did not give a full answer, as short labels. Empty = inventory complete. */
export function incompleteSources(status) {
  const out = [];
  const { worktrees, branches, prs } = status.sources;
  if (!worktrees.queried) out.push('worktrees');
  if (!branches.queried) out.push('branches'); else if (branches.partial) out.push('branches (partial counts)');
  if (!prs.queried) out.push('PRs'); else if (prs.complete === false) out.push(`PRs (may be truncated at ${prs.limit ?? '?'})`);
  if (checksLine(prs)) out.push('PR checks');
  if (!status.registry.complete) out.push('registry');
  return out;
}

/** "2 merged into base, 5 idle > 14 days" — the reasons `splitHidden` counted. */
function hiddenWhy(h) {
  const parts = [];
  if (h.merged) parts.push(`${h.merged} merged into base`);
  if (h.landed) parts.push(`${h.landed} landed (squash / merged PR)`);
  if (h.idle) parts.push(`${h.idle} idle > ${h.idleDays ?? '?'} day${h.idleDays === 1 ? '' : 's'}`);
  return parts.length ? parts.join(', ') : 'stale / merged';
}

/** @param {object} it a status item @param {number|null} [nowMs] */
function itemBlock(it, nowMs = null) {
  const lines = [];
  const head = [it.id, `[${it.display}]`];
  if (it.branch && it.branch !== it.id) head.push(`branch ${it.branch}`);
  lines.push(head.join('  '));
  if (it.intent) lines.push(`    intent: ${it.intent}`);
  const meta = [];
  if (it.ahead !== null && it.ahead !== undefined) meta.push(`ahead ${it.ahead} / behind ${it.behind ?? '?'}`);
  if (it.worktree) meta.push(`worktree ${it.worktree}${it.worktreeState && it.worktreeState !== 'present' ? ` (${it.worktreeState})` : ''}`);
  if (it.pr) meta.push(`PR #${it.pr.number}${it.pr.isDraft ? ' (draft)' : ''} checks:${it.pr.checks?.state ?? 'none'}${it.pr.checks?.skipped ? ` (${it.pr.checks.skipped} skipped)` : ''}`);
  if (meta.length) lines.push(`    ${meta.join(' · ')}`);
  if (it.waitingOn.length) {
    lines.push(`    WAITING: ${it.waitingOn.map((w) => `${w.kind}:${w.ref}${w.unblocked ? ` (${w.unblocked})` : ''}${w.note ? ` — ${w.note}` : ''}`).join('; ')}`);
  }
  for (const o of it.overlaps) {
    const what = o.files.length ? ` on ${o.files.join(', ')}` : '';
    const unc = o.uncommittedFiles?.length ? ` · uncommitted: ${o.uncommittedFiles.join(', ')}` : '';
    lines.push(`    overlaps ${o.with} (${o.via.join('+')})${what}${unc}${o.known ? ' [known]' : ''}`);
  }
  if (it.overlapsWithHidden?.length) {
    lines.push(`    + overlaps ${it.overlapsWithHidden.length} hidden item${it.overlapsWithHidden.length === 1 ? '' : 's'} — use --all`);
  }
  if (it.hotOverlaps?.length) {
    const files = [...new Set(it.hotOverlaps.flatMap((o) => o.files))];
    const n = it.hotOverlaps.length;
    lines.push(`    hot files shared with ${n} item${n === 1 ? '' : 's'}: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` +${files.length - 5} more` : ''} (not counted as conflicts)`);
  }
  if (it.duplicates.length) lines.push(`    DUPLICATE patch with ${it.duplicates.join(', ')}`);
  for (const f of it.findings) lines.push(`    ${f.level}: ${f.message}`);
  for (const n of it.notes) lines.push(`    note: ${n}`);
  for (const w of prWarnings(it.pr, nowMs)) lines.push(`    warning: ${w}`);
  return lines.join('\n');
}

/**
 * What the overlap evidence was measured against, as one line - or null when
 * there is nothing to add (the local base is current, or ahead of its upstream).
 * The phantom-overlap caveat appears exactly when the measurement could not use
 * the fresher base (diverged, or git could not compare the two).
 * @param {object|null|undefined} m - `resolveMeasurementBase` result
 * @param {string} [name] - the base branch name
 * @returns {string|null}
 */
export function describeMeasurement(m, name = 'base') {
  if (!m) return null;
  if (!m.ok) return `overlaps by files not measurable: ${m.reason}`;
  switch (m.relation) {
    case 'local-trails': return `overlaps measured from ${m.ref} @ ${String(m.oid).slice(0, 12)} (local ${name} trails it${m.behindBy === null ? '' : ` by ${m.behindBy}`})`;
    case 'upstream-only': return `overlaps measured from ${m.ref} @ ${String(m.oid).slice(0, 12)} (no local ${name})`;
    case 'diverged': return `local ${name} has DIVERGED from its upstream; overlaps measured from local ${name} may be phantom — sync ${name}, then re-check`;
    case 'unknown': return `could not compare local ${name} with its upstream; overlaps measured from local ${name} may be phantom`;
    default: return null;
  }
}

/**
 * Render the `buildStatus` result.
 * @param {ReturnType<import('./overlap.mjs').buildStatus>} status
 * @returns {string}
 */
export function renderStatus(status, { hidden } = {}) {
  const out = [];
  if (!status.registry.complete) {
    out.push(BANNER(status.registry.invalid));
    for (const f of status.registry.invalid) out.push(`  ${f.file}: ${f.reason}`);
  }
  const fr = status.base.freshness?.freshness;
  const baseNote = !fr ? 'freshness unknown' : fr.state === 'behind' ? `local base is ${fr.behindBy} behind ${fr.upstream} (since last fetch)` : fr.state;
  out.push(`base: ${status.base.name ?? '?'} — ${baseNote} · observed ${status.observedAt}`);
  const measured = describeMeasurement(status.base.measure, status.base.name ?? 'base');
  if (measured) out.push(`  ${measured}`);
  for (const l of [sourceLine('worktrees', status.sources.worktrees), sourceLine('branches', status.sources.branches), sourceLine('PRs', status.sources.prs), checksLine(status.sources.prs)]) {
    if (l) out.push(l);
  }
  if (status.hold?.held) out.push(`HOLD on heavy runs${status.hold.by ? ` by ${status.hold.by}` : ''}${status.hold.reason ? `: ${status.hold.reason}` : ''}`);
  out.push('');
  if (!status.items.length) {
    const missing = incompleteSources(status);
    const noGit = !status.sources.worktrees.queried && !status.sources.branches.queried;
    if (!missing.length) out.push('(nothing in flight)');
    else if (noGit) out.push(`(inventory unavailable — git facts could not be read: ${missing.join(', ')})`);
    else out.push(`(nothing found — but ${missing.length} source${missing.length === 1 ? ' was' : 's were'} not fully queried: ${missing.join(', ')})`);
  }
  const nowMs = Number.isFinite(Date.parse(status.observedAt)) ? Date.parse(status.observedAt) : null;
  for (const it of status.items) out.push(itemBlock(it, nowMs));
  if (hidden?.count) out.push(`${hidden.count} hidden (${hiddenWhy(hidden)}) — use --all`);
  if (hidden?.unchecked) out.push(`${hidden.unchecked} merged- or idle-looking worktree${hidden.unchecked === 1 ? '' : 's'} shown: cleanliness unchecked`);
  if (status.landingOrder.length) out.push('', `proposed landing order: ${status.landingOrder.join(' → ')}`);
  for (const c of status.cycles) out.push(`waiting cycle: ${c.join(' ↔ ')} (ordered by id for display only)`);
  for (const t of status.trains) out.push(`train ${t.trainId}: ${t.phase}${t.result ? ` (${t.result})` : ''}`);
  return out.join('\n');
}

/**
 * Render a `decideClaim` verdict.
 * @param {{ok: boolean, verdict: string, conflicts: object[], reason?: string}} v
 * @param {{id?: string, cmd?: string, measure?: object|null, baseName?: string}} [ctx]
 */
export function renderClaimVerdict(v, ctx = {}) {
  const who = ctx.id ? ` for ${ctx.id}` : '';
  if (v.verdict === 'refused') return `REFUSED${who}: ${v.reason}. Run \`${ctx.cmd ?? 'fleet'} repair --quarantine <file>\` after reading the invalid record.`;
  const lines = [];
  const head = { ok: `OK${who}`, warn: `WARN${who}: overlapping live work (advisory)`, blocked: `BLOCKED${who}: overlapping live work — stop and report` }[v.verdict];
  lines.push(head ?? `${v.verdict}${who}`);
  // Only worth saying beside a conflict: it is what tells a reader whether the overlap is real.
  const measured = v.conflicts.length ? describeMeasurement(ctx.measure, ctx.baseName) : null;
  if (measured) lines.push(`  (${measured})`);
  for (const c of v.conflicts) {
    const detail = [];
    if (c.paths?.length) detail.push(`paths ${c.paths.slice(0, 3).map(([a, b]) => `${a} ~ ${b}`).join(', ')}`);
    if (c.files?.length) detail.push(`files ${c.files.slice(0, 5).join(', ')}`);
    if (c.uncommittedFiles?.length) detail.push(`UNCOMMITTED in their worktree: ${c.uncommittedFiles.slice(0, 5).join(', ')} (advisory)`);
    if (c.via.includes('intent')) detail.push('identical intent');
    if (c.hotFiles?.length) detail.push(`hot files ${c.hotFiles.slice(0, 5).join(', ')} (${c.hotOnly ? 'disclosed, not blocking' : 'not counted'})`);
    lines.push(`  ${c.known ? '[known] ' : ''}${c.hotOnly ? '[hot] ' : ''}${c.with}: ${c.via.join('+')}${detail.length ? ` — ${detail.join('; ')}` : ''}`);
  }
  for (const u of v.uninspected ?? []) lines.push(`  note: uncommitted work not inspected for ${u.with} (${u.reason})`);
  return lines.join('\n');
}

/** Render an `approvable` result. */
export function renderApprovable(r) {
  return r.ok
    ? `approvable: ${r.reason}${r.note ? `\n  ${r.note}` : ''}`
    : `NOT approvable: ${r.reason}`;
}
