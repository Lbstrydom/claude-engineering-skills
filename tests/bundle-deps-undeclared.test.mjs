/**
 * @fileoverview The sync names every REQUIRED bundle package the consumer's
 * package.json does not durably declare.
 *
 * ## The defect
 *
 * `picomatch` became a required bundle package (importer lib/glob.mjs) and
 * nothing told storyline at sync time; two chips crashed on `Cannot find
 * package 'picomatch'` and it was hand-installed. Both existing probes ask
 * whether a package is PRESENT (a node_modules path; `require.resolve`), and a
 * hoisted or hand-installed copy satisfies both — until the next install drops
 * it. Measured 2026-10-13: storyline, wine-cellar-app and ai-organiser all
 * import picomatch without declaring it.
 *
 * Every fixture here is a scratch consumer directory plus a scratch bundle
 * (`lib/bundle-deps.json`), so the obligation is stated by the test rather than
 * inherited from whatever this repo's generated file says today.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  assessDeclaredBundleDeps, formatUndeclaredBundleDeps, readCommittedPackageJson, reportDeclaredBundleDeps,
} from '../scripts/lib/install/bundle-deps.mjs';
import { sanitizeGitEnv } from '../scripts/lib/git-env-sanitize.mjs';

let tmp;
let consumer;
let bundle;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-decl-')));
  consumer = path.join(tmp, 'consumer');
  bundle = path.join(tmp, 'bundle');
  fs.mkdirSync(consumer, { recursive: true });
  fs.mkdirSync(path.join(bundle, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'lib', 'bundle-deps.json'), JSON.stringify({
    packages: [
      { name: 'picomatch', required: true, importers: ['scripts/.claude-skills/lib/glob.mjs'] },
      { name: 'zod', required: true, importers: ['scripts/.claude-skills/lib/schemas.mjs'] },
      { name: 'playwright', required: false, importers: ['scripts/.claude-skills/check-setup.mjs'] },
    ],
  }));
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

const pkgJson = (body, root = consumer) => fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(body, null, 2));
/** HEAD agrees with the working tree unless a test says otherwise. */
const sameAsWorkingTree = (root) => ({ known: true, pkg: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) });
const assess = (io = { readCommitted: sameAsWorkingTree }) => assessDeclaredBundleDeps(consumer, bundle, io);
const names = (items) => items.map((p) => p.name);

