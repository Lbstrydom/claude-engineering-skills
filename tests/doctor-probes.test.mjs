/**
 * @fileoverview The doctor's probe registry — schema validation, the outcome
 * enum, and fixture-tree probe behaviour (consumer-friction-doctor plan).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { REGISTRY, probeIds, validateRegistry, runProbe } from '../scripts/lib/doctor/registry.mjs';
import { PROBE_STATUSES } from '../scripts/lib/doctor/report.mjs';
import { resolveBundleGithubSpec } from '../scripts/lib/doctor/probes.mjs';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function makeCtx(subjectRoot) {
  return {
    bundleRoot: process.cwd(),
    subjectRoot,
    exec: (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', cwd: subjectRoot, ...opts }),
    fs,
    cloud: false,
  };
}

// ── Registry schema (Tier 1 — no repo needed) ───────────────────────────────

describe('doctor registry schema', () => {
  it('every probe has a non-empty id, title, fix, a valid class, and a function run', () => {
    const { ok, problems } = validateRegistry();
    assert.equal(ok, true, problems.join('\n'));
  });

  it('probeIds() has no duplicates', () => {
    const ids = probeIds();
    assert.equal(ids.length, new Set(ids).size);
  });

  it('is non-empty (sandbox-honesty: never green having checked nothing)', () => {
    assert.ok(REGISTRY.length > 5);
  });

  it('every probe is one of class repo|machine', () => {
    for (const p of REGISTRY) assert.ok(['repo', 'machine'].includes(p.class), p.id);
  });
});

// ── runProbe's outcome normalisation (Tier 1) ───────────────────────────────

describe('runProbe', () => {
  it('catches a throwing probe body and reports status:error, never crashing', async () => {
    const probe = { id: 'x/throws', title: 't', class: 'repo', fix: 'f', run: () => { throw new Error('boom'); } };
    const r = await runProbe(probe, {});
    assert.equal(r.status, 'error');
    assert.match(r.detail, /boom/);
  });

  it('never throws even when the thrown value\'s OWN .message getter throws (closes round-5 audit M7)', async () => {
    const pathological = { get message() { throw new Error('getter boom'); } };
    const probe = { id: 'x/pathological', title: 't', class: 'repo', fix: 'f', run: () => { throw pathological; } };
    const r = await runProbe(probe, {}); // must not itself throw
    assert.equal(r.status, 'error');
    assert.match(r.detail, /could not be described/);
  });

  it('coerces an invalid returned status to error rather than trusting the probe', async () => {
    const probe = { id: 'x/bad-status', title: 't', class: 'repo', fix: 'f', run: () => ({ status: 'nonsense' }) };
    const r = await runProbe(probe, {});
    assert.equal(r.status, 'error');
  });

  it('accepts every value in the canonical PROBE_STATUSES enum', async () => {
    for (const status of PROBE_STATUSES) {
      const probe = { id: `x/${status}`, title: 't', class: 'repo', fix: 'f', run: () => ({ status, detail: 'd' }) };
      const r = await runProbe(probe, {});
      assert.equal(r.status, status);
    }
  });

  it('supports an async probe body', async () => {
    const probe = { id: 'x/async', title: 't', class: 'machine', fix: 'f', run: async () => ({ status: 'pass', detail: '' }) };
    const r = await runProbe(probe, {});
    assert.equal(r.status, 'pass');
  });
});

// ── Fixture-tree probe behaviour (Tier 2) ───────────────────────────────────

describe('hydration probes against fixture trees', () => {
  let mainRepo, worktreeDir;

  before(() => {
    mainRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-hydration-main-'));
    git(mainRepo, ['init', '-q']);
    git(mainRepo, ['config', 'user.email', 'a@b.c']);
    git(mainRepo, ['config', 'user.name', 'a']);
    fs.writeFileSync(path.join(mainRepo, 'package.json'), JSON.stringify({ name: 'some-consumer', scripts: {} }));
    git(mainRepo, ['add', '.']);
    git(mainRepo, ['commit', '-q', '-m', 'init']);
    fs.mkdirSync(path.join(mainRepo, 'scripts', '.claude-skills'), { recursive: true });
    fs.writeFileSync(path.join(mainRepo, 'scripts', '.claude-skills', 'stub.mjs'), '// stub');

    worktreeDir = path.join(mainRepo, '..', 'doctor-hydration-worktree-' + path.basename(mainRepo));
    git(mainRepo, ['worktree', 'add', worktreeDir, '-b', 'wt-branch']);
  });

  after(() => {
    try { git(mainRepo, ['worktree', 'remove', '--force', worktreeDir]); } catch { /* best-effort */ }
    fs.rmSync(mainRepo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    fs.rmSync(worktreeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('main checkout: hydration/tooling-absent passes', async () => {
    const probe = REGISTRY.find((p) => p.id === 'hydration/tooling-absent');
    const r = await runProbe(probe, makeCtx(mainRepo));
    assert.equal(r.status, 'pass');
  });

  it('linked worktree with tooling absent: hydration/tooling-absent fails', async () => {
    const probe = REGISTRY.find((p) => p.id === 'hydration/tooling-absent');
    const r = await runProbe(probe, makeCtx(worktreeDir));
    assert.equal(r.status, 'fail');
  });

  it('a CORRUPT package.json reports unknown with a clear reason, not silently as "no package name" (closes round-5 audit M12)', async () => {
    const saved = fs.readFileSync(path.join(mainRepo, 'package.json'), 'utf-8');
    try {
      fs.writeFileSync(path.join(mainRepo, 'package.json'), '{ not valid json');
      const probe = REGISTRY.find((p) => p.id === 'hydration/tooling-absent');
      const r = await runProbe(probe, makeCtx(mainRepo));
      assert.equal(r.status, 'unknown');
      assert.match(r.detail, /not valid JSON/);
    } finally {
      fs.writeFileSync(path.join(mainRepo, 'package.json'), saved);
    }
  });

  it('consumer with no skills:hydrate script: hydration/remedy-missing fails', async () => {
    const probe = REGISTRY.find((p) => p.id === 'hydration/remedy-missing');
    const r = await runProbe(probe, makeCtx(mainRepo));
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /skills:hydrate/);
  });

  it('consumer WITH skills:hydrate defined: hydration/remedy-missing passes', async () => {
    fs.writeFileSync(
      path.join(mainRepo, 'package.json'),
      JSON.stringify({ name: 'some-consumer', scripts: { 'skills:hydrate': 'node -e "1"' } }),
    );
    const probe = REGISTRY.find((p) => p.id === 'hydration/remedy-missing');
    const r = await runProbe(probe, makeCtx(mainRepo));
    assert.equal(r.status, 'pass');
  });
});

