/**
 * @fileoverview Guards the contract that makes `/cycle`'s per-cluster audit
 * actually scoped.
 *
 * Plan: docs/plans/cycle-cluster-audit-scope.md.
 *
 * The defect (measured 2026-08-13): Step 3C told the agent to pass the cluster's
 * derived scope as `--changed`, which is the R2+ impact set and does NOT bound
 * what the model reads. `--scope=diff` therefore recomputed the file set from the
 * working tree — on a tree shared with a concurrent session, 52 files reached the
 * prompt against 11 declared, and 26 of 31 findings concerned untouched code.
 * The failure was silent and read as thoroughness.
 *
 * Two halves, because either alone leaves a hole:
 *   (a) the PREMISE — `--files` beats `--scope` and suppresses the recompute;
 *   (b) the RECIPE  — Step 3C's executable block actually passes `--files`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveEffectiveScope } from '../scripts/lib/audit-scope.mjs';
import { collectReconciliationSet, admissionPreflight, commaUnsafe } from '../scripts/cycle-cluster-scope.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SKILL = path.join(REPO_ROOT, 'skills', 'cycle', 'SKILL.md');
const SCOPE_CLI = path.join(REPO_ROOT, 'scripts', 'cycle-cluster-scope.mjs');
const OPEN_MARK = '<!-- cycle:cluster-audit-command -->';
const CLOSE_MARK = '<!-- /cycle:cluster-audit-command -->';

/** Exclusion stub — the resolver takes it injected, so no glob dep is needed. */
const excludeStub = (files, patterns) => files.filter(f => !patterns.includes(f));

