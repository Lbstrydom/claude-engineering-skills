/**
 * @fileoverview `sync-isolation-verify.mjs`'s `--gates` flag parsing
 * (backlog-triage fix).
 *
 * THE DEFECT (verified live before this fix): `--gates ''` split/trimmed/
 * filtered down to an empty array, and `runGates()` over an empty gate list
 * produces zero results — no failures, exit 0. A verifier that ran ZERO gates
 * was indistinguishable from one that ran every gate and found nothing wrong.
 * Separately, `parseArgs`'s if/else-if chain had no final `else`, so an
 * unrecognized flag alongside a recognized one (`--gates 1 --bogus-flag foo`)
 * was silently ignored rather than refused — the exact class
 * `assertKnownFlags` (scripts/lib/cli-io.mjs) exists to close, and every
 * other CLI census-tracked by `check-cli-flags.mjs` already uses it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _internals } from '../scripts/lib/sync-isolation-verify.mjs';
import { ArgvError } from '../scripts/lib/cli-io.mjs';

const { parseArgs } = _internals;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SCRIPT = path.join(REPO, 'scripts', 'lib', 'sync-isolation-verify.mjs');

describe('parseArgs refuses an empty --gates value instead of silently running zero gates', () => {
  it('--gates "" throws rather than resolving to an empty gate list', () => {
    assert.throws(() => parseArgs(['--gates', '']), ArgvError);
    assert.throws(() => parseArgs(['--gates', '']), /would run ZERO gates/);
  });

  it('--gates "  ,  " (whitespace/commas only) is refused the same way', () => {
    assert.throws(() => parseArgs(['--gates', '  ,  ']), /would run ZERO gates/);
  });

  it('omitting --gates entirely still defaults to running every gate', () => {
    const out = parseArgs([]);
    assert.ok(Array.isArray(out.gates) && out.gates.length > 0);
  });

  it('a real --gates value still parses correctly (positive control)', () => {
    const out = parseArgs(['--gates', '1,2A']);
    assert.deepEqual(out.gates, ['1', '2A']);
  });
});

describe('parseArgs refuses an unrecognized flag rather than silently ignoring it', () => {
  it('a bogus flag alongside a recognized one throws', () => {
    assert.throws(() => parseArgs(['--gates', '1', '--bogus-flag', 'x']), ArgvError);
  });

  it('every flag the parser itself recognizes is still accepted (positive control)', () => {
    assert.doesNotThrow(() => parseArgs(['--consumer-root', '.', '--legacy-manifest', 'x', '--gates', '1', '--format', 'json', '--selfcheck-relocation', '--selfcheck-inventory']));
  });
});

describe('end-to-end CLI: the same two refusals, exercised as a real subprocess', () => {
  it('--gates "" exits non-zero (not 0) instead of a silent clean pass', () => {
    assert.throws(() => {
      execFileSync(process.execPath, [SCRIPT, '--gates', '', '--consumer-root', REPO], { encoding: 'utf-8', stdio: 'pipe' });
    }, (err) => {
      // A silent clean pass would mean err is undefined (exit 0). Any thrown
      // exec error here proves the process exited non-zero.
      assert.notEqual(err.status, 0, 'must not exit 0 having run zero gates');
      assert.match(String(err.stderr), /ZERO gates/);
      return true;
    });
  });

  it('an unrecognized flag alongside --gates exits non-zero, naming the offending flag', () => {
    assert.throws(() => {
      execFileSync(process.execPath, [SCRIPT, '--gates', '1', '--bogus-flag', 'x', '--consumer-root', REPO], { encoding: 'utf-8', stdio: 'pipe' });
    }, (err) => {
      assert.notEqual(err.status, 0);
      assert.match(String(err.stderr), /unknown flag "--bogus-flag"/);
      return true;
    });
  });
});
