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
  discoverScripts, loadBaselineFile, classifyPolarity, stripComments,
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

describe('detection reaches the shapes that hid real CLIs', () => {
  // Reported by a consumer repo 2026-07-20: their migration runner used this
  // spelling, `--check` was the SAFE mode, and the default APPLIED migrations —
  // so a typo'd `--chek` ran them for real while the gate reported clean.
  it('sees argv.includes() bound to a local, not just process.argv.includes()', () => {
    const viaProcessArgv = "const DRY = process.argv.includes('--dry-run');";
    const viaLocal = "const argv = process.argv.slice(2);\nconst DRY = argv.includes('--dry-run');";
    assert.equal(parsesFlags(viaProcessArgv), true);
    assert.equal(parsesFlags(viaLocal), true, 'the receiver must not be required');
  });

  it('still requires SOME argv read — a bare includes() is not a CLI', () => {
    assert.equal(parsesFlags("if (line.includes('--')) skip();"), false);
  });

  it('discovery is not depth-limited — git pathspec * crosses /', () => {
    // Two readers independently mis-read these globs as depth-2 by modelling
    // them with shell/minimatch semantics. Assert against the real function.
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
    const files = discoverScripts(repoRoot);
    const maxDepth = Math.max(...files.map((f) => f.split('/').length - 1));
    assert.ok(maxDepth >= 3, `expected depth-3+ files to be discovered, max was ${maxDepth}`);
    assert.ok(files.includes('scripts/lib/arch-memory/calibrate.mjs'));
  });

  it('discovers .js as well as .mjs (adopters are frequently mixed)', () => {
    const { root } = repoWith({ 'scripts/legacy.js': UNGUARDED });
    // repoWith is not a git repo, so assert the glob list directly instead.
    assert.ok(fs.existsSync(path.join(root, 'scripts/legacy.js')));
    const r = runCheck({ repoRoot: root, files: ['scripts/legacy.js'] });
    assert.deepEqual(r.findings, ['scripts/legacy.js'], '.js must be scannable');
  });
});

describe('--baseline is adoptable by consumers', () => {
  it('reads a JSON array and a newline-delimited file alike', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliflags-'));
    const asJson = path.join(dir, 'b.json');
    const asTxt = path.join(dir, 'b.txt');
    fs.writeFileSync(asJson, JSON.stringify(['scripts/a.mjs', 'scripts/b.mjs']));
    fs.writeFileSync(asTxt, '# comment\nscripts/a.mjs\n\nscripts/b.mjs\n');
    assert.deepEqual([...loadBaselineFile(asJson)].sort(), ['scripts/a.mjs', 'scripts/b.mjs']);
    assert.deepEqual([...loadBaselineFile(asTxt)].sort(), ['scripts/a.mjs', 'scripts/b.mjs']);
  });

  it('a consumer baseline replaces the upstream one for drift purposes', () => {
    const { root } = repoWith({ 'scripts/mine.mjs': UNGUARDED });
    const withUpstream = runCheck({ repoRoot: root, files: ['scripts/mine.mjs'], gating: true });
    assert.equal(withUpstream.drift.length, 1, 'unknown to the upstream baseline → drift');
    const withOwn = runCheck({
      repoRoot: root, files: ['scripts/mine.mjs'], gating: true,
      baseline: new Set(['scripts/mine.mjs']),
    });
    assert.equal(withOwn.drift.length, 0);
    assert.equal(withOwn.ok, true);
  });

  it('a malformed baseline throws rather than silently returning empty', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliflags-'));
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{"not":"an array"}');
    assert.throws(() => loadBaselineFile(bad), /must be an array/);
    assert.throws(() => loadBaselineFile(path.join(dir, 'missing.json')));
  });
});

