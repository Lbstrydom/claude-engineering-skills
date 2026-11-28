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
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  resolveArtifact, loadArtifacts, summariseArtifacts, formatArtifactRenderLine, ARTIFACT_MAX_TOKENS,
} from '../scripts/lib/brainstorm/artifact-context.mjs';
import { BrainstormEnvelopeV2Schema, BrainstormEnvelopeWriteSchema } from '../scripts/lib/brainstorm/schemas.mjs';

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

// ── Render line: the envelope says what was attached (upstream c1f6738a) ─────
// The skill used to render "Focal artifact(s) sent verbatim" unconditionally,
// so a plan cut to a third of its length reached the user as sent whole. The
// helper now composes the exact line; these pin that it tells the truth.

test('a TRUNCATED artifact renders as TRUNCATED with ~N of M chars; a small one in the same call as whole', () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'docs', 'plans', 'huge.md'), 'y'.repeat(ARTIFACT_MAX_TOKENS * 4 * 3));
  const loaded = loadArtifacts(['docs/plans/huge.md', 'docs/plans/thing.md'], { repoRoot: root });
  const s = summariseArtifacts(loaded, { requested: 2, policyAttached: true });
  const huge = s.attached.find((a) => a.path === 'docs/plans/huge.md');
  assert.equal(huge.truncated, true);
  assert.ok(huge.sentChars < huge.totalChars, 'sentChars must be below totalChars for a cut file');
  assert.equal(huge.totalChars, ARTIFACT_MAX_TOKENS * 4 * 3);
  assert.match(s.renderLine, /^⚠ /, 'a cut set leads with a warning glyph');
  const n = huge.sentChars.toLocaleString('en-US');
  const m = huge.totalChars.toLocaleString('en-US');
  assert.ok(s.renderLine.includes(`\`docs/plans/huge.md\` (⚠ TRUNCATED to ~${n} of ${m} chars)`), s.renderLine);
  // Negative control inside the same call: the small file must NOT be called truncated.
  assert.ok(s.renderLine.includes('`docs/plans/thing.md` (whole)'), s.renderLine);
  assert.ok(s.renderLine.includes('+ repo policy pack'));
  assert.doesNotMatch(s.renderLine, /verbatim|\bsent\b|\bsaw\b|received|delivered/i);
});

test('negative control: an all-small set renders "attached whole" with no warning and no TRUNCATED', () => {
  const root = makeRepo();
  const s = summariseArtifacts(loadArtifacts(['docs/plans/thing.md'], { repoRoot: root }), { requested: 1, policyAttached: false });
  assert.equal(s.renderLine, 'ℹ Focal artifact(s) attached whole: `docs/plans/thing.md`.');
  assert.doesNotMatch(s.renderLine, /TRUNCATED|⚠|verbatim/);
});

test('redaction is named on the render line, never hidden behind "whole"', () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'docs', 'plans', 'leaky.md'),
    'notes\nsk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n');
  const s = summariseArtifacts(loadArtifacts(['docs/plans/leaky.md'], { repoRoot: root }), { requested: 1, policyAttached: false });
  assert.match(s.renderLine, /secret pattern\(s\) redacted from the file/);
});

test('no attachment → renderLine null (refusals render their own lines)', () => {
  const root = makeRepo();
  const s = summariseArtifacts(loadArtifacts(['.env'], { repoRoot: root }), { requested: 1, policyAttached: false });
  assert.equal(s.renderLine, null);
  assert.equal(s.refused.length, 1);
  assert.equal(formatArtifactRenderLine([]), null);
});

test('the summary describes the payload actually built: sentChars == chars of content in loaded.text', () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'docs', 'plans', 'big.md'), 'z'.repeat(ARTIFACT_MAX_TOKENS * 4 * 2));
  const loaded = loadArtifacts(['docs/plans/big.md'], { repoRoot: root });
  const a = summariseArtifacts(loaded, { requested: 1, policyAttached: false }).attached[0];
  const header = '--- docs/plans/big.md ---\n';
  const start = loaded.text.indexOf(header) + header.length;
  const end = loaded.text.indexOf('\n\n[truncated:', start);
  assert.ok(start >= header.length && end > start, 'block must carry the header and the inline marker');
  assert.equal(end - start, a.sentChars, 'render-line N must equal the chars the models received');
});

