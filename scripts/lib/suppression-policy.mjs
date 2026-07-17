/**
 * @fileoverview Unified R2+ suppression policy — single source of truth for all
 * suppression decisions. Feeds all three layers (system-prompt exclusions,
 * R2+ prompt augmentation, post-output suppression) from one resolved policy.
 * @module scripts/lib/suppression-policy
 */

import { learningConfig, GLOBAL_REPO_ID, UNKNOWN_FILE_EXT } from './config.mjs';
// Effective sample size (sum of decayed weights). Single source of truth is
// findings-tracker.mjs; imported for local use + re-exported so existing
// callers that import it from this module keep working. applyLazyDecay is the
// SAME single decay implementation — cloud and local evidence must share the
// mathematical semantics, so we never grow a second one here.
import { effectiveSampleSize, applyLazyDecay } from './findings-tracker.mjs';
export { effectiveSampleSize };

const MIN_FP_SAMPLES = learningConfig.minFpSamples;

// ── Policy Resolution ───────────────────────────────────────────────────────

/**
 * Build ledger exclusions from adjudication ledger entries.
 */
function buildLedgerExclusions(ledger) {
  if (!ledger?.entries) return [];
  return ledger.entries
    .filter(e => e.adjudicationOutcome === 'dismissed')
    .map(e => ({
      topicId: e.topicId,
      semanticHash: e.semanticHash,
      category: e.category,
      severity: e.severity,
      principle: e.affectedPrinciples?.[0],
      section: e.section
    }));
}

/**
 * Resolve FP patterns from local tracker + cloud patterns.
 * Applies lazy decay to get current effective sample sizes.
 *
 * @param {object} fpTracker
 * @param {object} cloudPatterns - `{repoPatterns, globalPatterns}`
 * @param {string} repoFingerprint - accepted but unused (kept for the existing
 *   call signature; scoping is carried on each pattern, not derived here)
 * @param {number} [nowMs] - evaluation instant, resolved ONCE by the caller so
 *   every pattern in a policy is decayed against the same moment
 */
function resolveFpPatterns(fpTracker, cloudPatterns, repoFingerprint, nowMs = Date.now()) {
  const patterns = [];
  let undatable = 0;

  // Local patterns
  if (fpTracker?.patterns) {
    for (const [key, p] of Object.entries(fpTracker.patterns)) {
      patterns.push({
        ...p,
        _key: key,
        scope: p.scope || 'global',
        repoId: p.repoId || GLOBAL_REPO_ID,
        fileExtension: p.fileExtension || UNKNOWN_FILE_EXT
      });
    }
  }

  // Cloud patterns (already have structured dimensions)
  if (cloudPatterns) {
    for (const cp of [...(cloudPatterns.repoPatterns || []), ...(cloudPatterns.globalPatterns || [])]) {
      // Avoid duplicates — cloud patterns supplement local
      const existing = patterns.find(p =>
        p.category === cp.category && p.severity === cp.severity &&
        p.principle === cp.principle && p.scope === cp.scope
      );
      if (!existing) {
        const mapped = {
          ...cp,
          _key: `${cp.category}::${cp.severity}::${cp.principle}`,
          decayedAccepted: cp.decayed_accepted ?? cp.decayedAccepted ?? 0,
          decayedDismissed: cp.decayed_dismissed ?? cp.decayedDismissed ?? 0
        };
        // Decay AT READ. The row's counters are as-at its last sync; without
        // this a pattern whose writer stops syncing keeps its ESS forever and
        // can suppress indefinitely. `last_dismissed_at` is the anchor (the
        // writer stamps it at sync time and only ever syncs patterns recorded
        // in that same run).
        //
        // An UNDATABLE anchor makes the pattern unusable for suppression — it
        // is NOT kept at its as-written ESS. "Fail-open" for a suppression
        // layer means failing toward KEEPING THE FINDING, never toward
        // suppressing it: a pattern whose freshness cannot be established is
        // exactly the immortal row this decay exists to kill, so preserving its
        // full strength would be fail-CLOSED in the recall-losing direction.
        // (The schema makes this unreachable for real rows — last_dismissed_at
        // is NOT NULL DEFAULT NOW() — so this is a defensive branch.)
        const anchor = Date.parse(cp.last_dismissed_at ?? cp.lastDismissedAt ?? '');
        if (Number.isFinite(anchor)) {
          const decayed = applyLazyDecay(
            { ...mapped, lastDecayTs: anchor }, learningConfig.outcomeHalfLifeMs, nowMs
          );
          patterns.push({ ...mapped, ...decayed });
        } else {
          undatable++;
        }
      }
    }
  }

  // Dropping a pattern is the safe direction, but it must not be silent — a
  // suppression layer that quietly discards its own inputs is unauditable.
  if (undatable > 0) {
    process.stderr.write(
      `  [cloud-fp] ${undatable} pattern(s) dropped — undatable decay anchor (cannot be shown current)\n`
    );
  }

  return patterns;
}

/**
 * Check if a finding matches a pattern/exclusion.
 */
