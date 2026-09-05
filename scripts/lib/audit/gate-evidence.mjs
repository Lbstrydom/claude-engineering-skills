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
import { RUN_ID_RE, TREE_ID_RE } from '../commit-trailers.mjs';

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
 * The refusal reason for "there is no cloud run to bind this marker to".
 *
 * A named constant because TWO call sites must agree on it: this module's writer, which
 * declines, and `classifyGateEvidenceGap` below, which decides whether the decline is
 * worth telling the operator about. Two string literals is exactly the drift that let the
 * condition go unreported in the first place.
 */
export const GATE_EVIDENCE_NO_RUN_ID = 'no-cloud-run-id';

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
 * `auditedBranch` names the REF the audit ran on, and it is **required** — see
 * the throw below.
 *
 * @param {{runId: string, sid?: string|null, round?: number|null, auditedSha?: string|null, auditedTree?: string|null, auditedBranch?: string|null, nowIso?: string}} input
 * @returns {{runId: string, sid: string|null, round: number|null, auditedSha: string|null, auditedTree: string|null, auditedBranch: string|null, ts: string}}
 */
export function buildGateEvidence(input) {
  const { runId, sid = null, round = null, auditedSha = null, auditedTree = null, nowIso } = input ?? {};

  // `auditedBranch` is REQUIRED, and an omitted argument throws rather than
  // defaulting. This is the presence-vs-null contract on the WRITE side: `null`
  // is a MEANINGFUL value here — "detached at capture" — so a default of `null`
  // would silently record every attached audit as detached. The reader
  // (`resolveExpectedIdentity`) then compares an attached checkout against a
  // detached expectation and refuses EVERY ship. A guard that fails 100% of the
  // time is as useless as one that fails 0%, and a wrong default is how you get
  // there without anyone writing a bug.
  if (!input || !Object.hasOwn(input, 'auditedBranch')) {
    throw new TypeError(
      'buildGateEvidence: auditedBranch is required — pass the branch name, or an explicit null for a detached HEAD. '
      + 'Omitting it would record an attached audit as detached.',
    );
  }
  const { auditedBranch } = input;
  // `Object.hasOwn` answers "is the property THERE", not "is it usable" — so
  // `{auditedBranch: undefined}` (an uninitialised variable, a failed branch
  // resolution) sails past the check above. A bare String() would then coerce it
  // to the literal "undefined", the reader would accept that as a perfectly
  // valid branch NAME, and guard B would spend the rest of its life expecting a
  // branch called "undefined" — refusing every ship in the repo. That is the
  // same 100%-refusal failure the required-field check exists to prevent,
  // reached through the value instead of the key.
  if (auditedBranch !== null && typeof auditedBranch !== 'string') {
    throw new TypeError(
      `buildGateEvidence: auditedBranch must be a branch-name string or an explicit null (detached); got ${
        auditedBranch === undefined ? 'undefined' : typeof auditedBranch}. `
      + 'A non-string would be written to the marker and then read back as a branch name.',
    );
  }
  if (auditedBranch !== null && auditedBranch.trim() === '') {
    throw new TypeError(
      'buildGateEvidence: auditedBranch is an empty string — pass the branch name, or null for a detached HEAD.',
    );
  }

  return {
    runId,
    sid: sid ?? null,
    round: Number.isFinite(round) ? round : null,
    auditedSha: auditedSha ?? null,
    auditedTree: auditedTree ?? null,
    auditedBranch,   // already validated: a non-empty string, or null
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
 * @param {string|null} [opts.auditedSha] — HEAD at capture time
 * @param {string|null} [opts.auditedTree] — worktree content identity; REQUIRED
 * @param {string|null} opts.auditedBranch — the ref the audit ran on; REQUIRED
 *   (explicit `null` = detached at capture). Together with `auditedSha` this is
 *   the identity BUNDLE `/ship`'s guard B falls back to when no `--expect-head`
 *   was passed; a head without a ref disposition is refused, not degraded.
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
  ...rest
} = {}) {
  const write = adapters.atomicWriteFileSync || atomicWriteFileSync;
  // Forwarded by PRESENCE so buildGateEvidence's required-field check is the one
  // place that decides; defaulting here would defeat it.
  const hasBranch = Object.hasOwn(rest, 'auditedBranch');

  // No cloud run → no verifiable evidence. Writing a marker whose runId the
  // store cannot resolve would let `resolveEvidence` report `fresh` while
  // `evaluateGateVerification` refuses `passed` — a confusing half-state that
  // reads as "an audit ran but something is broken". Silence is honest here.
  if (!runId) return { written: false, reason: GATE_EVIDENCE_NO_RUN_ID };

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

  // buildGateEvidence THROWS on a malformed/missing auditedBranch — correct at a
  // pure boundary (it is a programming error), but this writer is best-effort
  // telemetry by contract and must never fail an audit that otherwise succeeded.
  // So the throw is caught here and degraded to "no marker", which reads as
  // `not-run` — the same direction every other failure in this function takes.
  let payload;
  try {
    payload = buildGateEvidence({
      runId, sid, round, auditedSha, auditedTree,
      ...(hasBranch ? { auditedBranch: rest.auditedBranch } : {}),
    });
  } catch (e) {
    log(`  [gate-evidence] refusing to build a marker (${e?.message || e}) — writing none; commit will read as not-run\n`);
    return { written: false, reason: 'invalid-input' };
  }

  // Validate the marker against the READER's contract before publishing it.
  // Writing a marker the reader will classify `malformed` is worse than writing
  // none: `{written: true}` reports success for evidence that can never verify,
  // and the failure then surfaces one layer away at commit time. The reader's
  // own regexes are imported rather than restated, so writer and reader cannot
  // drift into disagreeing about what a valid marker is.
  const defects = [];
  if (!RUN_ID_RE.test(String(payload.runId ?? ''))) defects.push(`runId=${JSON.stringify(payload.runId)}`);
  if (!TREE_ID_RE.test(String(payload.auditedTree ?? ''))) defects.push(`auditedTree=${JSON.stringify(payload.auditedTree)}`);
  if (Number.isNaN(Date.parse(payload.ts))) defects.push(`ts=${JSON.stringify(payload.ts)}`);
  if (defects.length > 0) {
    log(`  [gate-evidence] refusing to write a marker the reader would reject (${defects.join(', ')}) — commit will read as not-run\n`);
    return { written: false, reason: 'schema-invalid', payload, filePath: path.join(repoRoot, GATE_EVIDENCE_RELPATH) };
  }
  const filePath = path.join(repoRoot, GATE_EVIDENCE_RELPATH);
  try {
    write(filePath, JSON.stringify(payload, null, 2));
    return { written: true, payload, filePath };
  } catch (err) {
    log(`  [gate-evidence] marker write failed (${err?.code || err?.name || 'Error'}) — commit will read as not-run\n`);
    return { written: false, reason: 'write-failed', payload, filePath };
  }
}

