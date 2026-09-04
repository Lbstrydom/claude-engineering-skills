/**
 * @fileoverview Phase D.3 — debt-review helpers.
 *
 * Server-side computation that doesn't need the LLM:
 *  - Leverage scoring (deterministic, reproducible)
 *  - TTL staleness detection
 *  - Local-only clustering heuristics (for --local-only mode)
 *  - Budget-violation detection
 *
 * Keeping this logic out of the LLM prompt makes results reproducible and
 * lets us reject GPT's effort inflation.
 *
 * @module scripts/lib/debt-review-helpers
 */

// ── Ownership partition ─────────────────────────────────────────────────────

/**
 * Split debt entries into the ones this repo can act on and the ones it cannot.
 *
 * **Why a partition and not a filter.** A consumer's ledger held 34 entries,
 * **17 of which cite files the repo cannot edit** (`.audit-loop/
 * expected-schema.json` ×8, per-skill `SKILL.md` files ×9 — all synced from
 * upstream). `debt:review --local-only` ranked the eight-entry
 * `expected-schema.json` cluster **second by leverage**: a refactor target that
 * is not a refactor target, sitting above real work. The only available action,
 * `debt-resolve.mjs`, *removes* the entry from the committed ledger — which for
 * a real, still-open, upstream-owned defect deletes the only record of it.
 * Measured 2026-09-04.
 *
 * So upstream-owned entries stay VISIBLE (they are real debt; someone must file
 * them upstream) and stay OUT of leverage ranking (nobody here can refactor
 * them). Dropping them entirely would be the same deletion in a different coat.
 *
 * An entry is upstream-owned when EVERY file it cites is; a mixed entry stays
 * actionable, because part of it can be fixed here — the conservative direction,
 * since the failure mode being closed is *under*-reporting what the repo owns.
 *
 * Pure: ownership is the caller's oracle (git-ignore state ∪ the sync sidecar),
 * injected rather than probed, so this stays Tier-1 testable.
 *
 * @param {object[]} entries - hydrated debt entries
 * @param {(relPath: string) => boolean} isUpstreamOwned
 * @returns {{actionable: object[], upstreamOwned: object[]}}
 */
export function partitionByOwnership(entries, isUpstreamOwned) {
  const actionable = [];
  const upstreamOwned = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const files = Array.isArray(e?.affectedFiles) ? e.affectedFiles : [];
    // No cited file ⇒ nothing to attribute ⇒ this repo's problem by default.
    // Absence of evidence must not read as "someone else's".
    const owned = files.length > 0 && files.every((f) => isUpstreamOwned(f));
    (owned ? upstreamOwned : actionable).push(e);
  }
  return { actionable, upstreamOwned };
}

// ── Leverage Scoring (deterministic) ────────────────────────────────────────

/** Effort weight → number of "units" required to complete a refactor. */
export const EFFORT_WEIGHTS = Object.freeze({
  TRIVIAL: 1,
  EASY: 2,
  MEDIUM: 4,
  MAJOR: 8,
  CRITICAL: 16,
});

/** sonarType weight → how much impact resolving an entry of this type has. */
export const SONAR_TYPE_WEIGHTS = Object.freeze({
  BUG: 3,
  VULNERABILITY: 3,
  SECURITY_HOTSPOT: 2,
  CODE_SMELL: 1,
});

const DEFAULT_SONAR_WEIGHT = 1;

/**
 * Compute leverage = sum(sonarType weights of resolved entries) / effort weight.
 * Higher is better — more impact per unit of work.
 *
 * @param {{effortEstimate: string, resolvedTopicIds: string[]}} refactor
 * @param {Map<string, object>} debtIndex - topicId → hydrated debt entry
 * @returns {number}
 */
export function computeLeverage(refactor, debtIndex) {
  const effortWeight = EFFORT_WEIGHTS[refactor.effortEstimate];
  if (!effortWeight || effortWeight <= 0) return 0;

  const impact = refactor.resolvedTopicIds.reduce((sum, topicId) => {
    const entry = debtIndex.get(topicId);
    if (!entry) return sum;
    const w = SONAR_TYPE_WEIGHTS[entry.classification?.sonarType] ?? DEFAULT_SONAR_WEIGHT;
    return sum + w;
  }, 0);

  return Number((impact / effortWeight).toFixed(3));
}

