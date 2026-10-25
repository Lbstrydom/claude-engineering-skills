/**
 * @fileoverview Hook v13 (Tier 3: consumer hook contract - this ships to repos nobody here can observe). Three fixes from v12's first
 * day in the field (fleet p-...-eb21, -f757, -33e2):
 *
 *   A. REUSE BY PATCHES (eb21). A cherry-pick recovery after a squash divergence changes the pushed TREE but not the branch's own
 *      diff, so v12 re-ran a ~14 minute audit over work it had already converged. A converged run is now also reused when the
 *      branch's own commits have exactly the audited commits' content fingerprints - and the output says range-diff-equivalent, never "same tree".
 *   B. NO PLAN (33e2). The plan selector resolving nothing made the hook `finish` having audited NOTHING, with only a status line
 *      (storyline #431). That is UNMEASURED: refused unless the push carries nothing a code audit reads, or the named override is set.
 *   C. THE BUDGET is refit from measured durations (the formula's own doc carries the numbers); the regression that motivated it is
 *      pinned here, with v12's formula as the negative control.
 *
 * Both directions throughout: what each rule must refuse AND what it must not.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  decideAuditReuse, auditBudgetSec, BUDGET, UNMEASURED_OVERRIDE_ENV,
  classifyNoPlanPush, decideNoPlanGate, SYNC_BOOKKEEPING_FILES,
} from '../scripts/lib/prepush-audit-gate.mjs';
import { auditReuseLine, noPlanExit } from '../scripts/prepush-step.mjs';
import { _internals } from '../scripts/install-prepush-hook.mjs';
import { hasBash, git } from './lib/hook-test-helpers.mjs';
import { writeStepRunnerStub } from './lib/prepush-step-stub.mjs';

const { HOOK_BODY } = _internals;
const HAS_BASH = hasBash();
const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

// ── A. reuse by patches ───────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('decideAuditReuse - range-diff equivalence', () => {
  const TREE = 'a'.repeat(40);
  const PUSHED = 'b'.repeat(40);
  const marker = { runId: 'audit-run-0001', auditedTree: TREE, auditedSha: 'c'.repeat(40) };
  const conv = { roundConvergedAfter: 2 };
  const eq = { equivalent: true, commits: 3 };
  it('a different tree whose patches are equivalent AND whose run converged -> reuse, flagged range-diff', () => {
    assert.deepEqual(decideAuditReuse({ marker, pushedTree: PUSHED, convergence: conv, equivalence: eq }),
      { reuse: true, runId: 'audit-run-0001', round: 2, auditedTree: TREE, equivalence: 'range-diff', commits: 3 });
  });
  it('equivalence is not enough alone: an unverifiable or unconverged run still re-runs, saying it audited "the same patches"', () => {
    assert.match(decideAuditReuse({ marker, pushedTree: PUSHED, convergence: null, convergenceWhy: 'cloud store is off', equivalence: eq }).reason, /audited the same patches, but whether it passed cannot be verified \(cloud store is off\)/);
    assert.match(decideAuditReuse({ marker, pushedTree: PUSHED, convergence: { roundConvergedAfter: null }, equivalence: eq }).reason, /audited the same patches but did not converge/);
  });
  it('NOT equivalent -> re-runs, and the reason carries the comparison\'s own reason', () => {
    const r = decideAuditReuse({ marker, pushedTree: PUSHED, convergence: conv, equivalence: { equivalent: false, reason: 'the patches differ: audited 2 own commit(s), pushed 3' } });
    assert.equal(r.reuse, false);
    assert.match(r.reason, /not the pushed tree.*not range-diff-equivalent.*pushed 3/);
  });
  it('a same-tree reuse is untouched by an equivalence verdict: the tree is the stronger claim and keeps its own wording', () => {
    const r = decideAuditReuse({ marker, pushedTree: TREE, convergence: conv, equivalence: { equivalent: false, reason: 'x' } });
    assert.equal(r.reuse, true);
    assert.equal(r.equivalence, undefined);
  });
});

describe('auditReuseLine - range-diff equivalence against REAL git (rebase / cherry-pick recovery)', () => {
  const converged = async () => ({ convergence: { roundConvergedAfter: 3 }, why: null });
  /** main + a two-commit feature branch whose tip is the audited commit; origin/main is a ref we can advance. */
  function featureRepo() {
    const dir = tmpDir('audit-reuse-eq-');
    git(['init', '-q', '-b', 'main'], dir);
    git(['config', 'user.email', 'a@example.invalid'], dir);
    git(['config', 'user.name', 'A'], dir);
    const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); git(['add', rel], dir); };
    put('base.txt', 'base\n'); git(['commit', '-q', '-m', 'seed'], dir);
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], dir);
    git(['checkout', '-q', '-b', 'feature'], dir);
    put('src/a.txt', 'a1\na2\n'); git(['commit', '-q', '-m', 'A'], dir);
    put('src/b.txt', 'b1\nb2\n'); git(['commit', '-q', '-m', 'B'], dir);
    return { dir, put, tip: () => git(['rev-parse', 'HEAD'], dir) };
  }
  const writeMarker = (dir, sha, extra = {}) => {
    fs.mkdirSync(path.join(dir, '.audit'), { recursive: true });
    const m = { runId: 'audit-run-0009', auditedSha: sha, auditedTree: git(['rev-parse', `${sha}^{tree}`], dir), ts: new Date().toISOString(), ...extra };
    fs.writeFileSync(path.join(dir, '.audit', 'last-audit-run.json'), JSON.stringify(m));
  };
  const env = (dir) => ({ AUDIT_PUSH_RANGE_BASE: git(['rev-parse', 'origin/main'], dir), AUDIT_PUSH_RANGE_HEAD: git(['rev-parse', 'HEAD'], dir) });
  /** main moves on (a file the feature does not touch), then the feature is rebased onto it. */
  function rebaseOntoMovedMain(f) {
    git(['checkout', '-q', 'main'], f.dir);
    f.put('main-only.txt', 'moved\n'); git(['commit', '-q', '-m', 'main moves'], f.dir);
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], f.dir);
    git(['checkout', '-q', 'feature'], f.dir);
    git(['rebase', 'main'], f.dir);
  }

  it('a pure rebase onto a moved main: the tree changed, the branch\'s patches did not -> reuse-equivalent, naming run, round and commit count', async () => {
    const f = featureRepo();
    try {
      const audited = f.tip();
      writeMarker(f.dir, audited);
      rebaseOntoMovedMain(f);
      assert.notEqual(git(['rev-parse', 'HEAD^{tree}'], f.dir), git(['rev-parse', `${audited}^{tree}`], f.dir), 'fixture: the tree really moved');
      assert.equal(await auditReuseLine({ env: env(f.dir), cwd: f.dir, readConvergence: converged }), 'reuse-equivalent audit-run-0009 3 2');
    } finally { rmrf(f.dir); }
  });
  it('NEGATIVE CONTROL: the same rebase with one byte changed in a branch commit -> none, and the store is never asked', async () => {
    const f = featureRepo();
    try {
      writeMarker(f.dir, f.tip());
      rebaseOntoMovedMain(f);
      f.put('src/b.txt', 'b1\nB2\n'); git(['commit', '-q', '--amend', '--no-edit'], f.dir);
      let asked = false;
      const line = await auditReuseLine({ env: env(f.dir), cwd: f.dir, readConvergence: async () => { asked = true; return converged(); } });
      assert.match(line, /^none .*not the pushed tree.*not range-diff-equivalent.*differ/);
      assert.equal(asked, false);
    } finally { rmrf(f.dir); }
  });
  it('a commit added after the audit, or one dropped, is not equivalent', async () => {
    const f = featureRepo();
    try {
      writeMarker(f.dir, f.tip());
      f.put('src/c.txt', 'c\n'); git(['commit', '-q', '-m', 'C after the audit'], f.dir);
      assert.match(await auditReuseLine({ env: env(f.dir), cwd: f.dir, readConvergence: converged }), /^none .*1 pushed patch\(es\) were never audited/);
      git(['reset', '-q', '--hard', 'HEAD~2'], f.dir);
      assert.match(await auditReuseLine({ env: env(f.dir), cwd: f.dir, readConvergence: converged }), /^none .*1 audited patch\(es\) are not in the push/);
    } finally { rmrf(f.dir); }
  });
  it('a marker with no audited sha cannot be compared: the tree rule only, with the v12 wording', async () => {
    const f = featureRepo();
    try {
      writeMarker(f.dir, f.tip(), { auditedSha: undefined });
      rebaseOntoMovedMain(f);
      assert.match(await auditReuseLine({ env: env(f.dir), cwd: f.dir, readConvergence: converged }), /^none the last audited tree \([0-9a-f]{12}\) is not the pushed tree \([0-9a-f]{12}\)$/);
    } finally { rmrf(f.dir); }
  });
  it('an audit of an UNCOMMITTED tree (auditedSha is only the parent) proves nothing about that commit\'s patches -> none', async () => {
    const f = featureRepo();
    try {
      const parent = f.tip();
      f.put('src/dirty.txt', 'only in the working tree when audited\n');
      const dirtyTree = git(['write-tree'], f.dir);
      writeMarker(f.dir, parent, { auditedTree: dirtyTree });
      f.put('src/other.txt', 'a different commit than what was audited\n');
      git(['commit', '-q', '-m', 'then committed differently'], f.dir);
      assert.match(await auditReuseLine({ env: env(f.dir), cwd: f.dir, readConvergence: converged }), /^none .*not range-diff-equivalent.*uncommitted changes on top/);
    } finally { rmrf(f.dir); }
  });
  it('an equivalent branch whose run did not converge still re-runs', async () => {
    const f = featureRepo();
    try {
      writeMarker(f.dir, f.tip());
      rebaseOntoMovedMain(f);
      assert.match(await auditReuseLine({ env: env(f.dir), cwd: f.dir, readConvergence: async () => ({ convergence: { roundConvergedAfter: null }, why: null }) }), /^none .*audited the same patches but did not converge/);
    } finally { rmrf(f.dir); }
  });
  it('an unresolvable default ref (no origin/main) is "cannot tell", never equivalent', async () => {
    const f = featureRepo();
    try {
      writeMarker(f.dir, f.tip());
      rebaseOntoMovedMain(f);
      git(['update-ref', '-d', 'refs/remotes/origin/main'], f.dir);
      assert.match(await auditReuseLine({ env: { AUDIT_PUSH_RANGE_BASE: git(['rev-parse', 'HEAD~1'], f.dir), AUDIT_PUSH_RANGE_HEAD: git(['rev-parse', 'HEAD'], f.dir) }, cwd: f.dir, readConvergence: converged }), /^none .*default ref origin\/main does not resolve/);
    } finally { rmrf(f.dir); }
  });
});

