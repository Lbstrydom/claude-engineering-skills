/**
 * Step-timing judge + contract loader + the two cross-skill commands
 * (docs/plans/performance-checklist-and-step-timings.md §Change 2).
 *
 * The rule under test: an untimed or unsent step reads `unmeasured`, never
 * green. Every refusal is checked to fail CLOSED (an error, never "no contract").
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  judgeStepTimings, parseStepTimingContract, loadStepTimingContract, resolveReadySettings,
  matchBudget, contractDigest, DEFAULT_READY, MAX_CONTRACT_BYTES,
} from '../scripts/lib/step-timing.mjs';

const CLI = path.resolve(import.meta.dirname, '..', 'scripts', 'cross-skill.mjs');

const basis = (measuredMs, factor) => ({ percentile: 'p90', measuredMs, factor, measuredAt: '2026-11-20', remeasureWhen: ['dataset 10x'] });
const contractOf = (budgets) => ({ version: 1, ready: { selector: '[data-ready]', quietMs: 500, timeoutMs: 10000 }, budgets });
const navBudget = (route, measuredMs = 1000, factor = 1.5) =>
  ({ route, kind: 'navigate', budgetMs: Math.round(measuredMs * factor), basis: basis(measuredMs, factor) });
const step = (id, durationMs, extra = {}) => ({ id, route: '/wines/1', kind: 'navigate', durationMs, ...extra });
const parsed = (c) => { const r = parseStepTimingContract(c); assert.ok(r.ok, r.error); return r.contract; };
const READY = { selector: '[data-ready]', quietMs: 500, timeoutMs: 10000 };
/** The run's attempt log = the steps sent, plus any attempt not sent; measured with the contract's own ready settings. */
const inv = (steps, unsent = [], ready = READY) => ({ attemptedIds: [...steps.map((x) => x.id), ...unsent], ready });

