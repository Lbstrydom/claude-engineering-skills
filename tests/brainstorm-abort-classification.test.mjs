/**
 * Guards the abort-classification fix (upstream report, 2026-08-26).
 *
 * The defect: all three adapters abort on their OWN timeout, but tested for it
 * with `err.name === 'AbortError' || err.code === 'ABORT_ERR'`. The OpenAI SDK
 * wraps an aborted request as `APIUserAbortError` — status undefined, no code,
 * name not 'AbortError' — so a plain timeout fell through to `malformed` and
 * the operator was told the model produced unparseable output.
 *
 * The negative controls matter as much as the positives: a classifier that
 * calls everything an abort would pass every test above and destroy the
 * http_error / malformed distinction entirely.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isAbortFailure, abortMessage } from '../scripts/lib/brainstorm/error-classify.mjs';

describe('isAbortFailure — the shapes a real timeout arrives in', () => {
  test('an aborted signal is authoritative even when the error says nothing', () => {
    // The whole point of asking the signal: the code that aborted set this,
    // so no SDK wrapper can hide it.
    const controller = new AbortController();
    controller.abort();
    assert.equal(isAbortFailure({ err: new Error('Request was aborted.'), signal: controller.signal }), true);
    assert.equal(isAbortFailure({ err: { some: 'opaque object' }, signal: controller.signal }), true);
  });

  test('the OpenAI SDK APIUserAbortError shape — the class that caused the bug', () => {
    // Reproduces node_modules/openai/core/error.js: extends APIError, built with
    // status/headers/error all undefined, message 'Request was aborted.'.
    class APIError extends Error {}
    class APIUserAbortError extends APIError {
      constructor() { super('Request was aborted.'); this.name = 'APIUserAbortError'; this.status = undefined; }
    }
    const err = new APIUserAbortError();
    assert.equal(err.status, undefined, 'precondition: no status, so the http_error branch cannot catch it');
    assert.equal(err.name === 'AbortError', false, 'precondition: the old predicate did not match');
    assert.equal(isAbortFailure({ err }), true, 'must classify as an abort without a signal');
  });

  test('the two original shapes still match', () => {
    assert.equal(isAbortFailure({ err: Object.assign(new Error('x'), { name: 'AbortError' }) }), true);
    assert.equal(isAbortFailure({ err: Object.assign(new Error('x'), { code: 'ABORT_ERR' }) }), true);
  });

  test('a DOMException-worded abort matches', () => {
    assert.equal(isAbortFailure({ err: new Error('The operation was aborted') }), true);
  });
});

describe('isAbortFailure — the direction it must NOT fire (false aborts are silent)', () => {
  test('an HTTP error is not an abort', () => {
    assert.equal(isAbortFailure({ err: Object.assign(new Error('rate limited'), { status: 429 }) }), false);
  });

  test('a genuine parse failure is not an abort', () => {
    assert.equal(isAbortFailure({ err: new SyntaxError('Unexpected token < in JSON at position 0') }), false);
  });

  test('a non-aborted signal does not make an unrelated error an abort', () => {
    const controller = new AbortController();
    assert.equal(controller.signal.aborted, false, 'precondition');
    assert.equal(isAbortFailure({ err: new Error('connection reset'), signal: controller.signal }), false);
  });

  test('no error and no signal is not an abort', () => {
    assert.equal(isAbortFailure({}), false);
    assert.equal(isAbortFailure(), false);
  });
});

describe('abortMessage — one spelling across three adapters', () => {
  test('names the timeout and the two flags that change it', () => {
    const m = abortMessage(60000);
    assert.match(m, /60000ms/);
    assert.match(m, /--timeout/);
    assert.match(m, /--depth/);
  });

  test('degrades without a timeout value rather than printing null', () => {
    assert.doesNotMatch(abortMessage(null), /null/);
  });
});

describe('all three adapters delegate to the one oracle', () => {
  // Three copies of the predicate is why fixing one would have left two wrong.
  for (const f of ['openai-adapter', 'gemini-adapter', 'azure-claude-adapter']) {
    test(`${f} imports isAbortFailure and carries no private abort test`, async () => {
      const fs = await import('node:fs');
      const src = fs.readFileSync(new URL(`../scripts/lib/brainstorm/${f}.mjs`, import.meta.url), 'utf-8');
      assert.match(src, /isAbortFailure/, 'must use the shared classifier');
      assert.doesNotMatch(
        src, /err\?\.name === 'AbortError'/,
        'the private predicate must be gone, not merely shadowed',
      );
    });
  }
});