// ── B. no plan ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('classifyNoPlanPush / decideNoPlanGate - nothing to select is UNMEASURED unless nothing needed auditing', () => {
  it('a code push is UNMEASURED: refused by default, naming the files, the cause and the one override', () => {
    const d = decideNoPlanGate({ files: ['src/a.js', 'docs/readme.md'], env: {} });
    assert.equal(d.allow, false);
    const text = d.lines.join('\n');
    assert.match(text, /UNMEASURED: no plan was selected for this push \(no single active plan could be chosen: none is active, or several are and the push does not single one out\).*1 code file\(s\) in the push \(src\/a\.js\)/);
    assert.match(text, /AUDIT_PREPUSH_ALLOW_UNMEASURED=1/);
    assert.doesNotMatch(text, /noise/i);
  });
  it('the override value must be exactly 1, and it says so in the output', () => {
    for (const v of ['0', 'true', '', 'yes']) assert.equal(decideNoPlanGate({ files: ['a.js'], env: { [UNMEASURED_OVERRIDE_ENV]: v } }).allow, false, v);
    const d = decideNoPlanGate({ files: ['a.js'], env: { [UNMEASURED_OVERRIDE_ENV]: '1' } });
    assert.equal(d.allow, true);
    assert.match(d.lines.join('\n'), /push ALLOWED UNMEASURED because AUDIT_PREPUSH_ALLOW_UNMEASURED=1/);
  });
  it('EXEMPT (the directions it must NOT fire): sync-bookkeeping-only, docs-only, and a mix of the two', () => {
    assert.equal(classifyNoPlanPush({ files: ['.sync-receipt.json', 'scripts/.sync-owned.json'] }).exempt, true);
    assert.equal(classifyNoPlanPush({ files: ['docs/a.md', 'README.md', 'notes/x.TXT', 'docs/b.mdx'] }).exempt, true);
    assert.equal(classifyNoPlanPush({ files: ['.sync-receipt.json', 'docs/a.md'] }).exempt, true);
    assert.equal(decideNoPlanGate({ files: ['docs/a.md'], env: {} }).allow, true);
    assert.match(decideNoPlanGate({ files: ['docs/a.md'], env: {} }).lines.join('\n'), /only documentation/);
  });
  it('docs-ness is by EXTENSION only: a script or JSON under docs/ is code, and bookkeeping next to code is code', () => {
    assert.equal(classifyNoPlanPush({ files: ['docs/gen.mjs'] }).exempt, false);
    assert.equal(classifyNoPlanPush({ files: ['docs/data.json'] }).exempt, false);
    assert.equal(classifyNoPlanPush({ files: ['.sync-receipt.json', 'scripts/x.mjs'] }).exempt, false);
    assert.equal(classifyNoPlanPush({ files: ['package.json', 'docs/a.md'] }).exempt, false);
  });
  it('an UNKNOWN file list is never "nothing changed": refused, and says it could not be established', () => {
    const d = decideNoPlanGate({ files: null, env: {} });
    assert.equal(d.allow, false);
    assert.match(d.lines.join('\n'), /file list could not be established/);
    assert.equal(classifyNoPlanPush({ files: null }).exempt, false);
  });
  it('a selector that FAILED is named as such, not as "none active"', () => {
    assert.match(decideNoPlanGate({ files: ['a.js'], env: {}, selectorFailed: true }).lines.join('\n'), /the plan selector failed/);
  });
  it('the exempt bookkeeping pair is the pair hook v7 short-circuits on: one spelling, two consumers', () => {
    for (const f of SYNC_BOOKKEEPING_FILES) {
      assert.ok(HOOK_BODY.includes(f.replace(/\./g, '\\.')), `${f} is missing from the hook's bookkeeping filter`);
    }
  });
  it('noPlanExit reads the real pushed range: docs -> 0, code -> 1, no range from git -> 1, override -> 0', () => {
    const dir = tmpDir('audit-noplan-');
    try {
      git(['init', '-q', '-b', 'main'], dir);
      git(['config', 'user.email', 'a@example.invalid'], dir);
      git(['config', 'user.name', 'A'], dir);
      fs.writeFileSync(path.join(dir, 'seed.txt'), 's\n'); git(['add', '.'], dir); git(['commit', '-q', '-m', 'seed'], dir);
      const rangeOf = () => ({ AUDIT_PUSH_RANGE_BASE: git(['rev-parse', 'HEAD~1'], dir), AUDIT_PUSH_RANGE_HEAD: git(['rev-parse', 'HEAD'], dir) });
      fs.writeFileSync(path.join(dir, 'a.md'), 'doc\n'); git(['add', '.'], dir); git(['commit', '-q', '-m', 'docs'], dir);
      const lines = []; const write = (l) => lines.push(l);
      assert.equal(noPlanExit({ env: rangeOf(), cwd: dir, write }), 0);
      assert.match(lines.join('\n'), /only documentation/);
      fs.writeFileSync(path.join(dir, 'b.mjs'), 'x\n'); git(['add', '.'], dir); git(['commit', '-q', '-m', 'code'], dir);
      lines.length = 0;
      assert.equal(noPlanExit({ env: rangeOf(), cwd: dir, write }), 1);
      assert.match(lines.join('\n'), /UNMEASURED.*b\.mjs/);
      assert.equal(noPlanExit({ env: {}, cwd: dir, write: () => {} }), 1, 'an inferred range may not prove the push is docs-only');
      assert.equal(noPlanExit({ env: { ...rangeOf(), [UNMEASURED_OVERRIDE_ENV]: '1' }, cwd: dir, write: () => {} }), 0);
    } finally { rmrf(dir); }
  });
});

