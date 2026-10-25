/**
 * @fileoverview The STRUCTURAL-OR-STOP card — what an audit prints when it hits
 * its round cap so the decision to continue is made against the repo's memory
 * and backlog, not only against this one audit's findings.
 *
 * **Why it exists.** wine's 55-round plan audit was chasing three missing
 * shared primitives (document identity, a lock registry, lot enrichment): 16 of
 * its 17 design defects were absorbed by them. No per-plan loop could surface
 * that, because the structural fact lives outside the plan. The card clusters
 * this audit's findings, looks each cluster up in the deferred backlog (debt
 * ledger, recurring clusters, pending triage, upstream issues, unremediated
 * acceptances, fleet proposals, architectural memory) and ends in a HUMAN call.
 *
 * **Honesty rules.** (1) A source that could not be read is NAMED, with its
 * reason; the card never prints "no structural pattern". (2) Coverage is
 * tracked per cluster, so a source asked about only some clusters (architectural
 * memory) is `not-queried` for the rest, never `measured`. (3) A cluster is
 * LOCAL only when every source answered; otherwise it is
 * `local-or-structural (unmeasured: …)`. (4) Nothing is created: no debt, no
 * proposal — the card is read-only and the verdict is a hint, not an action.
 *
 * The pure core (`clusterAuditRounds`, `matchClusters`, `verdictFor`,
 * `assembleCard`, `renderStructuralCard`) takes data in and returns data out;
 * `buildStructuralCard` is the IO shell that reads the sources.
 *
 * Domain: audit-orchestration.
 *
 * @module scripts/lib/audit/structural-card
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normaliseCategoryKey, findingFiles, groupByLinkKeys } from '../concern-identity.mjs';
import { normalizePath } from '../file-io.mjs';
import { discoverRoundResults, readRoundResult } from './transcript.mjs';

export const CARD_VERSION = 1;

/** Sources every cluster is looked up in. `arch` is separate: it is queried per cluster, for a few. */
export const CARD_SOURCES = Object.freeze(['debt', 'recurring', 'triage', 'upstream', 'q2', 'proposals', 'arch']);

/** Clusters whose architectural neighbourhood is queried (the paid, embedding-backed read). */
export const ARCH_QUERY_BUDGET = 3;

/** Per-source read cap; a slow store must not turn a cheap refusal into a slow one. */
export const SOURCE_TIMEOUT_MS = 60_000;

const SEVERITY_RANK = Object.freeze({ HIGH: 3, MEDIUM: 2, LOW: 1 });

/** A string that can name a file: has a path separator or a short extension. Rejects prose. */
function looksLikePath(s) {
  return typeof s === 'string' && s.length < 200 && !/\s/.test(s) && /[\w-]\.[A-Za-z0-9]{1,6}$/.test(s);
}

const PLAN_PATH_RE = /(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,6}\b/g;
const BARE_FILE_RE = /\b[\w-]+(?:\.[\w-]+)*\.(?:mjs|cjs|js|jsx|ts|tsx|json|md|sql|ya?ml|sh)\b/g;
const SECTION_ANCHOR_RE =/§\s*(\d+(?:\.\d+)?)/;

/**
 * The files a finding concerns, normalised. Code findings carry them in
 * `affectedFiles`/`_primaryFile`; a plan finding carries only a `section` and
 * prose, so its files are the repo paths that prose names.
 * Plan prose often names a file by its bare name (`runs-findings.mjs`); with a
 * `fileIndex` (lower-cased basename → tracked paths) a name that matches exactly
 * ONE tracked file resolves to it, and an ambiguous one is dropped, never guessed.
 * @param {object} f
 * @param {'plan'|'code'} mode
 * @param {Map<string, string[]>} [fileIndex]
 * @returns {string[]}
 */