describe('prose about a guard is not a guard', () => {
  // Found 2026-07-20 in this repo, not reported by the consumer. sync-to-repos.mjs
  // WRITES INTO CONSUMER REPOS, is unguarded, and silently left the census
  // because a comment added in the same commit that fixed the sync-payload gap
  // mentions `assertKnownFlags` by name. The gate then listed it under
  // "baseline can shrink — fixed or gone": a regression dressed as a win.
  it('a comment MENTIONING assertKnownFlags does not count as guarded', () => {
    const mentioned = `${UNGUARDED}\n// The remedy is assertKnownFlags, in lib/cli-io.mjs.\n`;
    assert.equal(rejectsUnknownFlags(mentioned), false);
  });

  it('a docblock discussing unknown flags does not count as guarded', () => {
    const prose = `/**\n * TODO: we should reject unknown flags here one day.\n */\n${UNGUARDED}`;
    assert.equal(rejectsUnknownFlags(prose), false);
  });

  it('a real call still counts, commented neighbours notwithstanding', () => {
    assert.equal(rejectsUnknownFlags(VIA_HELPER), true);
    assert.equal(rejectsUnknownFlags(VIA_TEXT), true);
  });

  it('the real sync-to-repos.mjs reads unguarded (the live instance)', () => {
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
    const src = fs.readFileSync(path.join(repoRoot, 'scripts/sync-to-repos.mjs'), 'utf-8');
    assert.equal(parsesFlags(src), true);
    assert.equal(rejectsUnknownFlags(src), false, 'a comment must not mask a missing guard');
  });

  it('stripComments leaves string literals alone', () => {
    // A naive /\/\/.*$/ eats the rest of the line after any 'http://…' literal,
    // which would silently blank real guard calls that follow a URL.
    const src = `const u = 'http://x.test'; assertKnownFlags(argv, [], {});`;
    assert.match(stripComments(src), /assertKnownFlags/);
    assert.equal(rejectsUnknownFlags(src), true);
  });

  it('stripComments handles escapes and template literals', () => {
    assert.match(stripComments("const s = 'it\\'s // not a comment'; keep();"), /keep\(\)/);
    assert.match(stripComments('const t = `a // b`; keep();'), /keep\(\)/);
  });

  it('stripComments does not fuse tokens across a removed block', () => {
    assert.doesNotMatch(stripComments('assertKnown/* x */Flags('), /assertKnownFlags/);
  });
});

describe('polarity — the census is a triage list, not a flat wall', () => {
  // A consumer reported (2026-07-20) that only 4 of their 10 findings were the
  // dangerous polarity while their two WORST instances weren't listed at all.
  // A severity-flat census buries the cases that matter.
  it('a safety flag marks the CLI opt-out — its default is the mutating one', () => {
    assert.equal(classifyPolarity("const DRY = argv.includes('--dry-run');"), 'opt-out');
    assert.equal(classifyPolarity("const CHECK = argv.includes('--check');"), 'opt-out');
  });

  it('an opt-in danger flag is NOT opt-out — a typo there is a no-op', () => {
    assert.equal(classifyPolarity("const APPLY = argv.includes('--apply');"), 'unknown');
    assert.equal(classifyPolarity("const WRITE = argv.includes('--write');"), 'unknown');
  });

  it('does not match a safety flag it merely PASSES to another script', () => {
    // Real FP: maintenance-checks.mjs contains `args: ['--check-drift']` — an
    // argument forwarded to setup-postgres.mjs, not a brake on its own default.
    // A bare \b would match `--check` inside `--check-drift`.
    assert.equal(classifyPolarity("steps: [{ script: 'x.mjs', args: ['--check-drift'] }]"), 'unknown');
  });

  it('does not treat an output-suppression flag as a brake', () => {
    // Real FP: debt-pr-comment.mjs `--no-op-if-empty` suppresses OUTPUT. The
    // first draft of SAFETY_FLAG listed `--no-op` and mis-triaged it as danger.
    assert.equal(classifyPolarity("noOpIfEmpty: args.includes('--no-op-if-empty')"), 'unknown');
  });

  it('optOut is a subset of findings, and never changes the gate verdict', () => {
    // Polarity is triage ordering. A net-new unguarded CLI is drift whichever
    // polarity it has — inferring intent into an exit code would make the gate
    // wrong in a direction nobody can audit.
    const SAFE_MODE_UNGUARDED = "const argv = process.argv.slice(2);\nconst CHECK = argv.includes('--check');";
    const { root, files } = repoWith({
      'scripts/brake.mjs': SAFE_MODE_UNGUARDED,
      'scripts/plain.mjs': UNGUARDED,
    });
    const r = runCheck({ repoRoot: root, files, gating: true, baseline: new Set() });
    assert.deepEqual(r.optOut, ['scripts/brake.mjs']);
    assert.equal(r.findings.length, 2, 'optOut must not shrink the census');
    for (const f of r.optOut) assert.ok(r.findings.includes(f), 'optOut ⊆ findings');
    assert.deepEqual(r.drift.sort(), ['scripts/brake.mjs', 'scripts/plain.mjs']);
    assert.equal(r.ok, false);
  });

  it('a GUARDED safety-flag CLI is not in optOut at all', () => {
    // optOut is a subset of findings, so fixing the guard removes it from both.
    const { root, files } = repoWith({ 'scripts/ok.mjs': `${VIA_HELPER}\nconst d = argv.includes('--dry-run');` });
    const r = runCheck({ repoRoot: root, files, baseline: new Set() });
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.optOut, []);
  });

  it('the empty-scan refusal still carries the optOut key', () => {
    // The early-return path builds its result literal separately — an absent
    // key there would throw on `r.optOut.length` in the reporter.
    const r = runCheck({ repoRoot: os.tmpdir(), files: [] });
    assert.deepEqual(r.optOut, []);
  });
});

describe('BASELINE is debt, not approval', () => {
  it('every baseline entry is a repo-relative scripts/ path', () => {
    for (const b of BASELINE) {
      assert.match(b, /^scripts\/[\w./-]+\.(mjs|js)$/, b);
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
