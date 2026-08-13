/**
 * @fileoverview The layering oracle — DERIVED, never enumerated.
 *
 * Re-runs the architecture-intent measurement in-process and asserts the
 * `not-in-allowedDeps` violation set is empty. Plan:
 * [god-module-and-layering-debt.md](../docs/plans/god-module-and-layering-debt.md)
 * §6 ("The layering oracle is DERIVED") and §5b Phase 0.
 *
 * ## Why derived rather than a list of expected edges
 *
 * A hand-listed set of "the 14 known violations" proves only that somebody
 * updated the list. That is the failure mode `/audit-code` R2-M3 killed in
 * `audit-store-write-durability.md` §6, and the same disk-iterating shape as
 * `npm run db:enrolment:gate`: the oracle must be able to see an edge nobody
 * told it about.
 *
 * ## Why the inventory is `git ls-files`, and why that is NOT the tracked-only
 * blind spot the plan warned about
 *
 * The plan (§6, from plan-audit R3-M1) called for "tracked **plus non-ignored
 * untracked**" because Phase 2 *creates* `scripts/lib/arm-vocabulary.mjs`, and a
 * tracked-only scan cannot see it until it is staged — so the oracle could
 * report zero having never examined the module the phase exists to add.
 *
 * Implementing it revealed a better answer than either extreme, and this
 * deviates from the plan deliberately:
 *
 * - **`git ls-files` already includes intent-to-add entries.** `git add -N
 *   <new file>` puts it in the index, so a new module IS visible without being
 *   committed. The blind spot is closed by a one-command workflow, not by
 *   widening the inventory.
 * - **Widening to all non-ignored untracked files is actively wrong here.**
 *   This is a shared working tree with concurrent sessions; an unstaged
 *   scratch module belonging to somebody else's in-flight work would gate this
 *   suite. A gate that fails on work its owner has not offered for review is
 *   the cried-wolf shape that earns `--no-verify`.
 * - **It also matches the gate's real execution context.** The pre-push hook
 *   runs `check` in a throwaway worktree at the commit being pushed
 *   ([prepush-check.mjs](../scripts/prepush-check.mjs)), where untracked files
 *   do not exist at all. Tracked-only IS what the gate will see.
 *
 * The presence assertion below is what makes the intent-to-add step
 * non-optional rather than a thing to remember.
 *
 * @module tests/arm-vocabulary-layering.test
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import analyseImports from '../scripts/lib/arch-intent/adapters/js-ts.mjs';
import { resolveFileToDomain } from '../scripts/lib/arch-intent/domain-resolver.mjs';
import * as armArms from '../scripts/lib/audit-arms.mjs';
import * as armVocab from '../scripts/lib/arm-vocabulary.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The lower bound below is a **vacuous-pass guard**, not a size assertion.
 *
 * An `analyseImports` run over an empty or near-empty inventory returns zero
 * violations and is indistinguishable from a clean repo. The repo carried 1,250
 * mapped `.mjs` files when this landed; a run that sees fewer than a thousand
 * has lost its inventory (a bad glob, a cwd change, a failed `git ls-files`)
 * and must fail loudly rather than report green.
 */
const MIN_PLAUSIBLE_INVENTORY = 1000;

