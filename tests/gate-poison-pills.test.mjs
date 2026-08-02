/**
 * @fileoverview The poison-pill meta-gate — can it go green having checked nothing?
 *
 * This file's own subject is a gate, so its most important assertions are adversarial
 * against ITSELF: a registry that is empty, a gate nobody declared, a pill that "passes"
 * because the harness crashed. Those are the shapes that would make `gates:poison` a
 * decorative green.
 *
 * Plan: docs/plans/green-but-unrealized.md (Cluster B, Phase 3).
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import os from 'node:os';

import {
  extractCheckGates, loadContracts, loadExemptions, reconcile, runPill, _internals,
} from '../scripts/check-gate-poison-pills.mjs';
import { validateCliGateContract } from '../scripts/lib/gate-honesty/schema.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));

// ── Terminal-gate extraction ────────────────────────────────────────────────

test('extraction follows npm run TRANSITIVELY, not one level', () => {
  const scripts = { check: 'npm run a', a: 'npm run b', b: 'node scripts/x.mjs' };
  const gates = extractCheckGates(scripts);
  assert.deepEqual(gates.map((g) => g.script), ['b'], 'a one-level parse would have found nothing');
});

test('extraction handles npm lifecycle shorthand (`npm test` === `npm run test`)', () => {
  // Matching only the long form hard-errored on this repo's own chain, which ends in
  // `npm test` — an under-count in the function whose job is refusing under-counts.
  const gates = extractCheckGates({ check: 'npm test', test: 'node --test tests/**' });
  assert.deepEqual(gates.map((g) => g.script), ['test']);
});

test('extraction accepts ANY terminal node command, not just scripts/*.mjs', () => {
  // `node --test tests/**` must resolve; a `scripts/`-prefixed matcher would hard-error on
  // a gate the exemptions legitimately list.
  const gates = extractCheckGates({ check: 'node --test tests/**' });
  assert.equal(gates.length, 1);
});

test('a non-node terminal command is a GATE, not an error', () => {
  // Requiring `node …` meant a gate added as a bare binary could not be represented at all:
  // it hard-errored, so the only way to put `eslint .` in the chain was to break this gate.
  // "A decision per gate" has to cover gates we did not author.
  const gates = extractCheckGates({ check: 'npm run lint', lint: 'eslint .' });
  assert.deepEqual(gates.map((g) => g.command), ['eslint .']);
  // …and it is still reconciled: unpilled and unexempt ⇒ undeclared, not silently dropped.
  assert.deepEqual(reconcile(gates, [], {}).undeclared, ['eslint .']);
});

test('a missing npm script is a HARD ERROR, never a silently dropped gate', () => {
  assert.throws(() => extractCheckGates({ check: 'npm run nope' }), /does not exist/);
});

test('a shell operator other than && is REFUSED — it could chain commands we cannot see', () => {
  // Only `&&` is split, and the npm-run match used to be unanchored: `npm run a ; npm run b`
  // matched `a` and dropped `b` entirely, so the dropped command was never reconciled
  // against a contract or an exemption (consolidated Gemini gate, round 1).
  for (const body of ['npm run a ; npm run b', 'npm run a || npm run b', 'node x.mjs & node y.mjs',
    'node $(which x).mjs', 'node `x`.mjs']) {
    assert.throws(() => extractCheckGates({ check: body, a: 'node a.mjs', b: 'node b.mjs' }),
      /shell operator/, body);
  }
});

test('a script-level exemption does NOT cover an AGGREGATE script', () => {
  // Otherwise one entry accounts for every command the script runs, and a command added
  // later inherits an exemption written about something else.
  const scripts = { check: 'npm run agg', agg: 'node a.mjs && node b.mjs' };
  const gates = extractCheckGates(scripts);
  const { undeclared } = reconcile(gates, [], { agg: 'exempt for a reason about a.mjs only' });
  assert.deepEqual(undeclared, ['node a.mjs', 'node b.mjs']);
  // A single-command script is the case a script-level exemption legitimately covers.
  const one = extractCheckGates({ check: 'npm run solo', solo: 'node a.mjs' });
  assert.deepEqual(reconcile(one, [], { solo: 'a real reason' }).undeclared, []);
});

test('extraction is cycle-safe', () => {
  assert.doesNotThrow(() => extractCheckGates({ check: 'npm run a', a: 'npm run check' }));
});

// ── Every real gate has a DECISION ──────────────────────────────────────────

test('every check-chain gate in THIS repo is contracted or explicitly exempt', () => {
  const gates = extractCheckGates(pkg.scripts);
  const { undeclared } = reconcile(gates, loadContracts(), loadExemptions());
  assert.deepEqual(
    undeclared, [],
    'a new gate must carry a poison pill or a written exemption — this is what stops a '
    + '19th gate being added silently',
  );
});

/**
 * The exemption set as it stood when this plan landed — a RATCHET, not a snapshot.
 *
 * §2 dec. 3 says a gate added after 2026-07-31 is REQUIRED to carry a pill, but nothing
 * expressed that: a new gate could simply be appended to `_exemptions.json` with a
 * plausible sentence and be indistinguishable from the grandfathered set. Pinning the
 * legacy names here means the list may SHRINK freely (contracting a gate is always
 * welcome) while growing it takes a deliberate edit to a test that says why it must not.
 * Same shape as `.gate-contract-baseline.json` for skills.
 */