/**
 * Attach leverageScore to each refactor candidate, sort descending.
 * @param {object[]} refactors - RefactorCandidate-shaped
 * @param {object[]} debtEntries - hydrated debt entries
 * @returns {object[]} Same shape with leverageScore added
 */
export function rankRefactorsByLeverage(refactors, debtEntries) {
  const index = new Map(debtEntries.map(e => [e.topicId, e]));
  return refactors
    .map(r => ({ ...r, leverageScore: computeLeverage(r, index) }))
    .sort((a, b) => b.leverageScore - a.leverageScore);
}

// ── TTL Staleness ───────────────────────────────────────────────────────────

/**
 * Find debt entries older than ttlDays. Returns an array of topicIds.
 * Stale entries stay in the ledger — we only flag them for human review.
 *
 * @param {object[]} debtEntries - hydrated debt entries
 * @param {number} ttlDays
 * @param {Date} [now=new Date()]
 * @returns {string[]} topicIds of stale entries
 */
export function findStaleEntries(debtEntries, ttlDays, now = new Date()) {
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) return [];
  const cutoffMs = now.getTime() - ttlDays * 24 * 60 * 60 * 1000;
  return debtEntries
    .filter(e => {
      const t = Date.parse(e.deferredAt);
      return Number.isFinite(t) && t < cutoffMs;
    })
    .map(e => e.topicId);
}

/**
 * Age of the oldest entry in days (integer, rounded down).
 */
export function oldestEntryDays(debtEntries, now = new Date()) {
  if (debtEntries.length === 0) return 0;
  let oldestMs = now.getTime();
  for (const e of debtEntries) {
    const t = Date.parse(e.deferredAt);
    if (Number.isFinite(t) && t < oldestMs) oldestMs = t;
  }
  const ageMs = Math.max(0, now.getTime() - oldestMs);
  return Math.floor(ageMs / (24 * 60 * 60 * 1000));
}

// ── Local-only Clustering (no-LLM fallback) ─────────────────────────────────

/**
 * Group debt entries by primary file. Useful for --local-only mode where
 * we don't send entries to an external LLM.
 * @param {object[]} debtEntries
 * @returns {Map<string, object[]>} file → entries
 */
export function groupByFile(debtEntries) {
  const byFile = new Map();
  for (const e of debtEntries) {
    const primary = (e.affectedFiles || [])[0] || 'unknown';
    if (!byFile.has(primary)) byFile.set(primary, []);
    byFile.get(primary).push(e);
  }
  return byFile;
}

/**
 * Group by principle (first principle in affectedPrinciples).
 * @param {object[]} debtEntries
 * @returns {Map<string, object[]>}
 */
export function groupByPrinciple(debtEntries) {
  const byPrinciple = new Map();
  for (const e of debtEntries) {
    const p = (e.affectedPrinciples || [])[0] || 'unknown';
    if (!byPrinciple.has(p)) byPrinciple.set(p, []);
    byPrinciple.get(p).push(e);
  }
  return byPrinciple;
}

/**
 * Find recurring entries (distinctRunCount >= threshold). These are the
 * systemic signal: findings that keep coming back across audits.
 * @param {object[]} debtEntries - hydrated (must have distinctRunCount)
 * @param {number} [minOccurrences=3]
 * @returns {object[]} entries sorted by distinctRunCount descending
 */
export function findRecurringEntries(debtEntries, minOccurrences = 3) {
  return debtEntries
    .filter(e => (e.distinctRunCount ?? e.occurrences ?? 0) >= minOccurrences)
    .sort((a, b) => (b.distinctRunCount ?? 0) - (a.distinctRunCount ?? 0));
}

/**
 * Build local-only clusters (no LLM). Uses the three groupings above and
 * emits a Cluster for each group with >= minSize members.
 *
 * @param {object[]} debtEntries - hydrated
 * @param {object} [opts]
 * @param {number} [opts.minSize=2]
 * @param {number} [opts.recurrenceThreshold=3]
 * @returns {object[]} Cluster-shaped objects
 */
