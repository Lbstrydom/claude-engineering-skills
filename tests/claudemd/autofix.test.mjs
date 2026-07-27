import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { applyFixes } from '../../scripts/lib/claudemd/autofix.mjs';
import { trySymlink } from '../helpers/fs-symlink-test-utils.mjs';

const tmpDirs = [];
function mkTmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-test-'));
  tmpDirs.push(dir);
  return dir;
}
function mkTmpOutsideDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-outside-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ }
  }
});

describe('applyFixes — write path (atomic-write-adoption plan)', () => {
  it('dryRun:false actually removes the standalone link line and persists it', () => {
    const repoRoot = mkTmpRepo();
    const relFile = 'AGENTS.md';
    fs.writeFileSync(
      path.join(repoRoot, relFile),
      'line one\n[stale ref](docs/gone.md)\nline three\n',
    );
    const findings = [
      { file: relFile, line: 2, fixable: true, ruleId: 'stale/file-ref' },
    ];

    const result = applyFixes(findings, repoRoot, { dryRun: false });

    assert.equal(result.applied.length, 1);
    assert.match(result.applied[0].action, /^removed:/);
    const after = fs.readFileSync(path.join(repoRoot, relFile), 'utf-8');
    assert.equal(after, 'line one\nline three\n');
  });

  it('dryRun:true (default) reports without modifying the file', () => {
    const repoRoot = mkTmpRepo();
    const relFile = 'AGENTS.md';
    const original = 'line one\n[stale ref](docs/gone.md)\nline three\n';
    fs.writeFileSync(path.join(repoRoot, relFile), original);
    const findings = [
      { file: relFile, line: 2, fixable: true, ruleId: 'stale/file-ref' },
    ];

    const result = applyFixes(findings, repoRoot);

    assert.match(result.applied[0].action, /^would remove:/);
    assert.equal(fs.readFileSync(path.join(repoRoot, relFile), 'utf-8'), original);
  });
});

