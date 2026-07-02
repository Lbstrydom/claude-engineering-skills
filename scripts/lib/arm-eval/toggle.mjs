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
import { resolveArms } from '../audit-arms.mjs';

export const TOGGLE_RELPATH = path.join('.audit-loop', 'arm-eval-toggle.json');

/** The shadow arm set the toggle activates (all non-baseline canonical arms). */
export const TOGGLE_SHADOW_ARMS = 'B,C';

/**
 * Read the toggle state. Fail-closed: any read/parse problem → disabled.
 * @param {{repoRoot?: string}} [opts]
 * @returns {{enabled:boolean, budgetEur:number|null, enabledAt:string|null, present:boolean}}
 */
export function readToggle({ repoRoot = process.cwd() } = {}) {
  const p = path.join(repoRoot, TOGGLE_RELPATH);
  try {
    if (!existsSync(p)) return { enabled: false, budgetEur: null, enabledAt: null, present: false };
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const budget = Number.parseFloat(j.budgetEur);
    return {
      enabled: j.enabled === true,
      budgetEur: Number.isFinite(budget) && budget > 0 ? budget : null,
      enabledAt: typeof j.enabledAt === 'string' ? j.enabledAt : null,
      present: true,
    };
  } catch {
    return { enabled: false, budgetEur: null, enabledAt: null, present: false };
  }
}

/**
 * Write the toggle state (atomic; creates `.audit-loop/` if needed).
 * @param {{repoRoot?: string, enabled: boolean, budgetEur?: number|null}} input
 * @returns {ReturnType<typeof readToggle>}
 */
export function writeToggle({ repoRoot = process.cwd(), enabled, budgetEur = null }) {
  const dir = path.join(repoRoot, '.audit-loop');
  mkdirSync(dir, { recursive: true });
  const state = {
    enabled: enabled === true,
    budgetEur: Number.isFinite(budgetEur) && budgetEur > 0 ? budgetEur : null,
    enabledAt: enabled ? new Date().toISOString() : null,
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
