/**
 * The cost checklist reaches the prompts the legacy audit passes actually send
 * (docs/plans/performance-checklist-and-step-timings.md §Change 1).
 *
 * Three paths: the seed (`PASS_PROMPTS`), the R2+ rubric constants, and the R1
 * registry read (`getPassPrompt`) in an isolated cwd — fresh, advanced from an
 * older bootstrap seed, and preserved when hand-promoted. Negative control: the
 * same predicate finds every item missing from a pass that does not carry it.
 * The size label lives in `detail`, which the EMITTED response schema carries.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  PASS_PROMPTS, PASS_BACKEND_RUBRIC, PASS_FRONTEND_RUBRIC, COST_CHECKLIST,
} from '../scripts/lib/prompt-seeds.mjs';
import { ProducerFindingSchema } from '../scripts/lib/schemas.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** One distinctive phrase per checklist item (C1–C8, L1–L4, K, the size label). */
const ITEM_MARKERS = Object.freeze([
  'faster than linear with input',
  'repeated every request, render, rerun or remount',
  'independent I/O awaited in series',
  'a statement prepared or a client built per item; N+1 queries',
  'a failure neither cached nor backed off',
  'input with no size limit; extract-then-truncate; a result cap that truncates silently',
  'nested timeouts equal or inverted',
  'a cancel signal no handler reads',
  'one shared row or pointer every concurrent write must update',
  'a fixed output-token cap or thinking budget not sized to the input',
  'no stop_reason',
  'a model call that can repeat',
  'no prompt cache on a repeated prefix',
  'model egress not paced to the rate limit',
  'every input in the key',
  'memory bounded',
  'shared state published only once it is decided',
  'Expected cost:',
]);

const missingItems = (text) => ITEM_MARKERS.filter((m) => !text.includes(m));

describe('cost checklist — seed and R2+ rubrics', () => {
  for (const [name, text] of Object.entries({
    'PASS_PROMPTS.backend': PASS_PROMPTS.backend,
    'PASS_PROMPTS.frontend': PASS_PROMPTS.frontend,
    PASS_BACKEND_RUBRIC,
    PASS_FRONTEND_RUBRIC,
  })) {
    it(`${name} carries every item`, () => {
      assert.deepEqual(missingItems(text), []);
    });
  }

  it('negative control: the predicate sees every item missing from the sustainability pass', () => {
    assert.deepEqual(missingItems(PASS_PROMPTS.sustainability), ITEM_MARKERS);
  });

  it('has ONE home: the block appears exactly once per pass, and nowhere else in PASS_PROMPTS', () => {
    for (const [pass, text] of Object.entries(PASS_PROMPTS)) {
      const n = text.split(COST_CHECKLIST).length - 1;
      assert.equal(n, (pass === 'backend' || pass === 'frontend') ? 1 : 0, pass);
    }
  });

  it('the size label names an estimate, never a measurement', () => {
    assert.match(COST_CHECKLIST, /"Expected cost: <estimate> at <input size>" — an estimate from the code, never a measurement/);
  });
});

describe('cost checklist — the emitted response schema can hold the size label', () => {
  it('`detail` is a required string in z.toJSONSchema(ProducerFindingSchema)', () => {
    const js = z.toJSONSchema(ProducerFindingSchema);
    assert.equal(js.properties.detail.type, 'string');
    assert.ok(js.required.includes('detail'));
    assert.ok(js.properties.detail.maxLength >= 200, 'room for the label plus the finding');
  });
});

describe('cost checklist — the R1 registry read (getPassPrompt) in an isolated cwd', () => {
  const helpers = pathToFileURL(path.join(ROOT, 'scripts/lib/audit/llm-helpers.mjs')).href;
  const registry = pathToFileURL(path.join(ROOT, 'scripts/lib/prompt-registry.mjs')).href;

  function runIn(cwd, script) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, AUDIT_DB_URL: '', LEARNING_DISABLE: '1', OPENAI_API_KEY: 'test-not-used' },
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  }
  const readBackend = `const m = await import(${JSON.stringify(helpers)});
    const p = m.getPassPrompt('backend');
    process.stdout.write(JSON.stringify({ has: p.includes('faster than linear with input'), len: p.length }) + '\\n');`;
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cost-checklist-'));

  it('a fresh registry serves the new seed', () => {
    const cwd = tmp();
    try { assert.equal(runIn(cwd, readBackend).has, true); } finally { fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('an older BOOTSTRAP seed is advanced to the new one', () => {
    const cwd = tmp();
    try {
      runIn(cwd, `const r = await import(${JSON.stringify(registry)});
        const old = 'old backend seed without the checklist';
        const id = r.revisionId(old);
        r.saveRevision('backend', id, old, { source: 'bootstrap', createdAt: 1 });
        r.promoteRevision('backend', id);
        process.stdout.write('{}\\n');`);
      assert.equal(runIn(cwd, readBackend).has, true);
    } finally { fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('a hand-promoted revision is PRESERVED (R1 keeps it; R2+ still reads the rubric constant)', () => {
    const cwd = tmp();
    try {
      runIn(cwd, `const r = await import(${JSON.stringify(registry)});
        const mine = 'hand-tuned backend prompt';
        const id = r.revisionId(mine);
        r.saveRevision('backend', id, mine, { source: 'manual', createdAt: 1 });
        r.promoteRevision('backend', id);
        process.stdout.write('{}\\n');`);
      const got = runIn(cwd, readBackend);
      assert.equal(got.has, false);
      assert.equal(got.len, 'hand-tuned backend prompt'.length);
    } finally { fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

describe('plan-audit efficiency rule names the same classes', () => {
  it('openai-audit.mjs PLAN_AUDIT_SYSTEM rule 4 is extended, not duplicated', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/openai-audit.mjs'), 'utf8');
    const rule = src.slice(src.indexOf('4. Check code efficiency'), src.indexOf('5. For frontend plans'));
    for (const m of ['superlinear in input', 'repeated per request/render/remount', 'unbounded input',
      'nested timeouts equal or inverted', 'LLM output cap not sized to its input', 'measured percentile times a stated factor']) {
      assert.ok(rule.includes(m), m);
    }
    assert.equal(src.split('Check code efficiency').length - 1, 1);
  });
});
