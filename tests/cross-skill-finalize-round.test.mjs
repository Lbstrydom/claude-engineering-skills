/**
 * @fileoverview Round resolution for `cross-skill.mjs finalize-outcomes`.
 *
 * Guards the audit finding "Incorrect numeric option normalization": `argOption`
 * returns `null` when `--round` is absent, and `Number(null)` is `0` — an
 * integer — so the old
 *
 *     Number.isInteger(Number(roundOpt)) ? Number(roundOpt) : (result.round || 1)
 *
 * made its own `result.round || 1` fallback unreachable and silently finalised
 * every flagless invocation as round 0. Round is a real key: `finalizeRoundOutcomes`
 * stamps it onto outcome records, so round 0 mislabels the whole round.
 *
 * Driven through the CLI rather than a extracted helper on purpose — the defect
 * lived in the argument plumbing, and a census found this was the ONLY
 * `Number.isInteger(Number(...))` site in `scripts/`, so there is no class here
 * that a shared helper would serve.
 *
 * Hermetic: HOME/USERPROFILE are redirected at the temp tree so the shared
 * `~/.audit-loop.env` cloud config cannot load and the handler takes its
 * documented cloud-off branch, which echoes the resolved `round`.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../scripts/cross-skill.mjs', import.meta.url));

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xskill-round-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

/**
 * Run `finalize-outcomes` with a given result body and flag set, cloud forced
 * off, and return the parsed JSON envelope.
 */
function finalize(resultBody, extraArgs = [], { dbUrl = null } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'case-'));
  const ledger = path.join(dir, 'ledger.json');
  const result = path.join(dir, 'result.json');
  fs.writeFileSync(ledger, JSON.stringify({ entries: [] }));
  fs.writeFileSync(result, JSON.stringify(resultBody));

  // Scrubbing AUDIT_DB_URL alone is NOT enough: `load-shared-env` writes the
  // discovered repo `.env` path into DOTENV_CONFIG_PATH, which a child would
  // inherit and use to reload the real DSN from a temp cwd.
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, AUDIT_LOOP_DISABLE_SHARED: '1' };
  delete env.DOTENV_CONFIG_PATH;
  if (dbUrl) { env.AUDIT_DB_URL = dbUrl; env.AUDIT_DB_SSL_MODE = 'disable'; }
  else delete env.AUDIT_DB_URL;

  const r = spawnSync(process.execPath, [
    CLI, 'finalize-outcomes', '--run-id', 'round-test',
    '--ledger', ledger, '--result', result, ...extraArgs,
  ], { encoding: 'utf8', env, cwd: dir });

  const line = r.stdout.split('\n').filter((l) => l.trim().startsWith('{')).pop();
  assert.ok(line, `no JSON envelope on stdout (status ${r.status})\n${r.stdout}\n${r.stderr}`);
  return { ...JSON.parse(line), _status: r.status };
}

