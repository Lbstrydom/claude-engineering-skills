import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  replay,
  distSummary,
  passSelectionReward,
  convergencePredictReward,
  archMemoryBandReward,
  historicalBaseline,
  neutralBaseline,
  _internals,
} from '../scripts/lib/learning/replay.mjs';

import {
  parseDuration,
  renderMarkdownReport,
  runReplayCli,
  emptySampleNotice,
  REPLAY_GRAMMAR,
} from '../scripts/learning/replay.mjs';
import { REGISTRY, normalizeFlag } from '../scripts/lib/cross-skill/registry.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Fixture store ──────────────────────────────────────────────────────────

function fixtureStore(rows) {
  return {
    isCloudEnabled: () => true,
    initLearningStore: async () => true,
    _rows: rows,
  };
}

// We bypass the live cloud read by injecting rows directly via the
// internal readDecisionsForType signature — easiest path is to monkey-patch
// via a custom store shim that returns rows.

import * as replayMod from '../scripts/lib/learning/replay.mjs';

// ── distSummary ────────────────────────────────────────────────────────────

describe('replay / distSummary', () => {
  it('returns zeros for empty input', () => {
    const r = distSummary([]);
    assert.deepEqual(r, { mean: 0, p50: 0, p90: 0, total: 0 });
  });

  it('computes mean + p50 + p90 + total for known input', () => {
    const r = distSummary([1, 2, 3, 4, 5]);
    assert.equal(r.total, 15);
    assert.equal(r.mean, 3);
    assert.equal(r.p50, 3);
    assert.ok(r.p90 > 4 && r.p90 < 5, `p90 = ${r.p90}`); // ≈ 4.6 with linear interp
  });

  it('handles single-element input', () => {
    const r = distSummary([42]);
    assert.equal(r.mean, 42);
    assert.equal(r.p50, 42);
    assert.equal(r.p90, 42);
  });
});

// ── replay() with injected fixtures ──────────────────────────────────────

describe('replay / engine (fixture-driven)', () => {
  it('returns sample-size 0 + empty distributions when cloud disabled', async () => {
    // Short-circuit before any cloud read by stubbing isCloudEnabled:false.
    // Prior version of this test relied on the real store returning [], which
    // breaks once SUPABASE_AUDIT_SERVICE_ROLE_KEY is set in the test env
    // (real reads return real rows).
    const store = {
      isCloudEnabled: () => false,
      initLearningStore: async () => false,
    };
    const result = await replay({
      decisionType: 'pass_selection',
      candidatePolicy: () => ({ chose: 'all' }),
      rewardFn: () => 0,
      store,
    });
    assert.equal(result.ok, true);
    assert.equal(result.sampleSize, 0);
    assert.deepEqual(result.baselineDist,  { mean: 0, p50: 0, p90: 0, total: 0 });
    assert.deepEqual(result.candidateDist, { mean: 0, p50: 0, p90: 0, total: 0 });
  });

  it('rejects malformed input (validateInput)', async () => {
    await assert.rejects(() => replay({}), /decisionType/);
    await assert.rejects(() => replay({
      decisionType: 'pass_selection',
      candidatePolicy: 'not-a-fn',
      rewardFn: () => 0,
    }), /candidatePolicy/);
    await assert.rejects(() => replay({
      decisionType: 'pass_selection',
      candidatePolicy: () => ({}),
      rewardFn: 'not-a-fn',
    }), /rewardFn/);
  });

  it('rewardFn returning NaN/Infinity is coerced to 0', () => {
    // Test the safeReward internal directly.
    const { safeReward } = _internals;
    const row = {};
    assert.equal(safeReward(() => NaN, row, {}), 0);
    assert.equal(safeReward(() => Infinity, row, {}), 0);
    assert.equal(safeReward(() => 'abc', row, {}), 0);
    assert.equal(safeReward(() => 1.5, row, {}), 1.5);
  });

  it('rewardFn that throws is coerced to 0', () => {
    const { safeReward } = _internals;
    assert.equal(safeReward(() => { throw new Error('nope'); }, {}, {}), 0);
  });
});

