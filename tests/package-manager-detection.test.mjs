/**
 * @fileoverview The package-manager contract.
 *
 * Guards a bug measured 2026-08-15: consumer dependency auto-install hardcoded
 * `npm install --save-dev`, and npm cannot read pnpm's symlinked node_modules —
 * it aborts with `Cannot destructure property 'package' of 'node.target'`. So
 * dep install had never worked in a pnpm consumer, and the manual command it
 * printed on failure was the same broken npm one.
 *
 * The assertions that matter here are the ones covering the direction the
 * detector must NOT fire. A false "pnpm" is not a milder version of a false
 * "npm": running `pnpm add` in an npm repo succeeds and leaves a competing
 * `pnpm-lock.yaml` behind (also measured), so both directions corrupt a
 * consumer and both need a test.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  detectPackageManager,
  packageManagerInvocation,
  addDevDepsArgs,
  execBinaryArgs,
  displayCommand,
  displayAddDev,
  displayExec,
  playwrightInstallHint,
  playwrightBootstrapHint,
  SUPPORTED_PACKAGE_MANAGERS,
} from '../scripts/lib/package-manager.mjs';

let TMP;

/** Build a scratch repo with the given files. @returns {string} repo root */
function repoWith(name, files) {
  const root = path.join(TMP, name);
  fs.mkdirSync(root, { recursive: true });
  for (const [file, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, file), body);
  }
  return root;
}

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-detect-'));
});
after(() => {
  // maxRetries/retryDelay are required by tests/rmsync-retry-guard.test.mjs:
  // Windows throws EPERM/EBUSY when a handle is still settling.
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch { /* best effort */ }
});

describe('detectPackageManager — lockfile evidence', () => {
  it('reads a pnpm repo as pnpm', () => {
    const root = repoWith('pnpm-repo', { 'package.json': '{}', 'pnpm-lock.yaml': '' });
    const d = detectPackageManager(root);
    assert.equal(d.name, 'pnpm');
    assert.equal(d.source, 'lockfile');
    assert.equal(d.ambiguous, false);
  });

  it('reads an npm repo as npm — the direction that must NOT become pnpm', () => {
    // `pnpm add` in an npm repo succeeds and writes a second lockfile, so a
    // false positive here silently corrupts a correctly-configured consumer.
    const root = repoWith('npm-repo', { 'package.json': '{}', 'package-lock.json': '{}' });
    const d = detectPackageManager(root);
    assert.equal(d.name, 'npm');
    assert.equal(d.ambiguous, false);
  });

  it('reads yarn and bun repos', () => {
    assert.equal(detectPackageManager(repoWith('yarn-repo', { 'package.json': '{}', 'yarn.lock': '' })).name, 'yarn');
    assert.equal(detectPackageManager(repoWith('bun-repo', { 'package.json': '{}', 'bun.lockb': '' })).name, 'bun');
  });

  it('defaults to npm when there is no evidence at all', () => {
    const d = detectPackageManager(repoWith('bare-repo', { 'package.json': '{}' }));
    assert.equal(d.name, 'npm');
    assert.equal(d.source, 'default');
  });

  it('refuses to guess when two managers both claim the repo', () => {
    // Installing with either writes a lockfile the other does not own. The
    // honest outcome is to hand the decision back, not to pick.
    const root = repoWith('two-locks', {
      'package.json': '{}', 'pnpm-lock.yaml': '', 'package-lock.json': '{}',
    });
    const d = detectPackageManager(root);
    assert.equal(d.ambiguous, true);
    assert.deepEqual(d.candidates.sort(), ['npm', 'pnpm']);
  });
});