const GRANDFATHERED_EXEMPTIONS = [
  'arch:coverage-gate', 'cli:flags:gate', 'db:check-rls:gate', 'db:suites:gate',
  'docs:check', 'docs:refs:gate', 'efficacy:check', 'gates:poison', 'knip:gate',
  'node scripts/check-gate-contracts.mjs', 'node scripts/check-skill-refs.mjs',
  'node scripts/check-stale-skill-surface.mjs --gate',
  'npm-args:gate', 'on-conflict:check', 'plans:lint', 'plans:status', 'test',
];

test('the exemption list may shrink, never grow — a new gate must be pilled', () => {
  const now = Object.keys(loadExemptions()).sort();
  const added = now.filter((g) => !GRANDFATHERED_EXEMPTIONS.includes(g));
  assert.deepEqual(
    added, [],
    'a gate added after 2026-07-31 must carry a poison pill, not an exemption. If it '
    + 'genuinely cannot be pilled, add it to GRANDFATHERED_EXEMPTIONS here together with '
    + 'the reason — deliberately, in a diff a reviewer sees.',
  );
});

test('every exemption carries a non-trivial written reason', () => {
  for (const [gate, reason] of Object.entries(loadExemptions())) {
    assert.equal(typeof reason, 'string', `${gate}: reason must be a string`);
    assert.ok(reason.length > 60, `${gate}: "${reason}" is too short to be a real justification`);
  }
});

// ── Adversarial: can the meta-gate go green having checked nothing? ─────────

test('an EMPTY registry does not read as clean — it reads as undeclared', () => {
  // The failure this whole plan is about: a gate returning OK having verified nothing.
  // With no contracts and no exemptions, every gate must be reported, not passed.
  const gates = extractCheckGates(pkg.scripts);
  const { undeclared } = reconcile(gates, [], {});
  assert.ok(undeclared.length > 10, 'an empty registry must surface every gate, not none');
});

test('a pill that is not tmpdir-isolated is REFUSED, not run', () => {
  const r = runPill({ script: 'x', poisonPill: { isolation: 'flag', argv: [] } }, { repoRoot: REPO_ROOT });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /isolation must be "tmpdir"/);
});

test('an overlay pointing at a non-existent destination is REFUSED', () => {
  // Otherwise the fixture is an orphan the gate never reads, and the pill "passes" on a
  // crash — the poison pill contracting the disease it tests for.
  const r = runPill({
    script: 'x',
    poisonPill: {
      isolation: 'tmpdir',
      argv: ['scripts/build-manifest.mjs', '--check'],
      overlay: { 'no/such/file.json': 'tests/fixtures/poison/skills-manifest-tampered.json' },
    },
  }, { repoRoot: REPO_ROOT });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /does not exist/);
});

// ── One schema, two sources ─────────────────────────────────────────────────

