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
  parseGitGrepPragmaRecord,
  splitGitGrepRecords,
  PRAGMA_RESOLUTION_MAX_GAP_LINES,
} from '../scripts/lib/duplicate-justification-pragma.mjs';
import { gitFixtureEnv } from './helpers/fixtures.mjs';

describe('parseGitGrepPragmaRecord — NUL-delimited git grep -z parsing (round-1 audit H2/H4, sast-sandbox-backlog-hardening.md item 6)', () => {
  // POSIX filenames may legally contain colons and non-ASCII characters.
  // This repo's own development platform (Windows/NTFS) rejects ':' in
  // filenames outright, so an end-to-end fixture file with a literal colon
  // in its name can't be constructed here — this is exactly why the parsing
  // grammar was factored into its own pure, git-free, filesystem-free
  // function operating on synthetic NUL-delimited records (see the module's
  // own doc comment on parseGitGrepPragmaRecord).
  const rec = (file, line, content) => `${file}\0${line}\0${content}`;

  it('a normal path parses correctly (regression guard)', () => {
    const pragma = parseGitGrepPragmaRecord(rec('src/foo.mjs', 12, '// @duplicate-justification: target=a.mjs:bar reason=x'));
    assert.equal(pragma.pragmaFile, 'src/foo.mjs');
    assert.equal(pragma.pragmaLine, 12);
    assert.equal(pragma.targetFile, 'a.mjs');
    assert.equal(pragma.targetSymbol, 'bar');
  });

  it('a filename containing a colon is parsed correctly — NUL-delimited, so the embedded colon is never ambiguous', () => {
    const pragma = parseGitGrepPragmaRecord(rec('notes:draft.mjs', 12, '// @duplicate-justification: target=a.mjs:bar reason=x'));
    assert.equal(pragma.pragmaFile, 'notes:draft.mjs', 'the embedded colon must stay part of the filename');
    assert.equal(pragma.pragmaLine, 12);
    assert.equal(pragma.targetFile, 'a.mjs');
    assert.equal(pragma.targetSymbol, 'bar');
  });

  it('a filename with MULTIPLE embedded colons still parses correctly', () => {
    const pragma = parseGitGrepPragmaRecord(rec('v2:report:legacy.mjs', 42, '// @duplicate-justification: target=a.mjs:bar reason=x'));
    assert.equal(pragma.pragmaFile, 'v2:report:legacy.mjs');
    assert.equal(pragma.pragmaLine, 42);
  });

  it('a REASON containing a colon-digit-colon pattern no longer corrupts the parse — the exact regression a text-only regex fix (H4) could not close', () => {
    // This is the case a purely greedy-backtracking colon regex gets wrong:
    // "reason=see line:99:for details" contains its OWN :digit: pattern,
    // which a text heuristic could mistake for the real filename/line
    // delimiter. NUL-delimiting makes this structurally impossible.
    const pragma = parseGitGrepPragmaRecord(rec('src/bar.mjs', 12, '// @duplicate-justification: target=foo.mjs:baz reason=see line:99:for details'));
    assert.equal(pragma.pragmaFile, 'src/bar.mjs');
    assert.equal(pragma.pragmaLine, 12);
    assert.equal(pragma.targetFile, 'foo.mjs');
    assert.equal(pragma.targetSymbol, 'baz');
    assert.equal(pragma.reason, 'see line:99:for details');
  });

  it('a non-ASCII filename (git core.quotePath territory) round-trips correctly as raw text', () => {
    const pragma = parseGitGrepPragmaRecord(rec('café.mjs', 3, '// @duplicate-justification: target=a.mjs:bar reason=unicode'));
    assert.equal(pragma.pragmaFile, 'café.mjs');
  });

  it('also parses the one-NUL fallback shape (filename NUL line COLON content) — round-2 audit H1/H2 raised this as a possible cross-version git behavior', () => {
    // filename\0line:content, instead of filename\0line\0content — the
    // parser must handle both without knowing in advance which git this
    // repo (or a consumer repo it syncs to) is running.
    const oneNulRecord = 'src/foo.mjs\x0012:// @duplicate-justification: target=a.mjs:bar reason=x';
    const pragma = parseGitGrepPragmaRecord(oneNulRecord);
    assert.equal(pragma.pragmaFile, 'src/foo.mjs');
    assert.equal(pragma.pragmaLine, 12);
    assert.equal(pragma.targetFile, 'a.mjs');
    assert.equal(pragma.targetSymbol, 'bar');
  });

  it('the one-NUL fallback shape also survives a reason containing a colon-digit-colon pattern', () => {
    const oneNulRecord = 'src/bar.mjs\x0012:// @duplicate-justification: target=foo.mjs:baz reason=see line:99:for details';
    const pragma = parseGitGrepPragmaRecord(oneNulRecord);
    assert.equal(pragma.pragmaFile, 'src/bar.mjs');
    assert.equal(pragma.pragmaLine, 12);
    assert.equal(pragma.reason, 'see line:99:for details');
  });

  it('an empty record returns null', () => {
    assert.equal(parseGitGrepPragmaRecord(''), null);
  });

  it('a record with no pragma content returns null', () => {
    assert.equal(parseGitGrepPragmaRecord(rec('src/foo.mjs', 12, 'just a normal comment')), null);
  });

  it('a record missing the NUL delimiters entirely returns null', () => {
    assert.equal(parseGitGrepPragmaRecord('not a git grep -z record at all'), null);
  });

  it('a record whose "line" field is not pure digits returns null (defensive)', () => {
    assert.equal(parseGitGrepPragmaRecord('src/foo.mjs\0notaline\0// @duplicate-justification: target=a.mjs:bar reason=x'), null);
  });
});

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

  it('matches an indented // comment pragma (leading whitespace, not column 0)', () => {
    const m = PRAGMA_RE.exec('    // @duplicate-justification: target=a/b.mjs:foo reason=nested declaration');
    assert.ok(m);
    assert.equal(m[1], 'a/b.mjs');
  });

  it('does NOT match pragma-shaped text embedded mid-line inside a string literal (67f8f414/fbd71c9a)', () => {
    // A code example or test fixture inside a JS string — the comment marker
    // is real text on the line, but not at line-start, so it must not be
    // treated as an active suppression.
    const line = 'const example = "// @duplicate-justification: target=a.mjs:foo reason=example in docs";';
    const m = PRAGMA_RE.exec(line);
    assert.equal(m, null);
  });

  it('does NOT match pragma-shaped prose describing the syntax (no comment marker anywhere at line-start)', () => {
    const line = 'See the @duplicate-justification: target=a.mjs:foo reason=... syntax above.';
    const m = PRAGMA_RE.exec(line);
    assert.equal(m, null);
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
    const env = gitFixtureEnv();
    execSync('git init -q', { cwd: tmp, env });
    execSync('git config user.email test@test.com', { cwd: tmp, env });
    execSync('git config user.name test', { cwd: tmp, env });
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
    const pragmas = findRepoPragmas(tmp, { env: gitFixtureEnv() });
    assert.equal(pragmas.length, 1);
    assert.equal(pragmas[0].pragmaFile, 'untracked.mjs');
  });

  it('still finds a pragma in a TRACKED (committed) file', () => {
    fs.writeFileSync(
      path.join(tmp, 'tracked.mjs'),
      '// @duplicate-justification: target=a.mjs:bar reason=tracked test\nfunction bar() {}\n',
    );
    execSync('git add tracked.mjs', { cwd: tmp, env: gitFixtureEnv() });
    execSync('git commit -q -m init', { cwd: tmp, env: gitFixtureEnv() });
    const pragmas = findRepoPragmas(tmp, { env: gitFixtureEnv() });
    assert.equal(pragmas.length, 1);
    assert.equal(pragmas[0].pragmaFile, 'tracked.mjs');
  });

  it('respects .gitignore for untracked files (does not sweep ignored content)', () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), '*.log\n');
    fs.writeFileSync(
      path.join(tmp, 'ignored.log'),
      '// @duplicate-justification: target=a.mjs:baz reason=should not be found\n',
    );
    const pragmas = findRepoPragmas(tmp, { env: gitFixtureEnv() });
    assert.equal(pragmas.length, 0);
  });

  // CRLF regression (field, 2026-07-20). A consumer repo without an
  // `eol=lf` .gitattributes checks files out CRLF, so every `git grep` line
  // ends with \r. JS `.` does NOT match \r, so `(.*)$` in the line-shape
  // regex could never reach the anchor and EVERY line was discarded — the
  // sweep returned [] and the whole @duplicate-justification feature was
  // silently inert, with no warning (an empty sweep is indistinguishable
  // from "this repo has no pragmas"). This repo pins eol=lf, which is
  // exactly why its own suite never caught it.
  it('parses CRLF git-grep output (consumer repos without eol=lf)', () => {
    fs.writeFileSync(
      path.join(tmp, 'crlf.mjs'),
      '// @duplicate-justification: target=a.mjs:foo reason=crlf test\r\nfunction foo() {}\r\n',
    );
    const pragmas = findRepoPragmas(tmp, { env: gitFixtureEnv() });
    assert.equal(pragmas.length, 1, 'a CRLF file must not silently yield zero pragmas');
    assert.equal(pragmas[0].pragmaFile, 'crlf.mjs');
    assert.equal(pragmas[0].pragmaLine, 1);
    assert.equal(pragmas[0].targetFile, 'a.mjs');
    assert.equal(pragmas[0].targetSymbol, 'foo');
    assert.equal(pragmas[0].reason, 'crlf test', 'the trailing \\r must not leak into the reason');
  });

  it('parses a mixed CRLF/LF repo — both line endings in one sweep', () => {
    fs.writeFileSync(path.join(tmp, 'a-crlf.mjs'),
      '// @duplicate-justification: target=x.mjs:one reason=r1\r\nfunction one() {}\r\n');
    fs.writeFileSync(path.join(tmp, 'b-lf.mjs'),
      '// @duplicate-justification: target=x.mjs:two reason=r2\nfunction two() {}\n');
    const pragmas = findRepoPragmas(tmp, { env: gitFixtureEnv() });
    assert.equal(pragmas.length, 2);
    assert.deepEqual(pragmas.map((p) => p.reason).sort(), ['r1', 'r2']);
  });

  it('default (non-strict) mode: a genuinely non-git directory degrades to []', () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
    try {
      const pragmas = findRepoPragmas(notARepo, { env: gitFixtureEnv() });
      assert.deepEqual(pragmas, []);
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('strict mode: a genuinely non-git directory THROWS instead of degrading to [] — round-2 H8 regression guard', () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
    try {
      assert.throws(() => findRepoPragmas(notARepo, { strict: true, env: gitFixtureEnv() }), /PRAGMA_SWEEP_FAILED|findRepoPragmas failed/);
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('strict mode: a genuinely EMPTY (zero-match) git repo still returns [] — zero-match is not a failure', () => {
    const pragmas = findRepoPragmas(tmp, { strict: true, env: gitFixtureEnv() });
    assert.deepEqual(pragmas, []);
  });
});

describe('splitGitGrepRecords — a filename containing a newline', () => {
  // Raised 4x and REOPENED 2x. Every earlier attempt hardened the per-record
  // parser (already NUL-correct) instead of the SPLIT, which is where the bug
  // was: splitting the whole output on newlines cuts INSIDE the raw filename
  // that `-z` deliberately does not escape.
  const NUL = String.fromCharCode(0);
  const P = '// @duplicate-justification: target=src/a.mjs:foo reason=intentional';
  const weird = 'src/nor\nmal.mjs';

  it('keeps the record whole and preserves the real path', () => {
    const out = weird + NUL + '12:' + P + '\n' + 'src/plain.mjs' + NUL + '7:' + P + '\n';
    const got = splitGitGrepRecords(out).map(parseGitGrepPragmaRecord).filter(Boolean);
    assert.equal(got.length, 2);
    assert.equal(got[0].pragmaFile, weird);
    assert.equal(got[0].pragmaLine, 12);
    assert.equal(got[1].pragmaFile, 'src/plain.mjs');
  });

  it('the OLD newline-split MISATTRIBUTED it — corruption, not loss', () => {
    // Worth pinning: the failure was never a dropped pragma (which would merely
    // under-suppress). The post-newline fragment BECAME the filename, so the
    // suppression was recorded against a path that does not exist while the
    // real file's duplicate stayed unsuppressed.
    const out = weird + NUL + '12:' + P + '\n';
    const old = out.split(/\r?\n/).map(parseGitGrepPragmaRecord).filter(Boolean);
    assert.equal(old.length, 1);
    assert.equal(old[0].pragmaFile, 'mal.mjs', 'old split invented a bogus path');
    const now = splitGitGrepRecords(out).map(parseGitGrepPragmaRecord).filter(Boolean);
    assert.equal(now[0].pragmaFile, weird);
  });

  it('still handles CRLF checkouts and both -z record shapes', () => {
    const crlf = 'a.mjs' + NUL + '3:' + P + '\r\n';
    assert.ok(parseGitGrepPragmaRecord(splitGitGrepRecords(crlf)[0]));
    const twoNul = 'b.mjs' + NUL + '4' + NUL + P + '\n';
    assert.ok(parseGitGrepPragmaRecord(splitGitGrepRecords(twoNul)[0]));
  });

  it('empty / NUL-less input yields no records rather than a fragment', () => {
    assert.deepEqual(splitGitGrepRecords(''), []);
    assert.deepEqual(splitGitGrepRecords('no nul here\n'), []);
  });
});
