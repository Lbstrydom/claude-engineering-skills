/**
 * @fileoverview `check-emit-exit-agreement.mjs` must actually reject an unknown
 * flag when RUN, not merely when its source is scanned by the static
 * `check-cli-flags` detector.
 *
 * The defect (found 2026-08-12, documented in `tests/check-cli-flags.test.mjs`
 * "a MISCALL is not a guard" cases): the script called
 * `assertKnownFlags(process.argv.slice(2), KNOWN_FLAGS, { cli: '...' })`. The
 * helper's default `from` offset is `2`, meant for the FULL `process.argv`
 * (`[node, script, ...args]`); applied to an already-sliced array it skips the
 * first two real arguments, so a mistyped flag in that position ran the gate
 * happily at exit 0 — the exact accepted-and-inert defect `cli:flags:gate`
 * exists to catch, reproduced inside a gate script itself.
 *
 * `check-cli-flags.test.mjs` guards the general DETECTOR against this source
 * shape; this suite guards the one concrete script by actually executing it,
 * which is the only way to observe the `from` offset's real effect.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CLI = path.join(REPO, 'scripts', 'check-emit-exit-agreement.mjs');

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: REPO, encoding: 'utf-8' });
}

describe('check-emit-exit-agreement.mjs rejects unknown flags at runtime', () => {
  it('exits non-zero on an unrecognized flag, naming it in stderr', () => {
    const res = run(['--bogus-flag']);
    assert.notEqual(res.status, 0, `expected a refusal; stdout:\n${res.stdout}`);
    assert.match(res.stderr, /unknown flag "--bogus-flag"/);
  });

  it('positive control: a real known flag (--json) still runs to completion', () => {
    // Without this, a fix that made the CLI reject EVERYTHING (rather than only
    // unknown flags) would also pass the test above.
    const res = run(['--json']);
    assert.equal(res.status, 0, `expected success; stderr:\n${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, true);
  });

  it('a bogus flag in the FIRST position is caught too — the exact `from:2`-on-a-sliced-array failure', () => {
    // The original defect's failure mode was specific to offset: with
    // `process.argv.slice(2)` fed back in under the helper's default `from: 2`,
    // the FIRST supplied argument is the one silently skipped. Asserting on a
    // single leading bogus flag pins that exact regression, not just "some
    // argument somewhere is checked".
    const res = run(['--bogus-flag', '--json']);
    assert.notEqual(res.status, 0, `expected a refusal; stdout:\n${res.stdout}`);
    assert.match(res.stderr, /unknown flag "--bogus-flag"/);
  });
});
