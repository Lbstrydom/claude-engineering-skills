/**
 * Hook v16 plan selection (docs/plans/hook-fidelity-and-v15-field-gaps.md §2.3-2.4):
 *   - a plan is chosen by the code files it DECLARES (majority + strict margin), with its reason printed;
 *   - plan files are read from the PUSHED commit, not the working tree (fleet 4146), and a plan that differs from the checkout's copy
 *     is not selected.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractDeclaredPaths, selectByDeclaredPaths, isCodeChange } from '../scripts/lib/plan-declared-paths.mjs';
import { selectAuditPlan } from '../scripts/lib/plan-status.mjs';
import { gitPlanFiles } from '../scripts/lib/plan-git-source.mjs';
import { gitFixtureEnv } from './helpers/fixtures.mjs';

const plan = (status, ...paths) => `# P\n- **Status**: ${status}\n\n## 7. File-Level Plan\n\n${paths.map((p) => `| \`${p}\` | change |`).join('\n')}\n`;

describe('extractDeclaredPaths', () => {
  it('reads backticked paths, drops line suffixes and non-paths, and treats a trailing slash or glob as a directory', () => {
    const d = extractDeclaredPaths('See `scripts/a.mjs:120`, `./lib/b.mjs`, `tests/**`, `docs/x/`, `npm run check`, `--flag`, `https://x.y/z.js`, `src/{a,b}.js`, `v1.2`.');
    assert.deepEqual([...d.files].sort(), ['lib/b.mjs', 'scripts/a.mjs']);
    assert.deepEqual(d.dirs.sort(), ['docs/x/', 'tests/']);
  });
});

describe('selectByDeclaredPaths', () => {
  const cand = [
    { name: 'a.md', content: plan('Draft', 'src/one.mjs', 'src/two.mjs', 'src/three.mjs') },
    { name: 'b.md', content: plan('Draft', 'src/four.mjs', 'lib/') },
  ];
  it('selects the plan covering a strict majority of the changed code files, and says why with the counts', () => {
    const r = selectByDeclaredPaths(cand, ['src/one.mjs', 'src/two.mjs', 'src/four.mjs', 'docs/plans/a.md', 'README.md']);
    assert.equal(r.selected?.name, 'a.md');
    assert.match(r.why, /a\.md covers 2\/3 changed code files; next best covers 1/);
  });
  it('a directory declaration covers everything under it', () => {
    const r = selectByDeclaredPaths(cand, ['lib/x.mjs', 'lib/deep/y.mjs']);
    assert.equal(r.selected?.name, 'b.md');
  });
  it('a tie selects nothing and names the counts', () => {
    const r = selectByDeclaredPaths(cand, ['src/one.mjs', 'src/four.mjs']);
    assert.equal(r.selected, null);
    assert.match(r.why, /tie|too close/);
  });
  it('a minority never wins even with no runner-up (the plan that merely mentions a shared file)', () => {
    const r = selectByDeclaredPaths(cand, ['src/one.mjs', 'x/1.mjs', 'x/2.mjs', 'x/3.mjs']);
    assert.equal(r.selected, null);
    assert.match(r.why, /under the half/);
  });
  it('covering nothing, or a push with no code file, selects nothing', () => {
    assert.equal(selectByDeclaredPaths(cand, ['elsewhere/z.mjs']).selected, null);
    assert.equal(selectByDeclaredPaths(cand, ['README.md', 'docs/plans/a.md', '.sync-receipt.json']).selected, null);
  });
  it('docs, plan files and sync bookkeeping are not code changes (a plan edit cannot score itself)', () => {
    assert.equal(isCodeChange('docs/plans/a.md'), false);
    assert.equal(isCodeChange('README.md'), false);
    assert.equal(isCodeChange('.sync-receipt.json'), false);
    assert.equal(isCodeChange('src/a.mjs'), true);
  });
});

describe('selectAuditPlan - declared-paths tier', () => {
  const planFiles = (...ps) => ps.map(([name, content]) => ({ name, abs: `/x/docs/plans/${name}`, content, mtimeMs: 0 }));
  it('two active plans, none edited: the one declaring the changed code is selected, with boundBy and why', () => {
    const files = planFiles(['a.md', plan('Draft', 'src/one.mjs')], ['b.md', plan('Approved', 'src/two.mjs')]);
    const sel = selectAuditPlan('/x/docs/plans', { planFiles: files, changedFiles: ['src/two.mjs'] });
    assert.equal(sel?.boundBy, 'declared-paths');
    assert.match(sel.why, /b\.md covers 1\/1/);
    assert.match(sel.path, /b\.md$/);
  });
  it('NEGATIVE CONTROL: a push covering neither plan still selects nothing, and the warning carries the reason', () => {
    const files = planFiles(['a.md', plan('Draft', 'src/one.mjs')], ['b.md', plan('Approved', 'src/two.mjs')]);
    const warnings = [];
    const sel = selectAuditPlan('/x/docs/plans', { planFiles: files, changedFiles: ['src/unrelated.mjs'], warn: (m) => warnings.push(m) });
    assert.equal(sel, null);
    assert.ok(warnings.some((w) => /not selected by declared paths either: no active plan declares any of the 1 changed code file/.test(w)));
  });
  it('several edited active plans: declared paths decide among just those', () => {
    const files = planFiles(['a.md', plan('Draft', 'src/one.mjs')], ['b.md', plan('Draft', 'src/two.mjs')], ['c.md', plan('Draft', 'src/two.mjs', 'src/one.mjs')]);
    const sel = selectAuditPlan('/x/docs/plans', { planFiles: files, changedFiles: ['docs/plans/a.md', 'docs/plans/b.md', 'src/two.mjs'] });
    assert.match(sel.path, /b\.md$/, 'c.md also declares it but was not edited by the push');
  });
  it('without a change signal (null) there is still no guess', () => {
    const files = planFiles(['a.md', plan('Draft', 'src/one.mjs')], ['b.md', plan('Draft', 'src/two.mjs')]);
    assert.equal(selectAuditPlan('/x/docs/plans', { planFiles: files, changedFiles: null }), null);
  });
});

describe('plans are read from the pushed commit (fleet 4146)', () => {
  const env = gitFixtureEnv();
  let tmp; let repo;
  const git = (...a) => {
    const r = spawnSync('git', a, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (rel, body) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), body); };
  const CLI = path.resolve('scripts', 'check-plan-status.mjs');
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env: { ...env, ...extraEnv }, encoding: 'utf8' });
  let base; let head;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-src-'));
    repo = path.join(tmp, 'r');
    fs.mkdirSync(repo);
    git('init', '-q'); git('config', 'user.email', 't@t.t'); git('config', 'user.name', 't');
    write('docs/plans/good.md', '# G\n- **Status**: Draft\n');
    write('docs/plans/other.md', '# O\n- **Status**: Complete\n');
    write('src/a.mjs', '//\n');
    git('add', '-A'); git('commit', '-qm', 'base'); base = git('rev-parse', 'HEAD');
    // The pushed commit FIXES a bad Status line and edits code.
    write('docs/plans/good.md', '# G\n- **Status**: In Progress\n');
    write('src/a.mjs', '// changed\n');
    git('add', '-A'); git('commit', '-qm', 'work'); head = git('rev-parse', 'HEAD');
  });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  it('gitPlanFiles returns the commit\'s plans, not the working tree\'s', () => {
    write('docs/plans/good.md', '# G\n- **Status**: Bananas\n'); // dirty working tree
    const files = gitPlanFiles({ head, cwd: repo });
    assert.deepEqual(files.map((f) => f.name).sort(), ['good.md', 'other.md']);
    assert.match(files.find((f) => f.name === 'good.md').content, /In Progress/);
    git('checkout', '--', 'docs/plans/good.md');
  });
  it('a plan name containing a line break makes the listing unavailable (cat-file --batch cannot carry it)', () => {
    const spawn = (cmd, args) => (args[0] === 'ls-tree'
      ? { status: 0, stdout: Buffer.from('100644 blob ' + 'a'.repeat(40) + '\tdocs/plans/x\ny.md\0') }
      : { status: 0, stdout: Buffer.alloc(0) });
    assert.equal(gitPlanFiles({ head, cwd: repo, spawn }), null);
  });
  it('an unsafe or unknown revision is null (the caller falls back and says so), never an empty list', () => {
    assert.equal(gitPlanFiles({ head: '--upload-pack=x', cwd: repo }), null);
    assert.equal(gitPlanFiles({ head: 'f'.repeat(40), cwd: repo }), null);
  });
  it('--drift passes when the pushed commit is clean even though the working tree is not (the reported false block)', () => {
    write('docs/plans/good.md', '# G\n- **Status**: Bananas\n');
    const r = run(['--drift'], { AUDIT_PUSH_RANGE_BASE: base, AUDIT_PUSH_RANGE_HEAD: head });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /reading 2 plan\(s\) from the pushed commit/);
    git('checkout', '--', 'docs/plans/good.md');
  });
  it('NEGATIVE CONTROL: --drift fails when the pushed commit carries a bad Status even though the working tree is clean (the false pass)', () => {
    write('docs/plans/good.md', '# G\n- **Status**: Bananas\n');
    git('add', '-A'); git('commit', '-qm', 'bad'); const bad = git('rev-parse', 'HEAD');
    write('docs/plans/good.md', '# G\n- **Status**: Draft\n'); // clean in the working tree
    const r = run(['--drift'], { AUDIT_PUSH_RANGE_BASE: head, AUDIT_PUSH_RANGE_HEAD: bad });
    assert.equal(r.status, 1, r.stderr);
    git('checkout', '--', 'docs/plans/good.md');
    git('reset', '-q', '--hard', head);
  });
  it('NEGATIVE: a trusted head that git cannot read selects nothing and FAILS --drift - never a substitution of the working tree', () => {
    const ghost = 'f'.repeat(40);
    const sel = run(['--select', 'docs/plans'], { AUDIT_PUSH_RANGE_BASE: base, AUDIT_PUSH_RANGE_HEAD: ghost });
    assert.equal(sel.stdout.trim(), '');
    assert.match(sel.stderr, /refusing to substitute this checkout's working tree/);
    const drift = run(['--drift'], { AUDIT_PUSH_RANGE_BASE: base, AUDIT_PUSH_RANGE_HEAD: ghost });
    assert.equal(drift.status, 1, drift.stderr);
  });
  it('--select selects nothing and says why when the pushed plan differs from the checkout\'s copy', () => {
    write('docs/plans/good.md', '# G\n- **Status**: Draft\n- edited locally\n');
    const r = run(['--select', 'docs/plans'], { AUDIT_PUSH_RANGE_BASE: base, AUDIT_PUSH_RANGE_HEAD: head });
    assert.equal(r.stdout.trim(), '');
    assert.match(r.stderr, /differs from this checkout's copy/);
    git('checkout', '--', 'docs/plans/good.md');
  });
  it('--select selects the plan when the checkout is the pushed commit, including a CRLF working copy', () => {
    const lf = fs.readFileSync(path.join(repo, 'docs/plans/good.md'), 'utf8');
    fs.writeFileSync(path.join(repo, 'docs/plans/good.md'), lf.replace(/\n/g, '\r\n'));
    const r = run(['--select', 'docs/plans'], { AUDIT_PUSH_RANGE_BASE: base, AUDIT_PUSH_RANGE_HEAD: head });
    assert.equal(r.stdout.trim().replace(/\\/g, '/'), 'docs/plans/good.md', r.stderr);
    assert.match(r.stderr, /selected good\.md via/);
    git('checkout', '--', 'docs/plans/good.md');
  });
});
