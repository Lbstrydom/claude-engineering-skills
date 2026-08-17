/**
 * @fileoverview Arg construction + subprocess execution (D2).
 *
 * Moved from `scripts/bakeoff-collect.mjs` (plan: comparison-tooling-
 * consolidation.md, Phase 2). Per D2a: may import `bakeoff/scope.mjs` only;
 * must NOT import any `scripts/*.mjs` entry point, `bakeoff/arms.mjs`,
 * `bakeoff/summary.mjs`, or `bakeoff/progress.mjs`.
 *
 * **One necessary deviation from verbatim (discovered during Phase 2
 * implementation, same resolution pattern as `campaign/promote.mjs`'s log
 * parameter-passing fix in D2b).** The original `runArm` called
 * `readArmResult(out)` directly on spawn success — but `readArmResult`
 * needs `armCostUsd`/`cohortDigest`/`distinctFindingCount`, all exported by
 * `bakeoff/summary.mjs`, which this module is explicitly forbidden to
 * import (spawn → summary is not on the D2a allow-list, and adding it would
 * be exactly the kind of decorative widening D2b rejects elsewhere). So
 * `runArm` now returns the raw spawn outcome — `{ok:true, outPath}` on exit
 * 0, `{error, stderrTail}` otherwise — and the caller (the entry point,
 * which already imports both `spawn` and `summary`) reads the result file
 * itself. Same shape as `promote.mjs` taking log entries as a parameter
 * instead of reading the log itself: the impure step moves to the one layer
 * allowed to see both sides.
 *
 * @module scripts/lib/bakeoff/spawn
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

/**
 * The argv for one arm's `gemini-review` invocation. Pure, so the `--run-id`
 * wiring is assertable without spawning a reviewer or a database.
 *
 * @param {{id: string, args?: string[]}} arm
 * @param {{transcript: string, plan: string, mode?: string|null, out: string, runId?: string|null, envelopeScope?: string|null, campaignDigest?: string|null}} ctx
 */
export function buildArmArgs(arm, { transcript, plan, mode, out, runId, envelopeScope = null, campaignDigest = null }) {
  const args = ['scripts/gemini-review.mjs', 'review', plan, transcript, '--out', out, ...(arm.args || [])];
  if (mode) args.push('--mode', mode);
  // Without this, `runShadowAndPersist` returns early at `if (!runId) return`
  // and the ENTIRE cloud write is a silent no-op — the defect that left
  // snapshots 2-3 with `final_review_shadow_model = NULL` and no findings to
  // adjudicate, so §6.3's "accepted HIGH/MED clusters" had nothing to score.
  //
  // Omitted rather than passed as an empty string when registration failed: a
  // blank `--run-id` would be consumed as the flag's VALUE and silently write
  // nowhere, which is the same silence with an extra step.
  if (runId) args.push('--run-id', runId);
  // Campaign scope binding (plan KD-6). Passed EXPLICITLY per arm rather than
  // via env — a child spawned with an env var could not be told apart from an
  // operator's own FINAL_REVIEW_SHADOW_SCOPE, which is exactly the ambient-env
  // failure mode this whole mechanism exists to close. Both flags travel
  // together: envelopeScope is meaningless provenance without knowing WHICH
  // signed cohort declared it.
  if (envelopeScope) args.push('--envelope-scope', envelopeScope);
  if (campaignDigest) args.push('--campaign-digest', campaignDigest);
  return args;
}

/**
 * Spawn one arm's reviewer. Returns the raw outcome only — parsing the
 * result file is the caller's job (see the module-level note on why).
 *
 * @returns {{ok: true, outPath: string} | {error: string, stderrTail?: string}}
 */
