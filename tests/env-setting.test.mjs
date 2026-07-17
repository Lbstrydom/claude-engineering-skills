/**
 * @fileoverview Cluster B / Phase 3 — the pure `.env` writer. A secret-bearing
 * file (plan §8 R4): unrelated lines and secret values must survive byte-for-byte,
 * line endings preserved, no reformat unless asked.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyEnvSetting, resolveEnvValue } from '../scripts/lib/env-setting.mjs';

describe('applyEnvSetting — insert / replace / remove', () => {
  test('insert appends key (+ optional comment) preserving prior lines', () => {
    const { text, changed } = applyEnvSetting('A=1\n', 'K', 'v', { comment: '# c' });
    assert.equal(changed, true);
    assert.match(text, /^A=1$/m);
    assert.match(text, /^# c$/m);
    assert.match(text, /^K=v$/m);
    assert.ok(text.endsWith('\n'));
  });

  test('replace updates in place, exactly once, leaving neighbours intact', () => {
    const { text } = applyEnvSetting('A=1\nK=old\nB=2\n', 'K', 'new');
    assert.equal(text.match(/^K=/gm).length, 1);
    assert.match(text, /^K=new$/m);
    assert.match(text, /^A=1$/m);
    assert.match(text, /^B=2$/m);
  });

  test('remove (value=null) drops the key and its managed comment', () => {
    const start = applyEnvSetting('A=1\n', 'K', 'v', { comment: '# managed' }).text;
    const { text, changed } = applyEnvSetting(start, 'K', null, { comment: '# managed' });
    assert.equal(changed, true);
    assert.doesNotMatch(text, /^K=/m);
    assert.doesNotMatch(text, /# managed/);
    assert.match(text, /^A=1$/m);
  });

  test('remove of an absent key is a genuine no-op (input returned verbatim)', () => {
    const { text, changed } = applyEnvSetting('A=1\n', 'K', null);
    assert.equal(changed, false);
    assert.equal(text, 'A=1\n');
  });
});

describe('applyEnvSetting — R4 safety invariants', () => {
  test('a secret value on an unrelated line is preserved byte-for-byte', () => {
    const secret = 'AZURE_OPENAI_API_KEY=7buo4CrRj5dpiT2fi737Tngg0OYfJ2Mhk';
    const { text } = applyEnvSetting(`${secret}\n`, 'AZURE_OPENAI_EMBED_DEPLOYMENT', 'text-embedding-3-large');
    assert.ok(text.includes(secret), 'the untouched secret line must survive verbatim');
  });

  test('does NOT collapse blank runs by default (no reformat)', () => {
    const { text } = applyEnvSetting('A=1\n\n\n\nB=2\n', 'K', 'v');
    assert.match(text, /A=1\n\n\n\nB=2/, 'the user\'s blank run stays untouched');
  });

  test('collapses blank runs only when reformat:true (legacy applyProviderSetting output)', () => {
    const { text } = applyEnvSetting('A=1\n\n\n\nB=2\n', 'K', 'v', { reformat: true });
    assert.doesNotMatch(text, /\n\n\n/);
  });

  test('CRLF files keep CRLF endings (no wholesale LF rewrite of a Windows .env)', () => {
    const { text } = applyEnvSetting('A=1\r\nB=2\r\n', 'K', 'v');
    assert.match(text, /A=1\r\n/);
    assert.match(text, /K=v\r\n?$/);
    assert.doesNotMatch(text, /[^\r]\n/, 'no bare LF should appear in a CRLF file');
  });

  test('absent file (empty text) creates the key', () => {
    const { text, changed } = applyEnvSetting('', 'K', 'v');
    assert.equal(changed, true);
    assert.equal(text, 'K=v\n');
  });

  test('terminal blank lines are NOT stripped in default mode (audit L1/M1)', () => {
    const { text } = applyEnvSetting('A=1\nK=old\n\n\n', 'K', 'new');
    assert.ok(text.endsWith('\n\n\n'), 'the user\'s terminal blank lines survive');
  });

  test('duplicate key: edits the LAST (dotenv-effective) assignment + drops earlier dupes (audit H3)', () => {
    const { text } = applyEnvSetting('K=first\nB=2\nK=second\n', 'K', 'new');
    assert.equal(text.match(/^K=/gm).length, 1, 'earlier duplicate removed');
    assert.match(text, /^K=new$/m);
    assert.match(text, /^B=2$/m);
  });
});

describe('resolveEnvValue — observable value, not unrecoverable origin (H6/H10)', () => {
  const KEY = '__ENV_SETTING_TEST_KEY__';

  test('reads the value from the provided file text (not ambient dotenv)', () => {
    const r = resolveEnvValue(KEY, { envFileText: `${KEY}=from-file\nOTHER=x\n` });
    assert.equal(r.fileValue, 'from-file');
  });

  test('reports null fileValue when the key is absent from the file', () => {
    assert.equal(resolveEnvValue(KEY, { envFileText: 'OTHER=x\n' }).fileValue, null);
  });

  test('surfaces the live process.env value so the caller can detect shadowing', () => {
    const saved = process.env[KEY];
    process.env[KEY] = 'from-shell';
    try {
      const r = resolveEnvValue(KEY, { envFileText: `${KEY}=from-file\n` });
      assert.equal(r.liveValue, 'from-shell');
      assert.equal(r.fileValue, 'from-file');
      assert.notEqual(r.liveValue, r.fileValue, 'the caller warns on this difference');
    } finally {
      if (saved === undefined) delete process.env[KEY]; else process.env[KEY] = saved;
    }
  });
});
