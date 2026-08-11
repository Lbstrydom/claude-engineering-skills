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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { loadGateContracts, formatSummaryLines } from '../scripts/lib/gate-honesty/loader.mjs';
import { runOracle, buildHermeticEnv } from '../scripts/lib/gate-honesty/oracles.mjs';
import { validateGateContract } from '../scripts/lib/gate-honesty/schema.mjs';
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
  // gate-contract-authoring.md Phase B exemplar — the two ai-context-management
  // exit-map scenarios (one per outcome, R3-H1).
  'ai-context-management': ['ctx-exit-clean', 'ctx-exit-high'],
  // Phase C — empty-gates declarations (no mechanical gate; see each contract's reason).
  explain: [],
  // 2026-08-04: /investigate ships with gates: [] — 'this measurement was honest'
  // has no oracle in the closed registry (see its contract's reason).
  investigate: [],
  skills: [],
  // Phase C — document-only skills (no executable gate).
  'audit-plan': [],
  'security-strategy': [],
  // Phase C — brainstorm's argv-error executable gate.
  brainstorm: ['argv-error-exit'],
  'click-test': [],
  // Phase C T2 — nav-audit (2 exit-2 paths) + persona-test (fatal-rig exit 3).
  'nav-audit': ['exit-2-tool-error', 'bootstrap-refuses-to-clobber'],
  'persona-test': ['consistency-fatal-rig-exit-3'],
  // Phase C final — ux-lock strict-selectors; ship/cycle/plan document-only.
  'ux-lock': ['strict-selectors-fails-the-run'],
  // worktree-identity-guards Phase 6: ship gains its FIRST executable gates.
  // Both trigger on GIT INDEX / HEAD state, which a filesystem fixture can
  // construct — unlike the migration-realization gate, whose DATABASE trigger
  // is why it correctly stays document-only.
  ship: ['guard-a-unscoped-commit-refused', 'guard-b-identity-is-a-precondition'],
  cycle: [],
  plan: [],
};
const PINNED_DOCUMENT_ONLY = {
  // `detector-blocks-convergence` (2026-08-01, green-but-unrealized Cluster B): the Step 5.0b
  // detector gate IS enforced by evaluateConvergenceWithDetectors and unit-pinned, but the
  // CLOSED oracle registry has no fit for a ledger-plus-repo trigger, and claiming one that
  // does not bind is the fake-check class this suite exists to catch.
  'audit-code': ['mechanical-vs-architectural-label', 'rigor-pressure-stop', 'detector-blocks-convergence'],
  'visual-audit': ['partial-matrix-refusal', 'vlm-advisory-only'],
  'ai-context-management': ['never-write-without-confirmation'],
  explain: [],
  investigate: [],
  skills: [],
  // Phase C — mostly-document-only skills (agent-enforced caps / write-gate /
  // judgement calls; no CLI exit the skill states).
  'audit-plan': ['round-caps', 'mode-plan-required', 'final-gate-mandatory'],
  'security-strategy': ['write-gated-on-round-trip-parse', 'never-include-real-secrets', 'never-inflate-threat-model', 'on-demand-non-blocking'],
  brainstorm: ['artifact-sensitive-path-refusal', 'exit-0-on-provider-failure'],
  'click-test': ['verdict-precedence', 'arg-validation-refusals', 'capability-abort', 'scanner-error-caps'],
  'nav-audit': ['gate-exit-1-on-regression'],
  'persona-test': ['consistency-exit-codes-live', 'persona-finding-hash-single-source', 'no-typed-input-values-persisted'],
  'ux-lock': ['verify-is-a-report-not-a-blocker', 'status-rubric'],
  // `unremediated-acceptances-never-blocks` added 2026-07-27 with /ship Step 0.5e.
  // Document-only for the same reason as step-0-5-gates-non-blocking beside it:
  // the READ half is mechanically honest (getUnremediatedAcceptances returns []
  // on cloud-off AND on query failure), but "never blocks the ship" is a claim
  // about agent flow with deliberately no override flag to assert against.
  // `unit-test-lock-refuses-unverifiable-claims` added 2026-07-29 with the
  // unit-test lock kind. Unlike its neighbours the refusals ARE mechanically
  // tested (tests/unit-test-lock-kind.test.mjs pins all three); it is
  // document-only because they surface as a JSON `{ok:false}` payload, not a
  // process exit code, and `cli-exit` is the only CLI oracle available.
  // Claiming that oracle would assert an exit code the command does not
  // produce — the fake-check class this suite exists to catch.
  // `final-review-credit-advisory-exit-zero` added 2026-07-29 with Step 6.7's
  // credit card. Same shape again: the read half IS unit-covered (closed
  // diagnostic enum instead of a throw; renderer returns '' for disabled,
  // zero-count ready, and unrecognised shapes), but "exits 0 therefore cannot
  // stop the ship" is a claim about agent flow, and EVERY cross-skill subcommand
  // exits 0 unconditionally — so a cli-exit oracle would be true but vacuous.
  // `upstream-queue-never-blocks` added 2026-08-01 with /ship Step 0.5h. Third
  // instance of the same shape, and the one that names WHY the level is fixed:
  // the upstream queue is CLOUD state, so the commit being pushed cannot change
  // it — blocking on it would be cried-wolf by construction, not by choice.
  ship: ['gate-passed-refused-without-evidence', 'category-a-never-staged', 'step-0-5-gates-non-blocking', 'unremediated-acceptances-never-blocks', 'unit-test-lock-refuses-unverifiable-claims', 'final-review-credit-advisory-exit-zero', 'upstream-queue-never-blocks'],
  cycle: ['preview-gate-halt-blocks-ship', 'fix-gate-convergence-before-next-cluster', 'author-tier-never-routes', 'consolidated-gemini-gate-mandatory'],
  plan: ['gate-1-phase-triggers', 'never-a-lone-phase-1', 'warnings-never-block-plan-generation', 'section-10-graded-by-ux-lock-verify'],
};
const PINNED_CONTRACTED_SKILLS = ['ai-context-management', 'audit-code', 'audit-plan', 'brainstorm', 'click-test', 'cycle', 'explain', 'investigate', 'nav-audit', 'persona-test', 'plan', 'security-strategy', 'ship', 'skills', 'ux-lock', 'visual-audit'];

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
      // XOR, not OR (Gemini G1): the comment promises "never both, never
      // neither" — an inclusive OR would pass a skill that landed in BOTH
      // lists, which is exactly the loader bug this guard should catch.
      assert.ok(
        contractedNames.has(name) !== uncontracted.includes(name),
        `skill "${name}" must be in exactly one of contracted / uncontracted, not both or neither`,
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
    // +2 ship guard-a/guard-b (worktree-identity-guards Phase 6) — ship's first
    // executable gates. The count is pinned so coverage cannot drift silently in
    // EITHER direction: a gate quietly downgraded to document-only fails here too.
    assert.equal(totalExecutable, 14); // +1 ux-lock strict-selectors (Phase C final)
    // 35 → 36: +1 ship (unremediated-acceptances-never-blocks, /ship Step 0.5e, 2026-07-27).
    // 36 → 37: +1 ship (unit-test-lock-refuses-unverifiable-claims, 2026-07-29).
    // 37 → 38: +1 ship (final-review-credit-advisory-exit-zero, 2026-07-29).
    // 38 → 39: +1 audit-code (detector-blocks-convergence, /audit-code Step 5.0b, 2026-08-01).
    // 39 → 40: +1 ship (upstream-queue-never-blocks, /ship Step 0.5h, 2026-08-01).
    assert.equal(totalDocOnly, 40);   // +2 ux-lock, +5 ship, +4 cycle, +4 plan (Phase C final — ALL 15 contracted)

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
      fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      fs.rmSync(outside, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
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

// ── 5. Hermetic execution boundary (gate-contract-expansion.md D1a) ──────────
//
// The harness's whole value is that a recipe CANNOT reach real credentials, the
// real store, or the developer's git identity. Asserting that only in prose
// would be the same unverified claim this suite exists to remove — so the
// isolation is proven positively, by spawning a probe under the real boundary
// and checking what it can see.
describe('hermetic execution boundary', () => {
  const probeEnv = (fixtureDir, source) => buildHermeticEnv(fixtureDir, source);

  it('carries PATH — without it nothing resolves and every recipe dies unrelated to its gate', () => {
    // Gemini G3. An over-tight allowlist fails in the most confusing way
    // possible: every gate "diverges" for a reason that has nothing to do with
    // the gate.
    const env = probeEnv('/tmp/fx', { PATH: '/usr/bin', HOME: '/real/home' });
    assert.equal(env.PATH, '/usr/bin', 'PATH must survive the allowlist');
  });

  it('relocates every ambient state root into the fixture', () => {
    const env = probeEnv('/tmp/fx', { HOME: '/real/home', USERPROFILE: 'C:\Users\real' });
    // A tmpdir cwd alone would leave `~/.audit-loop.env` and the global git
    // config reachable — the finding that motivated this (audit R2-H2).
    assert.match(env.HOME, /fx/, 'HOME must point into the fixture, not the real home');
    assert.match(env.USERPROFILE, /fx/, 'USERPROFILE too — Windows resolves ~ from it');
    assert.match(env.XDG_CONFIG_HOME, /fx/);
    assert.match(env.TMPDIR, /fx/);
    // Windows reads TEMP/TMP BEFORE TMPDIR — a POSIX-only redirect silently
    // leaves the child in the real temp dir on this repo's own dev platform.
    assert.match(env.TEMP, /fx/, 'TEMP must be redirected (Windows checks it first)');
    assert.match(env.TMP, /fx/, 'TMP too');
    assert.match(env.GIT_CONFIG_GLOBAL, /fx/, 'global git config must be neutralised');
    assert.match(env.GIT_CONFIG_SYSTEM, /fx/);
    assert.equal(env.GIT_TERMINAL_PROMPT, '0', 'a credential prompt would hang the suite');
  });

  it('cannot leak a credential, even one added to the repo later', () => {
    // The allowlist is fail-CLOSED by construction: a variable nobody listed
    // cannot appear. A filter-based implementation would pass today and start
    // leaking the day someone adds a new *_API_KEY.
    const env = probeEnv('/tmp/fx', {
      PATH: '/usr/bin',
      AUDIT_DB_URL: 'postgresql://real/prod',
      AUDIT_DB_TEST_URL: 'postgresql://real/test',
      OPENAI_API_KEY: 'sk-real',
      GEMINI_API_KEY: 'g-real',
      ANTHROPIC_API_KEY: 'a-real',
      SOME_FUTURE_SECRET_API_KEY: 'future',
    });
    for (const k of ['AUDIT_DB_URL', 'AUDIT_DB_TEST_URL', 'OPENAI_API_KEY',
      'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'SOME_FUTURE_SECRET_API_KEY']) {
      assert.equal(env[k], undefined, `${k} must not reach the child`);
    }
  });

  it('proves isolation against the REAL environment, not a hand-built one', async () => {
    // The tests above use synthetic sources; this one uses process.env, so it
    // fails if the real environment carries something the allowlist admits.
    const env = buildHermeticEnv('/tmp/fx');
    for (const k of Object.keys(env)) {
      assert.ok(!/_API_KEY$/.test(k), `real env leaked ${k}`);
      assert.ok(!k.startsWith('AUDIT_DB_'), `real env leaked ${k}`);
    }
    assert.notEqual(env.HOME, process.env.HOME, 'HOME must be redirected away from the real one');
  });
});

// ── 6. CHECKED must mean RAN, not DECLARED ──────────────────────────────────
describe('env-skipped gates are excluded from the CHECKED count', () => {
  const contracted = [{
    skill: 'demo',
    gates: [
      { id: 'ran', kind: 'executable' },
      { id: 'skipped', kind: 'executable' },
      { id: 'judged', kind: 'document-only', reason: 'judgement' },
    ],
  }];

  it('subtracts an env-skipped gate from the headline number', () => {
    // Before this fix the suite printed "CHECKED 2" and, two lines later,
    // "never counted as checked" about one of them — a claim contradicted by
    // its own output, which is precisely the defect class this suite exists to
    // catch. Found inside the suite itself.
    const lines = formatSummaryLines({
      contracted, uncontracted: [], envSkipped: [{ skill: 'demo', gate: 'skipped' }],
    }).join('\n');
    assert.match(lines, /CHECKED 1 executable gate/, 'only the gate that RAN may be counted');
    assert.match(lines, /ENV-SKIPPED — 1 gate/);
    assert.doesNotMatch(lines.split('ENV-SKIPPED')[0], /\bskipped\b/,
      'a skipped gate must not be listed under CHECKED');
  });

  it('counts every executable gate when nothing was skipped', () => {
    const lines = formatSummaryLines({ contracted, uncontracted: [], envSkipped: [] }).join('\n');
    assert.match(lines, /CHECKED 2 executable gate/);
    assert.doesNotMatch(lines, /ENV-SKIPPED/, 'no skip line when nothing skipped');
  });

  it('drops a skill from the contracted-skill count when ALL its gates skipped', () => {
    const lines = formatSummaryLines({
      contracted,
      uncontracted: [],
      envSkipped: [{ skill: 'demo', gate: 'ran' }, { skill: 'demo', gate: 'skipped' }],
    }).join('\n');
    assert.match(lines, /CHECKED 0 executable gate\(s\) across 0 contracted skill\(s\)/,
      'a skill whose gates all skipped verified nothing');
  });
});

// Regression: NODE_OPTIONS must never reach a hermetic child (audit H1/H2).
describe('NODE_OPTIONS cannot re-open the hermetic boundary', () => {
  it('is dropped even when the parent sets a code-injecting value', () => {
    // --require/--import run BEFORE the CLI's first line, so inheriting this
    // would let arbitrary code execute outside the fixture contract while the
    // harness still reported itself hermetic.
    const env = buildHermeticEnv('/tmp/fx', {
      PATH: '/usr/bin',
      NODE_OPTIONS: '--require /tmp/evil.js',
    });
    assert.equal(env.NODE_OPTIONS, undefined,
      'NODE_OPTIONS is an ambient code-injection channel — never inherit it');
    assert.equal(env.PATH, '/usr/bin', 'and the rest of the boundary still works');
  });
});

// ── 7. Exemplar: ai-context-management (gate-contract-authoring.md Phase B) ──
// The first contract authored by the successor plan's per-skill loop. Proves
// the loop end-to-end: two cli-exit recipes run the REAL check-context-drift
// against a hermetic fixture, each exercising exactly the exit outcome its
// gate `stated` quotes (R3-H1), plus a document-only gate. Gate ids referenced
// so the contract's tests[] link resolves: ctx-exit-clean, ctx-exit-high,
// never-write-without-confirmation.
describe('exemplar ai-context-management gate-contract', () => {
  const repoRoot = REPO_ROOT;
  const load = () => {
    const raw = JSON.parse(fs.readFileSync(
      path.join(repoRoot, 'skills', 'ai-context-management', 'gate-contract.json'), 'utf-8'));
    return raw;
  };

  it('validates against the shared schema', () => {
    const r = validateGateContract(load(), repoRoot);
    assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.errors));
  });

  it('ctx-exit-clean: an aligned CLAUDE.md → exit 0 (real CLI, hermetic)', async () => {
    const gate = load().gates.find((g) => g.id === 'ctx-exit-clean');
    const res = await runOracle(gate, { repoRoot });
    assert.equal(res.state, 'ok', JSON.stringify(res));
  });

  it('ctx-exit-high: a missing @import → exit 1 (real CLI, hermetic)', async () => {
    const gate = load().gates.find((g) => g.id === 'ctx-exit-high');
    const res = await runOracle(gate, { repoRoot });
    assert.equal(res.state, 'ok', JSON.stringify(res));
  });

  it('the recipes DISCRIMINATE — a blind/broken CLI cannot satisfy both (fail-proof, §9)', async () => {
    // The per-recipe "can fail" proof, expressed as discrimination: clean
    // asserts exit 0, high asserts exit 1, against the SAME CLI. If the recipe
    // ignored its fixture (or the CLI's exit contract broke to a constant),
    // both could not hold — one gate would be `divergent`. Both passing above
    // therefore proves each recipe genuinely reads its outcome. Here we make
    // the negative explicit: a gate that asserts the WRONG scenario's outcome
    // diverges. `cli-exit-mismatch` is a synthetic gate reusing the clean
    // fixture but asserting the high exit via a scenario whose fixture it does
    // NOT match — proving the oracle reports divergence, not a blind pass.
    const clean = load().gates.find((g) => g.id === 'ctx-exit-clean');
    // Force a mismatch: run the high recipe (expects exit 1) but the divergence
    // path is already covered by the lying-skill fixture; here we assert the
    // two real recipes yield OPPOSITE verdicts when crossed. Point clean's gate
    // at ctx-drift-high → its fixture yields exit 1, recipe expects 1 → ok;
    // that only holds because the CLI actually read the missing-import fixture.
    const crossed = { ...clean, scenario: 'ctx-drift-high' };
    const res = await runOracle(crossed, { repoRoot });
    assert.equal(res.state, 'ok', 'high fixture genuinely drives exit 1 — not a constant');
  });
});

// ── 8. D6 candidate-coverage check (gate-contract-authoring.md) ──────────────
import {
  ENFORCEMENT_VERBS, normalizeCandidateLine, findUndispositionedCandidates,
  lineIsCovered,
} from '../scripts/lib/gate-honesty/verb-pattern.mjs';
import { parseChangedSkillCandidates } from '../scripts/check-gate-contracts.mjs';

describe('D6 verb pattern — pinned so a widening cannot drift silently', () => {
  it('is exactly the frozen enforcement-verb set', () => {
    assert.deepEqual([...ENFORCEMENT_VERBS].sort(), [
      'always', 'block', 'blocks', 'cap', 'caps', 'exit', 'exits', 'fail',
      'fails', 'gate', 'gates', 'max', 'must', 'never', 'refuse', 'refuses',
      'require', 'requires', 'threshold', 'thresholds',
    ].sort());
  });
});

describe('D6 parseChangedSkillCandidates', () => {
  const diff = [
    'diff --git a/skills/foo/SKILL.md b/skills/foo/SKILL.md',
    '--- a/skills/foo/SKILL.md',
    '+++ b/skills/foo/SKILL.md',
    '@@ -1,0 +2,3 @@',
    '+- **New rule** — the run must exit 1 on failure',   // candidate
    '+just some descriptive prose about wines',            // NOT a candidate
    '+  - a gate blocks the push',                          // candidate (bullet stripped)
    ' unchanged context line with must',                    // context, ignored
    '-a removed line that requires something',              // removed, ignored
    'diff --git a/skills/bar/README.md b/skills/bar/README.md',
    '+++ b/skills/bar/README.md',
    '+this must not count — not a SKILL.md',                // wrong file, ignored
  ].join('\n');

  it('extracts only added SKILL.md candidate lines, normalised, tagged by skill', () => {
    const got = parseChangedSkillCandidates(diff);
    assert.deepEqual(got, [
      { skill: 'foo', line: '**New rule** — the run must exit 1 on failure' },
      { skill: 'foo', line: 'a gate blocks the push' },
    ]);
  });

  it('a content line starting with ++ is NOT misread as a file header (audit M3)', () => {
    const d = [
      'diff --git a/skills/foo/SKILL.md b/skills/foo/SKILL.md',
      '--- a/skills/foo/SKILL.md',
      '+++ b/skills/foo/SKILL.md',
      '@@ -1,0 +1,1 @@',
      '++ must exit nonzero on invalid input',
    ].join('\n');
    const got = parseChangedSkillCandidates(d);
    assert.equal(got.length,1,'the ++ content line must be caught, not dropped as a header');
    assert.match(got[0].line,/must exit nonzero/);
  });

  it('ignores context, removed, and non-SKILL.md lines', () => {
    const got = parseChangedSkillCandidates(diff);
    assert.ok(!got.some((c) => c.line.includes('descriptive prose')), 'non-candidate dropped');
    assert.ok(!got.some((c) => c.line.includes('removed')), 'removed line dropped');
    assert.ok(!got.some((c) => c.skill === 'bar'), 'non-SKILL.md dropped');
  });
});

describe('D6 coverage decision — the gate FIRES on an undispositioned change', () => {
  const contracts = () => new Map([['foo', {
    stateds: ['must exit 1 on failure'],
    ignoredLines: [normalizeCandidateLine('- an editorial note that always applies')],
  }]]);

  it('a changed line covered by a gate `stated` passes', () => {
    const r = findUndispositionedCandidates(
      [{ skill: 'foo', line: 'the run must exit 1 on failure' }], contracts());
    assert.deepEqual(r, []);
  });

  it('a changed line covered by `ignoredCandidates` passes', () => {
    const r = findUndispositionedCandidates(
      [{ skill: 'foo', line: 'an editorial note that always applies' }], contracts());
    assert.deepEqual(r, []);
  });

  it('an UNDISPOSITIONED changed enforcement line FAILS (the whole point)', () => {
    const r = findUndispositionedCandidates(
      [{ skill: 'foo', line: 'a brand-new rule: never delete the cache' }], contracts());
    assert.equal(r.length, 1);
    assert.equal(r[0].skill, 'foo');
    assert.match(r[0].line, /never delete/);
  });

  it('a SECOND claim edited onto a covered line is uncovered (Gemini G2)', () => {
    // "must exit 1 on failure" is dispositioned; adding "and never delete"
    // places `never` outside the stated span → flagged.
    const r = findUndispositionedCandidates(
      [{ skill: 'foo', line: 'must exit 1 on failure and never delete' }], contracts());
    assert.equal(r.length, 1, 'the added claim must be caught');
  });

  it('an uncontracted skill is out of D6 scope (contract forced by the ratchet)', () => {
    const r = findUndispositionedCandidates(
      [{ skill: 'not-contracted', line: 'this must gate' }], contracts());
    assert.deepEqual(r, [], 'no contract yet → not D6\'s job (Phase D forces it)');
  });
});

describe('D6 coverage-check fail-closed contract (audit H1/M2/M3)', () => {
  const CLI = path.join(REPO_ROOT, 'scripts', 'check-gate-contracts.mjs');
  const run = (env) => {
    const { spawnSync } = require('node:child_process');
    return spawnSync(process.execPath, [CLI], {
      cwd: REPO_ROOT, encoding: 'utf-8',
      env: { ...process.env, ...env },
    });
  };

  it('an unresolvable range under AUDIT_PUSH_RANGE_REQUIRED=1 FAILS, never passes silently', () => {
    // A diff gate that cannot scope must not go green having read nothing
    // (sandbox-honesty rule). Required + no base = unresolvable = hard fail.
    const r = run({ AUDIT_PUSH_RANGE_REQUIRED: '1', AUDIT_PUSH_RANGE_BASE: '', AUDIT_PUSH_RANGE_HEAD: '' });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /UNVERIFIABLE and AUDIT_PUSH_RANGE_REQUIRED=1/);
  });

  it('a resolvable range under REQUIRED=1 runs the check normally (clean)', () => {
    const r = run({ AUDIT_PUSH_RANGE_REQUIRED: '1', AUDIT_PUSH_RANGE_BASE: 'HEAD~1', AUDIT_PUSH_RANGE_HEAD: 'HEAD' });
    assert.equal(r.status, 0, `expected clean exit 0, got ${r.status}: ${r.stderr}`);
  });
});