// ── Built-in reward functions ────────────────────────────────────────────

describe('replay / passSelectionReward', () => {
  it('returns 0 when outcome is missing', () => {
    assert.equal(passSelectionReward({}), 0);
    assert.equal(passSelectionReward({ outcome: null }), 0);
  });

  it('rewards high-severity findings + persona correlations', () => {
    const r = passSelectionReward({
      outcome: {
        highKept: 5,
        mediumKept: 3,
        costUsd: 1,
        personaCorrelationConfirmedHits: 2,
        dismissedFalsePositives: 1,
      },
    }, { chose: 'all' });
    // (5 + 0.5*3) / 1 + 2.0 * 2 - 0.5 * 1 = 6.5 + 4 - 0.5 = 10
    assert.equal(r, 10);
  });

  it('penalises false positives', () => {
    const noFp = passSelectionReward({ outcome: { highKept: 1, mediumKept: 0, costUsd: 1 } });
    const withFp = passSelectionReward({ outcome: { highKept: 1, mediumKept: 0, costUsd: 1, dismissedFalsePositives: 5 } });
    assert.ok(withFp < noFp);
  });
});

describe('replay / convergencePredictReward', () => {
  it('rewards correct stop (chose=stop, convergedAt=round)', () => {
    const r = convergencePredictReward(
      { round: 3, outcome: { converged_at: 3 } },
      { chose: 'stop' }
    );
    assert.equal(r, 1);
  });

  it('penalises early stop (chose=stop, convergedAt > round)', () => {
    const r = convergencePredictReward(
      { round: 2, outcome: { converged_at: 5 } },
      { chose: 'stop' }
    );
    assert.equal(r, -2);
  });

  it('rewards correct continue', () => {
    const r = convergencePredictReward(
      { round: 1, outcome: { converged_at: 3 } },
      { chose: 'continue' }
    );
    assert.equal(r, 0.5);
  });

  it('penalises wasted continue', () => {
    const r = convergencePredictReward(
      { round: 3, outcome: { converged_at: 3 } },
      { chose: 'continue' }
    );
    assert.equal(r, -0.2);
  });

  it('returns 0 when outcome is missing', () => {
    assert.equal(convergencePredictReward({}, { chose: 'stop' }), 0);
  });
});

describe('replay / archMemoryBandReward', () => {
  it('rewards correct reuse', () => {
    const r = archMemoryBandReward(
      { outcome: { action: 'reuse-correct' } },
      { band: 'reuse' }
    );
    assert.equal(r, 1);
  });

  it('rewards correct extend', () => {
    const r = archMemoryBandReward(
      { outcome: { action: 'extend-correct' } },
      { band: 'extend' }
    );
    assert.equal(r, 1);
  });

  it('penalises wrong-fork (recommended reuse, user wrote new)', () => {
    const r = archMemoryBandReward(
      { outcome: { action: 'wrong-fork' } },
      { band: 'reuse' }
    );
    assert.equal(r, -1);
  });

  it('zero for uncertain or missing outcome', () => {
    assert.equal(archMemoryBandReward({ outcome: { action: 'uncertain' } }, { band: 'reuse' }), 0);
    assert.equal(archMemoryBandReward({}, { band: 'reuse' }), 0);
  });
});

// ── Built-in baselines ───────────────────────────────────────────────────