test('a CLI-gate contract is refused unless its claim is stated in AGENTS.md', () => {
  // The closed source-authority policy, inherited rather than reimplemented. A CLI gate has
  // no owning SKILL.md, so AGENTS.md is the only legal source — anything else would let a
  // contract cite prose nobody maintains.
  const base = {
    version: 1,
    gate: 'demo:gate',
    guards: 'nothing real',
    gates: [{
      id: 'demo', kind: 'executable', statedIn: 'docs/plans/green-but-unrealized.md',
      stated: 'x', implementation: 'package.json', tests: ['tests/gate-poison-pills.test.mjs'],
      proof: 'process', oracle: 'poison-pill',
      poisonPill: {
        isolation: 'tmpdir', argv: ['x.mjs'], mutate: { 'package.json': { path: 'name', value: 'z' } },
        expectStderr: 'boom', why: 'demo',
      },
    }],
  };
  const bad = validateCliGateContract(base, REPO_ROOT);
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /not an approved source/);
});

test('a poison-pill gate with no tamper at all is schema-invalid', () => {
  const c = {
    version: 1, gate: 'demo:gate', guards: 'x',
    gates: [{
      id: 'demo', kind: 'executable', statedIn: 'AGENTS.md', stated: 'x',
      implementation: 'package.json', tests: ['tests/gate-poison-pills.test.mjs'],
      proof: 'process', oracle: 'poison-pill',
      poisonPill: { isolation: 'tmpdir', argv: ['x.mjs'], expectStderr: 'boom', why: 'demo' },
    }],
  };
  const r = validateCliGateContract(c, REPO_ROOT);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /overlay or a mutate/);
});

test('every contract file is named after the gate it declares', () => {
  // The CLI-gate form of contract↔directory identity: a contract filed under another
  // gate's name would be validated, counted, and attributed to the wrong gate.
  for (const c of loadContracts()) {
    assert.equal(path.basename(c.file), `${c.script.replace(/:/g, '-')}.json`);
  }
});

// ── The `mutate` tamper shape ───────────────────────────────────────────────

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pill-mut-'));
  tmpDirs.push(d);
  return d;
}

