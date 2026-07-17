/**
 * @fileoverview False-positive tracker (v2) — structured dimensions, lazy-decay EMA,
 * multi-scope counters, and auto-suppression logic.
 * Split from findings.mjs (Wave 2, Phase 3) for Single Responsibility.
 * @module scripts/lib/findings-tracker
 */

import path from 'node:path';
import { MutexFileStore } from './file-store.mjs';
import { GLOBAL_REPO_ID, UNKNOWN_FILE_EXT, learningConfig } from './config.mjs';

// ── Lazy-Decay Model ───────────────────────────────────────────────────────

/**
 * Apply lazy decay to a pattern's weights — PURE FUNCTION.
 * Returns a new decayed view without mutating the input.
 *
 * `nowMs` is injectable so callers can evaluate a whole policy against ONE
 * instant (rather than re-reading the wall clock per pattern mid-loop) and so
 * decay tests can pin a fixed evaluation time instead of monkey-patching global
 * time or using `Date.now()`-relative fixtures that silently rot. The default
 * preserves the original behaviour exactly for every existing caller.
 *
 * @param {object} pattern
 * @param {number} halfLifeMs
 * @param {number} [nowMs] - evaluation instant; defaults to Date.now()
 * @returns {object} Decayed copy
 */
export function applyLazyDecay(pattern, halfLifeMs = learningConfig.outcomeHalfLifeMs, nowMs = Date.now()) {
  const now = nowMs;
  const lambda = Math.LN2 / halfLifeMs;
  const elapsed = now - (pattern.lastDecayTs || now);

  const dA = pattern.decayedAccepted || 0;
  const dD = pattern.decayedDismissed || 0;

  if (elapsed <= 0) {
    const total = dA + dD;
    return { ...pattern, ema: total > 0 ? dA / total : 0.5 };
  }

  const decay = Math.exp(-lambda * elapsed);
  const decayedAccepted = dA * decay;
  const decayedDismissed = dD * decay;
  const total = decayedAccepted + decayedDismissed;

  return {
    ...pattern,
    decayedAccepted,
    decayedDismissed,
    lastDecayTs: now,
    ema: total > 0 ? decayedAccepted / total : 0.5
  };
}

/**
 * Effective sample size: sum of decayed weights.
 */
export function effectiveSampleSize(pattern) {
  return (pattern.decayedAccepted || 0) + (pattern.decayedDismissed || 0);
}

/**
 * Record an observation with lazy decay.
 * Mutates the pattern in place (for persistence).
 */
export function recordWithDecay(pattern, accepted, halfLifeMs = learningConfig.outcomeHalfLifeMs) {
  const decayed = applyLazyDecay(pattern, halfLifeMs);

  if (accepted) {
    decayed.decayedAccepted += 1.0;
    decayed.accepted = (pattern.accepted || 0) + 1;
  } else {
    decayed.decayedDismissed += 1.0;
    decayed.dismissed = (pattern.dismissed || 0) + 1;
  }

  const total = decayed.decayedAccepted + decayed.decayedDismissed;
  decayed.ema = total > 0 ? decayed.decayedAccepted / total : 0.5;
  decayed.lastUpdated = Date.now();

  Object.assign(pattern, decayed);
}

// ── FP Pattern Key Helpers ─────────────────────────────────────────────────

/**
 * Extract structured dimensions from a finding.
 */
export function extractDimensions(finding, repoFingerprint = null, filePath = null) {
  const category = (finding.category || '').replaceAll(/\[.*?\]\s*/g, '').trim().toLowerCase();
  const principle = (finding.principle || 'unknown').toLowerCase();
  const severity = finding.severity || 'UNKNOWN';
  const repoId = repoFingerprint || GLOBAL_REPO_ID;
  const fileExtension = filePath ? path.extname(filePath).replace('.', '').toLowerCase() || UNKNOWN_FILE_EXT : UNKNOWN_FILE_EXT;

  return { category, severity, principle, repoId, fileExtension };
}

