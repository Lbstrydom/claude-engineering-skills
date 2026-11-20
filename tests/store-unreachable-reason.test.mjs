/**
 * @fileoverview `upstream:queues` and `stores:drift` name an unreachable store as
 * `store-unreachable`, not `spawn-failed`.
 *
 * Measured 2026-11-20: both already refused to count a store they could not reach
 * (it went to `unqueried`, never to an empty queue), but BOTH reported it as
 * `spawn-failed` — a failing child exits non-zero, `execFileSync` throws, and the
 * envelope the child printed was never read. "The store is down" and "the CLI
 * crashed" were indistinguishable. The classifier is the dashboard's existing
 * oracle (`backlog-gather.mjs`), not a second one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  envelopeNamesUnreachableStore, stdoutNamesUnreachableStore, classifyReaderResult,
} from '../scripts/lib/store/backlog-gather.mjs';
import { queryStore } from '../scripts/upstream-queues.mjs';
import { queryStoreDrift } from '../scripts/store-drift.mjs';

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

describe('stdoutNamesUnreachableStore', () => {
  const line = (o) => `${JSON.stringify(o)}\n`;

  it('a CLOUD_UNREACHABLE envelope is unreachable', () => {
    assert.equal(stdoutNamesUnreachableStore(line({ ok: false, error: { code: 'CLOUD_UNREACHABLE' } })), true);
  });
  it('LIST_FAILED with connection-class evidence is unreachable (the real `upstream list` envelope)', () => {
    assert.equal(stdoutNamesUnreachableStore(
      `banner\n${JSON.stringify({ ok: false, error: { code: 'LIST_FAILED', message: 'connect ECONNREFUSED 127.0.0.1:1' } })}\n`), true);
  });

  it('NEGATIVE CONTROLS: a generic failure, a bad query, malformed output and success are not "unreachable"', () => {
    assert.equal(stdoutNamesUnreachableStore(line({ ok: false, error: { code: 'LIST_FAILED', message: 'syntax error at or near "FORM"' } })), false);
    assert.equal(stdoutNamesUnreachableStore(line({ ok: false, error: { code: 'BAD_INPUT' } })), false);
    assert.equal(stdoutNamesUnreachableStore('{not json'), false);
    assert.equal(stdoutNamesUnreachableStore(''), false);
    assert.equal(stdoutNamesUnreachableStore(line({ ok: true, rows: [] })), false);
    assert.equal(envelopeNamesUnreachableStore(null), false);
  });

  it('the dashboard classifier and this predicate cannot disagree (single oracle)', () => {
    for (const env of [
      { ok: false, error: { code: 'CLOUD_UNREACHABLE' } },
      { ok: false, error: { code: 'LIST_FAILED', message: 'connect ECONNREFUSED 127.0.0.1:1' } },
      { ok: false, error: { code: 'LIST_FAILED', message: 'syntax error' } },
    ]) {
      const dash = classifyReaderResult({ exitCode: 2, stdout: JSON.stringify(env), reader: 'upstream' }).kind === 'store-unreachable';
      assert.equal(dash, envelopeNamesUnreachableStore(env), JSON.stringify(env));
    }
  });
});

describe('the real child processes against a port nothing listens on', () => {
  it('upstream:queues reports store-unreachable (was spawn-failed)', async () => {
    const port = await freePort();
    const r = queryStore({ url: `postgresql://u:p@127.0.0.1:${port}/audit_loop`, sslMode: 'disable' });
    assert.deepEqual(r, { ok: false, rows: [], reason: 'store-unreachable' });
  });

  it('stores:drift reports store-unreachable (was spawn-failed)', async () => {
    const port = await freePort();
    const r = queryStoreDrift({ url: `postgresql://u:p@127.0.0.1:${port}/audit_loop`, sslMode: 'disable' });
    assert.deepEqual(r, { ok: false, drift: null, reason: 'store-unreachable' });
  });

  it('CONTROL: neither reports an empty answer — both stay ok:false (never counted as an empty queue / clean store)', async () => {
    const port = await freePort();
    const dsn = `postgresql://u:p@127.0.0.1:${port}/audit_loop`;
    assert.equal(queryStore({ url: dsn, sslMode: 'disable' }).ok, false);
    assert.equal(queryStoreDrift({ url: dsn, sslMode: 'disable' }).ok, false);
  });
});