describe('the real hook - a push the plan selector resolved no plan for', () => {
  function makeSource(ws, { selector = 'none' } = {}) {
    const root = path.join(ws, 'source-repo');
    const scripts = path.join(root, 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'sync-to-repos.mjs'), '// fixture\n');
    writeStepRunnerStub(scripts);
    fs.writeFileSync(path.join(scripts, 'check-plan-status.mjs'), [
      "const a = process.argv.slice(2);",
      "if (a.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }",
      `if (a.includes('--select')) { ${selector === 'crash' ? "console.error('malformed Status'); process.exit(1);" : 'process.exit(0);'} }`,
      'process.exit(0);', '',
    ].join('\n'));
    fs.writeFileSync(path.join(scripts, 'openai-audit.mjs'), "import fs from 'node:fs'; fs.writeFileSync('AUDIT_ARGV', 'called'); process.exit(0);\n");
    return root;
  }
  function consumer(ws) {
    const bare = path.join(ws, 'origin.git');
    const local = path.join(ws, 'local');
    git(['init', '--bare', '-q', '-b', 'main', bare]);
    git(['clone', '-q', bare, local]);
    git(['config', 'user.email', 'a@example.invalid'], local);
    git(['config', 'user.name', 'A'], local);
    fs.mkdirSync(path.join(local, 'docs', 'plans'), { recursive: true });
    fs.writeFileSync(path.join(local, 'docs', 'plans', 'done.md'), '# Plan\n\n- **Status**: Complete\n');
    git(['add', '.'], local);
    git(['commit', '-q', '-m', 'seed'], local);
    git(['push', '-q', 'origin', 'main'], local);
    const push = (rel, text) => {
      const base = git(['rev-parse', 'HEAD'], local);
      fs.mkdirSync(path.dirname(path.join(local, rel)), { recursive: true });
      fs.writeFileSync(path.join(local, rel), text);
      git(['add', rel], local);
      git(['commit', '-q', '-m', `touch ${rel}`], local);
      const head = git(['rev-parse', 'HEAD'], local);
      return `refs/heads/main ${head} refs/heads/main ${base}\n`;
    };
    return { local, push };
  }
  const run = (local, source, stdin, env = {}) => {
    const script = path.join(local, '.hook.sh');
    fs.writeFileSync(script, HOOK_BODY);
    const r = spawnSync('bash', [script, 'origin', 'https://example.invalid'], {
      cwd: local, encoding: 'utf-8', input: stdin, timeout: 120_000,
      env: { ...process.env, CLAUDE_AUDIT_LOOP_DIR: source, AUDIT_PREPUSH_BLOCK: '', AUDIT_PREPUSH_DISABLE: '', AUDIT_PREPUSH_ALLOW_UNMEASURED: '', ...env },
    });
    return { ...r, audited: fs.existsSync(path.join(local, 'AUDIT_ARGV')) };
  };

  it('RED then GREEN: a CODE push with no plan is refused as UNMEASURED (v12 exited 0 having measured nothing)', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const ws = tmpDir('hook-noplan-');
    try {
      const source = makeSource(ws);
      const c = consumer(ws);
      const got = run(c.local, source, c.push('src/app.mjs', 'x\n'));
      assert.equal(got.status, 1, got.stderr);
      assert.match(got.stderr, /UNMEASURED: no plan was selected for this push.*src\/app\.mjs/);
      assert.match(got.stderr, /AUDIT_PREPUSH_ALLOW_UNMEASURED=1/);
      assert.equal(got.audited, false);
    } finally { rmrf(ws); }
  });
  it('the named override lets the same push through, loudly, still without an audit', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const ws = tmpDir('hook-noplan-ovr-');
    try {
      const source = makeSource(ws);
      const c = consumer(ws);
      const got = run(c.local, source, c.push('src/app.mjs', 'x\n'), { AUDIT_PREPUSH_ALLOW_UNMEASURED: '1' });
      assert.equal(got.status, 0, got.stderr);
      assert.match(got.stderr, /push ALLOWED UNMEASURED because AUDIT_PREPUSH_ALLOW_UNMEASURED=1/);
      assert.equal(got.audited, false);
    } finally { rmrf(ws); }
  });
  it('EXEMPT: a docs-only push and a sync-bookkeeping-only push pass with no plan, saying why', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const ws = tmpDir('hook-noplan-exempt-');
    try {
      const source = makeSource(ws);
      const c = consumer(ws);
      const docs = run(c.local, source, c.push('docs/guide.md', 'words\n'));
      assert.equal(docs.status, 0, docs.stderr);
      assert.match(docs.stderr, /nothing a code audit reads: only documentation/);
      const book = run(c.local, source, c.push('.sync-receipt.json', '{}\n'));
      assert.equal(book.status, 0, book.stderr);
      assert.match(book.stderr, /nothing a code audit reads: only sync bookkeeping/);
      assert.equal(book.audited, false);
    } finally { rmrf(ws); }
  });
  it('a selector that CRASHES is no longer a silent pass: a code push is refused naming the selector failure', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const ws = tmpDir('hook-noplan-crash-');
    try {
      const source = makeSource(ws, { selector: 'crash' });
      const c = consumer(ws);
      const got = run(c.local, source, c.push('src/app.mjs', 'x\n'));
      assert.equal(got.status, 1, got.stderr);
      assert.match(got.stderr, /the plan selector failed/);
    } finally { rmrf(ws); }
  });
  it('a source checkout whose step runner lacks no-plan is refused outright (a v13 hook never runs half-capable)', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const ws = tmpDir('hook-noplan-oldrunner-');
    try {
      const source = makeSource(ws);
      fs.writeFileSync(path.join(source, 'scripts', 'prepush-step.mjs'), [
        "const a = process.argv.slice(2);",
        "if (a.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }",
        "if (a[0] === 'capabilities') { console.log('run own-files audit-outcome audit-reuse audit-budget'); process.exit(0); }",
        'process.exit(2);', '',
      ].join('\n'));
      const c = consumer(ws);
      const got = run(c.local, source, c.push('src/app.mjs', 'x\n'));
      assert.equal(got.status, 1, got.stderr);
      assert.match(got.stderr, /predates hook v13/);
    } finally { rmrf(ws); }
  });
});

