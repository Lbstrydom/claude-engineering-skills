/**
 * @fileoverview Audit convergence metrics (item 8d) — grouping, pass definition, honesty counters,
 * the CLI surface and the dashboard section. Definitions: docs/plans/audit-convergence-metrics.md §2.
 * Fixture shapes are taken from real audit_runs rows (2026-11-12): duplicate rows per round,
 * a round counter that does not start at 1, rounds=0 initial rows, plan rows passing on APPROVE only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  groupSessions, metricsFor, buildReport, flattenReport, roundPassed, summaryLine,
} from '../scripts/lib/audit/convergence-metrics.mjs';
import { renderGroup, renderReport } from '../scripts/audit-convergence.mjs';
import sectionConvergence from '../scripts/lib/dashboard/sections/convergence.mjs';
import { buildUi } from '../scripts/lib/dashboard/helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T0 = Date.parse('2026-11-01T00:00:00Z');
const MIN = 60_000;
let seq = 0;

function row(o) {
  seq += 1;
  return {
    id: `r${String(seq).padStart(4, '0')}`, repo_id: 'repo-a', repo_name: 'o/a', plan_file: 'docs/plans/x.md', branch: 'feat/x',
    mode: 'code', rounds: 1, run_status: 'complete', gemini_verdict: null, round_converged_after: null, audit_session_id: null,
    assignment_id: null, arm_eval_run_id: null, phase: null,
    created_at: new Date(T0 + (o.t ?? seq) * MIN).toISOString(), ...o,
  };
}
const passRow = (rounds, extra = {}) => row({ rounds, round_converged_after: rounds, ...extra });
const opts = { windowStartMs: T0 - 1, nowMs: T0 + 10 * 86_400_000, gapHours: 24 };

describe('roundPassed', () => {
  it('code passes on the convergence stamp, plan only on APPROVE', () => {
    assert.equal(roundPassed(passRow(2)), true);
    assert.equal(roundPassed(row({ rounds: 2 })), false);
    assert.equal(roundPassed(row({ mode: 'plan', rounds: 3, gemini_verdict: 'APPROVE' })), true);
    assert.equal(roundPassed(row({ mode: 'plan', rounds: 3, gemini_verdict: 'CONCERNS' })), false);
    assert.equal(roundPassed(row({ mode: 'plan', rounds: 3, round_converged_after: 3 })), false, 'a stamp is not a plan pass');
  });
  it('an INCOMPLETE round is never a pass, even with a stamp', () => {
    assert.equal(roundPassed(passRow(1, { run_status: 'incomplete' })), false);
  });
});

describe('groupSessions', () => {
  it('rows repeating a round number are one session (re-runs), a strict drop starts a new one', () => {
    const rows = [row({ rounds: 1 }), row({ rounds: 2 }), row({ rounds: 2 }), passRow(3), row({ rounds: 1 }), passRow(2)];
    const { sessions } = groupSessions(rows);
    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions.map((s) => s.roundsToPass), [3, 2]);
  });
  it('counts DISTINCT rounds to the pass, so a counter not starting at 1 does not inflate it', () => {
    const rows = [row({ rounds: 51 }), row({ rounds: 52 }), passRow(53)];
    const [s] = groupSessions(rows).sessions;
    assert.equal(s.roundsToPass, 3);
    assert.equal(s.startsMidChain, true);
  });
  it('a long silence splits a thread even without a counter reset', () => {
    const rows = [row({ rounds: 1, t: 0 }), row({ rounds: 2, t: 60 * 30 }), passRow(3, { t: 60 * 30 + 5 })];
    assert.equal(groupSessions(rows, { gapHours: 24 }).sessions.length, 2);
  });
  it('audit_session_id wins over the inferred key and is scoped by repo', () => {
    const rows = [
      row({ mode: 'plan', rounds: 1, audit_session_id: 'S1', branch: 'a' }),
      row({ mode: 'plan', rounds: 2, audit_session_id: 'S1', branch: 'b', gemini_verdict: 'APPROVE' }),
      row({ mode: 'plan', rounds: 1, audit_session_id: 'S1', repo_id: 'repo-b', repo_name: 'o/b' }),
    ];
    const { sessions } = groupSessions(rows);
    assert.equal(sessions.length, 2, 'same id in another repo is another session');
    const a = sessions.find((s) => s.repoId === 'repo-a');
    assert.equal(a.groupedBy, 'session-id');
    assert.equal(a.roundsToPass, 2);
  });
  it('experiment rows and rounds=0 rows are excluded and COUNTED, never silently dropped', () => {
    const rows = [row({ rounds: 0 }), row({ assignment_id: 'x', rounds: 1 }), row({ arm_eval_run_id: 'y', rounds: 1 }), passRow(1)];
    const { sessions, excluded } = groupSessions(rows);
    assert.deepEqual(excluded, { experiment: 2, notFinalised: 1 });
    assert.equal(sessions.length, 1);
  });
  it('a pass AFTER a lost write is unknown (the pass round is uncertain), not a precise rounds-to-pass', () => {
    const rows = [row({ rounds: 1, run_status: 'incomplete' }), passRow(2)];
    const [s] = groupSessions(rows).sessions;
    assert.equal(s.unknown, true);
    assert.equal(s.passed, false);
    assert.equal(s.roundsToPass, null);
  });
  it('an identified session whose first fetched audit_round is above 1 is truncated', () => {
    const rows = [row({ mode: 'plan', rounds: 2, audit_round: 2, audit_session_id: 'S9' }), row({ mode: 'plan', rounds: 3, audit_round: 3, audit_session_id: 'S9', gemini_verdict: 'APPROVE' })];
    assert.equal(groupSessions(rows).sessions[0].truncatedHead, true);
  });
  it('flags a weak key (ad-hoc / detached HEAD) and a session with a lost write as unknown, not failed', () => {
    const rows = [row({ plan_file: 'ad-hoc', rounds: 1 }), row({ branch: 'b2', rounds: 1, run_status: 'incomplete' })];
    const { sessions } = groupSessions(rows);
    assert.equal(sessions.find((s) => s.planFile === 'ad-hoc').weakKey, true);
    assert.equal(sessions.find((s) => s.branch === 'b2').unknown, true);
  });
});

describe('metricsFor / buildReport', () => {
  it('computes the three headline numbers over passed sessions, beside the unpassed count', () => {
    const rows = [];
    // 4 sessions passing at 1,1,2,5 rounds + 1 never passing (settled)
    for (const [i, n] of [1, 1, 2, 5].entries()) {
      for (let r = 1; r < n; r += 1) rows.push(row({ branch: `b${i}`, rounds: r }));
      rows.push(passRow(n, { branch: `b${i}` }));
    }
    rows.push(row({ branch: 'dead', rounds: 1 }));
    const rep = buildReport(rows, opts);
    const m = rep.byMode.code.overall;
    assert.equal(m.status, 'measured');
    assert.equal(m.passed, 4);
    assert.equal(m.passedFirstRoundShare, 0.5);
    assert.equal(m.fiveOrMoreShare, 0.25);
    assert.equal(m.meanRoundsToPass, 2.25);
    assert.equal(m.medianRoundsToPass, 1.5);
    assert.equal(m.unpassedSettled, 1);
    assert.equal(m.passRate, 0.8);
  });
  it('zero eligible sessions reads unmeasured with null shares, never 0%', () => {
    const rep = buildReport([], opts);
    assert.equal(rep.byMode.code.overall.status, 'unmeasured');
    assert.equal(rep.byMode.code.overall.passedFirstRoundShare, null);
    assert.match(renderGroup('all', rep.byMode.code.overall), /UNMEASURED/);
    assert.match(summaryLine(rep), /unmeasured/);
  });
  it('sessions that never passed leave shares null, not zero, but pass rate is a real 0', () => {
    const rep = buildReport([row({ rounds: 1 })], opts);
    const m = rep.byMode.code.overall;
    assert.equal(m.status, 'unmeasured');
    assert.equal(m.passedFirstRoundShare, null);
    assert.equal(m.passRate, 0);
  });
  it('splits code from plan and repo from repo; sessions outside the window are counted', () => {
    const rows = [
      passRow(1), row({ mode: 'plan', rounds: 1, gemini_verdict: 'APPROVE', repo_id: 'repo-b', repo_name: 'o/b', branch: 'p' }),
      passRow(1, { branch: 'old', t: -60 * 24 * 20 }),
    ];
    const rep = buildReport(rows, { ...opts, windowStartMs: T0 - 1 });
    assert.equal(rep.byMode.code.overall.passed, 1);
    assert.deepEqual(Object.keys(rep.byMode.plan.byRepo), ['o/b']);
    assert.equal(rep.excluded.outsideWindowSessions, 1);
    assert.deepEqual(flattenReport(rep).map((r) => `${r.mode}:${r.repo}`), ['code:all repos', 'code:o/a', 'plan:all repos', 'plan:o/b']);
  });
  it('a session whose head sits at the fetch start is reported truncated, not measured', () => {
    const rows = [row({ rounds: 2, t: 0 }), passRow(3, { t: 5 })];
    const rep = buildReport(rows, { ...opts, windowStartMs: T0 - 1, fetchStartMs: T0 - 3 * MIN });
    assert.equal(rep.excluded.truncatedHeadSessions, 1);
    assert.equal(rep.byMode.code.overall.status, 'unmeasured');
  });
  it('an open (recent) unpassed session is not counted as a failure yet', () => {
    const m = metricsFor(groupSessions([row({ rounds: 1, t: 10 * 24 * 60 - 5 })]).sessions, { nowMs: opts.nowMs, gapHours: 24 });
    assert.equal(m.unpassedOpen, 1);
    assert.equal(m.unpassedSettled, 0);
  });
});

describe('review-driven contracts', () => {
  it('tied timestamps split identically whatever the input order', () => {
    const base = [
      row({ id: 'a1', rounds: 2, t: 5 }), row({ id: 'a2', rounds: 1, t: 5 }), passRow(2, { id: 'a3', t: 6 }),
    ];
    const fwd = groupSessions(base).sessions.map((s) => s.roundsToPass);
    const rev = groupSessions([...base].reverse()).sessions.map((s) => s.roundsToPass);
    assert.deepEqual(fwd, rev);
  });
  it('an identified session with no audit_round cannot show its head is complete, so it is truncated', () => {
    const rows = [row({ mode: 'plan', rounds: 1, audit_session_id: 'S7', gemini_verdict: 'APPROVE' })];
    assert.equal(groupSessions(rows).sessions[0].truncatedHead, true);
  });
  it('store row order (ord) breaks millisecond ties ahead of id', () => {
    const rows = [row({ id: 'z', rounds: 2, t: 5, ord: 0 }), passRow(3, { id: 'a', t: 5, ord: 1 })];
    const [s] = groupSessions([...rows].reverse()).sessions;
    assert.equal(s.roundsToPass, 2, 'ord 0 (round 2) precedes ord 1 even though id z sorts after a');
  });
  it('two repos sharing a display name are reported separately, never merged', () => {
    const rows = [passRow(1, { repo_id: 'id-one-aaaa', repo_name: 'same/name' }), passRow(1, { repo_id: 'id-two-bbbb', repo_name: 'same/name', branch: 'z' })];
    const rep = buildReport(rows, opts);
    assert.equal(Object.keys(rep.byMode.code.byRepo).length, 2);
    assert.ok(Object.keys(rep.byMode.code.byRepo).every((k) => k.includes('id-')), 'the full id disambiguates');
    assert.equal(rep.byMode.code.overall.passed, 2);
  });
  it('filters scope the exclusion counters too', () => {
    const rows = [row({ rounds: 0, repo_id: 'repo-b', repo_name: 'o/b' }), row({ rounds: 0 }), passRow(1)];
    assert.equal(buildReport(rows, { ...opts, repo: 'o/a' }).excluded.notFinalisedRows, 1);
    assert.equal(buildReport(rows, opts).excluded.notFinalisedRows, 2);
  });
  it('unmeasured groups still show counts and the pass rate', () => {
    const rep = buildReport([row({ rounds: 1 })], opts);
    const line = renderGroup('all', rep.byMode.code.overall);
    assert.match(line, /UNMEASURED/);
    assert.match(line, /sessions 1/);
    assert.match(line, /pass rate 0\.0%/);
  });
});

describe('CLI + dashboard surface', () => {
  it('a value flag with no value, or another flag as its value, exits 2', () => {
    for (const args of [['--days'], ['--repo', '--json'], ['--out'], ['--mode=']]) {
      const r = spawnSync(process.execPath, ['scripts/audit-convergence.mjs', ...args], { cwd: ROOT, encoding: 'utf-8' });
      assert.equal(r.status, 2, args.join(' '));
      assert.match(r.stderr, /needs a value/);
    }
  });
  it('--out is honoured on the cloud-off path too (file written, not an envelope on stdout)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-'));
    try {
      const out = path.join(dir, 'r.json');
      const r = spawnSync(process.execPath, ['scripts/audit-convergence.mjs', '--out', out], { cwd: ROOT, encoding: 'utf-8', env: { ...process.env, AUDIT_DB_URL: '' } });
      assert.equal(r.status, 0);
      assert.equal(JSON.parse(fs.readFileSync(out, 'utf-8')).reason, 'cloud-off');
      assert.match(r.stdout, /cloud-off/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
  it('rejects an unknown flag with exit 2 and passes the relocation smoke', () => {
    const bad = spawnSync(process.execPath, ['scripts/audit-convergence.mjs', '--nope'], { cwd: ROOT, encoding: 'utf-8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /unknown flag "--nope"/);
    const ok = spawnSync(process.execPath, ['scripts/audit-convergence.mjs', '--selfcheck-relocation'], { cwd: ROOT, encoding: 'utf-8' });
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /OK/);
  });
  it('--json stdout is exactly one JSON value even while env banners print (cloud-off path)', () => {
    const r = spawnSync(process.execPath, ['scripts/audit-convergence.mjs', '--json'], { cwd: ROOT, encoding: 'utf-8', env: { ...process.env, AUDIT_DB_URL: '' } });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.measured, false);
    assert.equal(parsed.reason, 'cloud-off');
  });
  it('rejects an out-of-range --days (would overflow Date) with exit 2', () => {
    const r = spawnSync(process.execPath, ['scripts/audit-convergence.mjs', '--days', '99999999999'], { cwd: ROOT, encoding: 'utf-8' });
    assert.equal(r.status, 2);
  });
  it('rejects a non-integer --days with exit 2', () => {
    const r = spawnSync(process.execPath, ['scripts/audit-convergence.mjs', '--days', 'abc'], { cwd: ROOT, encoding: 'utf-8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /positive integer/);
  });
  it('renderReport states every excluded count', () => {
    const text = renderReport(buildReport([row({ rounds: 0 }), passRow(1)], opts));
    assert.match(text, /1 unfinalised/);
    assert.match(text, /code audits/);
  });
  const ui = buildUi();
  const base = { cloud: true, windowDays: 30, asOf: '2026-11-12T00:00:00Z', excluded: { experimentRows: 0, notFinalisedRows: 3, truncatedHeadSessions: 0, outsideWindowSessions: 0 } };
  it('section shows shares beside counts, and "Unmeasured" rather than 0%', () => {
    const rep = buildReport([passRow(1)], opts);
    const html = sectionConvergence({ src: { status: 'ok', detail: '' }, convergence: { ...base, rows: flattenReport(rep) } }, ui);
    assert.match(html, /100\.0%/);
    const empty = sectionConvergence({
      src: { status: 'ok', detail: '' },
      convergence: { ...base, rows: flattenReport(buildReport([row({ rounds: 1 })], opts)) },
    }, ui);
    assert.match(empty, /Unmeasured/);
    assert.doesNotMatch(empty, /<td>0\.0%<\/td>/, 'no share cell may read 0%');
    assert.match(empty, /pass rate 0\.0%/, 'the pass rate is a real 0 and is shown');
  });
  it('section distinguishes unavailable from empty', () => {
    const html = sectionConvergence({ src: { status: 'missing-optional', detail: 'convergence metrics need the cloud store' }, convergence: { ...base, cloud: false, rows: [] } }, ui);
    assert.match(html, /need the cloud store/);
  });
});