export function cardFilesOf(f, mode, fileIndex = null) {
  const out = new Set();
  if (mode === 'plan') {
    const text = `${f.section || ''} ${f.detail || ''}`;
    for (const m of text.matchAll(PLAN_PATH_RE)) out.add(normalizePath(m[0]));
    if (fileIndex) {
      for (const m of text.matchAll(BARE_FILE_RE)) {
        if (m[0].includes('/')) continue;
        const hits = fileIndex.get(m[0].toLowerCase());
        if (hits && hits.length === 1) out.add(normalizePath(hits[0]));
      }
    }
  }
  for (const x of findingFiles(f)) if (looksLikePath(x)) out.add(x);
  return [...out].filter(Boolean).sort();
}

function sectionAnchor(f) {
  const m = SECTION_ANCHOR_RE.exec(f.section || '');
  return m ? m[1] : null;
}

/**
 * Cluster one audit's findings across rounds.
 *
 * Link rule: the same category key AND a shared file (concern-identity's rule),
 * plus, for a plan audit, the same plan section anchor (`§2.3`) — a plan
 * finding names a section, not a file.
 *
 * @param {Array<{round: number, findings: object[], suppressed?: number}>} rounds
 * @param {'plan'|'code'} mode
 * @param {{fileIndex?: Map<string, string[]>|null}} [opts]
 * @returns {{clusters: object[], roundStats: object[], cleanRate: number|null, avgFindingsPerRound: number|null,
 *   suppressedTotal: number, hotFiles: Array<{file: string, rounds: number[]}>}}
 */
export function clusterAuditRounds(rounds, mode, { fileIndex = null } = {}) {
  const items = [];
  for (const r of rounds) {
    for (const f of r.findings || []) items.push({ f, round: r.round, files: cardFilesOf(f, mode, fileIndex) });
  }
  const groups = groupByLinkKeys(items, ({ f, files }) => {
    const cat = normaliseCategoryKey(f.category);
    const keys = files.map((file) => `catfile:${cat}|${file}`);
    if (mode === 'plan') {
      const a = sectionAnchor(f);
      if (a) keys.push(`sec:${a}`);
    }
    return keys;
  });

  const clusters = groups.map((idxs, n) => {
    const members = idxs.map((i) => items[i]);
    const catCounts = new Map();
    const files = new Set();
    const sev = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    const roundSet = new Set();
    for (const { f, round, files: fs_ } of members) {
      catCounts.set(f.category, (catCounts.get(f.category) || 0) + 1);
      for (const x of fs_) files.add(x);
      if (sev[f.severity] !== undefined) sev[f.severity] += 1;
      roundSet.add(round);
    }
    const label = [...catCounts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0] ?? '(uncategorised)';
    const maxSeverity = Object.keys(sev).filter((k) => sev[k] > 0).sort((a, b) => SEVERITY_RANK[b] - SEVERITY_RANK[a])[0] ?? 'LOW';
    return {
      id: `c${n + 1}`,
      label,
      categoryKeys: [...new Set(members.map(({ f }) => normaliseCategoryKey(f.category)))].filter(Boolean),
      files: [...files].sort(),
      rounds: [...roundSet].sort((a, b) => a - b),
      recurrence: roundSet.size,
      findingCount: members.length,
      severities: sev,
      maxSeverity,
    };
  });
  clusters.sort((a, b) => b.recurrence - a.recurrence || b.findingCount - a.findingCount || a.label.localeCompare(b.label));
  clusters.forEach((c, i) => { c.id = `c${i + 1}`; });

  const roundStats = rounds.map((r) => ({
    round: r.round,
    total: (r.findings || []).length,
    clean: (r.findings || []).length === 0,
    suppressed: r.suppressed || 0,
  }));
  const later = roundStats.length >= 2 ? roundStats.filter((r) => r.round >= 2) : roundStats;
  const fileRounds = new Map();
  for (const { round, files } of items) for (const file of files) {
    if (!fileRounds.has(file)) fileRounds.set(file, new Set());
    fileRounds.get(file).add(round);
  }
  const hotFiles = [...fileRounds.entries()]
    .filter(([, s]) => s.size >= 3)
    .map(([file, s]) => ({ file, rounds: [...s].sort((a, b) => a - b) }))
    .sort((a, b) => b.rounds.length - a.rounds.length || a.file.localeCompare(b.file));

  return {
    clusters,
    roundStats,
    cleanRate: roundStats.length ? roundStats.filter((r) => r.clean).length / roundStats.length : null,
    avgFindingsPerRound: later.length ? later.reduce((n, r) => n + r.total, 0) / later.length : null,
    suppressedTotal: roundStats.reduce((n, r) => n + r.suppressed, 0),
    hotFiles,
  };
}

