/**
 * Tests for scripts/lib/quickfix-patterns.mjs
 * Plan ACs: AC14, AC15, AC16, AC54, AC56, AC63 (redact-then-truncate).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PATTERNS,
  SUPPRESS_BY_EXT,
  normalisePath,
  isSensitivePath,
  hasSuppression,
  matchPatterns,
} from '../scripts/lib/quickfix-patterns.mjs';

describe('PATTERNS schema', () => {
  it('AC14 — at least 10 entries; each has name/severity/regex/suggestion', () => {
    assert.ok(PATTERNS.length >= 10, `expected ≥10 patterns, got ${PATTERNS.length}`);
    for (const p of PATTERNS) {
      assert.ok(typeof p.name === 'string' && p.name.length > 0, 'name required');
      assert.ok(['low', 'medium', 'high'].includes(p.severity), `severity invalid: ${p.severity}`);
      assert.ok(p.regex instanceof RegExp, 'regex required');
      assert.ok(typeof p.suggestion === 'string' && p.suggestion.length > 0, 'suggestion required');
    }
  });

  it('names are unique', () => {
    const names = PATTERNS.map(p => p.name);
    assert.equal(new Set(names).size, names.length, `duplicate pattern name(s) in ${JSON.stringify(names)}`);
  });

  it('optional fields (multiline, langGuard, nearby) have valid shapes when present (code-audit R1 Sustainability finding)', () => {
    for (const p of PATTERNS) {
      if ('multiline' in p) {
        assert.equal(typeof p.multiline, 'boolean', `${p.name}: multiline must be boolean`);
      }
      if ('langGuard' in p) {
        assert.ok(p.langGuard instanceof RegExp, `${p.name}: langGuard must be a RegExp`);
      }
      if ('nearby' in p) {
        assert.ok(p.multiline === true, `${p.name}: nearby is only meaningful on a multiline pattern`);
        assert.ok(Array.isArray(p.nearby.tokens) && p.nearby.tokens.length > 0, `${p.name}: nearby.tokens must be a non-empty array`);
        for (const t of p.nearby.tokens) {
          assert.ok(t instanceof RegExp, `${p.name}: every nearby.tokens entry must be a RegExp`);
          assert.ok(!t.global && !t.sticky, `${p.name}: nearby.tokens entries must not carry the g or y flag (stateful .test() would leak lastIndex across candidate windows)`);
        }
        assert.ok(typeof p.nearby.windowChars === 'number' && p.nearby.windowChars > 0, `${p.name}: nearby.windowChars must be a positive number`);
      }
    }
  });
});

describe('normalisePath', () => {
  it('replaces backslashes with forward slashes', () => {
    assert.equal(normalisePath('a\\b\\c'), 'a/b/c');
  });

  it('strips drive letter', () => {
    assert.equal(normalisePath('C:/git/repo/.env'), 'git/repo/.env');
  });

  it('lowercases', () => {
    assert.equal(normalisePath('FOO/BAR.JS'), 'foo/bar.js');
  });

  it('strips leading ./', () => {
    assert.equal(normalisePath('./a/b'), 'a/b');
  });

  it('handles non-string input safely', () => {
    assert.equal(normalisePath(null), '');
    assert.equal(normalisePath(undefined), '');
  });
});

describe('isSensitivePath — AC54 + §13.A basename matching', () => {
  const sensitive = [
    '.env',
    '.env.local',
    '.env.production',
    'secrets.json',
    'secrets.yml',
    'credentials.json',
    'foo.pem',
    'foo.key',
    'foo.crt',
    'secrets/api-keys.json',
    '.aws/credentials',
    '.ssh/id_rsa',
    '/Users/foo/repo/.env',                 // absolute (Posix)
    'C:\\repo\\.env',                        // absolute (Windows)
    '/home/me/.aws/credentials',
    'SECRETS/keys.json',                    // case-insensitive
  ];
  for (const p of sensitive) {
    it(`true for ${p}`, () => assert.equal(isSensitivePath(p), true));
  }

  // Canonical superset (plan WS3) now also classifies `foo.env` as sensitive
  // — a hardening upgrade from the legacy "only dot-env" rule. Tests below
  // pin the broadened-but-correct behaviour.
  const sensitiveAfterMigration = ['myenv.env', 'production.env'];
  for (const p of sensitiveAfterMigration) {
    it(`true for ${p} (canonical superset)`, () => assert.equal(isSensitivePath(p), true));
  }

  const nonSensitive = [
    'src/auth.js',
    'README.md',
    'package.json',
    'src/keys/manager.js',                   // 'keys' isn't a sensitive dir
  ];
  for (const p of nonSensitive) {
    it(`false for ${p}`, () => assert.equal(isSensitivePath(p), false));
  }
});

describe('hasSuppression — language-aware (AC56)', () => {
  it('// in .js suppresses', () => {
    assert.equal(hasSuppression('catch {} // quickfix-hook:ignore', 'foo.js'), true);
  });

  it('# in .py suppresses', () => {
    assert.equal(hasSuppression('except: pass  # quickfix-hook:ignore', 'foo.py'), true);
  });

  it('// in .py does NOT suppress (wrong syntax for the language)', () => {
    assert.equal(hasSuppression('except: pass  // quickfix-hook:ignore', 'foo.py'), false);
  });

  it('# in .js does NOT suppress', () => {
    assert.equal(hasSuppression('catch {} # quickfix-hook:ignore', 'foo.js'), false);
  });

  it('default fallback accepts both forms for unknown extension', () => {
    assert.equal(hasSuppression('// quickfix-hook:ignore', 'foo.unknown'), true);
    assert.equal(hasSuppression('# quickfix-hook:ignore', 'foo.unknown'), true);
  });
});

describe('matchPatterns — pattern-by-pattern coverage', () => {
  it('empty-catch fires on `catch (e) {}`', () => {
    const m = matchPatterns('try { x } catch (e) {}', { filePath: 'a.js' });
    assert.ok(m.some(x => x.name === 'empty-catch'));
  });

  it('empty-catch fires on `catch {}`', () => {
    const m = matchPatterns('try { x } catch {}', { filePath: 'a.js' });
    assert.ok(m.some(x => x.name === 'empty-catch'));
  });

  it('TODO comment fires', () => {
    const m = matchPatterns('// TODO: figure this out', { filePath: 'a.js' });
    assert.ok(m.some(x => x.name === 'todo-fixme-hack'));
  });

  it('@ts-ignore without justification fires (in .ts)', () => {
    const m = matchPatterns('// @ts-ignore', { filePath: 'a.ts' });
    assert.ok(m.some(x => x.name === 'ts-ignore-no-justification'));
  });

  it('@ts-ignore WITH justification does NOT fire', () => {
    const m = matchPatterns('// @ts-ignore — third-party types broken', { filePath: 'a.ts' });
    assert.ok(!m.some(x => x.name === 'ts-ignore-no-justification'));
  });

  it('eslint-disable-next-line without rule fires', () => {
    const m = matchPatterns('// eslint-disable-next-line', { filePath: 'a.js' });
    assert.ok(m.some(x => x.name === 'eslint-disable-no-rule'));
  });

  it('# noqa without code (Python only) fires', () => {
    const m = matchPatterns('x = 1  # noqa', { filePath: 'a.py' });
    assert.ok(m.some(x => x.name === 'py-noqa-no-code'));
  });

  it('# noqa WITH code does NOT fire', () => {
    const m = matchPatterns('x = 1  # noqa: E501', { filePath: 'a.py' });
    assert.ok(!m.some(x => x.name === 'py-noqa-no-code'));
  });

  it('magic number in conditional fires', () => {
    const m = matchPatterns('if (count > 100) doThing()', { filePath: 'a.js' });
    assert.ok(m.some(x => x.name === 'magic-number-conditional'));
  });

  it('conditional with 0 / 1 / -1 does NOT fire', () => {
    const m1 = matchPatterns('if (x > 0) {}', { filePath: 'a.js' });
    assert.ok(!m1.some(x => x.name === 'magic-number-conditional'));
    const m2 = matchPatterns('if (x === 1) {}', { filePath: 'a.js' });
    assert.ok(!m2.some(x => x.name === 'magic-number-conditional'));
  });

  it('masked-error catch-and-return-null fires (HIGH)', () => {
    const m = matchPatterns('try { x } catch (e) { return null }', { filePath: 'a.js' });
    const hit = m.find(x => x.name === 'masked-error');
    assert.ok(hit);
    assert.equal(hit.severity, 'high');
  });

  it('disabled assertion fires', () => {
    const m1 = matchPatterns('xit("skipped test", () => {})', { filePath: 'a.test.js' });
    assert.ok(m1.some(x => x.name === 'disabled-assertion'));
    const m2 = matchPatterns('describe.skip("group", () => {})', { filePath: 'a.test.js' });
    assert.ok(m2.some(x => x.name === 'disabled-assertion'));
  });

  it('hardcoded localhost fallback fires', () => {
    const m = matchPatterns('const url = process.env.API || "localhost:3000"', { filePath: 'a.js' });
    assert.ok(m.some(x => x.name === 'hardcoded-localhost'));
  });

  it('hardcoded http URL fires', () => {
    const m = matchPatterns('const url = process.env.API || "http://example.com"', { filePath: 'a.js' });
    assert.ok(m.some(x => x.name === 'hardcoded-http-url'));
  });
});

describe('matchPatterns — opt-outs and bails', () => {
  it('AC15 — // quickfix-hook:ignore on the same line suppresses', () => {
    const m = matchPatterns('try { x } catch {} // quickfix-hook:ignore', { filePath: 'a.js' });
    assert.equal(m.length, 0);
  });

  it('AC16 — input >80,000 chars returns empty', () => {
    const huge = 'x'.repeat(80_001);
    const m = matchPatterns(huge, { filePath: 'a.js' });
    assert.equal(m.length, 0);
  });

  it('returns empty on non-string input', () => {
    assert.deepEqual(matchPatterns(null), []);
    assert.deepEqual(matchPatterns(undefined), []);
  });

  it('langGuard — ts-ignore pattern does NOT fire in .py file', () => {
    const m = matchPatterns('@ts-ignore', { filePath: 'a.py' });
    assert.ok(!m.some(x => x.name === 'ts-ignore-no-justification'));
  });
});

describe('Audit Gemini-G3-M1 — multiline patterns', () => {
  it('empty-catch fires on `catch (e) {\\n  \\n}` (formatted multi-line)', () => {
    const code = 'try {\n  doThing()\n} catch (e) {\n  \n}\n';
    const m = matchPatterns(code, { filePath: 'a.js' });
    assert.ok(m.some(x => x.name === 'empty-catch'), `expected empty-catch in ${JSON.stringify(m)}`);
  });

  it('masked-error fires on `catch (e) {\\n  return null\\n}` (formatted multi-line)', () => {
    const code = 'try {\n  doThing()\n} catch (e) {\n  return null\n}\n';
    const m = matchPatterns(code, { filePath: 'a.js' });
    assert.ok(m.some(x => x.name === 'masked-error'), `expected masked-error in ${JSON.stringify(m)}`);
  });

  it('Audit Gemini-G4-L1 — // quickfix-hook:ignore on preceding line suppresses multi-line empty-catch', () => {
    const code = 'try {\n  doThing()\n} // quickfix-hook:ignore\ncatch (e) {\n}\n';
    const m = matchPatterns(code, { filePath: 'a.js' });
    assert.equal(m.length, 0, 'preceding-line suppression should silence the multi-line match');
  });

  it('code-audit Gemini gate G1 — a suppressed match does not shadow a later unsuppressed one of the same pattern (and the false-positive-prone naive fix — the prior statement\'s own trailing ignore-comment leaking onto the next via the preceding-line rule — is guarded: exactly one hit, not zero or two)', () => {
    const code = 'try { a() } catch (e) {} // quickfix-hook:ignore\ntry { b() } catch (e) {}';
    const m = matchPatterns(code, { filePath: 'a.js' });
    assert.equal(m.filter(x => x.name === 'empty-catch').length, 1, 'expected exactly the second, unsuppressed catch to fire');
  });
});

describe('nearby extension-point robustness — exercised via the public matchPatterns() API (round-3 audit L1; code-audit R1 Structure finding — the internal toGlobalRegex/iterateRegexMatches helpers stay unexported, per the plan)', () => {
  it('preserves case-insensitivity through the global-regex iteration (flag preservation)', () => {
    // transaction-empty-catch's regex carries the `i` flag; a lowercase
    // SQL keyword must still satisfy `nearby` after the internal g-flag clone.
    const code = 'begin(() => {\n  try { a() } catch (e) {}\n});';
    const m = matchPatterns(code, { filePath: 'a.js' });
    assert.ok(m.some(x => x.name === 'transaction-empty-catch'));
  });

  it('does not corrupt pattern state across repeated matchPatterns() calls (no lastIndex leakage)', () => {
    const code = 'db.transaction(() => {\n  try { a() } catch (e) {}\n});';
    const first = matchPatterns(code, { filePath: 'a.js' });
    const second = matchPatterns(code, { filePath: 'a.js' });
    assert.ok(first.some(x => x.name === 'transaction-empty-catch'));
    assert.ok(second.some(x => x.name === 'transaction-empty-catch'), 'second call regressed — source regex was likely mutated by the first');
  });

  it('iterates past a non-qualifying candidate to find a later qualifying one (see also the transaction-empty-catch suite below)', () => {
    const code = 'try { a() } catch (e) {}\n' + 'x'.repeat(250) +
      '\ndb.transaction(() => {\n  try { b() } catch (e) {}\n});';
    const m = matchPatterns(code, { filePath: 'a.js' });
    assert.ok(m.some(x => x.name === 'transaction-empty-catch'));
  });

  it('consults fullFileText for the nearby window when the isolated diffText lacks context (code-audit Gemini gate G1, round 2)', () => {
    const diffText = 'try { a() } catch (e) {}';
    const fullFileText = `function doWork() {\n  db.transaction(() => {\n    ${diffText}\n  });\n}`;
    const withoutContext = matchPatterns(diffText, { filePath: 'a.js' });
    assert.ok(!withoutContext.some(x => x.name === 'transaction-empty-catch'), 'isolated snippet alone should not see the transaction wrapper');
    const withContext = matchPatterns(diffText, { filePath: 'a.js', fullFileText });
    assert.ok(withContext.some(x => x.name === 'transaction-empty-catch'), 'fullFileText should let nearby see the transaction wrapper outside the edited snippet');
  });

  it('falls back to the diffText-only window when the match text is not found in fullFileText', () => {
    const diffText = 'try { a() } catch (e) {}';
    const m = matchPatterns(diffText, { filePath: 'a.js', fullFileText: 'this file does not contain the catch block at all' });
    assert.ok(!m.some(x => x.name === 'transaction-empty-catch'));
  });
});

describe('matchPatterns — transaction-empty-catch (Pattern Contract)', () => {
  it('fires on an empty catch near a .transaction( call', () => {
    const code = 'db.transaction(async () => {\n  try { x() } catch (e) {}\n})';
    const m = matchPatterns(code, { filePath: 'a.js' });
    assert.ok(m.some(x => x.name === 'transaction-empty-catch'));
  });

  it('does NOT fire when the transaction keyword is outside the 200-char window', () => {
    const filler = 'x'.repeat(250);
    const code = `db.transaction(() => { ${filler} });\ntry { y() } catch (e) {}`;
    const m = matchPatterns(code, { filePath: 'a.js' });
    assert.ok(!m.some(x => x.name === 'transaction-empty-catch'));
  });

  it('a non-qualifying catch before a qualifying one does not shadow it (round-2 M1)', () => {
    const code = 'try { a() } catch (e) { logger.error(e); }\n' +
      'x'.repeat(250) +
      '\ndb.transaction(() => {\n  try { b() } catch (e) {}\n});';
    const m = matchPatterns(code, { filePath: 'a.js' });
    assert.ok(m.some(x => x.name === 'transaction-empty-catch'));
  });

  it('a transaction keyword inside a comment near an unrelated catch is a KNOWN accepted false positive', () => {
    const code = '// BEGIN transaction here\ntry { a() } catch (e) {}';
    const m = matchPatterns(code, { filePath: 'a.js' });
    assert.ok(m.some(x => x.name === 'transaction-empty-catch'), 'documented false positive — no comment/string awareness');
  });

  it('lowercase begin/commit/rollback fire; BEGINNER does not', () => {
    const beginner = 'BEGINNER_MODE(() => {\n  try { a() } catch (e) {}\n});';
    assert.ok(!matchPatterns(beginner, { filePath: 'a.js' }).some(x => x.name === 'transaction-empty-catch'));
    const lowercase = 'begin(() => {\n  try { a() } catch (e) {}\n});';
    assert.ok(matchPatterns(lowercase, { filePath: 'a.js' }).some(x => x.name === 'transaction-empty-catch'));
  });

  it('does NOT fire on a rollback or a rethrow (Gemini gate G2 round 3)', () => {
    const rollback = 'db.transaction(() => {\n  try { a() } catch (e) { db.rollback(); }\n});';
    assert.ok(!matchPatterns(rollback, { filePath: 'a.js' }).some(x => x.name === 'transaction-empty-catch'));
    const rethrow = 'db.transaction(() => {\n  try { a() } catch (e) { throw e; }\n});';
    assert.ok(!matchPatterns(rethrow, { filePath: 'a.js' }).some(x => x.name === 'transaction-empty-catch'));
  });

  it('DOES fire on a logged-but-not-released catch (Gemini gate G2 round 3)', () => {
    const logged = 'db.transaction(() => {\n  try { a() } catch (e) { logger.error(e); }\n});';
    assert.ok(matchPatterns(logged, { filePath: 'a.js' }).some(x => x.name === 'transaction-empty-catch'));
  });

  it('rejects .md paths (langGuard)', () => {
    const code = 'db.transaction(() => {\n  try { a() } catch (e) {}\n});';
    assert.ok(!matchPatterns(code, { filePath: 'a.md' }).some(x => x.name === 'transaction-empty-catch'));
  });
});

describe('matchPatterns — valid-zero-coercion (Pattern Contract)', () => {
  it('does NOT fire on a non-numeric-suggestive identifier', () => {
    const m = matchPatterns('const x = enabled || false;', { filePath: 'a.js' });
    assert.ok(!m.some(x => x.name === 'valid-zero-coercion'));
  });

  it('does NOT fire on `qty || 0` (Gemini gate G1 round 1 — the safe case)', () => {
    const m = matchPatterns('const x = qty || 0;', { filePath: 'a.js' });
    assert.ok(!m.some(x => x.name === 'valid-zero-coercion'));
  });

  it('fires on a non-zero literal or null fallback', () => {
    assert.ok(matchPatterns('const x = qty || 10;', { filePath: 'a.js' }).some(x => x.name === 'valid-zero-coercion'));
    assert.ok(matchPatterns('const x = qty || null;', { filePath: 'a.js' }).some(x => x.name === 'valid-zero-coercion'));
  });

  it('fires on a negative-number or string-literal fallback (Gemini gate G2 round 2)', () => {
    assert.ok(matchPatterns('const x = index || -1;', { filePath: 'a.js' }).some(x => x.name === 'valid-zero-coercion'));
    assert.ok(matchPatterns("const x = amount || '0';", { filePath: 'a.js' }).some(x => x.name === 'valid-zero-coercion'));
  });

  it('fires on a template-literal string fallback (Gemini gate G3 round 3)', () => {
    const m = matchPatterns('const x = amount || `0`;', { filePath: 'a.js' });
    assert.ok(m.some(x => x.name === 'valid-zero-coercion'));
  });

  it('does NOT fire on ordinary English words containing the substring (Gemini gate G3 round 2)', () => {
    assert.ok(!matchPatterns("const x = country || 'US';", { filePath: 'a.js' }).some(x => x.name === 'valid-zero-coercion'));
    assert.ok(!matchPatterns("const x = summary || 'none';", { filePath: 'a.js' }).some(x => x.name === 'valid-zero-coercion'));
    assert.ok(!matchPatterns('const x = account || null;', { filePath: 'a.js' }).some(x => x.name === 'valid-zero-coercion'));
  });

  it('fires on camelCase-suffix, snake_case-prefix, and snake_case-suffix identifiers', () => {
    assert.ok(matchPatterns('const x = itemCount || 10;', { filePath: 'a.js' }).some(x => x.name === 'valid-zero-coercion'));
    assert.ok(matchPatterns('const x = total_price || 0.5;', { filePath: 'a.js' }).some(x => x.name === 'valid-zero-coercion'));
    assert.ok(matchPatterns('const x = item_count || -1;', { filePath: 'a.js' }).some(x => x.name === 'valid-zero-coercion'));
  });

  it('fires on a member-expression identifier (code-audit R1 — `row.count`, `stats.totalCount`, `item.price`)', () => {
    assert.ok(matchPatterns('return row.count || 10;', { filePath: 'a.js' }).some(x => x.name === 'valid-zero-coercion'));
    assert.ok(matchPatterns('const n = stats.totalCount || fallback;', { filePath: 'a.js' }).some(x => x.name === 'valid-zero-coercion'));
    assert.ok(matchPatterns('price: item.price || defaultPrice,', { filePath: 'a.js' }).some(x => x.name === 'valid-zero-coercion'));
  });

  it('fires on decimal fallbacks starting with 0 (Gemini gate G1 round 4)', () => {
    assert.ok(matchPatterns('const x = total_price || 0.5;', { filePath: 'a.js' }).some(x => x.name === 'valid-zero-coercion'));
    assert.ok(matchPatterns('const x = qty || 0.1;', { filePath: 'a.js' }).some(x => x.name === 'valid-zero-coercion'));
  });

  it('the reported decimal snippet is NOT truncated to the leading 0, and a negative decimal fires too (code-audit Gemini gate G2 — verified false positive; the `-?` optional-sign group is present, pinned here as a regression guard)', () => {
    const hit = matchPatterns('const x = total_price || 0.5;', { filePath: 'a.js' }).find(x => x.name === 'valid-zero-coercion');
    assert.ok(hit.snippet.includes('0.5'), `snippet should include the full "0.5", got: ${hit.snippet}`);
    assert.ok(matchPatterns('const x = qty || -0.5;', { filePath: 'a.js' }).some(x => x.name === 'valid-zero-coercion'));
  });

  it('does NOT fire inside a bare boolean conditional (Gemini gate G3 round 4 — harmful-suggestion guard)', () => {
    const m = matchPatterns('if (itemCount || totalItems) { doSomething(); }', { filePath: 'a.js' });
    assert.ok(!m.some(x => x.name === 'valid-zero-coercion'));
  });

  it('DOES fire on a returned value-coercion (return is a valid anchor)', () => {
    const m = matchPatterns('return itemCount || totalItems;', { filePath: 'a.js' });
    assert.ok(m.some(x => x.name === 'valid-zero-coercion'));
  });

  it('does NOT fire on a comparison operator\'s trailing = (code-audit Gemini gate G2, round 2)', () => {
    assert.ok(!matchPatterns('if (itemCount === qty || totalItems) { x(); }', { filePath: 'a.js' }).some(x => x.name === 'valid-zero-coercion'));
    assert.ok(!matchPatterns('if (itemCount !== qty || totalItems) { x(); }', { filePath: 'a.js' }).some(x => x.name === 'valid-zero-coercion'));
    assert.ok(!matchPatterns('if (itemCount == qty || totalItems) { x(); }', { filePath: 'a.js' }).some(x => x.name === 'valid-zero-coercion'));
    assert.ok(!matchPatterns('if (itemCount <= qty || totalItems) { x(); }', { filePath: 'a.js' }).some(x => x.name === 'valid-zero-coercion'));
    assert.ok(!matchPatterns('if (itemCount >= qty || totalItems) { x(); }', { filePath: 'a.js' }).some(x => x.name === 'valid-zero-coercion'));
  });

  it('rejects .py paths (langGuard)', () => {
    const m = matchPatterns('const x = qty || 10;', { filePath: 'a.py' });
    assert.ok(!m.some(x => x.name === 'valid-zero-coercion'));
  });

  it('suggestion matches the Pattern Contract exactly', () => {
    const m = matchPatterns('const x = qty || 10;', { filePath: 'a.js' });
    const hit = m.find(x => x.name === 'valid-zero-coercion');
    assert.equal(hit.suggestion, 'Coercing a falsy value here silently overwrites a valid 0 with a different default. Use `??` (nullish coalescing) so 0 survives and only null/undefined are replaced.');
  });
});

describe('matchPatterns — fail-open-auth-return-true / fail-open-auth-assignment (Pattern Contract)', () => {
  it('fail-open-auth-return-true fires with an auth-context token within the window', () => {
    const code = 'function check() {\n  try { isAuthorized(); } catch (e) { return true; }\n}';
    const m = matchPatterns(code, { filePath: 'a.js' });
    assert.ok(m.some(x => x.name === 'fail-open-auth-return-true'));
  });

  it('fail-open-auth-return-true does NOT fire with no auth context nearby', () => {
    const code = 'function parse() {\n  try { JSON.parse(x); } catch (e) { return true; }\n}';
    const m = matchPatterns(code, { filePath: 'a.js' });
    assert.ok(!m.some(x => x.name === 'fail-open-auth-return-true'));
  });

  it('fail-open-auth-return-true fires on the optional-catch-binding form (round-3 M1)', () => {
    const code = 'function check() {\n  try { isAuthorized(); } catch { return true; }\n}';
    const m = matchPatterns(code, { filePath: 'a.js' });
    assert.ok(m.some(x => x.name === 'fail-open-auth-return-true'));
  });

  it('fail-open-auth-assignment fires on a bare auth-named assignment', () => {
    const m = matchPatterns('try { x() } catch (e) { authorized = true; }', { filePath: 'a.js' });
    assert.ok(m.some(x => x.name === 'fail-open-auth-assignment'));
  });

  it('fail-open-auth-assignment fires on the optional-catch-binding form and member-assignment forms (round-3 M1/M2)', () => {
    assert.ok(matchPatterns('try { x() } catch { authorized = true; }', { filePath: 'a.js' }).some(x => x.name === 'fail-open-auth-assignment'));
    assert.ok(matchPatterns('try { x() } catch (e) { ctx.authorized = true; }', { filePath: 'a.js' }).some(x => x.name === 'fail-open-auth-assignment'));
    assert.ok(matchPatterns('try { x() } catch (e) { session.accessGranted = true; }', { filePath: 'a.js' }).some(x => x.name === 'fail-open-auth-assignment'));
  });

  it('fail-open-auth-assignment does NOT fire on a non-auth-sounding final property (round-3 M2 precision guard)', () => {
    const m = matchPatterns('try { x() } catch (e) { ctx.ready = true; }', { filePath: 'a.js' });
    assert.ok(!m.some(x => x.name === 'fail-open-auth-assignment'));
  });

  it('does NOT fire on explicitly SECURE fail-closed assignments (Gemini gate G1 round 2)', () => {
    assert.ok(!matchPatterns('try { x() } catch (e) { unauthorized = true; }', { filePath: 'a.js' }).some(x => x.name === 'fail-open-auth-assignment'));
    assert.ok(!matchPatterns('try { x() } catch (e) { disallowed = true; }', { filePath: 'a.js' }).some(x => x.name === 'fail-open-auth-assignment'));
  });

  it('does NOT count an unauthorized-named nearby variable as auth context for fail-open-auth-return-true', () => {
    const code = 'function check() {\n  const unauthorized = getFlag();\n  try { x(); } catch (e) { return true; }\n}';
    const m = matchPatterns(code, { filePath: 'a.js' });
    assert.ok(!m.some(x => x.name === 'fail-open-auth-return-true'));
  });

  it('DOES fire on compound camelCase/snake_case auth identifiers (Gemini gate G1 round 3)', () => {
    assert.ok(matchPatterns('try { x() } catch (e) { accessGranted = true; }', { filePath: 'a.js' }).some(x => x.name === 'fail-open-auth-assignment'));
    assert.ok(matchPatterns('try { x() } catch (e) { user_authorized = true; }', { filePath: 'a.js' }).some(x => x.name === 'fail-open-auth-assignment'));
  });

  it('DOES count a compound auth token (hasPermission) as nearby context for fail-open-auth-return-true', () => {
    const code = 'function check() {\n  try { hasPermission(); } catch (e) { return true; }\n}';
    const m = matchPatterns(code, { filePath: 'a.js' });
    assert.ok(m.some(x => x.name === 'fail-open-auth-return-true'));
  });

  it('both fail-open-auth-* patterns fire when the dangerous statement is not the sole content of the catch block (Gemini gate G2 round 1)', () => {
    const returnTrue = 'function check() {\n  try { isAuthorized(); } catch (e) { log(e); return true; }\n}';
    assert.ok(matchPatterns(returnTrue, { filePath: 'a.js' }).some(x => x.name === 'fail-open-auth-return-true'));
    const assignment = 'try { x() } catch (e) { console.error(e); authorized = true; }';
    assert.ok(matchPatterns(assignment, { filePath: 'a.js' }).some(x => x.name === 'fail-open-auth-assignment'));
  });

  it('rejects .md paths (langGuard)', () => {
    const code = 'try { x() } catch (e) { authorized = true; }';
    assert.ok(!matchPatterns(code, { filePath: 'a.md' }).some(x => x.name === 'fail-open-auth-assignment'));
  });

  it('suggestions match the Pattern Contract exactly', () => {
    const returnTrue = matchPatterns('function check() {\n  try { isAuthorized(); } catch (e) { return true; }\n}', { filePath: 'a.js' })
      .find(x => x.name === 'fail-open-auth-return-true');
    assert.equal(returnTrue.suggestion, 'Catch-and-return-true near an authorization check fails OPEN — an error becomes "access granted." Fail closed: return/throw the real error, or return false.');
    const assignment = matchPatterns('try { x() } catch (e) { authorized = true; }', { filePath: 'a.js' })
      .find(x => x.name === 'fail-open-auth-assignment');
    assert.equal(assignment.suggestion, 'Catch block sets an auth-sounding flag to true — fails OPEN on error. Fail closed: set it false (or leave unset) and surface/log the real failure.');
  });
});

describe('matchPatterns — accepted overlap between new and existing patterns (round-1 audit M5)', () => {
  it('a canonical masked catch inside a transaction window fires BOTH masked-error and transaction-empty-catch', () => {
    const code = 'db.transaction(() => {\n  try { a() } catch (e) { return null; }\n});';
    const m = matchPatterns(code, { filePath: 'a.js' });
    assert.ok(m.some(x => x.name === 'masked-error'));
    assert.ok(m.some(x => x.name === 'transaction-empty-catch'));
  });
});

describe('AC63 §15.A — redact BEFORE truncate', () => {
  it('long secret-shaped string in matched line is redacted, not partially truncated', () => {
    // Construct a line that triggers todo-fixme + contains a long fake key
    // The key shape should be caught by the redactor; if redact happens AFTER
    // truncation, the slice could leave half the key visible.
    const line = '// TODO: fix this, sk-' + 'A'.repeat(60) + '_long_secret_token_value_here';
    const m = matchPatterns(line, { filePath: 'a.js' });
    const todo = m.find(x => x.name === 'todo-fixme-hack');
    assert.ok(todo, 'todo pattern should fire');
    // The snippet must NOT contain the unredacted secret prefix `sk-AAAA...`
    // (redactor replaces it with [REDACTED:...] markers per secret-patterns.mjs)
    assert.ok(!todo.snippet.includes('sk-AAAAAAAAAAAAAAAAAA'), `snippet leaked secret: ${todo.snippet}`);
  });
});
