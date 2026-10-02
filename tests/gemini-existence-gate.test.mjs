/**
 * @fileoverview The final reviewer's existence-claim gate.
 *
 * `verifyExistenceFindings` ran only inside the GPT audit path
 * (legacy-production-audit.mjs) — `gemini-review.mjs` had no reference to it and
 * final-review findings arrive afterwards via `recordFinalReviewFindings`, never
 * re-entering that gate. So a mechanically-false "file X does not exist" claim
 * from the final reviewer could only be answered by argument: the operator
 * re-deriving `git ls-files` by hand while the reviewer restated the claim and
 * called the verification a hallucination (field case 2026-08-14,
 * `scripts/lib/glob-match.mjs` — tracked, committed, with real history).
 *
 * The failure is a category error — treating "not in the changed-files list" as
 * "not in the repo" — which one set lookup settles and no prose does.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { applyExistenceGate } from '../scripts/gemini-review.mjs';

// The report renderer (formatReviewResult) is CLI-internal to gemini-review.mjs.
const REPO_ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const REVIEW_SRC = fs.readFileSync(path.join(REPO_ROOT, 'scripts/gemini-review.mjs'), 'utf-8');

/** A stub inventory. `complete: true` ⇒ absence is provable. */
const inventory = (files, complete = true) => () => ({ files: new Set(files), complete });

const REPO = ['scripts/lib/glob-match.mjs', 'scripts/lib/ledger.mjs'];

/** The incident shape: a re-asserted GPT finding claiming a tracked file is gone. */
function wronglyDismissed(overrides = {}) {
  return {
    original_finding_id: 'H1',
    recommended_severity: 'HIGH',
    reason_claude_was_wrong:
      'The module `scripts/lib/glob-match.mjs` does not exist in the repository, '
      + 'so the import cannot resolve and the dismissal was incorrect.',
    cited_lines: ['scripts/lib/audit/glob-match.mjs:12'],
    ...overrides,
  };
}

describe('applyExistenceGate — wrongly_dismissed (the path the gate was inert on)', () => {
  test('THE INCIDENT: a re-asserted claim about a TRACKED file is refuted', () => {
    const result = { wrongly_dismissed: [wronglyDismissed()] };
    const stats = applyExistenceGate(result, { listFiles: inventory(REPO) });

    assert.equal(stats.refuted, 1, 'the claim names a file that is in the inventory');
    const wd = result.wrongly_dismissed[0];
    assert.equal(wd.verification?.verification, 'refuted');
    assert.match(wd.verification.verificationReason, /glob-match\.mjs/,
      'the reason must name the path — the operator stops arguing about a specific file');
    assert.equal(wd.original_finding_id, 'H1', 'the original entry survives the round-trip');
    assert.equal(wd.recommended_severity, 'HIGH', 'the gate annotates, it does not rewrite the entry');
  });

  test('THE PROJECTION IS LOAD-BEARING: the raw entry shares no field with FindingBase', () => {
    // If someone drops `projectWronglyDismissed`, the gate still runs, still
    // returns, and classifies zero — a green run that checked nothing. This test
    // pins the fact that makes the projection necessary: the prose lives in
    // `reason_claude_was_wrong`, which `classifyFinding` does not read.
    const raw = wronglyDismissed();
    for (const field of ['category', 'section', 'detail']) {
      assert.equal(raw[field], undefined,
        `WronglyDismissedSchema has no \`${field}\` — an unprojected gate is inert`);
    }
  });

  // ── The direction the gate must NOT fire ──────────────────────────────────
  test('MUST NOT REFUTE: a claim about a genuinely absent file is left standing', () => {
    const result = {
      wrongly_dismissed: [wronglyDismissed({
        reason_claude_was_wrong: 'The module `scripts/lib/does-not-exist.mjs` does not exist in the repository.',
      })],
    };
    const stats = applyExistenceGate(result, { listFiles: inventory(REPO) });

    assert.equal(stats.refuted, 0, 'a true absence claim must survive — refuting it would bury a real finding');
    assert.notEqual(result.wrongly_dismissed[0].verification?.verification, 'refuted');
  });

  test('MUST NOT REFUTE: a non-existence finding is not classified at all', () => {
    const result = {
      wrongly_dismissed: [wronglyDismissed({
        reason_claude_was_wrong: 'The error is swallowed by a bare catch, so the write failure is invisible.',
        cited_lines: [],
      })],
    };
    const stats = applyExistenceGate(result, { listFiles: inventory(REPO) });
    assert.equal(stats.refuted, 0);
    assert.equal(result.wrongly_dismissed[0].verification, undefined,
      'the gate must not annotate findings that make no existence claim');
  });

  test('an INCOMPLETE inventory cannot prove absence — no `confirmed` verdict', () => {
    const result = {
      wrongly_dismissed: [wronglyDismissed({
        reason_claude_was_wrong: 'The module `scripts/lib/does-not-exist.mjs` does not exist in the repository.',
      })],
    };
    applyExistenceGate(result, { listFiles: inventory(REPO, false) });
    assert.notEqual(result.wrongly_dismissed[0].verification?.verification, 'confirmed',
      'absence is unprovable against a partial inventory');
  });
});

