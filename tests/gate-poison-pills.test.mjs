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
import { execFileSync } from 'node:child_process';

import os from 'node:os';

import { EventEmitter } from 'node:events';

import {
  extractCheckGates, loadContracts, loadExemptions, reconcile, runPill,
  runPillsInParallel, resolveConcurrency, _internals,
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
  // Added 2026-09-04 (docs/plans/backlog-and-drift-reduction.md Phase 12).
  // Post-cutoff, so this entry is the deliberate, reviewer-visible decision the
  // ratchet demands. The gate CANNOT be pilled, structurally: the pill harness
  // requires a PASSING control run inside a fresh single-commit tmpdir, and a
  // repo whose only commit IS the current state has no prior state to conserve —
  // so the gate correctly reports CANNOT VERIFY and exits 2. Making that control
  // pass would mean returning 'conserved' from an empty baseline, which is the
  // exact vacuous pass this gate exists to eliminate (and which it briefly had,
  // during development, before being fixed to fail closed). Its negative evidence
  // is executable and lives in tests/check-status-log-integrity.test.mjs — a PR #87
  // replay, a gutted-body case, a tampered archive, the manifest-deletion bypass,
  // and both CLI exit codes.
  'status:integrity:gate',
  'arch:coverage-gate', 'cli:flags:gate', 'db:check-rls:gate', 'db:suites:gate',
  'docs:check', 'docs:refs:gate', 'efficacy:check', 'gates:poison', 'knip:gate',
  'node scripts/check-gate-contracts.mjs', 'node scripts/check-skill-refs.mjs',
  // RE-KEYED, not new (2026-08-13, cross-agent-delivery-parity Cluster B): the same
  // gate gained `--source-surfaces`, which added a categorical rule that
  // `.github/copilot-instructions.md` must not exist in this repo. The command string
  // changed, so the ratchet correctly saw an unrecognised key and demanded a pill.
  //
  // It still cannot be pilled, and the reason is verified against the runner rather
  // than inherited from the old entry's prose: BOTH tamper mechanisms require the
  // destination to already exist — `overlay` rejects a missing dest outright
  // ("the fixture would be an orphan the gate never reads") and `applyMutation`
  // returns "destination does not exist — nothing to tamper with". Every rule this
  // command enforces is an ABSENCE, so the tamper is file/directory CREATION, which
  // neither mechanism can express. Covered instead by tests/stale-skill-surface.test.mjs,
  // which exercises the rule in all three directions — present+flag fails, absent
  // passes, and the two boundary cases (consumer-scoped `--repo`, and a bare
  // relocated-copy invocation) pass with the file present.
  'node scripts/check-stale-skill-surface.mjs --gate --source-surfaces',
  'npm-args:gate', 'on-conflict:check', 'plans:lint', 'plans:status', 'test',
  // NEW gate, deliberately exempted (2026-08-23, consumer-friction-doctor round-6
  // audit H7): cross-checks the upstream disposition ledger against the LIVE
  // upstream_issues terminal-row inventory. Same DB-fixture limitation as
  // efficacy:check/db:check-rls:gate above — the poison-pill tmpdir isolation has
  // no AUDIT_DB_URL, so a control run and a tampered-ledger poison run would
  // identically no-op there (upstreamReconcile returns {ok:true, reconciliation:null}
  // on cloud-off), proving nothing about the gate's real divergence-detection logic.
  // A pill would need a seeded, disposable Postgres instance inside the sandbox,
  // which check-gate-poison-pills.mjs does not provide. Negative evidence instead:
  // tests/upstream-reconcile-gate.test.mjs drives upstreamCmd directly with an
  // injected listTerminalUpstreamIssues (no real DB needed) and asserts --gate
  // throws on all four divergence types plus the migration catch-all sentinel, does
  // NOT throw on a clean match or without --gate, and (round-6 H6) visibly warns
  // rather than reading as clean when cloud is off under --gate.
  'node scripts/cross-skill.mjs upstream reconcile --gate --worksheet',
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
  // The entry is `{reason, gateAddedAt, gateAddedAtSource}` since 2026-08-09
  // (adjudicated D3/D6) — the bare string became an object so the ratchet has a
  // date to key on. The property under test is unchanged: a real justification.
  for (const [gate, entry] of Object.entries(loadExemptions())) {
    const { reason } = entry;
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

test('a needsGit fixture is NOT poisoned by a leaked GIT_DIR/GIT_INDEX_FILE (git-hook environment)', () => {
  // git's own hook-invocation machinery exports GIT_DIR/GIT_INDEX_FILE/etc into
  // a pre-push hook's process (githooks(5)) so hook-run git commands resolve
  // the REAL repo. A spawnSync('git', ..., {cwd: work}) that inherits
  // process.env unfiltered gives GIT_DIR precedence over cwd, so the
  // "isolated" fixture's `git init`/`git commit` silently redirects at
  // whatever repo GIT_DIR names instead of the disposable one. The resulting
  // symptom under a real push — `Unable to create '.../index.lock': File
  // exists` — reads exactly like contention with another concurrent process
  // and is easy to misdiagnose as transient rather than as this leak (found
  // live: pushing this very fix hit it twice in a row from a linked worktree
  // before the cause was traced here).
  //
  // The "outer repo" the leak points at is a THROWAWAY tmpdir repo, never
  // this checkout's own .git — deliberately, so this test cannot collide with
  // a real concurrent git operation on the checkout it runs inside of (this
  // repo is routinely worked on from several linked worktrees at once).
  const outerRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'leaked-outer-repo-'));
  const g = (args) => execFileSync('git', args, { cwd: outerRepo, encoding: 'utf-8' });
  g(['init', '-q']);
  g(['config', 'user.email', 'outer@example.com']);
  g(['config', 'user.name', 'outer']);
  fs.writeFileSync(path.join(outerRepo, 'seed.txt'), 'x\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'seed']);
  const outerGitDir = g(['rev-parse', '--git-dir']).trim();
  const absOuterGitDir = path.isAbsolute(outerGitDir) ? outerGitDir : path.resolve(outerRepo, outerGitDir);
  // Simulate "another git process (the outer `git push` itself) currently
  // holds this repo's index" — the exact collision that produced the live
  // failure — entirely within the disposable outer repo, never the real one.
  const outerLock = path.join(absOuterGitDir, 'index.lock');
  fs.writeFileSync(outerLock, '');

  const prevGitDir = process.env.GIT_DIR;
  const prevIndexFile = process.env.GIT_INDEX_FILE;
  process.env.GIT_DIR = absOuterGitDir;
  process.env.GIT_INDEX_FILE = path.join(absOuterGitDir, 'index');
  try {
    // `needsGit` must be flattened onto the TOP-level contract object — the
    // shape `loadContracts()` produces (`{script, file, id, poisonPill,
    // needsGit}`, see extractCheckGates' neighbour around line 122) — not
    // left nested inside `poisonPill`, or `runPill`'s `if (contract.needsGit)`
    // never fires and this test passes vacuously regardless of the fix.
    const r = runPill({
      script: 'plans:index:check',
      needsGit: true,
      poisonPill: {
        isolation: 'tmpdir',
        argv: ['scripts/generate-plans-index.mjs', '--check'],
        overlay: { 'docs/plans/README.md': 'tests/fixtures/poison/plans-index-tampered.md' },
        expectExit: 1,
        expectStderr: 'stale',
      },
    }, { repoRoot: REPO_ROOT });
    assert.doesNotMatch(r.problems.join(' '), /could not create the isolated git fixture/,
      "a leaked GIT_DIR/GIT_INDEX_FILE must not redirect the fixture's git init at the leaked repo");
  } finally {
    if (prevGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prevGitDir;
    if (prevIndexFile === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = prevIndexFile;
    fs.rmSync(outerRepo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
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
    'skills-check-detects-over-budget-description',
    // Added 2026-09-03: a known frontmatter key indented under `description: |`
    // is description text — parsed, valid, inert. Pill is the real consumer file.
    'skills-check-detects-indented-frontmatter-key',
  ],
  'plans:index:check': ['plans-index-check-compares-rendered-content'],
  'requirements:map:check': ['requirements-map-check-compares-rendered-content'],
  'parity:check-coupling': ['parity-coupling-rejects-new-schema-qualification'],
  'context:check': ['context-check-rejects-missing-agents-import'],
  // Added 2026-08-02 when the architecture-intent drift gate finally landed on main
  // (it sat unmerged on a branch for 110 commits). A gate added after 2026-07-31 must
  // carry a pill, never an exemption — §2 dec. 3.
  'docs:architecture-intent:check': ['architecture-intent-check-detects-an-undocumented-domain'],
  // Added 2026-08-11 with the gate itself. Post-2026-07-31, so a pill is
  // mandatory and an exemption would not have been available — correctly, since
  // the whole point of this gate is that a check nobody can see fail is
  // indistinguishable from no check at all.
  'db:enrolment:gate': ['db-enrolment-gate-detects-a-suite-no-runner-names'],
  // Added 2026-09-04 with the three gates themselves (docs/plans/backlog-and-drift-reduction.md).
  // All post-2026-07-31, so each carries a pill rather than an exemption. Each pill
  // tampers with a real artifact, because the failure every one of them guards is
  // SILENT: an oversized file creeping back, a private path ignored with nowhere
  // durable to live, and a session log that shrank without anyone measuring it.
  'size:ratchet:gate': ['size-ratchet-rejects-growth-past-the-baseline'],
  'gitignore:policy:gate': ['gitignore-policy-rejects-undeclared-rules'],
  // Added 2026-08-12 with the emit() exit-code coupling (cross-skill-command-
  // registry §2b F4). Post-2026-07-31, so a pill is mandatory. The gate does not
  // re-check the runtime coupling — that is one seam, owned by
  // tests/emit-exit-coupling.test.mjs — it ratchets the population of DECLARED
  // opt-outs, which is the part no runtime test can see because each opt-out is
  // individually legitimate API.
  'emit:exit:gate': ['emit-exit-gate-detects-a-new-declared-opt-out'],
  // Added 2026-08-13 with the gate itself. Post-2026-07-31, so a pill is
  // mandatory. The class it closes has now shipped four times — the instruction
  // reaches a consumer and the tool it names does not — and the worktree
  // variant is the silent one: the SKILL.md is copied into the worktree while
  // the gitignored tooling tree is not, so the skill reads as fully installed.
  'worktree:preflight:gate': ['worktree-preflight-rejects-skill-without-marker'],
  // Added with the gate itself (consumer-friction-doctor plan §2.4). Post-
  // 2026-07-31, so a pill is mandatory. Closes the ratchet's own silent-drift
  // hole: a ledger entry citing a probe id that has since been renamed or
  // retired parses as valid JSON and would otherwise report clean.
  'upstream:coverage:gate': ['upstream-coverage-gate-detects-an-unresolvable-probe-disposition'],
  // Added 2026-09-02 with the gate itself. Post-2026-07-31, so a pill is
  // mandatory. Sibling to worktree:preflight:gate above and the same defect
  // class one step further out: that one catches a remedy a linked WORKTREE
  // cannot reach, this one a pointer a CONSUMER REPO cannot reach. The sync
  // never merges npm scripts and ships one docs/ file, so an `npm run X` or a
  // `docs/plans/y.md` in synced skill text is unresolvable there — and reads
  // as perfectly ordinary here, which is why it has shipped four times.
  'skills:consumer-refs:gate': ['skills-consumer-refs-gate-rejects-an-undeclared-unreachable-pointer'],
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

// ── Parallel execution (2026-08-11) ─────────────────────────────────────────
//
// The pills moved from a `for` loop around a synchronous `runPill` to a bounded
// pool of forked workers — 53.2s → 24.7s, measured, on a 32-core box. Speed is
// only acceptable if nothing about the gate's honesty moved with it, so what
// these pin is the three properties parallelism is capable of quietly costing:
// deterministic ordering, no silently-dropped worker, and a real IPC round trip.

/**
 * A `fork`-shaped stub whose Nth call plays the Nth scripted behaviour.
 *
 * Deliberately NOT a stub of `runPill`: what is under test is the parent's
 * handling of a child process it cannot see inside — including the cases where
 * the child never speaks. A stub at the runPill seam would make every worker
 * well-behaved by construction, which is the one assumption these tests exist to
 * refuse.
 */
function scriptedFork(behaviours) {
  let call = 0;
  const spawned = [];
  const forkFn = () => {
    const behaviour = behaviours[call++];
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.send = () => { setTimeout(() => behaviour(child), behaviour.delayMs ?? 0); };
    spawned.push(child);
    return child;
  };
  forkFn.spawned = spawned;
  return forkFn;
}

const contract = (id) => ({ script: `gate:${id}`, id, poisonPill: { isolation: 'tmpdir', argv: [] } });
const replies = (problems, delayMs) => Object.assign(
  (child) => { child.emit('message', { ok: !problems.length, problems }); child.emit('exit', 0, null); },
  { delayMs },
);

test('parallel: output order follows CONTRACT order, not completion order', async () => {
  // A report that reorders run-to-run cannot be diffed, and an operator learns
  // to skim it. The first contract is made the SLOWEST so a naive
  // append-on-completion implementation produces the reverse and fails here.
  const contracts = [contract('a'), contract('b'), contract('c')];
  const forkFn = scriptedFork([
    replies(['a-problem'], 30),
    replies(['b-problem'], 15),
    replies(['c-problem'], 0),
  ]);

  const problems = await runPillsInParallel(contracts, { concurrency: 3, fork: forkFn });
  assert.deepEqual(problems, ['a-problem', 'b-problem', 'c-problem']);
});

test('parallel: a worker that exits WITHOUT a result fails the gate', async () => {
  // The silently-dropped worker: the pill never ran, and an empty slot is
  // indistinguishable from a clean one. That is this file's own subject — a
  // green produced by not checking — performed by the runner instead of a gate.
  const forkFn = scriptedFork([
    (child) => { child.stderr.emit('data', 'ENOMEM: out of memory'); child.emit('exit', 7, null); },
  ]);

  const problems = await runPillsInParallel([contract('a')], { concurrency: 1, fork: forkFn });
  assert.equal(problems.length, 1, 'a dead worker must not read as a passing pill');
  assert.match(problems[0], /gate:a/);
  assert.match(problems[0], /exited without a result \(exit 7\)/);
  assert.match(problems[0], /ENOMEM/, 'its stderr is the only diagnosis available — surface it');
});

test('parallel: a worker killed by a SIGNAL fails the gate, and says so', async () => {
  const forkFn = scriptedFork([(child) => { child.emit('exit', null, 'SIGKILL'); }]);
  const problems = await runPillsInParallel([contract('a')], { concurrency: 1, fork: forkFn });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /signal SIGKILL/);
});

test('parallel: a spawn `error` event fails the gate', async () => {
  const forkFn = scriptedFork([(child) => { child.emit('error', new Error('EAGAIN')); }]);
  const problems = await runPillsInParallel([contract('a')], { concurrency: 1, fork: forkFn });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /pill worker error — EAGAIN/);
});

test('parallel: a fork that THROWS synchronously fails the gate', async () => {
  const forkFn = () => { throw new Error('EMFILE: too many open files'); };
  const problems = await runPillsInParallel([contract('a')], { concurrency: 1, fork: forkFn });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /could not spawn a pill worker — EMFILE/);
});

test('parallel: one dead worker does not mask its healthy neighbours\' findings', async () => {
  const forkFn = scriptedFork([
    replies(['real-finding']),
    (child) => { child.emit('exit', 1, null); },
    replies([]),
  ]);
  const problems = await runPillsInParallel(
    [contract('a'), contract('b'), contract('c')], { concurrency: 3, fork: forkFn },
  );
  assert.equal(problems[0], 'real-finding');
  assert.match(problems[1], /gate:b/);
  assert.equal(problems.length, 2, 'the clean third pill contributes nothing, as before');
});

test('parallel: a clean run produces NO problems — the pool cannot manufacture one', async () => {
  const forkFn = scriptedFork([replies([]), replies([]), replies([])]);
  const problems = await runPillsInParallel(
    [contract('a'), contract('b'), contract('c')], { concurrency: 2, fork: forkFn },
  );
  assert.deepEqual(problems, []);
});

test('parallel: every contract is spawned exactly once, even below the concurrency cap', async () => {
  const forkFn = scriptedFork([replies([]), replies([]), replies([]), replies([]), replies([])]);
  await runPillsInParallel(
    ['a', 'b', 'c', 'd', 'e'].map(contract), { concurrency: 2, fork: forkFn },
  );
  assert.equal(forkFn.spawned.length, 5, 'a pill the pool never started is a gate that never ran');
});

test('the real fork path round-trips a result over IPC', async () => {
  // The stubbed tests above prove the parent's logic; this proves the CHANNEL —
  // that a worker process really loads the module, runs the pill, and gets its
  // verdict back. Uses the non-tmpdir refusal, which `runPill` answers without
  // copying the repo, so the round trip costs one process rather than 5 seconds.
  const problems = await runPillsInParallel(
    [{ script: 'gate:real', id: 'real', poisonPill: { isolation: 'flag', argv: [] } }],
    { concurrency: 1 },
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /isolation must be "tmpdir"/,
    'the worker\'s own verdict must cross the boundary — not a crash the parent inferred');
});

test('concurrency leaves headroom, never exceeds the work, and never hits zero', () => {
  assert.equal(resolveConcurrency(10, {}, 32), 10, 'capped by the pill count');
  assert.equal(resolveConcurrency(40, {}, 32), 30, 'cpus - 2, leaving the parent and the OS room');
  assert.equal(resolveConcurrency(10, {}, 2), 1, 'a 2-core box still makes progress');
  assert.equal(resolveConcurrency(0, {}, 32), 1, 'no pills must not mean a zero-worker pool');
});

test('GATES_POISON_CONCURRENCY=1 restores serial execution for debugging', () => {
  // Measured: serial-through-fork is 52.4s against the pre-change 53.2s, so this
  // reproduces the old timing as well as the old interleaving — which is what
  // makes it usable for bisecting a misbehaving pill.
  assert.equal(resolveConcurrency(10, { GATES_POISON_CONCURRENCY: '1' }, 32), 1);
  assert.equal(resolveConcurrency(10, { GATES_POISON_CONCURRENCY: '4' }, 32), 4);
  for (const junk of ['0', '-3', 'abc', '']) {
    assert.equal(resolveConcurrency(10, { GATES_POISON_CONCURRENCY: junk }, 32), 10,
      `"${junk}" is not a concurrency — fall back to the default, never to zero workers`);
  }
});

// ── findNodeModules — the worktree dependency-resolution fix (2026-08-08) ────
//
// The harness used to link `path.join(repoRoot, 'node_modules')` unconditionally.
// A git worktree has no node_modules of its own, so that path did not exist —
// and on Windows a junction to a MISSING target succeeds, leaving a dangling
// link. The try/catch therefore never fired; the only symptom was the CONTROL
// run failing with a bare `Cannot find package 'zod'`, which reads as a defect
// in the gate under test rather than in the harness feeding it.
//
// Resolving upward mirrors Node's own algorithm, so the isolated copy resolves
// dependencies exactly as the checkout it was copied from — no hand-linking
// node_modules into every worktree.

test('findNodeModules — finds an ANCESTOR node_modules (the worktree case)', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  const nested = path.join(root, 'sub', 'worktree');
  fs.mkdirSync(nested, { recursive: true });

  assert.equal(_internals.findNodeModules(nested), path.join(root, 'node_modules'));
});

test('findNodeModules — prefers the NEAREST node_modules, not the farthest', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  const near = path.join(root, 'inner');
  fs.mkdirSync(path.join(near, 'node_modules'), { recursive: true });

  assert.equal(_internals.findNodeModules(near), path.join(near, 'node_modules'));
});

test('findNodeModules — a DANGLING node_modules link reads as absent and the walk continues', () => {
  // The precise shape of the bug: a link that exists as a directory entry but
  // resolves to nothing. It must not be accepted as a usable node_modules.
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  const inner = path.join(root, 'inner');
  fs.mkdirSync(inner, { recursive: true });
  try {
    fs.symlinkSync(path.join(root, 'no-such-target'), path.join(inner, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    return; // platform refuses dangling links — nothing to prove here
  }
  assert.equal(fs.existsSync(path.join(inner, 'node_modules')), false, 'precondition: link is dangling');

  assert.equal(_internals.findNodeModules(inner), path.join(root, 'node_modules'),
    'must skip the dangling link and keep walking up');
});