// ── C. the budget ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('auditBudgetSec - refit from the store\'s measured durations', () => {
  it('600s + 30s per file; lines are unmeasured evidence and are not an input', () => {
    assert.equal(auditBudgetSec({ files: 3, lines: 80 }).budgetSec, 690);
    assert.equal(auditBudgetSec({ files: 3, lines: 80 }).budgetSec, auditBudgetSec({ files: 3, lines: 800000 }).budgetSec);
    assert.equal(auditBudgetSec({ files: 0, lines: 0 }).budgetSec, BUDGET.floorSec);
  });
  it('REGRESSION (storyline Phase 6): 23 files / 1208 lines took 882s - v12\'s formula gave it 881s, the refit gives real headroom', () => {
    assert.ok(auditBudgetSec({ files: 23, lines: 1208 }).budgetSec >= 882 * 1.25);
    assert.ok(300 + 20 * 23 + 0.1 * 1208 < 882, 'negative control: the v12 formula is the one that was too tight');
  });
  it('covers the measured round-1 population: p95 duration by file count sits inside the budget with 25% headroom', () => {
    // Measured 2026-10-24 (store audit_runs, round-1 code audits, 610 rows): [files, p95 seconds].
    for (const [files, p95] of [[2, 148], [5, 349], [8, 559], [13, 697], [20, 837], [32, 855], [60, 1167], [125, 1823]]) {
      const b = auditBudgetSec({ files, lines: 0 }).budgetSec;
      assert.ok(b >= p95 * 1.25 || b === BUDGET.capSec, `${files} files: budget ${b}s vs p95 ${p95}s`);
    }
  });
  it('stays bounded: capped, and says so', () => {
    const huge = auditBudgetSec({ files: 5000, lines: 0 });
    assert.equal(huge.budgetSec, BUDGET.capSec);
    assert.match(huge.basis, /capped at/);
  });
});

