/**
 * @fileoverview Detector-first fix protocol — Tier 1.
 *
 * The two properties that matter, and why:
 *  - **full scope, not the diff** — restricting to changed files lets "fixed 1 of 4"
 *    converge clean, reproducing the audit undercount the detector exists to fix;
 *  - **no shell** — the pattern is LLM-authored ledger content; it reaches ripgrep as argv.
 *
 * Plan: docs/plans/green-but-unrealized.md (Cluster B, Phase 4).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DetectorSchema, runDetector, checkDetectors, collectDetectorEntries,
  isCrossCutting, matchKey,
} from '../scripts/lib/audit/detector.mjs';
import { evaluateConvergenceWithDetectors } from '../scripts/lib/audit/convergence.mjs';

const DET = { kind: 'regex', pattern: 'fs\\.writeFileSync\\(', globs: ['scripts/**/*.mjs'] };

/**
 * A spawnSync stub: records argv, returns canned ripgrep output.
 *
 * `--files` (the scope census) is answered separately from the match run — with `files`
 * defaulting to a non-empty list, since "the globs reached nothing" is now its own
 * unverifiable verdict and every match-behaviour test would otherwise short-circuit into it.
 */
function fakeRg(stdout, { status = 0, stderr = '', files = 'scripts/a.mjs\n' } = {}) {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (args.includes('--files')) return { status: files ? 0 : 1, stdout: files, stderr: '' };
    return { status, stdout, stderr };
  };
  run.calls = calls;
  /** argv of the match run (the census call is not the subject of most assertions). */
  run.matchCall = () => calls.find((c) => !c.args.includes('--files'));
  return run;
}

// ── Schema ──────────────────────────────────────────────────────────────────

test('the schema is a closed set — an executable command is not expressible', () => {
  assert.equal(DetectorSchema.safeParse(DET).success, true);
  // The whole point of the structured form: there is no field a shell string fits into.
  assert.equal(DetectorSchema.safeParse({ kind: 'shell', cmd: 'rm -rf /' }).success, false);
  assert.equal(DetectorSchema.safeParse({ ...DET, kind: 'ast' }).success, false);
  assert.equal(DetectorSchema.safeParse({ ...DET, globs: [] }).success, false);
});

// ── No shell, ever ──────────────────────────────────────────────────────────

test('the pattern reaches ripgrep as ARGV — never concatenated into a command line', () => {
  const run = fakeRg('');
  runDetector({ ...DET, pattern: "a'; rm -rf / #" }, { run, cwd: '/x' });
  const { cmd, args } = run.matchCall();
  assert.equal(cmd, 'rg', 'spawned directly, not through a shell');
  assert.ok(args.includes('--regexp'), 'the pattern is passed via --regexp…');
  assert.ok(args.includes("a'; rm -rf / #"), '…as its own argv element, unquoted and uninterpreted');
  assert.equal(run.matchCall().opts.shell, undefined, 'shell must never be enabled');
});

// ── Result parsing ──────────────────────────────────────────────────────────

test('parses path:line:text, keeping colons inside the matched text', () => {
  const run = fakeRg('scripts/a.mjs:12:  const x = fs.writeFileSync(p, "a:b:c");\n');
  const m = runDetector(DET, { run });
  assert.equal(m.length, 1);
  assert.equal(m[0].file, 'scripts/a.mjs');
  assert.match(m[0].line, /a:b:c/, 'the text must not be truncated at its own colons');
});

test('ripgrep exit 1 is "no matches", not a failure', () => {
  assert.deepEqual(runDetector(DET, { run: fakeRg('', { status: 1 }) }), []);
});

test('a ripgrep FAILURE throws — a broken tool must not read as zero matches', () => {
  // The false green this module exists to prevent, applied to itself.
  assert.throws(
    () => runDetector(DET, { run: fakeRg('', { status: 2, stderr: 'bad pattern' }) }),
    /exited 2/,
  );
  assert.throws(
    () => runDetector(DET, { run: () => ({ error: new Error('ENOENT') }) }),
    /ripgrep unavailable/,
  );
});

// ── Dispositions key on TEXT, not line numbers ──────────────────────────────

test('a disposition survives lines shifting above the match', () => {
  const line = '  fs.writeFileSync(tmp, data);';
  // Same file, same text, different line number — the key must be identical.
  assert.equal(matchKey('scripts/a.mjs', line), matchKey('scripts/a.mjs', line));
  const ledger = {
    F1: { detector: { ...DET, disposition: { [matchKey('scripts/a.mjs', line)]: 'exempt — temp file' } } },
  };
  const run = fakeRg(`scripts/a.mjs:999:${line}\n`);   // moved from 12 to 999
  const r = checkDetectors(ledger, { run });
  assert.equal(r.blocked, false, 'a line-number key would have orphaned here and blocked the build');
});

