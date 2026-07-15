/**
 * @fileoverview Operation-keyed policy for OSS/OpenRouter structured-output calls.
 *
 * Plan: docs/plans/oss-call-reliability-hardening.md. Single source of truth
 * for per-operation timeout/retry policy AND worst-case-duration math, so
 * `oss-structured-output.mjs`'s real retry timing and `stage1-triage.mjs`'s
 * admission-guard math can never silently drift apart (round-2 M1).
 *
 * @module scripts/lib/oss-call-policy
 */

import fs from 'node:fs';
import { z } from 'zod';

/** The single, real source of truth for the retry-backoff constant (round-3 M2) —
 * `oss-structured-output.mjs`'s retry loop imports this EXACT symbol rather than
 * keeping its own literal. */
export const RETRY_BACKOFF_BASE_MS = 800;

const OperationPolicySchema = z.object({
  timeoutMs: z.number().int().positive().finite(),
  maxRetries: z.number().int().nonnegative().max(3),
});

const PolicyFileSchema = z.object({
  version: z.literal(1),
  calibrationNote: z.string().optional(),
  operations: z.record(z.string(), OperationPolicySchema),
  stage1TriageBudget: z.object({
    totalMs: z.number().int().positive().finite(),
    note: z.string().optional(),
  }),
}).refine(
  // Cross-field validation (audit-code round-1 M5): a syntactically valid
  // policy whose stage1TriageBudget can't fit even ONE stage1_triage retry
  // envelope would zero-admit every candidate forever — a silent, permanent
  // Stage-1 outage disguised as a passing config. Computed inline (not via
  // calculateWorstCaseAttemptDuration, to avoid a circular reference at
  // module-init time) using the SAME formula.
  (data) => {
    const stage1Policy = data.operations.stage1_triage;
    if (!stage1Policy) return true; // stage1_triage itself is optional at the schema level
    let backoffSum = 0;
    for (let attempt = 1; attempt <= stage1Policy.maxRetries; attempt++) backoffSum += RETRY_BACKOFF_BASE_MS * attempt;
    const worstCaseMs = stage1Policy.timeoutMs * (stage1Policy.maxRetries + 1) + backoffSum;
    return worstCaseMs <= data.stage1TriageBudget.totalMs;
  },
  { message: 'stage1TriageBudget.totalMs cannot accommodate even one stage1_triage retry envelope — every candidate would be immediately budget_exhausted', path: ['stage1TriageBudget', 'totalMs'] },
);

/** Today's literal defaults — unchanged, byte-identical for the 3 dormant/frozen callers. */
const LEGACY_DEFAULT_POLICY = Object.freeze({ timeoutMs: 300000, maxRetries: 2 });

const DEFAULT_POLICY_PATH = new URL('./oss-call-policy.json', import.meta.url);

/**
 * Worst-case duration for one attempt sequence: `timeoutMs × (maxRetries+1)`
 * plus the retry-backoff delay between each attempt
 * (`RETRY_BACKOFF_BASE_MS × sum(1..maxRetries)`).
 * @param {{timeoutMs: number, maxRetries: number}} policy
 * @returns {number}
 */
export function calculateWorstCaseAttemptDuration(policy) {
  const { timeoutMs, maxRetries } = policy;
  let backoffSum = 0;
  for (let attempt = 1; attempt <= maxRetries; attempt++) backoffSum += RETRY_BACKOFF_BASE_MS * attempt;
  return timeoutMs * (maxRetries + 1) + backoffSum;
}

/**
 * Factory for an injectable, cached-once policy resolver.
 * @param {{readFile?: (path: URL|string) => string}} [opts]
 */
export function createOssCallPolicyResolver({ readFile = fs.readFileSync } = {}) {
  let cached = null;

  function load() {
    if (cached) return cached;
    let raw;
    try {
      raw = readFile(DEFAULT_POLICY_PATH, 'utf-8');
    } catch (err) {
      throw new Error(`[oss-call-policy] failed to read ${DEFAULT_POLICY_PATH}: ${err.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`[oss-call-policy] ${DEFAULT_POLICY_PATH} is not valid JSON: ${err.message}`);
    }
    const validated = PolicyFileSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(`[oss-call-policy] ${DEFAULT_POLICY_PATH} failed schema validation: ${validated.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    cached = validated.data;
    return cached;
  }

  /**
   * @param {string|undefined} operation
   * @returns {{timeoutMs: number, maxRetries: number}}
   */
  function getOssOperationPolicy(operation) {
    if (operation === undefined) return LEGACY_DEFAULT_POLICY;
    const operations = load().operations;
    // audit-code round-1 M1: a plain property lookup (`operations[operation]`)
    // resolves inherited Object.prototype members (e.g. operation ===
    // 'toString' or 'constructor') as truthy, bypassing the unrecognized-
    // operation rejection. An own-property check closes this.
    if (!Object.hasOwn(operations, operation)) {
      throw new Error(`[oss-call-policy] unrecognized operation "${operation}" — not a key in oss-call-policy.json. This is very likely a typo or an incomplete policy rollout; refusing to silently fall back to the legacy 300s/2-retry budget.`);
    }
    // audit-code round-1 M3: return a frozen COPY, not the live cached
    // reference — a caller mutating the returned object must never corrupt
    // the shared cache seen by every other/future caller.
    return Object.freeze({ ...operations[operation] });
  }

  function getStage1TriageBudget() {
    return load().stage1TriageBudget.totalMs;
  }

  return { getOssOperationPolicy, getStage1TriageBudget };
}

// Production singleton — cached once, matching the pre-plan behavior of a
// module-level constant (no repeated I/O on the sequential Stage-1 hot path).
const defaultResolver = createOssCallPolicyResolver();

/** @param {string|undefined} operation */
export function getOssOperationPolicy(operation) {
  return defaultResolver.getOssOperationPolicy(operation);
}

export function getStage1TriageBudget() {
  return defaultResolver.getStage1TriageBudget();
}