describe('applyFixes — defect #1: dedup by (canonical, line) before splice', () => {
  it('two findings sharing the identical (file, line) — first applied, second skipped as duplicate, no double-splice', () => {
    const repoRoot = mkTmpRepo();
    const relFile = 'AGENTS.md';
    fs.writeFileSync(
      path.join(repoRoot, relFile),
      'line one\n[`docs/<gone>.md`](docs/<gone>.md)\nline three\n',
    );
    const findings = [
      { file: relFile, line: 2, fixable: true, ruleId: 'stale/file-ref' },
      { file: relFile, line: 2, fixable: true, ruleId: 'stale/file-ref' },
    ];

    const result = applyFixes(findings, repoRoot, { dryRun: false });

    assert.equal(result.applied.length, 1, 'exactly one applied entry');
    assert.equal(result.skipped.length, 1, 'exactly one skipped entry');
    assert.equal(result.skipped[0].reason, 'duplicate finding for already-processed line');
    const after = fs.readFileSync(path.join(repoRoot, relFile), 'utf-8');
    assert.equal(after, 'line one\nline three\n', 'exactly the intended line removed, not a neighbour, not twice');
  });

  it('negative control: two DIFFERENT lines, both genuinely fixable — untouched multi-finding behaviour', () => {
    const repoRoot = mkTmpRepo();
    const relFile = 'AGENTS.md';
    fs.writeFileSync(
      path.join(repoRoot, relFile),
      'line one\n[a](docs/a.md)\n[b](docs/b.md)\nline four\n',
    );
    const findings = [
      { file: relFile, line: 2, fixable: true, ruleId: 'stale/file-ref' },
      { file: relFile, line: 3, fixable: true, ruleId: 'stale/file-ref' },
    ];

    const result = applyFixes(findings, repoRoot, { dryRun: false });

    assert.equal(result.applied.length, 2);
    assert.equal(result.skipped.length, 0);
    assert.equal(fs.readFileSync(path.join(repoRoot, relFile), 'utf-8'), 'line one\nline four\n');
  });

  it('cross-alias dedup: two DIFFERENT finding.file spellings resolving to the SAME physical file are grouped and deduplicated together', (t) => {
    const repoRoot = mkTmpRepo();
    const relFile = 'AGENTS.md';
    fs.writeFileSync(path.join(repoRoot, relFile), 'line one\n[a](docs/a.md)\n');
    const aliasName = 'ALIAS.md';
    if (!trySymlink(path.join(repoRoot, relFile), path.join(repoRoot, aliasName), 'file')) {
      t.skip('symlink creation unavailable on this host — cross-alias dedup NOT verified');
      return;
    }

    // Two findings, different `file` strings, same line, same physical target.
    const findings = [
      { file: relFile, line: 2, fixable: true, ruleId: 'stale/file-ref' },
      { file: aliasName, line: 2, fixable: true, ruleId: 'stale/file-ref' },
    ];

    const result = applyFixes(findings, repoRoot, { dryRun: false });

    assert.equal(result.applied.length, 1, 'exactly one applied entry across both aliases');
    assert.equal(result.skipped.length, 1, 'the second alias is skipped as a duplicate');
    assert.equal(result.skipped[0].reason, 'duplicate finding for already-processed line');
    // Exactly one line removed, and the file has only 2 lines total — this
    // fixture alone can't fully distinguish canonical-grouping from a
    // coincidentally-similar raw-file-grouping result on a different layout
    // (Gemini gate shadow finding caf64562), but combined with the Map-based
    // grouping structure (one canonical key -> exactly one read+write per
    // physical target, by construction) this is the expected outcome.
    assert.equal(fs.readFileSync(path.join(repoRoot, relFile), 'utf-8'), 'line one\n');
  });

  it('bounds check uses the ORIGINAL length, not the live (post-splice) one — identical outcome in dry-run and real-run', () => {
    const content = 'header\n[a](docs/a.md)\n[b](docs/b.md)\n[c](docs/c.md)\n';
    // 4 lines: line 4 is a unique valid finding; line 3 carries a duplicate
    // pair. Sorted descending: line4, line3(first), line3(second). Once
    // line4 and the first line3 have spliced in real-run mode, a LIVE
    // lines.length check would have shrunk to 2, making the SECOND line-3
    // finding's bounds check (3 > 2) wrongly fire BEFORE the dedup check —
    // misreporting "invalid line number" instead of "duplicate finding".
    const findings = [
      { file: 'AGENTS.md', line: 4, fixable: true, ruleId: 'stale/file-ref' },
      { file: 'AGENTS.md', line: 3, fixable: true, ruleId: 'stale/file-ref' },
      { file: 'AGENTS.md', line: 3, fixable: true, ruleId: 'stale/file-ref' },
    ];

    const realRoot = mkTmpRepo();
    fs.writeFileSync(path.join(realRoot, 'AGENTS.md'), content);
    const realResult = applyFixes(findings, realRoot, { dryRun: false });

    const dryRoot = mkTmpRepo();
    fs.writeFileSync(path.join(dryRoot, 'AGENTS.md'), content);
    const dryResult = applyFixes(findings, dryRoot, { dryRun: true });

    for (const [label, result] of [['real-run', realResult], ['dry-run', dryResult]]) {
      assert.equal(result.applied.length, 2, `${label}: line 4 + first line 3 applied`);
      assert.equal(result.skipped.length, 1, `${label}: second line 3 skipped`);
      assert.equal(
        result.skipped[0].reason,
        'duplicate finding for already-processed line',
        `${label}: must be reported as duplicate, never as invalid line number`,
      );
    }
  });

  it('a string-typed duplicate line number (e.g. "2" vs 2) is still caught by dedup, not double-spliced (round-1 audit 817bc3d4)', () => {
    const repoRoot = mkTmpRepo();
    const relFile = 'AGENTS.md';
    fs.writeFileSync(path.join(repoRoot, relFile), 'line one\n[a](docs/a.md)\nline three\n');
    const findings = [
      { file: relFile, line: 2, fixable: true, ruleId: 'stale/file-ref' },
      { file: relFile, line: '2', fixable: true, ruleId: 'stale/file-ref' },
    ];

    const result = applyFixes(findings, repoRoot, { dryRun: false });

    assert.equal(result.applied.length, 1, 'exactly one applied entry, regardless of line-value type');
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, 'duplicate finding for already-processed line');
    assert.equal(fs.readFileSync(path.join(repoRoot, relFile), 'utf-8'), 'line one\nline three\n', 'not double-spliced');
  });
});

