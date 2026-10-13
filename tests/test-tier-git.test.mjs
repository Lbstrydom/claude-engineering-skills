/**
 * @fileoverview The git side of the test-tier oracle and the query CLI (docs/plans/gate-cost-slice-2.md D4, D5, section
 * 2.6), against real throwaway repositories: the tree is read from git OBJECTS, the base is the fork point, an explicit
 * bad base is an error, and a query the selector cannot answer is `measured:false` (exit 3), never a zero.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots, scrubbedEnv, tmpRoot } from './helpers/fleet-repo.mjs';
import { SELECTOR_IDENTITY_FILES } from '../scripts/lib/test-tier.mjs';
import { blobSha, changedFiles, committerTime, readFileAt, readTreeAt, resolveSelectionBase, selectorIdentity } from '../scripts/lib/test-tier-git.mjs';

after(cleanupFleetRoots);

const REAL = path.resolve(import.meta.dirname, '..');
const CLI = path.join(REAL, 'scripts', 'test-tier.mjs');
const today = new Date().toISOString().slice(0, 10);

const write = (repo, rel, body) => { const f = path.join(repo, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const commit = (repo, msg) => { git(['add', '-A'], repo); git(['commit', '-q', '-m', msg], repo); return git(['rev-parse', 'HEAD'], repo); };

/** A repo with a bare origin: main has `base`, branch `topic` has one more commit. Returns the oids. */
function makeRepo({ withTier = true } = {}) {
  const root = tmpRoot('tier-git-');
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q', '--bare', origin], root);
  git(['init', '-q', '-b', 'main', repo], repo);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 't'], repo);
  git(['remote', 'add', 'origin', origin], repo);
  write(repo, 'tests/heavy-a.test.mjs', "import '../scripts/lib/a.mjs';\n");
  write(repo, 'tests/heavy-b.test.mjs', "import '../scripts/lib/b.mjs';\n");
  write(repo, 'scripts/lib/a.mjs', 'export const a = 1;\n');
  write(repo, 'scripts/lib/b.mjs', 'export const b = 1;\n');
  write(repo, 'docs/readme.md', '# x\n');
  if (withTier) {
    // Byte-identical copies of the selector files: the CLI judges the head's selector against ITS OWN checkout's.
    for (const f of SELECTOR_IDENTITY_FILES) {
      write(repo, f, fs.readFileSync(path.join(REAL, f), 'utf8'));
    }
    write(repo, '.test-tiers.json', `${JSON.stringify({
      version: 1, maxAgeDays: 30, heavyThresholdMs: 1000,
      heavy: [
        { file: 'tests/heavy-a.test.mjs', why: 'a heavy family member', measuredMs: 5, measuredAt: today, reach: ['lib/a/**'] },
        { file: 'tests/heavy-b.test.mjs', why: 'a heavy family member', measuredMs: 5, measuredAt: today, reach: ['lib/b/**'] },
      ],
    })}\n`);
  }
  const base = commit(repo, 'base');
  git(['push', '-q', 'origin', 'main'], repo);
  git(['remote', 'set-head', 'origin', 'main'], repo);
  git(['switch', '-q', '-c', 'topic'], repo);
  return { root, repo, origin, base };
}

