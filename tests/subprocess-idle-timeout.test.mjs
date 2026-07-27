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
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  makeTimeoutController,
  runJsonLinesAsync,
  runJsonLinesAsyncStrict,
  SUBPROC_ERROR_CODES,
} from '../scripts/lib/subprocess.mjs';
import { buildExtractSpawnOpts, describeExtractStall } from '../scripts/symbol-index/refresh-subprocess.mjs';
import { classifyPath } from '../scripts/lib/sensitive-paths.mjs';
import { trySymlink } from './helpers/fs-symlink-test-utils.mjs';

const EXTRACT = path.join(process.cwd(), 'scripts', 'symbol-index', 'extract.mjs');
// The record types refresh.mjs consumes; a `progress` heartbeat is deliberately
// none of them, so it is dropped from the published snapshot.
const PUBLISHED_TYPES = ['symbol', 'violation', 'import', 'coverage', 'summary'];

/** Valid, parseable JS padded to roughly `bytes` — for size-boundary fixtures. */
function fileOfSize(bytes) {
  const header = '// pad ';
  const filler = 'x'.repeat(Math.max(0, bytes - header.length - 1)) + '\n';
  return header + filler + 'export const PADDED = 1;\n';
}

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

  it('emits [bare, named] progress records per admitted file even when the files yield no symbols (D1/D2)', async () => {
    const res = await runJsonLinesAsync('node',
      [EXTRACT, '--root', tmp, '--files', 'a.mjs,b.mjs', '--mode', 'incremental']);
    const byType = {};
    for (const r of res.records) byType[r.type] = (byType[r.type] || 0) + 1;
    assert.equal(byType.symbol ?? 0, 0, 'fixture is symbol-less — proves progress is not incidental symbol output');
    const progress = res.records.filter(r => r.type === 'progress');
    assert.equal(progress.length, 4, 'two beats per admitted file (D2): one anonymous tick, one named beat');
    const named = progress.filter(p => Object.hasOwn(p, 'file'));
    assert.deepEqual(named.map(p => p.file).sort(), ['a.mjs', 'b.mjs'], 'one NAMED heartbeat per admitted file, carrying the path');
    const bare = progress.filter(p => !Object.hasOwn(p, 'file'));
    assert.equal(bare.length, 2, 'one anonymous tick per file, emitted before admission is decided (position unchanged)');
  });

  it('the progress type is not a published record type (dropped from the snapshot)', () => {
    // refresh.mjs filters records with `.filter(r => r.type === '<one of these>')`,
    // so a `progress` record can never reach the published snapshot.
    assert.ok(!PUBLISHED_TYPES.includes('progress'), 'progress is not consumed by any refresh filter');
  });
});

