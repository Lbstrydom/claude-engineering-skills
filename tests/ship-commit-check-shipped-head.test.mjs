/**
 * @fileoverview `ship-commit.mjs --check-shipped-head` against REAL git (docs/plans/coordinator-aggregate-ship.md section 2.3).
 *
 * Each case builds a throwaway repository with a base, an audited branch and a ship commit carrying real trailers, writes the two
 * local markers the check binds to, and runs `checkShippedHead` with a stub store (the store is the only thing not real here; the
 * store-off boundary is exercised through the real CLI at the end). The cases that matter most are the ones a line-by-line
 * reading of the algorithm would not find: a change reverted to base after the audit, a dirty-tree audit, a rebase that brings
 * in upstream-only changes, and path names that a pathspec would misread.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkShippedHead, parseNameStatusZ, parseTrailerLines, SHIPPED_HEAD_SCHEMA } from '../scripts/lib/ship-shipped-head.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN = '981fc79a-0fbb-447a-a294-b0c0217dab71';
const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });

const PLAN = ['# Plan: X', '- **Status**: Draft', '', '## Context', 'body', '', '## Phase 1', 'work', ''].join('\n');

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}
const write = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
const commit = (cwd, msg) => { git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '-m', msg); return git(cwd, 'rev-parse', 'HEAD'); };

/** A repo with a base on `origin/main` (a local ref faking the remote) and a feature branch checked out. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipped-head-'));
  tmpDirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T'], ['core.autocrlf', 'false'], ['commit.gpgsign', 'false']]) git(dir, 'config', k, v);
  write(dir, 'scripts/a.mjs', 'export const a = 1;\n');
  write(dir, 'scripts/other.mjs', 'export const o = 1;\n');
  write(dir, 'docs/plans/x.md', PLAN);
  write(dir, '.gitignore', '.audit/\n');
  const base = commit(dir, 'base');
  git(dir, 'update-ref', 'refs/remotes/origin/main', base);
  git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git(dir, 'checkout', '-q', '-b', 'claude/x');
  return { dir, base };
}

const TRAILERS = (over = {}) => {
  const t = { 'AI-Skill': 'ship', 'AI-Models': 'claude,gpt', 'AI-Gate': 'converged', 'AI-Run-ID': RUN, 'AI-Final-Review': 'approve', 'AI-Ship-Authority': 'launch-prompt', ...over };
  return Object.entries(t).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`).join('\n');
};

/** The ship step: a status entry plus the plan's Status and Implementation Log. */
function shipDocs(dir) {
  write(dir, 'docs/status/entries/2026-11-18-070000-ship-x.md', '## Ship x\nshipped\n');
  const plan = fs.readFileSync(path.join(dir, 'docs/plans/x.md'), 'utf8');
  write(dir, 'docs/plans/x.md', `${plan.replace('Draft', 'Implemented')}\n## Implementation Log\n- shipped\n`);
}

function writeMarkers(dir, { auditedTree, auditedSha, branch = 'claude/x', fr = {} } = {}) {
  write(dir, '.audit/last-audit-run.json', JSON.stringify({ runId: RUN, ts: new Date(Date.now() + 60_000).toISOString(), auditedTree, auditedSha, auditedBranch: branch, round: 4 }));
  write(dir, '.audit/last-final-review.json', JSON.stringify({ runId: RUN, auditedTree, round: 4, verdict: 'APPROVE', disposition: 'approve', ts: new Date().toISOString(), ...fr }));
}

const store = (over = {}) => ({
  runFacts: async () => ({ row: { repoId: 'r1', roundConvergedAfter: 4, auditedSha: null, auditedTree: over.auditedTree ?? null, geminiVerdict: 'APPROVE', branch: 'claude/x', ...over.row }, why: null }),
  repoId: async () => ({ repoId: 'r1', why: null }),
});

/**
 * The standard member: audited work in scripts/a.mjs, then a ship commit adding only ship docs.
 * `afterAudit(dir)` runs BETWEEN the audit and the ship commit (the place a post-audit change would hide).
 */
