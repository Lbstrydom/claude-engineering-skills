/**
 * Tier 3 (a): judge payloads are a provider-egress path (plan
 * docs/plans/seeded-defect-benchmark.md §5). Every assertion is on the EMITTED
 * request body, captured at the client the real adapter calls
 * (`messages.create` for Claude, `models.generateContent` for Gemini), never on
 * config. Nothing reaches a provider.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createJudge, judgePairs, prepareJudgePayload } from '../scripts/lib/model-eval/concern-matcher.mjs';

// Built at runtime so this file never contains a secret-shaped literal.
const SECRET = `sk-${'A1b2C3d4'.repeat(4)}`;
const KEY_BODY = 'KEYMATERIAL_must_never_leave_0042';

function fakeClaude(captured) {
  return {
    messages: {
      create: async (body) => {
        captured.push(JSON.stringify(body));
        return { content: [{ type: 'tool_use', name: 'judge_pair', input: { verdict: 'different', quote: '' } }] };
      },
    },
  };
}
function fakeGemini(captured) {
  return {
    models: {
      generateContent: async (body) => {
        captured.push(JSON.stringify(body));
        return { text: JSON.stringify({ verdict: 'different', quote: '' }), usageMetadata: {} };
      },
    },
  };
}

const f = (over = {}) => ({ id: 'F1', file: 'src/a.js', lines: 10, severity: 'HIGH', text: 'the retry loop never backs off', ...over });
const x = (over = {}) => ({ id: 'X1', file: 'src/a.js', lines: 12, severity: 'HIGH', text: 'retry without backoff', ...over });

async function runBoth(pairs, opts = {}) {
  const sent = { claude: [], gemini: [] };
  const claude = await createJudge({ deps: { anthropicClient: fakeClaude(sent.claude) } });
  const gemini = await createJudge({ sentinel: 'latest-pro', deps: { geminiClient: fakeGemini(sent.gemini) } });
  const rc = await judgePairs({ pairs, judge: claude, ...opts });
  const rg = await judgePairs({ pairs, judge: gemini, ...opts });
  return { sent, rc, rg };
}

test('control: a clean pair is actually sent by both judges (the interception sees real requests)', async () => {
  const { sent, rc, rg } = await runBoth([{ f: f(), x: x() }]);
  assert.equal(sent.claude.length, 1);
  assert.equal(sent.gemini.length, 1);
  assert.match(sent.claude[0], /retry loop never backs off/);
  assert.match(sent.gemini[0], /retry loop never backs off/);
  assert.equal(rc.results[0].verdict, 'different');
  assert.equal(rg.results[0].verdict, 'different');
});

test('a secret-shaped string is redacted before it leaves, in finding, entry and cited code', async () => {
  const pair = {
    f: f({ text: `fix the key ${SECRET} that is hardcoded`, code: [{ path: 'src/a.js', text: `const k = "${SECRET}";` }] }),
    x: x({ text: `key ${SECRET} committed` }),
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-root-'));
  fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src/a.js'), 'x');
  try {
    const { sent, rc, rg } = await runBoth([pair], { repoRoot: root });
    assert.equal(sent.claude.length, 1, 'the Claude judge sent a request'); assert.equal(sent.gemini.length, 1, 'the Gemini judge sent a request');
    assert.notEqual(rg.results[0].verdict, 'not-judged', 'the Gemini path was exercised end to end');
    for (const body of [...sent.claude, ...sent.gemini]) {
      assert.ok(!body.includes(SECRET), 'secret reached the request body');
      assert.match(body, /REDACTED:/);
    }
    assert.ok(rc.results[0].redactedCount >= 3, `redacted ${rc.results[0].redactedCount}`);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});

test('cited code is dropped when there is NO trusted repoRoot to realpath-check it against (fail closed)', async () => {
  const pair = { f: f({ text: 'plain text', code: [{ path: 'src/a.js', text: 'CODE-BODY-MARKER' }] }), x: x() };
  const { sent, rc } = await runBoth([pair]);
  for (const body of [...sent.claude, ...sent.gemini]) assert.ok(!body.includes('CODE-BODY-MARKER'), 'unchecked code left');
  assert.equal(rc.results[0].droppedCode, 1);
});

test('a sensitive path mention fails to leave and the pair is not-judged', async () => {
  const { sent, rc, rg } = await runBoth([
    { f: f({ id: 'F1', text: 'secrets are read from .env.production at boot' }), x: x() },
    { f: f({ id: 'F2' }), x: x({ id: 'X2', text: 'see .ssh/id_rsa handling' }) },
    { f: f({ id: 'F3', file: '.env' }), x: x({ id: 'X3' }) },
  ]);
  for (const body of [...sent.claude, ...sent.gemini]) {
    assert.ok(!/\.env\.production|id_rsa/.test(body), 'sensitive path mention reached the request body');
  }
  assert.equal(sent.claude.length, 0, 'no request was even built');
  assert.equal(sent.gemini.length, 0);
  for (const r of [...rc.results, ...rg.results]) {
    assert.equal(r.verdict, 'not-judged');
    assert.match(r.reason, /sensitive/);
  }
});

// A real symlink where the OS allows one; otherwise the same resolveAndClassify
// path is driven through an injected fs (so this test never goes green unchecked).
function makeRepoWithSymlink() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-egress-'));
  fs.mkdirSync(path.join(root, 'secrets'));
  fs.writeFileSync(path.join(root, 'secrets', 'key.txt'), KEY_BODY);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'ok');
  let injected = null;
  try {
    fs.symlinkSync(path.join(root, 'secrets', 'key.txt'), path.join(root, 'notes.txt'));
  } catch {
    const real = fs.realpathSync(root);
    injected = {
      ...fs,
      lstatSync: (p) => (String(p).endsWith('notes.txt') ? {} : fs.lstatSync(p)),
      realpathSync: (p) => (String(p).endsWith('notes.txt') ? path.join(real, 'secrets', 'key.txt') : fs.realpathSync(p)),
    };
  }
  return { root, fs: injected, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) };
}

test('a symlinked sensitive file fails to leave: as the finding\'s file => not-judged; as cited code => dropped and counted', async () => {
  const repo = makeRepoWithSymlink();
  try {
    const opts = { repoRoot: repo.root, ...(repo.fs ? { fs: repo.fs } : {}) };
    const { sent, rc, rg } = await runBoth([
      { f: f({ id: 'F1', file: 'notes.txt' }), x: x() },
      { f: f({ id: 'F2', code: [{ path: 'notes.txt', text: KEY_BODY }, { path: 'src/a.js', text: 'ok_line()' }] }), x: x({ id: 'X2' }) },
    ], opts);
    for (const body of [...sent.claude, ...sent.gemini]) assert.ok(!body.includes(KEY_BODY), 'sensitive file body reached the request');
    const byF = (r) => Object.fromEntries(r.results.map((p) => [p.fId, p]));
    for (const r of [byF(rc), byF(rg)]) {
      assert.equal(r.F1.verdict, 'not-judged');
      assert.equal(r.F1.reason, 'sensitive-file');
      assert.equal(r.F2.verdict, 'different', 'the pair is still judged, without the dropped code');
      assert.equal(r.F2.droppedCode, 1);
    }
    assert.equal(sent.claude.length, 1, 'only the F2 request was built');
    assert.match(sent.claude[0], /ok_line/);
  } finally { repo.cleanup(); }
});

test('cited code that cannot be resolved is dropped (fail closed), not sent', () => {
  const p = prepareJudgePayload({ f: f({ code: [{ path: 'does/not/exist.js', text: 'LEAK_IF_SENT' }] }), x: x() }, { repoRoot: os.tmpdir() });
  assert.equal(p.ok, true);
  assert.equal(p.droppedCode, 1);
  assert.ok(!p.user.includes('LEAK_IF_SENT'));
});

test('a field carrying the redaction-failure marker fails closed to not-judged', async () => {
  const pair = { f: f({ text: 'harmless' }), x: x() };
  // A text the redactor cannot process: force it with a poisoned toString on a non-string field.
  pair.f.severity = { toString() { return '[REDACTED:redaction-failed]'; } };
  const sent = [];
  const judge = await createJudge({ deps: { anthropicClient: fakeClaude(sent) } });
  const r = await judgePairs({ pairs: [pair], judge });
  assert.equal(r.results[0].verdict, 'not-judged');
  assert.equal(sent.length, 0);
});
