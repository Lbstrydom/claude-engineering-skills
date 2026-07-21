/**
 * @fileoverview Enumerate each skill's `gate-contract.json` under a given
 * root, validate each with the shared `validateGateContract` policy, and report
 * `{contracted, uncontracted, divergences}`. No prose parsing (plan §F2.3) —
 * discovery is pure file enumeration.
 *
 * @module scripts/lib/gate-honesty/loader
 */

import fs from 'node:fs';
import path from 'node:path';
import { listSkillNames } from '../skill-packaging.mjs';
import { validateGateContract } from './schema.mjs';

/**
 * @param {object} opts
 * @param {string} opts.skillsRoot — e.g. `<repoRoot>/skills`
 * @param {string} opts.repoRoot — root that contract-relative paths resolve against
 * @returns {{
 *   contracted: object[],      // validated contract objects
 *   uncontracted: string[],    // skill names with no gate-contract.json
 *   divergences: string[],     // human-readable "[skill][gate] ..." lines
 * }}
 */
export function loadGateContracts({ skillsRoot, repoRoot }) {
  const skillNames = listSkillNames(skillsRoot);
  const contracted = [];
  const uncontracted = [];
  const divergences = [];
  // dir → the contract's own `skill` field, for each dir whose contract VALIDATED.
  // The ratchet (Phase D) uses this to enforce contract↔directory identity — the
  // loader keys `contracted` by the self-declared `skill`, so a mismatch would
  // otherwise be invisible here.
  const contractedByDir = new Map();

  for (const name of skillNames) {
    const contractPath = path.join(skillsRoot, name, 'gate-contract.json');
    if (!fs.existsSync(contractPath)) {
      uncontracted.push(name);
      continue;
    }
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(contractPath, 'utf-8'));
    } catch (e) {
      divergences.push(`[${name}][gate-contract.json] invalid JSON: ${e.message}`);
      continue;
    }
    const result = validateGateContract(raw, repoRoot);
    if (!result.ok) {
      divergences.push(...result.errors.map((e) => (e.startsWith('[') ? e : `[${name}] ${e}`)));
      continue;
    }
    contracted.push(result.contract);
    contractedByDir.set(name, result.contract.skill);
  }

  return { contracted, uncontracted, divergences, skillNames, contractedByDir };
}

/**
 * Build the passing-run report lines (§F2.6). Every count/list is DERIVED
 * from `contracted`/`uncontracted` at call time — no literal counts, so an
 * intentional coverage change requires no hand-edited number anywhere.
 *
 * @param {{contracted: object[], uncontracted: string[], envSkipped?: Array<{skill: string, gate: string}>}} args
 * @returns {string[]}
 */
export function formatSummaryLines({ contracted, uncontracted, envSkipped = [] }) {
  const lines = [];
  // CHECKED must mean RAN, not DECLARED. Counting every declared executable
  // gate made the very next line ("never counted as checked") false in the same
  // output: an env-skipped gate executed nothing yet inflated the headline
  // number. Subtracting them here is what makes that promise true.
  const skipped = new Set(envSkipped.map((e) => `${e.skill}/${e.gate}`));
  const executableBySkill = contracted.map((c) => ({
    skill: c.skill,
    ids: c.gates
      .filter((g) => g.kind === 'executable' && !skipped.has(`${c.skill}/${g.id}`))
      .map((g) => g.id),
  })).filter((c) => c.ids.length > 0);
  const totalExecutable = executableBySkill.reduce((n, c) => n + c.ids.length, 0);

  lines.push(`gate-honesty: CHECKED ${totalExecutable} executable gate(s) across ${executableBySkill.length} contracted skill(s):`);
  for (const c of executableBySkill) lines.push(`  ${c.skill}: ${c.ids.join(', ')}`);

  const docOnly = contracted.flatMap((c) => c.gates.filter((g) => g.kind === 'document-only').map((g) => `${c.skill}/${g.id} (${g.reason})`));
  lines.push(`gate-honesty: NOT CHECKED — ${docOnly.length} document-only gate(s) (judgement, listed not verified):`);
  for (const d of docOnly) lines.push(`  ${d}`);

  lines.push(`gate-honesty: UNCONTRACTED skills (no gate-contract.json): ${uncontracted.length ? uncontracted.join(', ') : '(none)'}`);

  if (envSkipped.length > 0) {
    lines.push(`gate-honesty: ENV-SKIPPED — ${envSkipped.length} gate(s) could not run (missing prerequisite, never counted as checked):`);
    for (const e of envSkipped) lines.push(`  ${e.skill}/${e.gate}`);
  }

  return lines;
}