describe('detectPackageManager — declared packageManager field', () => {
  it('beats the lockfile, and de-ambiguates a two-lockfile repo', () => {
    const root = repoWith('declared', {
      'package.json': JSON.stringify({ packageManager: 'pnpm@11.21.0' }),
      'package-lock.json': '{}',
      'pnpm-lock.yaml': '',
    });
    const d = detectPackageManager(root);
    assert.equal(d.name, 'pnpm');
    assert.equal(d.source, 'declared');
    assert.equal(d.ambiguous, false, 'an explicit declaration settles the ambiguity');
  });

  it('parses the corepack hash suffix', () => {
    const root = repoWith('declared-hash', {
      'package.json': JSON.stringify({ packageManager: 'yarn@4.1.0+sha224.abcdef' }),
    });
    assert.equal(detectPackageManager(root).name, 'yarn');
  });

  it('ignores an unrecognised or malformed declaration rather than trusting it', () => {
    const unknown = repoWith('declared-unknown', {
      'package.json': JSON.stringify({ packageManager: 'cargo@1.0.0' }),
      'pnpm-lock.yaml': '',
    });
    assert.equal(detectPackageManager(unknown).name, 'pnpm', 'falls through to lockfile evidence');

    const broken = repoWith('declared-broken', { 'package.json': '{ not json' });
    assert.equal(detectPackageManager(broken).name, 'npm', 'unreadable package.json must not throw');
  });

  it('flags invalidDeclaration on the returned object itself, not just via a downstream consumer', () => {
    // Round-1 audit H6/M3/M17 (2026-08-15): a typo'd or unsupported
    // packageManager value must be a DISTINCT outcome from "field absent" —
    // both the previous test above and ensureAuditDeps's own suite assert this
    // indirectly through `.name` / `ensureAuditDeps`'s action string, but
    // nothing pins the flag `detectPackageManager` itself returns. A future
    // regression that stops setting `invalidDeclaration` (while still
    // happening to fall through to the same lockfile name) would pass both of
    // those without being caught here.
    const unknown = repoWith('declared-unknown-flag', {
      'package.json': JSON.stringify({ packageManager: 'pnmp@8.0.0' }), // typo'd name
      'package-lock.json': '{}', // must not be silently trusted either
    });
    const d = detectPackageManager(unknown);
    assert.equal(d.invalidDeclaration, true, 'a malformed declaration must set invalidDeclaration, not just fall through');
    assert.equal(d.ambiguous, false);

    const absent = repoWith('declared-absent-flag', { 'package.json': '{}', 'package-lock.json': '{}' });
    assert.equal(detectPackageManager(absent).invalidDeclaration, false, 'no declaration at all must NOT be flagged invalid');
  });
});

describe('command construction', () => {
  it('never sends npm-only flags to another manager', () => {
    // --legacy-peer-deps is an npm concept; pnpm/yarn/bun reject it outright,
    // which would turn every install into a hard failure.
    for (const pm of ['pnpm', 'yarn', 'bun']) {
      const args = addDevDepsArgs(pm, ['zod']);
      assert.ok(!args.includes('--legacy-peer-deps'), `${pm} must not receive --legacy-peer-deps`);
      assert.ok(!args.includes('install'), `${pm} uses 'add', not 'install'`);
      assert.equal(args[0], 'add');
    }
    assert.deepEqual(addDevDepsArgs('npm', ['zod']), ['install', '--save-dev', '--legacy-peer-deps', 'zod']);
  });

  it('marks dev-dependency intent for every manager', () => {
    assert.ok(addDevDepsArgs('pnpm', ['x']).includes('-D'));
    assert.ok(addDevDepsArgs('yarn', ['x']).includes('-D'));
    assert.ok(addDevDepsArgs('bun', ['x']).includes('-d'), 'bun spells it lowercase');
    assert.ok(addDevDepsArgs('npm', ['x']).includes('--save-dev'));
  });

  it('builds a binary-exec argv per manager', () => {
    assert.deepEqual(execBinaryArgs('pnpm', ['playwright', 'test']), ['exec', 'playwright', 'test']);
    assert.deepEqual(execBinaryArgs('bun', ['playwright', 'test']), ['x', 'playwright', 'test']);
    assert.deepEqual(execBinaryArgs('npm', ['playwright', 'test']), ['exec', '--', 'playwright', 'test']);
  });

  it('keeps human-facing hints free of the automation-only npm flag', () => {
    assert.equal(displayAddDev('npm', ['@playwright/test']), 'npm i -D @playwright/test');
    assert.equal(displayAddDev('pnpm', ['@playwright/test']), 'pnpm add -D @playwright/test');
    assert.ok(!displayAddDev('npm', ['x']).includes('--legacy-peer-deps'));
  });

  it('renders the display command as the manager, never the node transport', () => {
    // We spawn `node <corepack.js> pnpm add …`; printing that as advice would
    // be unusable. The hint must be what a person types.
    const shown = displayCommand('pnpm', addDevDepsArgs('pnpm', ['zod']));
    assert.equal(shown, 'pnpm add -D zod');
    assert.ok(!shown.includes('node'), shown);
    assert.ok(!shown.includes('corepack'), shown);
  });

  it('runs an installed binary LOCALLY, never via a registry fetch', () => {
    // The security-relevant one. Measured 2026-08-15 in a repo with playwright
    // 1.62.1 installed: `npx playwright --version` used the local binary and
    // fetched nothing, while `pnpm dlx playwright --version` downloaded a fresh
    // copy anyway. Translating npx -> `pnpm dlx` would turn a lockfile-pinned
    // local call into an unpinned fetch on every run.
    assert.equal(displayExec('npm', ['playwright']), 'npx playwright');
    assert.equal(displayExec('pnpm', ['playwright']), 'pnpm exec playwright');
    assert.equal(displayExec('yarn', ['playwright']), 'yarn exec playwright');
    assert.equal(displayExec('bun', ['playwright']), 'bun x playwright'); // matches execBinaryArgs, not the standalone bunx binary
    for (const pm of SUPPORTED_PACKAGE_MANAGERS) {
      assert.ok(!/\bdlx\b/.test(displayExec(pm, ['playwright'])), `${pm} must not reach for dlx`);
    }
  });
});

