/**
 * @fileoverview `extract.mjs` argument-parsing contract (audit-code-manifest
 * round 1: H1/M1 precedence, M2 fail-open unknown flags, M4 lossy `--files`,
 * M5 option-looking values).
 *
 * This CLI decides WHICH files an incremental refresh extracts, so every defect
 * here is "silently indexed the wrong subset" — the same failure class as the
 * lossy manifest, one layer up in the argument grammar. The contract mirrors
 * `refresh-args.mjs`, which this repo already standardised on: an allowlist
 * that rejects unknown flags, `--flag=value` support, a `--` terminator, and
 * scope resolved once after parsing rather than by assignment order.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _internals, KNOWN_FLAGS } from '../scripts/symbol-index/extract.mjs';
import { formatFilesManifest } from '../scripts/lib/symbol-index/files-manifest.mjs';

const { parseArgs } = _internals;

const tmp = [];
function manifest(paths) {
  const p = path.join(os.tmpdir(), `extract-cli-${process.pid}-${tmp.length}.manifest`);
  fs.writeFileSync(p, formatFilesManifest(paths), 'utf-8');
  tmp.push(p);
  return p;
}
const argv = (...rest) => ['node', 'extract.mjs', ...rest];

after(() => { while (tmp.length) { try { fs.unlinkSync(tmp.pop()); } catch { /* best-effort */ } } });

describe('extract.mjs parseArgs — scope resolution (H1/M1)', () => {
  it('rejects --files and --files-from together instead of letting order decide', () => {
    const m = manifest(['src/intended.mjs']);
    // Both orders must behave identically. Previously the LAST one won, so
    // `--files-from m --files stale.js` silently indexed stale.js despite the
    // documented "--files-from takes precedence".
    assert.throws(
      () => parseArgs(argv('--files-from', m, '--files', 'src/stale.js')),
      /mutually exclusive/,
    );
    assert.throws(
      () => parseArgs(argv('--files', 'src/stale.js', '--files-from', m)),
      /mutually exclusive/,
    );
  });

  it('rejects a repeated flag rather than taking the last one (shadow a9ff15b5)', () => {
    // The cross-flag fix left same-flag repetition still order-dependent:
    // `--files-from intended --files-from stale` silently used `stale`. Same
    // defect, one scope narrower, so it gets the same answer — refuse.
    const m = manifest(['src/a.mjs']);
    assert.throws(() => parseArgs(argv('--files-from', m, '--files-from', m)), /supplied more than once/);
    assert.throws(() => parseArgs(argv('--files', 'a.mjs', '--files', 'b.mjs')), /supplied more than once/);
    assert.throws(() => parseArgs(argv('--mode', 'full', '--mode', 'incremental')), /supplied more than once/);
    assert.throws(() => parseArgs(argv('--root', '/a', '--root=/b')), /supplied more than once/);
    assert.throws(() => parseArgs(argv('--include-delegates', '--include-delegates')), /supplied more than once/);
  });

  it('resolves each scope source on its own, in either position', () => {
    const m = manifest(['src/a.mjs', 'src/b.mjs']);
    assert.deepEqual(parseArgs(argv('--files-from', m)).files, ['src/a.mjs', 'src/b.mjs']);
    assert.deepEqual(parseArgs(argv('--mode', 'incremental', '--files-from', m)).files, ['src/a.mjs', 'src/b.mjs']);
    assert.deepEqual(parseArgs(argv('--files', 'src/a.mjs,src/b.mjs')).files, ['src/a.mjs', 'src/b.mjs']);
  });

  it('keeps the three-valued files contract: null vs [] vs list', () => {
    // null = unrestricted full walk; [] = a REAL zero-file scope (b021576b).
    // Collapsing [] to null silently promotes a docs-only incremental run to a
    // full repo walk.
    assert.equal(parseArgs(argv('--mode', 'incremental')).files, null);
    assert.deepEqual(parseArgs(argv('--files-from', manifest([]))).files, []);
  });
});