async function member({ afterAudit, trailers, fr, auditedTreeOverride, mutateMarkers, storeOver } = {}) {
  const { dir, base } = makeRepo();
  write(dir, 'scripts/a.mjs', 'export const a = 2; // audited\n');
  const auditedSha = commit(dir, 'audited work');
  const auditedTree = git(dir, 'rev-parse', 'HEAD^{tree}');
  if (afterAudit) afterAudit(dir);
  shipDocs(dir);
  const head = commit(dir, `ship x\n\n${trailers ?? TRAILERS()}`);
  writeMarkers(dir, { auditedTree: auditedTreeOverride ?? auditedTree, auditedSha, fr });
  if (mutateMarkers) mutateMarkers(dir);
  const env = await checkShippedHead({ repoRoot: dir, head, store: store({ auditedTree, ...storeOver }) });
  return { dir, head, env, auditedSha, auditedTree, base };
}
const failing = (env) => env.conditions.filter((c) => !c.ok).map((c) => c.id);
const reason = (env, id) => env.conditions.find((c) => c.id === id)?.reason ?? '';

describe('parseTrailerLines / parseNameStatusZ (pure)', () => {
  it('splits trailers at the first colon', () => {
    assert.deepEqual(parseTrailerLines('AI-Gate: converged\nAI-Models: a,b: c\n'), [{ key: 'AI-Gate', value: 'converged' }, { key: 'AI-Models', value: 'a,b: c' }]);
  });
  it('parses NUL-delimited name-status, keeping a name with a newline whole', () => {
    assert.deepEqual(parseNameStatusZ('M\0a\nb.txt\0A\0c.txt\0'), [{ status: 'M', rel: 'a\nb.txt' }, { status: 'A', rel: 'c.txt' }]);
  });
  it('an odd token count is malformed (null), never a short list', () => {
    assert.equal(parseNameStatusZ('M\0a.txt\0A\0'), null);
  });
});

describe('--check-shipped-head against real git: the member that should ship', () => {
  it('a branch whose ship commit adds only ship docs is ship-ok on every row', async () => {
    const { env } = await member();
    assert.equal(env.schema, SHIPPED_HEAD_SCHEMA);
    assert.equal(env.ok, true, env.refusals.join('\n'));
    assert.equal(env.gate, 'converged');
    assert.equal(env.runId, RUN);
    assert.match(reason(env, 'post-audit-delta'), /ship-step edit/);
  });
  it('a plan the branch ALREADY changed before the audit still takes a ship-only edit (the ambiguous case)', async () => {
    const { dir, base } = makeRepo();
    write(dir, 'docs/plans/x.md', PLAN.replace('body', 'body, edited before the audit'));
    const auditedSha = commit(dir, 'audited work incl. plan edit');
    const auditedTree = git(dir, 'rev-parse', 'HEAD^{tree}');
    shipDocs(dir);
    const head = commit(dir, `ship x\n\n${TRAILERS()}`);
    writeMarkers(dir, { auditedTree, auditedSha });
    const env = await checkShippedHead({ repoRoot: dir, head, store: store({ auditedTree }) });
    assert.equal(env.ok, true, env.refusals.join('\n'));
    assert.ok(base);
  });
  it('a rebase onto upstream-only changes does not read as a post-audit change', async () => {
    const { dir } = makeRepo();
    git(dir, 'checkout', '-q', 'main');
    write(dir, 'scripts/other.mjs', 'export const o = 2; // upstream\n');
    const newBase = commit(dir, 'upstream change');
    git(dir, 'update-ref', 'refs/remotes/origin/main', newBase);
    git(dir, 'checkout', '-q', 'claude/x');
    write(dir, 'scripts/a.mjs', 'export const a = 2; // audited\n');
    const auditedSha = commit(dir, 'audited work');
    const auditedTree = git(dir, 'rev-parse', 'HEAD^{tree}');
    git(dir, 'rebase', '-q', 'origin/main'); // picks up scripts/other.mjs: the head tree now differs from the audited tree there
    shipDocs(dir);
    const head = commit(dir, `ship x\n\n${TRAILERS()}`);
    writeMarkers(dir, { auditedTree, auditedSha });
    const env = await checkShippedHead({ repoRoot: dir, head, store: store({ auditedTree }) });
    assert.equal(env.ok, true, env.refusals.join('\n'));
  });
});

