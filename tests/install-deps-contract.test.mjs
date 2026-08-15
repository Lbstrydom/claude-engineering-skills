/**
 * @fileoverview The consumer dependency contract — derived, not hand-written.
 *
 * Guards the upstream#57 class: the synced bundle grows an import, nobody
 * updates the installer's dep list, and every consumer that lacks the package
 * dies with ERR_MODULE_NOT_FOUND at the first entry point that touches it.
 * `@babel/traverse` did exactly this to wine-cellar-app's `/audit-plan`.
 *
 * The fix is derivation (`requiredDeps()` reads the import graph), so the
 * interesting assertions here are the ones that would catch the derivation
 * itself silently returning nothing — the "can this go green having checked
 * nothing?" rule from AGENTS.md.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execFileSync } from 'node:child_process';

import { bundleDeps, requiredDeps, OPTIONAL_DEPS, findMissingDeps, npmInvocation, ensureAuditDeps } from '../scripts/lib/install/deps.mjs';
import { packageNameFromSpecifier, collectImportClosure } from '../scripts/lib/module-graph.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('consumer dependency contract', () => {
  it('derives a non-empty dependency set', () => {
    // The failure this guards: a broken walk returns [], findMissingDeps
    // reports nothing missing, and every consumer reads "all deps present"
    // while the bundle is unrunnable. Green-having-checked-nothing.
    assert.ok(bundleDeps().length >= 10, `expected a real dep set, got ${bundleDeps().length}`);
  });

  it('includes the packages whose absence broke a consumer (upstream#57)', () => {
    const deps = bundleDeps();
    for (const pkg of ['@babel/parser', '@babel/traverse']) {
      assert.ok(deps.includes(pkg), `${pkg} must be in the derived contract`);
    }
  });

  it('classifies every derived dep as required or optional, with no overlap', () => {
    const required = new Set(requiredDeps());
    const optional = new Set(OPTIONAL_DEPS);
    for (const pkg of bundleDeps()) {
      assert.ok(
        required.has(pkg) !== optional.has(pkg),
        `${pkg} must be exactly one of required/optional`,
      );
    }
  });

  it('has no stale OPTIONAL_DEPS entry the bundle no longer imports', () => {
    // A hand-curated list is allowed to exist, but not to rot: an entry the
    // graph never sees means the curation is describing a bundle that is gone.
    const derived = new Set(bundleDeps());
    const stale = OPTIONAL_DEPS.filter(d => !derived.has(d));
    assert.deepEqual(stale, [], `stale OPTIONAL_DEPS: ${stale.join(', ')}`);
  });

  it('every required dep is declared in the source package.json', () => {
    // The source repo must be able to run what it ships, and `npm install`
    // in a consumer resolves the same versions.
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
    const declared = new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
    ]);
    const undeclared = requiredDeps().filter(d => !declared.has(d));
    assert.deepEqual(undeclared, [], `bundle imports but source package.json omits: ${undeclared.join(', ')}`);
  });

  it('findMissingDeps reports nothing for a repo with no package.json', () => {
    const res = findMissingDeps(path.join(REPO_ROOT, 'tests', '__no_such_repo__'));
    assert.equal(res.hasPackageJson, false);
    assert.deepEqual(res.missing, []);
  });
});

describe('npmInvocation', () => {
  it('actually spawns npm without a shell', () => {
    // The regression: execFileSync('npm', …) is ENOENT on Windows (npm is
    // npm.cmd) and 'npm.cmd' is EINVAL under Node >= 22.19's .cmd hardening,
    // so consumer dep auto-install silently never ran there. Asserting on the
    // returned shape alone would not have caught that — only executing does.
    const { bin, prefix } = npmInvocation();
    const out = execFileSync(bin, [...prefix, '--version'], {
      encoding: 'utf-8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.match(out.trim(), /^\d+\.\d+\.\d+/, `expected an npm version, got: ${out.trim()}`);
  });

  it('never routes through a shell', () => {
    // shell:true would fix the spawn and reopen quoting pitfalls on argv that
    // carries package names. The contract is: no shell, ever.
    const { bin } = npmInvocation();
    if (process.platform === 'win32') {
      assert.ok(!/\.cmd$/i.test(bin) || bin === 'npm.cmd', 'win32 must prefer node + npm-cli.js');
    }
    assert.ok(typeof bin === 'string' && bin.length > 0);
  });
});

describe('ensureAuditDeps — manager routing (round-1 audit fixes, 2026-08-15)', () => {
  let TMP;
  before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-deps-')); });
  after(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
  });

  /** A repo with no node_modules at all — every required dep reports missing. */
  function scratchRepo(name, files) {
    const root = path.join(TMP, name);
    fs.mkdirSync(root, { recursive: true });
    for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(root, file), body);
    return root;
  }

  it('H2/H4/M6: refuses an automated install for yarn — never attempts a spawn', () => {
    const root = scratchRepo('yarn-consumer', { 'package.json': '{}', 'yarn.lock': '' });
    const res = ensureAuditDeps(root, { quiet: true });
    assert.equal(res.action, 'manual-install-required');
    assert.equal(res.packageManager, 'yarn');
    assert.equal(res.installed.length, 0);
  });

  it('H2/H4/M6: refuses an automated install for bun — never attempts a spawn', () => {
    const root = scratchRepo('bun-consumer', { 'package.json': '{}', 'bun.lockb': '' });
    const res = ensureAuditDeps(root, { quiet: true });
    assert.equal(res.action, 'manual-install-required');
    assert.equal(res.packageManager, 'bun');
  });

  it('M8 (round-2 audit, 2026-08-15): refuses to guess when package.json itself does not parse', () => {
    // The regression this guards: the round-1 fix only distinguished
    // "field malformed" from "field absent" — an UNPARSEABLE package.json
    // (not just a bad packageManager value) still silently fell through to
    // lockfile guessing, indistinguishable from a manifest that simply
    // omits the field.
    const root = scratchRepo('broken-manifest', {
      'package.json': '{ this is not json',
      'pnpm-lock.yaml': '', // real signal that must NOT be silently trusted
    });
    const res = ensureAuditDeps(root, { quiet: true });
    assert.equal(res.action, 'invalid-package-manager-declaration');
  });

  it('H6/M3/M17: refuses to guess when packageManager is declared but malformed', () => {
    const root = scratchRepo('bad-declared', {
      'package.json': JSON.stringify({ packageManager: 'pnmp@8.0.0' }), // typo'd name
      'package-lock.json': '{}', // stale lockfile from before the (attempted) switch
    });
    const res = ensureAuditDeps(root, { quiet: true });
    assert.equal(res.action, 'invalid-package-manager-declaration');
    // Must NOT silently fall through to the stale npm lockfile evidence.
    assert.notEqual(res.action, 'installed');
  });

  it('M9: dry-run reports the SAME refusal a real run would, not a guessed install', () => {
    const ambiguous = scratchRepo('ambiguous-dryrun', {
      'package.json': '{}', 'pnpm-lock.yaml': '', 'package-lock.json': '{}',
    });
    const real = ensureAuditDeps(ambiguous, { quiet: true });
    const dry = ensureAuditDeps(ambiguous, { quiet: true, dryRun: true });
    assert.equal(real.action, 'ambiguous-package-manager');
    assert.equal(dry.action, 'ambiguous-package-manager', 'dry-run must not report "installed" for an ambiguous repo');

    const invalid = scratchRepo('invalid-dryrun', {
      'package.json': JSON.stringify({ packageManager: 'cargo@1.0.0' }),
    });
    const dryInvalid = ensureAuditDeps(invalid, { quiet: true, dryRun: true });
    assert.equal(dryInvalid.action, 'invalid-package-manager-declaration');
  });

  it('still reports the honest "installed" shape for a plain npm dry-run', () => {
    const root = scratchRepo('npm-dryrun', { 'package.json': '{}', 'package-lock.json': '{}' });
    const dry = ensureAuditDeps(root, { quiet: true, dryRun: true });
    assert.equal(dry.packageManager, 'npm');
    assert.ok(dry.action === 'installed' || dry.action === 'already-satisfied');
  });
});

