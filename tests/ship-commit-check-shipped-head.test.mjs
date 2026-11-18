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
import { checkShippedHead as checkReal, parseRawZ, parseTrailerLines, isPlainBranch, SHIPPED_HEAD_SCHEMA } from '../scripts/lib/ship-shipped-head.mjs';

/** Every check that is not ABOUT the live base runs OFFLINE, explicitly (the default verifies the live base against the remote). */
const checkShippedHead = (o) => checkReal({ verifyBase: false, ...o });
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN = '981fc79a-0fbb-447a-a294-b0c0217dab71';
const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

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

describe('parseTrailerLines / parseRawZ (pure)', () => {
  it('splits trailers at the first colon', () => {
    assert.deepEqual(parseTrailerLines('AI-Gate: converged\nAI-Models: a,b: c\n'), [{ key: 'AI-Gate', value: 'converged' }, { key: 'AI-Models', value: 'a,b: c' }]);
  });
  const H1 = 'a'.repeat(40); const H2 = 'b'.repeat(40);
  it('parses NUL-delimited raw records with their modes, keeping a name with a newline whole', () => {
    assert.deepEqual(parseRawZ(`:100644 100644 ${H1} ${H2} M\0a\nb.txt\0:000000 120000 ${'0'.repeat(40)} ${H2} A\0c.txt\0`), [
      { status: 'M', rel: 'a\nb.txt', oldMode: '100644', newMode: '100644' },
      { status: 'A', rel: 'c.txt', oldMode: '000000', newMode: '120000' },
    ]);
  });
  it('a record with no path, or a token that is not a header, is malformed (null), never a short list', () => {
    assert.equal(parseRawZ(`:100644 100644 ${H1} ${H2} M\0`), null);
    assert.equal(parseRawZ('M\0a.txt\0'), null);
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
    const { env } = await member({ afterAudit: (d) => { fs.rmSync(path.join(d, 'scripts/other.mjs'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); commit(d, 'delete'); } });
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
    const { env } = await member({ mutateMarkers: (d) => fs.rmSync(path.join(d, '.audit/last-audit-run.json'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) });
    assert.ok(failing(env).includes('evidence'));
    assert.match(reason(env, 'evidence'), /evidence-unavailable|no usable/);
  });
  it('a missing final-review marker refuses the final-review row', async () => {
    const { env } = await member({ mutateMarkers: (d) => fs.rmSync(path.join(d, '.audit/last-final-review.json'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) });
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
    env: { ...process.env, AUDIT_DB_URL: '', LEARNING_DISABLE: '1', AZURE_OPENAI_ENDPOINT: '' },
  });
  it('prints exactly one v1 JSON envelope and exits 2: with the store off the evidence row refuses, with its reason', () => {
    const r = run(['--check-shipped-head', '--head', m.head, '--offline', '--json'], m.dir);
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
  it('an unexpected FIRST argument is refused, with and without --base (the value-skipping must not swallow index 0)', () => {
    for (const args of [['stray', '--check-shipped-head', '--head', m.head, '--json'], ['--check-shipped-head', '--head', m.head, 'stray', '--json'], ['stray', '--check-shipped-head', '--head', m.head, '--base', 'main', '--json']]) {
      const r = run(args, m.dir);
      assert.equal(r.status, 2, `${args.join(' ')} => ${r.stdout}${r.stderr}`);
      assert.match(JSON.parse(r.stdout).refusals.join(' '), /cannot be combined with stray/);
    }
  });
  it('a branch name with characters git allows but a narrow allowlist would not (release/v1+hotfix) is accepted; a git-illegal one is refused', () => {
    for (const ok of ['release/v1+hotfix', 'feature/a_b', 'v2.0']) assert.equal(isPlainBranch(ok), true, ok);
    for (const bad of ['', 'a..b', 'a b', '-x', 'a/', 'a.lock', 'a@{b', 'a~b', 'a:b', 'a//b', '@']) assert.equal(isPlainBranch(bad), false, JSON.stringify(bad));
  });
  it('a malformed --base or --remote is refused by name', () => {
    assert.equal(run(['--check-shipped-head', '--head', m.head, '--base', '../x', '--json'], m.dir).status, 2);
    assert.equal(run(['--check-shipped-head', '--head', m.head, '--remote', '--json'], m.dir).status, 2);
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

describe('--check-shipped-head: a PR into a NON-default branch (code-audit round 3)', () => {
  it('is measured against the branch it targets: a policy file that develop already carries is not the member\'s change', async () => {
    const { dir } = makeRepo();
    // origin/develop = main + a commit that touches a policy file (the member did NOT make this change).
    git(dir, 'checkout', '-q', '-b', 'develop');
    write(dir, '.github/workflows/ci.yml', 'name: ci\n');
    const dev = commit(dir, 'develop: ci');
    git(dir, 'update-ref', 'refs/remotes/origin/develop', dev);
    git(dir, 'checkout', '-q', '-b', 'claude/y');
    write(dir, 'scripts/a.mjs', 'export const a = 3; // audited\n');
    const auditedSha = commit(dir, 'audited work');
    const auditedTree = git(dir, 'rev-parse', 'HEAD^{tree}');
    shipDocs(dir);
    const head = commit(dir, `ship y\n\n${TRAILERS()}`);
    writeMarkers(dir, { auditedTree, auditedSha, branch: 'claude/y' });
    const against = (baseBranch) => checkShippedHead({ repoRoot: dir, head, baseBranch, store: store({ auditedTree, row: { branch: 'claude/y' } }) });
    const wrong = await against(null); // origin/HEAD names main: develop's policy file reads as this member's change
    assert.ok(failing(wrong).includes('repo-policy'), 'measured against main it WOULD refuse: the instrument sees the file');
    const right = await against('develop');
    assert.equal(right.ok, true, right.refusals.join(' | '));
  });
});

describe('--check-shipped-head: the LIVE base (code-audit round 5)', () => {
  /** A member whose `origin` is a real bare repository, so `ls-remote` has something to answer. */
  async function withRemote() {
    const { dir } = makeRepo();
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'bare-'));
    tmpDirs.push(bare);
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { encoding: 'utf-8' });
    git(dir, 'remote', 'add', 'origin', bare);
    git(dir, 'push', '-q', 'origin', 'main');
    git(dir, 'fetch', '-q', 'origin');
    write(dir, 'scripts/a.mjs', 'export const a = 5; // audited\n');
    const auditedSha = commit(dir, 'audited work');
    const auditedTree = git(dir, 'rev-parse', 'HEAD^{tree}');
    shipDocs(dir);
    const head = commit(dir, `ship w\n\n${TRAILERS()}`);
    writeMarkers(dir, { auditedTree, auditedSha });
    return { dir, bare, head, auditedTree };
  }
  it('a local origin/main equal to the live branch is checked normally (the control)', async () => {
    const { dir, head, auditedTree } = await withRemote();
    const env = await checkReal({ repoRoot: dir, head, baseBranch: 'main', remote: 'origin', store: store({ auditedTree }) });
    assert.equal(env.ok, true, env.refusals.join(' | '));
  });
  it('a STALE local origin/main (the live branch moved) is refused before anything is measured against it', async () => {
    const { dir, bare, head, auditedTree } = await withRemote();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'other-'));
    tmpDirs.push(other);
    spawnSync('git', ['clone', '-q', bare, other], { encoding: 'utf-8' });
    for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) git(other, 'config', k, v);
    write(other, 'landed.txt', 'someone landed this\n');
    commit(other, 'someone else landed');
    git(other, 'push', '-q', 'origin', 'main');
    const env = await checkReal({ repoRoot: dir, head, baseBranch: 'main', remote: 'origin', store: store({ auditedTree }) });
    assert.equal(env.ok, false);
    assert.deepEqual(failing(env), ['base']);
    assert.match(reason(env, 'base'), /fetch first/);
  });
  it('an unreachable remote is a refusal, never a pass', async () => {
    const { dir, head, auditedTree } = await withRemote();
    git(dir, 'remote', 'set-url', 'origin', path.join(os.tmpdir(), 'no-such-remote-dir'));
    const env = await checkReal({ repoRoot: dir, head, baseBranch: 'main', remote: 'origin', store: store({ auditedTree }) });
    assert.deepEqual(failing(env), ['base']);
    assert.match(reason(env, 'base'), /could not be read/);
  });
  it('with verifyBase:false (the CLI\'s --offline) the live branch is not consulted, and the envelope says so', async () => {
    const { dir, head, auditedTree } = await withRemote();
    git(dir, 'remote', 'set-url', 'origin', path.join(os.tmpdir(), 'no-such-remote-dir'));
    const env = await checkReal({ repoRoot: dir, head, baseBranch: 'main', remote: 'origin', verifyBase: false, store: store({ auditedTree }) });
    assert.equal(env.ok, true, env.refusals.join(' | '));
    assert.equal(env.baseVerified, false);
  });
  it('by DEFAULT the live base is verified, with no --base named: the branch <remote>/HEAD names', async () => {
    const { dir, head, auditedTree } = await withRemote();
    const env = await checkReal({ repoRoot: dir, head, store: store({ auditedTree }) });
    assert.equal(env.ok, true, env.refusals.join(' | '));
    assert.equal(env.baseVerified, true);
  });
  it('no --base and no <remote>/HEAD: the default branch cannot be determined, so it refuses and asks for --base', async () => {
    const { dir, head, auditedTree } = await withRemote();
    git(dir, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    const env = await checkReal({ repoRoot: dir, head, store: store({ auditedTree }) });
    assert.deepEqual(failing(env), ['base']);
    assert.match(reason(env, 'base'), /pass --base/);
  });
  it('a base that moves WHILE the check runs is refused (measured against two bases)', async () => {
    const { dir, head, auditedTree } = await withRemote();
    const racy = store({ auditedTree });
    const real = racy.runFacts;
    racy.runFacts = async (id) => { const other = git(dir, 'commit-tree', '-m', 'moved', `${git(dir, 'rev-parse', 'origin/main')}^{tree}`); git(dir, 'update-ref', 'refs/remotes/origin/main', other); return real(id); };
    const env = await checkReal({ repoRoot: dir, head, store: racy });
    assert.deepEqual(failing(env), ['base']);
    assert.match(reason(env, 'base'), /moved while the check was running/);
  });
});

describe('--check-shipped-head: a destination remote that is not origin (code-audit round 4)', () => {
  it('measures against <remote>/<branch>: the same member ships against upstream/develop with origin/* refs ABSENT', async () => {
    const { dir } = makeRepo();
    git(dir, 'checkout', '-q', '-b', 'develop');
    write(dir, '.github/workflows/ci.yml', 'name: ci\n');
    const dev = commit(dir, 'develop: ci');
    git(dir, 'update-ref', 'refs/remotes/upstream/develop', dev);
    for (const ref of ['refs/remotes/origin/main']) git(dir, 'update-ref', '-d', ref);
    git(dir, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    git(dir, 'checkout', '-q', '-b', 'claude/z');
    write(dir, 'scripts/a.mjs', 'export const a = 4; // audited\n');
    const auditedSha = commit(dir, 'audited work');
    const auditedTree = git(dir, 'rev-parse', 'HEAD^{tree}');
    shipDocs(dir);
    const head = commit(dir, `ship z\n\n${TRAILERS()}`);
    writeMarkers(dir, { auditedTree, auditedSha, branch: 'claude/z' });
    const against = (remote) => checkShippedHead({ repoRoot: dir, head, baseBranch: 'develop', remote, store: store({ auditedTree, row: { branch: 'claude/z' } }) });
    const wrong = await against('origin'); // there is no origin/develop here: the instrument must say so, not guess
    assert.equal(wrong.ok, false, 'a base that cannot be resolved is a refusal, never a pass');
    const right = await against('upstream');
    assert.equal(right.ok, true, right.refusals.join(' | '));
  });
});

describe('--check-shipped-head: modes, submodule config and the head race (code-audit round 1)', () => {
  const plumbMode = (dir, rel, mode, text) => {
    const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: text, encoding: 'utf-8', windowsHide: true }).stdout.trim();
    git(dir, 'update-index', '--add', '--cacheinfo', `${mode},${blob},${rel}`);
  };
  const shipWith = async (mutate, { config = [] } = {}) => {
    const { dir } = makeRepo();
    for (const [k, v] of config) git(dir, 'config', k, v);
    write(dir, 'scripts/a.mjs', 'export const a = 2; // audited\n');
    const auditedSha = commit(dir, 'audited work');
    const auditedTree = git(dir, 'rev-parse', 'HEAD^{tree}');
    mutate(dir);
    write(dir, 'docs/plans/x.md', `${PLAN.replace('Draft', 'Implemented')}\n## Implementation Log\n- shipped\n`);
    git(dir, 'add', 'docs/plans'); // NOT docs/: that would stage the plumbing-only entries as deleted
    git(dir, 'commit', '-q', '-m', `ship x\n\n${TRAILERS()}`);
    const head = git(dir, 'rev-parse', 'HEAD');
    writeMarkers(dir, { auditedTree, auditedSha });
    return { dir, env: await checkShippedHead({ repoRoot: dir, head, store: store({ auditedTree }) }) };
  };

  it('a status entry named like an entry but stored as a SYMLINK is not a status entry: refused', async () => {
    const { env } = await shipWith((d) => { plumbMode(d, 'docs/status/entries/2026-11-18-070000-ship-x.md', '120000', '../../../.env'); });
    assert.deepEqual(failing(env), ['post-audit-delta'], env.refusals.join(' | '));
    assert.match(reason(env, 'post-audit-delta'), /not a regular file \(mode 120000\)/);
  });

  it('the same entry as a REGULAR file passes (the control for the symlink case)', async () => {
    const { env } = await shipWith((d) => { plumbMode(d, 'docs/status/entries/2026-11-18-070000-ship-x.md', '100644', '## Ship x\nshipped\n'); });
    assert.equal(env.ok, true, env.refusals.join(' | '));
  });

  it('a GITLINK added after the audit is refused even when the repository config says to ignore submodules', async () => {
    const { env } = await shipWith((d) => { plumbMode(d, 'vendor/sub', '160000', ''); git(d, 'update-index', '--cacheinfo', `160000,${'a'.repeat(40)},vendor/sub`); }, { config: [['diff.ignoreSubmodules', 'all']] });
    assert.ok(failing(env).includes('post-audit-delta'), env.refusals.join(' | '));
    assert.match(reason(env, 'post-audit-delta'), /vendor\/sub/);
  });

  it('a HEAD that moves while the check runs is refused: nothing it read describes the head that was asked about', async () => {
    const { dir } = makeRepo();
    write(dir, 'scripts/a.mjs', 'export const a = 2; // audited\n');
    const auditedSha = commit(dir, 'audited work');
    const auditedTree = git(dir, 'rev-parse', 'HEAD^{tree}');
    shipDocs(dir);
    const head = commit(dir, `ship x\n\n${TRAILERS()}`);
    writeMarkers(dir, { auditedTree, auditedSha });
    // A store whose read moves HEAD: the worktree switches commits in the middle of the check.
    const racy = store({ auditedTree });
    const realFacts = racy.runFacts;
    racy.runFacts = async (id) => { write(dir, 'later.txt', 'x\n'); commit(dir, 'a later commit'); return realFacts(id); };
    const env = await checkShippedHead({ repoRoot: dir, head, store: racy });
    assert.equal(env.ok, false);
    assert.deepEqual(failing(env), ['head']);
    assert.match(reason(env, 'head'), /moved while the check was running/);
  });
});

describe('--check-shipped-head: the CLI verifies the live base unless told --offline', () => {
  it('--verify-base is no longer a flag: it is refused by name (the default IS verification)', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ship-commit.mjs'), '--check-shipped-head', '--head', 'a'.repeat(40), '--verify-base', '--json'], { encoding: 'utf-8', windowsHide: true });
    assert.equal(r.status, 2, r.stderr);
    assert.match(JSON.parse(r.stdout).refusals.join(' '), /unknown flag/);
  });
});

describe('storyline incidents 2026-11-18 (the tree, not the sha)', () => {
  it('(1) a branch REBUILT by a range cherry-pick that silently dropped its first commit is refused, though every remaining commit is intact', async () => {
    const { dir } = makeRepo();
    write(dir, 'scripts/first.mjs', 'export const first = 1;\n');
    commit(dir, 'first commit');
    write(dir, 'scripts/a.mjs', 'export const a = 2; // audited\n');
    const auditedSha = commit(dir, 'second commit');
    const auditedTree = git(dir, 'rev-parse', 'HEAD^{tree}');
    // The rebuild: back to the base, re-pick only the second commit (the first is gone), then ship.
    git(dir, 'reset', '-q', '--hard', 'refs/remotes/origin/main');
    git(dir, 'cherry-pick', auditedSha);
    shipDocs(dir);
    const head = commit(dir, `ship x\n\n${TRAILERS()}`);
    writeMarkers(dir, { auditedTree, auditedSha });
    const env = await checkShippedHead({ repoRoot: dir, head, store: store({ auditedTree }) });
    assert.deepEqual(failing(env), ['post-audit-delta'], env.refusals.join(' | '));
    assert.match(reason(env, 'post-audit-delta'), /scripts\/first\.mjs/);
  });
  it('a ship-doc delta passes as a named POLICY exception ("ship-step edit"), never as tree equality', async () => {
    const { env } = await member();
    assert.match(reason(env, 'post-audit-delta'), /ship-step edit/);
  });
});

describe('--check-shipped-head: the dispatcher and the runner (PR A audit round 1)', () => {
  it('--check-shipped-head after the -- terminator, or as the VALUE of an option, is not a mode switch', async () => {
    const { isShippedHeadMode } = await import('../scripts/lib/ship-shipped-head.mjs');
    const values = ['--message-file', '--skill'];
    assert.equal(isShippedHeadMode(['--check-shipped-head', '--head', 'abc'], values), true);
    assert.equal(isShippedHeadMode(['--', '--check-shipped-head'], values), false, 'after the terminator it is an operand');
    assert.equal(isShippedHeadMode(['--message-file', '--check-shipped-head'], values), false, 'it is the VALUE of --message-file');
    assert.equal(isShippedHeadMode(['--gate', 'passed'], values), false);
  });
  it('the real ship-commit CLI treats `--message-file --check-shipped-head` as a commit invocation, not the checker', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ship-commit.mjs'), '--message-file', '--check-shipped-head'], { encoding: 'utf-8', windowsHide: true });
    assert.doesNotMatch(r.stdout + r.stderr, /shipped-head\/v1/);
  });
  it('the git runner sanitizes the environment and bounds every call, ls-remote included; a timeout is reported, not swallowed', async () => {
    const { makeRunner, GIT_TIMEOUT_MS, LS_REMOTE_TIMEOUT_MS } = await import('../scripts/lib/ship-shipped-head.mjs');
    const seen = [];
    const spawn = (cmd, args, o) => { seen.push({ args, o }); return { status: null, error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' }; };
    const before = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(os.tmpdir(), 'somewhere-else');
    try {
      const run = makeRunner(ROOT, { spawn });
      const r = run(['ls-remote', 'origin', 'refs/heads/main']);
      run(['rev-parse', 'HEAD']);
      assert.equal(r.timedOut, true);
      assert.equal(r.status, null);
      assert.equal(seen[0].o.timeout, LS_REMOTE_TIMEOUT_MS);
      assert.equal(seen[1].o.timeout, GIT_TIMEOUT_MS);
      assert.equal(Object.keys(seen[0].o.env).some((k) => k.toUpperCase() === 'GIT_DIR'), false, 'an inherited GIT_DIR must not reach git');
    } finally { if (before === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = before; }
  });
  it('an equal-tree head reports "equals" (the delta is empty), independently of the ship-doc case', async () => {
    const { dir } = makeRepo();
    write(dir, 'scripts/a.mjs', 'export const a = 2; // audited\n');
    const auditedSha = commit(dir, 'audited work');
    const auditedTree = git(dir, 'rev-parse', 'HEAD^{tree}');
    git(dir, 'commit', '-q', '--allow-empty', '-m', `ship x\n\n${TRAILERS()}`);
    const head = git(dir, 'rev-parse', 'HEAD');
    writeMarkers(dir, { auditedTree, auditedSha });
    const env = await checkShippedHead({ repoRoot: dir, head, store: store({ auditedTree }) });
    assert.equal(env.ok, true, env.refusals.join(' | '));
    assert.match(reason(env, 'post-audit-delta'), /equals the audited tree/);
  });
});

describe('--check-shipped-head: worktree discovery uses the sanitized environment too (PR A audit round 2)', () => {
  it('a GIT_DIR / GIT_WORK_TREE inherited from a hook or a parent cannot point the CLI at another checkout', async () => {
    const mine = await member({});
    const { dir: other } = makeRepo();
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ship-commit.mjs'), '--check-shipped-head', '--head', mine.head, '--offline', '--json'], {
      cwd: mine.dir, encoding: 'utf-8', windowsHide: true,
      env: { ...process.env, GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other, AUDIT_DB_URL: '', LEARNING_DISABLE: '1', AZURE_OPENAI_ENDPOINT: '' },
    });
    const env = JSON.parse(r.stdout);
    assert.equal(env.head, mine.head, `it judged ${env.head}, the member's own head is ${mine.head}: ${r.stderr}`);
    assert.notEqual(failing(env)[0], 'head', 'the head must resolve in the member\'s own repository');
  });
});
