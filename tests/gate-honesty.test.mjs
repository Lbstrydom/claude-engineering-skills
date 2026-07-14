/**
 * @fileoverview The gate-honesty suite (plan §F2 — executable binding
 * between a skill's STATED gate and the code/tests that enforce it).
 *
 * Structure:
 *   1. Real `skills/` — loads whatever is currently contracted, asserts the
 *      pinned census (grows as contracts land — see the Phase 5 addendum
 *      below), runs every oracle, and prints the CHECKED/NOT-CHECKED/
 *      UNCONTRACTED report (F2.6) so a passing run never implies more
 *      verification than actually happened.
 *   2. Self-honesty — the lying-skill fixture (§F2.4): three gates, three
 *      different oracles, all schema-valid, all lying. The suite must catch
 *      every one; if it ever doesn't, THIS test fails, not silently passes.
 *   3. Negative fixtures — one per loader/schema failure mode (§F2.4).
 *   4. Direct oracle behavioural checks not tied to a contracted skill yet
 *      (tiered-shadow all-fallback correctness).
 *
 * @module tests/gate-honesty
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGateContracts, formatSummaryLines } from '../scripts/lib/gate-honesty/loader.mjs';
import { runOracle } from '../scripts/lib/gate-honesty/oracles.mjs';
import { listSkillNames } from '../scripts/lib/skill-packaging.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES_ROOT = path.join(REPO_ROOT, 'tests', 'fixtures', 'gate-honesty');

/** Run every executable gate's oracle; returns {oracleResults: [{skill, gate, result}]}. */
async function runAllOracles(contracted, repoRoot) {
  const oracleResults = [];
  for (const contract of contracted) {
    for (const gate of contract.gates) {
      if (gate.kind !== 'executable') continue;
      const result = await runOracle(gate, { repoRoot });
      oracleResults.push({ skill: contract.skill, gate: gate.id, result });
    }
  }
  return oracleResults;
}

function divergenceLine(skill, gate, result) {
  return `[${skill}][${gate}] stated "${result.stated}"; found "${result.found}"`;
}

// Pinned v1 inventory (§F2.6 — the definitive contract census; ANY coverage
// change requires an explicit edit here, never a silent drift). One
// deliberate deviation from the plan's original table, recorded 2026-07-14
// during Cluster B implementation: `partial-matrix-refusal` moved from
// executable to document-only — see its `reason` in
// skills/visual-audit/gate-contract.json for why (no independently
// importable pure predicate exists for that inline check; claiming a
// unit-seam oracle for it would itself be a fake-check).
const PINNED_EXECUTABLE = {
  'audit-code': ['convergence-threshold', 'tiered-shadow-window-honesty'],
  'visual-audit': ['static-gate-refusal', 'empty-capture-unverified', 'gate-unverified-reasons'],
};
const PINNED_DOCUMENT_ONLY = {
  'audit-code': ['mechanical-vs-architectural-label', 'rigor-pressure-stop'],
  'visual-audit': ['partial-matrix-refusal', 'vlm-advisory-only'],
};
const PINNED_CONTRACTED_SKILLS = ['audit-code', 'visual-audit'];

