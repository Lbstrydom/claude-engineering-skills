/**
 * Spawned-CLI proof of the GPT round cap (docs/plans/audit-round-cap-structural-or-stop.md §9).
 *
 * Every spawn runs `openai-audit.mjs` under tests/fixtures/no-network-preload.mjs, which records and refuses
 * every outbound request. That is what makes "a refused round makes zero audit-inference requests" a
 * measurement and not a log-text guess — and what makes the gate-passes cases safe: the process is killed
 * the moment the gate's own stderr line appears, and the preload would block any request anyway.
 *
 * AUDIT_DB_URL= (empty) is the air-gap signal: no store read, no embedding call from the card.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRELOAD = pathToFileURL(path.join(ROOT, 'tests', 'fixtures', 'no-network-preload.mjs')).href;
const AUDIT = path.join(ROOT, 'scripts', 'openai-audit.mjs');
const PLAN = 'docs/plans/audit-round-cap-structural-or-stop.md';
const AUDIT_DIR = path.join(ROOT, '.audit');
const MARKER = path.join(AUDIT_DIR, 'last-audit-run.json');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'round-cap-cli-'));
const sids = [];
let seq = 0;
const newSid = (prefix) => { const s = `${prefix}-clitest-${process.pid}-${Date.now()}-${seq++}`; sids.push(s); return s; };

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of fs.existsSync(AUDIT_DIR) ? fs.readdirSync(AUDIT_DIR) : []) {
    if (sids.some((s) => f.startsWith(s))) fs.rmSync(path.join(AUDIT_DIR, f), { force: true });
  }
});

/** Spawn the CLI; resolve on exit, or kill early once `until` matches stderr (the gate has passed). */
function run(args, { until = null, timeoutMs = 60_000 } = {}) {
  const netLog = path.join(tmp, `net-${seq++}.log`);
  fs.writeFileSync(netLog, '');
  return new Promise((resolve) => {
    const env = { ...process.env, AUDIT_DB_URL: '', NO_NET_LOG: netLog, MODEL_CATALOG_REFRESH: 'skip', AUDIT_TOOL_VERSION_CHECK: 'skip', CI: '1' };
    delete env.AUDIT_SESSION_ID;
    const child = spawn(process.execPath, ['--import', PRELOAD, AUDIT, ...args], { cwd: ROOT, env, windowsHide: true });
    let stderr = '';
    let killedEarly = false;
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stderr.on('data', (d) => {
      stderr += d;
      if (until && until.test(stderr) && !killedEarly) { killedEarly = true; child.kill(); }
    });
    child.stdout.on('data', () => {});
    child.on('close', (code) => {
      clearTimeout(timer);
      const attempts = fs.readFileSync(netLog, 'utf-8').split('\n').filter(Boolean);
      resolve({ code, stderr, killedEarly, attempts });
    });
  });
}

const reasonFlag = ['--past-cap', 'the recurring cluster is removed by this fix, so one more round converges'];

