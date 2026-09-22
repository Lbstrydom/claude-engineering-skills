/**
 * @fileoverview Concern identity for R2+ re-raise suppression: which dismissed
 * ledger entries are the SAME concern, whether a fresh finding belongs to one,
 * and the telemetry that shows whether either answer is working.
 *
 * Why this is its own module. The hard-suppress ruling counter ("Fix #4") has
 * died twice, both times because its key was built from model-written free
 * text: 2026-08-10, a `[Tag]` prefix stripped on one side only; 2026-09-22, a
 * consumer's six-round /audit-code run re-adjudicated one concern under eight
 * category phrasings across three files, because the key needed an exact
 * category AND an exact `affectedFiles[0]`. Fixing one spelling is defeated by
 * the next rewording, so identity now rests on two things that do not reword:
 *
 *  1. **The adjudicator's link.** `write-ledger-entries --triage` accepts
 *     `sameConcernAs`, resolved to a stored `concernId`. The adjudicator already
 *     knows ("sixth raising of…"); this gives that knowledge a structured home.
 *  2. **File OVERLAP, not `[0]`.** A `[SYSTEMIC]` finding's first file rotates
 *     between rounds; the set of files it names does not.
 *
 * Category text is still compared EXACTLY (after `normaliseCategoryKey`), never
 * fuzzily. Measured on the report's own rows: "operational limits" vs
 * "operational limit" scores 0.50, and "Hardcoded timeout value" vs "Hardcoded
 * credential value" also scores 0.50 — so no Jaccard cut both merges the
 * report's rows and keeps a permanent suppression off a different defect.
 *
 * Telemetry is stamped with `CONCERN_TELEMETRY_EPOCH` at the collector
 * (`audit_runs.suppression_stats.concern.epoch`) so a later reader counts only
 * rounds produced under this contract — never a date cut-off.
 */
import { normalizePath } from './file-io.mjs';

/** Dismissals of one concern before any further raise is hard-suppressed. */
export const HARD_SUPPRESS_THRESHOLD = 3;

/** Bump when the MEANING of the telemetry below changes, then re-collect. */
export const CONCERN_TELEMETRY_EPOCH = 'concern-v1';

/**
 * The ONE spelling of the category key. Lowercase, every `[Tag]` removed.
 * Moved here from ledger.mjs (which re-exports it) so the index below and the
 * ledger share one expression — two spellings is how the counter first died.
 *
 * @param {string|undefined} category
 * @returns {string}
 */
export function normaliseCategoryKey(category) {
  return (category || '').toLowerCase().replaceAll(/\[.*?\]\s*/g, '').trim();
}

/** A ledger entry's files, normalised; falls back to `section` as before. */
function entryFiles(e) {
  const files = Array.isArray(e.affectedFiles) && e.affectedFiles.length > 0 ? e.affectedFiles : [e.section || ''];
  return [...new Set(files.map(normalizePath))].filter(Boolean);
}

/** A fresh finding's files: `affectedFiles` plus the primary file. */
export function findingFiles(f) {
  const files = new Set((Array.isArray(f.affectedFiles) ? f.affectedFiles : []).map(normalizePath));
  files.add(normalizePath(f._primaryFile || f.section || ''));
  files.delete('');
  return files;
}

/**
 * Judgement dismissals only. `stage1-mechanical` stays excluded: its reason is
 * a mechanical fact about the code that a later edit can falsify, so it must
 * never accumulate toward a PERMANENT suppression.
 */
function countsTowardHardSuppress(e) {
  return e.source !== 'stage1-mechanical'
    && (e.ruling === 'overrule' || e.adjudicationOutcome === 'dismissed');
}

/**
 * Group dismissed entries into concerns. Two entries are one concern when the
 * adjudicator linked them (shared `concernId`, or one's `concernId` is the
 * other's `topicId`), or when they share a category key AND any file.
 *
 * @param {object[]} entries - resolved ledger entries (session/debt/stage1)
 * @returns {{groups: Array<{id: string, count: number, linked: boolean}>,
 *            byCategoryFile: Map<string, object>}}
 */