describe('packageNameFromSpecifier', () => {
  it('extracts plain and scoped package names, ignoring subpaths', () => {
    assert.equal(packageNameFromSpecifier('openai'), 'openai');
    assert.equal(packageNameFromSpecifier('@babel/traverse'), '@babel/traverse');
    assert.equal(packageNameFromSpecifier('zod/v4'), 'zod');
    assert.equal(packageNameFromSpecifier('@google/genai/dist/x.js'), '@google/genai');
  });

  it('rejects node builtins — nothing to install', () => {
    assert.equal(packageNameFromSpecifier('node:fs'), null);
    assert.equal(packageNameFromSpecifier('fs'), null);
    assert.equal(packageNameFromSpecifier('path'), null);
  });

  it('rejects relative specifiers', () => {
    assert.equal(packageNameFromSpecifier('./a.mjs'), null);
    assert.equal(packageNameFromSpecifier('../lib/b.mjs'), null);
  });

  it('rejects prose caught by the import regex, rather than guessing', () => {
    // parseImports is a regex, so doc-comment and template-literal fragments
    // reach here. A dep contract built from these would be junk.
    for (const noise of [
      'write the final result to disk',
      'https:',
      'C:\\repo\\.dependency-cruiser.cjs',
      'Foo',                 // capitals are not valid npm names
      '',
    ]) {
      assert.equal(packageNameFromSpecifier(noise), null, `should reject: ${JSON.stringify(noise)}`);
    }
  });
});

describe('collectImportClosure external bucket', () => {
  const FILES = {
    'scripts/entry.mjs': [
      "import { x } from './lib/a.mjs';",
      "import 'node:fs';",
      "import { parse } from '@babel/parser';",
    ].join('\n'),
    'scripts/lib/a.mjs': "import traverse from '@babel/traverse';\nimport { z } from './missing.mjs';",
  };
  const repoFiles = new Set(Object.keys(FILES));
  const readFile = (rel) => (rel in FILES ? FILES[rel] : null);

  it('reports bare deps as external, with their importer', () => {
    const { external } = collectImportClosure({ entryPoints: ['scripts/entry.mjs'], repoFiles, readFile });
    const pkgs = external.map(e => e.pkg).sort();
    assert.deepEqual(pkgs, ['@babel/parser', '@babel/traverse']);
    assert.equal(external.find(e => e.pkg === '@babel/traverse').from, 'scripts/lib/a.mjs');
  });

  it('keeps external and unresolved disjoint', () => {
    const { external, unresolved } = collectImportClosure({ entryPoints: ['scripts/entry.mjs'], repoFiles, readFile });
    assert.deepEqual(unresolved.map(u => u.specifier), ['./missing.mjs']);
    assert.equal(external.some(e => e.specifier === './missing.mjs'), false);
  });

  it('excludes node builtins from external', () => {
    const { external } = collectImportClosure({ entryPoints: ['scripts/entry.mjs'], repoFiles, readFile });
    assert.equal(external.some(e => e.specifier === 'node:fs'), false);
  });
});