describe('resolveSelectionBase (D4): one resolver, and a bad explicit base is an error', () => {
  it('automatic: the fork point from origin/<default>, not the incremental push range', () => {
    const { repo, base } = makeRepo();
    write(repo, 'docs/readme.md', '# changed\n');
    const c1 = commit(repo, 'c1');
    write(repo, 'docs/readme.md', '# changed again\n');
    const c2 = commit(repo, 'c2');
    const r = resolveSelectionBase({ cwd: repo, head: c2 });
    assert.deepEqual([r.ok, r.base, r.source, r.head], [true, base, 'merge-base:origin/main', c2]);
    assert.notEqual(r.base, c1, 'a re-push after a fix keeps the earlier commit in the range');
  });
  it('explicit: resolved to full ids and ancestry-checked', () => {
    const { repo, base } = makeRepo();
    write(repo, 'docs/readme.md', '# c\n');
    const c1 = commit(repo, 'c1');
    const r = resolveSelectionBase({ cwd: repo, head: 'HEAD', base: 'HEAD~1' });
    assert.deepEqual([r.ok, r.base, r.head, r.source], [true, base, c1, 'explicit']);
    assert.match(r.base, /^[0-9a-f]{40}$/);
  });
  it('an explicit base that is malformed, unresolvable or NOT an ancestor is an error, never a degrade', () => {
    const { repo } = makeRepo();
    write(repo, 'docs/readme.md', '# c\n');
    const c1 = commit(repo, 'c1');
    git(['switch', '-q', '-c', 'other', 'main'], repo);
    write(repo, 'docs/readme.md', '# other\n');
    const other = commit(repo, 'other');
    for (const [base, why] of [['--upload-pack=x', /unsafe revision/], ['no-such-rev', /does not resolve/], [other, /not an ancestor/], ['a b', /unsafe revision/]]) {
      const r = resolveSelectionBase({ cwd: repo, head: c1, base });
      assert.equal(r.ok, false, base);
      assert.match(r.error, why, base);
    }
    assert.equal(resolveSelectionBase({ cwd: repo, head: 'no-such-rev' }).ok, false, 'an unresolvable head too');
  });
  it('automatic with no origin/<default> is { ok:true, base:null }: the oracle\'s full escape, not an error', () => {
    const { repo } = makeRepo();
    git(['remote', 'remove', 'origin'], repo);
    const r = resolveSelectionBase({ cwd: repo, head: 'HEAD' });
    assert.deepEqual([r.ok, r.base, r.source], [true, null, 'none']);
    assert.match(r.reason, /no merge-base with origin\/main/);
  });
  it('an explicitly supplied EMPTY base is an error, not an invitation to infer one (audit M6/M14)', () => {
    const { repo } = makeRepo();
    const r = resolveSelectionBase({ cwd: repo, head: 'HEAD', base: '' });
    assert.equal(r.ok, false);
    assert.match(r.error, /--base/);
    assert.equal(resolveSelectionBase({ cwd: repo, head: 'HEAD', base: null }).ok, true, 'control: an OMITTED base still infers');
    assert.equal(resolveSelectionBase({ cwd: repo, head: 'HEAD' }).ok, true);
  });
  it('moving origin/main AFTER resolution does not change a result whose base was passed explicitly', () => {
    const { repo, base } = makeRepo();
    write(repo, 'docs/readme.md', '# c\n');
    commit(repo, 'c1');
    const before = resolveSelectionBase({ cwd: repo, head: 'HEAD', base });
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], repo);
    assert.deepEqual(resolveSelectionBase({ cwd: repo, head: 'HEAD', base }), before);
    assert.notEqual(resolveSelectionBase({ cwd: repo, head: 'HEAD' }).base, before.base, 'control: the automatic base DID move');
  });
});

