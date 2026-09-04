/**
 * @fileoverview Contract for `tests/helpers/consumer-fixture.mjs` — the shared
 * bounding/seeding helper three sync suites depend on.
 *
 * Its defects are invisible from those suites: they would still pass while
 * silently testing something weaker. So the helper gets its own assertions.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  syncExecOptions, INSTALL_ENV, syncBudgetMs, syncBudgetForEnv, whySyncFailed, runSyncCli, COPY_ONLY_CEILING_MS,
} from './helpers/consumer-fixture.mjs';
import { installTimeouts, MAX_TIMEOUT_MS } from '../scripts/lib/install/deps.mjs';

describe('syncExecOptions', () => {
  it('a caller-supplied env does NOT drop the install caps', () => {
    // Round-2 code audit M2. `...extra` spread last meant any caller `env`
    // replaced the whole object, so the child would fall back to production
    // defaults while the parent's budget stayed derived from INSTALL_ENV —
    // the outer-bound-is-tighter bug, re-created.
    const o = syncExecOptions({ env: { MY_VAR: 'x' } });
    assert.equal(o.env.MY_VAR, 'x', 'the caller value must survive');
    for (const [k, v] of Object.entries(INSTALL_ENV)) {
      assert.equal(o.env[k], v, `${k} must survive a caller-supplied env`);
    }
    assert.ok('PATH' in o.env || 'Path' in o.env, 'the inherited environment must survive too');
  });

  it('a caller may still override an install cap deliberately', () => {
    // Vacuous-pass guard for the precedence order: if INSTALL_ENV simply won,
    // the assertion above would pass while the documented precedence was wrong.
    const o = syncExecOptions({ env: { AUDIT_DEPS_INSTALL_TIMEOUT_MS: '42' } });
    assert.equal(o.env.AUDIT_DEPS_INSTALL_TIMEOUT_MS, '42');
  });

  it('an explicit timeout override is REFUSED, not silently discarded', () => {
    // Round-5 M2 fixed the silent-discard version of this bug (`...extra`
    // after `timeout:` let a caller hand back exactly the hand-picked number
    // this module exists to remove). Round-6 M1 caught what that fix left
    // behind: the JSDoc still advertised the full `ExecFileOptions` shape,
    // so "silently discarded" was still a surprise from the type's own
    // promise. Now it throws, naming why, and the type no longer claims to
    // accept the field it rejects.
    assert.throws(() => syncExecOptions({ timeout: 5 }), /not a supported option/);
  });

  it('carries the derived budget, never a hand-picked one', () => {
    assert.equal(syncExecOptions().timeout, syncBudgetMs);
  });
});

describe('whySyncFailed', () => {
  it('names a KILL as a kill rather than printing a null exit code', () => {
    const msg = whySyncFailed({ code: null, signal: 'SIGTERM', out: 'tail' });
    assert.match(msg, /KILLED/);
    assert.match(msg, new RegExp(String(syncBudgetMs)));
  });

  it('still reports an ordinary non-zero exit as an exit', () => {
    const msg = whySyncFailed({ code: 1, signal: null, out: 'boom' });
    assert.match(msg, /exit 1/);
    assert.doesNotMatch(msg, /KILLED/);
  });
});

describe('the parent budget is never the tighter bound', () => {
  it('a caller who raises the child cap raises the parent budget with it', () => {
    // Round-3 H1/M1 — a regression this file shipped and the audit caught. Once
    // syncExecOptions let a caller override AUDIT_DEPS_*, the timeout was still
    // a module constant: a caller raising the required cap to 900s got a 600s
    // parent, i.e. the parent tighter than the child. Measured before the fix.
    const o = syncExecOptions({ env: { AUDIT_DEPS_INSTALL_TIMEOUT_MS: '900000' } });
    assert.ok(o.timeout >= 900_000,
      `parent budget ${o.timeout}ms must cover a child cap of 900000ms`);
  });

  it('holds for every phase, and for both caps at once', () => {
    for (const env of [
      { AUDIT_DEPS_INSTALL_TIMEOUT_MS: '900000' },
      { AUDIT_DEPS_OPTIONAL_INSTALL_TIMEOUT_MS: '1200000' },
      { AUDIT_DEPS_INSTALL_TIMEOUT_MS: '900000', AUDIT_DEPS_OPTIONAL_INSTALL_TIMEOUT_MS: '1200000' },
      {},
    ]) {
      const o = syncExecOptions({ env });
      const caps = installTimeouts({ env: o.env });
      assert.ok(o.timeout >= caps.totalMs,
        `budget ${o.timeout} < child total ${caps.totalMs} for ${JSON.stringify(env)}`);
    }
  });

  it('an INVALID caller cap cannot shrink the budget below the copy-only floor', () => {
    // The direction a naive derivation gets wrong: junk falls back to the
    // defaults, so the budget must not collapse toward zero with it.
    const o = syncExecOptions({ env: { AUDIT_DEPS_INSTALL_TIMEOUT_MS: '0' } });
    assert.ok(o.timeout >= COPY_ONLY_CEILING_MS, `budget collapsed to ${o.timeout}`);
  });

  it('syncBudgetForEnv REFUSES the case it cannot honestly cover', () => {
    // Round-5 M1/M3: silently clamping here (the old behaviour) returns a
    // parent budget BELOW what the child's own caps demand -- the exact
    // invariant this module exists to hold, violated by its own escape hatch.
    // There is no smaller-but-correct number to return, so it throws instead.
    const huge = { AUDIT_DEPS_INSTALL_TIMEOUT_MS: String(MAX_TIMEOUT_MS), AUDIT_DEPS_OPTIONAL_INSTALL_TIMEOUT_MS: String(MAX_TIMEOUT_MS) };
    assert.throws(() => syncBudgetForEnv(huge), /Node's timer maximum/);
  });

  it('the invariant holds -- or the call throws -- for every representable env', () => {
    // Vacuous-pass guard for the throw above: a version that threw
    // UNCONDITIONALLY would also pass a bare assert.throws. This sweeps values
    // up to (but not past) the boundary and requires EITHER the covering
    // property to hold OR an explicit throw -- never a silent short-fall.
    for (const requiredMs of [1, 300_000, MAX_TIMEOUT_MS]) {
      for (const optionalMs of [1, 600_000, MAX_TIMEOUT_MS]) {
        const env = {
          AUDIT_DEPS_INSTALL_TIMEOUT_MS: String(requiredMs),
          AUDIT_DEPS_OPTIONAL_INSTALL_TIMEOUT_MS: String(optionalMs),
        };
        let budget;
        try { budget = syncBudgetForEnv(env); }
        catch (err) {
          assert.match(err.message, /Node's timer maximum/, `unexpected throw for ${JSON.stringify(env)}`);
          continue;
        }
        const caps = installTimeouts({ env });
        assert.ok(budget >= caps.totalMs, `budget ${budget} < child total ${caps.totalMs} for ${JSON.stringify(env)}`);
      }
    }
  });
});

describe('runSyncCli — one wrapper, one reported budget', () => {
  it('carries the budget the call actually ran under', async () => {
    // Round-4 M1/M3. whySyncFailed quoted the module constant, so a caller that
    // composed its own env got a diagnostic naming a timeout that never applied.
    const r = await runSyncCli(['--dry-run', '--target-path', 'definitely-not-a-path'],
      { env: { AUDIT_DEPS_INSTALL_TIMEOUT_MS: '900000' } });
    assert.equal(r.timeoutMs, syncExecOptions({ env: { AUDIT_DEPS_INSTALL_TIMEOUT_MS: '900000' } }).timeout);
    assert.notEqual(r.timeoutMs, syncBudgetMs, 'this call deliberately differs from the module default');
    assert.match(whySyncFailed({ ...r, code: null, signal: 'SIGTERM', killed: true }),
      new RegExp(`KILLED after ${r.timeoutMs}ms`));
  });

  it('reports a real CLI failure as an exit, with both streams available', async () => {
    // Vacuous-pass guard: proves the wrapper actually ran the CLI and captured
    // its refusal, rather than returning a shape nobody exercised.
    const r = await runSyncCli(['--dry-run', '--target', 'wine', '--target-path', '.']);
    assert.equal(r.code, 1);
    assert.equal(r.killed, false);
    assert.match(r.out, /mutually exclusive/);
    assert.equal(r.out, r.stdout + r.stderr, 'out must be the concatenation, not a third source of truth');
  });
});
