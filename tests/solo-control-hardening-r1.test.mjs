/**
 * docs/plans/solo-control-hardening.md — follow-ups the first /audit-code round raised against the hardening itself. Same
 * conventions as solo-control-hardening.test.mjs: a negative control per guard; CLI cases run in a TEMP cwd with inert keys.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseCsv } from '../scripts/lib/solo-control/csv.mjs';
import { budgetVerdict, sheetPairingProblems, rowSig, judgeResumeIdentity, findingsDigest } from '../scripts/lib/solo-control/hardening-guards.mjs';
import { runGptJudgeBatch } from '../scripts/lib/solo-control/judge.mjs';
import { _internals as soloCtl } from '../scripts/solo-control-audit.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const HEAD = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

function inTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-hardening-r1-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}
function cli(cwd, args, extraEnv = {}) {
  const env = {
    ...process.env, OPENAI_API_KEY: 'scrubbed', ANTHROPIC_API_KEY: 'scrubbed', GEMINI_API_KEY: 'scrubbed', DEEPSEEK_API_KEY: 'scrubbed',
    OPENROUTER_API_KEY: 'scrubbed', CLAUDE_BACKEND: 'sdk', SOLO_CONTROL_REPO_ROOTS: REPO_ROOT, MODEL_CATALOG_REFRESH: 'skip', ...extraEnv,
  };
  const r = spawnSync('node', [path.join(REPO_ROOT, 'scripts/solo-control-audit.mjs'), ...args], { cwd, encoding: 'utf8', env });
  return { out: `${r.stdout || ''}${r.stderr || ''}`, status: r.status };
}
const refusingPolicy = (dir) => {
  const p = path.join(dir, 'policy.json');
  fs.writeFileSync(p, JSON.stringify({ version: 2, repos: { 'github.com/nobody/else': ['openai', 'gemini', 'openrouter', 'anthropic'] } }));
  return { SOLO_CONTROL_RECIPIENT_POLICY_PATH: p };
};

describe('csv strictness', () => {
  test('text after a closing quote is a corrupt cell, not a silently merged one', () => {
    assert.throws(() => parseCsv('id,"a"b\n'), /after a closing quote/);
    assert.throws(() => parseCsv('"a"junk,b'), /after a closing quote/);
  });
  test('negative control: a quote closing at a comma, a line end or EOF is fine', () => {
    assert.deepEqual(parseCsv('"a","b"\r\n"c"'), [['a', 'b'], ['c']]);
  });
});

describe('budget compares unrounded', () => {
  test('a sub-0.0001 overage is a breach (the 4-decimal round let it through)', () => {
    const rows = [{ callId: 'a', costUsd: 350.00004, state: 'ok', usage: { input_tokens: 1 } }];
    assert.equal(budgetVerdict(rows, 350.00002).reason, 'ceiling');
  });
  test('negative control: just under the cap is not a breach', () => {
    assert.equal(budgetVerdict([{ callId: 'a', costUsd: 349.99996, state: 'ok', usage: { input_tokens: 1 } }], 350), null);
  });
});

describe('cold pass retry and usage honesty', () => {
  const diff = 'diff --git a/x b/x\n+1\n';
  const ok = { content: [{ type: 'text', text: '{"findings":[],"summary":"s"}' }] };
  test('a permanent 4xx (401) is attempted ONCE, a 503 twice', async () => {
    let n = 0;
    await soloCtl.runPass({ messages: { create: async () => { n++; throw Object.assign(new Error('401'), { status: 401 }); } } }, 'claude-x', 'structure', diff);
    assert.equal(n, 1);
    n = 0;
    await soloCtl.runPass({ messages: { create: async () => { n++; throw Object.assign(new Error('503'), { status: 503 }); } } }, 'claude-x', 'structure', diff);
    assert.equal(n, 2);
  });
  test('a reply that reported no usage makes the cell usage null (unmeasured), not a low price', async () => {
    const r = await soloCtl.runPass({ messages: { create: async () => ok } }, 'claude-x', 'structure', diff);
    assert.equal(r.usage, null);
  });
  test('negative control: a reply with usage keeps it', async () => {
    const r = await soloCtl.runPass({ messages: { create: async () => ({ ...ok, usage: { input_tokens: 3, output_tokens: 1 } }) } }, 'claude-x', 'structure', diff);
    assert.deepEqual(r.usage, { input_tokens: 3, output_tokens: 1 });
  });
});

describe('pairing binds file+detail; judge sidecar binds its CSV', () => {
  const map = { F001: { commit: 'abc12345def', severity: 'HIGH', category: 'k', sig: rowSig('f.mjs', 'the detail') } };
  const row = (over = {}) => ({ blindId: 'F001', commit: 'abc12345', severity: 'HIGH', category: 'k', file: 'f.mjs', detail: 'the detail', ...over });
  test('same id/commit/severity/category but a different finding is a different merge', () => {
    assert.match(sheetPairingProblems(map, [row({ detail: 'another finding' })]).join(), /different merges/);
    assert.match(sheetPairingProblems(map, [row({ file: 'g.mjs' })]).join(), /different merges/);
  });
  test('negative control: identical content, even with CRLF line endings, is paired; a legacy map with no sig is not penalised', () => {
    assert.deepEqual(sheetPairingProblems(map, [row()]), []);
    assert.equal(rowSig('f', 'a\nb'), rowSig('f', 'a\r\nb'));
    assert.deepEqual(sheetPairingProblems({ F001: { commit: 'abc12345def', severity: 'HIGH', category: 'k' } }, [row({ detail: 'x' })]), []);
  });
  test('judgeResumeIdentity: a CSV the sidecar does not describe (interrupted checkpoint) is not trusted', () => {
    const cur = { model: 'm', knownDefectsSha256: 'h', outSha256: 'new' };
    assert.equal(judgeResumeIdentity({ model: 'm', knownDefectsSha256: 'h', outSha256: 'old' }, cur).ok, false);
    assert.deepEqual(judgeResumeIdentity({ ...cur }, cur), { ok: true });
  });
  test('runGptJudgeBatch: no structured output is a failed batch, never an empty grading list', async () => {
    const client = { responses: { parse: async () => ({ output_parsed: null }) } };
    await assert.rejects(() => runGptJudgeBatch(client, () => ({}), 'gpt-x', { shortSha: 'abc', diff: 'd', kdBlock: '', rowsBatch: [], reasoning: null }), /no structured output/);
  });
});

describe('extraction uses literal pathspecs', () => {
  test('a file named [.]env (clean) does not pull in .env (sensitive) through git pathspec globbing', () => inTemp((dir) => {
    const g = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET_THING=hunter2hunter2\n');
    fs.writeFileSync(path.join(dir, '[.]env'), 'harmless\n');
    g('add', '-A'); g('commit', '-q', '-m', 'x');
    const ext = soloCtl.extractDiff(dir, g('rev-parse', 'HEAD').stdout.trim());
    assert.ok(ext.files.includes('[.]env'), 'the clean file is audited');
    assert.ok(!ext.diff.includes('hunter2'), 'the sensitive file never reaches the diff');
    assert.ok(!ext.files.includes('.env'));
  }));
});

describe('CLI: --label is a filename', () => {
  test('a parent-directory segment is refused, nothing is written outside the output dir', () => inTemp((dir) => {
    const r = cli(dir, ['run', '--commits', HEAD, '--label', '../escape'], refusingPolicy(dir));
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /invalid arm label/);
    assert.ok(!fs.existsSync(path.join(dir, '.audit-loop/escape.json')));
  }));
});

describe('CLI apparatus --gate-only: an incomplete pre-gate artifact is refused', () => {
  const artifact = (over) => {
    const gateContext = 'diff --git a/x b/x\n+1\n';
    return { sha: HEAD, repo: 'r', files: ['x'], findings: [], passChunks: 1, findingsSha256: findingsDigest([]), gptModel: 'gpt-5.6-terra', generationFailedCells: 0, gateContext, gateContextScope: 'full', gateContextSha256: createHash('sha256').update(gateContext).digest('hex'), ...over };
  };
  const run = (dir, over) => {
    const out = path.join(dir, '.audit-loop/solo-control'); fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, `S-pregate-A-${HEAD}.json`), JSON.stringify(artifact(over)));
    return cli(dir, ['apparatus', '--commits', HEAD, '--gate-only', '--label', 'A-test'], refusingPolicy(dir));
  };
  test('generation passes that never replied => not reusable', () => inTemp((dir) => {
    const r = run(dir, { generationFailedCells: 2 });
    assert.match(r.out, /not reusable.*2 generation pass/s, r.out);
    assert.doesNotMatch(r.out, /POLICY REFUSED/, 'refused before any later stage');
  }));
  test('a different generator model => not reusable', () => inTemp((dir) => {
    assert.match(run(dir, { gptModel: 'gpt-other' }).out, /not reusable.*generated by gpt-other/s);
  }));
  test('negative control: a complete artifact passes the artifact checks and reaches the policy stage', () => inTemp((dir) => {
    assert.match(run(dir, {}).out, /POLICY REFUSED/);
  }));
});

describe('extracted modules: every relative dynamic import resolves (a moved file silently kept ./lib/ paths)', () => {
  for (const f of ['gate-reviews.mjs', 'cold-pass-support.mjs', 'judge.mjs']) {
    test(f, () => {
      const file = path.join(REPO_ROOT, 'scripts/lib/solo-control', f);
      const specs = [...fs.readFileSync(file, 'utf8').matchAll(/import\(\s*'(\.[^']+)'\s*\)/g)].map((m) => m[1]);
      for (const s of specs) assert.ok(fs.existsSync(path.resolve(path.dirname(file), s)), `${f}: ${s} does not resolve`);
    });
  }
  test('vacuous-pass guard: gate-reviews has relative dynamic imports to check', () => {
    assert.ok(/import\(\s*'\.\.\/schemas\.mjs'\s*\)/.test(fs.readFileSync(path.join(REPO_ROOT, 'scripts/lib/solo-control/gate-reviews.mjs'), 'utf8')));
  });
});

describe('round 2 follow-ups', () => {
  test('a 408 is attempted once too: the project rule retries no 4xx except 429', async () => {
    const mk = (status) => { let n = 0; return { get n() { return n; }, client: { messages: { create: async () => { n++; throw Object.assign(new Error(String(status)), { status }); } } } }; };
    const a = mk(408); await soloCtl.runPass(a.client, 'claude-x', 'structure', 'diff --git a/x b/x\n+1\n');
    const b = mk(429); await soloCtl.runPass(b.client, 'claude-x', 'structure', 'diff --git a/x b/x\n+1\n');
    assert.equal(a.n, 1);
    assert.equal(b.n, 2, 'negative control: 429 is still retried');
  });
  test('judge-gpt: an ungraded row carries NO label from the source sheet into the GPT output', () => inTemp((dir) => {
    const out = path.join(dir, '.audit-loop/solo-control'); fs.mkdirSync(out, { recursive: true });
    const head = 'blind_id,commit,severity,category,file,detail,label,proof,cluster,matches,pattern';
    fs.writeFileSync(path.join(out, 'blind-adjudication.csv'), `${head}\nF001,${HEAD.slice(0, 8)},HIGH,k,f,d,proven,f:1,c1,KD-1,pat\n`);
    cli(dir, ['judge-gpt'], refusingPolicy(dir)); // policy-refused: the row is never graded
    const [, row] = parseCsv(fs.readFileSync(path.join(out, 'blind-adjudication-gpt.csv'), 'utf8'));
    assert.deepEqual([row[6], row[7], row[10]], ['', '', ''], 'label/proof/pattern cleared');
    assert.deepEqual([row[8], row[9]], ['c1', 'KD-1'], 'the pre-filled cluster and KD hint stay');
  }));
});

describe('round 3 follow-ups', () => {
  test('a quote inside an unquoted field is corrupt (it silently split a record before)', () => {
    assert.throws(() => parseCsv('prefix"line1\nline2",proven\n'), /unquoted field/);
  });
  test('negative control: a doubled quote INSIDE a quoted field and a quoted-first field still parse', () => {
    assert.deepEqual(parseCsv('"a ""b"" c",plain\n'), [['a "b" c', 'plain']]);
  });
});