/**
 * Build a pattern key from structured dimensions + scope.
 */
export function buildPatternKey(dims) {
  return `${dims.category}::${dims.severity}::${dims.principle}::${dims.repoId}::${dims.fileExtension}::${dims.scope}`;
}

// ── False Positive Tracker (v2) ────────────────────────────────────────────

/**
 * False positive tracker with structured dimensions, multi-scope counters,
 * and lazy-decay EMA. Auto-suppresses patterns with consistently high dismiss rates.
 */
export class FalsePositiveTracker {
  /**
   * @param {string} statePath
   * @param {object} [options]
   * @param {MutexFileStore} [options.store] - Injected store (for testing)
   */
  constructor(statePath = '.audit/fp-tracker.json', options = {}) {
    this.statePath = path.resolve(statePath);
    this._store = options.store || new MutexFileStore(this.statePath);
    this.patterns = this._store.load();
    if (!this.patterns || typeof this.patterns !== 'object') this.patterns = {};
    /** Pattern keys touched by record() in THIS process — the cloud-sync payload. */
    this.dirtyKeys = new Set();
  }

  /** Generate a legacy-compatible pattern key from a finding. */
  patternKey(finding) {
    const category = (finding.category || '').replaceAll(/\[.*?\]\s*/g, '').trim().toLowerCase();
    const principle = (finding.principle || 'unknown').toLowerCase();
    return `${category}::${finding.severity || 'UNKNOWN'}::${principle}`;
  }

  /**
   * Record outcome with structured dimensions at all 3 scope levels.
   * Falls back to legacy single-key if no repo context is provided.
   */
  record(finding, accepted, repoFingerprint = null, filePath = null) {
    if (!repoFingerprint) {
      const key = this.patternKey(finding);
      if (!this.patterns[key]) {
        this.patterns[key] = {
          dismissed: 0, accepted: 0, ema: 0.5,
          decayedAccepted: 0, decayedDismissed: 0,
          lastDecayTs: Date.now(), scope: 'global',
          repoId: GLOBAL_REPO_ID, fileExtension: UNKNOWN_FILE_EXT,
          firstSeen: Date.now(), lastUpdated: Date.now()
        };
      }
      recordWithDecay(this.patterns[key], accepted);
      this.dirtyKeys.add(key);
      this._store.save(this.patterns);
      return;
    }

    const dims = extractDimensions(finding, repoFingerprint, filePath);
    const scopes = [
      { ...dims, scope: 'repo+fileType' },
      { ...dims, fileExtension: UNKNOWN_FILE_EXT, scope: 'repo' },
      { ...dims, repoId: GLOBAL_REPO_ID, fileExtension: UNKNOWN_FILE_EXT, scope: 'global' }
    ];

    for (const scopeDims of scopes) {
      const key = buildPatternKey(scopeDims);
      if (!this.patterns[key]) {
        this.patterns[key] = {
          ...scopeDims,
          dismissed: 0, accepted: 0, ema: 0.5,
          decayedAccepted: 0, decayedDismissed: 0,
          lastDecayTs: Date.now(),
          firstSeen: Date.now(), lastUpdated: Date.now()
        };
      }
      recordWithDecay(this.patterns[key], accepted);
      this.dirtyKeys.add(key);
    }

    this._store.save(this.patterns);
  }

  /**
   * Patterns touched by record() in this process — the payload for
   * syncFalsePositivePatterns. Syncing only these (instead of the whole
   * map) keeps a run's cloud write proportional to its deliberated
   * findings rather than rewriting every tracked pattern (thousands of
   * rows) on every audit — the write-amplification half of the
   * 2026-07-17 Disk IO incident.
   */
  dirtyPatterns() {
    const out = {};
    for (const key of this.dirtyKeys) {
      if (this.patterns[key]) out[key] = this.patterns[key];
    }
    return out;
  }

