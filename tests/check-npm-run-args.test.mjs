/**
 * @fileoverview The `npm run <script> --flag` missing-`--` gate.
 *
 * Guards the class where npm eats a script flag before argv exists: the
 * AGENTS.md line every agent reads told agents to run `npm run sync --target
 * <name>`, which npm turns into a config set + a dropped flag, so sync wrote
 * into EVERY consumer repo. No in-script guard can catch this — the flag never
 * reaches the script — so the documentation is the only place to catch it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  findBrokenNpmRun, isExcludedPath, fingerprint, runCheck,
  NPM_NATIVE_FLAGS, BASELINE,
} from '../scripts/check-npm-run-args.mjs';

function repoWith(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-args-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return { root, files: Object.keys(files) };
}

describe('findBrokenNpmRun — npm eats a flag before `--`', () => {
  it('flags a script flag with no separator', () => {
    const f = findBrokenNpmRun('run `npm run sync --target wine` from here');
    assert.equal(f.length, 1);
    assert.equal(f[0].flag, '--target');
  });

  it('does NOT flag once a bare `--` precedes the flag', () => {
    assert.deepEqual(findBrokenNpmRun('npm run sync -- --target wine'), []);
  });

  it('does NOT flag an npm-native flag', () => {
    // --silent is consumed by npm itself; it is correct without `--`.
    assert.deepEqual(findBrokenNpmRun('npm run db:check-drift --silent'), []);
    assert.deepEqual(findBrokenNpmRun('npm run build --workspace pkg'), []);
  });

  it('flags a non-native flag that appears BEFORE an npm-native one', () => {
    // `--bar` is swallowed even though `--silent` after it is fine.
    const f = findBrokenNpmRun('npm run x --bar --silent');
    assert.equal(f.length, 1);
    assert.equal(f[0].flag, '--bar');
  });

  it('handles the `--flag=value` shape', () => {
    const f = findBrokenNpmRun('npm run x --repo=wine');
    assert.equal(f[0].flag, '--repo');
  });

  it('flags a short `-x` flag npm would eat', () => {
    assert.equal(findBrokenNpmRun('npm run x -q')[0].flag, '-q');
  });

  it('a flag that is NOT immediately after the script is still caught', () => {
    // The manual regex census that preceded this gate missed exactly this
    // shape — a positional between the script and the flag — and it was a real
    // bug: learning:replay forwards these flags to replay.mjs.
    const f = findBrokenNpmRun('npm run learning:replay pass_selection --policy p.mjs');
    assert.equal(f.length, 1);
    assert.equal(f[0].flag, '--policy');
  });

  it('treats markdown optional-brackets `[-- …]` as the separator, not a flag', () => {
    // Real FP: symbol-index/duplicates.mjs prints
    //   Usage: npm run arch:duplicates [-- --limit N] [--json]
    // which is CORRECT — the `--` is present. `[--` must read as the bare
    // separator, or every flag in the optional group is falsely flagged.
    assert.deepEqual(
      findBrokenNpmRun('Usage: npm run arch:duplicates [-- --limit N] [--json]'),
      [],
    );
  });

  it('does not mis-attribute a flag from a SECOND command on the line', () => {
    // `npm run a` has no flags; the `--bad` belongs to `npm run b`, which the
    // global scan matches on its own. The connector ends the first segment.
    const f = findBrokenNpmRun('npm run a && npm run b -- --bad');
    assert.deepEqual(f, [], 'the -- protects b; a has no flags');
    const g = findBrokenNpmRun('npm run a && npm run b --bad');
    assert.equal(g.length, 1);
    assert.equal(g[0].flag, '--bad');
    assert.match(g[0].command, /npm run b/);
  });

  it('reports the line number of the offending command', () => {
    const f = findBrokenNpmRun('line one\nline two\nnpm run sync --target x\n');
    assert.equal(f[0].line, 3);
  });

  it('a bare `npm run script` with no flags is clean', () => {
    assert.deepEqual(findBrokenNpmRun('npm run build && npm test'), []);
  });
});

describe('scope — historical surfaces are excluded, instructions are not', () => {
  it('excludes plans, research, completed, status.md, and the gate itself', () => {
    assert.equal(isExcludedPath('docs/plans/foo.md'), true);
    assert.equal(isExcludedPath('docs/research/bar.md'), true);
    // A consumer archive dir — records, not instructions. Wiring wine's
    // pre-push.local surfaced a completed plan quoting the command it ran.
    assert.equal(isExcludedPath('docs/completed/done.md'), true);
    assert.equal(isExcludedPath('status.md'), true);
    assert.equal(isExcludedPath('scripts/check-npm-run-args.mjs'), true);
    assert.equal(isExcludedPath('tests/check-npm-run-args.test.mjs'), true);
  });

  it('does NOT exclude live instruction surfaces', () => {
    assert.equal(isExcludedPath('AGENTS.md'), false);
    assert.equal(isExcludedPath('docs/runbooks/learning-system.md'), false);
    assert.equal(isExcludedPath('skills/ship/SKILL.md'), false);
    assert.equal(isExcludedPath('package.json'), false);
  });

  it('an excluded file is never scanned, even with a broken command', () => {
    const { root, files } = repoWith({
      'status.md': 'npm run sync --target wine',           // a bug-quote — excluded
      'docs/plans/x.md': 'npm run sync --target wine',      // a record — excluded
      'AGENTS.md': 'npm run sync --target wine',            // an instruction — caught
    });
    const r = runCheck({ repoRoot: root, files });
    assert.deepEqual(r.findings.map((f) => f.file), ['AGENTS.md']);
  });
});

describe('drift gate — baselined passes, net-new fails', () => {
  it('a net-new broken command fails the gate', () => {
    const { root, files } = repoWith({ 'AGENTS.md': 'npm run sync --target x' });
    const r = runCheck({ repoRoot: root, files, gating: true, baseline: new Set() });
    assert.equal(r.ok, false);
    assert.equal(r.drift.length, 1);
  });

  it('a baselined command does not fail', () => {
    const { root, files } = repoWith({ 'AGENTS.md': 'npm run sync --target x' });
    const fp = fingerprint('AGENTS.md', { command: 'npm run sync --target x' });
    const r = runCheck({ repoRoot: root, files, gating: true, baseline: new Set([fp]) });
    assert.equal(r.ok, true);
    assert.equal(r.baselined, 1);
    assert.equal(r.drift.length, 0);
  });

  it('report-only never fails even with findings', () => {
    const { root, files } = repoWith({ 'AGENTS.md': 'npm run sync --target x' });
    const r = runCheck({ repoRoot: root, files, gating: false, baseline: new Set() });
    assert.equal(r.ok, true);
    assert.equal(r.findings.length, 1);
  });

  it('a fixed baseline entry surfaces as staleBaseline (list can shrink)', () => {
    const { root, files } = repoWith({ 'AGENTS.md': 'npm run sync -- --target x' });
    const fp = fingerprint('AGENTS.md', { command: 'npm run sync --target x' });
    const r = runCheck({ repoRoot: root, files, gating: true, baseline: new Set([fp]) });
    assert.equal(r.ok, true);
    assert.deepEqual(r.staleBaseline, [fp]);
  });
});

describe('the gate cannot go green having checked nothing', () => {
  it('an empty scan set is a FAILURE', () => {
    const r = runCheck({ repoRoot: os.tmpdir(), files: [] });
    assert.equal(r.ok, false);
    assert.equal(r.failures[0].rule, 'scan/empty-scan-set');
  });

  it('an unreadable file is a scanner failure, not a silent skip', () => {
    const { root } = repoWith({ 'AGENTS.md': 'ok' });
    const r = runCheck({ repoRoot: root, files: ['AGENTS.md', 'ghost.md'] });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.rule === 'scanner/stat-failed'));
  });
});

describe('the live repo is clean and the gate is satisfiable', () => {
  it('NPM_NATIVE_FLAGS is a non-empty allowlist including --silent', () => {
    assert.ok(NPM_NATIVE_FLAGS.has('--silent'));
    assert.ok(NPM_NATIVE_FLAGS.size > 3);
  });

  it('the real repo has ZERO net-new drift', () => {
    // If this fails, someone documented a `npm run … --flag` that npm will eat.
    //
    // TRACKED files only (git ls-files), NOT discoverFiles() — that adds
    // `--others` (untracked-unignored), and the parallel test suite writes
    // transient scratch files into the repo, so a concurrent test's temp doc
    // containing a `npm run x --flag` string made this flake once. Tracked-only
    // is also what the gate sees in production: the pre-push hook runs in a
    // clean checkout of the pushed commit, where nothing is untracked.
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
    const files = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 128 * 1024 * 1024 })
      .split('\n').map((l) => l.trim()).filter(Boolean);
    assert.ok(files.length > 100, 'git ls-files must return the repo, not nothing');
    const r = runCheck({ repoRoot, files, gating: true });
    assert.equal(r.drift.length, 0, `net-new: ${r.drift.map((f) => `${f.file}:${f.line}`).join(', ')}`);
    assert.equal(r.ok, true);
  });

  it('BASELINE holds only well-formed fingerprints', () => {
    for (const b of BASELINE) assert.match(b, /^[^:]+.*::npm run /, b);
  });

  it('the tool that catches dropped flags does not drop its own', () => {
    // cli:flags:gate enforces this too, but assert it directly: a usage typo
    // must exit 2 with a diagnostic, not silently run the default (a census).
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
    const cli = path.join(repoRoot, 'scripts/check-npm-run-args.mjs');
    let code = 0, stderr = '';
    try {
      execFileSync('node', [cli, '--bogus'], { cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe' });
    } catch (err) {
      code = err.status;
      stderr = String(err.stderr || '');
    }
    assert.equal(code, 2);
    assert.match(stderr, /unknown flag "--bogus"/);
  });
});
