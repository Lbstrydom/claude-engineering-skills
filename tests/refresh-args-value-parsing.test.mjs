/**
 * @fileoverview Regression tests for refresh-args.mjs's `parseArgs` value-
 * parsing (symbol-index-pipeline-reliability-hardening plan, Theme 4,
 * round-1 H7 + round-2 H2). Two failure classes fixed together:
 *
 *  - H7: boolean flags (--full/--force/--include-delegates) had no defined
 *    behavior for an inline value (`--full=true`) — they now REJECT it.
 *  - H2: `--since-commit` silently fell through to "absent" (→ promoted to
 *    a full walk) on every value-less shape: end-of-argv, the next token
 *    looking like a flag (`--since-commit --force`), and `--since-commit=`
 *    (empty string). It now THROWS on all three instead.
 *
 * Complements tests/cli-unknown-flags.test.mjs (the allowlist check itself).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../scripts/symbol-index/refresh-args.mjs';

const argv = (...rest) => ['node', 'refresh.mjs', ...rest];

describe('refresh-args.mjs parseArgs — space-separated form (unaffected)', () => {
  it('--since-commit abc123 parses normally', () => {
    const args = parseArgs(argv('--since-commit', 'abc123'));
    assert.equal(args.sinceCommit, 'abc123');
  });

  it('--full / --force / --include-delegates parse normally with no value', () => {
    const args = parseArgs(argv('--full', '--force', '--include-delegates'));
    assert.equal(args.full, true);
    assert.equal(args.force, true);
    assert.equal(args.includeDelegates, true);
  });
});

describe('refresh-args.mjs parseArgs — `=`-form populates the same field (round-1 H7)', () => {
  it('--since-commit=abc123 populates sinceCommit identically to the space-separated form', () => {
    const args = parseArgs(argv('--since-commit=abc123'));
    assert.equal(args.sinceCommit, 'abc123');
  });
});

describe('refresh-args.mjs parseArgs — boolean flags REJECT an inline value (round-1 H7)', () => {
  it('--full=true throws', () => {
    assert.throws(() => parseArgs(argv('--full=true')), /--full does not take a value/);
  });

  it('--force=true throws', () => {
    assert.throws(() => parseArgs(argv('--force=true')), /--force does not take a value/);
  });

  it('--include-delegates=true throws', () => {
    assert.throws(() => parseArgs(argv('--include-delegates=true')), /--include-delegates does not take a value/);
  });
});

describe('refresh-args.mjs parseArgs — --since-commit rejects every value-less shape (round-2 H2)', () => {
  it('end-of-argv (no value at all) throws — was silently treated as absent → full walk', () => {
    assert.throws(() => parseArgs(argv('--since-commit')), /--since-commit requires a non-empty value/);
  });

  it('the next token looking like a flag throws — was silently consumed as the commit, disabling the OTHER flag', () => {
    assert.throws(() => parseArgs(argv('--since-commit', '--force')), /--since-commit requires a non-empty value/);
  });

  it('`--since-commit=` (empty string) throws', () => {
    assert.throws(() => parseArgs(argv('--since-commit=')), /--since-commit requires a non-empty value/);
  });
});

describe('refresh-args.mjs parseArgs — POSIX `--` terminator (Gemini-shadow finding)', () => {
  it('a positional flag-looking token after `--` is NOT parsed as a real flag', () => {
    const args = parseArgs(argv('--', '--full'));
    assert.equal(args.full, false, '--full after the -- terminator must not be treated as the real flag');
  });

  it('flags BEFORE `--` are still parsed normally', () => {
    const args = parseArgs(argv('--force', '--', '--full'));
    assert.equal(args.force, true);
    assert.equal(args.full, false);
  });
});