test('the envelope schema keeps renderLine and the per-artifact counts (a non-strict z.object strips undeclared keys)', () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'docs', 'plans', 'huge.md'), 'y'.repeat(ARTIFACT_MAX_TOKENS * 4 * 3));
  const s = summariseArtifacts(loadArtifacts(['docs/plans/huge.md'], { repoRoot: root }), { requested: 1, policyAttached: false });
  const sub = BrainstormEnvelopeV2Schema.shape.artifactContext;
  const parsed = sub.parse(s);
  assert.equal(parsed.renderLine, s.renderLine);
  assert.equal(parsed.attached[0].sentChars, s.attached[0].sentChars);
  assert.equal(parsed.attached[0].totalChars, s.attached[0].totalChars);
  // Back-compat: a row written before these keys existed still parses.
  assert.doesNotThrow(() => sub.parse({
    requested: 1, attached: [{ path: 'a.md', bytes: 3, truncated: false }], refused: [], policyAttached: false,
  }));
});

// ── CLI integration (hermetic: no provider key, no Azure profile → no spend) ──

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(TEST_DIR, '..');
const HELPER = path.join(REPO_ROOT, 'scripts', 'brainstorm-round.mjs');

function runRound(artifacts) {
  const out = path.join(os.tmpdir(), `brainstorm-artifact-cli-${process.pid}-${Date.now()}-${Math.random()}.json`);
  const args = ['--topic', 'x', '--models', 'openai', '--no-arch', '--no-policy', '--out', out];
  for (const a of artifacts) args.push('--with-artifact', a);
  const r = spawnSync('node', [HELPER, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: {
      ...process.env, OPENAI_API_KEY: '', GEMINI_API_KEY: '',
      AZURE_OPENAI_ENDPOINT: '', AZURE_AI_ENDPOINT: '', AZURE_OPENAI_API_KEY: '',
    },
  });
  try {
    assert.equal(r.status, 0, `helper exit ${r.status}: ${r.stderr}`);
    return { env: JSON.parse(fs.readFileSync(out, 'utf-8')), stderr: r.stderr };
  } finally {
    fs.rmSync(out, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

test('CLI: a cut artifact reaches the envelope renderLine as TRUNCATED and warns once on stderr', () => {
  const big = 'scripts/brainstorm-round.mjs'; // tracked, far over the per-artifact budget
  const small = 'LICENSE';
  const { env, stderr } = runRound([big, small]);
  assert.equal(env.providers[0].state, 'misconfigured', 'hermetic: nothing may be sent');
  const line = env.artifactContext.renderLine;
  assert.ok(line.includes(`\`${big}\` (⚠ TRUNCATED to ~`), line);
  assert.ok(line.includes(`\`${small}\` (whole)`), line);
  // Built before any provider call, so it may describe only the PROMPT — never
  // a delivery or what a model saw (audit-code R1 H1/H2): here nothing was sent.
  assert.doesNotMatch(line, /verbatim|\bsent\b|\bsaw\b|received|delivered/i);
  const warnings = stderr.split('\n').filter((l) => l.includes('artifact TRUNCATED'));
  assert.equal(warnings.length, 1, stderr);
  assert.ok(warnings[0].includes(big));

  // The write boundary requires the fields (read stays lenient): the real
  // envelope validates, and the same envelope minus renderLine / a count does not.
  assert.ok(BrainstormEnvelopeWriteSchema.safeParse(env).success, 'the emitted envelope is a valid write');
  const noLine = structuredClone(env);
  delete noLine.artifactContext.renderLine;
  assert.equal(BrainstormEnvelopeWriteSchema.safeParse(noLine).success, false, 'a writer dropping renderLine must fail');
  const noCount = structuredClone(env);
  delete noCount.artifactContext.attached[0].sentChars;
  assert.equal(BrainstormEnvelopeWriteSchema.safeParse(noCount).success, false, 'a writer dropping sentChars must fail');
});

test('CLI negative control: only a small artifact → no TRUNCATED in the line or on stderr', () => {
  const { env, stderr } = runRound(['LICENSE']);
  assert.equal(env.artifactContext.renderLine, 'ℹ Focal artifact(s) attached whole: `LICENSE`.');
  assert.doesNotMatch(stderr, /TRUNCATED/);
});