export function buildConcernIndex(entries) {
  const members = (entries || []).filter(countsTowardHardSuppress);
  const parent = members.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };

  const firstByKey = new Map();
  const link = (key, i) => (firstByKey.has(key) ? union(firstByKey.get(key), i) : firstByKey.set(key, i));
  members.forEach((e, i) => {
    link(`concern:${e.concernId || e.topicId}`, i);
    const cat = normaliseCategoryKey(e.category);
    for (const file of entryFiles(e)) link(`catfile:${cat}|${file}`, i);
  });

  const byRoot = new Map();
  members.forEach((e, i) => {
    const r = find(i);
    const g = byRoot.get(r) || { id: e.concernId || e.topicId, count: 0, linked: false, keys: [] };
    g.count += 1;
    g.linked ||= Boolean(e.concernId);
    const cat = normaliseCategoryKey(e.category);
    for (const file of entryFiles(e)) g.keys.push(`${cat}|${file}`);
    byRoot.set(r, g);
  });

  // A group's reach is every (category, file) pair any member covers, so a
  // raise matches on ANY phrasing the adjudicator already linked, on ANY file
  // the concern has named — the cross product, not only the pairs one entry had.
  const byCategoryFile = new Map();
  for (const g of byRoot.values()) {
    const cats = new Set(g.keys.map((k) => k.split('|')[0]));
    const files = new Set(g.keys.map((k) => k.slice(k.indexOf('|') + 1)));
    for (const c of cats) for (const f of files) {
      const prior = byCategoryFile.get(`${c}|${f}`);
      if (!prior || prior.count < g.count) byCategoryFile.set(`${c}|${f}`, g);
    }
    delete g.keys;
  }
  return { groups: [...byRoot.values()], byCategoryFile };
}

/**
 * The concern a fresh finding belongs to, if any (largest wins).
 * @returns {{id: string, count: number, linked: boolean}|null}
 */
export function matchConcern(f, index) {
  const cat = normaliseCategoryKey(f.category);
  let best = null;
  for (const file of findingFiles(f)) {
    const g = index.byCategoryFile.get(`${cat}|${file}`);
    if (g && (!best || g.count > best.count)) best = g;
  }
  return best;
}

/** Shortest `sameConcernAs` prefix accepted — the width the rulings block shows. */
export const MIN_CONCERN_REF_LENGTH = 6;

/**
 * Resolve each triage `sameConcernAs` to a stored `concernId` — the ROOT of the
 * concern, so a chain (C → B → A) stores A on every member and grouping never
 * depends on walking links at read time.
 *
 * A reference may name a finding id in the same triage batch, a full ledger
 * topicId, or a unique topicId prefix of at least MIN_CONCERN_REF_LENGTH chars
 * (what the adjudicator sees in the rulings block). An unresolvable, ambiguous,
 * self- or cyclic reference is an ERROR, never a silent skip: a dropped link is
 * exactly the lost knowledge this field exists to keep.
 *
 * @param {object[]} pending - entries about to be written (carry topicId)
 * @param {Map<string, string>} refsByTopic - topicId → raw sameConcernAs
 * @param {Map<string, string>} topicByFindingId - this batch's finding id → topicId
 * @param {Map<string, object>} ledgerByTopic - current ledger entries by topicId
 * @returns {{entries: object[], errors: string[]}}
 */
export function resolveConcernLinks(pending, refsByTopic, topicByFindingId, ledgerByTopic) {
  const errors = [];
  const batch = new Map(pending.map((e) => [e.topicId, e]));
  const known = [...new Set([...ledgerByTopic.keys(), ...batch.keys()])];

  const target = (ref) => {
    if (topicByFindingId.has(ref)) return topicByFindingId.get(ref);
    if (batch.has(ref) || ledgerByTopic.has(ref)) return ref;
    if (ref.length < MIN_CONCERN_REF_LENGTH) return { error: `is shorter than ${MIN_CONCERN_REF_LENGTH} chars and is not a finding id in this triage` };
    const hits = known.filter((t) => t.startsWith(ref));
    if (hits.length === 1) return hits[0];
    return { error: hits.length === 0 ? 'matches no ledger topicId' : `is ambiguous (${hits.length} topicIds)` };
  };

  const rootOf = (topicId, seen) => {
    if (seen.has(topicId)) return { error: `forms a cycle (${[...seen, topicId].join(' → ')})` };
    const ref = refsByTopic.get(topicId);
    if (ref === undefined) {
      const stored = ledgerByTopic.get(topicId)?.concernId;
      return stored || topicId;
    }
    const t = target(ref);
    if (typeof t !== 'string') return t;
    if (t === topicId) return { error: 'names the finding itself' };
    return rootOf(t, new Set([...seen, topicId]));
  };

  const entries = pending.map((e) => {
    if (!refsByTopic.has(e.topicId)) {
      // The triage path REPLACES an entry by topicId; keep a link made in an
      // earlier round rather than silently unlinking on a re-ruling.
      const stored = ledgerByTopic.get(e.topicId)?.concernId;
      return stored ? { ...e, concernId: stored } : e;
    }
    const root = rootOf(e.topicId, new Set());
    if (typeof root !== 'string') {
      errors.push(`${e.latestFindingId ?? e.topicId}.sameConcernAs ${JSON.stringify(refsByTopic.get(e.topicId))} ${root.error}`);
      return e;
    }
    return { ...e, concernId: root };
  });
  return { entries, errors };
}

