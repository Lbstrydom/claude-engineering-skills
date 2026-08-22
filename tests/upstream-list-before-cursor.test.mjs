/**
 * @fileoverview `upstream list --before <cursor>` (round-4 audit M13): a
 * malformed base64url or invalid JSON in the cursor used to escape
 * `upstreamCmd` as an unhandled exception rather than the CLI's own
 * standard `CommandError` shape.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { upstreamCmd } from '../scripts/lib/cross-skill/commands/quality.mjs';
import { CommandError } from '../scripts/lib/cross-skill/dispatch.mjs';

function makeCtx({ flags = {}, boolFlags = new Set() }) {
  return {
    verb: 'list',
    cloud: { enabled: true },
    flag: (name) => flags[name] ?? null,
    hasFlag: (name) => boolFlags.has(name),
    resolveScope: async () => ({ kind: 'none' }),
    deps: {
      listUpstreamIssues: async () => ({ ok: true, cloud: true, rows: [], nextCursor: null }),
      findPriorFixes: async () => ({ rows: [] }),
    },
  };
}

describe('upstream list --before', () => {
  it('a non-base64url string is a clean CommandError, not an unhandled crash', async () => {
    const ctx = makeCtx({ flags: { before: 'not valid base64url json at all !!!' } });
    await assert.rejects(() => upstreamCmd(ctx), (err) => {
      assert.ok(err instanceof CommandError);
      assert.equal(err.code, 'BAD_INPUT');
      assert.match(err.message, /not a valid cursor/);
      return true;
    });
  });

  it('valid base64url of invalid JSON is a clean CommandError, not an unhandled crash', async () => {
    const badJson = Buffer.from('{not: json', 'utf-8').toString('base64url');
    const ctx = makeCtx({ flags: { before: badJson } });
    await assert.rejects(() => upstreamCmd(ctx), (err) => {
      assert.ok(err instanceof CommandError);
      assert.equal(err.code, 'BAD_INPUT');
      return true;
    });
  });

  it('a valid, well-formed cursor still works', async () => {
    const good = Buffer.from(JSON.stringify({ createdAt: '2026-01-01T00:00:00Z', id: 'x' }), 'utf-8').toString('base64url');
    const ctx = makeCtx({ flags: { before: good } });
    const res = await upstreamCmd(ctx);
    assert.equal(res.ok, true);
  });
});