describe('applyFixes — round-1 audit hardening: untrusted finding.file / non-object array entries (67233241)', () => {
  it('a fixable finding with a non-string `file` is reported via skipped (invalid file path), never crashes the run', () => {
    const repoRoot = mkTmpRepo();
    const relFile = 'AGENTS.md';
    fs.writeFileSync(path.join(repoRoot, relFile), 'line one\n[a](docs/a.md)\n');
    const findings = [
      { file: 12345, line: 1, fixable: true, ruleId: 'stale/file-ref' },
      { file: relFile, line: 2, fixable: true, ruleId: 'stale/file-ref' },
    ];

    const result = applyFixes(findings, repoRoot, { dryRun: false });

    assert.equal(result.applied.length, 1, 'the OTHER, well-formed finding must still be processed');
    const badSkip = result.skipped.find((s) => s.file === 12345);
    assert.ok(badSkip, 'the non-string-file finding must be reported, never silently dropped or crash the run');
    assert.equal(badSkip.reason, 'invalid file path');
  });

  it('a null/non-object entry in the findings array is reported via skipped (round-2 audit 5a482bc2), not silently dropped — no crash, other findings unaffected', () => {
    const repoRoot = mkTmpRepo();
    const relFile = 'AGENTS.md';
    fs.writeFileSync(path.join(repoRoot, relFile), 'line one\n[a](docs/a.md)\n');
    const findings = [
      null,
      undefined,
      'not-an-object',
      { file: relFile, line: 2, fixable: true, ruleId: 'stale/file-ref' },
    ];

    let result;
    assert.doesNotThrow(() => { result = applyFixes(findings, repoRoot, { dryRun: true }); });
    assert.equal(result.applied.length, 1, 'the one well-formed, fixable finding is still processed');
    assert.equal(result.skipped.length, 3, 'each malformed array entry gets its own skipped entry — a producer regression is never invisible');
    for (const s of result.skipped) assert.match(s.reason, /^malformed finding at index \d+$/);
  });

  it('a well-formed finding that simply is not fixable (wrong ruleId) is silently untouched, unlike a malformed array entry', () => {
    const repoRoot = mkTmpRepo();
    const findings = [{ file: 'AGENTS.md', line: 2, fixable: true, ruleId: 'some-other-rule' }];
    const result = applyFixes(findings, repoRoot, { dryRun: true });
    assert.equal(result.applied.length, 0);
    assert.equal(result.skipped.length, 0, 'a normal non-applicable finding is not malformed and stays untouched, same as pre-plan behaviour');
  });

  it('a non-integer-but-coercible finding.line (true, a single-element array) is rejected as invalid, never silently mistaken for a real line (round-3 audit 69995e0f)', () => {
    const repoRoot = mkTmpRepo();
    const relFile = 'AGENTS.md';
    const original = '[unrelated](docs/unrelated.md)\nbody\n';
    fs.writeFileSync(path.join(repoRoot, relFile), original);

    for (const badLine of [true, [1], 1.5, -1, 0, '007', '1.5', ' 1']) {
      const result = applyFixes(
        [{ file: relFile, line: badLine, fixable: true, ruleId: 'stale/file-ref' }],
        repoRoot,
        { dryRun: false },
      );
      assert.equal(result.applied.length, 0, `line=${JSON.stringify(badLine)} must never be treated as a real line`);
      assert.equal(result.skipped[0]?.reason, 'invalid line number', `line=${JSON.stringify(badLine)}`);
      assert.equal(fs.readFileSync(path.join(repoRoot, relFile), 'utf-8'), original, `line=${JSON.stringify(badLine)} must not mutate the file`);
    }
  });

  it('a Symbol-valued finding.line does not throw (fails closed as invalid, never aborts the run)', () => {
    const repoRoot = mkTmpRepo();
    const relFile = 'AGENTS.md';
    fs.writeFileSync(path.join(repoRoot, relFile), '[a](docs/a.md)\n');
    const findings = [{ file: relFile, line: Symbol('bad'), fixable: true, ruleId: 'stale/file-ref' }];

    let result;
    assert.doesNotThrow(() => { result = applyFixes(findings, repoRoot, { dryRun: false }); });
    assert.equal(result.applied.length, 0);
    assert.equal(result.skipped[0].reason, 'invalid line number');
  });

  it('legitimate decimal-string line numbers ("2") are still accepted (not a regression from the stricter grammar)', () => {
    const repoRoot = mkTmpRepo();
    const relFile = 'AGENTS.md';
    fs.writeFileSync(path.join(repoRoot, relFile), 'line one\n[a](docs/a.md)\nline three\n');
    const result = applyFixes(
      [{ file: relFile, line: '2', fixable: true, ruleId: 'stale/file-ref' }],
      repoRoot,
      { dryRun: false },
    );
    assert.equal(result.applied.length, 1);
    assert.equal(fs.readFileSync(path.join(repoRoot, relFile), 'utf-8'), 'line one\nline three\n');
  });
});