/** The durable `suppression_events.reason` for a hard-suppress. The prefix is
 *  the historical string, kept so an existing `LIKE` query still matches. */
export function hardSuppressReason(group) {
  return `Category+file overruled ${group.count} times — hard-suppressed; `
    + `concern=${group.id}; linked=${group.linked ? 'yes' : 'no'}`;
}

/**
 * A KEPT finding that shares a file with a prior ruling — the shape of a missed
 * re-raise, and the only suppression outcome that previously left no trace.
 * Every such finding is recorded, not just those near the threshold, so the
 * week's data gives the whole score distribution rather than one tail of it.
 *
 * @param {object} f - kept finding
 * @param {object[]} resolved - the entries suppression matched against
 * @param {(f: object, d: object) => number} score - ledgerFindingSimilarity
 * @param {object} index - buildConcernIndex result
 * @returns {{finding, matchedTopic, matchScore, reason}|null}
 */
export function describeNearMiss(f, resolved, score, index) {
  const files = findingFiles(f);
  let best = null, bestScore = -1;
  for (const d of resolved) {
    if (!entryFiles(d).some((af) => [...files].some((ff) => ff === af || ff.includes(af)))) continue;
    const s = score(f, d);
    if (s > bestScore) { bestScore = s; best = d; }
  }
  if (!best) return null;
  const concern = matchConcern(f, index);
  return {
    finding: f,
    matchedTopic: best.topicId,
    matchScore: Math.round(bestScore * 1000) / 1000,
    // Multi-file ([SYSTEMIC]-shaped) raises are where a first-file key misroutes;
    // counted so the open keying question is answered by data, not argument.
    fileCount: files.size,
    reason: `near-miss; files=${files.size}; pass=${best.pass === f._pass ? 'same' : 'cross'}; `
      + `source=${best.source || 'session'}; outcome=${best.adjudicationOutcome ?? best.remediationState ?? 'unknown'}; `
      + `concern=${concern ? `${concern.id}:${concern.count}` : 'none'}`,
  };
}

/** Score bands for the near-miss distribution. Same-pass kept findings are
 *  <= the threshold by construction; the top band is cross-pass only. */
const BANDS = [['lt10', 0.1], ['lt20', 0.2], ['lt35', 0.35], ['gte35', Infinity]];

/**
 * Per-round counts for `audit_runs.suppression_stats.concern`. Counts only —
 * finding bodies belong in `suppression_events` rows.
 */
export function summariseConcernRound({ suppressed = [], nearMisses = [], index, reopenTelemetry = null }) {
  const bands = Object.fromEntries(BANDS.map(([k]) => [k, 0]));
  for (const m of nearMisses) bands[BANDS.find(([, hi]) => m.matchScore < hi)[0]] += 1;
  const groups = index?.groups || [];
  return {
    epoch: CONCERN_TELEMETRY_EPOCH,
    hardSuppressed: suppressed.filter((s) => s.matchedSource === 'ruling-count').length,
    fuzzySuppressed: suppressed.filter((s) => s.matchedSource !== 'ruling-count' && !s.relitigationDeclined).length,
    relitigationDeclined: suppressed.filter((s) => s.relitigationDeclined).length,
    nearMisses: nearMisses.length,
    nearMissBands: bands,
    nearMissInConcern: nearMisses.filter((m) => !m.reason.endsWith('concern=none')).length,
    nearMissMultiFile: nearMisses.filter((m) => (m.fileCount ?? 1) > 1).length,
    concerns: groups.length,
    concernsLinked: groups.filter((g) => g.linked).length,
    concernsAtThreshold: groups.filter((g) => g.count >= HARD_SUPPRESS_THRESHOLD).length,
    reopenUndeclaredOnDismissal: reopenTelemetry?.undeclaredOnDismissal ?? 0,
  };
}
