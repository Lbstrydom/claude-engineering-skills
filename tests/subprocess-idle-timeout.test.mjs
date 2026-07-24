/**
 * @fileoverview Tests for the extract idle-timeout (docs/plans/extract-idle-timeout.md).
 *
 * Two tiers, as the plan's §9 requires:
 *   - Tier A — deterministic `makeTimeoutController` state-machine tests with
 *     INJECTED timers (no subprocess, no wall-clock). These earn the word
 *     "deterministic".
 *   - Tier B — a small, generously-margined real-subprocess smoke, labelled
 *     timing-tolerant, that proves the wiring from runJsonLinesAsync down to a
 *     real child.kill. NOT asserted on timing precision.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  makeTimeoutController,
  runJsonLinesAsync,
  runJsonLinesAsyncStrict,
  SUBPROC_ERROR_CODES,
} from '../scripts/lib/subprocess.mjs';
import { buildExtractSpawnOpts } from '../scripts/symbol-index/refresh-subprocess.mjs';

const EXTRACT = path.join(process.cwd(), 'scripts', 'symbol-index', 'extract.mjs');
// The record types refresh.mjs consumes; a `progress` heartbeat is deliberately
// none of them, so it is dropped from the published snapshot.
const PUBLISHED_TYPES = ['symbol', 'violation', 'import', 'coverage', 'summary'];

// ── A fake clock: setTimeoutFn/clearTimeoutFn the controller can be driven by ──
function makeFakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map(); // id -> {at, fn}
  return {
    setTimeoutFn: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeoutFn: (id) => { timers.delete(id); },
    /** Advance the clock, firing due timers in time order. */
    advance(ms) {
      const target = now + ms;
      // Fire in chronological order; a fired timer may schedule/clear others.
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= target && (next === null || t.at < next.at)) next = { id, ...t };
        if (!next) break;
        now = next.at;
        timers.delete(next.id);
        next.fn();
      }
      now = target;
    },
    get pending() { return timers.size; },
  };
}

describe('makeTimeoutController — deterministic (injected timers, no subprocess)', () => {
  function harness({ timeoutMs, idleTimeoutMs, killGraceMs = 100 }) {
    const clock = makeFakeClock();
    const events = [];
    const ctrl = makeTimeoutController({
      timeoutMs, idleTimeoutMs, killGraceMs,
      sendTerm: () => events.push('term'),
      sendKill: () => events.push('kill'),
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });
    return { clock, events, ctrl };
  }

  it('onData resets the idle deadline; sustained output never kills', () => {
    const { clock, events, ctrl } = harness({ idleTimeoutMs: 100 });
    ctrl.arm();
    for (let i = 0; i < 10; i++) { clock.advance(60); ctrl.onData(); } // 600ms total, beat every 60ms
    assert.deepEqual(events, [], 'no term/kill — the deadline kept resetting');
    assert.equal(ctrl.timedOut, false);
  });

  it('silence past the idle threshold fires exactly one kill(idle)', () => {
    const { clock, events, ctrl } = harness({ idleTimeoutMs: 100 });
    ctrl.arm();
    ctrl.onData();
    clock.advance(150);            // no onData → idle expires at 100
    assert.deepEqual(events, ['term'], 'SIGTERM sent once');
    assert.equal(ctrl.killReason, 'idle');
    clock.advance(200);            // grace window → SIGKILL
    assert.deepEqual(events, ['term', 'kill']);
  });

  it('idempotent, first-reason-wins: the other timer cannot also fire', () => {
    const { clock, events, ctrl } = harness({ timeoutMs: 100, idleTimeoutMs: 300 });
    ctrl.arm();
    clock.advance(120);            // absolute fires first at 100
    assert.equal(ctrl.killReason, 'absolute');
    assert.deepEqual(events, ['term']);
    clock.advance(500);            // idle would have fired at 300 — but was cleared
    assert.deepEqual(events, ['term', 'kill'], 'only the grace SIGKILL follows, no second term');
  });

  it('dispose() (close/error path) is NOT a kill and clears every timer', () => {
    const { clock, events, ctrl } = harness({ timeoutMs: 100, idleTimeoutMs: 100 });
    ctrl.arm();
    ctrl.dispose();               // natural close
    clock.advance(1000);
    assert.deepEqual(events, [], 'no term/kill after dispose');
    assert.equal(ctrl.timedOut, false, 'a natural close never sets timedOut');
    assert.equal(clock.pending, 0, 'no dangling timers');
  });

  it('guards: 0 / negative / NaN / undefined idleTimeoutMs → idle never armed', () => {
    for (const bad of [0, -5, NaN, undefined]) {
      const { clock, events, ctrl } = harness({ idleTimeoutMs: bad });
      ctrl.arm();
      clock.advance(10_000);
      assert.deepEqual(events, [], `idleTimeoutMs=${bad} must not arm`);
    }
  });

  it('neither bound set → no timers, byte-identical to today', () => {
    const { clock, events, ctrl } = harness({});
    ctrl.arm();
    assert.equal(clock.pending, 0);
    clock.advance(10_000);
    assert.deepEqual(events, []);
  });
});

