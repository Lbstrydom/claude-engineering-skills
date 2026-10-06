/**
 * @fileoverview Phase 1 of docs/plans/dashboard-home-summary.md — the five queue
 * reads extracted from the CLI, the failure classification built from a REAL
 * capture, and the line parser that matches the line writer.
 *
 * The classification fixture (`store-unreachable-envelopes.json`) is a recorded run
 * of each reader with the store unreachable; nothing in it is hand-written.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';

import {
  classifyReaderResult, gatherBacklogEnvelopes, execReader, KIND_TO_STATUS, READERS,
  STORE_UNREACHABLE_CODES, STORE_UNREACHABLE_NO_ENVELOPE_SIGNATURES,
} from '../scripts/lib/store/backlog-gather.mjs';
import { renderBacklogSnapshot, parseBacklogLine } from '../scripts/lib/store/backlog-snapshot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'dashboard-home', 'store-unreachable-envelopes.json'), 'utf8'));
const READER_KEYS = ['q1', 'q2', 'q3', 'upstream', 'debt'];


describe('classifyReaderResult — against the REAL capture', () => {
  test('the capture covers every reader in both modes (instrument is not vacuous)', () => {
    for (const mode of ['closed-port', 'empty-dsn']) {
      for (const reader of READER_KEYS) {
        assert.ok(FIXTURE.captures.some((c) => c.reader === reader && c.mode === mode), `${reader}/${mode} captured`);
      }
    }
    assert.ok(FIXTURE.captures.every((c) => c.envelope !== null), 'every reader printed an envelope');
  });

  test('closed port: every reader classifies store-unreachable from its ENVELOPE, whatever the exit code', () => {
    for (const c of FIXTURE.captures.filter((x) => x.mode === 'closed-port')) {
      const r = classifyReaderResult({ exitCode: c.exitCode, stdout: `${JSON.stringify(c.envelope)}\n`, reader: c.reader });
      assert.equal(r.kind, 'store-unreachable', `${c.reader}: ${JSON.stringify(r)}`);
      assert.equal(KIND_TO_STATUS[r.kind], 'missing-optional');
    }
  });

  test('closed port: the exit codes really do vary (the exit code alone cannot classify)', () => {
    const codes = new Set(FIXTURE.captures.filter((x) => x.mode === 'closed-port').map((x) => x.exitCode));
    assert.ok(codes.has(0) && codes.has(2), 'one reader exits 0 with an unavailable envelope, others exit 2');
  });

  test('empty DSN (air-gap): readers that answer say store-off; debt shares the unreachable signature', () => {
    for (const c of FIXTURE.captures.filter((x) => x.mode === 'empty-dsn')) {
      const r = classifyReaderResult({ exitCode: c.exitCode, stdout: JSON.stringify(c.envelope), reader: c.reader });
      assert.equal(r.kind, c.reader === 'debt' ? 'store-unreachable' : 'store-off', `${c.reader}: ${JSON.stringify(r)}`);
      assert.equal(KIND_TO_STATUS[r.kind], 'missing-optional');
    }
  });

  test('the fixture holds no DSN and no stderr text', () => {
    const text = JSON.stringify(FIXTURE);
    assert.doesNotMatch(text, /postgres(ql)?:\/\//i);
    assert.ok(FIXTURE.captures.every((c) => ['none', 'other', 'store-unreachable-notice', 'cloud-off-notice'].includes(c.stderrClass)));
  });
});

describe('classifyReaderResult — decision tree (synthetic)', () => {
  const j = (o) => JSON.stringify(o);
  test('1. aborted wins over everything, even a parseable ok envelope', () => {
    const r = classifyReaderResult({ exitCode: null, stdout: j({ ok: true, measured: true }), aborted: true, reader: 'q1' });
    assert.equal(r.kind, 'timeout');
    assert.equal(KIND_TO_STATUS.timeout, 'missing-optional');
  });
  test('3. exit 0 and no parseable envelope is malformed (unexpected-error)', () => {
    for (const stdout of ['', 'progress only\n', '{not json']) {
      const r = classifyReaderResult({ exitCode: 0, stdout, reader: 'q2' });
      assert.equal(r.kind, 'malformed');
      assert.equal(KIND_TO_STATUS[r.kind], 'unexpected-error');
    }
  });
  test('negative control: a non-zero exit with NO envelope is process-failed, never store-unreachable', () => {
    for (const reader of READER_KEYS) {
      for (const exitCode of [1, 2, 3, 137, null]) {
        const r = classifyReaderResult({ exitCode, stdout: 'Error: Cannot find module x\n', reader });
        assert.equal(r.kind, 'process-failed', `${reader}/${exitCode}`);
        assert.equal(KIND_TO_STATUS[r.kind], 'unexpected-error');
      }
    }
    assert.deepEqual([...STORE_UNREACHABLE_NO_ENVELOPE_SIGNATURES], [], 'the capture showed no envelope-less failure, so none is declared');
  });
  test('schema fault: a typed SQLSTATE is unexpected-error, not an unreachable store', () => {
    const a = classifyReaderResult({ exitCode: 2, stdout: j({ ok: false, error: { code: '42P01', message: 'relation missing' } }), reader: 'q1' });
    assert.equal(a.kind, 'schema-fault');
    const b = classifyReaderResult({ exitCode: 2, stdout: j({ ok: false, error: { code: 'LIST_FAILED', sqlstate: '42703', message: 'column x' } }), reader: 'upstream' });
    assert.equal(b.kind, 'schema-fault');
    const c = classifyReaderResult({ exitCode: 0, stdout: j({ state: 'unavailable', diagnostic: 'NOT_MIGRATED' }), reader: 'q3' });
    assert.equal(c.kind, 'schema-fault');
    assert.equal(KIND_TO_STATUS['schema-fault'], 'unexpected-error');
  });
  test('a generic code without connection evidence is process-failed (LIST_FAILED can be a bad query)', () => {
    const r = classifyReaderResult({ exitCode: 2, stdout: j({ ok: false, error: { code: 'LIST_FAILED', message: 'syntax error near FROM' } }), reader: 'upstream' });
    assert.equal(r.kind, 'process-failed');
  });
  test('an unknown ok:false code is process-failed and the detail never echoes message text', () => {
    const r = classifyReaderResult({ exitCode: 2, stdout: j({ ok: false, error: { code: 'WEIRD', message: 'secret postgresql://u:p@h/db' } }), reader: 'q1' });
    assert.equal(r.kind, 'process-failed');
    assert.doesNotMatch(r.detail, /postgres|secret/);
    const hostile = classifyReaderResult({ exitCode: 2, stdout: j({ ok: false, error: { code: 'postgresql://u:p@h/db' } }), reader: 'q1' });
    assert.doesNotMatch(hostile.detail, /postgres/);
  });
  test('2. store-off: cloud:false and measured:false/cloud-off, q3 disabled', () => {
    assert.equal(classifyReaderResult({ exitCode: 0, stdout: j({ ok: true, cloud: false }), reader: 'upstream' }).kind, 'store-off');
    assert.equal(classifyReaderResult({ exitCode: 0, stdout: j({ ok: true, cloud: true, measured: false, reason: 'cloud-off' }), reader: 'q1' }).kind, 'store-off');
    assert.equal(classifyReaderResult({ exitCode: 0, stdout: j({ state: 'disabled' }), reader: 'q3' }).kind, 'store-off');
  });
  test('ok only when the reader says measured; an unmeasured non-store-off answer is process-failed', () => {
    assert.equal(classifyReaderResult({ exitCode: 0, stdout: j({ ok: true, cloud: true, measured: true, scope: { mode: 'repo' }, byMode: { code: 1, plan: 2 } }), reader: 'q1' }).kind, 'ok');
    assert.equal(classifyReaderResult({ exitCode: 0, stdout: j({ state: 'ready', counts: { totalActionable: 3 } }), reader: 'q3' }).kind, 'ok');
    assert.equal(classifyReaderResult({ exitCode: 0, stdout: j({ ok: true, verdict: 'measured', cloudTotal: 1, localTotal: 2 }), reader: 'debt' }).kind, 'ok');
    assert.equal(classifyReaderResult({ exitCode: 0, stdout: j({ ok: true, upstream: 1, cloud: true, total: 3 }), reader: 'upstream' }).kind, 'ok');
    assert.equal(classifyReaderResult({ exitCode: 0, stdout: j({ ok: true, cloud: true, measured: false, reason: 'no-identity' }), reader: 'q1' }).kind, 'process-failed');
    assert.equal(classifyReaderResult({ exitCode: 0, stdout: j({ ok: true, verdict: 'unverifiable' }), reader: 'debt' }).kind, 'process-failed');
  });
  test('H6b: an envelope lacking the counts the formatter needs is NEVER a measured answer ({} included)', () => {
    for (const reader of ['q1', 'q2']) {
      for (const env of [{}, { ok: true }, { ok: true, cloud: true, measured: true }, { ok: true, byMode: { code: 1 } }, { ok: true, byMode: { code: 'x', plan: 2 } }]) {
        const r = classifyReaderResult({ exitCode: 0, stdout: j(env), reader });
        assert.equal(r.kind, 'process-failed', `${reader} ${j(env)}`);
      }
    }
    assert.equal(classifyReaderResult({ exitCode: 0, stdout: j({ state: 'ready' }), reader: 'q3' }).kind, 'process-failed');
    assert.equal(classifyReaderResult({ exitCode: 0, stdout: j({ verdict: 'measured' }), reader: 'debt' }).kind, 'process-failed');
    assert.equal(classifyReaderResult({ exitCode: 0, stdout: j({ ok: true }), reader: 'upstream' }).kind, 'process-failed');
  });
  test('M11: a typed SQLSTATE OVERRIDES a connectivity code or the debt reason signature', () => {
    const debt = classifyReaderResult({ exitCode: 2, stdout: j({ ok: false, verdict: 'unverifiable', reason: 'repo-identity-unresolved', sqlstate: '42P01' }), reader: 'debt' });
    assert.equal(debt.kind, 'schema-fault');
    const coded = classifyReaderResult({ exitCode: 2, stdout: j({ ok: false, error: { code: 'REPO_RESOLVE_FAILED', sqlstate: '42P01', message: 'connect ECONNREFUSED' } }), reader: 'q1' });
    assert.equal(coded.kind, 'schema-fault');
    // and the reason alone (no SQLSTATE) is still the captured unreachable signature
    assert.equal(classifyReaderResult({ exitCode: 2, stdout: j({ ok: false, verdict: 'unverifiable', reason: 'repo-identity-unresolved' }), reader: 'debt' }).kind, 'store-unreachable');
    // the fixture holds no SQLSTATE: every captured envelope still classifies as before
    assert.equal(JSON.stringify(FIXTURE).includes('42P01'), false);
  });
  test('a measured-looking envelope from a NON-zero exit is process-failed, not ok', () => {
    const r = classifyReaderResult({ exitCode: 1, stdout: j({ ok: true, cloud: true, measured: true, scope: { mode: 'repo' } }), reader: 'q1' });
    assert.equal(r.kind, 'process-failed');
  });
  test('the envelope is read from the LAST JSON line, whatever the exit code', () => {
    const stdout = `progress\n${j({ ok: true, cloud: false })}\nmore progress\n${j({ ok: false, error: { code: 'CLOUD_UNREACHABLE' } })}\n`;
    assert.equal(classifyReaderResult({ exitCode: 2, stdout, reader: 'q1' }).kind, 'store-unreachable');
  });
  test('STORE_UNREACHABLE_CODES is a closed list', () => {
    assert.deepEqual([...STORE_UNREACHABLE_CODES].sort(), ['CLOUD_UNREACHABLE', 'LIST_FAILED', 'REPO_RESOLVE_FAILED']);
  });
});

const GOOD = {
  q1: { ok: true, cloud: true, measured: true, scope: { mode: 'repo' }, rows: new Array(20).fill({}), byMode: { total: 51, code: 26, plan: 25 }, agedOut: 190 },
  q2: { ok: true, cloud: true, measured: true, scope: { mode: 'repo' }, total: 168, byMode: { total: 168, code: 80, plan: 88 }, byDisposition: { open: 168, acceptedPermanent: 50 } },
  q3: { state: 'ready', cloud: true, counts: { totalActionable: 486 } },
  upstream: { ok: true, cloud: true, rows: [] },
  debt: { ok: true, verdict: 'measured', cloudTotal: 173, localTotal: 106, undrainedSpills: 0 },
};
const GOLDEN = 'Backlog 2026-09-04T09:14Z: Q1 26c/25p (+190 aged) · Q2 80c/88p (50 perm) · Q3 486 · debt 173 cloud/106 local (0 spilled) · upstream 0';
const AT = new Date('2026-09-04T09:14:32.000Z');

/** A fake runner keyed on the script + first arg, echoing canned envelopes. */
function fakeRun(table, calls = []) {
  return async ({ script, args }) => {
    calls.push({ script: path.basename(script), args });
    const key = path.basename(script) === 'debt-reconcile.mjs' ? 'debt'
      : args[0] === 'list-unlocked-fixes' ? 'q1' : args[0] === 'list-unremediated-acceptances' ? 'q2'
        : args[0] === 'final-review-pending' ? 'q3' : 'upstream';
    const r = table[key];
    return { exitCode: r.exitCode ?? 0, stdout: `progress line\n${JSON.stringify(r.envelope)}\n`, aborted: false };
  };
}