describe('cross-skill finalize-outcomes — --round resolution', () => {
  // The regression itself. Before the fix this asserted 0.
  it('falls back to result.round when --round is omitted', () => {
    const out = finalize({ round: 7, findings: [] });
    assert.equal(out.ok, true);
    assert.equal(out.cloud, false, 'the hermetic env must reach the cloud-off branch, or this proves nothing');
    assert.equal(out.round, 7, '--round omitted must defer to the result file, not coerce null to 0');
  });

  it('falls back to 1 when neither --round nor result.round is present', () => {
    const out = finalize({ findings: [] });
    assert.equal(out.round, 1);
  });

  // Vacuous-pass guard: if the flag were ignored outright every assertion above
  // would still pass, so the explicit value must be shown to win.
  it('honours an explicit --round over result.round (negative control)', () => {
    const out = finalize({ round: 7, findings: [] }, ['--round', '3']);
    assert.equal(out.round, 3);
  });

  // ── Contract TIGHTENED 2026-08-12 (cross-skill-cli-integrity, audit r5) ────
  //
  // These two cases previously asserted that `--round 0` was honoured ("an
  // explicit 0 is a caller decision") and that `--round abc` silently fell back
  // to `result.round`. Both are now refusals, because the older expectation
  // contradicted this suite's OWN header: *"Round is a real key:
  // `finalizeRoundOutcomes` stamps it onto outcome records, so round 0 mislabels
  // the whole round."* Audit rounds are 1-based (`--round <n>`, R2+ mode at
  // `>= 2`); there is no round 0 to finalise, so honouring it writes the exact
  // mislabelled record the original defect produced — just reached through a
  // different input.
  //
  // The fallback case is the same principle: quietly finalising round 7 because
  // the operator typed `abc` is a silently-different answer to the one they
  // asked for. That is the failure this CLI's flag guard exists to prevent
  // (a typo'd `--dry-runn` silently dropped while the real write ran).
  it('REFUSES an explicit --round 0 — the system has no round 0', () => {
    const out = finalize({ round: 7, findings: [] }, ['--round', '0']);
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'BAD_INPUT');
    assert.match(out.error.message, /positive integer/);
  });

  it('REFUSES a non-numeric --round rather than silently finalising another round', () => {
    const out = finalize({ round: 7, findings: [] }, ['--round', 'abc']);
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'BAD_INPUT');
    assert.notEqual(out.round, 7, 'must not quietly finalise a round the caller never named');
  });

  it('REFUSES a negative --round', () => {
    const out = finalize({ round: 7, findings: [] }, ['--round', '-2']);
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'BAD_INPUT');
  });
});

/**
 * `isCloudEnabled()` swallows pool-construction failures and returns false, so a
 * configured-but-unreachable store landed in the same branch as "no DSN at all".
 * Both still capture locally — that is the intended graceful degradation — but
 * the handler told the operator `AUDIT_DB_URL unset` when it was set and the
 * server was merely down, while this round's adjudications silently never
 * reached the store. Same class as `measured:false` vs a genuine zero.
 */
describe('cross-skill finalize-outcomes — unreachable is not unconfigured', () => {
  // A DSN that cannot even be parsed makes `getPool()` throw, so `isCloudEnabled()`
  // reports false with a DSN plainly configured — the branch that used to tell
  // the operator `AUDIT_DB_URL unset`.
  it('reports a configured-but-unusable DSN as degraded, not as unset', () => {
    const out = finalize({ round: 2, findings: [] }, [], { dbUrl: 'not-a-postgres-url' });
    assert.equal(out.ok, true, 'the local capture must still happen — this is degradation, not failure');
    assert.equal(out.cloud, false);
    assert.equal(out.degraded, true);
    assert.equal(out.reason, 'store-unreachable');
    assert.ok(!/unset/.test(out.hint), `the hint must not claim the DSN is unset: ${out.hint}`);
    assert.match(out.hint, /NOT in the cloud store/, 'the operator must be told the outcomes did not land');
  });

  // A parseable DSN pointing at a dead port takes the OTHER path: the pool
  // constructs lazily, so `isCloudEnabled()` says true and the run-existence
  // probe fails instead. That used to surface as UNKNOWN_RUN — blaming the
  // operator's --run-id for a server being down.
  it('an unreachable store is a store problem, not an unknown run', () => {
    const out = finalize({ round: 2, findings: [] }, [], { dbUrl: 'postgresql://u:p@127.0.0.1:1/postgres' });
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'STORE_UNAVAILABLE',
      'a failed probe must not be reported as UNKNOWN_RUN');
    assert.match(out.error.message, /could not be queried/);
  });

  // Vacuous-pass guard: the genuinely-unconfigured case must keep its own
  // (correct) diagnosis, or the assertions above would pass for a build that
  // labelled everything degraded.
  it('still reports a genuinely absent DSN as not-configured (negative control)', () => {
    const out = finalize({ round: 2, findings: [] });
    assert.equal(out.degraded, false);
    assert.equal(out.reason, 'not-configured');
    assert.match(out.hint, /AUDIT_DB_URL unset/);
  });
});
