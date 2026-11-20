/**
 * @fileoverview The child-boundary half of the unreachable-store contract:
 * what `setup-postgres --format json` prints and exits with, and how
 * `upstream:queues` interprets each stdout shape (never a wrong-empty).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { interpretUpstreamStdout } from '../scripts/upstream-queues.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETUP = path.join(ROOT, 'scripts', 'setup-postgres.mjs');
const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const line = (o) => `${JSON.stringify(o)}\n`;

describe('setup-postgres --check-drift against an unreachable store', () => {
  const run = async (format) => {
    const port = await freePort();
    return spawnSync(process.execPath, [SETUP, '--check-drift', '--live', '--format', format], {
      cwd: ROOT, encoding: 'utf-8', timeout: 60000, windowsHide: true,
      env: { ...process.env, AUDIT_DB_URL: `postgresql://u:p@127.0.0.1:${port}/audit_loop`, AUDIT_DB_SSL_MODE: 'disable' },
    });
  };

  it('json: prints the named envelope on stdout (no host, no DSN) and still exits 1', async () => {
    const r = await run('json');
    assert.equal(r.status, 1);
    const last = r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
    assert.deepEqual(JSON.parse(last), { ok: false, error: { code: 'CLOUD_UNREACHABLE', cause: 'unreachable' } });
    assert.doesNotMatch(r.stdout, /127\.0\.0\.1|u:p|audit_loop/);
  });

  it('CONTROL — human format prints no envelope (stdout stays as before) and exits 1', async () => {
    const r = await run('human');
    assert.equal(r.status, 1);
    assert.equal(r.stdout.includes('CLOUD_UNREACHABLE'), false);
  });
});

describe('`cross-skill upstream list` against an unreachable store', () => {
  it('emits the distinct CLOUD_UNREACHABLE code (classified by code, not message), still exit 2', async () => {
    const port = await freePort();
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'cross-skill.mjs'), 'upstream', 'list', '--state', 'open', '--limit', '3'], {
      cwd: ROOT, encoding: 'utf-8', timeout: 60000, windowsHide: true,
      env: { ...process.env, AUDIT_DB_URL: `postgresql://u:p@127.0.0.1:${port}/audit_loop`, AUDIT_DB_SSL_MODE: 'disable' },
    });
    assert.equal(r.status, 2);
    const last = r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
    assert.equal(JSON.parse(last).error.code, 'CLOUD_UNREACHABLE');
  });
});

describe('interpretUpstreamStdout', () => {
  it('a CLOUD_UNREACHABLE envelope (what `upstream list` now emits for a down store) is store-unreachable — by CODE', () => {
    assert.equal(interpretUpstreamStdout(line({ ok: false, error: { code: 'CLOUD_UNREACHABLE', message: 'x' } })).reason, 'store-unreachable');
  });
  it('legacy envelope: LIST_FAILED is recognised only WITH connection evidence (the dashboard oracle, unchanged)', () => {
    assert.equal(interpretUpstreamStdout(line({ ok: false, error: { code: 'LIST_FAILED', message: 'connect ECONNREFUSED 127.0.0.1:1' } })).reason, 'store-unreachable');
  });
  it('a generic failure keeps its own code; a bad query is NOT unreachable', () => {
    assert.equal(interpretUpstreamStdout(line({ ok: false, error: { code: 'BAD_INPUT' } })).reason, 'BAD_INPUT');
    assert.equal(interpretUpstreamStdout(line({ ok: false, error: { code: 'LIST_FAILED', message: 'syntax error' } })).reason, 'LIST_FAILED');
  });
  it('a success envelope with no rows array is malformed, NOT an empty queue', () => {
    for (const env of [{ ok: true }, { ok: true, rows: null }, { ok: true, rows: 'x' }]) {
      const r = interpretUpstreamStdout(line(env));
      assert.equal(r.ok, false, JSON.stringify(env));
      assert.equal(r.reason, 'malformed-envelope');
    }
  });
  it('CONTROLS: a genuine empty list is an answer; cloud off is its own state; no envelope is named', () => {
    assert.deepEqual(interpretUpstreamStdout(line({ ok: true, rows: [] })), { ok: true, rows: [], reason: null });
    assert.equal(interpretUpstreamStdout(line({ ok: true, cloud: false })).reason, 'cloud-off');
    assert.equal(interpretUpstreamStdout('banner only\n').reason, 'no-envelope-in-output');
    // A truncated line is malformed, not a spawn failure.
    assert.equal(interpretUpstreamStdout('{"ok":tru\n').reason, 'malformed-envelope');
  });
});