test('identical lines in ONE file get distinct keys — dispositioning one is not all four', () => {
  // The undercount this module exists to prevent, in its own identity function: four copies
  // of the same statement collapsed to one key, so exempting the first exempted every one.
  const dup = 'fs.writeFileSync(tmp, data);';
  const run = fakeRg([3, 40, 41, 90].map((n) => `scripts/a.mjs:${n}:  ${dup}`).join('\n') + '\n');
  const matches = runDetector(DET, { run });
  assert.equal(new Set(matches.map((m) => m.key)).size, 4, 'four occurrences, four identities');

  const ledger = { F1: { detector: { ...DET, disposition: { [matchKey('scripts/a.mjs', dup)]: 'exempt — first only' } } } };
  const r = checkDetectors(ledger, { run: fakeRg([3, 40, 41, 90].map((n) => `scripts/a.mjs:${n}:  ${dup}`).join('\n') + '\n') });
  assert.equal(r.blocked, true);
  assert.equal(r.undispositioned.length, 3, 'the other three still need a decision');
});

test('the ordinal counts only among IDENTICAL text, so unrelated edits do not shift it', () => {
  const dup = 'fs.writeFileSync(tmp, data);';
  const a = runDetector(DET, { run: fakeRg(`scripts/a.mjs:3:${dup}\nscripts/a.mjs:9:${dup}\n`) });
  // Another match with different text inserted between them must not renumber either one.
  const b = runDetector(DET, { run: fakeRg(`scripts/a.mjs:3:${dup}\nscripts/a.mjs:5:fs.writeFileSync(x)\nscripts/a.mjs:99:${dup}\n`) });
  assert.deepEqual(
    b.filter((m) => m.line === dup).map((m) => m.key),
    a.map((m) => m.key),
  );
});

test('the search reaches dot-directories — a committed .claude/** tree is in scope', () => {
  // Without --hidden, a detector scoped to `.claude/skills/**` matches nothing and the gate
  // reads clean over a tree it never opened.
  const run = fakeRg('');
  runDetector({ ...DET, globs: ['.claude/skills/**'] }, { run });
  assert.ok(run.matchCall().args.includes('--hidden'));
});

// ── The load-bearing property: FULL scope ───────────────────────────────────

test('an unfixed class member still blocks — "fixed 1 of 4" must NOT converge', () => {
  // The sharpest finding of the plan audit. Restricted to the diff, the three untouched
  // occurrences are invisible and convergence passes clean.
  const ledger = { F1: { detector: { ...DET, baseline: 4 } } };
  const run = fakeRg(
    'scripts/b.mjs:3:fs.writeFileSync(a)\n'
    + 'scripts/c.mjs:9:fs.writeFileSync(b)\n'
    + 'scripts/d.mjs:1:fs.writeFileSync(c)\n',
  );
  const r = checkDetectors(ledger, { run });
  assert.equal(r.blocked, true);
  assert.equal(r.undispositioned.length, 3);
  // And the run was NOT narrowed to a changed-file list.
  assert.ok(!run.matchCall().args.some((a) => /changed|--file=/.test(String(a))));
});

// ── Capture honesty: "nothing found" vs "nothing looked" ────────────────────

test('globs that reach NO FILE are unverifiable, never clean', () => {
  // A typo'd glob, a renamed directory, or a path .gitignore shadows returns zero matches
  // and is otherwise indistinguishable from a genuinely fixed class.
  const r = checkDetectors({ F1: { detector: DET } }, { run: fakeRg('', { files: '' }) });
  assert.equal(r.blocked, true, 'a census over nothing must not converge');
  assert.equal(r.undispositioned.length, 0, 'and it is not a finding — it is an unknown');
  assert.match(r.unverifiable[0].reason, /matched no files/);
});

test('a missing ripgrep yields a BLOCKING verdict, not an exception', () => {
  // runDetector must keep throwing (a broken tool must never read as zero matches), but the
  // caller asked "did the class reach zero" and deserves an answer it can act on.
  const run = (cmd, args) => (args.includes('--files')
    ? { status: 0, stdout: 'scripts/a.mjs\n' }
    : { error: new Error('spawn rg ENOENT') });
  const r = checkDetectors({ F1: { detector: DET } }, { run });
  assert.equal(r.blocked, true);
  assert.match(r.unverifiable[0].reason, /ripgrep unavailable/);
});

test('every match dispositioned ⇒ not blocked', () => {
  const l1 = 'fs.writeFileSync(a)';
  const ledger = {
    F1: { detector: { ...DET, disposition: { [matchKey('scripts/b.mjs', l1)]: 'exempt — scratch' } } },
  };
  assert.equal(checkDetectors(ledger, { run: fakeRg(`scripts/b.mjs:3:${l1}\n`) }).blocked, false);
});

test('baseline is reporting only — it is never the pass condition', () => {
  // Matches DOWN from 4 to 1 but that one is undispositioned: still blocked.
  const ledger = { F1: { detector: { ...DET, baseline: 4 } } };
  assert.equal(checkDetectors(ledger, { run: fakeRg('scripts/b.mjs:3:fs.writeFileSync(a)\n') }).blocked, true);
});