const lc = (s) => String(s || '').toLowerCase();

/**
 * Match one cluster against the answered sources. Pure.
 *
 * Evidence kinds: `file` (a repo-relative path in common), `category` (same
 * normalised category key), `text` (a proposal's prose names a cluster file or
 * a long basename), `precedent` (architectural memory says existing code
 * occupies this space). There is NO hub-file filter: a threshold computed over
 * a 1-4 cluster set degenerates, and every match prints its `via` so the human
 * can see an over-match.
 *
 * @param {object} cluster
 * @param {Record<string, {status: string, items?: object[]}>} sources
 * @param {Array<object>} [precedents] arch precedent items for THIS cluster
 * @returns {Array<{source: string, kind: string, item: string, label: string, via: string}>}
 */
export function matchCluster(cluster, sources, precedents = []) {
  const evidence = [];
  const files = cluster.files.map(lc);
  const catKeys = new Set(cluster.categoryKeys);
  for (const [name, src] of Object.entries(sources)) {
    if (src.status !== 'measured') continue;
    for (const item of src.items || []) {
      const itemFiles = (item.files || []).map((x) => lc(normalizePath(x)));
      const hit = files.find((f) => itemFiles.includes(f));
      if (hit) { evidence.push({ source: name, kind: 'file', item: item.id, label: item.label, via: hit }); continue; }
      if (item.category && catKeys.has(normaliseCategoryKey(item.category))) {
        evidence.push({ source: name, kind: 'category', item: item.id, label: item.label, via: normaliseCategoryKey(item.category) });
        continue;
      }
      if (item.text) {
        const text = lc(item.text);
        const t = files.find((f) => text.includes(f) || (path.posix.basename(f).length >= 8 && text.includes(path.posix.basename(f))));
        if (t) evidence.push({ source: name, kind: 'text', item: item.id, label: item.label, via: t });
      }
    }
  }
  for (const p of precedents) evidence.push({ source: 'arch', kind: 'precedent', item: p.id, label: p.label, via: p.via });
  return evidence;
}

/** Corroborated = positive evidence from outside this plan: a shared file or an architectural precedent. */
export function isCorroborated(evidence) {
  return evidence.some((e) => e.kind === 'file' || e.kind === 'precedent');
}

/**
 * The verdict, as an ORDERED first-match table. Total: rule 5 catches the rest.
 * Corroboration is positive evidence so rule 3 fires despite failed sources;
 * "uncorroborated" is a negative claim, trusted only under full coverage.
 *
 * @param {{recurrence: number, severities: Record<string, number>}} cluster
 * @param {Array<object>} evidence
 * @param {Record<string, 'measured'|'failed'|'not-queried'>} coverage
 * @returns {{verdict: 'polish'|'structural'|'local-or-structural'|'local', rule: number, unmeasured: string[]}}
 */
export function verdictFor(cluster, evidence, coverage) {
  const unmeasured = Object.entries(coverage).filter(([, s]) => s !== 'measured').map(([n]) => n);
  if (cluster.recurrence < 2) return { verdict: 'polish', rule: 1, unmeasured };
  if (cluster.severities.HIGH === 0 && cluster.severities.MEDIUM === 0) return { verdict: 'polish', rule: 2, unmeasured };
  if (isCorroborated(evidence)) return { verdict: 'structural', rule: 3, unmeasured };
  if (unmeasured.length > 0) return { verdict: 'local-or-structural', rule: 4, unmeasured };
  return { verdict: 'local', rule: 5, unmeasured };
}

/**
 * Assemble the card from this audit's clustering, the source reads and the arch precedents. Pure.
 * @param {object} input
 * @returns {object} the card JSON
 */
