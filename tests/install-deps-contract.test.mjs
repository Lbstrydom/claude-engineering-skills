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

import {
  bundleDeps, requiredDeps, OPTIONAL_DEPS, findMissingDeps, npmInvocation, ensureAuditDeps,
  installTimeouts, isInstallTimeout, DEPS_TIMEOUT_MARKER,
  DEFAULT_REQUIRED_INSTALL_TIMEOUT_MS, DEFAULT_OPTIONAL_INSTALL_TIMEOUT_MS, MAX_TIMEOUT_MS,
} from '../scripts/lib/install/deps.mjs';
import { packageNameFromSpecifier, collectImportClosure } from '../scripts/lib/module-graph.mjs';
import { seedInstalledDeps } from './helpers/consumer-fixture.mjs';

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

  it('provisions the SAME playwright package playwright-runner.mjs actually resolves (round-3 audit H1/H4, 2026-08-15)', () => {
    // Cross-file contract: playwright-runner.mjs's resolvePlaywrightCli() tries
    // `@playwright/test/cli` first, then falls back to the BASE `playwright`
    // package's own `bin` entry. OPTIONAL_DEPS used to list `@playwright/test`
    // while never provisioning plain `playwright`, so a consumer whose
    // install had run via this list could satisfy neither of the runner's two
    // resolution attempts. The fix was to have this list provision the
    // package the runner's fallback step actually needs.
    assert.ok(OPTIONAL_DEPS.includes('playwright'), 'must provision the base package the runner falls back to');
    assert.ok(!OPTIONAL_DEPS.includes('@playwright/test'), 'must not re-introduce the package the runner never requires this list to provide');
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
    if (TMP) fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
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

// ── Install bounding + timeout adjudication (2026-09-04) ────────────────────
//
// `tests/sync-target-path.test.mjs` failed intermittently with `null !== 0`,
// independently of any code change. One flat 120s cap covered BOTH install
// phases, and the optional set contains `playwright`; on a slow network the
// two phases summed to exactly the 240s that test allowed the whole
// subprocess, so the parent killed the child. Two defects, both here:
//
//   1. the cap was not sized to the work (one number for two very different
//      phases), and
//   2. a cap-kill was reported with the same words as a manager-reported
//      failure — "install failed" for work we never let finish.
describe('install bounding', () => {
  it('sizes the optional phase above the required one by default', () => {
    // Not an arbitrary ordering: the optional set is the one containing
    // playwright. If these ever equalise, the 2026-09-04 shape is back.
    const t = installTimeouts({ env: {} });
    assert.equal(t.requiredMs, DEFAULT_REQUIRED_INSTALL_TIMEOUT_MS);
    assert.equal(t.optionalMs, DEFAULT_OPTIONAL_INSTALL_TIMEOUT_MS);
    assert.ok(t.optionalMs > t.requiredMs, 'the phase that downloads playwright needs the longer cap');
    assert.equal(t.totalMs, t.requiredMs + t.optionalMs);
  });

  it('env overrides each phase independently', () => {
    const t = installTimeouts({ env: { AUDIT_DEPS_INSTALL_TIMEOUT_MS: '5000', AUDIT_DEPS_OPTIONAL_INSTALL_TIMEOUT_MS: '9000' } });
    assert.deepEqual([t.requiredMs, t.optionalMs, t.totalMs], [5000, 9000, 14000]);
  });

  it('an explicit timeoutMs overrides BOTH phases (the old single-number contract)', () => {
    const t = installTimeouts({ timeoutMs: 7000, env: { AUDIT_DEPS_INSTALL_TIMEOUT_MS: '5000' } });
    assert.deepEqual([t.requiredMs, t.optionalMs], [7000, 7000]);
  });

  it('a junk env value falls back rather than disabling the cap', () => {
    // The direction that matters: `timeout: 0` / `NaN` in execFileSync means
    // NO timeout, so a typo'd env var would silently remove the bound
    // entirely — the opposite of what an operator setting it intends.
    for (const bad of ['0', '-1', 'abc', '1.5', '']) {
      const t = installTimeouts({ env: { AUDIT_DEPS_INSTALL_TIMEOUT_MS: bad } });
      assert.equal(t.requiredMs, DEFAULT_REQUIRED_INSTALL_TIMEOUT_MS, `"${bad}" must not disable the cap`);
    }
  });
});

describe('install timeout adjudication', () => {
  it('isInstallTimeout separates a cap-kill from an ordinary non-zero exit', () => {
    // execFileSync reports a kill as the STRING 'ETIMEDOUT' and an ordinary
    // failure as the numeric exit status (verified 2026-09-04, Node 22).
    assert.equal(isInstallTimeout({ code: 'ETIMEDOUT', status: null }), true);
    assert.equal(isInstallTimeout({ killed: true }), true);
    // The direction that must NOT fire — a real failure misread as a timeout
    // would tell the operator to raise a cap that was never the problem.
    assert.equal(isInstallTimeout({ code: 1, status: 1 }), false, 'a non-zero exit is not a timeout');
    assert.equal(isInstallTimeout({ code: 'ERR_PNPM_IGNORED_BUILDS' }), false);
    assert.equal(isInstallTimeout(null), false);
  });

  it('a cap-kill reports `timed-out`, not `failed` — with the cap named', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-timeout-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
    const stderr = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => { stderr.push(String(s)); return true; };
    let res;
    try {
      // 1ms: npm cannot even start in that, so the kill is deterministic and
      // this test needs no network.
      res = ensureAuditDeps(root, { timeoutMs: 1 });
    } finally {
      process.stderr.write = write;
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
    const out = stderr.join('');
    assert.equal(res.action, 'timed-out', `expected a timeout verdict, got ${res.action}: ${out}`);
    assert.equal(res.timedOut, true);
    assert.ok(res.failed.length > 0, 'the packages are still absent — that half is unchanged');
    assert.match(out, new RegExp(DEPS_TIMEOUT_MARKER), 'the operator message must name the timeout');
    assert.doesNotMatch(out, /install failed/, 'a cap-kill must not be reported as a manager failure');
    assert.match(out, /AUDIT_DEPS_INSTALL_TIMEOUT_MS/, 'the message must name the lever');
    assert.match(out, /Run manually:/, 'the manual fallback stays');
  });
});

// ── Round-1 code-audit fixes (2026-09-04) ──────────────────────────────────
describe('timeout validation covers EVERY source', () => {
  it('an invalid explicit timeoutMs falls back, exactly as an invalid env value does', () => {
    // Round-1 H5/M2. `positiveIntEnv` guarded the env vars while the public
    // `timeoutMs` argument reached the caps through a bare `??`. Measured:
    // `installTimeouts({timeoutMs: 0})` returned `{requiredMs: 0}` — and
    // execFileSync reads `timeout: 0` as NO timeout, so the "safety" argument
    // removed the cap it was asked to set.
    for (const bad of [0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY, '', null]) {
      const t = installTimeouts({ timeoutMs: bad, env: {} });
      assert.equal(t.requiredMs, DEFAULT_REQUIRED_INSTALL_TIMEOUT_MS, `timeoutMs=${String(bad)} must not reach the cap`);
      assert.equal(t.optionalMs, DEFAULT_OPTIONAL_INSTALL_TIMEOUT_MS, `timeoutMs=${String(bad)} must not reach the cap`);
    }
  });

  it('an invalid timeoutMs falls back PER PHASE, not onto one shared number', () => {
    // The direction a naive fix gets wrong: collapsing both phases onto the
    // required default would silently re-create the single-cap bug the whole
    // change exists to remove.
    const t = installTimeouts({ timeoutMs: 0, env: {} });
    assert.notEqual(t.requiredMs, t.optionalMs);
  });

  it('a VALID explicit timeoutMs still overrides both phases', () => {
    // Vacuous-pass guard: a validator that rejected everything would pass every
    // assertion above while breaking the feature.
    const t = installTimeouts({ timeoutMs: 7000, env: { AUDIT_DEPS_INSTALL_TIMEOUT_MS: '5000' } });
    assert.deepEqual([t.requiredMs, t.optionalMs], [7000, 7000]);
    assert.equal(installTimeouts({ timeoutMs: 1, env: {} }).requiredMs, 1, '1ms is valid — no arbitrary floor');
  });
});

describe('dependency presence is a PACKAGE, not a directory', () => {
  let TMP;
  before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-probe-')); });
  after(() => {
    if (TMP) fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const repoWith = (name, build) => {
    const root = path.join(TMP, name);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    build(path.join(root, 'node_modules'));
    return root;
  };

  it('an empty directory named after a dep does NOT count as installed', () => {
    // Round-1 H1/H4. A partial or interrupted install leaves the directory with
    // no manifest; reporting it present tells the consumer a package is there
    // that cannot be loaded.
    const dep = requiredDeps()[0];
    const root = repoWith('bare-dir', (nm) => fs.mkdirSync(path.join(nm, dep), { recursive: true }));
    assert.ok(findMissingDeps(root).missing.includes(dep), `${dep} is a bare directory — it must still read as missing`);
  });

  it('the same directory WITH a package.json does count', () => {
    // Negative control for the assertion above: without this, a probe that
    // returned "missing" unconditionally would pass it.
    const dep = requiredDeps()[0];
    const root = repoWith('real-pkg', (nm) => {
      fs.mkdirSync(path.join(nm, dep), { recursive: true });
      fs.writeFileSync(path.join(nm, dep, 'package.json'), '{"name":"x","version":"0.0.0"}');
    });
    assert.ok(!findMissingDeps(root).missing.includes(dep), `${dep} has a manifest — it must read as present`);
  });

  it('the test fixture satisfies the SAME probe production uses', () => {
    // Round-1 M6. The fixture and the production predicate must not be able to
    // drift: a seed that satisfies a weaker check than the real installer does
    // is a hole, not a fixture. This binds them — tighten the probe and this
    // fails here before it fails anywhere a human would have to diagnose it.
    const root = path.join(TMP, 'seeded');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    seedInstalledDeps(root);
    const res = findMissingDeps(root);
    assert.deepEqual(res.missing, [], 'seeded required deps must read as installed');
    assert.deepEqual(res.missingOptional, [], 'seeded optional deps must read as installed');
  });
});

// ── Round-2 code-audit fixes (2026-09-04) ──────────────────────────────────
describe('timeout bounds', () => {
  it('rejects a value beyond Node\'s documented timer range', () => {
    // Round-2 M1/M3. NOT because a failure was reproduced — it was not: with a
    // verified positive control (a 300ms cap killing a 3s child at 318ms),
    // execFileSync timeouts of 2**31 and 2**32 let the child run to completion,
    // no clamp-kill and no TimeoutOverflowWarning. The bound is here because
    // those values are outside the range setTimeout documents as supported.
    for (const bad of [MAX_TIMEOUT_MS + 1, 2 ** 32, Number.MAX_SAFE_INTEGER + 2]) {
      assert.equal(installTimeouts({ timeoutMs: bad, env: {} }).requiredMs,
        DEFAULT_REQUIRED_INSTALL_TIMEOUT_MS, `${bad} is out of range and must fall back`);
    }
  });

  it('accepts the largest in-range value — the boundary, not just the far side', () => {
    // Vacuous-pass guard: a bound that rejected everything would satisfy the
    // test above while breaking every legitimate large cap.
    assert.equal(installTimeouts({ timeoutMs: MAX_TIMEOUT_MS, env: {} }).requiredMs, MAX_TIMEOUT_MS);
    assert.equal(installTimeouts({ env: { AUDIT_DEPS_INSTALL_TIMEOUT_MS: String(MAX_TIMEOUT_MS) } }).requiredMs,
      MAX_TIMEOUT_MS, 'the env path must accept the same boundary the argument path does');
  });

  it('keeps totalMs exact — the reason isSafeInteger and not isInteger', () => {
    const t = installTimeouts({ env: {} });
    assert.ok(Number.isSafeInteger(t.totalMs), 'the sum of two caps must stay exact');
  });
});