  /**
   * Should this finding pattern be auto-suppressed, and WHICH pattern decided?
   * Hierarchical with confidence-aware override.
   *
   * The tracker has always known which scope fired and thrown it away —
   * `shouldSuppress` returns a bare boolean. That made local suppressions
   * unattributable: a suppression recorded with a synthesized topic id would
   * name a pattern that may not be the one that actually fired, which is
   * confidently-wrong provenance (worse than absent, because it reads as
   * authoritative). Returning the matched key lets a local suppression flow
   * through `recordSuppressionEvents` with the same honesty as a cloud one.
   *
   * @param {object} finding
   * @param {string|null} [repoFingerprint]
   * @param {string|null} [filePath]
   * @returns {{suppress: boolean, key: string|null, scope: string|null, ess: number|null, ema: number|null}}
   */
  shouldSuppressWithReason(finding, repoFingerprint = null, filePath = null) {
    const MIN_FP_SAMPLES = learningConfig.minFpSamples;
    const miss = { suppress: false, key: null, scope: null, ess: null, ema: null };

    if (repoFingerprint) {
      const dims = extractDimensions(finding, repoFingerprint, filePath);
      const scopeChecks = [
        { ...dims, scope: 'repo+fileType' },
        { ...dims, fileExtension: UNKNOWN_FILE_EXT, scope: 'repo' },
        { ...dims, repoId: GLOBAL_REPO_ID, fileExtension: UNKNOWN_FILE_EXT, scope: 'global' }
      ];

      for (const scopeDims of scopeChecks) {
        const key = buildPatternKey(scopeDims);
        const p = this.patterns[key];
        if (!p) continue;

        const decayed = applyLazyDecay(p);
        const ess = effectiveSampleSize(decayed);
        if (ess < MIN_FP_SAMPLES) continue;

        // This scope decided — narrow overrides broad, so the walk stops here
        // whichever way it goes. `key` is the pattern that made the call.
        return { suppress: decayed.ema < 0.15, key, scope: scopeDims.scope, ess, ema: decayed.ema };
      }
    }

    const legacyKey = this.patternKey(finding);
    const p = this.patterns[legacyKey];
    if (!p) return miss;
    const decayed = applyLazyDecay(p);
    const ess = effectiveSampleSize(decayed);
    if (ess < MIN_FP_SAMPLES) {
      // Legacy raw-count fallback — deliberately preserved (see the cloud-FP
      // plan's Out of Scope: unifying it with the policy's decayed-only gate
      // needs a parity suite first).
      const total = (p.accepted || 0) + (p.dismissed || 0);
      return {
        suppress: total >= 5 && (p.ema ?? 0.5) < 0.15,
        key: legacyKey, scope: 'legacy', ess, ema: p.ema ?? 0.5,
      };
    }
    return { suppress: decayed.ema < 0.15, key: legacyKey, scope: 'legacy', ess, ema: decayed.ema };
  }

  /**
   * Should this finding pattern be auto-suppressed?
   * Hierarchical with confidence-aware override.
   *
   * Delegates to `shouldSuppressWithReason` — the boolean contract is unchanged,
   * and the existing suite passing untouched is the proof of that.
   */
  shouldSuppress(finding, repoFingerprint = null, filePath = null) {
    return this.shouldSuppressWithReason(finding, repoFingerprint, filePath).suppress;
  }

  /** Get suppression report for all tracked patterns. */
  getReport() {
    return Object.entries(this.patterns)
      .map(([key, p]) => {
        const decayed = applyLazyDecay(p);
        const ess = effectiveSampleSize(decayed);
        return {
          pattern: key,
          scope: p.scope || 'global',
          total: (p.accepted || 0) + (p.dismissed || 0),
          effectiveSampleSize: ess,
          acceptRate: decayed.ema,
          suppressed: ess >= learningConfig.minFpSamples && decayed.ema < 0.15
        };
      })
      .sort((a, b) => a.acceptRate - b.acceptRate);
  }
}
