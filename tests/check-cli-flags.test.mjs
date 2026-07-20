/**
 * @fileoverview The CLI unknown-flag drift gate.
 *
 * Guards the check that guards the class: `refresh.mjs --full --dry-run` ran a
 * REAL full refresh because an unrecognised flag was silently dropped, and
 * `prune.mjs` / `render-mermaid.mjs` had the same shape. Each was found by hand,
 * separately. This gate exists so there is no fourth — which only holds if the
 * gate itself can fail.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runCheck, parsesFlags, rejectsUnknownFlags, BASELINE,
} from '../scripts/check-cli-flags.mjs';

/** Write files into a throwaway repo root; returns {root, files}. */
function repoWith(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-flags-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return { root, files: Object.keys(files) };
}

const UNGUARDED = `
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) { if (argv[i] === '--force') args.force = true; }
  return args;
}
`;
const VIA_HELPER = `
import { assertKnownFlags } from './lib/cli-io.mjs';
function parseArgs(argv) {
  assertKnownFlags(argv, ['--force'], { cli: 'x' });
  for (let i = 2; i < argv.length; i++) { if (argv[i] === '--force') return true; }
}
`;
const VIA_TEXT = `
function parseArgs(argv) {
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--force') continue;
    if (argv[i].startsWith('--')) throw new Error('unknown flag ' + argv[i]);
  }
}
`;
const NOT_A_CLI = `export function helper(a, b) { return a + b; }\n`;

/**
 * The spelling `parsesFlags` originally missed. A file matching no `readsArgv`
 * pattern is skipped BEFORE the guard check, so it can never be a finding and
 * never be drift — the gate reported green over 37 CLIs written this way,
 * including ones that write to consumer repos, overwrite generated trees, and
 * delete. Undetectable is indistinguishable from clean, which is the failure
 * mode this whole module exists to prevent.
 */
const UNGUARDED_INCLUDES = `
function main() {
  const force = process.argv.includes('--force');
  const dryRun = process.argv.includes('--dry-run');
  return { force, dryRun };
}
`;
const VIA_HELPER_INCLUDES = `
import { assertKnownFlags } from './lib/cli-io.mjs';
function main() {
  assertKnownFlags(process.argv, ['--force'], { cli: 'x' });
  return process.argv.includes('--force');
}
`;

describe('detection — helper OR message text', () => {
  it('a CLI guarded by assertKnownFlags counts as guarded', () => {
    // The original one-off survey checked ONLY for the literal error text, so
    // once the shared helper existed it reported every fixed CLI as broken.
    // A detector that misreports the fixed state trains people to ignore it.
    assert.equal(rejectsUnknownFlags(VIA_HELPER), true);
  });
  it('a CLI with its own diagnostic counts as guarded', () => {
    assert.equal(rejectsUnknownFlags(VIA_TEXT), true);
  });
  it('an unguarded CLI does not', () => {
    assert.equal(rejectsUnknownFlags(UNGUARDED), false);
  });
  it('a plain library is not a flag-parsing CLI at all', () => {
    assert.equal(parsesFlags(NOT_A_CLI), false);
  });

  it('a CLI parsing via process.argv.includes() IS a flag-parsing CLI', () => {
    // Regression: omitting this spelling hid 37 CLIs from the gate entirely —
    // more than the original baseline, and none of them guarded.
    assert.equal(parsesFlags(UNGUARDED_INCLUDES), true);
    assert.equal(rejectsUnknownFlags(UNGUARDED_INCLUDES), false);
  });

  it('the includes() spelling still counts as guarded when it delegates', () => {
    assert.equal(parsesFlags(VIA_HELPER_INCLUDES), true);
    assert.equal(rejectsUnknownFlags(VIA_HELPER_INCLUDES), true);
  });

  it('an unguarded includes() CLI reaches the findings list, not just the detector', () => {
    // parsesFlags returning true is necessary but not sufficient — the earlier
    // bug was a skip BEFORE the guard check, so assert the full path.
    const { root, files } = repoWith({ 'scripts/bad.mjs': UNGUARDED_INCLUDES });
    const r = runCheck({ repoRoot: root, files, gating: true, baseline: new Set() });
    assert.deepEqual(r.drift, ['scripts/bad.mjs']);
    assert.equal(r.ok, false);
  });
});