describe('packageManagerInvocation', () => {
  it('spawns npm through a real, existing JS entry point', () => {
    // Asserting the returned shape alone would not catch a wrong path; the
    // point of this indirection is that the file is actually there.
    const { bin, prefix } = packageManagerInvocation('npm');
    if (prefix.length > 0) {
      assert.equal(bin, process.execPath, 'npm should run under the current node');
      assert.ok(fs.existsSync(prefix[0]), `npm-cli.js must exist at ${prefix[0]}`);
    }
  });

  it('routes pnpm and yarn through corepack when it ships with this node', () => {
    // The Windows reason this exists: bare `pnpm` is ENOENT and `pnpm.cmd` is
    // EINVAL under Node >= 22.19's .cmd hardening, so neither is spawnable
    // without a shell. corepack is a plain .js file and needs none.
    for (const pm of ['pnpm', 'yarn']) {
      const { bin, prefix, viaCorepack } = packageManagerInvocation(pm);
      if (viaCorepack) {
        assert.equal(bin, process.execPath);
        assert.ok(fs.existsSync(prefix[0]), `corepack.js must exist at ${prefix[0]}`);
        assert.equal(prefix[1], pm, 'the manager name is corepack\'s first argument');
      }
    }
  });

  it('never returns a bare .cmd path while a JS entry point was available', () => {
    for (const pm of SUPPORTED_PACKAGE_MANAGERS) {
      const { bin, prefix } = packageManagerInvocation(pm);
      if (prefix.length > 0) {
        assert.ok(!/\.cmd$/i.test(bin), `${pm} resolved a JS entry but still returned ${bin}`);
      }
    }
  });

  it('bun (no bundled JS entry, ever) falls back to the bare binary WITH shell:true on Windows — never a bare .cmd without a shell', () => {
    // Round-1/round-2/round-3 audit H1/H4/M2/M6 (2026-08-15): this branch used
    // to hardcode `${pm}.cmd` and spawn it WITHOUT shell:true. Node >= 22.19
    // rejects spawning a .cmd file without shell:true (EINVAL, CVE-2024-27980
    // hardening) — so the old shape was unspawnable on every current Windows
    // Node. bun is the one manager that unconditionally reaches this fallback
    // (unlike npm/pnpm/yarn it has no bundled JS entry point this module
    // checks for), so it deterministically exercises the exact branch these
    // three findings describe, regardless of what happens to be installed in
    // this environment.
    const { bin, prefix, viaCorepack, shell } = packageManagerInvocation('bun');
    assert.equal(prefix.length, 0, 'the bare-binary fallback carries no JS-entry prefix');
    assert.equal(bin, 'bun', 'the bare manager name, never "bun.cmd"');
    assert.ok(!/\.cmd$/i.test(bin), 'must never synthesize a .cmd suffix itself');
    assert.equal(viaCorepack, false);
    if (process.platform === 'win32') {
      assert.equal(shell, true, 'Windows must spawn the bare binary through a shell, or Node >= 22.19 EINVALs');
    } else {
      assert.equal(shell, false, 'non-Windows must not opt into a shell it does not need');
    }
  });
});

describe('playwrightInstallHint', () => {
  it('speaks the dialect of the repo it is asked about', () => {
    const pnpmRepo = repoWith('hint-pnpm', { 'package.json': '{}', 'pnpm-lock.yaml': '' });
    const npmRepo = repoWith('hint-npm', { 'package.json': '{}', 'package-lock.json': '{}' });
    assert.equal(playwrightInstallHint(pnpmRepo), 'pnpm exec playwright install chromium');
    assert.equal(playwrightInstallHint(npmRepo), 'npx playwright install chromium');
  });

  it('tells a pnpm user something other than npx — the whole point', () => {
    const pnpmRepo = repoWith('hint-pnpm-2', { 'package.json': '{}', 'pnpm-lock.yaml': '' });
    assert.ok(!playwrightInstallHint(pnpmRepo).startsWith('npx '));
  });

  it('keeps "package missing" and "browser missing" as different fixes', () => {
    // Collapsing them tells a user with no playwright installed to run a binary
    // they do not have. check-setup distinguishes the two states, so the hints
    // must too.
    const npmRepo = repoWith('hint-two-states', { 'package.json': '{}', 'package-lock.json': '{}' });
    assert.equal(playwrightBootstrapHint(npmRepo), 'npm i -D playwright && npx playwright install chromium');
    assert.equal(playwrightInstallHint(npmRepo), 'npx playwright install chromium');
    assert.notEqual(playwrightBootstrapHint(npmRepo), playwrightInstallHint(npmRepo));
  });

  it('bootstraps a pnpm repo with pnpm on both halves', () => {
    const pnpmRepo = repoWith('hint-bootstrap-pnpm', { 'package.json': '{}', 'pnpm-lock.yaml': '' });
    assert.equal(
      playwrightBootstrapHint(pnpmRepo),
      'pnpm add -D playwright && pnpm exec playwright install chromium',
    );
  });
});