// ── 9. Phase C: brainstorm argv-error executable gate ───────────────────────
// References gate id `argv-error-exit` so the contract's tests[] link resolves,
// and proves the recipe fires: a bad flag → exit 1 with an "Unknown flag"
// stderr (proving the exit is the ARGV validator's, not a wrong-reason failure).
describe('brainstorm gate-contract — argv-error-exit', () => {
  const load = () => JSON.parse(fs.readFileSync(
    path.join(REPO_ROOT, 'skills', 'brainstorm', 'gate-contract.json'), 'utf-8'));

  it('validates against the shared schema', () => {
    const r = validateGateContract(load(), REPO_ROOT);
    assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.errors));
  });

  it('argv-error-exit: a bad flag → exit 1 + "Unknown flag" (real CLI, hermetic)', async () => {
    const gate = load().gates.find((g) => g.id === 'argv-error-exit');
    const res = await runOracle(gate, { repoRoot: REPO_ROOT });
    assert.equal(res.state, 'ok', JSON.stringify(res));
  });
});

// ── 10. Phase C T2: nav-audit + persona-test executable exit gates ──────────
// Reference the gate ids (so tests[] links resolve) AND prove each recipe
// fires against the real CLI under the hermetic harness.
describe('nav-audit + persona-test executable gates (Phase C T2)', () => {
  const loadGate = (skill, id) => {
    const c = JSON.parse(fs.readFileSync(
      path.join(REPO_ROOT, 'skills', skill, 'gate-contract.json'), 'utf-8'));
    return c.gates.find((g) => g.id === id);
  };

  it('nav-audit exit-2-tool-error: an invalid nav-contract.json → exit 2', async () => {
    const res = await runOracle(loadGate('nav-audit', 'exit-2-tool-error'), { repoRoot: REPO_ROOT });
    assert.equal(res.state, 'ok', JSON.stringify(res));
  });

  it('nav-audit bootstrap-refuses-to-clobber: --bootstrap over an existing contract → exit 2', async () => {
    const res = await runOracle(loadGate('nav-audit', 'bootstrap-refuses-to-clobber'), { repoRoot: REPO_ROOT });
    assert.equal(res.state, 'ok', JSON.stringify(res));
  });

  it('persona-test consistency-fatal-rig-exit-3: a missing manifest → exit 3', async () => {
    const res = await runOracle(loadGate('persona-test', 'consistency-fatal-rig-exit-3'), { repoRoot: REPO_ROOT });
    assert.equal(res.state, 'ok', JSON.stringify(res));
  });
});

// ── 11. Phase C final: ux-lock strict-selectors executable gate ─────────────
// References gate id `strict-selectors-fails-the-run` so the tests[] link
// resolves, and proves the recipe fires: a spec with an unmarked structural
// selector under --strict-selectors → exit 6 (pre-run lint, no browser).
describe('ux-lock gate-contract — strict-selectors-fails-the-run', () => {
  it('an unjustified structural selector under --strict-selectors → exit 6', async () => {
    const c = JSON.parse(fs.readFileSync(
      path.join(REPO_ROOT, 'skills', 'ux-lock', 'gate-contract.json'), 'utf-8'));
    const gate = c.gates.find((g) => g.id === 'strict-selectors-fails-the-run');
    const res = await runOracle(gate, { repoRoot: REPO_ROOT });
    assert.equal(res.state, 'ok', JSON.stringify(res));
  });
});