describe('KD-4a — resolveEffectiveScope: the premise the recipe rests on', () => {
  it('an explicit allowlist WINS over scopeMode:diff and suppresses the recompute', () => {
    // If this inverts, /cycle's per-cluster audit silently widens again.
    const r = resolveEffectiveScope({ fileFilter: ['a.mjs'], scopeMode: 'diff' });
    assert.equal(r.source, 'allowlist');
    assert.deepEqual(r.files, ['a.mjs']);
  });

  it('exclusions still apply to an allowlist', () => {
    const r = resolveEffectiveScope({
      fileFilter: ['a.mjs', 'b.mjs'], scopeMode: 'diff',
      excludePatterns: ['b.mjs'], applyExclusions: excludeStub,
    });
    assert.deepEqual(r.files, ['a.mjs']);
  });

  it('an allowlist emptied by exclusions stays `allowlist` — it does NOT fall back', () => {
    // Degrading to a working-tree recompute here would resurrect the defect.
    const r = resolveEffectiveScope({
      fileFilter: ['b.mjs'], scopeMode: 'diff',
      excludePatterns: ['b.mjs'], applyExclusions: excludeStub,
    });
    assert.equal(r.source, 'allowlist');
    assert.deepEqual(r.files, []);
  });

  it('no allowlist + diff → diff-recompute; + plan/full → none', () => {
    assert.equal(resolveEffectiveScope({ fileFilter: null, scopeMode: 'diff' }).source, 'diff-recompute');
    assert.equal(resolveEffectiveScope({ fileFilter: null, scopeMode: 'plan' }).source, 'none');
    assert.equal(resolveEffectiveScope({ fileFilter: [], scopeMode: 'full' }).source, 'none');
  });

  it('de-duplicates while preserving first-seen order', () => {
    assert.deepEqual(resolveEffectiveScope({ fileFilter: ['b', 'a', 'b'], scopeMode: 'diff' }).files, ['b', 'a']);
  });

  it('is pure — no fs, no git, no cwd dependence', () => {
    const prev = process.cwd();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-pure-'));
    try {
      process.chdir(tmp);
      assert.deepEqual(resolveEffectiveScope({ fileFilter: ['nope/missing.mjs'], scopeMode: 'diff' }).files,
        ['nope/missing.mjs']);
    } finally {
      process.chdir(prev);
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('openai-audit.mjs uses the resolver and keeps no inline copy of the branch', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'openai-audit.mjs'), 'utf8');
    assert.match(src, /resolveEffectiveScope\s*\(/);
    assert.doesNotMatch(src, /if\s*\(!effectiveFileFilter\s*&&\s*scopeMode === 'diff'\)/,
      'the inline precedence branch was reintroduced — the resolver is no longer authoritative');
  });
});

describe('KD-1b — the CLI refusal hint names the flag that can actually fix scope', () => {
  it('auditSubjectFileGuard sends the operator to --files, never --changed', async () => {
    const { auditSubjectFileGuard } = await import('../scripts/lib/audit-scope.mjs');
    for (const hasFileFilter of [true, false]) {
      const msg = auditSubjectFileGuard({ scopeMode: 'diff', subjectFileCount: 0, hasFileFilter });
      assert.match(msg, /--files/);
      assert.doesNotMatch(msg, /Pass `--changed/,
        'the remediation hint names the R2+ impact flag, which cannot fix a scope problem');
    }
  });
});

describe('KD-2/KD-3 — cycle-cluster-scope over real git repos', () => {
  /** Build a throwaway repo; returns {dir, base}. Real git, not canned strings. */
  const makeRepo = (setup) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cycle-scope-'));
    const g = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    g(['init', '-q', '.']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
    fs.mkdirSync(path.join(dir, 's'), { recursive: true });
    fs.writeFileSync(path.join(dir, 's', 'keep.mjs'), 'a\n');
    fs.writeFileSync(path.join(dir, 's', 'old.mjs'), 'b\n');
    g(['add', '-A']); g(['commit', '-qm', 'base']);
    const base = g(['rev-parse', 'HEAD']).trim();
    setup(dir, g);
    return { dir, base, g };
  };
  const runCli = (dir, base, scopePaths) => {
    // The scope file lives OUTSIDE the fixture repo: written inside it, it would
    // itself be an untracked change and show up as an out-of-scope edit, so every
    // assertion about outOfScope would be measuring the test's own litter.
    const scopeFile = path.join(os.tmpdir(), `cycle-scope-${path.basename(dir)}.txt`);
    fs.writeFileSync(scopeFile, `${scopePaths.join('\n')}\n`);
    try {
      const out = execFileSync(process.execPath,
        [SCOPE_CLI, '--base', base, '--scope-file', scopeFile, '--json'],
        { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
      return { status: 0, json: JSON.parse(out), stderr: '' };
    } catch (e) {
      const raw = e.stdout ?? '';
      return { status: e.status ?? -1, json: raw.trim() ? JSON.parse(raw) : null, stderr: e.stderr ?? '' };
    }
  };
  const cleanup = dir => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

  it('a RENAME out of scope is caught — both operands are in the reconciliation set', () => {
    // The regression that motivated the rewrite: `--name-only` emitted only the
    // NEW path, so a file renamed out of a cluster escaped the fail-closed check.
    const { dir, base } = makeRepo((d, g) => g(['mv', 's/old.mjs', 's/new.mjs']));
    try {
      const r = runCli(dir, base, ['s/new.mjs']);
      assert.equal(r.status, 1);
      assert.ok(r.json.outOfScope.includes('s/old.mjs'),
        'the rename OLD path must appear in the reconciliation set');
      assert.ok(!r.json.files.includes('s/old.mjs'),
        'the rename OLD path must NOT be in the on-disk allowlist');
    } finally { cleanup(dir); }
  });

  it('a DELETE outside scope fails closed, and is absent from the allowlist', () => {
    const { dir, base } = makeRepo(d => fs.rmSync(path.join(d, 's', 'old.mjs'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
    try {
      const r = runCli(dir, base, ['s/keep.mjs']);
      assert.equal(r.status, 1);
      assert.ok(r.json.outOfScope.includes('s/old.mjs'));
      assert.ok(!r.json.files.includes('s/old.mjs'));
    } finally { cleanup(dir); }
  });

  it('an UNTRACKED file outside scope fails closed', () => {
    const { dir, base } = makeRepo(d => fs.writeFileSync(path.join(d, 's', 'stray.mjs'), 'x\n'));
    try {
      const r = runCli(dir, base, ['s/keep.mjs']);
      assert.equal(r.status, 1);
      assert.ok(r.json.outOfScope.includes('s/stray.mjs'));
    } finally { cleanup(dir); }
  });

  it('a path containing a SPACE survives round-trip (argv marshalling, not shell)', () => {
    const { dir, base } = makeRepo((d, g) => {
      fs.writeFileSync(path.join(d, 's', 'has space.mjs'), 'x\n');
      g(['add', '-A']); g(['commit', '-qm', 'spaced']);
    });
    try {
      const r = runCli(dir, base, ['s/has space.mjs']);
      assert.deepEqual(r.json.files, ['s/has space.mjs']);
      assert.equal(r.json.outOfScope.length, 0);
    } finally { cleanup(dir); }
  });

  it('a COMMA-bearing path stops the run rather than splitting the allowlist', () => {
    const { dir, base } = makeRepo((d, g) => {
      fs.writeFileSync(path.join(d, 's', 'a,b.mjs'), 'x\n');
      g(['add', '-A']); g(['commit', '-qm', 'comma']);
    });
    try {
      const r = runCli(dir, base, ['s/a,b.mjs']);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /comma-unsafe/);
    } finally { cleanup(dir); }
    assert.deepEqual(commaUnsafe(['ok.mjs', 'a,b.mjs']), ['a,b.mjs']);
  });

  it('a DELETION-ONLY cluster reports emptyAllowlist rather than a vacuous pass', () => {
    const { dir, base } = makeRepo(d => fs.rmSync(path.join(d, 's', 'old.mjs'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
    try {
      const r = runCli(dir, base, ['s/old.mjs']);
      assert.equal(r.json.emptyAllowlist, true);
      assert.deepEqual(r.json.files, []);
    } finally { cleanup(dir); }
  });

  it('a mutable base that has left history is refused, not silently widened', () => {
    const { dir } = makeRepo(() => {});
    try {
      const r = runCli(dir, '0000000000000000000000000000000000000000', ['s/keep.mjs']);
      assert.equal(r.status, 2);
    } finally { cleanup(dir); }
  });

  it('admissionPreflight uses the REAL isAuditInfraFile, not a restatement', () => {
    const rows = admissionPreflight(['scripts/lib/schemas.mjs', 'scripts/foo.mjs'], { exists: () => true });
    const infra = rows.find(r => r.path === 'scripts/lib/schemas.mjs');
    assert.equal(infra.reason, 'infra-requires-allow-flag');
    assert.equal(rows.find(r => r.path === 'scripts/foo.mjs').reason, null);
  });

  it('reconciliation parsing stays in sync across a rename (status-aware records)', () => {
    // A fixed-pair parser desynchronises on the first R record and mis-attributes
    // every later path. Assert a rename followed by another change stays correct.
    const { dir, base } = makeRepo((d, g) => {
      g(['mv', 's/old.mjs', 's/new.mjs']);
      fs.appendFileSync(path.join(d, 's', 'keep.mjs'), 'more\n');
    });
    try {
      const set = collectReconciliationSet(base, dir);
      for (const p of ['s/old.mjs', 's/new.mjs', 's/keep.mjs']) {
        assert.ok(set.all.includes(p), `${p} missing — record parsing desynchronised`);
      }
    } finally { cleanup(dir); }
  });
});

describe('KD-4b — Step 3C\'s executable block really passes --files', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  const start = skill.indexOf(OPEN_MARK);
  const end = skill.indexOf(CLOSE_MARK);
  const block = start >= 0 && end > start ? skill.slice(start + OPEN_MARK.length, end) : '';

  it('the delimited block exists and is non-empty (vacuous-pass guard)', () => {
    // Without this, indexOf returning -1 and a slice of nothing would let every
    // assertion below pass over an empty string.
    assert.ok(start >= 0, `missing ${OPEN_MARK} in skills/cycle/SKILL.md`);
    assert.ok(end > start, `missing or misordered ${CLOSE_MARK}`);
    assert.ok(block.trim().length > 100, 'the canonical command block is suspiciously short');
  });

  it('the audit INVOCATION carries --files — not merely the surrounding prose', () => {
    const invocation = block.split('\n').find(l => l.includes('openai-audit.mjs code'));
    assert.ok(invocation, 'no openai-audit invocation inside the delimited block');
    const cmd = block.slice(block.indexOf(invocation));
    assert.match(cmd, /--files\s+"?\$/, 'the invocation must pass --files a variable');
  });

  it('--files and --changed receive the SAME scope variable', () => {
    // A token check alone would pass on `--files "$PLAN"`: flag present, scoping
    // still wrong. Assert the data flow, which is the actual contract.
    const filesVar = block.match(/--files\s+"?(\$\{?\w+\}?)"?/)?.[1];
    const changedVar = block.match(/--changed\s+"?(\$\{?\w+\}?)"?/)?.[1];
    assert.ok(filesVar, 'could not read the --files argument');
    assert.equal(filesVar, changedVar, '--files and --changed must carry the same derived scope');
    assert.doesNotMatch(filesVar, /PLAN/, '--files must receive the scope, not the plan path');
  });

  it('the block calls cycle-cluster-scope.mjs before auditing', () => {
    const scopeIdx = block.indexOf('cycle-cluster-scope.mjs');
    const auditIdx = block.indexOf('openai-audit.mjs');
    assert.ok(scopeIdx >= 0, 'the deterministic pre-flight is not invoked');
    assert.ok(scopeIdx < auditIdx, 'the pre-flight must run BEFORE the audit spends');
  });

  it('reads the canonical source, never the generated .claude/ copy', () => {
    // The RELATIVE form is load-bearing, not stylistic. This repo's linked
    // worktrees live under `.claude/worktrees/<name>/`, so an ABSOLUTE path
    // carries `.claude/` from the checkout's own location — a
    // `doesNotMatch(/\.claude\//)` on it passed in the primary tree and failed in
    // every worktree, on the canonical file it was meant to accept. The invariant
    // is about where the file sits INSIDE the repo, which is what path.relative()
    // expresses and what the absolute path cannot.
    const rel = path.relative(REPO_ROOT, SKILL).replace(/\\/g, '/');
    assert.equal(rel, 'skills/cycle/SKILL.md',
      'SKILL must resolve to the canonical source, not the generated .claude/ copy');
  });

  it('does NOT present --changed as the scoping mechanism', () => {
    assert.match(block, /--changed\s*:.*(does NOT scope|reopen)/i,
      'the block must state what --changed actually does');
  });
});

describe('audit-found regressions — delete lifecycle and the shared extension policy', () => {
  const makeRepo = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cycle-del-'));
    const g = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    g(['init', '-q', '.']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
    fs.mkdirSync(path.join(dir, 's'), { recursive: true });
    fs.writeFileSync(path.join(dir, 's', 'keep.mjs'), 'a\n');
    fs.writeFileSync(path.join(dir, 's', 'doomed.mjs'), 'b\n');
    g(['add', '-A']); g(['commit', '-qm', 'base']);
    return { dir, base: g(['rev-parse', 'HEAD']).trim() };
  };
  const run = (dir, base, paths) => {
    const sf = path.join(os.tmpdir(), `cd-${path.basename(dir)}.txt`);
    fs.writeFileSync(sf, `${paths.join('\n')}\n`);
    try {
      return { status: 0, json: JSON.parse(execFileSync(process.execPath,
        [SCOPE_CLI, '--base', base, '--scope-file', sf, '--json'],
        { cwd: dir, encoding: 'utf8', stdio: 'pipe' })), stderr: '' };
    } catch (e) {
      return { status: e.status ?? -1, json: e.stdout?.trim() ? JSON.parse(e.stdout) : null, stderr: e.stderr ?? '' };
    }
  };
  const clean = d => fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

  it('a cluster that DELETES a file it declared is allowed to proceed', () => {
    // The contradiction the code audit found: a plan intent-tagging a file
    // `(delete)` MUST declare it (ownership), but it is gone from disk by
    // admission time. Rejecting it made a legitimate delete cluster unrunnable.
    const { dir, base } = makeRepo();
    try {
      fs.rmSync(path.join(dir, 's', 'doomed.mjs'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      const r = run(dir, base, ['s/keep.mjs', 's/doomed.mjs']);
      assert.equal(r.status, 0, `a declared delete must not be fatal: ${r.stderr}`);
      assert.deepEqual(r.json.files, ['s/keep.mjs'], 'the deleted path must not be in the allowlist');
      assert.equal(r.json.admissions.find(a => a.path === 's/doomed.mjs').reason, 'removed-by-this-cluster');
    } finally { clean(dir); }
  });

  it('an UNEXPLAINED absent path is still fatal (the typo case)', () => {
    // The mirror direction: relaxing the delete case must not make every absent
    // path acceptable, or a typo'd scope entry silently shrinks the audit.
    const { dir, base } = makeRepo();
    try {
      const r = run(dir, base, ['s/keep.mjs', 's/never-existed.mjs']);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /not-on-disk/);
    } finally { clean(dir); }
  });

  it('the extension policy is the SHARED constant, dot-normalised', () => {
    // Importing PLAN_REFERENCE_EXTENSIONS removed a duplicated policy, but that
    // constant stores 'mjs' while path.extname() returns '.mjs' — comparing them
    // raw rejected every file as 'extension'. Assert a real .mjs is admitted.
    const rows = admissionPreflight(['s/x.mjs', 's/y.bin'], { exists: () => true });
    assert.equal(rows.find(r => r.path === 's/x.mjs').admitted, true);
    assert.equal(rows.find(r => r.path === 's/y.bin').reason, 'extension');
  });
});
