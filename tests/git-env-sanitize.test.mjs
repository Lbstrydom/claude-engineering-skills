/**
 * @fileoverview Coverage for scripts/lib/git-env-sanitize.mjs — the
 * hook->sandbox boundary fix for the 2026-07-23 GIT_DIR leak incident (six
 * live HEAD corruptions in one session; see scripts/prepush-check.mjs and
 * tests/git-env-fixture-isolation.test.mjs for the full story).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { getGitLocalEnvVarNames, sanitizeGitEnv, GIT_LOCAL_ENV_VARS } from '../scripts/lib/git-env-sanitize.mjs';

describe('getGitLocalEnvVarNames', () => {
  it('is a superset of the live git rev-parse --local-env-vars result (union with the static baseline)', () => {
    const dynamic = execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
    const names = getGitLocalEnvVarNames(process.cwd());
    for (const v of dynamic) assert.ok(names.includes(v), `expected ${v} (from live git) in the result`);
  });

  it('is a superset of the static GIT_LOCAL_ENV_VARS baseline — the union never drops a known var', () => {
    const names = getGitLocalEnvVarNames(process.cwd());
    for (const v of GIT_LOCAL_ENV_VARS) assert.ok(names.includes(v), `expected baseline var ${v} in the result`);
  });

  it('THE REAL DRIFT GUARD: the static GIT_LOCAL_ENV_VARS baseline ALONE is a superset of live git output (round-2 audit M6 fix)', () => {
    // The two tests above assert against getGitLocalEnvVarNames()'s UNION
    // output, which trivially contains both of its own inputs by
    // construction — they can never fail regardless of whether the static
    // baseline has genuinely fallen behind git. This is the test that
    // actually catches drift: it checks the baseline ARRAY DIRECTLY,
    // bypassing the union entirely. This matters because the round-3
    // fail-open fix falls back to JUST this baseline when dynamic discovery
    // fails — a baseline that's silently fallen behind would only surface
    // there, which the tautological tests above could never detect.
    const dynamic = execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
    const missing = dynamic.filter((v) => !GIT_LOCAL_ENV_VARS.includes(v));
    assert.deepEqual(missing, [], `GIT_LOCAL_ENV_VARS has fallen behind this git version — add: ${missing.join(', ')}`);
  });

  it('includes the two vars that actually caused the live incident', () => {
    const names = getGitLocalEnvVarNames(process.cwd());
    assert.ok(names.includes('GIT_DIR'));
    assert.ok(names.includes('GIT_WORK_TREE'));
  });

  it('falls back to the static baseline (never []) when git discovery fails — the round-3 audit fix', () => {
    const names = getGitLocalEnvVarNames('C:\\this\\path\\does\\not\\exist\\at\\all');
    assert.deepEqual(new Set(names), new Set(GIT_LOCAL_ENV_VARS));
    assert.ok(names.length > 0, 'a discovery failure must never silently strip nothing');
  });

  it('never throws — a git failure degrades to the baseline, not a crash', () => {
    assert.doesNotThrow(() => getGitLocalEnvVarNames('C:\\this\\path\\does\\not\\exist\\at\\all'));
  });
});

describe('sanitizeGitEnv', () => {
  it('strips GIT_DIR/GIT_WORK_TREE from a base env that carries them', () => {
    const poisoned = { ...process.env, GIT_DIR: 'C:/somewhere/.git', GIT_WORK_TREE: 'C:/somewhere', SAFE_VAR: 'keep-me' };
    const clean = sanitizeGitEnv(process.cwd(), poisoned);
    assert.equal(clean.GIT_DIR, undefined);
    assert.equal(clean.GIT_WORK_TREE, undefined);
    assert.equal(clean.SAFE_VAR, 'keep-me', 'only git-local vars are stripped, nothing else');
  });

  it('deletes keys rather than setting them to undefined (property absence, not an undefined value)', () => {
    const poisoned = { ...process.env, GIT_DIR: 'C:/somewhere/.git' };
    const clean = sanitizeGitEnv(process.cwd(), poisoned);
    assert.equal('GIT_DIR' in clean, false);
  });

  it('does not mutate the caller-supplied base env', () => {
    const poisoned = { GIT_DIR: 'C:/somewhere/.git' };
    sanitizeGitEnv(process.cwd(), poisoned);
    assert.equal(poisoned.GIT_DIR, 'C:/somewhere/.git', 'input object must be left untouched');
  });

  it('defaults to process.env when no base is supplied', () => {
    const clean = sanitizeGitEnv(process.cwd());
    assert.equal('GIT_DIR' in clean, false);
  });
});