describe('buildExtractSpawnOpts — wiring pin (audit M2, no subprocess)', () => {
  it('passes hardTimeoutMs as idleTimeoutMs and NOT a total timeoutMs', () => {
    const opts = buildExtractSpawnOpts({ hardTimeoutMs: 300_000 });
    assert.equal(opts.idleTimeoutMs, 300_000, 'coverage hardTimeoutMs → idleTimeoutMs');
    assert.equal(opts.timeoutMs, undefined, 'must NOT arm an absolute total timeout (re-opens the truncation defect)');
    assert.equal(opts.stage, 'extract');
  });
});

// ── Tier B — real-subprocess smoke (timing-TOLERANT, not "deterministic") ─────
const IDLE = 1000; // generous; margins below are ≥4×

describe('runJsonLinesAsyncStrict idleTimeoutMs — real subprocess (timing-tolerant)', () => {
  it('a child that keeps streaming survives past its total lifetime', async () => {
    // Emits a record every ~IDLE/4 for ~5 beats (total ~1.25×IDLE of wall time,
    // but never IDLE-silent), then exits 0. Must NOT be killed.
    const src = `let n=0;const t=setInterval(()=>{process.stdout.write(JSON.stringify({type:'progress',n})+'\\n');if(++n>=5){clearInterval(t);process.exit(0);}}, ${Math.round(IDLE / 4)});`;
    const records = await runJsonLinesAsyncStrict('node', ['-e', src], { idleTimeoutMs: IDLE });
    assert.ok(records.length >= 5, 'all beats returned, no kill');
  });

  it('a child that goes silent past the threshold is terminated (assert outcome, not signal)', async () => {
    // Emits 2 beats, then sleeps ≫ IDLE with no output → idle kill.
    const src = `process.stdout.write('{"type":"progress","n":0}\\n');process.stdout.write('{"type":"progress","n":1}\\n');setTimeout(()=>process.exit(0), ${IDLE * 6});`;
    await assert.rejects(
      () => runJsonLinesAsyncStrict('node', ['-e', src], { idleTimeoutMs: IDLE, stage: 'smoke' }),
      (err) => {
        assert.equal(err.code, SUBPROC_ERROR_CODES.KILLED_BY_SIGNAL);
        assert.equal(err.cause?.timedOut, true);
        assert.equal(err.killReason, 'idle');
        assert.ok((err.cause?.records || []).length >= 2, 'pre-silence records preserved');
        return true;
      },
    );
  });
});

describe('extract.mjs per-file heartbeat (audit H1) — real subprocess on a fixture', () => {
  let tmp;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-hb-'));
    // Symbol-LESS files: `const X = 1` is not an arrow/function initializer, so
    // extractSymbols emits ZERO `symbol` records for these — the exact case
    // where incidental symbol output would leave a silent gap.
    fs.writeFileSync(path.join(tmp, 'a.mjs'), 'export const X = 1;\n');
    fs.writeFileSync(path.join(tmp, 'b.mjs'), 'export const Y = 2;\n');
  });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  it('emits a {type:progress, file} record per file even when the files yield no symbols', async () => {
    const res = await runJsonLinesAsync('node',
      [EXTRACT, '--root', tmp, '--files', 'a.mjs,b.mjs', '--mode', 'incremental']);
    const byType = {};
    for (const r of res.records) byType[r.type] = (byType[r.type] || 0) + 1;
    assert.equal(byType.symbol ?? 0, 0, 'fixture is symbol-less — proves progress is not incidental symbol output');
    const progress = res.records.filter(r => r.type === 'progress');
    assert.deepEqual(progress.map(p => p.file).sort(), ['a.mjs', 'b.mjs'], 'one heartbeat per file, carrying the path');
  });

  it('the progress type is not a published record type (dropped from the snapshot)', () => {
    // refresh.mjs filters records with `.filter(r => r.type === '<one of these>')`,
    // so a `progress` record can never reach the published snapshot.
    assert.ok(!PUBLISHED_TYPES.includes('progress'), 'progress is not consumed by any refresh filter');
  });
});