export function runArm(arm, { transcript, plan, mode, outDir, id, runId, envelopeScope, campaignDigest }) {
  const out = path.join(outDir, `${id}-${arm.id}.json`);
  const args = buildArmArgs(arm, { transcript, plan, mode, out, runId, envelopeScope, campaignDigest });
  process.stderr.write(`  [bakeoff] arm ${arm.id}…\n`);
  const startedMs = Date.now();
  // Three-tier precedence, not spread order alone (which can only express
  // "last wins" between two sources): an operator's own explicit
  // GEMINI_REVIEW_TIMEOUT_MS wins outright; else a route's own per-arm
  // default (`arm.env.GEMINI_REVIEW_TIMEOUT_MS`, e.g. alibaba's longer
  // ceiling — see bakeoff/arms.mjs transportForModel) applies; else 300s.
  // The unconditional `GEMINI_REVIEW_TIMEOUT_MS: ... || '300000'` this
  // replaced always stomped a per-arm value regardless of `...arm.env`
  // appearing before it in the spread — the per-arm override was dead code
  // until this fix (2026-08-17, qwen intermittent-timeout follow-up).
  const timeoutMs = process.env.GEMINI_REVIEW_TIMEOUT_MS || arm.env?.GEMINI_REVIEW_TIMEOUT_MS || '300000';
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf-8',
    env: { ...process.env, ...arm.env, GEMINI_REVIEW_TIMEOUT_MS: timeoutMs },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const elapsedMs = Date.now() - startedMs;
  // `status` and `elapsedMs` ride on BOTH shapes because the retry policy below
  // is a function of them: a hard-deadline exit is only distinguishable from a
  // bad-credentials exit by its code, and "the failed attempt took 900s" is the
  // one number that tells an operator a retried arm was not a first-try success.
  if (r.status !== 0) return { error: `exit ${r.status}`, stderrTail: String(r.stderr || '').slice(-400), status: r.status, elapsedMs };
  return { ok: true, outPath: out, status: r.status, elapsedMs };
}

/**
 * The reviewer CLI's hard-deadline exit code (`gemini-review.mjs`'s
 * `armReviewWatchdog` → `finishAndExit(124)`). A dedicated code, not prose:
 * it is the only structured evidence that survives a force-exit, because a
 * process the watchdog kills never writes the `_shadow` block that would
 * otherwise carry the classification.
 */
export const HARD_DEADLINE_EXIT_CODE = 124;

/**
 * How many times one arm may be spawned for one snapshot before the collector
 * gives up and leaves it for a human-invoked retry (`selectRetryArmIds`).
 *
 * **2, not 3, and sized from the measured recovery rather than from symmetry.**
 * Every manual retry of a timed-out qwen arm succeeded on its FIRST re-attempt
 * (2026-08-17/18) — a third automatic attempt would therefore be buying an
 * outcome nothing has been observed to need, at up to another full deadline of
 * wall clock. The existing per-arm retry path remains the backstop for the
 * rarer double failure, so the cost of being wrong here is one CLI re-invocation,
 * not a lost snapshot.
 */
export const ARM_MAX_ATTEMPTS = 2;

/**
 * PURE. May this failed attempt be re-spawned?
 *
 * **It re-classifies nothing.** The one classifier in this repo is
 * `classifyLlmError` (`lib/robustness.mjs`), and it runs where the error object
 * actually exists — inside the spawned reviewer, whose `_shadow` block carries
 * the verdict across the process boundary as `errorRetryable`/`errorCategory`.
 * This function reads that verdict and the exit code; it never inspects an
 * error message. A second retry-eligibility predicate here would be a split
 * oracle that drifts the first time either side learns a new failure class —
 * and it would drift silently, since both sides look right in isolation.
 *
 * Fails CLOSED in every direction that is not positively known to be transient:
 * an absent `errorRetryable` (an artifact from an older reviewer, or an error
 * path that never classified) means "not classified", never "retryable", so a
 * deterministic failure cannot be retried by omission. Only two things earn a
 * retry: the reviewer's own hard-deadline exit, and a shadow failure its
 * classifier called transient (timeout, 429, 5xx — never a 4xx, never a bad
 * model id, never a schema rejection).
 *
 * @param {{ok?: true, error?: string, status?: number|null}} spawned - `runArm`'s outcome
 * @param {{error?: string, shadowState?: string|null, shadowErrorRetryable?: boolean,
 *          shadowErrorCategory?: string|null}|null} armResult - the parsed result record,
 *   or the spawn outcome itself when the child never produced a readable one
 * @returns {{retryable: boolean, category: string}}
 */