export function buildLocalClusters(debtEntries, { minSize = 2, recurrenceThreshold = 3 } = {}) {
  const clusters = [];

  // File clusters
  for (const [file, entries] of groupByFile(debtEntries)) {
    if (entries.length < minSize || file === 'unknown') continue;
    clusters.push({
      id: `file:${file}`.slice(0, 40),
      title: `${file} — ${entries.length} entries`,
      kind: 'file',
      entries: entries.map(e => e.topicId),
      rationale: `${entries.length} debt entries cite ${file}. Candidate for module-level refactor.`,
    });
  }

  // Principle clusters
  for (const [principle, entries] of groupByPrinciple(debtEntries)) {
    if (entries.length < minSize || principle === 'unknown') continue;
    clusters.push({
      id: `principle:${principle}`.slice(0, 40),
      title: `${principle} violations — ${entries.length} entries`,
      kind: 'principle',
      entries: entries.map(e => e.topicId),
      rationale: `${entries.length} debt entries violate "${principle}". Systemic pattern.`,
    });
  }

  // Recurrence cluster (all high-occurrence entries together)
  const recurring = findRecurringEntries(debtEntries, recurrenceThreshold);
  if (recurring.length >= minSize) {
    clusters.push({
      id: 'recurrence:high',
      title: `Recurring (>= ${recurrenceThreshold} runs) — ${recurring.length} entries`,
      kind: 'recurrence',
      entries: recurring.map(e => e.topicId),
      rationale: `${recurring.length} entries have surfaced in ${recurrenceThreshold}+ distinct audit runs. High-priority refactor candidates.`,
    });
  }

  return clusters;
}

// ── Budget Violations ───────────────────────────────────────────────────────

/**
 * Compute per-path debt counts from entries' first affectedFile.
 * @param {object[]} debtEntries
 * @returns {Map<string, number>} file → count
 */
export function countDebtByFile(debtEntries) {
  const counts = new Map();
  for (const e of debtEntries) {
    const primary = (e.affectedFiles || [])[0];
    if (!primary) continue;
    counts.set(primary, (counts.get(primary) || 0) + 1);
  }
  return counts;
}

/**
 * Detect files exceeding their budget. Supports both exact paths AND globs
 * (via micromatch). Budget violations are reported per-BUDGET-KEY:
 *   budget "scripts/lib/**": 10 exceeded → one violation record with
 *   count = total entries across all files matching that glob.
 *
 * This matches operator intent: "I budget 10 debt items for the scripts/lib
 * area" is one policy, not N file-level policies.
 *
 * @param {object[]} debtEntries
 * @param {Record<string, number>} budgets - path or glob → max allowed count
 * @param {object} [opts]
 * @param {Function} [opts.matcher] - override matcher for testing (fn(files, pattern) → files[])
 * @returns {{path: string, count: number, budget: number, isGlob: boolean}[]}
 */
export function findBudgetViolations(debtEntries, budgets = {}, opts = {}) {
  if (!budgets || Object.keys(budgets).length === 0) return [];

  const files = debtEntries
    .map(e => (e.affectedFiles || [])[0])
    .filter(Boolean);
  const counts = countDebtByFile(debtEntries);
  const matcher = opts.matcher || getDefaultMatcher();

  const violations = [];
  for (const [pattern, budget] of Object.entries(budgets)) {
    const isGlob = /[*?[\]{}]/.test(pattern);
    if (!isGlob) {
      const count = counts.get(pattern) || 0;
      if (count > budget) {
        violations.push({ path: pattern, count, budget, isGlob: false });
      }
    } else {
      const matched = matcher(files, pattern);
      if (matched.length > budget) {
        violations.push({ path: pattern, count: matched.length, budget, isGlob: true });
      }
    }
  }

  return violations.sort((a, b) => (b.count - b.budget) - (a.count - a.budget));
}

// Lazy micromatch loader — synchronous via createRequire (ESM→CJS interop)
import { createRequire } from 'node:module';
let _matcher = null;
function getDefaultMatcher() {
  if (_matcher) return _matcher;
  try {
    const mm = createRequire(import.meta.url)('micromatch');
    _matcher = (files, pattern) => mm(files, pattern);
    return _matcher;
  } catch (err) {
    process.stderr.write(`  [budgets] micromatch unavailable (${err.message}); falling back to exact-match\n`);
    _matcher = (files, pattern) => files.filter(f => f === pattern);
    return _matcher;
  }
}