/** Repo-relative `.mjs` paths git knows about — tracked or intent-to-add. */
function trackedMjs() {
  const out = execFileSync('git', ['-C', REPO, 'ls-files', '-z', '--', '*.mjs'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').map(s => s.trim()).filter(Boolean);
}

describe('layering: no not-in-allowedDeps violations', () => {
  let report;
  let mapped;

  before(async () => {
    const domainMap = JSON.parse(
      readFileSync(path.join(REPO, '.audit-loop', 'domain-map.json'), 'utf8'),
    );
    mapped = new Map();
    for (const f of trackedMjs()) {
      const d = resolveFileToDomain(f, domainMap.rules);
      if (d) mapped.set(f, d);
    }
    report = await analyseImports({ mapped, domainMap, repoPath: REPO });
  });

  it('analysed a plausible inventory (vacuous-pass guard)', () => {
    assert.ok(
      mapped.size >= MIN_PLAUSIBLE_INVENTORY,
      `inventory collapsed to ${mapped.size} mapped files (expected >= ${MIN_PLAUSIBLE_INVENTORY}). ` +
      'A zero-violation result from an empty inventory is not a pass.',
    );
    assert.ok(
      report._meta.localFileEdges > 0,
      'zero local-file edges analysed — the import graph is empty, so no violation could be found',
    );
  });

  it('has no not-in-allowedDeps violations', () => {
    const byEdge = new Map();
    for (const v of report.violations) {
      const k = `${v.fromDomain} -> ${v.toDomain}`;
      if (!byEdge.has(k)) byEdge.set(k, []);
      byEdge.get(k).push(`${v.fromFile} -> ${v.toFile}`);
    }
    const detail = [...byEdge.entries()]
      .map(([edge, files]) => `  ${edge} (${files.length})\n${files.map(f => `    ${f}`).join('\n')}`)
      .join('\n');

    assert.equal(
      report.violations.length,
      0,
      `${report.violations.length} layering violation(s) across ${byEdge.size} domain edge(s):\n${detail}\n\n` +
      'Fix the code, retag the file, or declare the edge in .audit-loop/domain-map.json ' +
      '— in that preference order (refactor > retag > declare).',
    );
  });
});

/**
 * The vocabulary that MOVED to `arm-vocabulary.mjs` in Phase 2.
 *
 * Frozen deliberately: `audit-arms.mjs` re-exports each of these, and the test
 * below asserts the two bindings are **identical**, not merely both present.
 * Two equal-looking copies of a frozen array is exactly the drift the extraction
 * exists to prevent, and `deepEqual` would not see it.
 */
const MOVED = Object.freeze([
  'STAGES', 'SHARED_STAGES', 'ARM_SPECIFIC_STAGES', 'ARM_IDS',
  'SHADOW_STAGES', 'BASELINE_STAGES', 'CANONICAL_ARMS',
  'stagesForArm', 'resolveArms',
]);

/**
 * `audit-arms.mjs`'s complete public surface, as a MAINTAINED contract.
 *
 * Asserted against this literal rather than against "whatever it exported
 * before", because a test that reads only post-change code cannot detect an
 * export that was accidentally **removed** — and there is no pre-extraction
 * snapshot to diff against (plan-audit R3-M2). Changing this list is how you
 * change the module's public API: deliberately, in a diff a reviewer sees.
 */
const AUDIT_ARMS_PUBLIC_SURFACE = Object.freeze([
  ...MOVED,
  'ArmGenerationSchema', 'ArmSchema', 'parseArm',
  'buildCandidateArm', 'attributeStageToArms', 'executionPlan',
].sort());

describe('arm-vocabulary extraction contracts', () => {
  it('the new module is in the analysed inventory (not a tracked-only blind spot)', () => {
    // Phase 2 CREATES this file. `git ls-files` sees it once it is tracked or
    // intent-to-add (`git add -N`); if this fails, the oracle above measured a
    // tree that does not contain the module it is supposed to be validating.
    const inv = trackedMjs();
    assert.ok(
      inv.includes('scripts/lib/arm-vocabulary.mjs'),
      'scripts/lib/arm-vocabulary.mjs is absent from the analysed inventory. ' +
      'If it exists on disk, run `git add -N scripts/lib/arm-vocabulary.mjs` — ' +
      'an untracked new module makes a zero-violation result vacuous.',
    );
  });

  it('every moved symbol is the SAME binding in both modules', () => {
    for (const name of MOVED) {
      assert.ok(name in armVocab, `arm-vocabulary.mjs does not export ${name}`);
      assert.ok(name in armArms, `audit-arms.mjs no longer re-exports ${name} — its importers break`);
      assert.strictEqual(
        armArms[name], armVocab[name],
        `${name} is a DIFFERENT binding in audit-arms.mjs than in arm-vocabulary.mjs — ` +
        'that is a second definition of the vocabulary, which is the drift this extraction prevents.',
      );
    }
  });

  it('audit-arms.mjs public surface matches its maintained manifest exactly', () => {
    assert.deepEqual(
      Object.keys(armArms).sort(),
      [...AUDIT_ARMS_PUBLIC_SURFACE],
      'audit-arms.mjs exports drifted from AUDIT_ARMS_PUBLIC_SURFACE. Narrowing it breaks its ' +
      'importers; widening it is fine but must be a deliberate edit to that list.',
    );
  });

  it('arm-vocabulary.mjs is a genuine primitive — no imports at all', () => {
    // The property that made the split possible (Zod-free, contracts-free). If a
    // future edit adds an import here, the module may have stopped being a
    // primitive and the shared-lib tag may no longer be honest.
    const src = readFileSync(path.join(REPO, 'scripts/lib/arm-vocabulary.mjs'), 'utf8');
    const imports = src.split(/\r?\n/).filter(l => /^\s*import\s/.test(l));
    assert.deepEqual(
      imports, [],
      'arm-vocabulary.mjs must have zero imports to stay a domain-neutral primitive; found:'
      + JSON.stringify(imports),
    );
  });
});
