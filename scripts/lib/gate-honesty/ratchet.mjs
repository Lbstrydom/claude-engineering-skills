/**
 * @fileoverview The net-new-skill ratchet (Phase D, gate-contract-authoring.md
 * §7b). Every skill root must DECLARE its gate-honesty status — a real
 * `gate-contract.json`, or a baseline exemption with a reason. A skill that
 * declares neither fails `npm run check`, so a new skill can never silently
 * escape the gate-honesty system.
 *
 * The set logic is PURE (`computeRatchetDivergences`), so every §7b failure
 * mode is unit-testable without a repo; the impure shell in
 * check-gate-contracts.mjs does the fs reads (contracts, baseline, symlinks).
 *
 * @module scripts/lib/gate-honesty/ratchet
 */

/**
 * The §7b set rules, as a pure function over already-loaded data.
 *
 * Rule 1 ("declare a contract or a baseline exemption") keys on the contract
 * FILE being ABSENT (`uncontractedDirs`) — a present-but-broken contract is
 * already a loader divergence, so re-flagging it here would double-report. Rules
 * 2–3 key on VALID contracts (`contractSkillByDir`), the only ones whose `skill`
 * field can be trusted for identity/collision comparison.
 *
 * @param {object} args
 * @param {string[]} args.skillNames  every skill root (listSkillNames — the
 *   sole authority; a root not here does not exist).
 * @param {string[]} args.uncontractedDirs  roots whose gate-contract.json is
 *   ABSENT (from the loader).
 * @param {Map<string,string>} args.contractSkillByDir  dir → the contract's own
 *   `skill` field, for each dir whose contract VALIDATED.
 * @param {Array<{skill: string, reason: string}>} args.baselineExemptions
 * @returns {string[]}  divergence strings, in deterministic order (skill roots
 *   ascending, then a stable rule order), empty when clean.
 */
export function computeRatchetDivergences({
  skillNames, uncontractedDirs, contractSkillByDir, baselineExemptions,
}) {
  const out = [];
  const skillSet = new Set(skillNames);
  const uncontractedSet = new Set(uncontractedDirs);
  const exemptSkills = baselineExemptions.map((e) => e.skill);
  const exemptSet = new Set(exemptSkills);
  // A contract FILE is present for a dir when it is a known root and not in the
  // absent list — includes broken contracts (which fail elsewhere), so the
  // baseline-collision rule treats a broken-contract skill as still contracted.
  const hasContractFile = (dir) => skillSet.has(dir) && !uncontractedSet.has(dir);

  // 1. Every skill root must DECLARE: a contract file, or a baseline exemption.
  //    This is the ratchet — a net-new skill with neither fails.
  for (const dir of [...skillNames].sort()) {
    if (uncontractedSet.has(dir) && !exemptSet.has(dir)) {
      out.push(`[ratchet] skill "${dir}" has neither a gate-contract.json nor a baseline exemption — every skill must declare its gate-honesty status`);
    }
  }

  // 2. Contract ↔ directory identity: a contract's `skill` field must equal its
  //    directory, or the loader's by-skill keying silently misattributes it.
  for (const dir of [...contractSkillByDir.keys()].sort()) {
    const declared = contractSkillByDir.get(dir);
    if (declared !== dir) {
      out.push(`[ratchet] skills/${dir}/gate-contract.json declares skill "${declared}" — the "skill" field must equal the directory name`);
    }
  }

  // 3. Baseline integrity.
  const seen = new Set();
  for (const skill of [...exemptSkills].sort()) {
    if (seen.has(skill)) {
      out.push(`[ratchet] baseline has a duplicate exemption for "${skill}"`);
      continue;
    }
    seen.add(skill);
    if (!skillSet.has(skill)) {
      out.push(`[ratchet] baseline exempts "${skill}", which is no longer a skill root — remove the stale exemption`);
    }
    if (hasContractFile(skill)) {
      out.push(`[ratchet] baseline exempts "${skill}", which now HAS a gate-contract.json — remove the exemption (a contracted skill needs no exemption)`);
    }
  }

  return out;
}