describe('plan audit round cap (spawned CLI)', () => {
  it('round 4, no override: exit 4, card printed, zero network attempts, no --out, marker untouched', async () => {
    const sid = newSid('audit-plan');
    const out = path.join(AUDIT_DIR, `${sid}-r4-result.json`);
    const markerBefore = fs.existsSync(MARKER) ? fs.readFileSync(MARKER) : null;
    const r = await run(['plan', PLAN, '--mode', 'plan', '--round', '4', '--out', out]);
    assert.equal(r.code, 4, r.stderr);
    assert.match(r.stderr, /Structural-or-stop: plan audit, round 4 requested \(soft cap 3, absolute 5\)/);
    assert.match(r.stderr, /\[PAST_CAP_REQUIRED\]/);
    assert.match(r.stderr, /--past-cap/);
    assert.deepEqual(r.attempts, [], 'a refused round must make no network attempt');
    assert.equal(fs.existsSync(out), false, 'a refusal writes no --out file');
    const markerAfter = fs.existsSync(MARKER) ? fs.readFileSync(MARKER) : null;
    assert.deepEqual(markerAfter, markerBefore, 'a refusal leaves the gate-evidence marker untouched');
    assert.equal(fs.existsSync(path.join(AUDIT_DIR, `${sid}-r4-structural-card.json`)), true, 'the card is written');
  });

  it('round 4 with --past-cap but no card on disk: CARD_REQUIRED (exit 4); the same command then passes the gate', async () => {
    const sid = newSid('audit-plan');
    const args = ['plan', PLAN, '--mode', 'plan', '--round', '4', ...reasonFlag, '--out', path.join(AUDIT_DIR, `${sid}-r4-result.json`)];
    const first = await run(args);
    assert.equal(first.code, 4, first.stderr);
    assert.match(first.stderr, /\[CARD_REQUIRED\]/);
    assert.deepEqual(first.attempts, []);
    const second = await run(args, { until: /\[round-cap\] past cap/ });
    assert.equal(second.killedEarly, true, `the gate should pass on the second run:\n${second.stderr}`);
    assert.match(second.stderr, /\[round-cap\] past cap: plan round 4 \(soft 3, absolute 5\)/);
  });

  it('round 6 is past the absolute cap whatever the reason: exit 4 ABSOLUTE_CAP', async () => {
    const sid = newSid('audit-plan');
    const r = await run(['plan', PLAN, '--mode', 'plan', '--round', '6', ...reasonFlag, '--out', path.join(AUDIT_DIR, `${sid}-r6-result.json`)]);
    assert.equal(r.code, 4);
    assert.match(r.stderr, /\[ABSOLUTE_CAP\]/);
    assert.match(r.stderr, /CONTINUE\s+not available \(absolute cap 5\)/);
    assert.deepEqual(r.attempts, []);
  });

  it('plan … --mode code is a mode conflict (exit 1), not a silent pick', async () => {
    const r = await run(['plan', PLAN, '--mode', 'code', '--round', '4']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /MODE_CONFLICT|conflicts with the positional mode/);
  });

  for (const bad of ['1.5', '3junk', '0', 'abc']) {
    it(`--round ${bad} is refused as a bad round (exit 1)`, async () => {
      const r = await run(['plan', PLAN, '--mode', 'plan', '--round', bad]);
      assert.equal(r.code, 1, r.stderr);
      assert.match(r.stderr, /--round must be a positive whole number/);
    });
  }

  it('--past-cap on a within-cap round is refused as unneeded (exit 1)', async () => {
    const r = await run(['plan', PLAN, '--mode', 'plan', '--round', '2', ...reasonFlag]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /PAST_CAP_UNNEEDED/);
  });

  it('negative control: round 3 with no flag passes the gate (the process is only killed after the gate line)', async () => {
    const r = await run(['plan', PLAN, '--mode', 'plan', '--round', '3', '--ledger', path.join(tmp, 'l.json')], { until: /\[round-cap\] within cap/ });
    assert.equal(r.killedEarly, true, r.stderr);
    assert.match(r.stderr, /\[round-cap\] within cap: plan round 3\/3/);
  });
});

describe('code audit round cap (spawned CLI)', () => {
  it('round 7 is past the code soft cap (6): exit 4 with a code card', async () => {
    const sid = newSid('audit-code');
    const r = await run(['code', PLAN, '--round', '7', '--out', path.join(AUDIT_DIR, `${sid}-r7-result.json`)]);
    assert.equal(r.code, 4, r.stderr);
    assert.match(r.stderr, /Structural-or-stop: code audit, round 7 requested \(soft cap 6, absolute 8\)/);
    assert.deepEqual(r.attempts, []);
  });

  it('round 6 is within the code soft cap', async () => {
    const r = await run(['code', PLAN, '--round', '6', '--ledger', path.join(tmp, 'l.json')], { until: /\[round-cap\] within cap/ });
    assert.equal(r.killedEarly, true, r.stderr);
    assert.match(r.stderr, /within cap: code round 6\/6/);
  });

  it('a rebuttal has no round and is never capped', async () => {
    const r = await run(['rebuttal', PLAN], {});
    assert.notEqual(r.code, 4);
    assert.doesNotMatch(r.stderr, /round-cap/);
  });
});

describe('the no-network preload is a working instrument (positive control)', () => {
  it('records and refuses fetch, tcp connect and tls connect', async () => {
    const netLog = path.join(tmp, 'preload-control.log');
    fs.writeFileSync(netLog, '');
    const script = [
      "fetch('https://example.invalid/x').catch(() => {});",
      "const net = require('node:net');",
      "net.connect({ host: 'example.invalid', port: 443 }).on('error', () => {});",
      "try { require('node:tls').connect({ host: 'example.invalid', port: 443 }); } catch {}",
      'setTimeout(() => {}, 200);',
    ].join('\n');
    await new Promise((resolve) => {
      const c = spawn(process.execPath, ['--import', PRELOAD, '-e', script], { env: { ...process.env, NO_NET_LOG: netLog }, windowsHide: true });
      c.on('close', resolve);
    });
    const kinds = fs.readFileSync(netLog, 'utf-8').split('\n').filter(Boolean).map((l) => l.split(' ')[0]).sort();
    assert.deepEqual(kinds, ['fetch', 'net.connect', 'tls.connect']);
  });
});