export function classifyArmAttempt(spawned, armResult) {
  if (spawned?.status === HARD_DEADLINE_EXIT_CODE) return { retryable: true, category: 'hard-deadline' };
  // Any OTHER non-zero exit is a fail-fast: a missing credential, an unknown
  // provider, a campaign-safety refusal and a schema rejection all land here,
  // and every one of them will fail identically on a second spawn while costing
  // another envelope's worth of provider time to prove it.
  if (spawned?.error) return { retryable: false, category: 'spawn-failed' };
  if (armResult?.error) return { retryable: false, category: 'unreadable-result' };
  if (armResult?.shadowErrorRetryable === true) {
    return { retryable: true, category: armResult.shadowErrorCategory || 'transient' };
  }
  if (armResult?.shadowState === 'ran') return { retryable: false, category: 'ran' };
  return { retryable: false, category: armResult?.shadowErrorCategory || armResult?.shadowState || 'not-classified' };
}

/**
 * Spawn one arm, retrying a TRANSIENT failure automatically up to
 * `ARM_MAX_ATTEMPTS` times.
 *
 * **Why retry rather than raise the deadline again.** The alibaba ceiling was
 * raised twice (300s → 600s → 900s), each time sized from the most recent
 * measurement, and each time the next long sample still exceeded it — while a
 * manual retry succeeded every time it was attempted, once in 176s on the very
 * request that had just stalled past 900s. Latency there is server-side
 * variance, not compute proportional to the envelope (a 367K-char request
 * finished in 176s; a smaller ~275K one took 839s), so a deadline can bound one
 * attempt but can never cover the tail. Retry is what covers the tail; see
 * `transportForModel`'s alibaba branch in `bakeoff/arms.mjs` for the series.
 *
 * No backoff between attempts, deliberately: the observed recovery was an
 * IMMEDIATE re-spawn, and a sleep sized from no measurement is the same guess
 * this change exists to stop making.
 *
 * Impure only through its injected collaborators — `spawn`, `readOutcome` and
 * `beforeAttempt` are all parameters, so the whole policy is assertable without
 * a provider call, a database or a subprocess.
 *
 * @param {object} arm
 * @param {object} ctx - `runArm`'s context (transcript/plan/mode/outDir/id/…)
 * @param {object} deps
 * @param {(arm: object, ctx: object) => object} [deps.spawn]
 * @param {(spawned: object) => object} deps.readOutcome - parses one attempt's result
 *   file into the record the log stores. Injected because `summary.mjs`, which owns
 *   the cost extraction it needs, is off-limits to this module (D2a).
 * @param {(attempt: number) => Promise<string|null>} [deps.beforeAttempt] - mints the
 *   attempt's cloud run id. Called PER ATTEMPT: two attempts sharing one
 *   `audit_runs` row would persist the primary reviewer's findings into it twice.
 * @param {number} [deps.maxAttempts]
 * @param {(msg: string) => void} [deps.log]
 * @returns {Promise<{result: object, runId: string|null, attempts: number,
 *   supersededAttempts: Array<object>}>}
 */
export async function runArmAttempts(arm, ctx, {
  spawn = runArm,
  readOutcome,
  beforeAttempt = async () => null,
  maxAttempts = ARM_MAX_ATTEMPTS,
  log = (msg) => process.stderr.write(msg),
} = {}) {
  const supersededAttempts = [];
  for (let attempt = 1; ; attempt++) {
    const runId = await beforeAttempt(attempt);
    const spawned = spawn(arm, { ...ctx, runId });
    const result = spawned.error ? spawned : readOutcome(spawned);
    const cls = classifyArmAttempt(spawned, result);
    const secs = ((spawned.elapsedMs ?? 0) / 1000).toFixed(1);
    if (!cls.retryable || attempt >= maxAttempts) {
      if (cls.retryable) {
        // Exhausted, not resolved. Named distinctly from "failed": the arm is
        // still missing and a human-invoked retry is the next step, which is a
        // different instruction than "this arm is broken, stop retrying it".
        log(`  [bakeoff] arm ${arm.id}: attempt ${attempt}/${maxAttempts} failed (${cls.category}, ${secs}s)`
          + ' — automatic retries EXHAUSTED; re-run the collector to retry this arm.\n');
      } else if (attempt > 1) {
        // A retried arm must never read as a first-try success.
        log(`  [bakeoff] arm ${arm.id}: attempt ${attempt}/${maxAttempts} finished in ${secs}s`
          + ` after ${supersededAttempts.length} superseded attempt(s) — this arm was RETRIED, not a first-try result.\n`);
      }
      return { result, runId, attempts: attempt, supersededAttempts };
    }
    // Everything the superseded attempt is evidence of: how long it burned, why
    // it failed, and what it cost. `costUsd: null` here is "unknown", NOT free —
    // a call that timed out may have consumed the provider's full reasoning
    // budget and simply never returned a usage block to price.
    supersededAttempts.push({
      attempt,
      runId: runId ?? null,
      elapsedMs: spawned.elapsedMs ?? null,
      errorCategory: cls.category,
      error: result?.error ?? result?.shadowError ?? `${cls.category} on attempt ${attempt}`,
      costUsd: typeof result?.costUsd === 'number' ? result.costUsd : null,
      unpricedModels: result?.unpricedModels ?? [],
    });
    log(`  [bakeoff] arm ${arm.id}: attempt ${attempt}/${maxAttempts} failed after ${secs}s (${cls.category})`
      + ' — retrying automatically. The failed attempt still counts toward spend.\n');
  }
}

