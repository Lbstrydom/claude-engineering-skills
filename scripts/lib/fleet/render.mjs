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

/** @param {object} it a status item @param {number|null} [nowMs] @param {Record<string, string>} [hosts] */
function itemBlock(it, nowMs = null, hosts = {}, untrackedIds = null) {
  const lines = [];
  const head = [it.id, `[${it.display}]`];
  if (it.branch && it.branch !== it.id) head.push(`branch ${it.branch}`);
  lines.push(head.join('  '));
  if (it.intent) lines.push(`    intent: ${it.intent}`);
  const meta = [];
  if (it.ahead !== null && it.ahead !== undefined) meta.push(`ahead ${it.ahead} / behind ${it.behind ?? '?'}`);
  if (it.worktree) meta.push(`worktree ${it.worktree}${it.worktreeState && it.worktreeState !== 'present' ? ` (${it.worktreeState})` : ''}`);
  if (hosts[it.id]) meta.push(`host: ${hosts[it.id]}`);
  if (it.pr) meta.push(`PR #${it.pr.number}${it.pr.isDraft ? ' (draft)' : ''} checks:${it.pr.checks?.state ?? 'none'}${it.pr.checks?.skipped ? ` (${it.pr.checks.skipped} skipped)` : ''}`);
  if (meta.length) lines.push(`    ${meta.join(' · ')}`);
  if (it.waitingOn.length) {
    lines.push(`    WAITING: ${it.waitingOn.map((w) => `${w.kind}:${w.ref}${w.unblocked ? ` (${w.unblocked})` : ''}${w.note ? ` — ${w.note}` : ''}`).join('; ')}`);
  }
  // Between two UNTRACKED items an overlap is noise in the text view (v): it collapses to a count. Overlaps
  // involving a live claim stay in full — that is what overlap detection is for. JSON and land see everything.
  const collapse = untrackedIds && it.tracked === false;
  const quiet = collapse ? it.overlaps.filter((o) => untrackedIds.has(o.with)) : [];
  for (const o of it.overlaps) {
    if (quiet.includes(o)) continue;
    const what = o.files.length ? ` on ${o.files.join(', ')}` : '';
    const unc = o.uncommittedFiles?.length ? ` · uncommitted: ${o.uncommittedFiles.join(', ')}` : '';
    lines.push(`    overlaps ${o.with} (${o.via.join('+')})${what}${unc}${o.known ? ' [known]' : ''}`);
  }
  if (quiet.length) lines.push(`    overlaps ${quiet.length} other untracked branch${quiet.length === 1 ? '' : 'es'} (--all)`);
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
export function renderStatus(status, { hidden, hosts = {}, directives = null, now = null, all = false, unregistered = null } = {}) {
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
  const untrackedIds = all ? null : new Set(status.items.filter((i) => i.tracked === false).map((i) => i.id));
  for (const it of status.items) out.push(itemBlock(it, nowMs, hosts, untrackedIds));
  out.push(...directiveLines(directives, now));
  // The idle hide and the Unregistered-work section must agree: say how many hidden items are unlanded work.
  const unlandedHidden = unregistered?.queried ? (hidden?.ids ?? []).filter((id) => unregistered.items.some((u) => u.branch === id && u.verdict === 'unlanded')).length : 0;
  if (hidden?.count) out.push(`${hidden.count} hidden (${hiddenWhy(hidden)})${unlandedHidden ? ` (${unlandedHidden} of them unlanded — see Unregistered work)` : ''} — use --all`);
  if (hidden?.unchecked) out.push(`${hidden.unchecked} merged- or idle-looking worktree${hidden.unchecked === 1 ? '' : 's'} shown: cleanliness unchecked`);
  if (status.landingOrder.length) out.push('', `proposed landing order: ${status.landingOrder.join(' → ')}`);
  for (const c of status.cycles) out.push(`waiting cycle: ${c.join(' ↔ ')} (ordered by id for display only)`);
  for (const t of status.trains) out.push(`train ${t.trainId}: ${t.phase}${t.result ? ` (${t.result})` : ''}`);
  return out.join('\n');
}

/** Active directives, one line each; an incomplete read and unsupported records are named, never hidden. */
function directiveLines(d, now) {
  if (!d) return [];
  const out = [];
  const live = (d.active ?? []).filter((x) => !now || Date.parse(x.expiresAt) > now.getTime());
  if (live.length || !d.complete || d.unsupported?.length || d.invalid?.length) out.push('');
  for (const x of live) out.push(`directive ${x.id}: ${x.kind} → ${x.to} (${x.reason.kind}${x.reason.ref ? ` ${x.reason.ref}` : ''}) by ${x.by || '?'} · acks: ${x.acks.length}`);
  if (!d.complete) out.push(`directives: not fully read (${d.reason ?? 'incomplete'})`);
  if (d.unsupported?.length) out.push(`directives: ${d.unsupported.length} not understood by this fleet version (never acted on)`);
  for (const i of d.invalid ?? []) out.push(`directives: invalid record ${i.file} (${i.reason}) — never acted on; inspect it under fleet/directives/`);
  return out;
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
    if (c.abstractPaths?.length) detail.push(`patterns meet only on names no tracked file has: ${c.abstractPaths.slice(0, 3).map(([a, b]) => `${a} ~ ${b}`).join(', ')} (disclosed, not blocking)`);
    if (c.files?.length) detail.push(`files ${c.files.slice(0, 5).join(', ')}`);
    if (c.uncommittedFiles?.length) detail.push(`UNCOMMITTED in their worktree: ${c.uncommittedFiles.slice(0, 5).join(', ')} (advisory)`);
    if (c.via.includes('intent')) detail.push('identical intent');
    if (c.hotFiles?.length) detail.push(`hot files ${c.hotFiles.slice(0, 5).join(', ')} (${c.hotOnly ? 'disclosed, not blocking' : 'not counted'})`);
    lines.push(`  ${c.known ? '[known] ' : ''}${c.hotOnly ? '[hot] ' : ''}${c.abstractOnly ? '[abstract] ' : ''}${c.with}: ${c.via.join('+')}${detail.length ? ` — ${detail.join('; ')}` : ''}`);
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

// ── unregistered work (status section, plan §2.2) ───────────────────────────

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One unregistered item, the status line form: what, how idle, what is at stake, where it lives. */
function unregisteredLine(i) {
  const name = i.worktree ? (i.branch ?? `detached ${String(i.head ?? '').slice(0, 12)}`) : `${i.branch} (no worktree)`;
  const idle = i.idleDays === null || i.idleDays === undefined ? 'idle ?' : `idle ${i.idleDays}d`;
  const stake = [];
  if (i.ahead) stake.push(`${i.ahead} ahead`);
  if (i.risks?.unpushed) stake.push(`${i.risks.unpushed} unpushed`);
  for (const k of ['staged', 'unstaged', 'untracked']) if (i.risks?.[k]) stake.push(`${i.risks[k]} ${k}`);
  const where = i.preserved === 'none' ? 'local-only' : i.preserved === 'remote' ? 'on a remote-tracking ref' : null;
  const parts = [idle, ...(stake.length ? [stake.join(', ')] : []), ...(where ? [where] : []), i.reason];
  return `      ${name}  ${parts.join(' · ')}${i.worktree ? ` · ${i.worktree}` : ''}`;
}

/**
 * The "Unregistered work" section of `fleet status`. Possibly-abandoned and unverified items are listed in
 * full (ranked: work that exists nowhere else first); the other groups are counts unless `all`. A scan that did
 * not reach everything says so; archive tags holding commits not on base are counted by where they live.
 * @param {{queried: boolean, reason?: string, items: object[], partial: boolean, notProbed: number, staleDays: number, branchesUnknown?: string}} scan
 * @param {{groups: object, all?: boolean, tags?: object|null}} opts `groups` = `groupUnregistered(scan.items)`
 */
export function renderUnregistered(scan, { groups, all = false, tags = null } = {}) {
  if (!scan.queried) return [`Unregistered work — not measured (${scan.reason ?? 'unknown reason'})`];
  const n = scan.items.length;
  const out = [`Unregistered work — ${n ? `${plural(n, 'worktree/branch', 'worktrees/branches')} hold work no live claim covers` : 'none found'}`];
  if (scan.partial) out.push(`  NOT FULLY MEASURED: ${[scan.notProbed ? `${scan.notProbed} not probed before the deadline` : null, scan.branchesUnknown ?? null].filter(Boolean).join('; ')}`);
  const group = (label, list, full) => {
    if (!list.length) return;
    out.push(`  ${label} — ${list.length}`);
    if (full || all) for (const i of list) out.push(unregisteredLine(i));
  };
  group(`possibly abandoned (idle > ${scan.staleDays}d, unlanded)`, groups.abandoned, true);
  group('unverified (could not be measured or landing unknown)', groups.unverified, true);
  group('superseded, on base (removable — see fleet prune)', groups.supersededOnBase, false);
  group('covered by a live claim (same patch — not removable yet; leave it until that claim lands)', groups.coveredByClaim, false);
  group('sync receipt only (sync-owned)', groups.syncOwned, false);
  group(`fresh (idle ≤ ${scan.staleDays}d)`, groups.fresh, false);
  if (scan.tooling?.length) out.push(`  pre-push sandboxes (tooling, not work; removed by the pre-push run that made them) — ${scan.tooling.length}`);
  if (tags?.queried && tags.overflow && !tags.counts.unlanded) out.push(`  archive tags: ${tags.overflow} not judged (over the scan limit or the deadline); none of those judged hold commits off base`);
  if (tags?.queried && tags.counts.unlanded) {
    const c = tags.counts;
    const kinds = ['local-only', 'last-fetch', 'remote', 'unknown'].filter((k) => c[k]).map((k) => `${c[k]} ${k}`).join(', ');
    out.push(`  archive tags holding commits not on base — ${c.unlanded} (${kinds})${tags.overflow ? `; ${tags.overflow} more not judged` : ''}`);
    if (all) for (const t of tags.tags.filter((x) => x.verdict === 'unlanded')) out.push(`      ${t.name} @ ${t.oid.slice(0, 12)} · ${t.preserved}`);
  } else if (tags && !tags.queried) out.push(`  archive tags: not measured (${tags.reason})`);
  return out;
}