function tmpJson(obj) {
  const p = path.join(tmpDir(), 'a.json');
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`);
  return p;
}

test('mutate changes exactly the named field and leaves the rest byte-stable', () => {
  const p = tmpJson({ bundleVersion: 'abc', skills: { plan: { sha: 'real' } } });
  assert.equal(_internals.applyMutation(p, { path: 'skills.plan.sha', value: '000' }), true);
  const after = JSON.parse(fs.readFileSync(p, 'utf-8'));
  assert.equal(after.skills.plan.sha, '000');
  assert.equal(after.bundleVersion, 'abc',
    'the versions must survive — "versions match, content differs" IS the condition under test');
});

test('a mutation that changes NOTHING is refused, not silently applied', () => {
  // The false green in miniature: the gate is handed a pristine artifact and "passes"
  // having detected nothing, while the pill reports success.
  const p = tmpJson({ skills: { plan: { sha: 'same' } } });
  const r = _internals.applyMutation(p, { path: 'skills.plan.sha', value: 'same' });
  assert.match(String(r), /already equals/);
});

test('a mutation path that does not exist is refused, never auto-created', () => {
  // Auto-vivifying would add a field the real artifact never has, so the gate would reject
  // a shape it will never see in production — a pill passing for the wrong reason.
  const p = tmpJson({ skills: {} });
  assert.match(String(_internals.applyMutation(p, { path: 'skills.plan.sha', value: 'x' })), /does not exist/);
  assert.match(String(_internals.applyMutation(p, { path: 'nope', value: 'x' })), /does not exist/);
});

test('a malformed or missing target is reported, not thrown', () => {
  const dir = tmpDir();
  const bad = path.join(dir, 'b.json');
  fs.writeFileSync(bad, 'not json at all');
  assert.match(String(_internals.applyMutation(bad, { path: 'a', value: 1 })), /not JSON/);
  assert.match(String(_internals.applyMutation(path.join(dir, 'gone.json'), { path: 'a', value: 1 })),
    /does not exist/);
  assert.match(String(_internals.applyMutation(bad, {})), /needs \{path, value\}/);
});

test('an artifact whose formatting we would not reproduce is REFUSED, not rewritten', () => {
  // Re-serializing means the gate could reject the reformatting rather than the tampering,
  // and the pill would "pass" for a reason unrelated to the field it changed.
  const p = path.join(tmpDir(), 'c.json');
  fs.writeFileSync(p, '{"a":1}');                    // compact — not stringify(…, null, 2)
  assert.match(String(_internals.applyMutation(p, { path: 'a', value: 2 })), /formatting differs/);
  assert.equal(fs.readFileSync(p, 'utf-8'), '{"a":1}', 'and it must not have written anything');
});

// ── The real contracts are well-formed ──────────────────────────────────────

/**
 * The five gates §2 dec. 3 of the plan made mandatory, keyed by contract gate id.
 *
 * Listed by ID rather than by script name because the shared validator requires a
 * contract's `tests[]` file to actually reference the gate it claims — so this list IS the
 * reference, and dropping a gate from the registry breaks the assertion below rather than
 * quietly shrinking the covered set. Execution of the pills themselves is the `gates:poison`
 * step of the `check` chain; what this file pins is that the registry cannot silently lose
 * one, and that every pill is shaped so it can actually fail.
 */
const MANDATORY = {
  'skills:check': [
    'skills-check-authenticates-manifest-content',
    'skills-check-detects-hand-edited-generated-copy',
    'skills-check-detects-shared-reference-drift',
  ],
  'plans:index:check': ['plans-index-check-compares-rendered-content'],
  'requirements:map:check': ['requirements-map-check-compares-rendered-content'],
  'parity:check-coupling': ['parity-coupling-rejects-new-schema-qualification'],
  'context:check': ['context-check-rejects-missing-agents-import'],
  // Added 2026-08-02 when the architecture-intent drift gate finally landed on main
  // (it sat unmerged on a branch for 110 commits). A gate added after 2026-07-31 must
  // carry a pill, never an exemption — §2 dec. 3.
  'docs:architecture-intent:check': ['architecture-intent-check-detects-an-undocumented-domain'],
};

test('every gate the plan made mandatory is contracted — not quietly exempted', () => {
  // Exempting one of them with a plausible-sounding reason is the half-applied rule this
  // whole plan is about, performed on the plan. (I did exactly that on the first pass.)
  // `skills:check` carries three because it is an AGGREGATE of six terminal commands: the
  // three that certify a Category-B artifact are pilled, the other three are exempt by
  // exact command. Contracting the script name alone let one pill account for all six.
  const byScript = new Map();
  for (const c of loadContracts()) {
    if (!byScript.has(c.script)) byScript.set(c.script, []);
    byScript.get(c.script).push(c.id);
  }
  const exempt = loadExemptions();
  for (const [script, ids] of Object.entries(MANDATORY)) {
    assert.ok(byScript.has(script), `${script} is mandated by docs/plans/green-but-unrealized.md §2 dec. 3`);
    assert.deepEqual(byScript.get(script).sort(), [...ids].sort(), `${script}: contracted gate ids changed`);
    assert.ok(!Object.hasOwn(exempt, script), `${script} must not be BOTH contracted and exempt`);
  }
});

test('every pill is shaped so it can actually fail, and its fixtures exist', () => {
  const contracts = loadContracts();
  assert.ok(contracts.length >= Object.keys(MANDATORY).length, 'sanity: the mandatory set at minimum');
  for (const c of contracts) {
    const p = c.poisonPill;
    assert.equal(p.isolation, 'tmpdir', `${c.file}: outputs must be isolated, not just inputs`);
    const tampers = Object.keys(p.overlay ?? {}).length + Object.keys(p.mutate ?? {}).length;
    assert.ok(tampers > 0, `${c.file}: a pill with nothing to tamper with hands the gate a pristine artifact`);
    assert.ok(p.expectStderr, `${c.file}: exit code alone cannot distinguish detection from a crash`);
    assert.ok(p.why, `${c.file}: record WHICH false-green this pill reproduces`);
    for (const fixture of Object.values(p.overlay ?? {})) {
      assert.ok(fs.existsSync(path.join(REPO_ROOT, fixture)), `${c.file}: fixture missing: ${fixture}`);
    }
  }
});

test('contracts go through the SHARED schema — a malformed one throws, never loads half', () => {
  // The rejected design was a private parser here plus the real one in
  // check-gate-contracts.mjs: two validators, one name, guaranteed to drift.
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'bogus.json'), JSON.stringify({ version: 1, gate: 'x' }));
  assert.throws(() => loadContracts(dir, REPO_ROOT), /invalid CLI gate contract/);
});

test('gates:poison is wired into the check chain — an uninvoked gate protects nothing', () => {
  assert.match(pkg.scripts.check, /gates:poison/,
    'the manifest gate was correct and simply never called; that is the precedent here');
  assert.ok(pkg.scripts['gates:poison'], 'the script must exist');
});