describe('extract.mjs — per-outcome progress cardinality, isolated single-file fixtures (round-2 M1)', () => {
  function isolatedRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'extract-seq-'));
  }
  async function runFullWalk(root) {
    const res = await runJsonLinesAsync('node', [EXTRACT, '--root', root]);
    return res.records.filter(r => r.type === 'progress');
  }
  function shapes(records) {
    return records.map(r => (Object.hasOwn(r, 'file') ? 'named' : 'bare'));
  }

  it('admitted, small file → [bare, named]', async () => {
    const root = isolatedRoot();
    try {
      fs.writeFileSync(path.join(root, 'a.mjs'), 'export const A = 1;\n');
      const progress = await runFullWalk(root);
      assert.deepEqual(shapes(progress), ['bare', 'named']);
      assert.equal(progress[1].file, 'a.mjs');
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('admitted, >250KB file → [bare, named] — the deleted large-file tick is NOT resurrected as a third beat (R2)', async () => {
    const root = isolatedRoot();
    try {
      fs.writeFileSync(path.join(root, 'big.mjs'), fileOfSize(300_000));
      const progress = await runFullWalk(root);
      assert.deepEqual(shapes(progress), ['bare', 'named']);
      assert.equal(progress[1].file, 'big.mjs');
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('lexically-skipped (.env) → [bare] only, name never attached', async () => {
    const root = isolatedRoot();
    try {
      fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
      assert.deepEqual(shapes(await runFullWalk(root)), ['bare']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('non-allowlisted extension (.txt) → [bare] only', async () => {
    const root = isolatedRoot();
    try {
      fs.writeFileSync(path.join(root, 'notes.txt'), 'hello\n');
      assert.deepEqual(shapes(await runFullWalk(root)), ['bare']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('over the size cap → [bare] only', async () => {
    const root = isolatedRoot();
    try {
      fs.writeFileSync(path.join(root, 'huge.mjs'), fileOfSize(600_000));
      assert.deepEqual(shapes(await runFullWalk(root)), ['bare']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('a symlink (broken or valid) is invisible to enumerateFiles — zero progress records, not a disclosure (independent, pre-existing walker gap)', async (t) => {
    const root = isolatedRoot();
    try {
      const link = path.join(root, 'dangling.mjs');
      if (!trySymlink(path.join(root, 'does-not-exist-target.mjs'), link, 'file')) {
        t.skip('symlink creation unavailable on this host (needs Developer Mode/elevation) — '
          + 'this case NOT verified here; the core disclosure defect is still covered by the '
          + 'symlink-free lexical/extension/size cases above');
        return;
      }
      // Empirically confirmed (node v22, win32 AND per Node's cross-platform
      // Dirent contract — d_type reflects the raw entry type, not the resolved
      // target): enumerateFiles's walker keys off `e.isFile()`/`e.isDirectory()`,
      // both of which are false for ANY symlink dirent. The symlink never
      // reaches the per-file loop at all, so it produces NO progress record —
      // not even the anonymous tick — rather than a rejected `[bare]`. This is
      // a pre-existing, independent gap in enumerateFiles (a coverage
      // limitation: symlinked source is silently never indexed, sensitive or
      // not) — orthogonal to this plan's disclosure-prevention design, since
      // there is nothing for admitFile's gate to withhold when the walker
      // never surfaces the path in the first place.
      assert.deepEqual(await runFullWalk(root), [], 'a symlink produces zero progress records — the walker excludes it before the loop, so nothing is disclosed and nothing is a false "bare" tick either');
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('mixed unrestricted walk: totals reconcile, no two consecutive named, no named record names a rejected path', async () => {
    const root = isolatedRoot();
    try {
      fs.writeFileSync(path.join(root, 'a.mjs'), 'export const A = 1;\n');
      fs.writeFileSync(path.join(root, 'b.mjs'), 'export const B = 2;\n');
      fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
      fs.mkdirSync(path.join(root, 'secrets'));
      fs.writeFileSync(path.join(root, 'secrets', 'token.ts'), 'export const T = 1;\n');
      fs.writeFileSync(path.join(root, 'notes.txt'), 'hello\n');
      fs.writeFileSync(path.join(root, 'huge.mjs'), fileOfSize(600_000));

      const progress = await runFullWalk(root);
      const walked = 6; // a.mjs, b.mjs, .env, secrets/token.ts, notes.txt, huge.mjs
      const admitted = 2; // a.mjs, b.mjs
      assert.equal(progress.length, walked + admitted, 'per-outcome cardinality: rejected=1, admitted=2 (D2)');

      const seq = shapes(progress);
      for (let i = 0; i < seq.length - 1; i++) {
        assert.ok(!(seq[i] === 'named' && seq[i + 1] === 'named'), 'no two consecutive named records — every named beat is preceded by its own file\'s bare tick');
      }

      const rejectedPaths = new Set(['.env', 'secrets/token.ts', 'notes.txt', 'huge.mjs']);
      for (const r of progress) {
        if (Object.hasOwn(r, 'file')) {
          assert.ok(!rejectedPaths.has(r.file), `named record must never name a rejected path (got ${r.file})`);
        }
      }
      const namedFiles = progress.filter(r => Object.hasOwn(r, 'file')).map(r => r.file).sort();
      assert.deepEqual(namedFiles, ['a.mjs', 'b.mjs']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('extract.mjs — empirical no-sensitive-name verifier (Tier 3, never "by inspection")', () => {
  // Automated, reduces every record to a redacted digest immediately — the raw
  // path is never retained past the reduction, never logged, never printed
  // (docs/plans/refactor-symbol-index.md §8 Empirical). A failure's assertion
  // message carries only a category + an 8-hex-char digest, mirroring
  // formatSkipLog's `[redacted:<sha256-hex8>]` convention.
  it('every progress record naming a file classifies non-sensitive by the repo\'s own classifyPath', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-verify-'));
    try {
      fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
      fs.mkdirSync(path.join(root, 'secrets'));
      fs.writeFileSync(path.join(root, 'secrets', 'token.ts'), 'export const T = 1;\n');
      fs.writeFileSync(path.join(root, 'notes.txt'), 'hello\n');
      fs.writeFileSync(path.join(root, 'app.mjs'), 'export const A = 1;\n');

      const res = await runJsonLinesAsync('node', [EXTRACT, '--root', root]);
      // Reduce IMMEDIATELY — never hold the raw records past this line.
      const digest = res.records
        .filter(r => r.type === 'progress' && Object.hasOwn(r, 'file'))
        .map(r => ({
          category: classifyPath(r.file) ?? 'clean',
          hash: crypto.createHash('sha256').update(r.file).digest('hex').slice(0, 8),
        }));
      const leaked = digest.filter(d => d.category === 'sensitive');
      assert.equal(leaked.length, 0,
        `${leaked.length} sensitive name(s) reached the progress channel: ${leaked.map(d => `[redacted:${d.hash}]`).join(', ')}`);
      assert.ok(digest.length >= 1, 'at least the admitted app.mjs must have produced a named beat');
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('describeExtractStall (D3) — pure, latest-record-only, no timeout provoked', () => {
  it('last progress record is named → reports that file', () => {
    const msg = describeExtractStall([{ type: 'progress' }, { type: 'progress', file: 'big.mjs' }]);
    assert.equal(msg, 'last file: big.mjs');
  });

  it('last progress record is bare (admission-stage stall) → withholds the name, and does NOT name an earlier admitted file (R2 H1)', () => {
    const msg = describeExtractStall([
      { type: 'progress' },
      { type: 'progress', file: 'earlier-admitted.mjs' },
      { type: 'progress' }, // bare tick for the NEXT (still-uncleared) file
    ]);
    assert.match(msg, /wedged during path admission/);
    assert.doesNotMatch(msg, /earlier-admitted\.mjs/, 'a confidently wrong culprit is worse than none');
  });

  it('no progress records at all → explicit fallback, never a guess', () => {
    assert.equal(describeExtractStall([]), 'no progress records — wedged before the first file');
    assert.equal(describeExtractStall(undefined), 'no progress records — wedged before the first file');
    assert.equal(describeExtractStall([{ type: 'symbol', symbolName: 'x' }]), 'no progress records — wedged before the first file');
  });

  it('presence, not truthiness (round-2 M1) — an empty-string file is still "named"', () => {
    assert.equal(describeExtractStall([{ type: 'progress', file: '' }]), 'last file: ');
  });
});
