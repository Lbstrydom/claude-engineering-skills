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

  const impact = [...new Set(refactor.resolvedTopicIds)].reduce((sum, topicId) => {
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
 * Find debt entries whose OWN `reviewDeadline` has passed (docs/plans/
 * debt-ledger-persisted-record-contract.md §2 Fix D) — a different question
 * from `findStaleEntries`'s age-based signal: "did you say you'd look at
 * this by X" vs "is this just old". An entry with no `reviewDeadline` is
 * never flagged (silence is not a deadline).
 *
 * Excludes superseded entries (`supersededBy` set) — Gemini gate round-1 G3:
 * an entry already retired by its replacement has a moot review deadline,
 * and without this exclusion it would nag forever after being superseded.
 *
 * @param {object[]} debtEntries - hydrated debt entries
 * @param {Date} [now=new Date()]
 * @returns {string[]} topicIds of entries overdue for review
 */
export function findOverdueForReview(debtEntries, now = new Date()) {
  const nowMs = now.getTime();
  return debtEntries
    .filter(e => {
      if (e.supersededBy) return false;
      const t = Date.parse(e.reviewDeadline);
      return Number.isFinite(t) && t < nowMs;
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

// ── Duplicate topicId detection ─────────────────────────────────────────────

/**
 * Find topicIds that appear more than once in the ledger's entry array.
 *
 * The ledger is a flat JSON array with no VCS-aware merge driver, so a plain
 * `git merge` that touches two different array elements on each branch
 * unions the line ranges instead of raising a conflict — topicId is a
 * logical record key `git` cannot see. This surfaced as real corruption in a
 * consumer (22 duplicated topicIds / 44 elements), several with one copy
 * `status:"resolved"` sitting beside a still-open twin. Nothing in the
 * ledger's own tooling asserted uniqueness across the whole array, so this
 * is the detection half of the fix — see debt-health-check.mjs.
 *
 * **A `.gitattributes` merge driver is REJECTED, not merely deferred** (a
 * brainstorm session cross-examined this design before docs/plans/
 * debt-ledger-merge-safety.md was written): a topicId-keyed merge driver
 * never runs on a GitHub/GitLab web-UI merge or a bot-driven auto-merge — it
 * only fires on a LOCAL `git merge`, so any consumer whose PRs merge through
 * the hosted UI (the common case) would have it silently bypassed on exactly
 * the merges that caused the incident. That is a structural blind spot in the
 * mechanism itself, not a per-clone adoption-friction problem that more setup
 * tooling could close. See the plan doc for what was built instead: a
 * merge-friendly on-disk serialization (`serializeLedgerForDisk`,
 * `debt-ledger.mjs`) plus a CI-blocking mode for this function
 * (`debt-health-check.mjs --fail-on-duplicates`) that runs on every
 * `pull_request`-triggered check regardless of merge path. A full
 * per-topicId-file storage migration remains a separately-scoped, larger
 * option — see that plan's Risk Register for why it wasn't built and its
 * revisit trigger.
 *
 * @param {object[]} debtEntries - hydrated debt entries
 * @returns {{topicId: string, count: number}[]} sorted by count desc, then topicId
 */
export function findDuplicateTopicIds(debtEntries) {
  const counts = new Map();
  for (const e of debtEntries) {
    if (!e?.topicId) continue;
    counts.set(e.topicId, (counts.get(e.topicId) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([topicId, count]) => ({ topicId, count }))
    .sort((a, b) => (b.count - a.count) || a.topicId.localeCompare(b.topicId));
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