export function assembleCard({ sid, mode, round, planFile, caps, audit, auditUnmeasured = null, sources, archByCluster = {}, notes = [], now = new Date() }) {
  const clusters = (audit?.clusters || []).map((c) => {
    const answered = Object.fromEntries(Object.entries(sources).filter(([n]) => n !== 'arch'));
    const arch = archByCluster[c.id];
    const coverage = {};
    for (const n of Object.keys(answered)) coverage[n] = answered[n].status === 'measured' ? 'measured' : 'failed';
    coverage.arch = arch ? (arch.status === 'measured' ? 'measured' : 'failed') : 'not-queried';
    const evidence = matchCluster(c, answered, arch?.status === 'measured' ? arch.items : []);
    const v = verdictFor(c, evidence, coverage);
    return { ...c, evidence, coverage, verdict: v.verdict, rule: v.rule, unmeasured: v.unmeasured };
  });
  const count = (v) => clusters.filter((c) => c.verdict === v).length;
  const recurrent = clusters.filter((c) => c.recurrence >= 2);
  const dirs = new Set(recurrent.flatMap((c) => c.files.map((f) => f.split('/')[0])));
  const unmeasuredSources = Object.entries(sources).filter(([, s]) => s.status !== 'measured').map(([n, s]) => ({ source: n, reason: s.detail }));
  return {
    version: CARD_VERSION,
    sid: sid || null,
    mode,
    round,
    planFile: planFile || null,
    caps,
    generatedAt: now.toISOString(),
    audit: audit
      ? { roundsRead: audit.roundStats.length, cleanRate: audit.cleanRate, avgFindingsPerRound: audit.avgFindingsPerRound,
          suppressedTotal: audit.suppressedTotal, roundStats: audit.roundStats, hotFiles: audit.hotFiles }
      : null,
    auditUnmeasured,
    sources: Object.fromEntries(Object.entries(sources).map(([n, s]) => [n, { status: s.status, detail: s.detail ?? null, count: (s.items || []).length }])),
    unmeasuredSources,
    notes,
    clusters,
    sharedPrimitiveCheck: { recurrent: recurrent.length, directories: dirs.size, promoted: recurrent.length >= 3 || dirs.size >= 2 },
    summary: {
      clusters: clusters.length,
      structural: count('structural'),
      local: count('local'),
      localOrStructural: count('local-or-structural'),
      polish: count('polish'),
      unmeasured: unmeasuredSources.length,
    },
  };
}

const VERDICT_LABEL = Object.freeze({
  structural: 'STRUCTURAL', local: 'LOCAL', 'local-or-structural': 'LOCAL?', polish: 'POLISH',
});

/**
 * Render the card as the text an operator reads. Never prints "no structural
 * pattern": zero structural clusters is stated with counts and the sources read.
 * @param {object} card
 * @returns {string}
 */
