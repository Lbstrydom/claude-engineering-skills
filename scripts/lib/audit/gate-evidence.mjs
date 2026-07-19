/**
 * @fileoverview Writer for `.audit/last-audit-run.json` — the gate-evidence
 * marker that `scripts/ship-commit.mjs` reads to decide whether `AI-Gate:`
 * may say anything other than `not-run`.
 *
 * **Why this file exists.** `resolveEvidence` (lib/commit-trailers.mjs) has
 * always READ this marker, and `evaluateGateVerification` has always been able
 * to verify a `passed` gate against the store — but **nothing in the repo ever
 * wrote the marker**. Verified 2026-07-18: `grep -rn "last-audit-run" scripts/`
 * returned four readers and zero writers, and the file on disk was dated
 * 2026-06-04. So `AI-Gate: passed` was structurally unreachable, and every
 * commit shipped `not-run` — including commits behind a converged multi-round
 * GPT audit and a consolidated Gemini APPROVE. The trailer understated the
 * rigor behind the change, which is the opposite of what a provenance trailer
 * is for.
 *
 * **The marker proves an audit RAN, never that it PASSED.** That split is
 * deliberate and load-bearing (commit-trailers R1 H3/H5): freshness is a local
 * file anyone could touch, so it can only ever be necessary, not sufficient.
 * `passed` additionally requires the store's `audit_runs.round_converged_after`
 * for this exact `runId` — a value written by the pipeline, not by the shipper.
 * Hence this module writes the marker for EVERY completed cloud-backed code
 * audit, converged or not: an audit that ran and did not converge is honest
 * evidence, and it correctly yields `waived`-or-fix rather than `passed`.
 *
 * @module scripts/lib/audit/gate-evidence
 */

import path from 'node:path';
import { atomicWriteFileSync } from '../file-io.mjs';

/**
 * The marker's schema, matched to `resolveEvidence`'s validation exactly:
 *   - `runId` MUST satisfy `RUN_ID_RE` (`/^[A-Za-z0-9-]{8,64}$/`) — a UUID does.
 *   - `ts` MUST be `Date.parse`-able, and is compared against the HEAD
 *     committer time (`fresh = Date.parse(ts) > headCommitTs * 1000`).
 * `sid` and `round` are carried for human/dashboard diagnostics; the validator
 * ignores them, so they can never make a malformed marker read as valid.
 */

/** Relative location — a single constant so the writer and every reader agree. */
export const GATE_EVIDENCE_RELPATH = path.join('.audit', 'last-audit-run.json');

/**
 * Build the marker payload. Pure, so the schema contract is unit-testable
 * against the real validator without touching a filesystem.
 *
 * `auditedTree` / `auditedSha` name the SUBJECT the audit read (E1, R2-H1).
 * Timestamp freshness alone is not identity: a run started against commit A can
 * terminate after commit B's timestamp, so `ts > headCommitTs` reads fresh and
 * `passed` attaches to B — a commit that was never audited. Freshness answers
 * "when", never "what". `auditedTree` is the only one of the three checks a
 * post-audit edit cannot satisfy.
 *
 * @param {{runId: string, sid?: string|null, round?: number|null, auditedSha?: string|null, auditedTree?: string|null, nowIso?: string}} input
 * @returns {{runId: string, sid: string|null, round: number|null, auditedSha: string|null, auditedTree: string|null, ts: string}}
 */
export function buildGateEvidence({ runId, sid = null, round = null, auditedSha = null, auditedTree = null, nowIso }) {
  return {
    runId,
    sid: sid ?? null,
    round: Number.isFinite(round) ? round : null,
    auditedSha: auditedSha ?? null,
    auditedTree: auditedTree ?? null,
    ts: nowIso ?? new Date().toISOString(),
  };
}

/**
 * Write the gate-evidence marker for a completed audit round.
 *
 * Best-effort by contract: this is provenance telemetry, and a write failure
 * must never fail an audit that otherwise succeeded. A missing marker degrades
 * to `AI-Gate: not-run`, which is the honest reading of "no evidence" — the
 * same direction the readers already fail toward.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string|null} opts.runId — the cloud `audit_runs.id`; absent → no write
 * @param {'code'|'plan'} [opts.mode='code']
 * @param {string|null} [opts.sid]
 * @param {number|null} [opts.round]
 * @param {string|null} [opts.auditedSha] — HEAD at capture time (cheap secondary)
 * @param {string|null} [opts.auditedTree] — worktree content identity; REQUIRED
 * @param {(msg: string) => void} [opts.log]
 * @param {{atomicWriteFileSync?: Function}} [opts.adapters] — injected for tests
 * @returns {{written: boolean, reason?: string, payload?: object, filePath?: string}}
 */
export function writeGateEvidence({
  repoRoot,
  runId,
  mode = 'code',
  sid = null,
  round = null,
  auditedSha = null,
  auditedTree = null,
  log = (m) => process.stderr.write(m),
  adapters = {},
} = {}) {
  const write = adapters.atomicWriteFileSync || atomicWriteFileSync;

  // No cloud run → no verifiable evidence. Writing a marker whose runId the
  // store cannot resolve would let `resolveEvidence` report `fresh` while
  // `evaluateGateVerification` refuses `passed` — a confusing half-state that
  // reads as "an audit ran but something is broken". Silence is honest here.
  if (!runId) return { written: false, reason: 'no-cloud-run-id' };

  // Plan audits are excluded: the marker gates a COMMIT, and `--gate passed`
  // asserts the shipped CODE was audited. A plan-mode run would make a
  // docs-only commit look code-gated. (`resolveEvidence` has no mode field to
  // discriminate on, so the discrimination must happen here, at the writer.)
  if (mode !== 'code') return { written: false, reason: `mode-not-code:${mode}` };

  // No content identity → the run is EVIDENCE-LESS, not merely under-described
  // (E1, hop 1). A marker without `auditedTree` can only ever be verified by
  // freshness, which is exactly the false-pass hole this field exists to close:
  // it would let `passed` attach to a commit whose content was never audited.
  // Writing nothing degrades to `not-run` — the honest reading — whereas writing
  // a tree-less marker would manufacture evidence that cannot support its claim.
  // This is also what makes the field's introduction fail-closed for legacy
  // pointers: they simply never verify.
  if (!auditedTree) {
    log('  [gate-evidence] no audited-tree identity (VCS capture failed) — writing no marker; commit will read as not-run\n');
    return { written: false, reason: 'no-audited-tree' };
  }

  const payload = buildGateEvidence({ runId, sid, round, auditedSha, auditedTree });
  const filePath = path.join(repoRoot, GATE_EVIDENCE_RELPATH);
  try {
    write(filePath, JSON.stringify(payload, null, 2));
    return { written: true, payload, filePath };
  } catch (err) {
    log(`  [gate-evidence] marker write failed (${err?.code || err?.name || 'Error'}) — commit will read as not-run\n`);
    return { written: false, reason: 'write-failed', payload, filePath };
  }
}