describe('gate-honesty — real skills/', () => {
  it('loads the current repo contracts and runs every oracle clean, printing the coverage report', async () => {
    const skillsRoot = path.join(REPO_ROOT, 'skills');
    const { contracted, uncontracted, divergences } = loadGateContracts({ skillsRoot, repoRoot: REPO_ROOT });

    assert.deepEqual(divergences, [], `loader-level divergences on real contracts:\n${divergences.join('\n')}`);

    const oracleResults = await runAllOracles(contracted, REPO_ROOT);
    const failures = oracleResults.filter((r) => r.result.state === 'divergent');
    assert.deepEqual(
      failures.map((f) => divergenceLine(f.skill, f.gate, f.result)),
      [],
      'a contracted gate\'s oracle diverged from its stated claim',
    );

    // Capture honesty (self-honesty rule applied to the reporter itself):
    // an oracle that could not run at all (missing prerequisite) must never
    // be silently counted as "checked".
    const envSkipped = oracleResults.filter((r) => r.result.state === 'env-skipped');

    const lines = formatSummaryLines({ contracted, uncontracted, envSkipped });
    process.stdout.write(`${lines.join('\n')}\n`);

    // Every current skill directory is accounted for exactly once, in
    // contracted OR uncontracted — never both, never neither.
    const allSkillNames = listSkillNames(skillsRoot);
    const contractedNames = new Set(contracted.map((c) => c.skill));
    assert.deepEqual([...contractedNames].sort(), contracted.map((c) => c.skill).sort());
    for (const name of allSkillNames) {
      assert.ok(
        contractedNames.has(name) || uncontracted.includes(name),
        `skill "${name}" is neither contracted nor reported uncontracted`,
      );
    }
  });

  it('matches the pinned v1 census exactly — an intentional coverage change requires editing this test', () => {
    const skillsRoot = path.join(REPO_ROOT, 'skills');
    const { contracted, uncontracted } = loadGateContracts({ skillsRoot, repoRoot: REPO_ROOT });

    assert.deepEqual(contracted.map((c) => c.skill).sort(), [...PINNED_CONTRACTED_SKILLS].sort());

    for (const c of contracted) {
      const executableIds = c.gates.filter((g) => g.kind === 'executable').map((g) => g.id).sort();
      const documentOnlyIds = c.gates.filter((g) => g.kind === 'document-only').map((g) => g.id).sort();
      assert.deepEqual(executableIds, [...PINNED_EXECUTABLE[c.skill]].sort(), `${c.skill} executable gate set drifted`);
      assert.deepEqual(documentOnlyIds, [...PINNED_DOCUMENT_ONLY[c.skill]].sort(), `${c.skill} document-only gate set drifted`);
    }

    const totalExecutable = Object.values(PINNED_EXECUTABLE).flat().length;
    const totalDocOnly = Object.values(PINNED_DOCUMENT_ONLY).flat().length;
    assert.equal(totalExecutable, 5);
    assert.equal(totalDocOnly, 4);

    const allSkillNames = listSkillNames(skillsRoot);
    const expectedUncontracted = allSkillNames.filter((n) => !PINNED_CONTRACTED_SKILLS.includes(n));
    assert.deepEqual([...uncontracted].sort(), expectedUncontracted.sort());
  });
});

describe('gate-honesty — self-honesty: the lying-skill fixture must be caught', () => {
  it('the fixture is schema-valid (isolates the test to oracle-level lies)', () => {
    const skillsRoot = path.join(FIXTURES_ROOT, 'lying-skill', 'skills');
    const repoRoot = path.join(FIXTURES_ROOT, 'lying-skill');
    const { contracted, divergences } = loadGateContracts({ skillsRoot, repoRoot });
    assert.deepEqual(divergences, []);
    assert.equal(contracted.length, 1);
    assert.equal(contracted[0].gates.length, 3);
  });

  it('every one of its three gates is caught as divergent by a DIFFERENT oracle', async () => {
    const skillsRoot = path.join(FIXTURES_ROOT, 'lying-skill', 'skills');
    const repoRoot = path.join(FIXTURES_ROOT, 'lying-skill');
    const { contracted } = loadGateContracts({ skillsRoot, repoRoot });
    const oracleResults = await runAllOracles(contracted, repoRoot);

    assert.equal(oracleResults.length, 3);
    const byGate = Object.fromEntries(oracleResults.map((r) => [r.gate, r.result]));

    assert.equal(byGate['always-green'].state, 'divergent', 'cli-exit oracle must catch the always-exits-0 fake CLI');
    assert.equal(byGate['fake-tiered-shadow'].state, 'divergent', 'tiered-shadow-window oracle must catch fallback_legacy counted as compared');
    assert.equal(byGate['fake-convergence'].state, 'divergent', 'convergence-threshold oracle must catch the wrong exported constant');

    // The suite proves it can fail BEFORE it is allowed to pass (§F2.4) —
    // if this count is ever < 3, the suite has a blind spot.
    const divergent = oracleResults.filter((r) => r.result.state === 'divergent');
    assert.ok(divergent.length >= 3, `expected >= 3 divergences from the lying fixture, got ${divergent.length}`);
    process.stdout.write(
      `gate-honesty: self-check — lying fixture correctly REJECTED (${divergent.length} divergences).\n`
      + divergent.map((d) => `  ${divergenceLine(d.skill, d.gate, d.result)}`).join('\n') + '\n',
    );
  });
});

