/**
 * Audit-context integrity: redaction must not silently shorten the thing under
 * review.
 *
 * `readFilesAsContext` redacts file bodies before they reach the LLM auditor, and
 * `redactSecrets` can COLLAPSE a span (the `pem-private-key` pattern spans
 * BEGIN…END) rather than merely masking a token. So the text a reviewer sees can
 * be structurally different from the file on disk.
 *
 * Observed 2026-07-19: a test file whose BEGIN and END markers sat in two
 * unrelated fixtures had ~80 lines between them collapsed into one placeholder.
 * Three reviewers then reported the file as syntactically broken — correctly,
 * for the mangled input they were given. That is the "green (or red) over content
 * that was never really examined" class: confident findings about code that is
 * not on disk.
 *
 * Two defences, tested here and in tests/secret-patterns.test.mjs:
 *   1. the pattern is charset-bounded so it cannot span code (upstream fix), and
 *   2. any span collapse that DOES happen is announced, inline, next to the file.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readFilesAsContext } from '../scripts/lib/audit-scope.mjs';

// Assembled from parts so this file cannot mangle ITSELF — the very failure
// under test. A literal BEGIN…END pair here would collapse everything between.
const PEM_BEGIN = `-----BEGIN RSA ${'PRIVATE'} KEY-----`;
const PEM_END = `-----END RSA ${'PRIVATE'} KEY-----`;
const PEM_LINE = 'MIIEowIBAAKCAQEAvR2LmS8kQe1nQ9pXmZ7cVbNfJ4hT2sYwKpLdGxRtUiOaMnBv';
const REAL_KEY = [PEM_BEGIN, ...Array.from({ length: 12 }, () => PEM_LINE), PEM_END].join('\n');

let dir, cwd;

before(() => {
  cwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-redaction-'));
  process.chdir(dir);
});

after(() => {
  process.chdir(cwd);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** The per-file section of the assembled context. */
const sectionFor = (ctx, file) => (ctx.split(`### ${file}`)[1] || '').split('### ')[0];

describe('audit context — span collapse is announced, token masking is not', () => {
  it('a collapsed span is flagged INLINE, next to the file it happened in', () => {
    fs.writeFileSync('haskey.mjs', `const cfg = \`${REAL_KEY}\`;\nconst after = 1;\n`);
    const ctx = readFilesAsContext(['haskey.mjs']);

    const section = sectionFor(ctx, 'haskey.mjs');
    assert.match(section, /REDACTION REMOVED CONTENT FROM THIS FILE/,
      'the reviewer must be told this file is not byte-identical to disk');
    assert.match(section, /Do NOT report syntax errors/,
      'the note must say what NOT to conclude — that is the failure it prevents');
    // Inline placement is the point: a summary at the end of a 120K-char context
    // does not reach the model reasoning about this particular file.
    assert.ok(section.includes('REDACTION REMOVED CONTENT'),
      'the note must sit in the file section, not only in a trailing summary');
  });

  it('masking an ordinary token does NOT trigger the note (no crying wolf)', () => {
    fs.writeFileSync('token.mjs', 'const t = "ghp_16C7e42F292c6912E7710c838347Ae178B4a";\n');
    const ctx = readFilesAsContext(['token.mjs']);
    assert.doesNotMatch(sectionFor(ctx, 'token.mjs'), /REDACTION REMOVED CONTENT/,
      'a token mask loses tens of characters and hides no code — flagging it would '
      + 'train reviewers to ignore the warning that matters');
  });

  it('a clean file is untouched', () => {
    fs.writeFileSync('clean.mjs', 'const x = 1;\nconst y = 2;\n');
    const ctx = readFilesAsContext(['clean.mjs']);
    assert.doesNotMatch(sectionFor(ctx, 'clean.mjs'), /REDACTION REMOVED CONTENT/);
  });

  it('a trailing summary lists every shortened file', () => {
    fs.writeFileSync('k2.mjs', `const cfg = \`${REAL_KEY}\`;\n`);
    const ctx = readFilesAsContext(['k2.mjs']);
    assert.match(ctx, /SHORTENED by secret-redaction before review/);
    assert.match(ctx, /k2\.mjs \(-\d+ chars\)/, 'the summary must quantify the loss');
  });

  it('redact:false disables the check rather than reporting a phantom loss', () => {
    fs.writeFileSync('k3.mjs', `const cfg = \`${REAL_KEY}\`;\n`);
    const ctx = readFilesAsContext(['k3.mjs'], { redact: false });
    assert.doesNotMatch(ctx, /REDACTION REMOVED CONTENT/);
    assert.ok(ctx.includes(PEM_LINE), 'redact:false must pass content through verbatim');
  });
});

describe('audit context — the upstream fix: code between markers is not spanned', () => {
  it('two unrelated PEM markers no longer swallow the code between them', () => {
    // The exact 2026-07-19 repro: BEGIN in one fixture, END in another, with
    // real code in between. Before the pattern was charset-bounded, all of it
    // collapsed into a single placeholder.
    const code = Array.from({ length: 40 }, (_, i) => `  const line${i} = { a: ${i} };`).join('\n');
    fs.writeFileSync('twomarkers.mjs', `const a = '${PEM_BEGIN}';\n${code}\nconst b = '${PEM_END}';\n`);

    const ctx = readFilesAsContext(['twomarkers.mjs']);
    const section = sectionFor(ctx, 'twomarkers.mjs');

    assert.ok(section.includes('const line0 = { a: 0 };'), 'the first line of code must survive');
    assert.ok(section.includes('const line39 = { a: 39 };'), 'the last line of code must survive');
    assert.doesNotMatch(section, /REDACTION REMOVED CONTENT/,
      'nothing was collapsed, so there is nothing to warn about');
  });
});