describe('applyFixes — defect #2: containment (INC-001-pattern regression)', () => {
  it('a `../`-escaping relative path is refused; the outside target is never read or written', () => {
    const repoRoot = mkTmpRepo();
    const outsideDir = mkTmpOutsideDir();
    // NOT named "secret*"/"credential*" — that would (correctly) hit this
    // repo's own SENSITIVE_PATTERNS lexical fast-path and short-circuit
    // before the escape/containment check this test targets.
    const outsideFile = path.join(outsideDir, 'outside-note.md');
    const outsideContent = 'header\n[link](docs/x.md)\n';
    fs.writeFileSync(outsideFile, outsideContent);
    const escapingRel = path.relative(repoRoot, outsideFile);

    const findings = [{ file: escapingRel, line: 2, fixable: true, ruleId: 'stale/file-ref' }];
    const result = applyFixes(findings, repoRoot, { dryRun: false });

    assert.equal(result.applied.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, 'path escapes repo root');
    assert.equal(fs.readFileSync(outsideFile, 'utf-8'), outsideContent, 'outside file must be untouched');
  });

  it('a finding whose path lexically matches a sensitive pattern is refused', () => {
    const repoRoot = mkTmpRepo();
    fs.writeFileSync(path.join(repoRoot, '.env'), 'SECRET=1\n[link](docs/x.md)\n');
    const findings = [{ file: '.env', line: 2, fixable: true, ruleId: 'stale/file-ref' }];

    const result = applyFixes(findings, repoRoot, { dryRun: false });

    assert.equal(result.applied.length, 0);
    assert.equal(result.skipped[0].reason, 'path classified sensitive');
  });

  it('reason precedence: a path that is BOTH resolution-failed and category=sensitive (resolveAndClassify sets category=\'sensitive\' on every refusal) reports resolutionFailed\'s reason, not the generic sensitive one', () => {
    // resolveAndClassify's resolutionFailed branch always ALSO returns
    // category:'sensitive' — without a stated precedence, the reason text
    // is an unspecified contract. A nonexistent path (non-sensitive-looking
    // name) hits exactly this dual-true branch.
    const repoRoot = mkTmpRepo();
    const findings = [{ file: 'no-such-file.md', line: 1, fixable: true, ruleId: 'stale/file-ref' }];

    const result = applyFixes(findings, repoRoot, { dryRun: false });

    assert.equal(result.applied.length, 0, 'not silently dropped — one skipped entry, never zero results');
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, 'path resolution failed', 'resolutionFailed takes precedence over the generic sensitive category');
  });

  it('symlink escape: an in-repo path that is a symlink to a file outside repoRoot is refused; the outside target is never read or written', (t) => {
    const repoRoot = mkTmpRepo();
    const outsideDir = mkTmpOutsideDir();
    const outsideFile = path.join(outsideDir, 'target.md');
    const outsideContent = 'header\n[link](docs/x.md)\n';
    fs.writeFileSync(outsideFile, outsideContent);
    const linkPath = path.join(repoRoot, 'notes-that-looks-safe.md');
    if (!trySymlink(outsideFile, linkPath, 'file')) {
      t.skip('symlink creation unavailable on this host — symlink-escape NOT verified');
      return;
    }

    const findings = [{ file: 'notes-that-looks-safe.md', line: 2, fixable: true, ruleId: 'stale/file-ref' }];
    const result = applyFixes(findings, repoRoot, { dryRun: false });

    assert.equal(result.applied.length, 0);
    assert.equal(result.skipped[0].reason, 'path escapes repo root');
    assert.equal(fs.readFileSync(outsideFile, 'utf-8'), outsideContent, 'outside file must be untouched');
  });

  it('a symlinked repoRoot does not false-positive a genuinely in-repo finding as an escape', (t) => {
    const realRoot = mkTmpRepo();
    fs.writeFileSync(path.join(realRoot, 'AGENTS.md'), 'line one\n[link](docs/x.md)\n');
    const symlinkRoot = path.join(os.tmpdir(), `autofix-repo-symlink-${process.pid}-${Date.now()}`);
    if (!trySymlink(realRoot, symlinkRoot, 'dir')) {
      t.skip('symlink creation unavailable on this host — symlinked-repoRoot NOT verified');
      return;
    }
    tmpDirs.push(symlinkRoot);

    const findings = [{ file: 'AGENTS.md', line: 2, fixable: true, ruleId: 'stale/file-ref' }];
    const result = applyFixes(findings, symlinkRoot, { dryRun: false });

    assert.equal(result.skipped.length, 0, 'a genuinely in-repo finding must not be refused when repoRoot itself is a symlink');
    assert.equal(result.applied.length, 1);
  });
});

