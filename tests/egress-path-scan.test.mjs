import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { findSensitivePathMentions } from '../scripts/lib/model-eval/egress-path-scan.mjs';

describe('findSensitivePathMentions', () => {
  test('does not flag ordinary English word/word prose that happens to start with a bare sensitive keyword (2026-07-12 dogfood false positive)', () => {
    // "token/size" tripped the tokens?(?:[/.]|$) keyword pattern purely
    // because English used "/" to mean "or", not a directory separator —
    // confirmed blocking a real blind-judge payload.
    assert.deepEqual(findSensitivePathMentions('a token/size cap... not enforced globally'), []);
    assert.deepEqual(findSensitivePathMentions('the password/credential flow needs work'), []);
  });

  test('does not flag unrelated word/word prose', () => {
    assert.deepEqual(findSensitivePathMentions('public/private visibility toggle'), []);
    assert.deepEqual(findSensitivePathMentions('blocking read/write in a loop'), []);
  });

  test('does not flag process.env / import.meta.env property access as a .env file mention (2026-07-12 candidate-sweep false positive — ~40% of a 331-candidate harvest)', () => {
    assert.deepEqual(findSensitivePathMentions('const key = process.env.GEMINI_API_KEY;'), []);
    assert.deepEqual(findSensitivePathMentions('return import.meta.env.VITE_API_URL;'), []);
    assert.deepEqual(findSensitivePathMentions('this.config.env.SOME_VALUE'), []);
  });

  test('still flags genuine sensitive file mentions', () => {
    assert.deepEqual(findSensitivePathMentions('the file .env has SECRET=abc123'), ['.env']);
    assert.deepEqual(findSensitivePathMentions('see .env.production for the real values'), ['.env.production']);
    assert.deepEqual(findSensitivePathMentions('leaked key at secrets/api-key.pem'), ['secrets/api-key.pem']);
    assert.deepEqual(findSensitivePathMentions('read the key from .ssh/id_rsa directly'), ['.ssh/id_rsa']);
    assert.deepEqual(findSensitivePathMentions('creds live under config/.aws/credentials'), ['config/.aws/credentials']);
  });

  test('non-string / empty input returns no matches', () => {
    assert.deepEqual(findSensitivePathMentions(''), []);
    assert.deepEqual(findSensitivePathMentions(null), []);
    assert.deepEqual(findSensitivePathMentions(undefined), []);
  });

  test('does not flag lockfile mentions — generatedNoise is a body-egress category, not a secret (2026-07-12 sweep: blocked every diff touching package-lock.json)', () => {
    assert.deepEqual(findSensitivePathMentions('updated a/package-lock.json and b/package-lock.json after the dep bump'), []);
    assert.deepEqual(findSensitivePathMentions('regenerated dist/bundle.min.js and dist/bundle.js.map'), []);
  });

  test('does not flag regex pattern source from the security tooling itself (2026-07-12 sweep: id_rsa/i, .env(\\..+)?$ self-trips)', () => {
    assert.deepEqual(findSensitivePathMentions('adds the pattern /(^|\\/)id_rsa.*$/i to the denylist'), []);
    assert.deepEqual(findSensitivePathMentions('the regex .env(\\..+)?$ matches dotenv variants'), []);
  });

  test('punctuation-wrapped prose mentions keep their HISTORICAL non-flagging behavior — a same-day strengthening attempt (trailing-punct strip) re-blocked valid corpus entries and was reverted', () => {
    assert.deepEqual(findSensitivePathMentions('(SUPABASE_AUDIT_URL + SUPABASE_AUDIT_ANON_KEY in .env)'), []);
    // Bare, unwrapped mentions still flag exactly as before:
    assert.deepEqual(findSensitivePathMentions('the file .env has the keys'), ['.env']);
  });

  test('does not flag design-token code modules; still flags credential-shaped token data files', () => {
    assert.deepEqual(findSensitivePathMentions("import { colors } from './lib/visual/tokens.mjs';"), []);
    assert.deepEqual(findSensitivePathMentions('theme styles live in styles/tokens.css today'), []);
    assert.deepEqual(findSensitivePathMentions('the service account reads auth/tokens.json on boot'), ['auth/tokens.json']);
  });
});