describe('hook v13 housekeeping', () => {
  it('the version was bumped so consumers re-install, and the capability list the hook demands matches the runner\'s', async () => {
    assert.ok(Number(HOOK_BODY.match(/# hook-version: (\d+)/)[1]) >= 13);
    const { CAPABILITIES } = await import('../scripts/prepush-step.mjs');
    for (const cap of ['audit-outcome', 'audit-reuse', 'audit-budget', 'no-plan']) {
      assert.ok(CAPABILITIES.includes(cap), cap);
      assert.ok(HOOK_BODY.includes(cap), cap);
    }
  });
  it('the fail-closed-on-signal block is untouched by this change (byte-identical in both hooks is pinned elsewhere; here: still present once)', () => {
    assert.equal(HOOK_BODY.split('# >>> fail-closed-on-signal >>>').length - 1, 1);
    assert.equal(HOOK_BODY.split('# <<< fail-closed-on-signal <<<').length - 1, 1);
  });
});

// ── audit round 1: renames, and the budget's input contract ───────────────────────────────────────────────────────────────────────
describe('no-plan push - a rename lists BOTH endpoints (a code file renamed to a docs path is not docs-only)', () => {
  it('noPlanExit refuses src/app.mjs -> docs/app.md; the same content merely ADDED as docs is exempt (control)', () => {
    const dir = tmpDir('audit-noplan-rename-');
    try {
      git(['init', '-q', '-b', 'main'], dir);
      git(['config', 'user.email', 'a@example.invalid'], dir);
      git(['config', 'user.name', 'A'], dir);
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'app.mjs'), 'export const answer = 42;\nexport const more = "enough lines so git sees a rename";\n');
      git(['add', '.'], dir); git(['commit', '-q', '-m', 'seed'], dir);
      const base = git(['rev-parse', 'HEAD'], dir);
      fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
      git(['mv', 'src/app.mjs', 'docs/app.md'], dir); git(['commit', '-q', '-m', 'rename code to docs'], dir);
      const env = { AUDIT_PUSH_RANGE_BASE: base, AUDIT_PUSH_RANGE_HEAD: git(['rev-parse', 'HEAD'], dir) };
      // instrument check: default rename detection reports ONLY the destination - the blind spot this closes
      assert.equal(git(['diff', '--name-only', `${base}..HEAD`], dir), 'docs/app.md');
      const lines = [];
      assert.equal(noPlanExit({ env, cwd: dir, write: (l) => lines.push(l) }), 1);
      assert.match(lines.join('\n'), /src\/app\.mjs/);
      // control: adding a doc (no code file touched) is exempt
      const base2 = git(['rev-parse', 'HEAD'], dir);
      fs.writeFileSync(path.join(dir, 'docs', 'extra.md'), 'words\n'); git(['add', '.'], dir); git(['commit', '-q', '-m', 'docs only'], dir);
      assert.equal(noPlanExit({ env: { AUDIT_PUSH_RANGE_BASE: base2, AUDIT_PUSH_RANGE_HEAD: git(['rev-parse', 'HEAD'], dir) }, cwd: dir, write: () => {} }), 0);
    } finally { rmrf(dir); }
  });
});

describe('auditBudgetSec - the input contract is the file count', () => {
  it('files alone is enough (no fall back to the floor), a missing/garbage lines value only drops it from the basis, and unknown files keeps the floor', () => {
    assert.equal(auditBudgetSec({ files: 23 }).budgetSec, 1290);
    assert.equal(auditBudgetSec({ files: 23, lines: null }).budgetSec, 1290);
    assert.equal(auditBudgetSec({ files: 23, lines: -5 }).budgetSec, 1290);
    assert.equal(auditBudgetSec({ files: 23 }).basis, '23 file(s)');
    assert.equal(auditBudgetSec({ files: 23, lines: 1208 }).basis, '23 file(s), 1208 changed line(s)');
    for (const bad of [{}, { files: null }, { files: NaN }, { files: -1 }]) assert.deepEqual(auditBudgetSec(bad), { budgetSec: BUDGET.floorSec, basis: 'diff size unknown' });
  });
});

describe('auditReuseLine - the REAL runner path reads patch bytes losslessly (audit round 4)', () => {
  it('a rebase that changes ONLY an invalid UTF-8 byte (0xff -> 0xfe) is NOT reused, through the same code the hook runs', async () => {
    const dir = tmpDir('audit-reuse-bytes-');
    try {
      git(['init', '-q', '-b', 'main'], dir);
      git(['config', 'user.email', 'a@example.invalid'], dir);
      git(['config', 'user.name', 'A'], dir);
      fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n'); git(['add', '.'], dir); git(['commit', '-q', '-m', 'seed'], dir);
      git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], dir);
      git(['checkout', '-q', '-b', 'feature'], dir);
      const put = (bytes) => { fs.writeFileSync(path.join(dir, 'blob.dat'), Buffer.from(bytes)); git(['add', 'blob.dat'], dir); };
      put([0x61, 0xff, 0x0a]); git(['commit', '-q', '-m', 'audited'], dir);
      const audited = git(['rev-parse', 'HEAD'], dir);
      fs.mkdirSync(path.join(dir, '.audit'), { recursive: true });
      const marker = { runId: 'audit-run-0042', auditedSha: audited, auditedTree: git(['rev-parse', `${audited}^{tree}`], dir), ts: new Date().toISOString() };
      fs.writeFileSync(path.join(dir, '.audit', 'last-audit-run.json'), JSON.stringify(marker));
      const converged = async () => ({ convergence: { roundConvergedAfter: 2 }, why: null });
      const env = () => ({ AUDIT_PUSH_RANGE_BASE: git(['rev-parse', 'origin/main'], dir), AUDIT_PUSH_RANGE_HEAD: git(['rev-parse', 'HEAD'], dir) });
      // the pushed branch: the same change with the one bad byte different, on a moved main (so the tree differs and equivalence is asked)
      git(['checkout', '-q', 'main'], dir);
      fs.writeFileSync(path.join(dir, 'moved.txt'), 'main moved\n'); git(['add', '.'], dir); git(['commit', '-q', '-m', 'main moves'], dir);
      git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], dir);
      git(['checkout', '-q', '-b', 'pushed'], dir);
      put([0x61, 0xfe, 0x0a]); git(['commit', '-q', '-m', 'same change, different bad byte'], dir);
      assert.match(await auditReuseLine({ env: env(), cwd: dir, readConvergence: converged }), /^none .*patches differ/);
      // control: the identical bytes, cherry-picked, ARE reused - so the refusal above is the byte difference and nothing else
      git(['checkout', '-q', 'main'], dir);
      git(['checkout', '-q', '-b', 'picked'], dir);
      git(['cherry-pick', audited], dir);
      assert.equal(await auditReuseLine({ env: env(), cwd: dir, readConvergence: converged }), 'reuse-equivalent audit-run-0042 2 1');
    } finally { rmrf(dir); }
  });
});

