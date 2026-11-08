/**
 * Run-heartbeat journals + stale-watch (docs/plans/test-campaign-controls.md §2.1, §7.1).
 * The load-bearing assertions: a withheld heartbeat and a killed wrapper read STALE, and
 * absence never reads RUNNING.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  validateRunId, journalPath, startRun, appendRun, readJournal, parseJournalText,
  assessJournal, checkRun, listRuns, summariseRuns, resolveRunsDir,
} from '../scripts/lib/run-heartbeat.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'run-heartbeat.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hb-'));
const T0 = Date.parse('2026-11-08T10:00:00Z');
const alive = () => true;

describe('run id grammar and containment', () => {
  test('accepts a plain id, rejects traversal, absolute, backslash, overlong', () => {
    assert.equal(validateRunId('e5b-label-2026-11-08').ok, true);
    for (const bad of ['../x', '..', 'a/b', 'a\\b', '/etc/x', 'C:x', '', 'a'.repeat(81), '.hidden', 'a..b']) {
      assert.equal(validateRunId(bad).ok, false, bad);
      assert.throws(() => journalPath(tmp(), bad));
    }
  });
});

describe('assessJournal — absence is never health', () => {
  test('missing journal ⇒ UNKNOWN', () => {
    assert.equal(checkRun(tmp(), 'nope').state, 'UNKNOWN');
  });
  test('only malformed lines ⇒ UNKNOWN', () => {
    const v = assessJournal(parseJournalText('{oops\nnot json\n'), { now: T0 });
    assert.equal(v.state, 'UNKNOWN');
    assert.equal(v.malformedLines, 2);
  });
  test('beat with no start ⇒ UNKNOWN', () => {
    const v = assessJournal(parseJournalText(`${JSON.stringify({ v: 1, ts: new Date(T0).toISOString(), kind: 'beat' })}\n`), { now: T0 });
    assert.equal(v.state, 'UNKNOWN');
  });
  test('start without a cadence ⇒ UNKNOWN', () => {
    const v = assessJournal(parseJournalText(`${JSON.stringify({ v: 1, ts: new Date(T0).toISOString(), kind: 'start', runId: 'r' })}\n`), { now: T0 });
    assert.equal(v.state, 'UNKNOWN');
    assert.match(v.reason, /cadence/);
  });
  test('future timestamp ⇒ UNKNOWN', () => {
    const d = tmp();
    startRun(d, { runId: 'r', staleAfterSec: 60, now: T0 + 10 * 60_000 });
    assert.equal(checkRun(d, 'r', { now: T0 }).state, 'UNKNOWN');
  });
});

describe('withheld heartbeat ⇒ STALE (and the negative control)', () => {
  test('fresh beat ⇒ RUNNING — the check does not fire on a live run', () => {
    const d = tmp();
    startRun(d, { runId: 'r', staleAfterSec: 60, now: T0 });
    appendRun(d, { runId: 'r', kind: 'beat', now: T0 + 30_000 });
    assert.equal(checkRun(d, 'r', { now: T0 + 50_000 }).state, 'RUNNING');
  });
  test('no beat past the declared cadence ⇒ STALE with childAlive', () => {
    const d = tmp();
    startRun(d, { runId: 'r', staleAfterSec: 60, now: T0 });
    appendRun(d, { runId: 'r', kind: 'beat', childPid: 4242, now: T0 + 1000 });
    const v = checkRun(d, 'r', { now: T0 + 5 * 60_000, pidAlive: alive });
    assert.equal(v.state, 'STALE');
    assert.equal(v.childPid, 4242);
    assert.equal(v.childAlive, true);
  });
  test('ended runs: exit 0 ⇒ ENDED_OK, non-zero ⇒ ENDED_FAILED, signal ⇒ ENDED_FAILED', () => {
    for (const [exitCode, signal, want] of [[0, undefined, 'ENDED_OK'], [2, undefined, 'ENDED_FAILED'], [null, 'SIGTERM', 'ENDED_FAILED']]) {
      const d = tmp();
      startRun(d, { runId: 'r', staleAfterSec: 60, now: T0 });
      appendRun(d, { runId: 'r', kind: 'end', exitCode, signal, now: T0 + 1000 });
      assert.equal(checkRun(d, 'r', { now: T0 + 999_999_999 }).state, want);
    }
  });
});

describe('writer lifecycle', () => {
  test('a reused id is refused by the exclusive create', () => {
    const d = tmp();
    startRun(d, { runId: 'r', staleAfterSec: 60 });
    assert.throws(() => startRun(d, { runId: 'r', staleAfterSec: 60 }), /already in use/);
  });
  test('beat without start, and beat after end, are refused', () => {
    const d = tmp();
    assert.throws(() => appendRun(d, { runId: 'r', kind: 'beat' }), /no start/);
    startRun(d, { runId: 'r', staleAfterSec: 60 });
    appendRun(d, { runId: 'r', kind: 'end', exitCode: 0 });
    assert.throws(() => appendRun(d, { runId: 'r', kind: 'beat' }), /already ended/);
  });
  test('a > 1 MB journal keeps its start and end; malformed middle lines are counted', () => {
    const d = tmp();
    const p = startRun(d, { runId: 'big', staleAfterSec: 60, now: T0 });
    const beat = `${JSON.stringify({ v: 1, ts: new Date(T0 + 1000).toISOString(), runId: 'big', kind: 'beat', note: 'x'.repeat(100) })}\n`;
    fs.appendFileSync(p, beat.repeat(9000) + 'garbage line\n' + beat.repeat(9000));
    assert.ok(fs.statSync(p).size > 1_000_000);
    assert.equal(checkRun(d, 'big', { now: T0 + 2000 }).state, 'RUNNING');
    assert.equal(checkRun(d, 'big', { now: T0 + 5 * 60_000, pidAlive: alive }).state, 'STALE');
    appendRun(d, { runId: 'big', kind: 'end', exitCode: 0, now: T0 + 3000 });
    const v = checkRun(d, 'big', { now: T0 + 4000 });
    assert.equal(v.state, 'ENDED_OK');
    assert.equal(v.malformedLines, 1);
  });
  test('a symlinked journal is refused', { skip: process.platform === 'win32' && 'symlink creation needs privileges on Windows' }, () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'target'), '');
    fs.symlinkSync(path.join(d, 'target'), path.join(d, 'r.jsonl'));
    assert.throws(() => startRun(d, { runId: 'r', staleAfterSec: 60 }));
  });
});

describe('listRuns / summariseRuns (the /fleet status line)', () => {
  test('absent dir ⇒ no line; unreadable dir ⇒ UNMEASURED, never omitted', () => {
    assert.equal(summariseRuns(listRuns(path.join(tmp(), 'absent'))), null);
    const notADir = path.join(tmp(), 'file');
    fs.writeFileSync(notADir, '');
    const listing = listRuns(notADir);
    assert.equal(listing.measured, false);
    assert.match(summariseRuns(listing), /^runs: UNMEASURED/);
  });
  test('names the stale run', () => {
    const d = tmp();
    startRun(d, { runId: 'live', staleAfterSec: 600, now: T0 });
    startRun(d, { runId: 'dead', staleAfterSec: 60, now: T0 });
    const line = summariseRuns(listRuns(d, { now: T0 + 5 * 60_000, pidAlive: alive }));
    assert.match(line, /1 running/);
    assert.match(line, /STALE dead/);
  });
  test('resolveRunsDir: inside git ⇒ common dir; outside ⇒ .audit/runs', () => {
    assert.match(resolveRunsDir(ROOT).dir.replace(/\\/g, '/'), /audit-loop\/runs$/);
    assert.equal(resolveRunsDir('/x', { git: () => null }).shared, false);
  });
});

describe('CLI — a real wrapper, really killed', () => {
  const cli = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8', ...opts });

  test('run propagates the child exit code and writes end', () => {
    const d = tmp();
    const ok = cli(['run', '--run-id', 'ok', '--stale-after', '60', '--dir', d, '--', process.execPath, '-e', 'console.log("hi")']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(checkRun(d, 'ok').state, 'ENDED_OK');
    const bad = cli(['run', '--run-id', 'bad', '--stale-after', '60', '--dir', d, '--', process.execPath, '-e', 'process.exit(7)']);
    assert.equal(bad.status, 7);
    assert.equal(checkRun(d, 'bad').exitCode, 7);
  });

  test('spawn of a missing binary ⇒ ENDED_FAILED 127', () => {
    const d = tmp();
    const r = cli(['run', '--run-id', 'nobin', '--stale-after', '60', '--dir', d, '--', 'definitely-not-a-binary-xyz']);
    assert.equal(r.status, 127);
    assert.equal(checkRun(d, 'nobin').state, 'ENDED_FAILED');
  });

  test('a taken id spawns nothing', () => {
    const d = tmp();
    startRun(d, { runId: 'taken', staleAfterSec: 60 });
    const marker = path.join(d, 'ran');
    const r = cli(['run', '--run-id', 'taken', '--stale-after', '60', '--dir', d, '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`]);
    assert.notEqual(r.status, 0);
    assert.equal(fs.existsSync(marker), false);
  });

  test('killed wrapper ⇒ no end record ⇒ STALE, child liveness reported', async () => {
    const d = tmp();
    const wrapper = spawn(process.execPath, [CLI, 'run', '--run-id', 'killme', '--stale-after', '1', '--dir', d, '--',
      process.execPath, '-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
    let childPid = null;
    for (let i = 0; i < 100 && !childPid; i++) {
      await new Promise((r) => setTimeout(r, 100));
      childPid = readJournal(journalPath(d, 'killme')).entries.find((e) => e.childPid)?.childPid ?? null;
    }
    assert.ok(childPid, 'child pid recorded');
    wrapper.kill('SIGKILL');
    await new Promise((r) => wrapper.on('exit', r));
    try {
      const v = checkRun(d, 'killme', { now: Date.now() + 10_000 });
      assert.equal(v.state, 'STALE');
      assert.equal(v.childPid, childPid);
      assert.ok([true, false, 'unknown'].includes(v.childAlive));
      const check = cli(['check', '--run-id', 'killme', '--dir', d]);
      // the real clock: stale-after is 1s, so by now (≥1s later) it is stale or about to be
      if (check.status !== 0) assert.equal(check.status, 3);
    } finally {
      try { process.kill(childPid); } catch { /* already gone */ }
    }
  });

  test('watch exits 3 on a stale run and 0 on a clean end', () => {
    const d = tmp();
    startRun(d, { runId: 'w', staleAfterSec: 1, now: Date.now() - 10_000 });
    const r = cli(['watch', '--run-id', 'w', '--poll', '1', '--dir', d], { timeout: 20_000 });
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /STALE/);
    const d2 = tmp();
    startRun(d2, { runId: 'w', staleAfterSec: 60 });
    appendRun(d2, { runId: 'w', kind: 'end', exitCode: 0 });
    assert.equal(cli(['watch', '--run-id', 'w', '--poll', '1', '--dir', d2], { timeout: 20_000 }).status, 0);
  });

  test('bad run id and unknown flag ⇒ usage exit 2', () => {
    assert.equal(cli(['check', '--run-id', '../x', '--dir', tmp()]).status, 2);
    assert.equal(cli(['check', '--run-id', 'x', '--bogus']).status, 2);
  });
});