function matchesFinding(pattern, finding) {
  const fCat = (finding.category || '').replaceAll(/\[.*?\]\s*/g, '').trim().toLowerCase();
  const pCat = (pattern.category || '').toLowerCase();
  const fPrin = (finding.principle || '').toLowerCase();
  const pPrin = (pattern.principle || '').toLowerCase();
  return fCat === pCat && (finding.severity || '') === (pattern.severity || '') &&
    (!pPrin || !fPrin || fPrin === pPrin);
}

/**
 * Resolve suppression policy from all sources.
 * Called once at audit start; the result feeds the post-output (Layer 3) check.
 *
 * Returns only the two fields that decide something. There is deliberately NO
 * prompt-rendering projection here: cloud-derived `category` text is
 * model-generated free text and cannot safely be interpolated into an
 * instruction-bearing prompt block without canonicalization, bounds, delimited
 * data-not-instruction rendering and a reopen-aware projection — and a
 * pre-generation "do not raise X" hint can stop a required regression reopen
 * from ever reaching `suppressReRaises`. See
 * docs/plans/cloud-fp-suppression-read-loop.md §"Why Layer 1 is NOT in this
 * plan". Do not re-add a formatter here; the future Layer-1 plan builds one
 * alongside its contracts.
 *
 * @param {object} ledger - Adjudication ledger
 * @param {object} fpTracker - FalsePositiveTracker instance
 * @param {object} cloudPatterns - `{repoPatterns, globalPatterns}`
 * @param {string} repoFingerprint - accepted but unused
 * @param {object} [opts]
 * @param {number} [opts.nowMs] - evaluation instant, resolved once per policy
 * @returns {{ledgerExclusions: object[], fpSuppressions: object[]}}
 */
export function resolveSuppressionPolicy(ledger, fpTracker, cloudPatterns, repoFingerprint, { nowMs = Date.now() } = {}) {
  const ledgerExclusions = buildLedgerExclusions(ledger);
  const fpSuppressions = resolveFpPatterns(fpTracker, cloudPatterns, repoFingerprint, nowMs);
  return { ledgerExclusions, fpSuppressions };
}

/**
 * Check a finding against the policy (Layer 3 post-output).
 * Confidence-aware: narrower scopes only override broader when they have enough evidence.
 * @param {object} finding
 * @param {object} policy
 * @returns {{ suppress: boolean, scope: string, confidence: number, reason: string }}
 */
export function shouldSuppressFinding(finding, policy) {
  // Check FP patterns with hierarchical scope resolution
  for (const scope of ['repo+fileType', 'repo', 'global']) {
    const match = policy.fpSuppressions.find(p =>
      p.scope === scope && matchesFinding(p, finding)
    );
    if (!match) continue;

    const ess = effectiveSampleSize(match);
    if (ess < MIN_FP_SAMPLES) continue;

    if ((match.ema ?? 0.5) < 0.15) {
      return {
        suppress: true,
        scope,
        confidence: Math.min(1, ess / 10),
        // The matched pattern's identity, so a suppression can be attributed in
        // the audit trail rather than being an anonymous disappearance.
        topicId: match._key || `fp:${match.category}:${match.severity}`,
        reason: `FP pattern (${scope}, n=${ess.toFixed(1)}, ema=${(match.ema ?? 0).toFixed(2)})`
      };
    }

    // Scope has enough data but doesn't suppress — stop checking broader scopes
    return { suppress: false, scope, confidence: 0, reason: 'Pattern exists but above threshold' };
  }

  // No FP pattern match — check ledger exclusions
  const ledgerMatch = policy.ledgerExclusions.find(e => matchesFinding(e, finding));
  if (ledgerMatch) {
    return { suppress: true, scope: 'ledger', confidence: 1, reason: `Ledger exclusion: ${ledgerMatch.topicId}` };
  }

  return { suppress: false, scope: 'none', confidence: 0, reason: 'No matching pattern' };
}

// ── Cloud FP policy construction (envelope → policy) ────────────────────────

/** A repo scope is usable only if it is complete — see buildCloudFpPolicy. */
function scopeCompleteness(scope) {
  if (!scope || scope.status === 'failed') {
    return { complete: false, reason: `failed:${scope?.errorName ?? 'unknown'}` };
  }
  if (scope.status === 'skipped') return { complete: false, reason: `skipped:${scope.reason ?? 'unknown'}` };
  if (scope.atLimit) return { complete: false, reason: 'truncated' };
  return { complete: true, reason: null };
}