describe('judgeStepTimings — an untimed step is never green', () => {
  for (const [label, d] of [['absent', undefined], ['null', null], ['NaN', Number.NaN], ['negative', -5], ['a string', '812']]) {
    it(`a step whose duration is ${label} reads unmeasured / not-recorded`, () => {
      const s = d === undefined ? { id: 'a', route: '/', kind: 'navigate' } : step('a', d);
      const r = judgeStepTimings([s], null, inv([s]));
      assert.equal(r.steps[0].status, 'unmeasured');
      assert.equal(r.steps[0].unmeasuredReason, 'not-recorded');
      assert.equal(r.overall, 'unmeasured');
    });
  }

  it('a sent reason is carried through', () => {
    const r = judgeStepTimings([step('a', null, { unmeasuredReason: 'timeout' })], null, inv([step('a', null, { unmeasuredReason: 'timeout' })]));
    assert.equal(r.steps[0].unmeasuredReason, 'timeout');
  });

  it('zero steps is unmeasured, not a clean pass', () => {
    assert.equal(judgeStepTimings([], parsed(contractOf([navBudget('/wines*')])), inv([])).overall, 'unmeasured');
  });

  it('one unmeasured step among within-budget steps makes the run unmeasured', () => {
    const c = parsed(contractOf([navBudget('/wines*')]));
    const r = judgeStepTimings([step('a', 900), step('b', 1000), step('c', null)], c, inv([step('a', 900), step('b', 1000), step('c', null)]));
    assert.deepEqual(r.steps.map((s) => s.status), ['within-budget', 'within-budget', 'unmeasured']);
    assert.equal(r.overall, 'unmeasured');
  });

  it('positive control: every step timed and within budget IS within-budget', () => {
    const c = parsed(contractOf([navBudget('/wines*')]));
    assert.equal(judgeStepTimings([step('a', 900), step('b', 1500)], c, inv([step('a', 900), step('b', 1500)])).overall, 'within-budget');
  });

  it('an attempt that was never sent is missing → unmeasured', () => {
    const c = parsed(contractOf([navBudget('/wines*')]));
    const r = judgeStepTimings([step('a', 900)], c, inv([step('a', 900)], ['b']));
    assert.equal(r.counts.missing, 1);
    assert.deepEqual(r.missingIds, ['b']);
    assert.equal(r.overall, 'unmeasured');
  });

  it('refuses a duplicate entry id, a duplicate attempt id, and an entry no attempt names', () => {
    assert.equal(judgeStepTimings([step('a', 1), step('a', 2)], null, { attemptedIds: ['a'], ready: READY }).ok, false);
    assert.equal(judgeStepTimings([step('a', 1)], null, { attemptedIds: ['a', 'a'], ready: READY }).ok, false);
    // the count agrees (2 = 2) but s3 was never attempted and s2 was omitted: refused, not green
    assert.equal(judgeStepTimings([step('s1', 1), step('s3', 2)], null, { attemptedIds: ['s1', 's2'], ready: READY }).ok, false);
  });

  it('a reason always wins over a duration (a contradictory payload is not green)', () => {
    const c = parsed(contractOf([navBudget('/wines*')]));
    const r = judgeStepTimings([step('a', 0, { unmeasuredReason: 'timeout' })], c, inv([step('a', 0)]));
    assert.equal(r.steps[0].status, 'unmeasured');
    assert.equal(r.steps[0].unmeasuredReason, 'timeout');
    assert.equal(r.overall, 'unmeasured');
  });

  it("ready settings other than the contract's → budgets not applied (reported, readyOverridden)", () => {
    const c = parsed(contractOf([navBudget('/wines*')]));
    const r = judgeStepTimings([step('a', 100)], c, inv([step('a', 100)], [], { ...READY, selector: 'body' }));
    assert.equal(r.readyOverridden, true);
    assert.equal(r.steps[0].status, 'reported');
    assert.equal(r.overall, 'reported');
    assert.equal(judgeStepTimings([step('a', 100)], c, inv([step('a', 100)])).readyOverridden, false);
  });

  it("the output basis omits the contract's free-text remeasureWhen", () => {
    const c = parsed(contractOf([{ ...navBudget('/wines*'), basis: { ...basis(1000, 1.5), remeasureWhen: ['internal-note-xyz'] } }]));
    const r = judgeStepTimings([step('a', 100)], c, inv([step('a', 100)]));
    assert.ok(!JSON.stringify(r).includes('internal-note-xyz'));
    assert.deepEqual(Object.keys(r.steps[0].basis).sort(), ['factor', 'measuredAt', 'measuredMs', 'percentile']);
  });

  it('no contract → times reported only; a complete run over a budget → over-budget', () => {
    assert.equal(judgeStepTimings([step('a', 900)], null, inv([step('a', 900)])).overall, 'reported');
    const c = parsed(contractOf([navBudget('/wines*')]));
    assert.equal(judgeStepTimings([step('a', 1501), step('b', 900)], c, inv([step('a', 1501), step('b', 900)])).overall, 'over-budget');
  });

  it('completeness outranks over-budget: over + unmeasured, or over + missing, is unmeasured (over stays in counts)', () => {
    const c = parsed(contractOf([navBudget('/wines*')]));
    const r = judgeStepTimings([step('a', 1501), step('b', null)], c, inv([step('a', 1501), step('b', null)]));
    assert.equal(r.steps[0].status, 'over-budget');
    assert.equal(r.counts['over-budget'], 1);
    assert.equal(r.overall, 'unmeasured');
    assert.equal(judgeStepTimings([step('a', 1501)], c, inv([step('a', 1501)], ['b'])).overall, 'unmeasured');
  });

  it('a timed step with no matching budget is reported, and keeps the run from green', () => {
    const c = parsed(contractOf([navBudget('/cellar')]));
    const r = judgeStepTimings([step('a', 10)], c, inv([step('a', 10)]));
    assert.equal(r.steps[0].status, 'reported');
    assert.equal(r.overall, 'reported');
  });
});

describe('matchBudget', () => {
  const budgets = [navBudget('/wines*'), navBudget('/wines/1*', 800), navBudget('/wines/1', 400)];
  it('an exact route beats a longer prefix', () => {
    assert.equal(matchBudget(budgets, '/wines/1', 'navigate').route, '/wines/1');
  });
  it('among prefixes the longest wins', () => {
    assert.equal(matchBudget(budgets, '/wines/12', 'navigate').route, '/wines/1*');
    assert.equal(matchBudget(budgets, '/wines/9', 'navigate').route, '/wines*');
  });
  it('kind must match', () => {
    assert.equal(matchBudget(budgets, '/wines/1', 'action'), null);
  });
});

