/**
 * @fileoverview The plan-less code audit's CLI door and intent document (docs/plans/prepush-gate-consumer-feedback-theme1.md D1).
 *
 * The door is spawned, because the exit code and the stderr are the contract: every refusal is exit 2 (the hook reads 2 as "the audit
 * refused its arguments", i.e. UNMEASURED), before any store write or model call. The child env is scrubbed of every provider
 * credential and store DSN, so a run that got past the door would have nothing to spend - and the control proves the door is the
 * thing that stopped it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parsePlanlessArgs, buildIntentDocument, stampPlanless, PLANLESS_HEADER, INTENT_CAP_BYTES,
} from '../scripts/lib/audit/planless-intent.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAN = 'docs/plans/prepush-gate-consumer-feedback-theme1.md';
// A shape the gentle redactor recognises (an OpenAI-style key); assembled so this file itself carries no key-shaped literal.
const FAKE_KEY = ['sk', 'proj', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('-');

function runCli(args) {
  const env = { ...process.env, LEARNING_DISABLE: '1', MODEL_CATALOG_REFRESH: 'skip', AUDIT_DB_URL: '', AUDIT_NO_PREFLIGHT: '1' };
  // EMPTY, not deleted: the CLI loads the main worktree's .env and ~/.audit-loop.env, which fill only UNSET variables. A deleted key
  // is refilled from disk and the control below would start a real, paid audit; an empty one is the air-gap signal.
  for (const k of Object.keys(env)) if (/^(AZURE_|OPENAI_|ANTHROPIC_|GEMINI_|GOOGLE_)/.test(k)) env[k] = '';
  Object.assign(env, { OPENAI_API_KEY: '', AZURE_OPENAI_ENDPOINT: '', AZURE_OPENAI_API_KEY: '', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '' });
  return spawnSync(process.execPath, ['scripts/openai-audit.mjs', ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
}

function withIntent(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planless-'));
  const file = path.join(dir, 'intent.md');
  fs.writeFileSync(file, 'feat: add the thing\n');
  try { return fn(file, dir); } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}

describe('openai-audit --planless: refused at the door (exit 2)', () => {
  it('a positional plan AND --planless refuses: one or the other', () => withIntent((intent) => {
    const r = runCli(['code', PLAN, '--planless', intent]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /replaces the plan argument/);
  }));
  it('--planless with no value refuses', () => {
    for (const args of [['code', '--planless'], ['code', '--planless', '--scope', 'diff']]) {
      const r = runCli(args);
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, /needs an intent file/);
    }
  });
  it('a plan audit with --planless refuses: it is a code-audit mode only', () => withIntent((intent) => {
    const r = runCli(['plan', '--planless', intent]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /code-audit mode only/);
  }));
  it('--scope plan (or full) refuses: only a plan can supply plan scope', () => withIntent((intent) => {
    for (const scope of ['plan', 'full']) {
      const r = runCli(['code', '--planless', intent, '--scope', scope]);
      assert.equal(r.status, 2, `${scope}: ${r.stderr}`);
      assert.match(r.stderr, /needs --scope diff or --files/);
    }
  }));
  it('an unreadable intent file refuses, naming it', () => {
    const r = runCli(['code', '--planless', path.join(os.tmpdir(), 'no-such-intent-file-xyz.md')]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /intent file unreadable: .*no-such-intent-file-xyz\.md/);
  });
  it('control: a valid --planless passes the door and stops at the credential gate (exit 1), never the usage message', () => withIntent((intent) => {
    const r = runCli(['code', '--planless', intent, '--scope', 'diff']);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /OPENAI_API_KEY environment variable required/);
    assert.doesNotMatch(r.stderr, /--planless/);
    assert.doesNotMatch(r.stderr, /^Usage:/m);
  }));
});

describe('parsePlanlessArgs (pure)', () => {
  const read = () => `fix: rotate ${FAKE_KEY}\n`;
  it('absent flag is plan-keyed, untouched', () => {
    assert.deepEqual(parsePlanlessArgs(['code', PLAN, '--scope', 'diff'], { read }), { planless: false });
  });
  it('a positional AFTER the intent file is a plan too: refused in either order (audit B R3 M3)', () => {
    assert.match(parsePlanlessArgs(['code', '--planless', 'i.md', 'plan.md'], { read }).error, /not both/);
    assert.match(parsePlanlessArgs(['code', 'plan.md', '--planless', 'i.md'], { read }).error, /not both/);
  });
  it('the flag after other flags is accepted when no positional plan was given', () => {
    const r = parsePlanlessArgs(['code', '--scope', 'diff', '--planless', 'i.md'], { read });
    assert.equal(r.planless, true);
    assert.equal(r.intentPath, 'i.md');
  });
  it('planContent is the header plus the REDACTED intent - a secret in a message never reaches a prompt', () => {
    const r = parsePlanlessArgs(['code', '--planless', 'i.md', '--files', 'a.js'], { read });
    assert.ok(r.planContent.startsWith(PLANLESS_HEADER));
    assert.ok(!r.planContent.includes(FAKE_KEY), 'the key must be redacted');
    assert.ok(r.redacted.length > 0);
  });
  it('the header says there is no plan and forbids judging conformance and completeness', () => {
    assert.match(PLANLESS_HEADER, /no plan/i);
    assert.match(PLANLESS_HEADER, /Do NOT judge plan conformance or plan completeness/);
  });
});

describe('buildIntentDocument', () => {
  it('lists every message, oldest first, and counts them', () => {
    const d = buildIntentDocument({ messages: ['feat: one\n\nbody one', 'fix: two'] });
    assert.equal(d.count, 2);
    assert.ok(d.text.indexOf('feat: one') < d.text.indexOf('fix: two'));
    assert.match(d.text, /Commit 1 of 2/);
  });
  it('a secret in a message is redacted', () => {
    const d = buildIntentDocument({ messages: [`chore: token ${FAKE_KEY}`] });
    assert.ok(!d.text.includes(FAKE_KEY));
    assert.ok(d.redacted.length > 0);
  });
  it('is capped at 8 KB (UTF-8 bytes), never splitting a character', () => {
    const d = buildIntentDocument({ messages: Array.from({ length: 400 }, (_, i) => `feat: message ${i} with ünïcödé ${'x'.repeat(40)}`) });
    assert.ok(Buffer.byteLength(d.text, 'utf8') <= INTENT_CAP_BYTES, `${Buffer.byteLength(d.text, 'utf8')} bytes`);
    assert.match(d.text, /intent truncated at the 8 KB cap/);
    assert.ok(!d.text.includes('�'), 'no replacement character from a split code point');
  });
  it('an empty message set produces a document that SAYS it is empty', () => {
    for (const messages of [[], ['', '   '], undefined]) {
      const d = buildIntentDocument({ messages });
      assert.equal(d.count, 0);
      assert.match(d.text, /carries no commit messages, so the stated intent is empty/);
    }
  });
});

describe('stampPlanless', () => {
  it('marks a plan-less result and leaves a plan-keyed one untouched', () => {
    const r = { verdict: 'PASS', findings: [] };
    assert.deepEqual(stampPlanless(r, { planless: true }), { verdict: 'PASS', findings: [], planless: true });
    assert.equal(stampPlanless(r, { planless: false }), r);
    assert.equal(stampPlanless(r, {}), r);
    assert.equal('planless' in r, false, 'the input is not mutated');
  });
});