describe('--check-shipped-head: AI-Gate honesty at the git boundary', () => {
  for (const gate of ['waived', 'not-run']) {
    it(`a ${gate} member is refused`, async () => {
      const { env } = await member({ trailers: TRAILERS({ 'AI-Gate': gate }) });
      assert.equal(env.ok, false);
      assert.deepEqual(failing(env), ['trailers']);
    });
  }
  it('trailers typed INLINE in the body (not the last paragraph) are not trailers', async () => {
    const msg = `ship x\n\n${TRAILERS()}\n\nA trailing paragraph that pushes the block out of last place.`;
    const { env } = await member({ trailers: msg.slice(msg.indexOf('AI-Skill')) });
    assert.equal(env.ok, false);
    assert.ok(failing(env).includes('trailers'), 'a block that is not the last paragraph must refuse');
  });
  it('a forged gate with a store row that never converged is refused by the evidence row', async () => {
    const { env } = await member({ storeOver: { row: { roundConvergedAfter: null } } });
    assert.deepEqual(failing(env), ['evidence']);
  });
});

describe('--check-shipped-head: what changed after the audit', () => {
  it('a code change after the audit refuses, naming the path', async () => {
    const { env } = await member({ afterAudit: (d) => { write(d, 'scripts/other.mjs', 'export const o = 99; // sneaked in\n'); commit(d, 'late fix'); } });
    assert.deepEqual(failing(env), ['post-audit-delta']);
    assert.match(reason(env, 'post-audit-delta'), /scripts\/other\.mjs/);
  });
  it('an audited change REVERTED TO BASE after the audit is still inspected (it left the head change set, not the audited one)', async () => {
    const { env } = await member({ afterAudit: (d) => { write(d, 'scripts/a.mjs', 'export const a = 1;\n'); commit(d, 'revert to base'); } });
    assert.deepEqual(failing(env), ['post-audit-delta']);
    assert.match(reason(env, 'post-audit-delta'), /scripts\/a\.mjs/);
  });
  it('a DIRTY-TREE audit (a change in the audited tree that no commit holds) reverted before shipping is inspected', async () => {
    const { dir } = makeRepo();
    write(dir, 'scripts/a.mjs', 'export const a = 2; // audited\n');
    const auditedSha = commit(dir, 'audited work');
    write(dir, 'scripts/other.mjs', 'export const o = 7; // uncommitted at audit time\n');
    git(dir, 'add', '-A');
    const auditedTree = git(dir, 'write-tree'); // the tree the audit read: HEAD plus the uncommitted change
    git(dir, 'reset', '-q', '--hard', 'HEAD'); // the change is dropped before the ship
    shipDocs(dir);
    const head = commit(dir, `ship x\n\n${TRAILERS()}`);
    writeMarkers(dir, { auditedTree, auditedSha });
    const env = await checkShippedHead({ repoRoot: dir, head, store: store({ auditedTree }) });
    assert.deepEqual(failing(env), ['post-audit-delta']);
    assert.match(reason(env, 'post-audit-delta'), /scripts\/other\.mjs/);
  });
  // Names a Windows filesystem cannot hold (`*`, `:`, a newline) are put straight into git's index with plumbing, so the fixture
  // does not depend on the OS being able to create them: git stores them happily, and the check must read them literally.
  const plumb = (dir, rel, text) => {
    const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: text, encoding: 'utf-8', windowsHide: true }).stdout.trim();
    git(dir, 'update-index', '--add', '--cacheinfo', `100644,${blob},${rel}`);
  };
  /** Commit EXACTLY the index plus the named worktree paths (never `add -A`, which would stage the plumbing-only names as deleted). */
  const commitIndex = (dir, msg, ...worktreePaths) => { if (worktreePaths.length) git(dir, 'add', '--', ...worktreePaths); git(dir, 'commit', '-q', '-m', msg); return git(dir, 'rev-parse', 'HEAD'); };
  for (const [label, name] of [
    ['brackets and a glob star', 'src/*[a1].js'],
    ['a pathspec-magic prefix', ':(exclude)x.js'],
    ['a newline', 'weird\nname.txt'],
    ['a plain glob that would match a sibling', 'src/a[1].js'],
    ['a negated class and braces', 'src/[!x]{a,b}.js'],
  ]) {
    it(`a path named with ${label} is matched literally: changed after the audit it is REFUSED, never skipped`, async (t) => {
      const { dir } = makeRepo();
      // Git for Windows refuses some names even in the index (protectNTFS): that platform cannot hold the case, so it is skipped, not passed.
      try { plumb(dir, name, 'x\n'); } catch (e) { if (/Invalid path/.test(String(e.message))) { t.skip('this platform cannot store that path name'); return; } throw e; }
      plumb(dir, 'src/a1.js', 'sibling the glob would also match\n');
      const auditedSha = commitIndex(dir, 'audited work with odd names');
      const auditedTree = git(dir, 'rev-parse', 'HEAD^{tree}');
      plumb(dir, name, 'changed after the audit\n');
      write(dir, 'docs/plans/x.md', `${PLAN.replace('Draft', 'Implemented')}\n## Implementation Log\n- shipped\n`);
      write(dir, 'docs/status/entries/2026-11-18-070000-ship-x.md', '## Ship x\nshipped\n');
      const head = commitIndex(dir, `ship x\n\n${TRAILERS()}`, 'docs');
      writeMarkers(dir, { auditedTree, auditedSha });
      const env = await checkShippedHead({ repoRoot: dir, head, store: store({ auditedTree }) });
      assert.deepEqual(failing(env), ['post-audit-delta'], env.refusals.join(' | '));
      assert.ok(reason(env, 'post-audit-delta').includes(name.split('\n')[0]), `the refusal must name the path: ${reason(env, 'post-audit-delta')}`);
    });
  }
  it('a delete after the audit refuses', async () => {
    const { env } = await member({ afterAudit: (d) => { fs.rmSync(path.join(d, 'scripts/other.mjs')); commit(d, 'delete'); } });
    assert.deepEqual(failing(env), ['post-audit-delta']);
  });
  it('a plan body edit after the audit refuses', async () => {
    const { env } = await member({ afterAudit: (d) => { write(d, 'docs/plans/x.md', PLAN.replace('work', 'different work')); commit(d, 'plan body'); } });
    assert.deepEqual(failing(env), ['post-audit-delta']);
    assert.match(reason(env, 'post-audit-delta'), /docs\/plans\/x\.md/);
  });
  it('an audited tree that is not in the repository refuses (audited-tree-missing), it does not pass vacuously', async () => {
    const { env } = await member({ auditedTreeOverride: '0'.repeat(40) });
    assert.ok(failing(env).includes('post-audit-delta'));
    assert.match(reason(env, 'post-audit-delta'), /audited-tree-missing/);
  });
});

