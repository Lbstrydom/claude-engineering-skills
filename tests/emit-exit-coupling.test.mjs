/**
 * @fileoverview `emit({ok:false})` sets a non-zero exit code
 * (cross-skill-command-registry §2b F4, 2026-08-12), and the opt-out has to be
 * justified in place.
 *
 * THE DEFECT. `emit` was a bare `process.stdout.write` with no exit coupling at
 * all, so a CLI could report a failure in its envelope and still exit 0. Every
 * caller that checks `$?` — shell scripts, CI steps, the pre-push hook — read
 * that as success. Measured over the 124 captured cross-skill invocations
 * before F2/F3: **13** emitted `ok:false` at exit 0; after them, 0. That zero is
 * what makes this enforceable instead of a gate that cries wolf, which is why
 * the plan orders F4 last.
 *
 * The opt-out ratchet lives in `npm run emit:exit:gate`
 * (scripts/check-emit-exit-agreement.mjs) — this suite owns the primitive's
 * behaviour, that gate owns the population.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { emit } from '../scripts/lib/cli-io.mjs';

let written;
let realWrite;
let realExitCode;

beforeEach(() => {
  written = [];
  realWrite = process.stdout.write;
  realExitCode = process.exitCode;
  process.stdout.write = (s) => { written.push(s); return true; };
  process.exitCode = undefined;
});

afterEach(() => {
  process.stdout.write = realWrite;
  process.exitCode = realExitCode;
});

describe('emit — the envelope and the exit code must agree', () => {
  it('ok:true leaves the exit code alone', () => {
    emit({ ok: true, cloud: false });
    assert.equal(process.exitCode, undefined, 'a success envelope must not set an exit code');
    assert.equal(written.join(''), '{"ok":true,"cloud":false}\n');
  });

  it('ok:false sets exit 1', () => {
    emit({ ok: false, error: 'boom' });
    assert.equal(process.exitCode, 1, 'a failure envelope at exit 0 is the defect this closes');
  });

  it('the envelope is still written verbatim — the coupling changes the CODE, not the output', () => {
    emit({ ok: false, error: 'boom' });
    assert.equal(written.join(''), '{"ok":false,"error":"boom"}\n');
  });

  it('never LOWERS an exit code the CLI already chose', () => {
    // `||=`, not `=`. ux-lock-run exits 6 for strict-selector violations and
    // cross-skill exits 2 for argv errors; overwriting those with 1 would
    // destroy information the caller acts on.
    process.exitCode = 6;
    emit({ ok: false });
    assert.equal(process.exitCode, 6, 'a more specific exit code must survive');
  });

  it('a non-object, or an envelope with no `ok`, is left alone', () => {
    // `okless` envelopes exist by design (final-review-pending carries its
    // outcome in `state` and is exit 0 for all three). Treating absent as false
    // would fail a command whose contract has no `ok` to be false.
    emit({ schemaVersion: 1, state: 'disabled' });
    assert.equal(process.exitCode, undefined);
    emit('not an object');
    assert.equal(process.exitCode, undefined);
  });

  it('softFail opts out — but ONLY with a written reason', () => {
    emit({ ok: false }, { softFail: true, reason: 'a declined run is not a process failure' });
    assert.equal(process.exitCode, undefined, 'a justified opt-out must not set the code');
  });

  it('softFail WITHOUT a reason throws rather than silently exempting', () => {
    // A bare boolean is a silencer. An exemption that has to be justified in
    // place is a claim a reader can check — the same reasoning as the
    // registry's softFail and the durability oracle's NOT_A_DURABLE_WRITE.
    assert.throws(
      () => emit({ ok: false }, { softFail: true }),
      /requires a written `reason`/,
    );
  });

  it('softFail:false is not an opt-out (only an explicit true is)', () => {
    emit({ ok: false }, { softFail: false });
    assert.equal(process.exitCode, 1);
  });
});
