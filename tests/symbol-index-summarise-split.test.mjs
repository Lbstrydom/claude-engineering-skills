/**
 * Truncated / short batches are re-asked in halves, down to size 1.
 *
 * Measured 2026-11-22: a full `arch:refresh` left 410 of 7533 symbols with no
 * summary (55/151 batches INCOMPLETE), so those symbols got no embedding and
 * read `unscored` in get-neighbourhood. Two layers here: the pure recursion
 * (`summariseWithSplit`, stub provider) and the real CLI end to end (fake
 * `claude` that truncates any request above size K).
 *
 * @module tests/symbol-index-summarise-split
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as summarise from '../scripts/symbol-index/summarise.mjs';

const { summariseWithSplit } = summarise;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUMMARISE = path.join(REPO_ROOT, 'scripts', 'symbol-index', 'summarise.mjs');

const mk = (n) => Array.from({ length: n }, (_, i) => ({ symbolName: `s${i + 1}` }));
const budgetFor = (n) => ({ remaining: 2 * n, calls: 0, splits: 0 });

/** Stub provider: truncates (stop max_tokens, tail cut) any call above size k; `bad` symbols never come back. */
function stub({ k, bad = new Set(), alwaysTruncate = false }) {
  const calls = [];
  const once = async (b) => {
    calls.push(b.length);
    const summaries = b.map(s => (bad.has(s.symbolName) ? null : `sum ${s.symbolName}`));
    const over = b.length > k || alwaysTruncate;
    if (over) {
      const keep = alwaysTruncate ? 0 : Math.max(0, k - 1);
      for (let i = keep; i < summaries.length; i++) summaries[i] = null;
    }
    const missing = summaries.map((s, i) => (s ? 0 : i + 1)).filter(Boolean);
    return { summaries, health: { complete: !missing.length && !over, missing, truncated: over } };
  };
  return { once, calls };
}

describe('summariseWithSplit', () => {
  it('every symbol ends summarised when batches above size k truncate', async () => {
    const { once, calls } = stub({ k: 4 });
    const res = await summariseWithSplit(mk(50), once, budgetFor(50));
    assert.deepEqual(res.map(r => r.summary), mk(50).map(s => `sum ${s.symbolName}`), 'each symbol keeps ITS OWN summary');
    assert.ok(calls.length > 1);
  });

  it('a symbol that always fails ends unsummarised with a reason; no fake summary', async () => {
    const { once } = stub({ k: 100, bad: new Set(['s3']) });
    const res = await summariseWithSplit(mk(5), once, budgetFor(5));
    assert.equal(res[2].summary, null);
    assert.match(res[2].reason, /even at batch size 1/);
    assert.equal(res.filter(r => r.summary).length, 4);
  });

  it('a thrown provider error is not split (a smaller request cannot fix it)', async () => {
    let n = 0;
    const once = async (b) => {
      n++;
      return { summaries: b.map(() => null), health: { complete: false, missing: [], truncated: false }, error: 'boom' };
    };
    const res = await summariseWithSplit(mk(8), once, budgetFor(8));
    assert.equal(n, 1);
    assert.match(res[0].reason, /provider error: boom/);
  });

  it('the retry bound holds: <= 2n calls even when every call truncates', async () => {
    for (const n of [1, 2, 7, 50]) {
      const { once, calls } = stub({ k: 0, alwaysTruncate: true });
      const res = await summariseWithSplit(mk(n), once, budgetFor(n));
      assert.ok(calls.length <= 2 * n, `n=${n}: ${calls.length} calls`);
      assert.equal(res.filter(r => r.summary).length, 0, 'nothing is back-filled');
      assert.ok(res.every(r => typeof r.reason === 'string' && r.reason));
    }
  });

  it('an exhausted budget stops retrying and says so', async () => {
    const { once, calls } = stub({ k: 0, alwaysTruncate: true });
    const res = await summariseWithSplit(mk(16), once, { remaining: 2, calls: 0, splits: 0 });
    assert.ok(calls.length <= 3);
    assert.ok(res.some(r => /retry budget exhausted/.test(r.reason)));
  });

  it('the last entry of a max_tokens response is re-asked, not trusted', async () => {
    const once = async (b) => (b.length === 2
      ? { summaries: ['first', 'cut mid-sen'], health: { complete: false, missing: [], truncated: true } }
      : { summaries: ['second full'], health: { complete: true, missing: [], truncated: false } });
    const res = await summariseWithSplit(mk(2), once, budgetFor(2));
    assert.deepEqual(res.map(r => r.summary), ['first', 'second full']);
  });
});

describe('summarise CLI: truncation above size K is recovered end to end', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'summarise-split-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  function fakeClaude(k) {
    const js = path.join(tmpDir, 'fake.mjs');
    fs.writeFileSync(js, [
      "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{",
      "  const n=Number((d.match(/these (\\d+) symbols/)||[])[1]);",
      "  const names=[...d.matchAll(/^\\d+\\. \\w+ `(\\w+)`/gm)].map(m=>m[1]);",
      `  const over=n>${k};`,
      `  const keep=over?${k}-1:n;`,
      "  const result=names.slice(0,keep).map((s,i)=>(i+1)+'. summary of '+s).join('\\n');",
      "  process.stdout.write(JSON.stringify({result,stop_reason:over?'max_tokens':'end_turn',usage:{input_tokens:1,output_tokens:1},total_cost_usd:0,num_turns:1}));",
      '});',
    ].join('\n'));
    if (process.platform === 'win32') {
      const cmd = path.join(tmpDir, 'fake.cmd');
      fs.writeFileSync(cmd, `@echo off\r\nnode "${js}" %*\r\n`);
      return cmd;
    }
    const sh = path.join(tmpDir, 'fake.sh');
    fs.writeFileSync(sh, `#!/bin/sh\nexec node "${js}" "$@"\n`, { mode: 0o755 });
    return sh;
  }

  it('summarises all 12 symbols although every request above size 3 truncates', () => {
    const N = 12;
    const input = Array.from({ length: N }, (_, i) => JSON.stringify({
      type: 'symbol', symbolName: `sym${i + 1}`, kind: 'function', filePath: `src/m${i + 1}.mjs`,
      startLine: 1, endLine: 2, bodyText: `function sym${i + 1}(){}`,
    })).join('\n') + '\n';
    const r = spawnSync(process.execPath, [SUMMARISE], {
      cwd: REPO_ROOT, input, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL',
      env: {
        ...process.env, CLAUDE_BACKEND: 'cli', CLAUDE_BIN: fakeClaude(3), ANTHROPIC_API_KEY: '',
        AZURE_OPENAI_ENDPOINT: '', ARCH_INDEX_BATCH_SIZE: String(N), LEARNING_DISABLE: '1',
        AUDIT_DB_URL: '', MODEL_CATALOG_REFRESH: 'skip',
      },
    });
    assert.equal(r.status, 0, (r.stderr || '').slice(0, 500));
    const recs = r.stdout.trim().split('\n').map(l => JSON.parse(l));
    const syms = recs.filter(x => x.type === 'symbol');
    const sum = recs.find(x => x.type === 'summary');
    assert.equal(syms.length, N);
    assert.deepEqual(syms.map(s => s.purposeSummary), syms.map(s => `summary of ${s.symbolName}`));
    assert.equal(sum.counts.summarised, N);
    assert.equal(sum.complete, true);
    assert.equal(sum.counts.incompleteBatches, 1, 'the first attempt is still reported');
    assert.ok(sum.counts.splitCalls > 0);
  });
});