describe('extract.mjs parseArgs — unknown flags fail closed (M2)', () => {
  it('rejects a misspelled scope flag rather than silently walking the whole repo', () => {
    const m = manifest(['src/a.mjs']);
    // The real hazard: `--files-form` (a one-letter typo) was dropped whole,
    // leaving files=null — an unrestricted full walk that LOOKS like it worked.
    assert.throws(() => parseArgs(argv('--files-form', m, '--mode', 'incremental')), /unknown flag/);
  });

  it('rejects an unknown flag even when every other flag is valid', () => {
    assert.throws(() => parseArgs(argv('--mode', 'full', '--dry-run')), /unknown flag/);
  });

  it('accepts every flag it advertises — the allowlist is not a lie', () => {
    // Vacuous-pass guard for the two tests above: proves they fail on the flag
    // being unknown, not because parseArgs rejects everything.
    const m = manifest(['src/a.mjs']);
    const parsed = parseArgs(argv('--root', '/tmp/x', '--files-from', m, '--mode', 'incremental', '--include-delegates'));
    assert.equal(parsed.mode, 'incremental');
    assert.equal(parsed.includeDelegates, true);
    for (const flag of KNOWN_FLAGS) {
      assert.match(flag, /^--[a-z-]+$/, `${flag} must be a well-formed long flag`);
    }
  });

  it('validates --mode against its enum instead of accepting free-form text', () => {
    assert.throws(() => parseArgs(argv('--mode', 'increment')), /--mode must be one of/);
  });
});

describe('extract.mjs parseArgs — value handling (M4/M5)', () => {
  it('diagnoses an empty --files record instead of dropping it', () => {
    // `.filter(Boolean)` used to silently shorten the list, so a malformed
    // argument produced a smaller scope that still looked successful.
    assert.throws(() => parseArgs(argv('--files', 'src/a.mjs,,src/b.mjs')), /empty entry/);
    assert.throws(() => parseArgs(argv('--files', 'src/a.mjs,')), /empty entry/);
  });

  it('points a comma-containing path at the lossless route', () => {
    // Comma is legal in a POSIX filename, so --files structurally cannot carry
    // one. The error must say where to go rather than silently splitting.
    assert.throws(
      () => parseArgs(argv('--files', 'src/a,b.mjs,')),
      /--files-from/,
    );
  });

  it('still refuses a missing value that would swallow the next flag', () => {
    assert.throws(() => parseArgs(argv('--files', '--mode', 'incremental')), /requires a non-empty value/);
    assert.throws(() => parseArgs(argv('--mode')), /requires a non-empty value/);
  });

  it('accepts an option-looking value via the inline form (M5 escape hatch)', () => {
    // A path beginning with `--` is legal and was unrepresentable: the
    // space-separated guard cannot tell it from a missing value. `--flag=value`
    // disambiguates, exactly as refresh-args.mjs does.
    assert.deepEqual(parseArgs(argv('--files=--odd-name.mjs')).files, ['--odd-name.mjs']);
    assert.equal(parseArgs(argv('--root=--weird-root')).root, '--weird-root');
  });

  it('rejects an empty inline value', () => {
    assert.throws(() => parseArgs(argv('--mode=')), /requires a non-empty value/);
  });

  it('rejects a value on a boolean flag rather than ignoring it', () => {
    assert.throws(() => parseArgs(argv('--include-delegates=yes')), /does not take a value/);
  });

  it('reports a usage error before touching the filesystem (shadow 9b082099)', () => {
    // The manifest read used to happen inside the argv loop, so an invocation
    // wrong in TWO ways (both scope flags AND a bad manifest path) surfaced the
    // raw ENOENT rather than the usage error — the less informative of the two.
    assert.throws(
      () => parseArgs(argv('--files-from', '/nonexistent/nope.manifest', '--files', 'a.mjs')),
      /mutually exclusive/,
      'argument-shape validation must run before any filesystem access',
    );
  });

  it('turns an unreadable manifest into a CLI diagnostic, not a bare Node stack', () => {
    assert.throws(
      () => parseArgs(argv('--files-from', '/nonexistent/nope.manifest')),
      /--files-from: cannot read manifest .*ENOENT/,
    );
  });

  it('refuses positional operands after -- rather than silently discarding them', () => {
    // The terminator must still be HONOURED (a following `--files` is not a
    // flag), but this CLI takes no positionals, so silently dropping them is
    // the same fail-open shape as the unknown-flag bug.
    assert.throws(
      () => parseArgs(argv('--mode', 'full', '--', '--files', 'src/a.mjs')),
      /no positional operands are accepted/,
    );
    assert.throws(() => parseArgs(argv('--', 'stray.mjs')), /no positional operands/);
  });

  it('a bare trailing -- is still accepted (it discards nothing)', () => {
    // Vacuous-pass guard for the rejection above: proves it fires on there
    // being operands, not on the terminator itself.
    assert.equal(parseArgs(argv('--mode', 'full', '--')).mode, 'full');
  });
});