describe('gatherBacklogEnvelopes', () => {
  test('golden: the envelopes it returns render the byte-identical CLI line', async () => {
    const calls = [];
    const { envelopes, outcomes } = await gatherBacklogEnvelopes({
      repo: 'owner/repo', run: fakeRun(Object.fromEntries(Object.entries(GOOD).map(([k, v]) => [k, { envelope: v }])), calls),
    });
    assert.equal(renderBacklogSnapshot({ ...envelopes, at: AT }), GOLDEN);
    assert.deepEqual(Object.keys(outcomes).sort(), [...READER_KEYS].sort());
    assert.ok(Object.values(outcomes).every((o) => o.kind === 'ok'), JSON.stringify(outcomes));
    assert.deepEqual(calls.find((c) => c.args[0] === 'final-review-pending').args, ['final-review-pending', '--repo', 'owner/repo']);
    assert.deepEqual(calls.find((c) => c.script === 'debt-reconcile.mjs').args, ['--json']);
  });

  test('null on failure, never an empty envelope: garbage, non-zero exit and a throw all yield null', async () => {
    const run = async ({ args }) => {
      if (args[0] === 'list-unlocked-fixes') return { exitCode: 0, stdout: 'garbage', aborted: false };
      if (args[0] === 'list-unremediated-acceptances') return { exitCode: 2, stdout: JSON.stringify({ ok: false, error: { code: 'CLOUD_UNREACHABLE' } }), aborted: false };
      if (args[0] === 'final-review-pending') throw new Error('spawn failed');
      return { exitCode: 0, stdout: JSON.stringify(GOOD.upstream), aborted: false };
    };
    const { envelopes, outcomes } = await gatherBacklogEnvelopes({ repo: 'o/r', run });
    assert.equal(envelopes.q1, null);
    assert.equal(envelopes.q2, null);
    assert.equal(envelopes.q3, null);
    assert.deepEqual(envelopes.upstream, GOOD.upstream);
    assert.equal(outcomes.q1.kind, 'malformed');
    assert.equal(outcomes.q2.kind, 'store-unreachable');
    assert.equal(outcomes.q3.kind, 'process-failed');
    const line = renderBacklogSnapshot({ ...envelopes, at: AT });
    assert.match(line, /Q1 unmeasured · Q2 unmeasured · Q3 unmeasured/);
  });

  test('Q3 is not asked without a repo slug (the CLI never spawned it), and says why', async () => {
    const calls = [];
    const { envelopes, outcomes } = await gatherBacklogEnvelopes({ repo: '', run: fakeRun({ q1: { envelope: GOOD.q1 }, q2: { envelope: GOOD.q2 }, q3: { envelope: GOOD.q3 }, upstream: { envelope: GOOD.upstream }, debt: { envelope: GOOD.debt } }, calls) });
    assert.equal(envelopes.q3, null);
    assert.equal(outcomes.q3.kind, 'store-off');
    assert.equal(calls.some((c) => c.args[0] === 'final-review-pending'), false);
  });

  test('the five reads run in PARALLEL (wall clock ~ max, not sum)', async () => {
    const run = async ({ args }) => {
      await new Promise((r) => setTimeout(r, 250));
      return { exitCode: 0, stdout: JSON.stringify(args[0] === 'upstream' ? GOOD.upstream : { ok: true, cloud: false }), aborted: false };
    };
    const t0 = Date.now();
    await gatherBacklogEnvelopes({ repo: 'o/r', run });
    assert.ok(Date.now() - t0 < 900, `took ${Date.now() - t0}ms; sequential would be >= 1250`);
  });

  test('an AbortSignal reaches every read and a timed-out reader is classified timeout', async () => {
    const ac = new AbortController();
    const seen = [];
    const run = ({ signal }) => new Promise((resolve) => {
      seen.push(signal);
      signal.addEventListener('abort', () => resolve({ exitCode: null, stdout: '', aborted: true }));
    });
    const p = gatherBacklogEnvelopes({ repo: 'o/r', run, signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    const { envelopes, outcomes } = await p;
    assert.equal(seen.length, 5);
    assert.ok(seen.every((s) => s === ac.signal));
    assert.ok(Object.values(outcomes).every((o) => o.kind === 'timeout'));
    assert.ok(Object.values(envelopes).every((e) => e === null));
  });
});

describe('execReader (real child processes)', () => {
  test('H2: a reader that traps SIGTERM is still killed, and the result waits for its close', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-gather-'));
    try {
      const pidFile = path.join(dir, 'pid.txt');
      const script = path.join(dir, 'stubborn.mjs');
      fs.writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n`);
      const t0 = Date.now();
      const r = await execReader({ script, args: [], cwd: dir, timeoutMs: 800, graceMs: 300, closeWaitMs: 5000 });
      assert.equal(r.aborted, true);
      assert.equal(r.childExited, true, 'resolved only after the child closed');
      assert.ok(Date.now() - t0 < 8000);
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      assert.throws(() => process.kill(pid, 0), 'the child must be gone, not merely abandoned');
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  /** A fake child process: records kill signals; `dieOn` names the signal that makes it close. */
  function fakeSpawn({ dieOn }) {
    const log = { signals: [], closedBeforeResolve: null, closed: false };
    const spawnFn = () => {
      const child = new EventEmitter();
      child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
      child.stderr = { resume() {} };
      child.kill = (sig) => {
        log.signals.push(sig);
        if (sig === dieOn) setImmediate(() => { log.closed = true; child.emit('close', null); });
        return true;
      };
      return child;
    };
    return { spawnFn, log };
  }

  test('H2 (deterministic): SIGTERM is ignored => SIGKILL after the grace, and the result resolves only AFTER the close', async () => {
    const { spawnFn, log } = fakeSpawn({ dieOn: 'SIGKILL' });
    const r = await execReader({ script: 'x', args: [], cwd: '.', timeoutMs: 30, graceMs: 60, closeWaitMs: 2000, spawnFn });
    log.closedBeforeResolve = log.closed;
    assert.deepEqual(log.signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(r.aborted, true);
    assert.equal(r.childExited, true);
    assert.equal(log.closedBeforeResolve, true, 'the promise must not resolve before the child closed');
  });

  test('H2 (deterministic): a child that NEVER closes resolves after grace + bounded wait with childExited:false', async () => {
    const { spawnFn, log } = fakeSpawn({ dieOn: 'never' });
    const t0 = Date.now();
    const r = await execReader({ script: 'x', args: [], cwd: '.', timeoutMs: 20, graceMs: 30, closeWaitMs: 100, spawnFn });
    assert.equal(r.childExited, false);
    assert.equal(r.aborted, true);
    assert.deepEqual(log.signals, ['SIGTERM', 'SIGKILL']);
    assert.ok(Date.now() - t0 < 2000);
  });

  test('H2: a child that never closes is reported "child did not exit", not as released', async () => {
    const { outcomes } = await gatherBacklogEnvelopes({ repo: 'o/r', run: async () => ({ exitCode: null, stdout: '', aborted: true, childExited: false }) });
    assert.ok(Object.values(outcomes).every((o) => o.kind === 'timeout' && /child did not exit/.test(o.detail)));
  });

  test('a reader past its timeout is killed, reported aborted, and returns promptly', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-gather-'));
    try {
      const script = path.join(dir, 'sleeper.mjs');
      fs.writeFileSync(script, 'setTimeout(() => {}, 60000);\n');
      const t0 = Date.now();
      const r = await execReader({ script, args: [], cwd: dir, timeoutMs: 400 });
      assert.equal(r.aborted, true);
      assert.ok(Date.now() - t0 < 10_000);
      assert.equal(classifyReaderResult({ ...r, reader: 'q1' }).kind, 'timeout');
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  test('a non-zero exit keeps stdout so the envelope can still classify it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-gather-'));
    try {
      const script = path.join(dir, 'fail.mjs');
      fs.writeFileSync(script, `console.log(JSON.stringify({ ok: false, error: { code: 'CLOUD_UNREACHABLE' } })); process.exit(2);\n`);
      const r = await execReader({ script, args: [], cwd: dir, timeoutMs: 20_000 });
      assert.equal(r.exitCode, 2);
      assert.equal(r.aborted, false);
      assert.equal(classifyReaderResult({ ...r, reader: 'q1' }).kind, 'store-unreachable');
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

describe('the CLI still prints the line it always printed', () => {
  test('hermetic air-gap run: every queue renders unmeasured, exit 0, one line', () => {
    const base = {};
    for (const k of ['PATH', 'Path', 'SYSTEMROOT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) if (process.env[k]) base[k] = process.env[k];
    const r = spawnSync(process.execPath, [path.join(HERE, '..', 'scripts', 'backlog-snapshot.mjs'), '--json'], {
      cwd: path.join(HERE, '..'), encoding: 'utf8', timeout: 120_000,
      env: { ...base, AUDIT_DB_URL: '', LEARNING_REPO_NAME: 'owner/repo' },
    });
    assert.equal(r.status, 0, r.stderr);
    const env = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(env.ok, true);
    assert.match(env.line, /^Backlog \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z: Q1 unmeasured · Q2 unmeasured · Q3 unmeasured · debt unmeasured · upstream unmeasured$/);
  });
});

describe('parseBacklogLine — the reader matching renderBacklogSnapshot', () => {
  test('round-trips what the writer produced (the golden line)', () => {
    assert.deepEqual(parseBacklogLine(GOLDEN), {
      at: '2026-09-04T09:14Z',
      q1: { code: 26, plan: 25, aged: 190 },
      q2: { code: 80, plan: 88, perm: 50 },
      q3: 486,
      debt: { cloud: 173, local: 106, spilled: 0 },
      upstream: { total: 0, partial: false },
    });
  });
  test('round-trips unmeasured segments as null, distinct from zero', () => {
    const line = renderBacklogSnapshot({ q1: null, q2: GOOD.q2, q3: { state: 'disabled' }, debt: null, upstream: null, at: AT });
    const p = parseBacklogLine(line);
    assert.equal(p.q1, null);
    assert.equal(p.q3, null);
    assert.equal(p.debt, null);
    assert.equal(p.upstream, null);
    assert.deepEqual(p.q2, { code: 80, plan: 88, perm: 50 });
  });
  test('round-trips optional tails (no aged / no perm / unknown spill / partial upstream)', () => {
    const line = renderBacklogSnapshot({
      q1: { ...GOOD.q1, agedOut: undefined }, q2: { ...GOOD.q2, byDisposition: {} }, q3: GOOD.q3,
      debt: { ...GOOD.debt, undrainedSpills: null }, upstream: { ok: true, cloud: true, rows: [1, 2], nextCursor: 'c' }, at: AT,
    });
    const p = parseBacklogLine(line);
    assert.equal(p.q1.aged, null);
    assert.equal(p.q2.perm, null);
    assert.equal(p.debt.spilled, null);
    assert.deepEqual(p.upstream, { total: 2, partial: true });
  });
  test('parses a REAL line copied from this repo status.md (2026-10-06)', () => {
    const real = 'Backlog 2026-10-06T04:56Z: Q1 68c/8p (+353 aged) · Q2 89c/42p (54 perm) · Q3 35 · debt 303 cloud/67 local (0 spilled) · upstream 1';
    assert.deepEqual(parseBacklogLine(real), {
      at: '2026-10-06T04:56Z',
      q1: { code: 68, plan: 8, aged: 353 }, q2: { code: 89, plan: 42, perm: 54 }, q3: 35,
      debt: { cloud: 303, local: 67, spilled: 0 }, upstream: { total: 1, partial: false },
    });
    const withDebtUnmeasured = 'Backlog 2026-10-03T12:42Z: Q1 68c/23p (+338 aged) · Q2 101c/60p (54 perm) · Q3 35 · debt unmeasured · upstream 1';
    assert.equal(parseBacklogLine(withDebtUnmeasured).debt, null);
  });
  test('anything that is not exactly the grammar is null as a WHOLE (no half-parsed line)', () => {
    for (const bad of ['', 'hello', null, undefined, 42,
      'Backlog 2026-10-06T04:56Z: Q1 68c/8p · Q2 89c/42p · Q3 35 · debt unmeasured',
      'Backlog 2026-10-06T04:56Z: Q1 68c · Q2 89c/42p · Q3 35 · debt unmeasured · upstream 1',
      'Backlog 2026-10-06: Q1 68c/8p · Q2 89c/42p · Q3 35 · debt unmeasured · upstream 1']) {
      assert.equal(parseBacklogLine(bad), null, String(bad));
    }
  });
  test('tolerates CRLF / surrounding whitespace from a Windows checkout', () => {
    assert.equal(parseBacklogLine(`  ${GOLDEN}\r`).q3, 486);
  });
});