describe('contract validation refuses what is not a measured budget', () => {
  const bad = {
    'budget not equal to round(measured × factor)': contractOf([{ ...navBudget('/a'), budgetMs: 2000 }]),
    'empty remeasureWhen': contractOf([{ ...navBudget('/a'), basis: { ...basis(1000, 1.5), remeasureWhen: [] } }]),
    'factor above 10': contractOf([navBudget('/a', 100, 11)]),
    'factor below 1': contractOf([navBudget('/a', 1000, 0.5)]),
    'a non-ISO date': contractOf([{ ...navBudget('/a'), basis: { ...basis(1000, 1.5), measuredAt: 'last week' } }]),
    'an impossible calendar date': contractOf([{ ...navBudget('/a'), basis: { ...basis(1000, 1.5), measuredAt: '2026-02-30' } }]),
    'month 99': contractOf([{ ...navBudget('/a'), basis: { ...basis(1000, 1.5), measuredAt: '2026-99-01' } }]),
    'a duplicate (route, kind)': contractOf([navBudget('/a'), navBudget('/a', 2000)]),
    'an unknown key': { ...contractOf([]), extra: 1 },
    'a route without a leading slash': contractOf([navBudget('wines*')]),
    'a timeout below 1 s': { ...contractOf([]), ready: { selector: null, quietMs: 0, timeoutMs: 10 } },
    'a quiet window the timeout cannot hold': { ...contractOf([]), ready: { selector: null, quietMs: 10000, timeoutMs: 1000 } },
    'more budgets than the cap': contractOf(Array.from({ length: 201 }, (_, i) => navBudget(`/r${i}`))),
  };
  for (const [label, c] of Object.entries(bad)) {
    it(`refuses ${label}`, () => assert.equal(parseStepTimingContract(c).ok, false));
  }
  it('accepts a well-formed contract', () => assert.equal(parseStepTimingContract(contractOf([navBudget('/a')])).ok, true));
  it('accepts a leap day', () => assert.equal(parseStepTimingContract(contractOf([{ ...navBudget('/a'), basis: { ...basis(1000, 1.5), measuredAt: '2028-02-29' } }])).ok, true));
  it('a refusal never echoes contract keys or values (duplicate route, unknown key, bad enum)', () => {
    const secret = 'sk-secret-marker';
    for (const c of [
      contractOf([navBudget(`/reset/${secret}`), navBudget(`/reset/${secret}`)]),
      { ...contractOf([]), [secret]: 1 },
      contractOf([{ ...navBudget('/a'), kind: secret }]),
      contractOf([{ ...navBudget('/a'), basis: { ...basis(1000, 1.5), [secret]: 2 } }]),
    ]) {
      const r = parseStepTimingContract(c);
      assert.equal(r.ok, false);
      assert.ok(!r.error.includes(secret), r.error);
    }
  });
});

describe('loadStepTimingContract — fails closed, never echoes file text', () => {
  const withRepo = (fn) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-timing-'));
    try { return fn(fs.realpathSync(dir)); } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  };

  it('an absent DEFAULT file is no contract', () => withRepo((repoRoot) => {
    assert.deepEqual(loadStepTimingContract({ repoRoot }), { ok: true, contract: null, path: null });
  }));

  it('an absent EXPLICIT path is an error', () => withRepo((repoRoot) => {
    assert.equal(loadStepTimingContract({ repoRoot, contractPath: 'nope.json' }).ok, false);
  }));

  it('a sensitive path is refused', () => withRepo((repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, '.env'), 'SECRET_TOKEN=hunter2');
    const r = loadStepTimingContract({ repoRoot, contractPath: '.env' });
    assert.equal(r.ok, false);
    assert.ok(!r.error.includes('hunter2'));
  }));

  it('a symlink escaping the repo is refused', (t) => withRepo((repoRoot) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'step-timing-out-'));
    try {
      fs.writeFileSync(path.join(outside, 'c.json'), JSON.stringify(contractOf([])));
      try { fs.symlinkSync(path.join(outside, 'c.json'), path.join(repoRoot, 'step-timing-contract.json'), 'file'); } catch {
        t.skip('symlinks not permitted on this host'); return;
      }
      const r = loadStepTimingContract({ repoRoot });
      assert.equal(r.ok, false);
      assert.match(r.error, /outside the repository/);
    } finally { fs.rmSync(outside, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  }));

  it('a DANGLING default symlink is an error, not "no contract"', (t) => withRepo((repoRoot) => {
    try { fs.symlinkSync(path.join(repoRoot, 'gone.json'), path.join(repoRoot, 'step-timing-contract.json'), 'file'); } catch {
      t.skip('symlinks not permitted on this host'); return;
    }
    assert.equal(loadStepTimingContract({ repoRoot }).ok, false);
  }));

  it('an oversized file is refused', () => withRepo((repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'step-timing-contract.json'), ' '.repeat(MAX_CONTRACT_BYTES + 1));
    assert.match(loadStepTimingContract({ repoRoot }).error, /over the/);
  }));

  it('malformed JSON is refused without echoing the body', () => withRepo((repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'step-timing-contract.json'), '{"version": 1, "token": "sk-should-not-echo"');
    const r = loadStepTimingContract({ repoRoot });
    assert.equal(r.ok, false);
    assert.ok(!r.error.includes('sk-should-not-echo'));
  }));

  it('a valid default file loads, and resolveReadySettings returns only ready settings', () => withRepo((repoRoot) => {
    const c = contractOf([navBudget('/a')]);
    fs.writeFileSync(path.join(repoRoot, 'step-timing-contract.json'), JSON.stringify(c));
    const r = resolveReadySettings({ repoRoot });
    assert.deepEqual(r.ready, c.ready);
    assert.equal(r.contractDeclared, true);
    assert.equal(r.contractDigest, contractDigest(parsed(c)));
    assert.ok(!('budgets' in r) && !('budgets' in r.ready));
  }));

  it('no contract → default ready settings and a null digest', () => withRepo((repoRoot) => {
    const r = resolveReadySettings({ repoRoot });
    assert.deepEqual(r.ready, { ...DEFAULT_READY });
    assert.equal(r.contractDigest, null);
  }));
});

