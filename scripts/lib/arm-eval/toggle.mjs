/**
 * @fileoverview One-command experiment toggle for the arm-eval + model-A/B/C
 * harnesses (operator request 2026-07-02).
 *
 * `arm-eval-toggle on` flips ONE per-repo, gitignored state file
 * (`.audit-loop/arm-eval-toggle.json`) that three surfaces consult:
 *   1. /audit-code + /audit-plan — shadow arms B,C activate via
 *      `resolveShadowArmsWithToggle` (explicit `AUDIT_MODEL_SHADOW` env ALWAYS
 *      wins — the env var stays the kill switch / override).
 *   2. /plan — fires an `arm-eval-run --experiment plan-authoring` capture
 *      after the normal plan is written (via `arm-eval-maybe-capture`).
 *   3. /brainstorm — same, `--experiment brainstorm`.
 *
 * Fail-closed to OFF: a missing, malformed, or unreadable toggle file means
 * DISABLED — never a surprise spend. Budget: the toggle carries its own
 * ceiling (defaults to `armEvalConfig.budgetEur` = €300); every downstream
 * spend path still enforces its own refusal on a null budget.
 *
 * @module scripts/lib/arm-eval/toggle
 */

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../file-io.mjs';
import { resolveArms } from '../arm-vocabulary.mjs';

export const TOGGLE_RELPATH = path.join('.audit-loop', 'arm-eval-toggle.json');

/** The shadow arm set the toggle activates (all non-baseline canonical arms). */
export const TOGGLE_SHADOW_ARMS = 'B,C';

/**
 * Why `null` is NOT a safe budget, and why this module validates rather than
 * coerces (audit 2026-08-13, H1/M7/M10/M11/L3 — one defect, five symptoms).
 *
 * `cross-skill/commands/model-eval.mjs:339` reads
 * `const budgetCapEur = t.budgetEur ?? armEvalConfig.budgetEur` — so a null
 * toggle budget does not refuse spend, it **falls back to the €300 default**.
 * This module's own test asserted `-5 → null` under the comment *"downstream
 * refusal still applies — no negative ceiling"*, which was simply false: an
 * operator typo silently bought a LARGER allowance than the one they typed.
 *
 * Three coercions produced that, all of them "helpful":
 *   - `Number.parseFloat(j.budgetEur)` accepts numeric PREFIXES, so the string
 *     `"300EUR-typo"` decoded to a valid 300.
 *   - `writeToggle` mapped every non-positive/non-finite budget to `null`.
 *   - `readToggle`'s bare `catch` mapped an unreadable or malformed file to the
 *     exact value used for "no file here".
 *
 * The fix is the repo's standing rule applied to a config decoder: **a failure
 * must not be representable as a normal outcome.** Fail-closed behaviour is
 * unchanged and non-negotiable (any problem ⇒ `enabled:false`); what changes is
 * that the READER now says which problem, and the WRITER refuses input it
 * cannot honestly persist instead of widening a spend cap on the operator's
 * behalf.
 */

/** Toggle read outcomes. `ok` is the only state carrying trustworthy content. */
export const TOGGLE_STATES = Object.freeze(['ok', 'absent', 'unreadable', 'malformed']);

/**
 * Strictly decode a persisted budget.
 *
 * Accepts a finite positive JSON **number** only. A numeric string is rejected
 * rather than parsed: this file is machine-written, so a string here means the
 * file was hand-edited or corrupted, and `parseFloat` would silently rescue a
 * typo into a spend ceiling. Returns `undefined` for "present but invalid" so
 * the caller can tell it from a legitimately absent `null`.
 *
 * @param {unknown} raw
 * @returns {number|null|undefined} number = valid · null = absent · undefined = invalid
 */
function decodeBudget(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
  return raw;
}

/**
 * Read the toggle state. **Fail-closed: any problem → `enabled:false`.**
 *
 * `state` distinguishes the four cases the old bare `catch` collapsed into one.
 * `present` is retained with its original meaning (a usable file was read) so
 * existing callers are unaffected; a malformed or unreadable file reports
 * `present:false` **and** a `state` naming the cause, because "the operator
 * never configured this" and "the operator's configuration is broken" warrant
 * different responses even though both must refuse to spend.
 *
 * @param {{repoRoot?: string}} [opts]
 * @returns {{enabled:boolean, budgetEur:number|null, enabledAt:string|null, present:boolean,
 *            state:'ok'|'absent'|'unreadable'|'malformed', reason:string|null}}
 */