describe('--check-shipped-head: evidence and final review live in the member worktree', () => {
  it('a missing evidence marker is evidence-unavailable (a gone worktree fails closed)', async () => {
    const { env } = await member({ mutateMarkers: (d) => fs.rmSync(path.join(d, '.audit/last-audit-run.json')) });
    assert.ok(failing(env).includes('evidence'));
    assert.match(reason(env, 'evidence'), /evidence-unavailable|no usable/);
  });
  it('a missing final-review marker refuses the final-review row', async () => {
    const { env } = await member({ mutateMarkers: (d) => fs.rmSync(path.join(d, '.audit/last-final-review.json')) });
    assert.deepEqual(failing(env), ['final-review']);
  });
  it('a final review for another round refuses', async () => {
    const { env } = await member({ fr: { round: 2 } });
    assert.deepEqual(failing(env), ['final-review']);
  });
  it('a final review that is APPROVE-with-debt refuses', async () => {
    const { env } = await member({ fr: { verdict: 'CONCERNS', disposition: 'approve_with_debt' } });
    assert.deepEqual(failing(env), ['final-review']);
  });
  it('evidence audited on another branch refuses', async () => {
    const { env } = await member({ mutateMarkers: (d) => { const f = path.join(d, '.audit/last-audit-run.json'); const m = JSON.parse(fs.readFileSync(f, 'utf8')); m.auditedBranch = 'claude/other'; fs.writeFileSync(f, JSON.stringify(m)); } });
    assert.ok(failing(env).includes('evidence'));
  });
});