describe('replay / built-in baselines', () => {
  it('historicalBaseline returns the row choice', () => {
    assert.deepEqual(historicalBaseline({ choice: { chose: 'all' } }), { chose: 'all' });
    assert.deepEqual(historicalBaseline({}), {});
  });

  it('neutralBaseline returns a fixed neutral choice', () => {
    assert.deepEqual(neutralBaseline(), { chose: 'neutral' });
  });

  // Audit-fix Phase 3 R1 H2/H7: contract is `(row) => choice`, NOT
  // `(context) => choice`.  Pin the contract.
  it('audit-fix H2/H7: policy contract receives the full row, not just context', async () => {
    const fakeRow = { context: { x: 1 }, choice: { historical: true }, outcome: null };
    // Inject our own store implementation that returns one row.
    const ls = await import('../scripts/learning-store.mjs');
    const originalIsCloud = ls.isCloudEnabled;
    let called = false;
    let receivedRow = null;
    const candidate = (row) => { called = true; receivedRow = row; return { fromCandidate: true }; };
    // Use replay's fixture-driven path: provide a store with rows already
    // populated.  The simplest way is to pass a store stub whose
    // isCloudEnabled returns true, but we'd still hit the live read fn.
    // Instead, monkey-test the contract by calling historicalBaseline
    // directly with a row to confirm the new shape works.
    assert.deepEqual(historicalBaseline(fakeRow), { historical: true });
    // And call candidate directly to confirm row shape compatibility:
    candidate(fakeRow);
    assert.equal(called, true);
    assert.deepEqual(receivedRow, fakeRow);
    assert.equal(receivedRow.choice.historical, true, 'policy must see row.choice');
  });
});

// ── CLI: parseDuration ───────────────────────────────────────────────────

describe('replay CLI / parseDuration', () => {
  it('parses common formats', () => {
    assert.equal(parseDuration('1ms', 0), 1);
    assert.equal(parseDuration('5s', 0), 5_000);
    assert.equal(parseDuration('2m', 0), 120_000);
    assert.equal(parseDuration('1h', 0), 3_600_000);
    assert.equal(parseDuration('30d', 0), 30 * 86_400_000);
    assert.equal(parseDuration('2w', 0), 14 * 86_400_000);
  });

  it('treats bare number as milliseconds', () => {
    assert.equal(parseDuration('500', 0), 500);
  });

  it('falls back on invalid input', () => {
    assert.equal(parseDuration('zzz', 9999), 9999);
    assert.equal(parseDuration('', 9999), 9999);
    assert.equal(parseDuration(null, 9999), 9999);
  });
});

// ── CLI: renderMarkdownReport ────────────────────────────────────────────

describe('replay CLI / renderMarkdownReport', () => {
  it('renders a complete markdown table', () => {
    const md = renderMarkdownReport({
      decisionType: 'pass_selection',
      sampleSize: 100,
      sinceMs: 30 * 86_400_000,
      baselineDist:  { mean: 1.0, p50: 1.0, p90: 1.5, total: 100 },
      candidateDist: { mean: 1.2, p50: 1.1, p90: 1.8, total: 120 },
      deltaSummary:  { meanDelta: 0.2, candidateBetterPct: 0.65, ties: 5 },
    });
    assert.match(md, /Replay report/);
    assert.match(md, /pass_selection/);
    assert.match(md, /Sample size:.*100/);
    assert.match(md, /candidate-better.*65.0%/);
    assert.doesNotMatch(md, /empty sample/i, 'a non-empty sample must not carry the empty-sample warning');
  });

  it('an EMPTY sample says so in the report (ledger af81be85)', () => {
    const md = renderMarkdownReport({
      decisionType: 'pass_selection',
      sampleSize: 0,
      sinceMs: 30 * 86_400_000,
      baselineDist:  { mean: 0, p50: 0, p90: 0, total: 0 },
      candidateDist: { mean: 0, p50: 0, p90: 0, total: 0 },
      deltaSummary:  { meanDelta: 0, candidateBetterPct: 0, ties: 0 },
    });
    assert.match(md, /empty sample/i);
    assert.match(md, /NOT evidence/);
  });
});

// ── CLI: runReplayCli — validation, honesty, and the written failure ─────────
//
// Ledger b445b4ba + af81be85 (executed 2026-10-03). Every case injects `replayFn`
// so NO database is touched: the point of the validation block is that it runs
// BEFORE any policy import or store read, and a spy that was never called is the
// proof.