export function renderStructuralCard(card) {
  const { caps, mode } = card;
  const L = [];
  const capText = caps ? `soft cap ${caps.soft}, absolute ${caps.absolute}` : 'no cap';
  L.push(`── Structural-or-stop: ${mode} audit, round ${card.round} requested (${capText}) ──`);
  if (card.audit) {
    const a = card.audit;
    const pct = a.cleanRate === null ? 'n/a' : `${Math.round(a.cleanRate * 100)}%`;
    const avg = a.avgFindingsPerRound === null ? 'n/a' : a.avgFindingsPerRound.toFixed(1);
    L.push(`This audit: ${a.roundsRead} round(s) read · clean-round rate ${pct} · ${avg} findings/round since R2` +
      (a.suppressedTotal ? ` · ${a.suppressedTotal} re-raise(s) suppressed (not clustered)` : ''));
  } else {
    L.push(`This audit: UNMEASURED (${card.auditUnmeasured || 'no round results found'})`);
  }
  const srcText = Object.entries(card.sources).map(([n, s]) =>
    s.status === 'measured' ? `${n} ok(${s.count})` : `${n} ${s.detail ? `unreadable (${s.detail})` : s.status}`).join(' · ');
  L.push(`Sources: ${srcText}`);

  const sp = card.sharedPrimitiveCheck;
  const spLine = `Would one missing shared capability remove several of these clusters? (recurrent clusters: ${sp.recurrent}${sp.directories ? ` across ${sp.directories} top-level director${sp.directories === 1 ? 'y' : 'ies'}` : ', no files named'})`;
  L.push(sp.promoted ? `⚠ SHARED-PRIMITIVE CHECK — ${spLine}` : spLine);

  if (card.clusters.length === 0) {
    L.push(card.audit ? 'Clusters: none formed from this audit\'s findings.' : 'Clusters: not computed (this audit\'s findings were unreadable).');
  } else {
    L.push('Clusters (by recurrence):');
    for (const c of card.clusters.slice(0, 12)) {
      const tag = VERDICT_LABEL[c.verdict].padEnd(11);
      const where = c.files.length ? c.files.slice(0, 3).join(', ') + (c.files.length > 3 ? ` (+${c.files.length - 3})` : '') : '(no file named)';
      L.push(`  ${tag}[${c.recurrence} round${c.recurrence === 1 ? ' ' : 's'}] ${c.label} — ${where}`);
      if (c.verdict === 'local-or-structural') L.push(`               unmeasured: ${c.unmeasured.join(', ')}`);
      const shown = c.evidence.filter((e) => e.kind !== 'category' || c.evidence.length <= 3).slice(0, 3);
      for (const e of shown) L.push(`               ↳ ${e.source}/${e.kind} ${e.item} "${String(e.label).slice(0, 70)}" (via ${e.via})`);
    }
    if (card.clusters.length > 12) L.push(`  … ${card.clusters.length - 12} more cluster(s) in the card JSON`);
  }
  if (card.audit?.hotFiles?.length) {
    L.push(`Files raised in 3+ rounds: ${card.audit.hotFiles.slice(0, 5).map((h) => `${h.file} (${h.rounds.length})`).join(', ')}`);
  }
  const s = card.summary;
  L.push(`Summary: ${s.structural} structural · ${s.local} local · ${s.localOrStructural} unclassifiable · ${s.polish} polish, of ${s.clusters} cluster(s)`);
  if (card.unmeasuredSources.length) {
    L.push(`UNMEASURED: ${card.unmeasuredSources.map((u) => `${u.source} (${u.reason || 'unreadable'})`).join('; ')}. No cluster can read LOCAL until these answer.`);
  }
  for (const n of card.notes || []) L.push(`Note: ${n}`);
  L.push('Human call (pick one; record it in the plan\'s audit trail):');
  L.push('  STOP        accept the rest as debt → node scripts/debt-auto-capture.mjs …');
  L.push('  STRUCTURAL  plan the shared primitive first → /plan "<cluster label>" ; node scripts/fleet.mjs propose …');
  if (caps && card.round <= caps.absolute) {
    L.push(`  CONTINUE    one more round → re-run with --past-cap "<why this round will converge>"`);
  } else if (caps) {
    L.push(`  CONTINUE    not available (absolute cap ${caps.absolute})`);
  }
  return L.join('\n');
}

// ── IO shell ─────────────────────────────────────────────────────────────────

function withTimeout(promise, ms, name) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${name} timed out after ${ms}ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

const measured = (items, detail = null) => ({ status: 'measured', items, detail });
const failed = (detail) => ({ status: 'failed', items: [], detail });

/** Read this audit's round results. Never throws; a bad file is `unmeasured`. */
export function readAuditRounds({ sid, auditDir }) {
  if (!sid) return { rounds: null, unmeasured: 'no session id could be derived from --out or AUDIT_SESSION_ID' };
  let found;
  try { found = discoverRoundResults({ sid, dir: auditDir }); } catch (err) {
    return { rounds: null, unmeasured: `could not list ${auditDir}: ${err.message}` };
  }
  if (found.length === 0) return { rounds: null, unmeasured: `no ${sid}-r<N>-result.json files in ${auditDir}` };
  const rounds = [];
  for (const { path: p, round } of found) {
    try {
      const r = readRoundResult(p);
      rounds.push({ round, findings: r.findings || [], suppressed: Number(r._suppression?.suppressed) || 0 });
    } catch (err) {
      return { rounds: null, unmeasured: `unreadable round result (${err.message})` };
    }
  }
  return { rounds, unmeasured: null };
}

