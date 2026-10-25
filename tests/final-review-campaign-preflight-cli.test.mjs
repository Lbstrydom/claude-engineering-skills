/**
 * @fileoverview A campaign-unsafe shadow scope is refused BEFORE any provider
 * work — the primary review included.
 *
 * The refusal used to live only inside `runShadowAndPersist`, which `main()`
 * reaches after building the primary client and AWAITING the primary review:
 * the arm was billed for a result it then threw away, contradicting the plan's
 * own test ("exit non-zero before any client is constructed").
 *
 * Spawns the REAL CLI with `--provider fixture` (NODE_ENV=test): the fixture
 * path does no provider work at all, so it is the strictest observable proxy —
 * if even the fixture review runs, a real review would have run and billed.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const GEMINI_REVIEW = path.join(REPO_ROOT, 'scripts', 'gemini-review.mjs');

describe('gemini-review.mjs — campaign scope refusal precedes the primary review', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'final-review-campaign-'));
    fs.writeFileSync(path.join(dir, 'plan.md'), '# plan\n');
    fs.writeFileSync(path.join(dir, 't.json'), JSON.stringify({ changed_files: ['src/a.mjs'], rounds: [] }));
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ } });

  const review = (extra) => spawnSync(process.execPath, [
    GEMINI_REVIEW, 'review', path.join(dir, 'plan.md'), path.join(dir, 't.json'), '--provider', 'fixture', ...extra,
  ], {
    cwd: REPO_ROOT, encoding: 'utf-8',
    env: { ...process.env, NODE_ENV: 'test', AUDIT_DB_URL: '', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '', FINAL_REVIEW_SHADOW_SCOPE: '' },
  });

  it('gap under --campaign-digest exits non-zero and NO review is produced', () => {
    const out = path.join(dir, 'r.json');
    const r = review(['--envelope-scope', 'gap', '--campaign-digest', 'abc123', '--out', out]);
    assert.notEqual(r.status, 0, `must refuse; stdout=${r.stdout}`);
    assert.match(r.stderr, /campaign-ineligible/);
    assert.equal(fs.existsSync(out), false, 'the primary review must not have run');
  });

  it('an invalid scope under --campaign-digest exits non-zero before the review', () => {
    const out = path.join(dir, 'r.json');
    const r = review(['--envelope-scope', 'nonsense', '--campaign-digest', 'abc123', '--out', out]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /invalid --envelope-scope "nonsense"/);
    assert.equal(fs.existsSync(out), false);
  });

  it('NEGATIVE CONTROL: a valid scope under a campaign runs the review', () => {
    const out = path.join(dir, 'r.json');
    const r = review(['--envelope-scope', 'thin', '--campaign-digest', 'abc123', '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(out), true);
  });
});
