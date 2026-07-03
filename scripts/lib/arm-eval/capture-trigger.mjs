/**
 * @fileoverview Deterministic, toggle-gated arm-eval capture trigger.
 *
 * Fires ONE arm-eval session as a DETACHED background process when the per-repo
 * arm-eval toggle is on. Wired into the persistence seams of /brainstorm
 * (`brainstorm-round.mjs`, after the session is appended) and /plan
 * (`cross-skill.mjs::cmdUpsertPlan`, after the plan is upserted) so capture is a
 * function of RUNNING the skill — not a trailing instruction the model can skip.
 *
 * Why: pre-2026-07-03 the capture was a skill step (`/brainstorm` Step 4.5,
 * `/plan` Phase 7.5). Being the last, "silent-no-op-when-off" step, the model
 * running the skill silently omitted it — so a toggled-on experiment recorded
 * nothing. This mirrors the audit shadow's script-level determinism
 * (`resolveShadowArmsWithToggle` in `openai-audit.mjs`): toggle off → no-op,
 * byte-identical to no experiment; toggle on → it always runs.
 *
 * Detached (not blocking): a captured session is a full produce→judge→cross-check
 * that spends ~1-3 min + budget; running it inline would stall the interactive
 * brainstorm/plan flow. The child re-reads the toggle + resolves repo identity
 * itself, so it is self-contained and survives the parent CLI's exit.
 *
 * @module scripts/lib/arm-eval/capture-trigger
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readToggle } from './toggle.mjs';

// cross-skill.mjs sits two dirs up from scripts/lib/arm-eval/. This relative
// resolution holds in BOTH the source layout AND the consumer isolated layout
// (scripts/.claude-skills/...), because the whole tree relocates together.
const CROSS_SKILL_PATH = path.resolve(fileURLToPath(import.meta.url), '../../../cross-skill.mjs');

/**
 * Fire a detached arm-eval capture when the toggle is on. NEVER throws — it must
 * not be able to break the brainstorm/plan flow it is wired into. Returns a
 * small status object for optional logging.
 *
 * @param {object} opts
 * @param {'brainstorm'|'plan-authoring'} opts.experimentType
 * @param {string} opts.task — the task/topic text the arms are scored on
 * @param {number|null} [opts.round=null] — when provided, capture ONLY on the
 *   session's FIRST round, which the brainstorm session-store numbers **0**
 *   (`appendSession`: empty ledger → round 0). Skips debate/continue rounds of
 *   the same session so a session is captured once. Field-verified 2026-07-03:
 *   the original `=== 1` gate meant a fresh brainstorm could NEVER fire.
 * @param {string} [opts.repoRoot=process.cwd()]
 * @param {Function} [opts.spawnFn=spawn] — injectable for tests
 * @param {Function} [opts.readToggleFn=readToggle] — injectable for tests
 * @returns {{fired: boolean, reason?: string}}
 */
export function maybeFireArmEvalCaptureDetached({
  experimentType,
  task,
  round = null,
  repoRoot = process.cwd(),
  spawnFn = spawn,
  readToggleFn = readToggle,
} = {}) {
  try {
    if (!experimentType || !task || !String(task).trim()) {
      return { fired: false, reason: 'missing-experiment-or-task' };
    }
    if (round !== null && round !== 0) {
      return { fired: false, reason: `round-${round}-not-first` };
    }
    const toggle = readToggleFn({ repoRoot });
    if (!toggle?.enabled) return { fired: false, reason: 'toggle-off' };

    // Array args → no shell, so the (possibly multi-KB, multi-line) task needs
    // no escaping and can't be word-split.
    const child = spawnFn(
      process.execPath,
      [CROSS_SKILL_PATH, 'arm-eval-maybe-capture', '--experiment', experimentType, '--task', String(task)],
      { cwd: repoRoot, detached: true, stdio: 'ignore' },
    );
    if (child && typeof child.on === 'function') child.on('error', () => { /* best-effort */ });
    if (child && typeof child.unref === 'function') child.unref();
    return { fired: true };
  } catch {
    return { fired: false, reason: 'spawn-failed' };
  }
}

export const _internals = Object.freeze({ CROSS_SKILL_PATH });