async function defaultReadStoreSources({ cwd }) {
  const out = {};
  const { resolveRepoForStoreResult } = await import('../store/repo.mjs');
  const { readOpenRecurringClusters, readPendingTriageFindingsStrict } = await import('../store/learning-decisions.mjs');
  const { resolveDebtReadContext, loadAuthoritativeDebt } = await import('../debt-memory.mjs');

  const repo = await resolveRepoForStoreResult({ cwd });
  const noRepo = repo.kind === 'cloud-off' ? 'store-off (cloud not configured)'
    : repo.kind === 'resolved' ? null : `repo not resolved (${repo.kind}${repo.error ? `: ${repo.error}` : ''})`;

  const debtP = (async () => {
    const ctx = await resolveDebtReadContext({});
    const d = await loadAuthoritativeDebt(ctx);
    if (d.source === 'unavailable') return failed(d.reason || 'unavailable');
    return measured((d.entries || []).map((e) => ({
      id: String(e.topicId || '').slice(0, 8), label: e.category || e.deferredReason || 'debt',
      category: e.category, files: e.affectedFiles || [],
    })), d.source === 'local' ? 'local cache — not authoritative' : null);
  })();

  const recurringP = noRepo ? failed(noRepo) : (async () => {
    const r = await readOpenRecurringClusters({ repoId: repo.repoRowId });
    if (!r.ok) return failed(r.error);
    if (!r.cloud) return failed('store-off (cloud not configured)');
    return measured(r.rows.map((x) => ({
      id: String(x.cluster_hash || x.id || '').slice(0, 8), label: x.cluster_label || 'recurring cluster',
      category: x.cluster_label, files: x.files_affected || [],
    })));
  })();

  const triageP = noRepo ? failed(noRepo) : (async () => {
    const r = await readPendingTriageFindingsStrict({ repoId: repo.repoRowId });
    if (!r.ok) return failed(r.error);
    if (!r.cloud) return failed('store-off (cloud not configured)');
    return measured(r.rows.map((x) => ({
      id: String(x.id || x.finding_id || x.fingerprint || '').slice(0, 8), label: x.title || x.category || 'pending triage',
      category: x.title || x.category, files: x.primary_file ? [x.primary_file] : [],
    })));
  })();

  const [debt, recurring, triage] = await Promise.all([
    withTimeout(debtP, SOURCE_TIMEOUT_MS, 'debt').catch((e) => failed(e.message)),
    withTimeout(Promise.resolve(recurringP), SOURCE_TIMEOUT_MS, 'recurring').catch((e) => failed(e.message)),
    withTimeout(Promise.resolve(triageP), SOURCE_TIMEOUT_MS, 'triage').catch((e) => failed(e.message)),
  ]);
  out.debt = debt; out.recurring = recurring; out.triage = triage;
  return out;
}

async function defaultReadProposals({ cwd }) {
  try {
    const { fleetDir } = await import('../fleet/registry.mjs');
    const { readProposals } = await import('../fleet/proposals.mjs');
    const read = readProposals(fleetDir(cwd));
    if (read.unmeasured) return failed('proposals unmeasured');
    return measured(read.records.map((p) => ({
      id: String(p.id || '').slice(-8), label: String(p.what || '').slice(0, 90), text: `${p.where || ''} ${p.what || ''}`, files: [],
    })), read.complete ? null : 'incomplete read');
  } catch (err) {
    return failed(err.message);
  }
}