/**
 * The experiment label written to `audit_runs.experiment_tag` (migration
 * 20260808120000). Every run this script mints is a REPLAY, never an audit
 * of the working tree — the tag is what keeps them out of the per-run rate
 * the campaign compares against.
 */
export const EXPERIMENT_TAG = 'final-review-bakeoff';

/**
 * Collector-side pre-flight verification (plan §8, Phase 6). The schema's
 * semanticRules already REQUIRE a `pass` disposition for any campaign
 * declaring an xAI arm; this is the second half — RECOMPUTING the artifact's
 * sha256 rather than trusting the recorded one, because a recorded hash
 * nobody recomputes is decoration (this repo's own "control the write side,
 * not just the read" lesson). Pure modulo the injected file reads, so it is
 * unit-testable without a real campaign directory or network call.
 *
 * @param {{artifact:string, sha256:string, disposition:string}|undefined} preflight
 * @param {{exists?: (p:string)=>boolean, readFile?: (p:string)=>Buffer, stat?: (p:string)=>{size:number}}} [deps]
 * @returns {{ok: boolean, checked: boolean, reason?: string, artifact?: string}}
 *   `checked:false` means no preflight was declared (no xAI arm) — nothing to verify.
 */
const PREFLIGHT_ARTIFACT_MAX_BYTES = 1024 * 1024; // 1MB — these are small JSON measurement artifacts (~2KB observed)

export function verifyPreflightArtifact(preflight, { exists = fs.existsSync, readFile = fs.readFileSync, stat = fs.statSync } = {}) {
  if (!preflight) return { ok: true, checked: false };
  if (!exists(preflight.artifact)) {
    return { ok: false, checked: false, reason: `campaign declares a preflight artifact that does not exist: ${preflight.artifact}` };
  }
  const { size } = stat(preflight.artifact);
  if (size > PREFLIGHT_ARTIFACT_MAX_BYTES) {
    return {
      ok: false, checked: false,
      reason: `preflight artifact ${preflight.artifact} is ${size} bytes, exceeding the `
        + `${PREFLIGHT_ARTIFACT_MAX_BYTES}-byte ceiling for this artifact class — refusing to read it into memory`,
    };
  }
  const actualSha256 = crypto.createHash('sha256').update(readFile(preflight.artifact)).digest('hex');
  if (actualSha256 !== preflight.sha256) {
    return {
      ok: false, checked: false,
      reason: `preflight artifact ${preflight.artifact} has been modified since the campaign was signed `
        + `(recorded sha256 ${preflight.sha256}, actual ${actualSha256}) — refusing to collect. `
        + 're-run scripts/grok-effort-preflight.mjs and update the campaign config with the new digest.',
    };
  }
  if (preflight.disposition !== 'pass') {
    // Belt-and-braces — the schema's semanticRules already reject this shape,
    // so reaching here means the config was hand-edited after validation or
    // loaded via a path that skipped it.
    return { ok: false, checked: false, reason: `preflight disposition is "${preflight.disposition}", not "pass" — refusing to collect` };
  }
  return { ok: true, checked: true, artifact: preflight.artifact };
}