describe('the tree is read from git objects, never the working tree (D5)', () => {
  it('a dirty working-tree edit and an untracked file do not change what the oracle sees', () => {
    const { repo } = makeRepo();
    write(repo, 'scripts/lib/a.mjs', 'export const a = "DIRTY";\n');
    write(repo, 'scripts/lib/untracked.mjs', 'export {};\n');
    const t = readTreeAt(repo, 'HEAD');
    assert.equal(t.ok, true, t.error);
    assert.equal(t.tree.read('scripts/lib/a.mjs'), 'export const a = 1;\n');
    assert.equal(t.tree.files.has('scripts/lib/untracked.mjs'), false);
    assert.ok(t.tree.files.has('docs/readme.md'), 'every file is listed, code or not');
    assert.equal(t.tree.read('docs/readme.md'), null, 'only code files are read');
  });
  it('a tracked path containing a newline survives end to end (object ids, not path-spelled requests) - audit M1/H6', () => {
    // Neither NTFS nor the index can hold such a name, but a git TREE can: build it with plumbing, no working tree involved.
    const root = tmpRoot('tier-nl-');
    git(['init', '-q', '-b', 'main', root], root);
    const put = (body) => spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: body, env: scrubbedEnv(), encoding: 'utf8' }).stdout.trim();
    const mktree = (rec) => spawnSync('git', ['mktree', '-z'], { cwd: root, input: rec, env: scrubbedEnv(), encoding: 'utf8' }).stdout.trim();
    const ordinary = put('export const a = 1;\n');
    const tricky = put('export const tricky = 1;\n');
    const link = put('./a.mjs');
    const lib = mktree(`100644 blob ${ordinary}\ta.mjs\u0000100644 blob ${tricky}\ta\nb.mjs\u0000120000 blob ${link}\talias.mjs\u0000`);
    const top = mktree(`040000 tree ${lib}\tlib\u0000`);
    const author = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.c', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.c' };
    const head = spawnSync('git', ['commit-tree', top, '-m', 'a path with a newline'], { cwd: root, env: scrubbedEnv(author), encoding: 'utf8' }).stdout.trim();
    assert.match(head, /^[0-9a-f]{40}$/, 'the fixture commit was built');
    const t = readTreeAt(root, head);
    assert.equal(t.ok, true, t.error);
    assert.ok(t.tree.files.has('lib/a\nb.mjs'), 'the path is listed whole');
    assert.equal(t.tree.read('lib/a\nb.mjs'), 'export const tricky = 1;\n', 'its own content is read, not a neighbour');
    assert.equal(t.tree.read('lib/a.mjs'), 'export const a = 1;\n', 'control: the ordinary file beside it is unaffected');
    // audit r2 H1: a symlink is listed, flagged, and never parsed as source (its content is a target path)
    assert.ok(t.tree.files.has('lib/alias.mjs'));
    assert.ok(t.tree.symlinks.has('lib/alias.mjs'));
    assert.equal(t.tree.read('lib/alias.mjs'), null);
    assert.equal(t.tree.symlinks.has('lib/a.mjs'), false, 'control: a regular file is not flagged');
  });
  it('changedFiles splits a rename into delete + add, and readFileAt/blobSha/committerTime read the commit', () => {
    const { repo, base } = makeRepo();
    git(['mv', 'docs/readme.md', 'docs/readme2.md'], repo);
    const c = commit(repo, 'rename');
    assert.deepEqual(changedFiles(repo, base, c).files.sort(), ['docs/readme.md', 'docs/readme2.md']);
    assert.equal(readFileAt(repo, c, 'docs/readme2.md'), '# x\n');
    assert.equal(readFileAt(repo, c, 'docs/readme.md'), null);
    assert.match(blobSha(repo, c, 'docs/readme2.md'), /^[0-9a-f]{40}$/);
    assert.equal(blobSha(repo, c, 'absent.txt'), null);
    assert.match(committerTime(repo, c).iso, /^\d{4}-\d\d-\d\dT.*Z$/);
    const id = selectorIdentity(repo, c);
    assert.deepEqual(Object.keys(id.selector).sort(), [...SELECTOR_IDENTITY_FILES].sort());
    assert.match(id.manifest, /^[0-9a-f]{40}$/);
  });
});

