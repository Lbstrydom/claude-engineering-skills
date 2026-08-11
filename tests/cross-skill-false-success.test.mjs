/**
 * @fileoverview A command that did not do the thing may not report success.
 *
 * Guards the SYSTEMIC audit finding "False-success and fail-open command result
 * reporting": several independent `cross-skill.mjs` handlers emitted a successful
 * envelope for an unsuccessful, malformed or rejected operation. The two closed
 * here are the ones reachable from outside the process:
 *
 *   - an unknown `--action` for `learning-quickfix-stats` fell through to the
 *     stats output, so a typo'd verb printed a real-looking report;
 *   - a reachability payload that failed its own response schema degraded to
 *     `{ok:true, cloud:true, personas:[]}` — withholding the malformed payload
 *     was right, calling that outcome a SUCCESS was not. The nav-audit consumer
 *     cannot distinguish "this repo has no reachability evidence" from "the
 *     reader is broken", and reads the second as the first.
 *
 * The sibling sub-claims (abort reporting, plan-verify-items) are locked by
 * tests/refresh-runs-repo-scoping.test.mjs and
 * tests/plan-verify-items-write-result.test.mjs respectively.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReachabilityEvidenceResponseSchema } from '../scripts/lib/schemas.mjs';

const CLI_PATH = fileURLToPath(new URL('../scripts/cross-skill.mjs', import.meta.url));

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xskill-fs-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

function run(...args) {
  const dir = fs.mkdtempSync(path.join(tmp, 'case-'));
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, AUDIT_LOOP_DISABLE_SHARED: '1' };
  delete env.DOTENV_CONFIG_PATH;
  delete env.AUDIT_DB_URL;
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: 'utf8', env, cwd: dir, timeout: 60_000 });
  const line = r.stdout.split('\n').filter((l) => l.trim().startsWith('{')).pop();
  assert.ok(line, `no JSON envelope (status ${r.status})\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(line);
}

describe('learning-quickfix-stats — an unknown verb is rejected, not answered', () => {
  it('a misspelled --action is an error rather than a stats report', () => {
    const out = run('learning-quickfix-stats', '--action', 'bogus');
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'BAD_INPUT');
    assert.match(out.error.message, /unknown --action/);
    assert.equal(out.patterns, undefined, 'a rejected verb must not also print a real-looking payload');
  });

  it('names the actions it does accept, so the typo is actionable', () => {
    const out = run('learning-quickfix-stats', '--action', 'bogus');
    assert.match(out.error.message, /rebuild/);
    assert.match(out.error.message, /stats/);
  });

  // Vacuous-pass guard: a handler that rejected everything would satisfy both
  // assertions above.
  it('a valid --action still produces its report (negative control)', () => {
    const out = run('learning-quickfix-stats', '--action', 'stats');
    assert.equal(out.ok, true);
    assert.equal(out.action, 'stats');
  });
});

describe('get-reachability-evidence — a schema failure is not an empty success', () => {
  // The malformed-reader branch is not reachable from outside the process (the
  // store's own catch returns a well-formed empty payload), so the contract is
  // asserted where it is decided. Paired with a live check that the schema can
  // actually reject, so this cannot pass against a schema that accepts anything.
  it('the response schema genuinely rejects a malformed personas payload', () => {
    const bad = ReachabilityEvidenceResponseSchema.safeParse({
      ok: true, cloud: true, personas: [{ nope: 1 }],
    });
    assert.equal(bad.success, false, 'if the schema accepted this, the guarded branch could never run');
  });

  it('the schema accepts a well-formed empty payload (negative control)', () => {
    const good = ReachabilityEvidenceResponseSchema.safeParse({ ok: true, cloud: true, personas: [] });
    assert.equal(good.success, true);
  });

  it('the handler emits an error on schema failure, never ok:true with an empty list', () => {
    const src = fs.readFileSync(CLI_PATH, 'utf-8');
    const at = src.indexOf('ReachabilityEvidenceResponseSchema.safeParse');
    assert.ok(at > 0, 'the validation site must exist (vacuous-pass guard)');
    const branch = src.slice(at, at + 900);
    assert.match(branch, /emitError\('PROTOCOL_VIOLATION'/,
      'an unmeasurable reachability result must be reported as unmeasured');
    assert.ok(
      !/return emit\(\{ ok: true, cloud: true, personas: \[\] \}\)/.test(branch),
      'the empty-success degrade must be gone, not merely reworded',
    );
  });
});
