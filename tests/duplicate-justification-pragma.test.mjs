/**
 * @fileoverview Tier-1 tests for scripts/lib/duplicate-justification-pragma.mjs
 * (arch-drift-duplication-cleanup plan). `resolvePragmasToDefinitions` is a
 * pure function — the primary coverage here, no git/DB fixtures needed.
 * `findRepoPragmas` gets a light live-repo smoke test (it already finds
 * this repo's own real pragmas).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  PRAGMA_RE,
  findRepoPragmas,
  resolvePragmasToDefinitions,
  PRAGMA_RESOLUTION_MAX_GAP_LINES,
} from '../scripts/lib/duplicate-justification-pragma.mjs';

describe('PRAGMA_RE', () => {
  it('matches a // comment pragma', () => {
    const m = PRAGMA_RE.exec('// @duplicate-justification: target=a/b.mjs:foo reason=intentional');
    assert.ok(m);
    assert.equal(m[1], 'a/b.mjs');
    assert.equal(m[2], 'foo');
    assert.equal(m[3], 'intentional');
  });

  it('matches a # comment pragma', () => {
    const m = PRAGMA_RE.exec('# @duplicate-justification: target=a.py:bar reason=cli stays dependency-free');
    assert.ok(m);
    assert.equal(m[1], 'a.py');
  });
});

describe('resolvePragmasToDefinitions', () => {
  const pragma = (pragmaFile, pragmaLine, targetFile = 't.mjs', targetSymbol = 'x', reason = 'r') =>
    ({ pragmaFile, pragmaLine, targetFile, targetSymbol, reason });
  const candidate = (filePath, symbolName, kind, startLine, definitionId) =>
    ({ filePath, symbolName, kind, startLine, definitionId });

  it('resolves a pragma to the next declaration in the same file', () => {
    const pragmas = [pragma('a.mjs', 10)];
    const candidates = [candidate('a.mjs', 'foo', 'function', 11, 'def-1')];
    const { resolved, ambiguous, unresolved } = resolvePragmasToDefinitions(pragmas, candidates);
    assert.deepEqual(resolved, [{ definitionId: 'def-1', reason: 'r', target: 't.mjs:x', source: 'a.mjs:10' }]);
    assert.deepEqual(ambiguous, []);
    assert.deepEqual(unresolved, []);
  });

  it('picks the SMALLEST start_line strictly after the pragma line (nearest declaration)', () => {
    const pragmas = [pragma('a.mjs', 10)];
    const candidates = [
      candidate('a.mjs', 'far', 'function', 14, 'def-far'),
      candidate('a.mjs', 'near', 'function', 11, 'def-near'),
    ];
    const { resolved } = resolvePragmasToDefinitions(pragmas, candidates);
    assert.equal(resolved[0].definitionId, 'def-near');
  });

  it('ignores a declaration ON or BEFORE the pragma line', () => {
    const pragmas = [pragma('a.mjs', 10)];
    const candidates = [candidate('a.mjs', 'before', 'function', 10, 'def-before')];
    const { resolved, unresolved } = resolvePragmasToDefinitions(pragmas, candidates);
    assert.deepEqual(resolved, []);
    assert.equal(unresolved.length, 1);
  });

  it(`rejects a match beyond the ${PRAGMA_RESOLUTION_MAX_GAP_LINES}-line gap`, () => {
    const pragmas = [pragma('a.mjs', 10)];
    const candidates = [candidate('a.mjs', 'far', 'function', 10 + PRAGMA_RESOLUTION_MAX_GAP_LINES + 1, 'def-far')];
    const { resolved, unresolved } = resolvePragmasToDefinitions(pragmas, candidates);
    assert.deepEqual(resolved, []);
    assert.equal(unresolved.length, 1);
  });

  it(`accepts a match exactly at the ${PRAGMA_RESOLUTION_MAX_GAP_LINES}-line gap boundary`, () => {
    const pragmas = [pragma('a.mjs', 10)];
    const candidates = [candidate('a.mjs', 'boundary', 'function', 10 + PRAGMA_RESOLUTION_MAX_GAP_LINES, 'def-b')];
    const { resolved } = resolvePragmasToDefinitions(pragmas, candidates);
    assert.equal(resolved.length, 1);
  });

  it('ignores candidates in a DIFFERENT file', () => {
    const pragmas = [pragma('a.mjs', 10)];
    const candidates = [candidate('b.mjs', 'foo', 'function', 11, 'def-1')];
    const { resolved, unresolved } = resolvePragmasToDefinitions(pragmas, candidates);
    assert.deepEqual(resolved, []);
    assert.equal(unresolved.length, 1);
  });

  it('multiple pragmas resolving to the SAME definition: NEITHER is trusted, both go to ambiguous (round-5 M5)', () => {
    const pragmas = [pragma('a.mjs', 5), pragma('a.mjs', 8)];
    const candidates = [candidate('a.mjs', 'foo', 'function', 10, 'def-1')];
    const { resolved, ambiguous } = resolvePragmasToDefinitions(pragmas, candidates);
    assert.deepEqual(resolved, [], 'an ambiguous declaration must not be excluded from the drift score based on an unreliable signal');
    assert.equal(ambiguous.length, 2);
    assert.deepEqual(ambiguous.map((a) => a.pragmaLine).sort(), [5, 8]);
  });

  it('a candidate with no definitionId is never a resolution target', () => {
    const pragmas = [pragma('a.mjs', 10)];
    const candidates = [candidate('a.mjs', 'foo', 'function', 11, undefined)];
    const { resolved, unresolved } = resolvePragmasToDefinitions(pragmas, candidates);
    assert.deepEqual(resolved, []);
    assert.equal(unresolved.length, 1);
  });

  it('independent pragmas in independent files all resolve correctly together', () => {
    const pragmas = [pragma('a.mjs', 10), pragma('b.mjs', 20)];
    const candidates = [
      candidate('a.mjs', 'foo', 'function', 11, 'def-a'),
      candidate('b.mjs', 'bar', 'function', 21, 'def-b'),
    ];
    const { resolved, ambiguous, unresolved } = resolvePragmasToDefinitions(pragmas, candidates);
    assert.equal(resolved.length, 2);
    assert.deepEqual(ambiguous, []);
    assert.deepEqual(unresolved, []);
  });

  it('empty pragmas list resolves to all-empty output', () => {
    const { resolved, ambiguous, unresolved } = resolvePragmasToDefinitions([], [{ filePath: 'a.mjs', symbolName: 'x', kind: 'function', startLine: 1, definitionId: 'd' }]);
    assert.deepEqual(resolved, []);
    assert.deepEqual(ambiguous, []);
    assert.deepEqual(unresolved, []);
  });
});

describe('findRepoPragmas — live smoke test', () => {
  it('finds this repo\'s own real @duplicate-justification pragmas', () => {
    const repoRoot = process.cwd();
    const pragmas = findRepoPragmas(repoRoot);
    // This repo has real pragmas authored by this exact plan (e.g.
    // scripts/lib/model-ab-decision.mjs:round4) — a live, non-synthetic
    // regression guard that the sweep actually finds real repo content.
    assert.ok(pragmas.length > 0, 'expected at least one real pragma in this repo');
    const round4 = pragmas.find((p) => p.pragmaFile.includes('model-ab-decision.mjs'));
    assert.ok(round4, 'expected the model-ab-decision.mjs round4 pragma to be found');
    assert.equal(round4.targetFile, 'scripts/lib/arm-eval/decision.mjs');
    assert.equal(round4.targetSymbol, 'round4');
  });

  it('skips placeholder/template targets (the [<>${}] guard)', () => {
    const repoRoot = process.cwd();
    const pragmas = findRepoPragmas(repoRoot);
    for (const p of pragmas) {
      assert.doesNotMatch(p.targetFile, /[<>${}]/);
    }
  });
});

describe('findRepoPragmas — untracked files + strict mode (round-2 M7 / H8)', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pragma-sweep-'));
    execSync('git init -q', { cwd: tmp });
    execSync('git config user.email test@test.com', { cwd: tmp });
    execSync('git config user.name test', { cwd: tmp });
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('finds a pragma in a genuinely UNTRACKED file (never git add-ed) — round-2 M7 regression guard', () => {
    fs.writeFileSync(
      path.join(tmp, 'untracked.mjs'),
      '// @duplicate-justification: target=a.mjs:foo reason=untracked test\nfunction foo() {}\n',
    );
    // Deliberately NOT `git add`-ed.
    const pragmas = findRepoPragmas(tmp);
    assert.equal(pragmas.length, 1);
    assert.equal(pragmas[0].pragmaFile, 'untracked.mjs');
  });

  it('still finds a pragma in a TRACKED (committed) file', () => {
    fs.writeFileSync(
      path.join(tmp, 'tracked.mjs'),
      '// @duplicate-justification: target=a.mjs:bar reason=tracked test\nfunction bar() {}\n',
    );
    execSync('git add tracked.mjs', { cwd: tmp });
    execSync('git commit -q -m init', { cwd: tmp });
    const pragmas = findRepoPragmas(tmp);
    assert.equal(pragmas.length, 1);
    assert.equal(pragmas[0].pragmaFile, 'tracked.mjs');
  });

  it('respects .gitignore for untracked files (does not sweep ignored content)', () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), '*.log\n');
    fs.writeFileSync(
      path.join(tmp, 'ignored.log'),
      '// @duplicate-justification: target=a.mjs:baz reason=should not be found\n',
    );
    const pragmas = findRepoPragmas(tmp);
    assert.equal(pragmas.length, 0);
  });

  it('default (non-strict) mode: a genuinely non-git directory degrades to []', () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
    try {
      const pragmas = findRepoPragmas(notARepo);
      assert.deepEqual(pragmas, []);
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('strict mode: a genuinely non-git directory THROWS instead of degrading to [] — round-2 H8 regression guard', () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
    try {
      assert.throws(() => findRepoPragmas(notARepo, { strict: true }), /PRAGMA_SWEEP_FAILED|findRepoPragmas failed/);
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('strict mode: a genuinely EMPTY (zero-match) git repo still returns [] — zero-match is not a failure', () => {
    const pragmas = findRepoPragmas(tmp, { strict: true });
    assert.deepEqual(pragmas, []);
  });
});