describe('applyExistenceGate — new_findings', () => {
  test('a false absence claim in new_findings is refuted', () => {
    const result = {
      new_findings: [{
        id: 'G1', severity: 'HIGH', category: 'Missing Module',
        section: 'scripts/lib/audit/glob-match.mjs',
        detail: 'The module `scripts/lib/glob-match.mjs` does not exist, so the import fails at runtime.',
      }],
    };
    const stats = applyExistenceGate(result, { listFiles: inventory(REPO) });
    assert.equal(stats.refuted, 1);
    assert.equal(result.new_findings[0].verification?.verification, 'refuted');
  });

  test('both arrays are counted, and the tally lands on the result', () => {
    const result = { new_findings: [], wrongly_dismissed: [wronglyDismissed()] };
    applyExistenceGate(result, { listFiles: inventory(REPO) });
    assert.deepEqual(result._existenceGate, { checked: 1, refuted: 1 });
  });
});

// A working gate that nothing calls is the ORIGINAL bug, not a new one:
// `verifyExistenceFindings` was correct and fully tested the whole time — it was
// simply never invoked on this path. Every test above would pass against a
// gemini-review.mjs that defines `applyExistenceGate` and never runs it, so the
// call sites need an assertion of their own.
describe('applyExistenceGate — is actually WIRED into the review path', () => {
  // BEHAVIOURAL since 2026-10. This used to count `applyExistenceGate(result);`
  // lines against `applyScopeFilter` lines across two source files — a test that
  // passes for any spelling that keeps the counts equal, and fails on a harmless
  // rename. Every path now runs ONE chain (applyReviewFilters); each test below
  // drives a real path and reads the gate's own stamp or verdict off its output.
  const INCIDENT = {
    id: 'X1', severity: 'HIGH', category: 'Missing Module', section: 'scripts/lib/glob-match.mjs',
    detail: 'The module `scripts/lib/glob-match.mjs` does not exist in the repository, so the import cannot resolve.',
    risk: 'r', recommendation: 'x', is_quick_fix: false, is_mechanical: false, is_reopened: false, principle: 'p',
    release_blocking: false, blocking_basis: 'none',
  };

  test('the shared chain runs the gate and refutes a claim about a tracked file', async () => {
    const { applyReviewFilters } = await import('../scripts/lib/final-review/post-review.mjs');
    const result = { new_findings: [{ ...INCIDENT }], wrongly_dismissed: [] };
    await applyReviewFilters(result, '{}', 'gemini');
    assert.ok(result._existenceGate, 'the chain must stamp the gate tally');
    assert.equal(result.new_findings[0].verification?.verification, 'refuted');
  });

  test('the SHADOW path runs it: a persisted shadow finding carries the refutation', async () => {
    const { _internals } = await import('../scripts/gemini-review.mjs');
    const READY = { repoId: null, modelEvalRunId: null, shadow: { state: 'ready', provider: 'gemini', model: 'gemini-test' } };
    const persisted = [];
    await _internals.runShadowAndPersist({ verdict: 'APPROVE', new_findings: [] }, 'gpt-5.6', 'run-1',
      { planContent: 'p', transcriptContent: '{}', projectContext: '', auditMode: 'code' }, {
        modelEvalOverride: READY,
        buildShadowClientFn: async () => ({}),
        runReviewWithRetry: async () => ({ result: { verdict: 'CONCERNS', new_findings: [{ ...INCIDENT }] }, usage: {}, latencyMs: 1, transcriptContent: '{}' }),
        persistFn: async (_runId, payload) => { persisted.push(payload); },
      });
    assert.equal(persisted[0]?.shadow?.[0]?.verification?.verification, 'refuted');
  });

  test('the PRIMARY CLI path runs it: the --out artifact carries the gate tally', async () => {
    const { spawnSync } = await import('node:child_process');
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'existence-gate-cli-'));
    try {
      fs.writeFileSync(path.join(dir, 'plan.md'), '# plan\n');
      fs.writeFileSync(path.join(dir, 't.json'), JSON.stringify({ changed_files: ['scripts/lib/glob-match.mjs'], rounds: [], _fixtureVerdict: 'missed_candidate' }));
      const out = path.join(dir, 'r.json');
      const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'gemini-review.mjs'), 'review',
        path.join(dir, 'plan.md'), path.join(dir, 't.json'), '--provider', 'fixture', '--out', out], {
        cwd: REPO_ROOT, encoding: 'utf-8', env: { ...process.env, NODE_ENV: 'test', AUDIT_DB_URL: '' },
      });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf-8'))._existenceGate, { checked: 1, refuted: 0 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the refuted verdict reaches the human-readable report, not just stderr', () => {
    // The operator reads the report. A refutation visible only on stderr leaves
    // them re-deriving `git ls-files` by hand while the reviewer restates it.
    assert.match(REVIEW_SRC, /REFUTED \(repo inventory\)/,
      'the wrongly_dismissed renderer must mark a mechanically-refuted claim');
  });
});

describe('applyExistenceGate — degradation', () => {
  test('an inventory failure is non-blocking and reports zero, never a false clean', () => {
    const result = { wrongly_dismissed: [wronglyDismissed()] };
    let stats;
    assert.doesNotThrow(() => {
      stats = applyExistenceGate(result, {
        listFiles: () => { throw new Error('inventory unavailable'); },
      });
    });
    assert.equal(stats.checked, 0, 'a gate that could not run must report having checked nothing');
    assert.equal(stats.refuted, 0);
    assert.equal(result.wrongly_dismissed[0].verification, undefined);
  });

  test('a result with neither array does not throw', () => {
    assert.doesNotThrow(() => applyExistenceGate({}, { listFiles: inventory(REPO) }));
  });
});
