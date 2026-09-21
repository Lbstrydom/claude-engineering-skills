/**
 * @fileoverview The per-call cost ledger for experiment 5 — every provider
 * call (a cold pass, an apparatus 5-pass call, a gate call, a retry) appends
 * one row here, so `$/diff` is read from a real record instead of estimated.
 * Two aggregation predicates are deliberately NOT the same function (Gemini
 * R3-G2): scoring must credit a SHARED call (the 5-pass calls behind both
 * Arm A and Arm A+) to every arm that shares it, while the run's overall
 * budget must count that same call once, by its unique `callId`.
 *
 * docs/plans/reviewer-cost-value-experiment.md §2 ("Cost is recorded per call
 * into a ledger, then aggregated").
 *
 * @module scripts/lib/solo-control/ledger
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import { atomicWriteFileSync } from '../file-io.mjs';

/** callId is deterministic over the cell's identity — NOT randomly generated
 * — so a resumed/re-run cell for the SAME (commit, purpose, pass, chunk,
 * repeat, model) produces the SAME id, and a shared apparatus pass computed
 * once for two configurations (A and A+) is recognisably one call under two
 * `sharedBy` labels rather than two rows that happen to agree by luck. */
export function computeCallId({ commit, purpose, pass, chunkIndex, repeatIndex, resolvedModel }) {
  for (const [k, v] of Object.entries({ commit, purpose, pass, resolvedModel })) {
    if (typeof v !== 'string' || v.length === 0) throw new Error(`computeCallId: "${k}" must be a non-empty string, got ${JSON.stringify(v)}`);
  }
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) throw new Error(`computeCallId: chunkIndex must be a non-negative integer, got ${JSON.stringify(chunkIndex)}`);
  if (!Number.isInteger(repeatIndex) || repeatIndex < 0) throw new Error(`computeCallId: repeatIndex must be a non-negative integer, got ${JSON.stringify(repeatIndex)}`);
  return createHash('sha256').update([commit, purpose, pass, chunkIndex, repeatIndex, resolvedModel].join('|')).digest('hex');
}

export const LedgerRowSchema = z.object({
  callId: z.string(),
  arm: z.string(),
  sharedBy: z.array(z.string()).nullable().default(null),
  commit: z.string(),
  repeat: z.number().int().min(0),
  chunk: z.number().int().min(0),
  pass: z.string(),
  purpose: z.enum(['pass', 'gate', 'retry']),
  resolvedModel: z.string(),
  recipient: z.string(),
  usage: z.record(z.string(), z.number()).nullable().default(null),
  costUsd: z.number().nullable(),
  pricingVersion: z.string().nullable(),
  providerCostUsd: z.number().nullable().default(null),
  state: z.enum(['ok', 'conformance-miss', 'provider-error', 'excluded']),
});

/** Append one validated row to the JSONL ledger. Never overwrites — the
 * ledger is a log, and a partial run's rows must survive a later resumed
 * run appending more. */
export function appendLedgerRow(ledgerPath, row) {
  const parsed = LedgerRowSchema.parse(row);
  fs.appendFileSync(ledgerPath, JSON.stringify(parsed) + '\n');
  return parsed;
}

/** Read every row currently on the ledger. Empty file / missing file both
 * read as `[]` — an experiment that has not spent yet is not an error. */
export function readLedger(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * SCORING aggregate for one arm: sum `costUsd` over every row that belongs
 * to the arm directly OR shares a row with it (the apparatus 5-pass calls
 * behind both A and A+). This is deliberately the LOOSER of the two
 * predicates — an arm's own $/diff must include compute it shares with a
 * sibling configuration, or A+ would appear to cost only its gate call.
 *
 * @returns {{costUsd: number|null, complete: boolean}} `complete:false` (and
 *   `costUsd:null`) when any contributing row has `costUsd:null` — an
 *   unpriced call makes the aggregate unknown, never a partial sum that
 *   silently reads low.
 */
export function aggregateCostForArm(rows, arm) {
  const mine = rows.filter((r) => r.arm === arm || (r.sharedBy || []).includes(arm));
  if (mine.length === 0) return { costUsd: null, complete: false };
  if (mine.some((r) => r.costUsd == null)) return { costUsd: null, complete: false };
  return { costUsd: +mine.reduce((a, r) => a + r.costUsd, 0).toFixed(4), complete: true };
}

/**
 * BUDGET aggregate over the whole run: sum `costUsd` by UNIQUE `callId` — a
 * call shared by two configurations is one spend event and must be counted
 * once, never once per configuration that shares it. This is the stricter
 * predicate; conflating it with `aggregateCostForArm` above is exactly the
 * bug Gemini R3-G2 caught in an earlier draft (a single shared schema with
 * no stated predicate for either use).
 *
 * @returns {{spentUsd: number, complete: boolean}} `complete:false` when any
 *   row lacks a price — the running total is then a FLOOR, not the true
 *   spend, and callers must not compare it to the budget ceiling as if exact.
 */
export function aggregateBudgetSpent(rows) {
  const byCallId = new Map();
  for (const r of rows) if (!byCallId.has(r.callId)) byCallId.set(r.callId, r);
  const unique = [...byCallId.values()];
  const complete = unique.every((r) => r.costUsd != null);
  const spentUsd = +unique.reduce((a, r) => a + (r.costUsd ?? 0), 0).toFixed(4);
  return { spentUsd, complete };
}
