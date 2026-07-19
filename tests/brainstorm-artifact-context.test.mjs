/**
 * @fileoverview Egress contract for `/brainstorm --with-artifact`.
 *
 * TIER 3 (AGENTS.md testing doctrine — "HARD test-first, non-negotiable"):
 * `--with-artifact` reads an OPERATOR-SUPPLIED path and ships it verbatim
 * to OpenAI and Gemini. That is the sensitive-path egress seam, and a leak
 * here ships credentials to a third-party LLM. Every refusal branch below
 * is a gate, not a nicety.
 *
 * The symlink cases inject `fs` (supported by `resolveAndClassify`) rather
 * than creating real symlinks — Windows symlink creation needs elevation,
 * and this contract must be verifiable on every dev machine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveArtifact, loadArtifacts, ARTIFACT_MAX_TOKENS } from '../scripts/lib/brainstorm/artifact-context.mjs';

/** Build a throwaway repo root with a couple of files. */
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brainstorm-artifact-'));
  fs.mkdirSync(path.join(root, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'plans', 'thing.md'), '# Thing\n\nBody text.\n');
  fs.writeFileSync(path.join(root, '.env'), 'OPENAI_API_KEY=sk-real-secret\n');
  return root;
}

test('attaches a normal repo file verbatim', () => {
  const root = makeRepo();
  const r = resolveArtifact('docs/plans/thing.md', { repoRoot: root });
  assert.equal(r.state, 'ok');
  assert.equal(r.text, '# Thing\n\nBody text.\n', 'content must be verbatim, not summarised');
  assert.equal(r.path, 'docs/plans/thing.md');
});

test('REFUSES a sensitive path by lexical name (.env)', () => {
  const root = makeRepo();
  const r = resolveArtifact('.env', { repoRoot: root });
  assert.equal(r.state, 'refused');
  assert.equal(r.reason, 'sensitive');
  assert.equal(r.text, '', 'refused artifact must carry no content');
  assert.ok(!JSON.stringify(r).includes('sk-real-secret'), 'secret must not leak into the result object');
});

test('REFUSES an innocently-named symlink resolving to a sensitive target', () => {
  const root = makeRepo();
  // Visible name is innocent; realpath lands in ~/.ssh/id_rsa.
  const fakeFs = {
    ...fs,
    realpathSync: (p) => (String(p).endsWith('notes.md')
      ? path.join(root, '.ssh', 'id_rsa')
      : fs.realpathSync(p)),
  };
  const r = resolveArtifact('notes.md', { repoRoot: root, fs: fakeFs });
  assert.equal(r.state, 'refused');
  assert.equal(r.reason, 'sensitive');
});

test('REFUSES a symlink escaping the repo root', () => {
  const root = makeRepo();
  const outside = path.join(os.tmpdir(), 'elsewhere-secrets.txt');
  const fakeFs = { ...fs, realpathSync: () => outside };
  const r = resolveArtifact('docs/plans/thing.md', { repoRoot: root, fs: fakeFs });
  assert.equal(r.state, 'refused');
  assert.equal(r.reason, 'escaped-repo');
});

test('reports a missing file as missing, NOT as sensitive', () => {
  const root = makeRepo();
  const r = resolveArtifact('docs/plans/nope.md', { repoRoot: root });
  assert.equal(r.state, 'missing', 'a typo must not read as "your file is secret"');
  assert.equal(r.text, '');
});

test('redacts secret patterns inside an otherwise-permitted artifact', () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'docs', 'plans', 'leaky.md'),
    'Config notes\nsk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n');
  const r = resolveArtifact('docs/plans/leaky.md', { repoRoot: root });
  assert.equal(r.state, 'ok');
  assert.ok(!/sk-ant-api03-A{20}/.test(r.text), 'in-file secret must be redacted before egress');
  assert.ok(r.redactionCount > 0);
});

test('truncates an oversized artifact rather than blowing the budget', () => {
  const root = makeRepo();
  const huge = 'x'.repeat(ARTIFACT_MAX_TOKENS * 4 * 3);
  fs.writeFileSync(path.join(root, 'docs', 'plans', 'huge.md'), huge);
  const r = resolveArtifact('docs/plans/huge.md', { repoRoot: root });
  assert.equal(r.state, 'ok');
  assert.ok(r.truncated, 'oversized artifact must be marked truncated');
  assert.ok(r.text.length < huge.length);
  assert.match(r.text, /truncated/i, 'truncation must be visible to the model, not silent');
});

test('loadArtifacts keeps permitted files and reports refusals separately', () => {
  const root = makeRepo();
  const out = loadArtifacts(['docs/plans/thing.md', '.env'], { repoRoot: root });
  assert.equal(out.attached.length, 1);
  assert.equal(out.attached[0].path, 'docs/plans/thing.md');
  assert.equal(out.refused.length, 1);
  assert.equal(out.refused[0].path, '.env');
  assert.ok(!out.text.includes('sk-real-secret'));
});

test('one refused artifact does not suppress the others (partial attach)', () => {
  const root = makeRepo();
  const out = loadArtifacts(['.env', 'docs/plans/thing.md'], { repoRoot: root });
  assert.equal(out.attached.length, 1, 'a refusal must not abort the whole payload');
  assert.equal(out.refused.length, 1);
});
