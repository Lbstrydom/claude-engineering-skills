/**
 * @fileoverview `doctor.mjs`'s `--only`/`--bundle-sha` flag parsing (round-3
 * audit M15): a present-but-no-value flag used to collapse into the same
 * `null` as an absent flag (the exact class round-1 audit H10 already fixed
 * for `--consumer-root` in context.mjs — this pair had not been carried over
 * to doctor.mjs's own local `flagValue` helper).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { onlyFlagValue, bundleShaFlagValue } from '../scripts/doctor.mjs';

const DOCTOR_MJS = path.resolve(import.meta.dirname, '..', 'scripts', 'doctor.mjs');

/**
 * Round-5 audit M19: these subprocess tests only exercise ARGV VALIDATION
 * (--only/--bundle-sha parsing), which does not depend on cwd or ambient
 * env — but running them from whatever the test runner's own cwd/env
 * happens to be is still a latent hazard (a stray AUDIT_DB_URL or a
 * repo-root .env could change downstream probe behaviour even though these
 * specific assertions don't read it today). Same minimal-allowlist +
 * isolated-cwd technique as tests/relocation-selfcheck-smoke.test.mjs.
 */
function hermeticEnv() {
  const env = { CI: '1', NO_COLOR: '1' };
  for (const k of ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']) {
    if (process.env[k] != null) env[k] = process.env[k];
  }
  return env;
}

function hermeticCwd() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-cli-flags-hermetic-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
  return dir;
}

describe('onlyFlagValue', () => {
  it('returns null when the flag is absent', () => {
    assert.equal(onlyFlagValue(['node', 'doctor.mjs']), null);
  });

  it('returns the value when given', () => {
    assert.equal(onlyFlagValue(['node', 'doctor.mjs', '--only', 'env/package-manager']), 'env/package-manager');
  });

  it('accepts the --only=<value> form', () => {
    assert.equal(onlyFlagValue(['node', 'doctor.mjs', '--only=env/package-manager']), 'env/package-manager');
  });

  it('throws rather than silently returning null when given with no usable value (last argv token)', () => {
    assert.throws(() => onlyFlagValue(['node', 'doctor.mjs', '--only']), /no usable value/);
  });

  it('throws rather than swallowing a FOLLOWING flag as its value', () => {
    assert.throws(() => onlyFlagValue(['node', 'doctor.mjs', '--only', '--gate']), /no usable value/);
  });

  it('throws on an explicit empty string (--only \'\'), rather than reading it as "no filter" (closes round-4 audit H1)', () => {
    assert.throws(() => onlyFlagValue(['node', 'doctor.mjs', '--only', '']), /no usable value/);
  });

  it('throws on --only= with nothing after the equals', () => {
    assert.throws(() => onlyFlagValue(['node', 'doctor.mjs', '--only=']), /no usable value/);
  });
});

describe('bundleShaFlagValue', () => {
  it('returns null when the flag is absent', () => {
    assert.equal(bundleShaFlagValue(['node', 'doctor.mjs']), null);
  });

  it('returns the value when given', () => {
    assert.equal(bundleShaFlagValue(['node', 'doctor.mjs', '--bundle-sha', 'abc123']), 'abc123');
  });

  it('throws rather than silently returning null when given with no usable value', () => {
    assert.throws(() => bundleShaFlagValue(['node', 'doctor.mjs', '--bundle-sha']), /no usable value/);
  });
});

describe('doctor.mjs CLI: cloud resolution does not crash with --consumer-root pointed at a repo with no .env (round-4 audit M4)', () => {
  it('a target repo with no .env at all still runs cleanly (resolveCloudConfig degrades gracefully)', () => {
    const dir = hermeticCwd();
    try {
      const out = execFileSync(
        process.execPath,
        [DOCTOR_MJS, '--consumer-root', dir, '--only', 'env/package-manager', '--json'],
        { encoding: 'utf-8', cwd: dir, env: hermeticEnv() },
      );
      const parsed = JSON.parse(out.trim().split('\n').pop());
      assert.ok(Array.isArray(parsed.results));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('doctor.mjs CLI: --only validates against the real probe registry (round-3 audit M15)', () => {
  it('a typo\'d/unknown --only id exits 2 with a clear error, rather than silently matching nothing', () => {
    const dir = hermeticCwd();
    try {
      assert.throws(
        () => execFileSync(process.execPath, [DOCTOR_MJS, '--only', 'nonexistent-id-xyz'], { encoding: 'utf-8', cwd: dir, env: hermeticEnv() }),
        (err) => {
          assert.equal(err.status, 2);
          assert.match(err.stderr, /unknown probe id/);
          return true;
        },
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('a value that normalises to no ids at all (e.g. "--only=,,,") is rejected, not silently unfiltered (closes round-5 audit L2)', () => {
    const dir = hermeticCwd();
    try {
      assert.throws(
        () => execFileSync(process.execPath, [DOCTOR_MJS, '--only=,,,'], { encoding: 'utf-8', cwd: dir, env: hermeticEnv() }),
        (err) => { assert.equal(err.status, 2); assert.match(err.stderr, /no valid probe id/); return true; },
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('a real, known --only id runs cleanly (round-5 audit M19: hermetic cwd/env — no reliance on the test runner\'s own repo state)', () => {
    const dir = hermeticCwd();
    try {
      const out = execFileSync(
        process.execPath,
        [DOCTOR_MJS, '--consumer-root', dir, '--only', 'env/package-manager', '--json'],
        { encoding: 'utf-8', cwd: dir, env: hermeticEnv() },
      );
      const parsed = JSON.parse(out);
      assert.ok(Array.isArray(parsed.results));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
