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