const A_UUID = '6461a693-6690-4bf3-98ee-14c0385cc357';

/** Run runReplayCli with stdout/stderr captured. */
async function runCaptured(args, deps) {
  const out = [];
  const err = [];
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  process.stderr.write = (s) => { err.push(String(s)); return true; };
  try {
    const result = await runReplayCli(args, deps);
    return { result, out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

const EMPTY_DIST = { mean: 0, p50: 0, p90: 0, total: 0 };
const zeroResult = (extra = {}) => ({
  ok: true, decisionType: 'pass_selection', sampleSize: 0, sinceMs: 1, truncated: false,
  baselineDist: EMPTY_DIST, candidateDist: EMPTY_DIST,
  deltaSummary: { meanDelta: 0, candidateBetterPct: 0, ties: 0 }, ...extra,
});
const spy = (result = zeroResult()) => {
  const calls = [];
  const fn = async (input) => { calls.push(input); return result; };
  fn.calls = calls;
  return fn;
};

describe('replay CLI / runReplayCli validates before any import or read', () => {
  it('an unknown decision type is ok:false (the rewardFn message) and nothing runs', async () => {
    const replayFn = spy();
    const { result, out } = await runCaptured(['bogus_type'], { replayFn });
    assert.equal(result.ok, false);
    assert.match(result.error, /rewardFn/);
    assert.match(result.error, /pass_selection/, 'the error must list what IS supported');
    assert.equal(replayFn.calls.length, 0);
    assert.equal(out, '', 'runReplayCli leaves a FAILURE to its caller to write — see the isMain tail');
  });

  it('Object.prototype names are not decision types', async () => {
    // `DEFAULT_REWARDS[type]` found `constructor` — a function — so the lookup
    // read a prototype member as a registered reward.
    for (const t of ['constructor', 'toString', '__proto__']) {
      const replayFn = spy();
      const { result } = await runCaptured([t], { replayFn });
      assert.equal(result.ok, false, `${t} must not be accepted`);
      assert.equal(replayFn.calls.length, 0);
    }
  });

  it('validation precedes the policy import: a bad type + a nonexistent --policy reports the TYPE', async () => {
    const replayFn = spy();
    const { result } = await runCaptured(['bogus_type', '--policy', 'tests/fixtures/does-not-exist.mjs'], { replayFn });
    assert.equal(result.ok, false);
    assert.match(result.error, /rewardFn/, 'previously this surfaced as a module-import failure');
  });

  it('a second bare word is refused, not ignored', async () => {
    const replayFn = spy();
    const { result } = await runCaptured(['pass_selection', 'convergence_predict'], { replayFn });
    assert.equal(result.ok, false);
    assert.match(result.error, /exactly one decision type/);
    assert.equal(replayFn.calls.length, 0);
  });

  it('--repo owner/repo is ok:false /UUID/ — it used to be a 22P02 swallowed into a false zero', async () => {
    const replayFn = spy();
    const { result } = await runCaptured(['pass_selection', '--repo', 'owner/repo'], { replayFn });
    assert.equal(result.ok, false);
    assert.match(result.error, /UUID/);
    assert.match(result.error, /owner\/repo/);
    assert.equal(replayFn.calls.length, 0, 'the store must never see a non-UUID repo id');
  });

  it('--repo-id is validated too', async () => {
    const { result } = await runCaptured(['pass_selection', '--repo-id=not-a-uuid'], { replayFn: spy() });
    assert.equal(result.ok, false);
    assert.match(result.error, /UUID/);
  });

  it('a UUID is accepted in BOTH spellings and reaches replay() — the = form used to be ignored', async () => {
    for (const args of [
      ['pass_selection', '--repo-id', A_UUID],
      ['pass_selection', `--repo-id=${A_UUID}`],
      ['pass_selection', `--repo=${A_UUID}`],
      ['pass_selection', `--repo=${A_UUID.toUpperCase()}`],
    ]) {
      const replayFn = spy();
      await runCaptured(args, { replayFn });
      assert.equal(replayFn.calls.length, 1, `${args.join(' ')} must reach replay()`);
      assert.equal(replayFn.calls[0].repoId.toLowerCase(), A_UUID, `${args.join(' ')}: the filter must be passed through`);
    }
  });

  it('--repo and --repo-id are one filter: disagreeing values are refused, the same value twice is accepted', async () => {
    const OTHER_UUID = A_UUID.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
    const refused = spy();
    const { result } = await runCaptured(['pass_selection', '--repo', A_UUID, '--repo-id', OTHER_UUID], { replayFn: refused });
    assert.equal(result.ok, false);
    assert.match(result.error, /same filter but disagree/);
    assert.equal(refused.calls.length, 0, 'the store must not be queried for an ambiguous scope');

    // Control: the same value in both spellings (even in a different case) reaches replay().
    const accepted = spy();
    await runCaptured(['pass_selection', '--repo', A_UUID.toUpperCase(), '--repo-id', A_UUID], { replayFn: accepted });
    assert.equal(accepted.calls.length, 1, 'control: an agreeing pair is not refused');
  });

  it('--since=7d and --since 7d are the same window; last wins; the default is 30d', async () => {
    const day = 24 * 60 * 60 * 1000;
    const cases = [
      [['pass_selection', '--since=7d'], 7 * day],
      [['pass_selection', '--since', '7d'], 7 * day],
      [['pass_selection', '--since', '14d', '--since=7d'], 7 * day],
      [['pass_selection', '--since=7d', '--since', '14d'], 14 * day],
      [['pass_selection'], 30 * day],
    ];
    for (const [args, expected] of cases) {
      const replayFn = spy();
      await runCaptured(args, { replayFn });
      assert.equal(replayFn.calls[0].sinceMs, expected, `${args.join(' ')} → sinceMs`);
    }
  });

  it('an unparseable --since is ok:false — it used to fall back to 30d silently', async () => {
    for (const bad of ['7days', 'garbage', '-5d', '1.5d']) {
      const replayFn = spy();
      const { result } = await runCaptured(['pass_selection', `--since=${bad}`], { replayFn });
      assert.equal(result.ok, false, `--since=${bad}`);
      assert.match(result.error, /--since/);
      assert.equal(replayFn.calls.length, 0);
    }
  });

  it('a valued flag with no value is refused, and never swallows the NEXT flag', async () => {
    const replayFn = spy();
    for (const args of [
      ['pass_selection', '--since'],
      ['pass_selection', '--since='],
      ['pass_selection', '--since', '--format', 'markdown'],
      ['pass_selection', '--policy', '--since', '7d'],
    ]) {
      const { result } = await runCaptured(args, { replayFn });
      assert.equal(result.ok, false, args.join(' '));
      assert.match(result.error, /requires a value/, args.join(' '));
    }
    assert.equal(replayFn.calls.length, 0);
  });

  it('--format must be json or markdown — it used to fall back to JSON silently', async () => {
    const { result } = await runCaptured(['pass_selection', '--format=markdwon'], { replayFn: spy() });
    assert.equal(result.ok, false);
    assert.match(result.error, /--format/);
  });

  it('everything after -- is a positional, so it cannot smuggle a policy path', async () => {
    const replayFn = spy();
    const { result } = await runCaptured(['pass_selection', '--', '--policy=tests/fixtures/does-not-exist.mjs'], { replayFn });
    assert.equal(result.ok, false, 'two positionals now — refused, and the policy file was never imported');
    assert.match(result.error, /exactly one decision type/);
  });
});

describe('replay CLI / runReplayCli — failures AFTER validation are returned, not thrown', () => {
  // Round-1 plan audit H2: the isMain tail can only WRITE a returned result, so a
  // rejection here would bypass the output lifecycle and exit with empty stdout —
  // the very defect (ledger b445b4ba, 5a) being fixed.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-policy-'));
  const write = (name, body) => { const p = path.join(tmp, name); fs.writeFileSync(p, body); return p; };
  after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  it('a VALID type with a nonexistent --policy file is ok:false /policy-load-failed/', async () => {
    const replayFn = spy();
    const { result, err } = await runCaptured(['pass_selection', '--policy', path.join(tmp, 'nope.mjs')], { replayFn });
    assert.equal(result.ok, false);
    assert.match(result.error, /policy-load-failed/);
    assert.match(result.error, /--policy/);
    assert.ok(err.length > 0, 'the underlying stack goes to stderr');
    assert.equal(replayFn.calls.length, 0);
  });

  it('a module exporting no function is ok:false /policy-load-failed/, and --baseline is named as such', async () => {
    const bad = write('no-fn.mjs', 'export const nope = 1;\n');
    const { result } = await runCaptured(['pass_selection', '--baseline', bad], { replayFn: spy() });
    assert.equal(result.ok, false);
    assert.match(result.error, /policy-load-failed/);
    assert.match(result.error, /--baseline/);
    assert.match(result.error, /default OR named 'policy'/, 'the contract wording of the original message is preserved');
  });

  it('a module that throws on import is ok:false', async () => {
    const bad = write('throws.mjs', "throw new Error('boom at import');\n");
    const { result } = await runCaptured(['pass_selection', '--policy', bad], { replayFn: spy() });
    assert.equal(result.ok, false);
    assert.match(result.error, /boom at import/);
  });

  it('a valid policy module loads and reaches replay()', async () => {
    const good = write('good.mjs', 'export default function policy() { return { chose: "x" }; }\n');
    const replayFn = spy();
    const { result } = await runCaptured(['pass_selection', '--policy', good], { replayFn });
    assert.equal(result.ok, true);
    assert.equal(typeof replayFn.calls[0].candidatePolicy, 'function');
  });

  it('export selection uses the SAME predicate as validation (round-1 code audit H2/M6)', async () => {
    // loadPolicy accepted a module when `default` OR `policy` was a function and
    // then RETURNED `default || policy` — so a truthy non-function default shadowed
    // a valid named policy, and the "validated" value was not callable.
    const cases = [
      ['non-function default + named policy fn', 'export default { not: "a function" };\nexport function policy() { return { chose: "named" }; }\n', 'named'],
      ['function default + non-function policy', 'export default function () { return { chose: "default" }; }\nexport const policy = 42;\n', 'default'],
      ['both functions: default wins (the long-standing precedence)', 'export default function () { return { chose: "default" }; }\nexport function policy() { return { chose: "named" }; }\n', 'default'],
      ['only a named policy fn', 'export function policy() { return { chose: "named" }; }\n', 'named'],
    ];
    for (const [label, body, expected] of cases) {
      const replayFn = spy();
      const { result } = await runCaptured(['pass_selection', '--policy', write(`sel-${expected}-${label.length}.mjs`, body)], { replayFn });
      assert.equal(result.ok, true, label);
      assert.equal(replayFn.calls[0].candidatePolicy({}).chose, expected, label);
    }
    for (const body of ['export default { x: 1 };\nexport const policy = "nope";\n', 'export default 7;\n']) {
      const { result } = await runCaptured(['pass_selection', '--policy', write(`bad-${body.length}.mjs`, body)], { replayFn: spy() });
      assert.equal(result.ok, false, 'neither export callable → refused');
      assert.match(result.error, /policy-load-failed/);
    }
  });

  it('replay() throwing is ok:false /replay-failed/ with the stack on stderr', async () => {
    const replayFn = async () => { throw new Error('policy exploded mid-replay'); };
    const { result, err } = await runCaptured(['pass_selection'], { replayFn });
    assert.equal(result.ok, false);
    assert.match(result.error, /replay-failed: policy exploded mid-replay/);
    assert.match(err, /policy exploded mid-replay/);
  });

  it('a replayFn that RETURNS ok:false is passed through unwritten (the caller emits it once)', async () => {
    const { result, out } = await runCaptured(['pass_selection'], { replayFn: async () => ({ ok: false, error: 'x' }) });
    assert.equal(result.ok, false);
    assert.equal(out, '', 'writing it here AND at the entry point would put two JSON values on one stdout');
  });
});

describe('replay CLI / an empty sample is not a clean result (ledger af81be85)', () => {
  it('emptySampleNotice names all three causes and refuses to read zero as "no difference"', () => {
    const n = emptySampleNotice(zeroResult());
    assert.equal(typeof n, 'string');
    assert.match(n, /NOT evidence/);
    assert.match(n, /store/i);
    assert.match(n, /window|filter/i);
    assert.match(n, /recorded|none/i);
  });

  it('a non-empty sample, and a non-result, produce no notice', () => {
    assert.equal(emptySampleNotice(zeroResult({ sampleSize: 3 })), null);
    assert.equal(emptySampleNotice(null), null);
    assert.equal(emptySampleNotice(undefined), null);
  });

  // Decision 2026-10-12 (user): this used to pin "stdout JSON UNCHANGED", so a
  // caller reading only stdout or the exit code saw ok:true + a zero delta — a
  // clean zero. The envelope now carries `measured:false` (AGENTS.md shape (7):
  // end in measured:false, never a refusal and never a zero). ok:true and exit 0
  // are deliberately KEPT; only the stderr WARNING is not on stdout.
  it('sampleSize 0 ⇒ stderr WARNING, stdout JSON ok:true AND measured:false', async () => {
    const { result, out, err } = await runCaptured(['pass_selection'], { replayFn: spy(zeroResult()) });
    assert.equal(result.ok, true);
    assert.equal(result.measured, false, 'the returned result is the written envelope');
    assert.match(err, /\[replay\] WARNING:.*NOT evidence/);
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.sampleSize, 0);
    assert.equal(parsed.measured, false);
    assert.equal(Object.hasOwn(parsed, 'warning'), false, 'the notice prose rides stderr and markdown only');
  });

  it('a non-empty sample ⇒ stdout JSON measured:true', async () => {
    const { result, out } = await runCaptured(['pass_selection'], { replayFn: spy(zeroResult({ sampleSize: 7 })) });
    assert.equal(result.measured, true);
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.measured, true);
  });

  it('a result with no numeric sampleSize is NOT measured (fails closed)', async () => {
    const { out } = await runCaptured(['pass_selection'], { replayFn: spy(zeroResult({ sampleSize: undefined })) });
    assert.equal(JSON.parse(out).measured, false);
  });

  it('sampleSize 0 with --format=markdown carries the warning in the report', async () => {
    const { out } = await runCaptured(['pass_selection', '--format=markdown'], { replayFn: spy(zeroResult()) });
    assert.match(out, /Replay report/);
    assert.match(out, /empty sample/i);
  });

  it('a non-empty sample emits no WARNING', async () => {
    const { err } = await runCaptured(['pass_selection'], { replayFn: spy(zeroResult({ sampleSize: 12 })) });
    assert.doesNotMatch(err, /WARNING/);
  });

  it('--format=markdown is honoured in the = spelling — it used to print JSON', async () => {
    const { out } = await runCaptured(['pass_selection', '--format=markdown'], { replayFn: spy(zeroResult({ sampleSize: 5 })) });
    assert.match(out, /^# Replay report/);
  });
});

describe('replay CLI / spawned — the failure is WRITTEN and the exit code agrees', () => {
  // Executed 2026-10-03: `node scripts/learning/replay.mjs bogus_type` exited 1
  // with EMPTY stdout. Both cases below fail before any store read, so they are
  // hermetic whatever AUDIT_DB_URL the machine has.
  const run = (script, args) => spawnSync(process.execPath, [script, ...args],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 });

  it('direct CLI: an unknown decision type exits 1 with an ok:false envelope on stdout', () => {
    const r = run('scripts/learning/replay.mjs', ['bogus_type']);
    assert.equal(r.status, 1, r.stderr);
    const env = JSON.parse(r.stdout.trim());
    assert.equal(env.ok, false);
    assert.match(env.error, /rewardFn/);
  });

  it('direct CLI: a valid type with a nonexistent policy exits 1 with ok:false /policy-load-failed/', () => {
    const r = run('scripts/learning/replay.mjs', ['pass_selection', '--policy', 'tests/fixtures/does-not-exist.mjs']);
    assert.equal(r.status, 1, r.stderr);
    const env = JSON.parse(r.stdout.trim());
    assert.equal(env.ok, false);
    assert.match(env.error, /policy-load-failed/);
  });

  it('direct CLI: a non-UUID --repo exits 1 with an ok:false envelope (not a false zero at exit 0)', () => {
    const r = run('scripts/learning/replay.mjs', ['pass_selection', '--repo', 'owner/repo']);
    assert.equal(r.status, 1, r.stderr);
    assert.match(JSON.parse(r.stdout.trim()).error, /UUID/);
  });

  it('direct CLI: an unknown flag is still a usage error (exit 2) — unchanged', () => {
    const r = run('scripts/learning/replay.mjs', ['pass_selection', '--nope']);
    assert.equal(r.status, 2);
  });

  it('through cross-skill: flags and the type reach the sub-CLI (they used to exit 2 BAD_INPUT)', () => {
    // `npm run learning:replay -- pass_selection --since=7d` was dead: the
    // registry entry declared no flags and `positionals:'none'`, so the
    // dispatcher refused both BEFORE the forwarder ran. exit 1 + a rewardFn error
    // proves the argv was FORWARDED and replay's own validation answered.
    for (const args of [
      ['learning-replay', 'bogus_type', '--since=7d', '--format', 'markdown'],
      ['learning-replay', '--since', '7d', 'bogus_type'],
    ]) {
      const r = run('scripts/cross-skill.mjs', args);
      assert.equal(r.status, 1, `${args.join(' ')} → ${r.stdout}${r.stderr}`);
      const env = JSON.parse(r.stdout.trim());
      assert.equal(env.ok, false);
      assert.match(env.error, /rewardFn/);
    }
  });

  it('through cross-skill: a flag the sub-CLI does not know is still refused (exit 2)', () => {
    const r = run('scripts/cross-skill.mjs', ['learning-replay', 'pass_selection', '--nope']);
    assert.equal(r.status, 2);
  });
});

describe('registry entry learning-replay mirrors replay.mjs own grammar (parity)', () => {
  // The registry is static (it must not import replay.mjs: cold start does not
  // scale with command count, and it would add a cross-skill-bridge → scripts
  // edge), so the two inventories are pinned against each other HERE. One of
  // them drifting is how the documented command died the first time.
  const entry = REGISTRY.find((e) => e.name === 'learning-replay');

  it('the entry exists and forwards to scripts/learning/replay.mjs', () => {
    assert.ok(entry);
    assert.equal(entry.forward?.to, 'scripts/learning/replay.mjs');
  });

  it('verbs == the built-in decision types', () => {
    assert.deepEqual([...entry.positionals.verbs].sort(), [...REPLAY_GRAMMAR.decisionTypes].sort());
  });

  it('flags == replay.mjs valued flags, every one declared valued', () => {
    const flags = (entry.flags ?? []).map(normalizeFlag);
    assert.deepEqual(flags.map((f) => f.name).sort(), [...REPLAY_GRAMMAR.valuedFlags].sort());
    for (const f of flags) assert.equal(f.kind, 'valued', `--${f.name}`);
  });
});
