/**
 * @fileoverview /fleet — append-only union resolution and land checks in the
 * combined tree (plan docs/plans/fleet-consumer-feedback-oct.md §2.5).
 *
 * Pinned: all-or-nothing eligibility (three stages, regular text, same mode, glob
 * match); nothing is written when ineligible; direct-mode trains resolve and
 * disclose; pr-mode trains stop with the restack remedy; a `land` check that
 * exists only on one train branch runs against the combined tree.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { ineligibility, onlyAdds, parseUnmerged, resolveAppendOnly } from '../scripts/lib/fleet/union-merge.mjs';
import { runGit } from '../scripts/lib/fleet/git-facts.mjs';
import {
  addBranch, cleanupFleetRoots, commitFile, installFakeGh, makeFleetRepo, prRow, runFleet, scrubbedEnv, writeFile,
} from './helpers/fleet-repo.mjs';

after(cleanupFleetRoots);

const OIDS = { a: 'a'.repeat(40), b: 'b'.repeat(40), c: 'c'.repeat(40) };

describe('eligibility — decided before anything is written', () => {
  const stages = (over = {}) => ({ 1: { mode: '100644', oid: OIDS.a }, 2: { mode: '100644', oid: OIDS.b }, 3: { mode: '100644', oid: OIDS.c }, ...over });
  it('a three-stage regular file under a glob is eligible on its stages', () => assert.equal(ineligibility('docs/log.md', stages(), ['docs/**']), null));
  it('add/add, modify/delete, mode mismatch, symlink and no glob are not', () => {
    const { 1: _b, ...noBase } = stages();
    const { 3: _t, ...noTheirs } = stages();
    assert.match(ineligibility('docs/log.md', noBase, ['docs/**']), /stage 1 missing/);
    assert.match(ineligibility('docs/log.md', noTheirs, ['docs/**']), /stage 3 missing/);
    assert.match(ineligibility('docs/log.md', stages({ 3: { mode: '100755', oid: OIDS.c } }), ['docs/**']), /mode differs/);
    assert.match(ineligibility('docs/log.md', stages({ 2: { mode: '120000', oid: OIDS.b } }), ['docs/**']), /not a regular file/);
    assert.match(ineligibility('src/a.js', stages(), ['docs/**']), /not in appendOnlyGlobs/);
  });
  it('onlyAdds: insertions anywhere pass; a deleted or rewritten base line does not (C3-R1-M3)', () => {
    const B = (s) => Buffer.from(s);
    assert.equal(onlyAdds(B('a\nb\n'), B('a\nnew\nb\nmore\n')), true);
    assert.equal(onlyAdds(B('a\nb\n'), B('a\n')), false);
    assert.equal(onlyAdds(B('a\nb\n'), B('a\nB\n')), false);
    assert.equal(onlyAdds(B('a\n'), B('a\nours')), true, 'a byte-prefix append without a final newline (C3-R2-M1)');
    assert.equal(onlyAdds(B('a\n'), B('a')), false, 'dropping the final newline is an edit (C3-R3-H1)');
    assert.equal(onlyAdds(B('a'), B('a\nb\n')), false, 'terminating an unterminated last line is an edit (safe direction)');
    assert.equal(onlyAdds(B(''), B('x\n')), true, 'an empty base');
  });
  it('parses ls-files -u -z', () => {
    const NUL = '\u0000';
    const m = parseUnmerged(`100644 ${OIDS.a} 1\tdocs/log.md${NUL}100644 ${OIDS.b} 2\tdocs/log.md${NUL}`);
    assert.deepEqual(Object.keys(m.get('docs/log.md')), ['1', '2']);
  });
});

describe('resolveAppendOnly on a real conflict', () => {
  const conflicted = () => {
    const { repo } = makeFleetRepo({ files: { 'docs/log.md': '# log\n- base\n', 'src/a.js': 'a\n' } });
    git(['checkout', '-q', '-b', 'one'], repo); commitFile(repo, 'docs/log.md', '# log\n- base\n- one\n');
    git(['checkout', '-q', '-b', 'two', 'main'], repo); commitFile(repo, 'docs/log.md', '# log\n- base\n- two\n');
    return repo;
  };
  const g = (repo) => (args) => runGit(args, repo);
  it('keeps both sides and stages the file', () => {
    const repo = conflicted();
    assert.throws(() => git(['cherry-pick', 'one'], repo));
    const r = resolveAppendOnly({ dir: repo, git: g(repo), globs: ['docs/**'] });
    assert.deepEqual(r, { ok: true, resolved: ['docs/log.md'] });
    const body = fs.readFileSync(path.join(repo, 'docs/log.md'), 'utf8');
    assert.match(body, /- two/); assert.match(body, /- one/);
    assert.equal(git(['diff', '--name-only', '--diff-filter=U'], repo), '');
  });
  it('a side that rewrites a base line is NOT append-only: refused, nothing written (C3-R1-M3)', () => {
    const { repo } = makeFleetRepo({ files: { 'docs/log.md': '# log\n- base\n' } });
    git(['checkout', '-q', '-b', 'one'], repo); commitFile(repo, 'docs/log.md', '# log\n- base\n- one\n');
    git(['checkout', '-q', '-b', 'two', 'main'], repo); commitFile(repo, 'docs/log.md', '# LOG\n- base\n- two\n');
    assert.throws(() => git(['cherry-pick', 'one'], repo));
    const r = resolveAppendOnly({ dir: repo, git: g(repo), globs: ['docs/**'] });
    assert.equal(r.ok, false);
    assert.match(r.reason, /not append-only/);
    assert.notEqual(git(['diff', '--name-only', '--diff-filter=U'], repo), '', 'still an ordinary conflict');
  });
  it('bytes are preserved: a CRLF + non-UTF-8 byte file round-trips exactly (C3-R1-H2/H6)', () => {
    const { repo } = makeFleetRepo({ files: { 'docs/log.md': '# log\r\n' } });
    const write = (body) => fs.writeFileSync(path.join(repo, 'docs/log.md'), Buffer.concat([Buffer.from('# log\r\n'), body]));
    git(['checkout', '-q', '-b', 'one'], repo); write(Buffer.from([0x2d, 0x20, 0xe9, 0x0d, 0x0a])); git(['commit', '-qam', 'one'], repo);
    git(['checkout', '-q', '-b', 'two', 'main'], repo); write(Buffer.from('- two\r\n')); git(['commit', '-qam', 'two'], repo);
    assert.throws(() => git(['cherry-pick', 'one'], repo));
    const r = resolveAppendOnly({ dir: repo, git: g(repo), globs: ['docs/**'] });
    assert.equal(r.ok, true, r.reason);
    const out = fs.readFileSync(path.join(repo, 'docs/log.md'));
    assert.ok(out.includes(Buffer.from([0x2d, 0x20, 0xe9, 0x0d, 0x0a])), 'the latin-1 byte and CRLF survive unchanged');
  });
  it('one ineligible path ⇒ nothing is touched', () => {
    const repo = conflicted();
    git(['checkout', '-q', 'one'], repo); commitFile(repo, 'src/a.js', 'one\n');
    git(['checkout', '-q', 'two'], repo); commitFile(repo, 'src/a.js', 'two\n');
    assert.throws(() => git(['merge', 'one'], repo));
    const before = fs.readFileSync(path.join(repo, 'docs/log.md'), 'utf8');
    const r = resolveAppendOnly({ dir: repo, git: g(repo), globs: ['docs/**'] });
    assert.equal(r.ok, false);
    assert.match(r.reason, /src\/a\.js \(not in appendOnlyGlobs\)/);
    assert.equal(fs.readFileSync(path.join(repo, 'docs/log.md'), 'utf8'), before, 'the eligible file was not resolved either');
  });
});

describe('trains: direct modes resolve and disclose; pr mode stops with the remedy', () => {
  const OK_TIER = { name: 'ok', command: ['node', '-e', '0'] };
  const setup = (cfg) => {
    const fx = makeFleetRepo({ files: { 'docs/log.md': '# log\n', 'a.txt': 'a\n' }, fleetConfig: { testCommand: { tiers: [OK_TIER] }, ...cfg } });
    git(['add', '.fleet.json'], fx.repo); git(['commit', '-q', '-m', 'cfg'], fx.repo); git(['push', '-q', 'origin', 'main'], fx.repo);
    const fake = installFakeGh(fx.root);
    const env = scrubbedEnv({ FLEET_WORKTREE_ROOT: fx.wtRoot, ...fake.env }, { prependPath: [fake.bin] });
    const f = (args) => runFleet(args, { cwd: fx.repo, env });
    const base = git(['rev-parse', 'main'], fx.repo);
    const rows = [];
    for (const [i, n] of ['one', 'two'].entries()) {
      const oid = addBranch(fx.repo, n, { 'docs/log.md': `# log\n- ${n}\n` });
      rows.push(prRow({ number: 30 + i, branch: n, headOid: oid, baseOid: base }));
      git(['push', '-q', 'origin', `${oid}:refs/pull/${30 + i}/head`], fx.repo);
      git(['checkout', '-q', n], fx.repo);
      assert.equal(f(['claim', '--id', n, '--intent', n, '--paths', `${n}.txt`]).status, 0);
      assert.equal(f(['ready', '--id', n]).status, 0);
      git(['checkout', '-q', 'main'], fx.repo);
    }
    fake.setState({ list: rows, view: Object.fromEntries(rows.map((r) => [r.number, r])) });
    return { fx, f };
  };
  it('direct-squash: both lines land in the candidate; the train notes say so', () => {
    const { fx, f } = setup({ mergeMethod: 'direct-squash', appendOnlyGlobs: ['docs/**'] });
    const b = f(['land', '--json']);
    assert.equal(b.status, 0, b.stdout + b.stderr);
    const t = b.json.train;
    assert.equal(t.phase, 'tested');
    const log = git(['show', `${t.candidate.oid}:docs/log.md`], fx.repo);
    assert.match(log, /- one/); assert.match(log, /- two/);
    assert.match(t.notes.join(' '), /merged keeping both sides \(appendOnlyGlobs\)/);
  });
  it('without appendOnlyGlobs the same train is a plain conflict (control)', () => {
    const { f } = setup({ mergeMethod: 'direct-squash' });
    const b = f(['land', '--json']);
    assert.equal(b.json.train.phase, 'conflict');
  });
  it('pr mode: an append-only conflict stops with the restack remedy', () => {
    const { f } = setup({ mergeMethod: 'pr', appendOnlyGlobs: ['docs/**'] });
    const b = f(['land', '--json']);
    assert.equal(b.json.train.phase, 'conflict');
    assert.match(b.json.train.conflict.reason, /append-only conflict.*fleet restack/);
  });
});

describe('land checks run in the combined tree', () => {
  it('a guard committed only on branch A blocks branch B in the same train', () => {
    const guard = 'scripts/guard.mjs';
    const fx = makeFleetRepo({
      files: { 'a.txt': 'a\n', 'rules.txt': 'r1\n' },
      fleetConfig: { mergeMethod: 'direct-squash', testCommand: { tiers: [{ name: 'ok', command: ['node', '-e', '0'] }] }, checks: [{ name: 'guard', script: guard, runIn: ['land'], severity: 'block' }] },
    });
    git(['add', '.fleet.json'], fx.repo); git(['commit', '-q', '-m', 'cfg'], fx.repo); git(['push', '-q', 'origin', 'main'], fx.repo);
    const env = scrubbedEnv({ FLEET_WORKTREE_ROOT: fx.wtRoot });
    const f = (args) => runFleet(args, { cwd: fx.repo, env });
    // Branch A adds the guard: every rule must be listed in rules.txt.
    const guardSrc = "import fs from 'node:fs';\nconst rules = fs.readFileSync('rules.txt','utf8');\nconst bad = fs.readdirSync('.').filter((f) => f.startsWith('rule-') && !rules.includes(f));\nprocess.stdout.write(JSON.stringify({ schemaVersion: 1, findings: bad.map((b) => ({ level: 'block', message: 'unlisted ' + b })) }));\n";
    addBranch(fx.repo, 'a-guard', { [guard]: guardSrc });
    addBranch(fx.repo, 'b-rule', { 'rule-new.txt': 'x\n' });
    for (const n of ['a-guard', 'b-rule']) {
      git(['checkout', '-q', n], fx.repo);
      assert.equal(f(['claim', '--id', n, '--intent', n, '--paths', `${n}/**`]).status, 0);
      assert.equal(f(['ready', '--id', n]).status, 0);
      git(['checkout', '-q', 'main'], fx.repo);
    }
    const b = f(['land', '--json']);
    const t = b.json.train;
    const guardResult = (t.checkResults ?? []).find((c) => c.name === 'guard');
    assert.ok(guardResult, `the guard ran: ${b.stdout}`);
    assert.match(JSON.stringify(guardResult), /unlisted rule-new\.txt/);
    assert.equal(b.json.approvability?.ok ?? false, false, 'a block finding makes the train non-approvable');
  });
});
