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
import { validateGateContract, validateCliGateContract } from './schema.mjs';

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

/** The exemption registry filename inside `contractsRoot` — never itself a contract. */
export const CLI_GATE_EXEMPTIONS_FILE = '_exemptions.json';

/**
 * Enumerate `scripts/gate-contracts/<gate>.json` — the CLI-gate half of the same protocol.
 *
 * Discovery is pure file enumeration, exactly as above; validation is
 * `validateCliGateContract`, which shares its per-gate loop with the skill contracts.
 * The filename must match the contract's own `gate` field with `:` written as `-`, so a
 * contract cannot claim to be for a gate other than the one its filename advertises —
 * the CLI-gate form of the contract↔directory identity the ratchet enforces for skills.
 *
 * @returns {{contracted: object[], divergences: string[], exemptions: Record<string,string>}}
 */
export function loadCliGateContracts({ contractsRoot, repoRoot }) {
  const contracted = [];
  const divergences = [];
  let exemptions = {};

  if (!fs.existsSync(contractsRoot)) return { contracted, divergences, exemptions };

  for (const entry of fs.readdirSync(contractsRoot).sort()) {
    if (!entry.endsWith('.json')) continue;
    const abs = path.join(contractsRoot, entry);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(abs, 'utf-8'));
    } catch (e) {
      divergences.push(`[${entry}] invalid JSON: ${e.message}`);
      continue;
    }
    if (entry === CLI_GATE_EXEMPTIONS_FILE) {
      exemptions = raw?.exempt && typeof raw.exempt === 'object' ? raw.exempt : {};
      // An exemption is `{reason, gateAddedAt, gateAddedAtSource}` since 2026-08-09
      // (adjudicated finding D3/D6). The bare-string form is still read so a
      // consumer repo mid-migration is not hard-failed by a shape change alone —
      // but either way the REASON must be a non-empty string, which is the whole
      // point of this check. `check-gate-poison-pills.mjs::loadExemptions` is the
      // strict validator that additionally requires the provenance fields; this
      // loader deliberately stays the looser of the two so one registry never has
      // two schemas that can disagree about what is loadable.
      const reasonOf = (r) => (typeof r === 'string' ? r : r?.reason);
      const bad = Object.entries(exemptions)
        .filter(([, r]) => typeof reasonOf(r) !== 'string' || reasonOf(r).trim().length === 0);
      for (const [gate] of bad) {
        divergences.push(`[${entry}][${gate}] exemption without a reason — silence is what this registry exists to remove`);
      }
      continue;
    }
    const result = validateCliGateContract(raw, repoRoot);
    if (!result.ok) {
      divergences.push(...result.errors.map((e) => (e.startsWith('[') ? e : `[${entry}] ${e}`)));
      continue;
    }
    const expected = `${result.contract.gate.replace(/:/g, '-')}.json`;
    if (entry !== expected) {
      divergences.push(`[${entry}] declares gate "${result.contract.gate}", which belongs in ${expected} — `
        + 'a contract must not be filed under a name other than its own gate');
      continue;
    }
    contracted.push({ ...result.contract, file: `${path.basename(contractsRoot)}/${entry}` });
  }

  return { contracted, divergences, exemptions };
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