describe('gate-honesty — negative fixtures (one per loader/schema failure mode)', () => {
  it('a nonexistent implementation path is rejected (fail-closed: missing and unresolvable get the same treatment as any other resolution failure — INC-001)', () => {
    const base = path.join(FIXTURES_ROOT, 'negative', 'nonexistent-implementation');
    const { contracted, divergences } = loadGateContracts({ skillsRoot: path.join(base, 'skills'), repoRoot: base });
    assert.equal(contracted.length, 0);
    assert.ok(divergences.some((d) => d.includes('no-such-file.mjs') && d.includes('invalid')));
  });

  it('a stated string absent from SKILL.md is rejected', () => {
    const base = path.join(FIXTURES_ROOT, 'negative', 'stated-absent');
    const { contracted, divergences } = loadGateContracts({ skillsRoot: path.join(base, 'skills'), repoRoot: base });
    assert.equal(contracted.length, 0);
    assert.ok(divergences.some((d) => d.includes('not found verbatim')));
  });

  it('a document-only gate carrying params is rejected (fake-check guard)', () => {
    const base = path.join(FIXTURES_ROOT, 'negative', 'document-only-with-params');
    const { contracted, divergences } = loadGateContracts({ skillsRoot: path.join(base, 'skills'), repoRoot: base });
    assert.equal(contracted.length, 0);
    assert.ok(divergences.length >= 1, 'expected a schema-validation divergence for the smuggled params field');
  });
});

describe('gate-honesty — statedIn source-authority policy (R3-H2, direct unit coverage)', () => {
  it('accepts the owning skill\'s own SKILL.md and AGENTS.md; rejects everything else', async () => {
    const { isApprovedStatedInSource } = await import('../scripts/lib/gate-honesty/schema.mjs');
    assert.equal(isApprovedStatedInSource('skills/audit-code/SKILL.md', 'audit-code'), true);
    assert.equal(isApprovedStatedInSource('AGENTS.md', 'audit-code'), true);
    assert.equal(isApprovedStatedInSource('skills/visual-audit/SKILL.md', 'audit-code'), false, 'a different skill\'s SKILL.md must be rejected');
    assert.equal(isApprovedStatedInSource('docs/some-doc.md', 'audit-code'), false, 'an arbitrary docs path must be rejected');
    assert.equal(isApprovedStatedInSource('../../etc/passwd', 'audit-code'), false, 'a traversal-shaped path must be rejected');
  });

  it('resolveContainedPath fails closed on a symlink escaping the repo (INC-001 family)', async () => {
    const { resolveContainedPath } = await import('../scripts/lib/gate-honesty/schema.mjs');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-honesty-symlink-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-honesty-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.mjs'), '// outside the repo');
      fs.symlinkSync(path.join(outside, 'secret.mjs'), path.join(repoRoot, 'looks-local.mjs'));
      const verdict = resolveContainedPath('looks-local.mjs', repoRoot);
      assert.equal(verdict.ok, false);
      assert.equal(verdict.reason, 'escapes-repo');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('gate-honesty — tiered-shadow-window oracle correctness (direct, ahead of any contract)', () => {
  it('an all-fallback_legacy fixture reads comparedRuns=0 and met=false — the executable form of d0522e9', async () => {
    const gate = {
      id: 'direct-check',
      oracle: 'tiered-shadow-window',
      implementation: 'scripts/lib/audit/tiered-shadow-summary.mjs',
      fixture: {
        rows: Array.from({ length: 20 }, () => ({
          legacyOk: true, shadowOk: false,
          comparison: { tieredRunStatus: 'fallback_legacy' },
        })),
      },
    };
    const result = await runOracle(gate, { repoRoot: REPO_ROOT });
    assert.equal(result.state, 'ok', result.state === 'divergent' ? `${result.stated} / ${result.found}` : undefined);
  });

  it('a mixed fixture counts only the complete rows as compared', async () => {
    const gate = {
      id: 'direct-check-mixed',
      oracle: 'tiered-shadow-window',
      implementation: 'scripts/lib/audit/tiered-shadow-summary.mjs',
      fixture: {
        rows: [
          ...Array.from({ length: 5 }, () => ({ legacyOk: true, shadowOk: true, comparison: { tieredRunStatus: 'complete' } })),
          ...Array.from({ length: 15 }, () => ({ legacyOk: true, shadowOk: false, comparison: { tieredRunStatus: 'fallback_legacy' } })),
        ],
      },
    };
    const result = await runOracle(gate, { repoRoot: REPO_ROOT });
    assert.equal(result.state, 'ok', result.state === 'divergent' ? `${result.stated} / ${result.found}` : undefined);
  });
});