// ── Ledger shapes ───────────────────────────────────────────────────────────

test('detectors are found in every ledger shape the repo uses', () => {
  assert.equal(collectDetectorEntries({ F1: { detector: DET } }).length, 1);
  assert.equal(collectDetectorEntries({ entries: [{ id: 'F1', detector: DET }] }).length, 1);
  assert.equal(collectDetectorEntries([{ id: 'F1', detector: DET }]).length, 1);
  assert.equal(collectDetectorEntries({ F1: { severity: 'HIGH' } }).length, 0, 'no detector ⇒ nothing to run');
  assert.equal(collectDetectorEntries(null).length, 0);
});

// ── Cross-cutting trigger is mechanical ─────────────────────────────────────

test('cross-cutting is affectedFiles>1 — never a scan of model prose', () => {
  assert.equal(isCrossCutting({ affectedFiles: ['a.mjs', 'b.mjs'] }), true);
  assert.equal(isCrossCutting({ affectedFiles: ['a.mjs'] }), false);
  // Prose is not an authority in either direction:
  assert.equal(isCrossCutting({ affectedFiles: ['a.mjs'], detail: 'fix ALL callers everywhere' }), false);
  assert.equal(isCrossCutting({ affectedFiles: ['a.mjs'], crossCutting: true }), true, 'explicit opt-in still works');
  assert.equal(isCrossCutting({}), false);
});

// ── Wired into the convergence oracle ───────────────────────────────────────

test('convergence requires the detector gate, not just the finding counts', () => {
  const met = { high: 0, medium: 1, quickFix: 0 };
  assert.equal(evaluateConvergenceWithDetectors(met, { blocked: false }).converged, true);
  const blocked = evaluateConvergenceWithDetectors(met, { blocked: true });
  assert.equal(blocked.converged, false);
  assert.equal(blocked.reason, 'detector-undispositioned',
    'the reason must name WHICH gate refused, or the operator cannot act on it');
});

test('an OMITTED detector result is not clean — it is `detector-not-run`', () => {
  // The fail-open this function's own name forbids: `detectorResult?.blocked` returned
  // converged:true for any caller that forgot to run checkDetectors, so a wiring regression
  // would restore exactly the green-without-checking the detector protocol exists to remove.
  const met = { high: 0, medium: 1, quickFix: 0 };
  for (const absent of [undefined, null, {}, { blocked: 'no' }]) {
    const r = evaluateConvergenceWithDetectors(met, absent);
    assert.equal(r.converged, false, `${JSON.stringify(absent)} must not converge`);
    assert.equal(r.reason, 'detector-not-run');
  }
  // "No detectors were declared" is a real, distinct answer — and it is checkDetectors' own
  // output, so declaring it costs a call rather than a claim.
  assert.equal(evaluateConvergenceWithDetectors(met, { blocked: false, checked: 0 }).converged, true);
});

test('the finding-count threshold still fails first, and reports itself', () => {
  const r = evaluateConvergenceWithDetectors({ high: 1, medium: 0, quickFix: 0 }, { blocked: false });
  assert.equal(r.converged, false);
  assert.equal(r.reason, 'finding-thresholds');
});

// ── The CLI wrapper (Step 5.0b) ────────────────────────────────────────────
//
// Step 5.0b used to be a `node -e "import('./scripts/lib/audit/detector.mjs')"`
// snippet, which the consumer sync's command rewriter cannot relocate — so it
// could not run in any consumer repo (reported 2026-08-08, same class as
// /plan's Gate-1 self-check). It is now a CLI entry point, and its exit mapping
// is what /audit-code's SKILL.md tells the operator to read.

test('the detector CLI maps its three outcomes onto distinct exit codes', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-cli-'));
  const CLI = 'scripts/lib/audit/detector.mjs';
  const run = (arg) => spawnSync(process.execPath, arg === null ? [CLI] : [CLI, arg], { encoding: 'utf-8' });

  // Clean: no detectors to run ⇒ nothing blocks.
  const clean = path.join(dir, 'clean.json');
  fs.writeFileSync(clean, JSON.stringify({ version: 1, entries: [] }));
  const ok = run(clean);
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).blocked, false);

  // Blocked: a detector whose globs reach nothing is UNVERIFIABLE — "no census
  // happened" must never read as a clean class, so it blocks.
  const blocked = path.join(dir, 'blocked.json');
  fs.writeFileSync(blocked, JSON.stringify({
    version: 1,
    entries: [{
      topicId: 'x', id: 'H1',
      detector: { kind: 'regex', pattern: 'nothing-matches-this', globs: ['no/such/dir/**'] },
    }],
  }));
  const bad = run(blocked);
  assert.equal(bad.status, 1, 'an unverifiable detector must block, not pass');
  assert.equal(JSON.parse(bad.stdout).blocked, true);

  // Unreadable ledger: also "no census happened" — never exit 0.
  assert.equal(run(path.join(dir, 'absent.json')).status, 2);
  // No argument at all: usage, still non-zero.
  assert.equal(run(null).status, 2);
});