describe('the no-plan refusal names the way out (p-1ad3 (a))', async () => {
  const { PLAN_OVERRIDE_ENV } = await import('../scripts/lib/prepush-audit-gate.mjs');
  const refusal = (extra = {}) => decideNoPlanGate({ files: ['src/a.js'], env: {}, ...extra }).lines.join('\n');

  it('puts AUDIT_PREPUSH_PLAN first, as a runnable command, before the UNMEASURED override', () => {
    const text = refusal();
    assert.equal(PLAN_OVERRIDE_ENV, 'AUDIT_PREPUSH_PLAN');
    assert.match(text, /AUDIT_PREPUSH_PLAN=docs\/plans\/<plan>\.md git push/);
    assert.ok(text.indexOf('AUDIT_PREPUSH_PLAN') < text.indexOf(UNMEASURED_OVERRIDE_ENV), 'the measured fix is offered before the unmeasured one');
  });

  it('an override that points at a missing file is named as the reason (it selects nothing)', () => {
    const text = refusal({ env: { AUDIT_PREPUSH_PLAN: 'docs/plans/nope.md' }, exists: () => false });
    assert.match(text, /AUDIT_PREPUSH_PLAN=docs\/plans\/nope\.md does not exist/);
  });

  it('an override that exists is not blamed, and the generic reason is honest about both ways to get here', () => {
    const text = refusal({ env: { AUDIT_PREPUSH_PLAN: 'docs/plans/real.md' }, exists: () => true });
    assert.doesNotMatch(text, /does not exist/);
    assert.match(text, /none is active, or several are and the push does not single one out/);
  });
});