/**
 * Why is there no marker for this run — and is that worth saying out loud?
 *
 * **The gap this closes (measured 2026-09-05, this repo).** The caller used to run the
 * whole gate-evidence block under `if (cloudRunId && !noCloudRecording)`, so the ONE
 * condition that silently costs a converged audit its provenance — the run row could not
 * be registered, most often because the store is one migration behind this checkout — was
 * the ONE condition that reported nothing. Two audits converged at `PASS`, exited 0, wrote
 * no marker, said nothing about it, and the commit that followed read `AI-Gate: not-run`:
 * one word away from an audit nobody ran. `writeGateEvidence` already HAD the honest
 * answer (`no-cloud-run-id`); it was simply never reached to give it.
 *
 * **Cloud-off is deliberately silent.** A local-only run is a supported mode, not a
 * failure (`durableWrite`'s `skipped`), and `not-run` is the correct trailer for it. A gate
 * that also fires there would print the same warning on every offline audit and be tuned
 * out — which is how the real one gets missed. So the discriminator is not "is there a
 * marker" but "was cloud recording BOTH intended and available, and the run still did not
 * register".
 *
 * Pure and total: every input combination lands on exactly one branch, so the direction
 * this must NOT fire is as testable as the direction it must.
 *
 * @param {{cloudRunId: string|null, noCloudRecording: boolean, cloudEnabled: boolean}} input
 * @returns {{report: boolean, reason: string}}
 */
export function classifyGateEvidenceGap({ cloudRunId, noCloudRecording, cloudEnabled } = {}) {
  // Observation-only (the tiered-shadow harness's fallback run): it is forbidden from
  // touching audit_runs at all, so having no marker is the contract, not a loss.
  if (noCloudRecording) return { report: false, reason: 'observation-only-run' };
  if (cloudRunId) return { report: false, reason: 'run-registered' };
  if (!cloudEnabled) return { report: false, reason: 'cloud-off' };
  return { report: true, reason: GATE_EVIDENCE_NO_RUN_ID };
}

/**
 * The operator-facing text for a reportable gap.
 *
 * Says three things a bare "no marker" does not: what was lost (provenance, not findings),
 * that the audit's own verdict is unaffected (so the reader does not go looking for a
 * different bug), and that re-running AFTER the remedy is the only repair — the marker
 * cannot be back-dated, and hand-writing `.audit/last-audit-run.json` is forgery the store
 * cross-check is designed to catch.
 *
 * `command` is passed in rather than derived here so this module stays free of the DB
 * layer; the caller already knows its layout.
 *
 * @param {{command: string}} input the layout-correct `setup-postgres --migrate` invocation
 * @returns {string} a complete, newline-terminated stderr block
 */
export function formatGateEvidenceGap({ command } = {}) {
  return '  [gate-evidence] cloud recording is ON but this run was never registered — no audit_runs row,\n'
    + '                  so no marker is written and a commit from this tree will read `AI-Gate: not-run`\n'
    + '                  however clean this audit was. The verdict above is unaffected; only its provenance is.\n'
    + `                  If the store is behind this revision (see the [learning] line above), run \`${command}\`\n`
    + '                  and RE-RUN the audit — the evidence cannot be reconstructed after the fact.\n';
}
