/**
 * @fileoverview The `--files-from` manifest wire format (topicIds `c191e74d781b`
 * HIGH / `395e92881aa4` MEDIUM, docs/plans/refactor-arch-memory-symbol-index-2026-07.md
 * Theme 3).
 *
 * The manifest is the handoff that decides WHICH files an incremental refresh
 * extracts. Everything upstream of it is NUL-clean — `vcs.mjs` runs
 * `git diff --name-status -z` and `git ls-files -z` and hard-fails on a
 * malformed stream — so a path containing a newline or leading/trailing
 * whitespace survives intact all the way to this seam, where the old
 * newline-join + `.trim()` split it into two phantom paths (or mangled it).
 * A path that mangles here is a file that is silently NOT indexed.
 *
 * The format therefore mirrors `vcs.mjs`'s own `parseUntrackedPathsZ`
 * contract verbatim: empty content is valid and means a real zero-file scope;
 * non-empty content MUST end in a NUL; exactly one trailing empty token is
 * discarded; an interior empty token is malformed and is NOT tolerated
 * (silently skipping it is the `.filter(Boolean)` data-loss class AGENTS.md
 * names).
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFilesManifestIfRestricted } from '../scripts/symbol-index/refresh-subprocess.mjs';
import { formatFilesManifest } from '../scripts/lib/symbol-index/files-manifest.mjs';
import { _internals as extractInternals } from '../scripts/symbol-index/extract.mjs';

const { parseArgs } = extractInternals;

/** Paths that are legal on POSIX and that the old newline+trim format destroyed. */
const HOSTILE = [
  'src/plain.mjs',
  'src/has spaces.mjs',
  ' src/leading-space.mjs',
  'src/trailing-space.mjs ',
  'src/embedded\nnewline.mjs',
  'src/trailing-tab.mjs\t',
];

const tmpFiles = [];
function writeManifest(content) {
  const p = path.join(os.tmpdir(), `manifest-wire-${process.pid}-${tmpFiles.length}.txt`);
  fs.writeFileSync(p, content, 'utf-8');
  tmpFiles.push(p);
  return p;
}
function readFilesFrom(manifestPath) {
  return parseArgs(['node', 'extract.mjs', '--files-from', manifestPath]).files;
}

after(() => {
  while (tmpFiles.length) {
    try { fs.unlinkSync(tmpFiles.pop()); } catch { /* best-effort */ }
  }
});

describe('--files-from manifest wire format (c191e74d781b/395e92881aa4)', () => {
  it('round-trips every path the upstream NUL-clean git layer can hand it', () => {
    const manifestPath = writeFilesManifestIfRestricted(HOSTILE);
    tmpFiles.push(manifestPath);
    assert.deepEqual(
      readFilesFrom(manifestPath),
      HOSTILE,
      'producer -> reader must be lossless for every POSIX-legal path',
    );
  });

  it('writes NUL-terminated records, not newline-joined text', () => {
    const manifestPath = writeFilesManifestIfRestricted(['a.mjs', 'b/c.mjs']);
    tmpFiles.push(manifestPath);
    assert.equal(fs.readFileSync(manifestPath, 'utf-8'), 'a.mjs\0b/c.mjs\0');
  });

  it('an empty scope writes empty content and reads back as a real zero-file scope', () => {
    // b021576b: `[]` is "a resolved scope of zero files", NOT "unrestricted".
    // It must survive the round trip as `[]` and never degrade to `null`.
    const manifestPath = writeFilesManifestIfRestricted([]);
    tmpFiles.push(manifestPath);
    assert.equal(fs.readFileSync(manifestPath, 'utf-8'), '');
    assert.deepEqual(readFilesFrom(manifestPath), []);
  });

  // ── Negative controls: the parser must REFUSE, never silently mis-parse ──

  it('rejects content that does not end in a NUL terminator (truncation)', () => {
    const manifestPath = writeManifest('a.mjs\0b/c.mjs');
    assert.throws(
      () => readFilesFrom(manifestPath),
      /NUL terminator/,
      'a truncated manifest must fail loudly — a short list read as a complete one is silent data loss',
    );
  });

  it('rejects an interior empty token rather than dropping it', () => {
    const manifestPath = writeManifest('a.mjs\0\0b/c.mjs\0');
    assert.throws(
      () => readFilesFrom(manifestPath),
      /empty path token/,
      'an empty record means a malformed stream; .filter(Boolean) would hide it',
    );
  });

  // ── Producer validates symmetrically with the parser (shadow 3339be19) ──
  //
  // The parser was strict while the producer coerced anything via template
  // interpolation. The dangerous direction was silence: a non-string became a
  // literal path that matched no file, so the entry vanished from the
  // extraction scope with no error anywhere.

  it('refuses a non-string entry instead of coercing it to a literal path', () => {
    // The concrete shape that can reach here: refresh-file-scope.mjs builds its
    // list partly from `diff.renamed.map(r => r.to)`, so a mapping slip passes
    // the {from,to} object itself.
    assert.throws(() => formatFilesManifest(['a.mjs', { from: 'x', to: 'y' }]), /entry 1 is object/);
    assert.throws(() => formatFilesManifest(['a.mjs', undefined]), /entry 1 is undefined/);
    assert.throws(() => formatFilesManifest(['a.mjs', null]), /entry 1 is null/);
  });

  it('names the coercion consequence, so the reader knows why it matters', () => {
    assert.throws(() => formatFilesManifest([{ to: 'y' }]), /\[object Object\]/);
  });

  it('refuses an empty entry at the producer, not in the child', () => {
    // Previously this produced a manifest the parser rejected with an error
    // blaming a truncated write or the retired newline format — the wrong layer.
    assert.throws(() => formatFilesManifest(['a.mjs', '']), /entry 1 is an empty string/);
  });

  it('refuses already-framed content rather than double-framing it', () => {
    assert.throws(() => formatFilesManifest(['a.mjs\0b.mjs']), /contains a NUL byte/);
  });

  it('refuses a non-array argument', () => {
    assert.throws(() => formatFilesManifest('a.mjs'), /expected an array/);
  });

  it('still accepts every legitimate path shape (vacuous-pass guard)', () => {
    // Proves the validation above rejects on the stated grounds and has not
    // simply become reject-everything.
    assert.equal(formatFilesManifest(HOSTILE), HOSTILE.map(p => `${p}\0`).join(''));
    assert.equal(formatFilesManifest([]), '');
  });

  // ── Vacuous-pass guard ──────────────────────────────────────────────────
  // Proves the round-trip test above is actually testing the NUL format and
  // would not pass under the old newline-delimited one.

  it('does NOT accept the legacy newline-delimited format', () => {
    const manifestPath = writeManifest('src/alpha.mjs\nsrc/beta.mjs\n');
    assert.throws(
      () => readFilesFrom(manifestPath),
      /NUL terminator/,
      'a legacy newline manifest must be refused, not reinterpreted — a path containing a '
      + 'newline is indistinguishable from a separator, so dual-format sniffing reopens the bug',
    );
  });
});