async function defaultGatherBacklog({ cwd, here }) {
  const { gatherBacklogEnvelopes } = await import('../store/backlog-gather.mjs');
  const readers = {
    q2: { script: 'cross-skill.mjs', args: ['list-unremediated-acceptances'] },
    upstream: { script: 'cross-skill.mjs', args: ['upstream', 'list'] },
  };
  const { envelopes, outcomes } = await gatherBacklogEnvelopes({ cwd, here, readers, timeoutMs: SOURCE_TIMEOUT_MS });
  const out = {};
  for (const key of ['q2', 'upstream']) {
    const oc = outcomes[key];
    if (oc?.kind !== 'ok') { out[key] = failed(`${oc?.kind || 'unknown'}: ${oc?.detail || ''}`.trim()); continue; }
    const env = envelopes[key] || {};
    if (key === 'q2') {
      out.q2 = measured((env.rows || []).map((r) => ({
        id: String(r.audit_finding_id || '').slice(0, 8), label: r.category || 'accepted finding', category: r.category, files: r.primary_file ? [r.primary_file] : [],
      })));
    } else {
      out.upstream = measured((env.items || env.rows || []).map((r) => ({
        id: String(r.id || '').slice(0, 8), label: r.title || 'upstream issue', files: r.affected_path ? [r.affected_path] : [],
      })));
    }
  }
  return out;
}

/** lower-cased basename → tracked paths, from `git ls-files`. Throws when git cannot answer. */
export function defaultFileIndex({ cwd }) {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const index = new Map();
  for (const p of out.split(' ')) {
    if (!p) continue;
    const key = path.posix.basename(p).toLowerCase();
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(p);
  }
  return index;
}

function defaultRunArch({ cluster, planFile, cwd, here }) {
  const payload = JSON.stringify({
    targetPaths: cluster.files.slice(0, 6),
    intentDescription: `${cluster.label} (recurring audit finding cluster in ${planFile || 'a plan'})`,
    k: 5,
  });
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(here, 'cross-skill.mjs'), 'get-neighbourhood', '--json', payload],
      { cwd, timeout: SOURCE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
        const line = String(stdout || '').trim().split('\n').filter(Boolean).pop();
        let env = null;
        try { env = line ? JSON.parse(line) : null; } catch { env = null; }
        if (!env) return resolve(failed(err ? `process failed: ${String(err.message).slice(0, 80)}` : 'malformed response'));
        if (env.ok === false) return resolve(failed(`${env.error?.code || 'error'}`));
        if (env.cloud === false) return resolve(failed(`store-off${env.degraded ? ` (${env.degraded})` : ''}`));
        if (env.degraded) return resolve(failed(String(env.degraded)));
        const precedents = (env.records || []).filter((r) => r.recommendation === 'precedent').slice(0, 3);
        resolve(measured(precedents.map((r) => ({
          id: String(r.symbolName || '').slice(0, 24), label: `${r.symbolName} — ${r.purposeSummary || ''}`.slice(0, 90), via: r.filePath,
        }))));
      });
  });
}

/**
 * Build the card for one audit: read this audit's rounds, every backlog source and (for the top clusters)
 * architectural memory, then assemble. Never throws — an unreadable source is named in the card.
 *
 * @param {object} opts
 * @param {string|null} opts.sid
 * @param {'plan'|'code'} opts.mode
 * @param {number} opts.round - the round that was requested
 * @param {string|null} [opts.planFile]
 * @param {{soft: number, absolute: number}|null} [opts.caps]
 * @param {string} [opts.auditDir]
 * @param {string} [opts.cwd]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {object} [opts.deps] - test seams: readRounds, readStore, readProposals, gatherBacklog, runArch
 * @returns {Promise<{card: object, text: string}>}
 */