export function readToggle({ repoRoot = process.cwd() } = {}) {
  const p = path.join(repoRoot, TOGGLE_RELPATH);
  const closed = (state, reason) => ({
    enabled: false, budgetEur: null, enabledAt: null, present: false, state, reason,
  });

  let text;
  try {
    if (!existsSync(p)) return closed('absent', null);
    text = readFileSync(p, 'utf8');
  } catch (err) {
    return closed('unreadable', `cannot read ${TOGGLE_RELPATH}: ${err.message}`);
  }

  let j;
  try {
    j = JSON.parse(text);
  } catch (err) {
    return closed('malformed', `${TOGGLE_RELPATH} is not valid JSON: ${err.message}`);
  }
  if (j === null || typeof j !== 'object' || Array.isArray(j)) {
    return closed('malformed', `${TOGGLE_RELPATH} must contain a JSON object`);
  }

  const budget = decodeBudget(j.budgetEur);
  if (budget === undefined) {
    // A budget we cannot trust must not silently become the DEFAULT ceiling.
    return closed('malformed', `${TOGGLE_RELPATH}: budgetEur must be a positive number, got ${JSON.stringify(j.budgetEur)}`);
  }

  const enabled = j.enabled === true;
  return {
    enabled,
    budgetEur: budget,
    // Tied to the SAME boolean as `enabled` — the old code derived this from
    // truthiness, so `{enabled:"false"}` persisted enabled:false beside a
    // non-null enable timestamp (audit L3).
    enabledAt: enabled && typeof j.enabledAt === 'string' ? j.enabledAt : null,
    present: true,
    state: 'ok',
    reason: null,
  };
}

/**
 * Write the toggle state (atomic; creates `.audit-loop/` if needed).
 *
 * **Throws on a budget it cannot honestly persist.** Silently mapping `0`/`-1`/
 * `NaN` to `null` handed the caller a bigger cap than they asked for (see the
 * block comment above). `null`/`undefined` remain legal and mean "no explicit
 * ceiling — use the configured default", which is a deliberate choice rather
 * than a rescued typo.
 *
 * @param {{repoRoot?: string, enabled: boolean, budgetEur?: number|null}} input
 * @returns {ReturnType<typeof readToggle>}
 * @throws {RangeError} when `budgetEur` is supplied but is not a positive finite number
 */
export function writeToggle({ repoRoot = process.cwd(), enabled, budgetEur = null }) {
  const budget = decodeBudget(budgetEur);
  if (budget === undefined) {
    throw new RangeError(
      `writeToggle: budgetEur must be a positive finite number or null, got ${JSON.stringify(budgetEur)}. `
      + 'Refusing rather than coercing to null — a null budget means "use the configured default", '
      + 'so coercion would RAISE the spend ceiling instead of rejecting the input.',
    );
  }
  const dir = path.join(repoRoot, '.audit-loop');
  mkdirSync(dir, { recursive: true });
  const on = enabled === true;
  const state = {
    enabled: on,
    budgetEur: budget,
    enabledAt: on ? new Date().toISOString() : null,
  };
  atomicWriteFileSync(path.join(repoRoot, TOGGLE_RELPATH), JSON.stringify(state, null, 2) + '\n');
  return readToggle({ repoRoot });
}

/**
 * Shadow-arm resolution with the toggle as the convenience layer.
 *
 * Precedence (load-bearing):
 *   1. `AUDIT_MODEL_SHADOW` env set (any non-empty value) → `resolveArms(env)`
 *      verbatim — the env var remains authoritative for BOTH enabling a custom
 *      arm set AND any future explicit override while a toggle is on.
 *   2. env unset + toggle enabled → arms `B,C` (the canonical shadow set).
 *   3. neither → disabled (byte-identical to the pre-toggle path).
 *
 * @param {Record<string,string|undefined>} [env=process.env]
 * @param {{repoRoot?: string}} [opts]
 * @returns {ReturnType<typeof resolveArms> & {source:'env'|'toggle'|'off'}}
 */
export function resolveShadowArmsWithToggle(env = process.env, { repoRoot = process.cwd() } = {}) {
  const raw = (env.AUDIT_MODEL_SHADOW || '').trim();
  if (raw) return { ...resolveArms(env), source: 'env' };
  const t = readToggle({ repoRoot });
  if (t.enabled) return { ...resolveArms({ AUDIT_MODEL_SHADOW: TOGGLE_SHADOW_ARMS }), source: 'toggle' };
  return { ...resolveArms(env), source: 'off' };
}
