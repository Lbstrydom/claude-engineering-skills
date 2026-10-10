/**
 * Cluster C audit R1 fixes (docs/plans/file-coverage-contract-and-csharp.md): each pins the direction the defect used to fail in.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatCoverageSuffix, oneLine } from '../scripts/lib/coverage-format.mjs';
import { waveRecord, waveEligibility } from '../scripts/lib/audit/wave-eligibility.mjs';
import { getRuleMetadata } from '../scripts/lib/rule-metadata.mjs';
import { buildChangeRecord } from '../scripts/lib/audit/change-record.mjs';
import { runTool, setExecFileSync, setExistsSync } from '../scripts/lib/linter.mjs';
import { detectShape } from '../scripts/lib/fit-check/detect.mjs';
import { applyRules } from '../scripts/lib/fit-check/rules.mjs';

describe('formatCoverageSuffix recognises a ledger by SHAPE, not by its status string', () => {
  it('{status:"complete"} alone is INVALID, never a clean ledger', () => {
    assert.match(formatCoverageSuffix({ status: 'complete' }), /LEDGER INVALID/);
    assert.match(formatCoverageSuffix({ status: 'partial', counts: {} }), /LEDGER INVALID/);
  });
  it('control: a shaped complete ledger still prints empty', () => {
    assert.equal(formatCoverageSuffix({ status: 'complete', counts: { required: 1, short: 0 }, files: [] }), '');
  });
  it('a capped projection prints its per-file counts as a floor', () => {
    const rec = { outcome: 'deleted', class: 'profiled', read: { state: 'none' } };
    const s = formatCoverageSuffix({
      status: 'partial', counts: { required: 90, short: 60 },
      filesProjection: { shown: [rec], shortTotal: 60 },
    });
    assert.match(s, /at least 1 deleted source file/);
  });
  it('repository-controlled text cannot carry control characters into the line', () => {
    assert.equal(oneLine('a\nb\u001b[31m'), 'a?b?[31m');
    const s = formatCoverageSuffix({ status: 'partial', counts: { required: 1, short: 1 }, files: [], uncoveredByExtension: { '.x\ny': 1 } });
    assert.ok(!s.includes('\n'));
  });
});

describe('waveRecord: an execution failure outranks ineligibility', () => {
  it('errored + ineligible input is ERRORED', () => {
    const e = waveEligibility(['a.cs'], () => false);
    assert.equal(e.state, 'ineligible');
    assert.equal(waveRecord(e, 'js/ts', 'errored', 'boom').state, 'errored');
  });
  it('control: a completed wave over ineligible input is still ineligible', () => {
    const e = waveEligibility(['a.cs'], () => false);
    assert.equal(waveRecord(e, 'js/ts').state, 'ineligible');
  });
});

describe('getRuleMetadata uses own-property lookup', () => {
  it('an inherited Object.prototype name falls to the tool default', () => {
    assert.deepEqual(getRuleMetadata('msbuild', 'toString'), getRuleMetadata('msbuild', 'NOPE_NOT_A_RULE'));
    assert.deepEqual(getRuleMetadata('constructor', 'x'), getRuleMetadata('__nope__', 'x'));
  });
});

describe('buildChangeRecord does not hide a failed change-kind lookup', () => {
  const base = { diffChanged: ['a.cs'], untrackedFiles: [], baseSha: 'abc', allowInfraScope: false, excludePatterns: [], applyExclusions: (f) => f };
  it('a throwing git call is reported on the record, and the set is unchanged', () => {
    const r = buildChangeRecord({ ...base, run: () => { throw new Error('git exploded'); } });
    assert.equal(r.nameStatusError, 'git exploded');
    assert.deepEqual(r.changed.map((c) => c.path), ['a.cs']);
  });
  it('malformed (truncated) output is reported, not parsed into a short list', () => {
    const r = buildChangeRecord({ ...base, run: () => 'M\0a.cs' });
    assert.match(r.nameStatusError, /NUL-terminated/);
  });
  it('control: well-formed output carries no error and real kinds', () => {
    const r = buildChangeRecord({ ...base, run: () => 'D\0a.cs\0' });
    assert.equal(r.nameStatusError, null);
    assert.equal(r.changed[0].changeKind, 'deleted');
  });
});

// docs/plans/audit-hunk-window-coverage.md D6: R1 gets diff hunks from the change record (R1 had none at all).
describe('buildChangeRecord attaches new-side hunks per changed file', () => {
  const base = { diffChanged: ['a.js', 'img.png'], untrackedFiles: ['new.js'], baseSha: 'abc', allowInfraScope: false, excludePatterns: [], applyExclusions: (f) => f };
  const u0 = [
    'diff --git a/a.js b/a.js', 'index 1111111..2222222 100644', '--- a/a.js', '+++ b/a.js',
    '@@ -10,2 +10,3 @@ fn', '+x', '+y', '+z', '@@ -40 +41,0 @@', '-gone', '',
  ].join('\n');
  const calls = [];
  const run = (cmd, args) => {
    calls.push(args);
    if (args.includes('--name-status')) return 'M\0a.js\0M\0img.png\0';
    return u0;
  };
  it('tracked files get their hunks, an unmentioned (binary) file stays unknown, an untracked file one whole-file hunk', () => {
    const r = buildChangeRecord({ ...base, run, readText: (p) => (p === 'new.js' ? 'a\nb\nc' : null) });
    const by = Object.fromEntries(r.changed.map((c) => [c.path, c.hunks]));
    assert.deepEqual(by['a.js'], [{ startLine: 10, lineCount: 3 }, { startLine: 41, lineCount: 0 }]);
    assert.equal(by['img.png'], undefined, 'absent from the diff is unknown, never a measured empty change (code audit R2 H5)');
    assert.deepEqual(by['new.js'], [{ startLine: 1, lineCount: 3 }]);
    const u0Call = calls.find((a) => a.includes('-U0'));
    assert.ok(u0Call.includes('--src-prefix=a/') && u0Call.includes('--dst-prefix=b/'), 'a diff.noprefix config must not empty the map');
    assert.ok(u0Call.includes('--no-textconv'), 'hunk coordinates must number the bytes the readers render');
  });
  it('a C-quoted (non-ASCII) path keeps its hunks — an unrecognised header must not read as "no change"', () => {
    const q = (side) => `"${side}/caf\\303\\251.js"`;   // git's C-quoting of café.js under core.quotePath
    const quoted = [`diff --git ${q('a')} ${q('b')}`, 'index 1111111..2222222 100644', `--- ${q('a')}`, `+++ ${q('b')}`, '@@ -3 +3,2 @@', '+x', '+y', ''].join('\n');
    const nameStatus = ['M', 'café.js', ''].join('\u0000');
    const r = buildChangeRecord({ ...base, diffChanged: ['café.js'], untrackedFiles: [], run: (cmd, args) => (args.includes('--name-status') ? nameStatus : quoted) });
    assert.deepEqual(r.changed[0].hunks, [{ startLine: 3, lineCount: 2 }]);
  });
  it('an untracked file that cannot be read stays UNKNOWN (no hunks), never a measured empty change', () => {
    const r = buildChangeRecord({ ...base, run, readText: () => null });
    const rec = r.changed.find((c) => c.path === 'new.js');
    assert.equal('hunks' in rec, false);
  });
  it('a failed hunk read leaves `hunks` absent (unknown), never [] (which would mean "nothing changed")', () => {
    const r = buildChangeRecord({ ...base, run: (cmd, args) => { if (args.includes('-U0')) throw new Error('ENOBUFS'); return 'M\0a.js\0M\0img.png\0'; }, readText: () => 'a' });
    assert.ok(r.changed.every((c) => !('hunks' in c)));
  });
});

describe('runTool', () => {
  it('a self-referencing fallback fails the tool instead of recursing forever', () => {
    setExistsSync(() => true);
    setExecFileSync(() => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); });
    const cfg = { id: 'loop', kind: 'lint', command: 'x', args: ['.'], parser: 'eslint-json', availabilityProbe: ['x', '--version'] };
    cfg.fallback = cfg;
    const r = runTool(cfg, ['a.js'], 'js');
    assert.equal(r.status, 'failed');
    assert.match(r.stderr, /fallback cycle/);
  });
});

describe('fit-check: a C#-only repo is not "no recognised stack" for /audit-code', () => {
  it('FITS, naming csharp', () => {
    const v = applyRules({ stack: 'unknown', stackKinds: ['csharp'] }).find((x) => x.skill === '/audit-code');
    assert.equal(v.label, 'FITS');
    assert.match(v.reason, /csharp/);
  });
  it('control: an unknown stack with no kinds is still PARTIAL', () => {
    const v = applyRules({ stack: 'unknown', stackKinds: [] }).find((x) => x.skill === '/audit-code');
    assert.equal(v.label, 'PARTIAL');
  });
});