describe('applyFixes — defect #3: silent I/O failure', () => {
  it('a readFileSync failure surfaces via skipped for every finding in that group — other groups still process', (t) => {
    const repoRoot = mkTmpRepo();
    const okFile = 'OK.md';
    const failFile = 'FAIL.md';
    fs.writeFileSync(path.join(repoRoot, okFile), 'line one\n[link](docs/a.md)\n');
    fs.writeFileSync(path.join(repoRoot, failFile), 'line one\n[link](docs/b.md)\n');

    const failCanonical = fs.realpathSync(path.join(repoRoot, failFile));
    const realReadFileSync = fs.readFileSync.bind(fs);
    t.mock.method(fs, 'readFileSync', (p, ...rest) => {
      if (path.resolve(String(p)) === path.resolve(failCanonical)) {
        throw Object.assign(new Error('boom'), { code: 'EACCES' });
      }
      return realReadFileSync(p, ...rest);
    });

    const findings = [
      { file: okFile, line: 2, fixable: true, ruleId: 'stale/file-ref' },
      { file: failFile, line: 2, fixable: true, ruleId: 'stale/file-ref' },
    ];
    const result = applyFixes(findings, repoRoot, { dryRun: false });

    assert.equal(result.applied.length, 1, 'the OTHER (non-failing) group must still be processed');
    assert.equal(result.applied[0].file, okFile);
    const failSkip = result.skipped.find((s) => s.file === failFile);
    assert.ok(failSkip, 'the failing group must produce a skipped entry, never silently zero results');
    assert.match(failSkip.reason, /^read failed: EACCES/);
  });
});

describe('applyFixes — dry-run/real-run partition consistency', () => {
  it('produces identical applied/skipped counts and reasons whether dryRun is true or false, over a fixture combining a same-file duplicate and a cross-alias duplicate', (t) => {
    const content = 'header\n[a](docs/a.md)\n[b](docs/b.md)\n[c](docs/c.md)\n';
    const relFile = 'AGENTS.md';

    function buildFixture() {
      const repoRoot = mkTmpRepo();
      fs.writeFileSync(path.join(repoRoot, relFile), content);
      const aliasName = 'ALIAS.md';
      const hasSymlink = trySymlink(path.join(repoRoot, relFile), path.join(repoRoot, aliasName), 'file');
      const findings = [
        { file: relFile, line: 2, fixable: true, ruleId: 'stale/file-ref' },  // unique
        { file: relFile, line: 3, fixable: true, ruleId: 'stale/file-ref' },  // same-file dup member 1
        { file: relFile, line: 3, fixable: true, ruleId: 'stale/file-ref' },  // same-file dup member 2
      ];
      if (hasSymlink) {
        findings.push({ file: relFile, line: 4, fixable: true, ruleId: 'stale/file-ref' });   // cross-alias member A
        findings.push({ file: aliasName, line: 4, fixable: true, ruleId: 'stale/file-ref' });  // cross-alias member B
      }
      return { repoRoot, findings, hasSymlink };
    }

    const dry = buildFixture();
    const dryResult = applyFixes(dry.findings, dry.repoRoot, { dryRun: true });

    const real = buildFixture();
    const realResult = applyFixes(real.findings, real.repoRoot, { dryRun: false });

    if (!dry.hasSymlink) {
      t.skip('symlink creation unavailable on this host — cross-alias half of this fixture NOT exercised (same-file dedup half still ran)');
    }

    assert.equal(dryResult.applied.length, realResult.applied.length, 'applied count must match between dry-run and real-run');
    assert.equal(dryResult.skipped.length, realResult.skipped.length, 'skipped count must match between dry-run and real-run');
    assert.deepEqual(
      dryResult.skipped.map((s) => s.reason).sort(),
      realResult.skipped.map((s) => s.reason).sort(),
      'skip reasons must match between dry-run and real-run',
    );
    for (const entry of dryResult.applied) assert.match(entry.action, /^would remove:/);
    for (const entry of realResult.applied) assert.match(entry.action, /^removed:/);
  });
});
