/**
 * @fileoverview Regression guard for the annotation-marker comment-safety
 * invariant (`scripts/lib/diff-annotation.mjs`).
 *
 * THE BUG (live, 2026-07-26). The UNCHANGED markers used to be block comments:
 * `/*` … `*` `/`. A git hunk boundary routinely lands *inside* a file-level
 * JSDoc block — git prepends 3 context lines, so any change near the top of a
 * file splits its header comment. The marker's closing delimiter then closed
 * the JSDoc early and the file's own closing delimiter became a stray token,
 * making the annotated payload handed to the GPT auditor genuinely invalid
 * JavaScript.
 *
 * The auditor duly reported a HIGH `[Sustainability] Syntax error` against
 * `tests/tiered-shadow-summary.test.mjs` — a file that passes `node --check`
 * and runs 119 green tests. It was reading the corrupted payload correctly;
 * the annotator was lying to it. Cost: a wasted audit round plus HIGH budget
 * that could have masked a real finding.
 *
 * These tests pin the property that actually prevents recurrence, not the
 * marker's cosmetic wording — a future redesign may reword the markers freely
 * as long as none of them can terminate an enclosing block comment.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  _annotationMarkers, parseDiffText, readFilesAsAnnotatedContext,
} from '../scripts/lib/diff-annotation.mjs';

// The two-character sequence is built at runtime so this test file can discuss
// the delimiter without containing it literally inside its own JSDoc header.
const CLOSE_DELIM = `*${'/'}`;

describe('annotation markers cannot terminate an enclosing block comment', () => {
  test('no marker contains a block-comment close delimiter (THE invariant)', () => {
    const markers = Object.entries(_annotationMarkers);
    assert.ok(markers.length >= 4, 'precondition: all four markers are exported');
    for (const [name, text] of markers) {
      assert.ok(
        !text.includes(CLOSE_DELIM),
        `${name} contains a block-comment close delimiter (${JSON.stringify(text)}). `
        + 'Injected into a file whose hunk boundary falls inside a JSDoc block, this closes '
        + 'that comment early and corrupts the payload the auditor reads — the 2026-07-26 bug.',
      );
    }
  });

  test('every marker is a line comment, so it degrades to inert text rather than corrupting', () => {
    for (const [name, text] of Object.entries(_annotationMarkers)) {
      assert.match(text, /^\/\//, `${name} must start with a line-comment prefix, got ${JSON.stringify(text)}`);
    }
  });
});

describe('end-to-end: a hunk boundary inside a JSDoc header keeps the payload parseable', () => {
  // Reproduces the original failure shape: a JSDoc file header, with the hunk
  // starting at a line INSIDE that header (as git does when the first change
  // sits near the top of the file).
  const SOURCE = [
    '/**',
    ' * @fileoverview Sample with a multi-line JSDoc header.',
    ' * line three',
    ' * line four',
    ' * line five',
    ' * line six',
    ' */',
    "import assert from 'node:assert/strict';",
    'export const x = 1;',
    '',
  ].join('\n');

  /** Annotate SOURCE in a temp cwd and return the fenced code body. */
  function annotate(hunkHeader) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-annot-'));
    const prevCwd = process.cwd();
    try {
      fs.writeFileSync(path.join(dir, 'sample.mjs'), SOURCE);
      process.chdir(dir);
      const out = readFilesAsAnnotatedContext(
        ['sample.mjs'],
        parseDiffText(`+++ b/sample.mjs\n${hunkHeader}\n`),
        { redact: false },
      );
      return out.split('```js\n')[1].split('\n```')[0];
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }

  test('the annotated payload still parses as JavaScript (node --check, the real oracle)', () => {
    const code = annotate('@@ -6,4 +6,4 @@');
    assert.ok(code.includes('UNCHANGED CONTEXT'), 'precondition: markers really were injected');
    assert.ok(code.includes('/**'), 'precondition: the JSDoc header really is split by the boundary');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-annot-check-'));
    const file = path.join(dir, 'annotated.mjs');
    try {
      fs.writeFileSync(file, code);
      // node --check is the ground truth for "is this valid JavaScript" — the
      // same oracle that disproved the original false-positive finding.
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
      assert.fail(
        'the annotated payload does not parse — the annotator is handing the auditor '
        + `broken code:\n${err.stderr?.toString() || err.message}\n\n--- payload ---\n${code}`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  test('the injected markers do not add or remove any of the file\'s own lines', () => {
    const code = annotate('@@ -6,4 +6,4 @@');
    const markerValues = new Set(Object.values(_annotationMarkers));
    const withoutMarkers = code.split('\n').filter((l) => !markerValues.has(l));
    assert.deepEqual(
      withoutMarkers, SOURCE.split('\n'),
      'stripping the markers must return the file byte-for-byte — annotation is additive only, '
      + 'so line numbers in a finding stay resolvable against the real file',
    );
  });
});