export async function buildStructuralCard({
  sid, mode, round, planFile = null, caps = null, auditDir = path.resolve('.audit'), cwd = process.cwd(), env = process.env, deps = {},
}) {
  const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const readRounds = deps.readRounds || readAuditRounds;
  const { rounds, unmeasured } = readRounds({ sid, auditDir });
  const notes = [];
  let fileIndex = null;
  if (mode === 'plan' && rounds) {
    try { fileIndex = (deps.fileIndex || defaultFileIndex)({ cwd }); } catch (err) {
      notes.push(`plan findings' bare file names were not resolved to paths (git ls-files failed: ${String(err.message).slice(0, 60)})`);
    }
  }
  const audit = rounds ? clusterAuditRounds(rounds, mode, { fileIndex }) : null;

  const airGapped = Object.hasOwn(env, 'AUDIT_DB_URL') && env.AUDIT_DB_URL === '';
  const safe = (fn, name) => Promise.resolve().then(fn).catch((e) => ({ __err: `${name}: ${e.message}` }));
  const [store, proposals, backlog] = await Promise.all([
    safe(() => (deps.readStore || defaultReadStoreSources)({ cwd }), 'store'),
    safe(() => (deps.readProposals || defaultReadProposals)({ cwd }), 'proposals'),
    safe(() => (deps.gatherBacklog || defaultGatherBacklog)({ cwd, here }), 'backlog'),
  ]);
  const pick = (bag, key, label) => (bag && !bag.__err && bag[key]) || failed(bag?.__err || `${label} not read`);
  const sources = {
    debt: pick(store, 'debt', 'debt'),
    recurring: pick(store, 'recurring', 'recurring'),
    triage: pick(store, 'triage', 'triage'),
    upstream: pick(backlog, 'upstream', 'upstream'),
    q2: pick(backlog, 'q2', 'q2'),
    proposals: proposals && !proposals.__err ? proposals : failed(proposals?.__err || 'proposals not read'),
  };

  // Architectural memory: the paid read, for the top clusters only. Air-gapped or opted out ⇒ never asked.
  const archByCluster = {};
  const archOff = env.AUDIT_CARD_NO_ARCH === '1' || airGapped;
  if (audit && !archOff) {
    const runArch = deps.runArch || defaultRunArch;
    const targets = audit.clusters.filter((c) => c.recurrence >= 2 && c.files.length > 0).slice(0, ARCH_QUERY_BUDGET);
    await Promise.all(targets.map(async (c) => {
      archByCluster[c.id] = await safe(() => runArch({ cluster: c, planFile, cwd, here }), 'arch')
        .then((r) => (r.__err ? failed(r.__err) : r));
    }));
  }
  const withArch = { ...sources, arch: { status: archOff ? 'failed' : 'measured', items: [], detail: archOff ? 'not queried (air-gapped or AUDIT_CARD_NO_ARCH=1)' : null } };
  // The headline `arch` source row reports the worst per-cluster outcome; coverage itself is per cluster.
  const archResults = Object.values(archByCluster);
  if (!archOff) {
    const bad = archResults.find((r) => r.status !== 'measured');
    withArch.arch = bad ? { status: 'failed', items: [], detail: bad.detail } : { status: 'measured', items: archResults.flatMap((r) => r.items), detail: archResults.length ? null : 'no recurrent cluster to query' };
  }

  const card = assembleCard({ sid, mode, round, planFile, caps, audit, auditUnmeasured: unmeasured, sources: withArch, archByCluster, notes });
  return { card, text: renderStructuralCard(card) };
}

/**
 * Write the card JSON atomically enough for a one-shot CLI (tmp + rename). Returns the path.
 * @param {string} dir
 * @param {string} fileName
 * @param {object} card
 */
export function writeCardFile(dir, fileName, card) {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, fileName);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(card, null, 2)}\n`);
  fs.renameSync(tmp, target);
  return target;
}

/**
 * Read a card back and confirm it was computed for this exact (sid, round).
 * @returns {{ok: true, card: object} | {ok: false, reason: string}}
 */
export function readMatchingCard(dir, fileName, { round }) {
  const target = path.join(dir, fileName);
  let card;
  try { card = JSON.parse(fs.readFileSync(target, 'utf-8')); } catch (err) {
    return { ok: false, reason: err.code === 'ENOENT' ? 'no card on disk' : `unreadable card (${err.message})` };
  }
  if (!card || card.version !== CARD_VERSION || card.round !== round) return { ok: false, reason: `card is for a different round (${card?.round ?? '?'})` };
  return { ok: true, card };
}