describe('the query CLI: select (section 2.6)', () => {
  const env = scrubbedEnv({ FLEET_TELEMETRY: 'off' });
  const cli = (cwd, ...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* human output */ }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
  };

  it('measured: reads git objects at --head, reports the base back, skips exactly the unreached heavy file', () => {
    const { repo, base } = makeRepo();
    write(repo, 'scripts/lib/a.mjs', 'export const a = 2;\n');
    const head = commit(repo, 'touch a');
    const r = cli(repo, 'select', '--head', head, '--base', base, '--json');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual([r.json.measured, r.json.kind, r.json.tier, r.json.base, r.json.baseSource], [true, 'counterfactual-branch', 'branch', base, 'explicit']);
    assert.deepEqual(r.json.heavy.filter((h) => h.reached).map((h) => h.file), ['tests/heavy-a.test.mjs']);
    assert.deepEqual(r.json.skipped, ['tests/heavy-b.test.mjs']);
    assert.ok(r.json.manifest && r.json.selector['scripts/lib/test-tier.mjs']);
  });

  it('the answer is a function of (head, base): an uncommitted edit, a different request env and a later clock do not move it', () => {
    const { repo, base } = makeRepo();
    write(repo, 'scripts/lib/a.mjs', 'export const a = 2;\n');
    const head = commit(repo, 'touch a');
    const a = cli(repo, 'select', '--head', head, '--base', base, '--json').json;
    write(repo, 'scripts/lib/b.mjs', 'export const b = "dirty";\n');
    const b = spawnSync(process.execPath, [CLI, 'select', '--head', head, '--base', base, '--json'], { cwd: repo, env: { ...env, AUDIT_PREPUSH_TIER: 'full', FLEET_NOW: '2099-01-01T00:00:00Z' }, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(b.stdout), a);
  });

  it('an explicit --base that is not an ancestor is exit 1 (an error), not a degrade', () => {
    const { repo } = makeRepo();
    write(repo, 'docs/readme.md', '# c\n');
    const head = commit(repo, 'c');
    git(['switch', '-q', '-c', 'other', 'main'], repo);
    write(repo, 'docs/readme.md', '# o\n');
    const other = commit(repo, 'o');
    const r = cli(repo, 'select', '--head', head, '--base', other, '--json');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not an ancestor/);
    assert.equal(cli(repo, 'select', '--head', head, '--base', 'nope', '--json').status, 1);
  });

  it('a head that predates the tier is measured:false, exit 3: unmeasured, never a zero', () => {
    const { repo, base } = makeRepo({ withTier: false });
    write(repo, 'docs/readme.md', '# c\n');
    const head = commit(repo, 'c');
    const r = cli(repo, 'select', '--head', head, '--base', base, '--json');
    assert.equal(r.status, 3);
    assert.deepEqual([r.json.measured, 'skipped' in r.json], [false, false]);
    assert.match(r.json.reason, /predates the test tier/);
  });

  it('a head whose selector differs from this checkout\'s is measured:false, exit 3', () => {
    const { repo, base } = makeRepo();
    write(repo, 'scripts/lib/test-tier.mjs', `${fs.readFileSync(path.join(repo, 'scripts/lib/test-tier.mjs'), 'utf8')}\n// edited at the head\n`);
    const head = commit(repo, 'edit the selector');
    const r = cli(repo, 'select', '--head', head, '--base', base, '--json');
    assert.equal(r.status, 3);
    assert.match(r.json.reason, /selector at the head differs from this checkout's \(scripts\/lib\/test-tier\.mjs\)/);
  });

  it('an invalid heavy list at the head is unmeasured, and --as-of must be a time', () => {
    const { repo, base } = makeRepo();
    write(repo, '.test-tiers.json', '{ "version": 9 }');
    const head = commit(repo, 'break the list');
    assert.equal(cli(repo, 'select', '--head', head, '--base', base, '--json').status, 3);
    const ok = makeRepo();
    assert.equal(cli(ok.repo, 'select', '--head', 'HEAD', '--base', ok.base, '--as-of', 'soon', '--json').status, 2);
  });

  it('usage errors: no sub-command, no --head, an unknown flag (exit 2)', () => {
    const { repo } = makeRepo();
    assert.equal(cli(repo).status, 2);
    assert.equal(cli(repo, 'select').status, 2);
    assert.equal(cli(repo, 'select', '--head', 'HEAD', '--bogus').status, 2);
    assert.equal(cli(repo, '--selfcheck-relocation').stdout.trim(), 'OK');
  });
});

describe('the push-time plan: plan (section 13)', () => {
  const env = scrubbedEnv({ FLEET_TELEMETRY: 'off' });
  const plan = (repo, head, ...args) => {
    const out = path.join(repo, '..', 'env.json');
    const r = spawnSync(process.execPath, [CLI, 'plan', '--head', head, '--out', out, ...args], { cwd: repo, env, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, envelope: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null };
  };
  it('default request: full, with wouldSkip for the shadow line; the one summary line is on stdout', () => {
    const { repo } = makeRepo();
    write(repo, 'scripts/lib/a.mjs', 'export const a = 2;\n');
    const head = commit(repo, 'touch a');
    const r = plan(repo, head);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual([r.envelope.kind, r.envelope.tier, r.envelope.skipped, r.envelope.wouldSkip], ['push', 'full', [], ['tests/heavy-b.test.mjs']]);
    assert.match(r.stdout.trim(), new RegExp(`^test-tier/v1 full ${head} skipped=0 base=[0-9a-f]{40}$`));
  });
  it('--tier branch skips the unreached file; --pushes-default and --tier full each force full', () => {
    const { repo } = makeRepo();
    write(repo, 'docs/readme.md', '# c\n');
    const head = commit(repo, 'docs only');
    assert.deepEqual(plan(repo, head, '--tier', 'branch').envelope.skipped, ['tests/heavy-a.test.mjs', 'tests/heavy-b.test.mjs']);
    assert.equal(plan(repo, head, '--tier', 'branch', '--pushes-default').envelope.tier, 'full');
    assert.equal(plan(repo, head, '--tier', 'full').envelope.tier, 'full');
    assert.equal(plan(repo, head, '--tier', 'bogus').envelope.escapes.some((e) => e.id === 'unknown-tier-request'), true);
  });
  it('a head with no list fails (exit 1): the sandbox then runs the full suite', () => {
    const { repo } = makeRepo({ withTier: false });
    write(repo, 'docs/readme.md', '# c\n');
    const head = commit(repo, 'c');
    const r = plan(repo, head, '--tier', 'branch');
    assert.equal(r.status, 1);
    assert.equal(r.envelope, null);
  });
});