/**
 * Build a cloud-only suppression policy from a loader envelope — PURE FUNCTION.
 *
 * Owns EVERY scope-status rule so the orchestrator holds none (the rules are
 * decisions, and decisions must be unit-testable rather than living as implicit
 * branching in the audit pipeline).
 *
 * **An incomplete NARROW (repo) scope voids the whole policy.**
 * `shouldSuppressFinding` walks repo+fileType → repo → global, and a
 * sufficiently-evidenced repo pattern that does NOT suppress stops the walk,
 * blocking global. So if the repo scope is missing patterns — whether the read
 * `failed`, was `skipped`, or was truncated (`atLimit`) — the narrow override
 * set is UNKNOWN, and letting global decide would read "absence of a repo
 * pattern" as "no repo override exists". All three causes are the same defect;
 * hence one rule over completeness, not three over statuses.
 *
 * The converse is safe and therefore allowed: an incomplete GLOBAL scope with a
 * complete repo scope still builds a repo-only policy. A repo pattern that
 * suppresses is authoritative (narrowest wins) and one that blocks is
 * authoritative too; a finding with no repo match just finds no global row and
 * is kept — under-suppression, the harmless direction.
 *
 * @param {object} envelope - from loadFalsePositivePatterns()
 * @param {object} [opts]
 * @param {number} [opts.nowMs]
 * @returns {{policy: object|null, lifecycleState: string, availability: object}}
 */
export function buildCloudFpPolicy(envelope, { nowMs = Date.now() } = {}) {
  const repo = scopeCompleteness(envelope?.repo);
  const global = scopeCompleteness(envelope?.global);
  const availability = { repo, global };

  if (!repo.complete) {
    return { policy: null, lifecycleState: 'load-failed', availability, reason: repo.reason };
  }

  const repoPatterns = envelope.repo.patterns ?? [];
  const globalPatterns = global.complete ? (envelope.global.patterns ?? []) : [];

  if (repoPatterns.length === 0 && globalPatterns.length === 0) {
    return {
      policy: null,
      lifecycleState: global.complete ? 'loaded-zero' : 'degraded-global-dropped',
      availability,
      reason: global.complete ? null : global.reason,
    };
  }

  const policy = resolveSuppressionPolicy(
    null, null, { repoPatterns, globalPatterns }, undefined, { nowMs }
  );
  return {
    policy,
    lifecycleState: global.complete ? 'loaded-active' : 'degraded-global-dropped',
    availability,
    reason: global.complete ? null : global.reason,
    counts: { repo: repoPatterns.length, global: globalPatterns.length },
  };
}

// ── Layer 3: post-output cloud FP suppression ──────────────────────────────

/**
 * Apply a cloud FP policy to a finding list — PURE FUNCTION.
 *
 * `exempt` carries findings that must never be suppressed by category-level
 * statistics — in practice the `reopened` set. A reopened finding is either a
 * regression check against a `fixed` ledger entry or a dismissed-entry reopen;
 * letting aggregate stats override a per-finding reopen decision would mask
 * regressions. Membership is object identity.
 *
 * @param {object[]} findings
 * @param {object} policy
 * @param {object} [opts]
 * @param {Set<object>} [opts.exempt]
 * @returns {{kept: object[], suppressed: object[]}}
 */
export function applyCloudFpSuppression(findings, policy, { exempt = new Set() } = {}) {
  const kept = [];
  const suppressed = [];
  for (const f of findings) {
    if (exempt.has(f)) { kept.push(f); continue; }
    const verdict = shouldSuppressFinding(f, policy);
    if (verdict.suppress) {
      suppressed.push({
        finding: f,
        reason: verdict.reason,
        scope: verdict.scope,
        confidence: verdict.confidence,
        // `matchedTopic`/`matchScore` mirror suppressReRaises' entry shape so
        // recordSuppressionEvents can persist a cloud suppression through the
        // SAME path, unchanged — a suppression with no attributable cause is
        // exactly the silent disappearance this layer must not produce.
        matchedTopic: verdict.topicId,
        matchScore: verdict.confidence,
      });
    } else {
      kept.push(f);
    }
  }
  return { kept, suppressed };
}

/**
 * The audit's cloud-FP pass — the single composition seam the orchestrator
 * calls UNCONDITIONALLY (a null policy is a no-op), so there is no branch at
 * the call site for a future edit to get wrong.
 *
 * **ARRAY OWNERSHIP: this ALWAYS returns a NEW array, never the input
 * reference.** The call site clears `allFindings` before re-pushing the result;
 * if the null path returned its input, the clear would empty the result too and
 * every finding would be erased on every cloud-disabled run. "Unchanged" here
 * means same contents and order — explicitly NOT the same array object.
 * (Finding objects are shared by reference, matching the existing
 * `kept`/`reopened` handling.)
 *
 * @param {object[]} findings
 * @param {object} opts
 * @param {object|null} opts.policy
 * @param {Set<object>} [opts.exempt]
 * @param {(line: string) => void} [opts.log]
 * @returns {{findings: object[], suppressedCount: number, suppressed: object[]}}
 */
export function runCloudFpPass(findings, { policy, exempt = new Set(), log = () => {} } = {}) {
  if (!policy) return { findings: [...findings], suppressedCount: 0, suppressed: [] };

  const { kept, suppressed } = applyCloudFpSuppression(findings, policy, { exempt });
  for (const s of suppressed) {
    log(`    [cloud-fp] suppressed: ${(s.finding.category || '').slice(0, 60)} — ${s.reason}\n`);
  }
  if (suppressed.length > 0) {
    log(`  [cloud-fp] suppressed ${suppressed.length} findings via cloud FP patterns\n`);
  }
  return { findings: kept, suppressedCount: suppressed.length, suppressed };
}