describe('assessDeclaredBundleDeps — the state table', () => {
  it('names a required package declared nowhere, with its importer (storyline)', () => {
    pkgJson({ name: 'c', devDependencies: { zod: '^4' } });
    const r = assess();
    assert.equal(r.measured, true);
    assert.deepEqual(r.undeclared, [{ name: 'picomatch', importer: 'scripts/.claude-skills/lib/glob.mjs' }]);
    assert.equal(r.command, 'npm i -D picomatch');
  });

  it('dependencies and devDependencies both count; an undeclared OPTIONAL bundle package is not named', () => {
    pkgJson({ name: 'c', dependencies: { picomatch: '^4' }, devDependencies: { zod: '^4' } });
    const r = assess();
    assert.deepEqual([r.undeclared, r.optionalOnly, r.uncommitted], [[], [], []]);
    assert.equal(r.command, null);
  });

  it('optionalDependencies-only is its own bucket, never clean', () => {
    pkgJson({ name: 'c', optionalDependencies: { picomatch: '^4' }, devDependencies: { zod: '^4' } });
    const r = assess();
    assert.deepEqual(names(r.optionalOnly), ['picomatch']);
    assert.deepEqual(r.undeclared, []);
    assert.equal(r.command, 'npm i -D picomatch');
  });

  it('listed in BOTH dependencies and optionalDependencies → optional wins, never clean (npm precedence)', () => {
    pkgJson({ name: 'c', dependencies: { picomatch: '^4' }, optionalDependencies: { picomatch: '^4' }, devDependencies: { zod: '^4' } });
    const r = assess();
    assert.deepEqual(names(r.optionalOnly), ['picomatch']);
    assert.match(formatUndeclaredBundleDeps(r).lines.join('\n'), /optional overrides any same-name dependencies entry/);
  });

  it('HEAD lists it in both sections → the committed declaration is not durable either', () => {
    pkgJson({ name: 'c', devDependencies: { picomatch: '^4', zod: '^4' } });
    const r = assess({ readCommitted: () => ({ known: true, pkg: {
      devDependencies: { picomatch: '^4', zod: '^4' }, optionalDependencies: { picomatch: '^4' } } }) });
    assert.deepEqual(names(r.uncommitted), ['picomatch']);
  });

  it('peerDependencies does not count as a declaration', () => {
    pkgJson({ name: 'c', peerDependencies: { picomatch: '^4' }, devDependencies: { zod: '^4' } });
    assert.deepEqual(names(assess().undeclared), ['picomatch']);
  });

  it('declared in the working tree but not in HEAD → uncommitted', () => {
    pkgJson({ name: 'c', devDependencies: { picomatch: '^4', zod: '^4' } });
    const r = assess({ readCommitted: () => ({ known: true, pkg: { devDependencies: { zod: '^4' } } }) });
    assert.deepEqual(names(r.uncommitted), ['picomatch']);
    assert.equal(r.committedKnown, true);
  });

  it('HEAD declared it but the working tree removed it → undeclared, not clean (a pending removal)', () => {
    pkgJson({ name: 'c', devDependencies: { zod: '^4' } });
    const r = assess({ readCommitted: () => ({ known: true, pkg: { devDependencies: { picomatch: '^4', zod: '^4' } } }) });
    assert.deepEqual(names(r.undeclared), ['picomatch']);
  });

  it('HEAD unreadable → every working-tree declaration is uncommitted-unknown, and says so', () => {
    pkgJson({ name: 'c', devDependencies: { picomatch: '^4', zod: '^4' } });
    const r = assess({ readCommitted: () => ({ known: false }) });
    assert.deepEqual(names(r.uncommitted), ['picomatch', 'zod']);
    assert.equal(r.committedKnown, false);
    assert.match(formatUndeclaredBundleDeps(r).lines.join('\n'), /HEAD could not be read/);
  });

  it('the remedy uses the consumer\'s own manager (pnpm)', () => {
    pkgJson({ name: 'c', packageManager: 'pnpm@11.21.0', devDependencies: { zod: '^4' } });
    assert.match(assess().command, /^pnpm add -D .*picomatch$/);
  });

  it('an ambiguous manager gets NO command — never a guess', () => {
    pkgJson({ name: 'c', devDependencies: { zod: '^4' } });
    fs.writeFileSync(path.join(consumer, 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(consumer, 'pnpm-lock.yaml'), '');
    const r = assess();
    assert.equal(r.command, null);
    assert.match(r.pmNote, /ambiguous/);
    assert.match(formatUndeclaredBundleDeps(r).lines.join('\n'), /ambiguous/);
  });
});

describe('unmeasurable is said, never a silent zero', () => {
  for (const [label, setup, reason] of [
    ['no package.json', () => {}, /no package\.json/],
    ['package.json does not parse', () => fs.writeFileSync(path.join(consumer, 'package.json'), '{ nope'), /does not parse/],
    ['bundle-deps.json missing', () => { pkgJson({ name: 'c' }); fs.rmSync(path.join(bundle, 'lib', 'bundle-deps.json')); }, /bundle-deps\.json/],
  ]) {
    it(label, () => {
      setup();
      const r = assess();
      assert.equal(r.measured, false);
      assert.match(r.reason, reason);
      const out = formatUndeclaredBundleDeps(r);
      assert.match(out.lines.join('\n'), /could not check/);
      assert.match(out.summary, /^not checked/);
    });
  }
});

describe('formatUndeclaredBundleDeps', () => {
  it('a clean result prints one confirmation and NO summary', () => {
    pkgJson({ name: 'c', devDependencies: { picomatch: '^4', zod: '^4' } });
    const out = formatUndeclaredBundleDeps(assess());
    assert.deepEqual(out, { lines: ['  ✓ package.json declares all 2 required bundle packages'], summary: null });
  });

  it('names each package on its own line with the importer, then the command; summary lists them', () => {
    pkgJson({ name: 'c' });
    const out = formatUndeclaredBundleDeps(assess());
    const text = out.lines.join('\n');
    assert.match(text, /package\.json does not declare 2 required bundle package/);
    assert.match(text, /^ {4}- picomatch \(imported by scripts\/\.claude-skills\/lib\/glob\.mjs\)$/m);
    assert.match(text, /^ {4}- zod \(imported by /m);
    assert.match(text, /declare them as devDependencies: npm i -D picomatch zod$/m);
    // Declaring a bundle-only package trips knip/depcheck "unused" in consumers
    // that scan package.json, because its importers are gitignored.
    assert.match(text, /add them to your knip\/depcheck ignore list/);
    assert.equal(out.summary, 'picomatch, zod');
  });
});

describe('readCommittedPackageJson — real git', () => {
  const git = (args, cwd, env = sanitizeGitEnv(cwd)) => execFileSync('git', args, { cwd, env, encoding: 'utf-8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const initRepo = (dir, body) => {
    fs.mkdirSync(dir, { recursive: true });
    git(['init', '-q', '--initial-branch=main'], dir);
    git(['config', 'user.email', 'test@example.invalid'], dir);
    git(['config', 'user.name', 'Decl Test'], dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(body));
    git(['add', 'package.json'], dir);
    git(['commit', '-q', '-m', 'init', '--no-gpg-sign'], dir);
  };

  it('reads THIS consumer\'s HEAD even when GIT_DIR points at another repo (the pre-push hook case)', () => {
    const source = path.join(tmp, 'source');
    initRepo(source, { name: 'SOURCE', devDependencies: { picomatch: '^4' } });
    initRepo(consumer, { name: 'CONSUMER' });
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = path.join(source, '.git');
    process.env.GIT_WORK_TREE = source;
    try {
      const r = readCommittedPackageJson(consumer);
      assert.equal(r.known, true);
      assert.equal(r.pkg.name, 'CONSUMER');
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it('a consumer nested below its repository top level reads ITS manifest, not the top-level one', () => {
    const top = path.join(tmp, 'mono');
    initRepo(top, { name: 'TOP' });
    const nested = path.join(top, 'packages', 'app');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'package.json'), JSON.stringify({ name: 'NESTED' }));
    git(['add', 'packages/app/package.json'], top);
    git(['commit', '-q', '-m', 'nested', '--no-gpg-sign'], top);
    const r = readCommittedPackageJson(nested);
    assert.equal(r.known, true);
    assert.equal(r.pkg.name, 'NESTED');
  });

  it('not a git repository → known:false, never another repo\'s data', () => {
    pkgJson({ name: 'c' });
    assert.deepEqual(readCommittedPackageJson(consumer), { known: false });
  });

  it('end to end: a committed, declared consumer reports clean through the production reader', () => {
    initRepo(consumer, { name: 'c', devDependencies: { picomatch: '^4', zod: '^4' } });
    assert.equal(reportDeclaredBundleDeps(consumer, bundle).summary, null);
  });
});