describe('sync gate probes: a missing/unreadable manifest FAILS, never unknown (closes round-3 audit H4)', () => {
  it('a repo with NO scripts/.sync-manifest.json reports fail (class:repo, so it gates), not unknown', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-sync-nomanifest-'));
    try {
      git(dir, ['init', '-q']);
      git(dir, ['config', 'user.email', 'a@b.c']);
      git(dir, ['config', 'user.name', 'a']);
      fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
      git(dir, ['add', '.']);
      git(dir, ['commit', '-q', '-m', 'init']);
      // Deliberately no scripts/.sync-manifest.json — the "never hydrated" case.
      const probe = REGISTRY.find((p) => p.id === 'sync/manifest-hydration');
      const r = await runProbe(probe, makeCtx(dir));
      assert.equal(r.status, 'fail', 'a missing manifest must FAIL, not read as unknown/n-a — it silently skipped --gate before this fix');
      assert.equal(probe.class, 'repo', 'only a class:repo fail/error actually gates');
      assert.match(r.detail, /manifest unreadable/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('env/package-manager probe against fixture trees', () => {
  it('two lockfiles, no packageManager field -> warn, never a guessed manager literal in the fix', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-pm-ambig-'));
    try {
      fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
      fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
      const probe = REGISTRY.find((p) => p.id === 'env/package-manager');
      const r = await runProbe(probe, makeCtx(dir));
      assert.equal(r.status, 'warn');
      assert.ok(!/\bnpm\b|\bpnpm\b/.test(probe.fix), 'the STATIC fix string must not guess a manager');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('a single lockfile resolves cleanly to pass', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-pm-clean-'));
    try {
      fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
      const probe = REGISTRY.find((p) => p.id === 'env/package-manager');
      const r = await runProbe(probe, makeCtx(dir));
      assert.equal(r.status, 'pass');
      assert.match(r.detail, /npm/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('resolveBundleGithubSpec (closes round-5 audit M18)', () => {
  it('derives owner/repo from a package.json with a string repository field', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-bundlesrc-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ repository: 'https://github.com/someone/some-fork' }));
      assert.equal(resolveBundleGithubSpec(dir), 'someone/some-fork');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('derives owner/repo from a package.json with an object repository field', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-bundlesrc-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ repository: { type: 'git', url: 'https://github.com/someone/some-fork' } }));
      assert.equal(resolveBundleGithubSpec(dir), 'someone/some-fork');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('falls back to the known slug when package.json is missing or unparsable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-bundlesrc-missing-'));
    try {
      assert.equal(resolveBundleGithubSpec(dir), 'Lbstrydom/claude-engineering-skills');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('resolves to THIS repo\'s own real slug against the real bundleRoot', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    assert.equal(resolveBundleGithubSpec(repoRoot), 'Lbstrydom/claude-engineering-skills');
  });
});

describe('no probe detail/fix ever interpolates a raw env value (Security Considerations §3)', () => {
  it('static fix strings contain no obvious secret-shaped token', () => {
    for (const p of REGISTRY) {
      assert.ok(!/sk-[A-Za-z0-9]{10,}/.test(p.fix), `${p.id}: fix string looks like it embeds a real API key`);
    }
  });
});
