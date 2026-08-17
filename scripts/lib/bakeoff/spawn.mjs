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
  if (r.status !== 0) return { error: `exit ${r.status}`, stderrTail: String(r.stderr || '').slice(-400) };
  return { ok: true, outPath: out };
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