describe('drift gate — baselined passes, net-new fails', () => {
  it('flags an unguarded CLI as a finding', () => {
    const { root, files } = repoWith({ 'scripts/bad.mjs': UNGUARDED });
    const r = runCheck({ repoRoot: root, files, baseline: new Set() });
    assert.deepEqual(r.findings, ['scripts/bad.mjs']);
  });

  it('a BASELINED file does not fail the gate', () => {
    // 24 CLIs were unguarded when this landed. A check that fails on all of
    // them is a wall, not a ratchet — and a cried-wolf gate gets --no-verify'd.
    const { root, files } = repoWith({ 'scripts/bad.mjs': UNGUARDED });
    const r = runCheck({ repoRoot: root, files, gating: true, baseline: new Set(['scripts/bad.mjs']) });
    assert.equal(r.ok, true);
    assert.equal(r.drift.length, 0);
    assert.equal(r.baselined, 1);
  });

  it('a NET-NEW unguarded CLI fails the gate', () => {
    const { root, files } = repoWith({ 'scripts/new.mjs': UNGUARDED });
    const r = runCheck({ repoRoot: root, files, gating: true, baseline: new Set(['scripts/old.mjs']) });
    assert.equal(r.ok, false);
    assert.deepEqual(r.drift, ['scripts/new.mjs']);
  });

  it('report-only mode never fails, even with drift', () => {
    const { root, files } = repoWith({ 'scripts/new.mjs': UNGUARDED });
    const r = runCheck({ repoRoot: root, files, gating: false, baseline: new Set() });
    assert.equal(r.ok, true);
    assert.equal(r.findings.length, 1);
  });

  it('reports a baseline entry that is now fixed, so the list can shrink', () => {
    // Left silent, the baseline rots into fiction — claiming files are broken
    // that are not. Report-only: failing a push BECAUSE something was fixed
    // would be hostile.
    const { root, files } = repoWith({ 'scripts/fixed.mjs': VIA_HELPER });
    const r = runCheck({ repoRoot: root, files, gating: true, baseline: new Set(['scripts/fixed.mjs']) });
    assert.equal(r.ok, true);
    assert.deepEqual(r.staleBaseline, ['scripts/fixed.mjs']);
  });
});

describe('the gate cannot go green having checked nothing', () => {
  it('an empty scan set is a FAILURE, not a clean run', () => {
    const r = runCheck({ repoRoot: os.tmpdir(), files: [] });
    assert.equal(r.ok, false);
    assert.equal(r.failures[0].rule, 'scan/empty-scan-set');
  });

  it('an unreadable file is a scanner failure, not a silent skip', () => {
    const { root } = repoWith({ 'scripts/x.mjs': UNGUARDED });
    const r = runCheck({ repoRoot: root, files: ['scripts/does-not-exist.mjs'] });
    assert.equal(r.ok, false);
    assert.equal(r.failures[0].rule, 'scanner/stat-failed');
  });
});

describe('BASELINE is debt, not approval', () => {
  it('every baseline entry is a repo-relative scripts/ path', () => {
    for (const b of BASELINE) {
      assert.match(b, /^scripts\/[\w./-]+\.mjs$/, b);
      assert.doesNotMatch(b, /\\/, `${b} must use forward slashes to match git ls-files`);
    }
  });

  it('the live repo has ZERO net-new drift (the gate is currently satisfiable)', () => {
    // If this fails, someone shipped a flag-parsing CLI without a guard —
    // which is exactly what the gate is for.
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
    const files = [...BASELINE].filter((f) => fs.existsSync(path.join(repoRoot, f)));
    assert.ok(files.length > 0, 'baseline paths must resolve against the real repo');
    const r = runCheck({ repoRoot, files, gating: true });
    assert.equal(r.drift.length, 0);
  });
});