describe('cross-skill commands end to end', () => {
  const run = (cwd, cmd, payload) => {
    const r = spawnSync(process.execPath, [CLI, cmd, '--stdin'], {
      cwd, input: JSON.stringify(payload), encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, AUDIT_DB_URL: '', LEARNING_DISABLE: '1' },
    });
    const line = r.stdout.split('\n').filter((l) => l.trim().startsWith('{')).pop();
    return { status: r.status, env: line ? JSON.parse(line) : null };
  };
  const withRepo = (fn) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-timing-cli-'));
    try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  };

  it('ready → measure → judge, with a contract', () => withRepo((cwd) => {
    fs.writeFileSync(path.join(cwd, 'step-timing-contract.json'), JSON.stringify(contractOf([navBudget('/wines*')])));
    const ready = run(cwd, 'step-timing-ready', {});
    assert.equal(ready.status, 0);
    assert.equal(ready.env.ready.selector, '[data-ready]');
    const judged = run(cwd, 'judge-step-timings', { steps: [step('a', 900), step('b', null)], attemptedIds: ['a', 'b'], ready: ready.env.ready, contractDigest: ready.env.contractDigest });
    assert.equal(judged.status, 0);
    assert.equal(judged.env.overall, 'unmeasured');
    assert.deepEqual(judged.env.steps.map((s) => s.status), ['within-budget', 'unmeasured']);
  }));

  it('a non-default contractPath is carried through both calls', () => withRepo((cwd) => {
    fs.mkdirSync(path.join(cwd, 'perf'));
    fs.writeFileSync(path.join(cwd, 'perf', 'c.json'), JSON.stringify(contractOf([navBudget('/wines*')])));
    const ready = run(cwd, 'step-timing-ready', { contractPath: 'perf/c.json' });
    assert.equal(ready.status, 0);
    assert.equal(ready.env.contract.path, 'perf/c.json');
    const judged = run(cwd, 'judge-step-timings', { steps: [step('a', 900)], attemptedIds: ['a'], ready: ready.env.ready,
      contractDigest: ready.env.contractDigest, contractPath: 'perf/c.json' });
    assert.equal(judged.status, 0);
    assert.equal(judged.env.overall, 'within-budget');
    // negative control: dropping contractPath on the judge reloads the (absent) default → digest mismatch
    const dropped = run(cwd, 'judge-step-timings', { steps: [step('a', 900)], attemptedIds: ['a'], ready: ready.env.ready, contractDigest: ready.env.contractDigest });
    assert.equal(dropped.status, 1);
  }));

  it('a contract replaced between the two calls is refused', () => withRepo((cwd) => {
    const file = path.join(cwd, 'step-timing-contract.json');
    fs.writeFileSync(file, JSON.stringify(contractOf([navBudget('/wines*')])));
    const ready = run(cwd, 'step-timing-ready', {});
    fs.writeFileSync(file, JSON.stringify(contractOf([navBudget('/wines*', 5000)])));
    const judged = run(cwd, 'judge-step-timings', { steps: [step('a', 900)], attemptedIds: ['a'], ready: ready.env.ready, contractDigest: ready.env.contractDigest });
    assert.equal(judged.status, 1);
    assert.match(judged.env.error.message, /contract changed between calls/);
  }));

  it('a malformed contract exits non-zero on both commands', () => withRepo((cwd) => {
    fs.writeFileSync(path.join(cwd, 'step-timing-contract.json'), '{not json');
    assert.equal(run(cwd, 'step-timing-ready', {}).status, 1);
    assert.equal(run(cwd, 'judge-step-timings', { steps: [], attemptedIds: [], ready: READY, contractDigest: null }).status, 1);
  }));
});