describe('--check-shipped-head: head identity and paths', () => {
  it('a --head that is not the checked-out commit refuses before anything is trusted', async () => {
    const { dir, base } = await member();
    const env = await checkShippedHead({ repoRoot: dir, head: base, store: store() });
    assert.equal(env.ok, false);
    assert.deepEqual(failing(env), ['head']);
    assert.match(reason(env, 'head'), /checked out/);
  });
  it('an unknown oid refuses', async () => {
    const { dir } = await member();
    const env = await checkShippedHead({ repoRoot: dir, head: 'deadbeef'.repeat(5), store: store() });
    assert.deepEqual(failing(env), ['head']);
  });
  it('a migration or policy file in the change set refuses its own row', async () => {
    const { env } = await member({ afterAudit: (d) => { write(d, 'supabase/migrations/20261118_x.sql', 'select 1;\n'); write(d, '.github/workflows/ci.yml', 'name: x\n'); commit(d, 'late files'); } });
    assert.ok(failing(env).includes('migration'));
    assert.ok(failing(env).includes('repo-policy'));
    assert.ok(failing(env).includes('post-audit-delta'));
  });
});

describe('--check-shipped-head: the real CLI boundary (store off)', () => {
  let m;
  before(async () => { m = await member(); });
  const run = (args, cwd) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ship-commit.mjs'), ...args], {
    cwd, encoding: 'utf-8', windowsHide: true,
    // An EMPTY DSN is the air-gap signal: the store is off whatever ~/.audit-loop.env says.
    env: { ...process.env, AUDIT_DB_URL: '', AUDIT_DB_TEST_URL: '', LEARNING_DISABLE: '1', AZURE_OPENAI_ENDPOINT: '' },
  });
  it('prints exactly one v1 JSON envelope and exits 2: with the store off the evidence row refuses, with its reason', () => {
    const r = run(['--check-shipped-head', '--head', m.head, '--json'], m.dir);
    assert.equal(r.status, 2, r.stderr);
    const env = JSON.parse(r.stdout);
    assert.equal(env.schema, SHIPPED_HEAD_SCHEMA);
    assert.equal(env.head, m.head);
    assert.equal(env.ok, false);
    assert.match(env.conditions.find((c) => c.id === 'evidence').reason, /store|cloud|audit_runs/);
  });
  it('a missing --head is a correctable argument error (exit 2), not a pass', () => {
    const r = run(['--check-shipped-head', '--json'], m.dir);
    assert.equal(r.status, 2);
    assert.equal(JSON.parse(r.stdout).ok, false);
  });
  it('cannot be combined with commit arguments', () => {
    const r = run(['--check-shipped-head', '--head', m.head, '--gate', 'converged'], m.dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot be combined/);
  });
  it('outside a git worktree it errors with exit 1', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'not-git-'));
    tmpDirs.push(d);
    const r = run(['--check-shipped-head', '--head', m.head], d);
    assert.equal(r.status, 1);
  });
});
