/**
 * @fileoverview Unit tests for the Azure embedding wrapper's output contract.
 * Mocks the OpenAI client so no network/credentials are needed — exercises the
 * dimension-mismatch and empty-vector guards that protect the pgvector write
 * path (which is otherwise untested locally; see the plan's risk register).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  azureEmbed,
  SECURITY_EMBED_DIM,
  _setClientForTest,
  _resetClientForTest,
} from '../scripts/lib/security/azure-embed.mjs';

function fakeClient(vector) {
  return { embeddings: { create: async () => ({ data: [{ embedding: vector }] }) } };
}

// Cleanup runs via t.after so a failing assertion can't leak the fake client
// into later tests (Opus O3 — node:test does not isolate tests in a file).
test('azureEmbed returns the vector when length matches', async (t) => {
  t.after(_resetClientForTest);
  _setClientForTest(fakeClient(new Array(SECURITY_EMBED_DIM).fill(0.1)));
  const v = await azureEmbed('hello');
  assert.equal(v.length, SECURITY_EMBED_DIM);
});

test('azureEmbed throws on dimension mismatch (model/param regression guard)', async (t) => {
  t.after(_resetClientForTest);
  _setClientForTest(fakeClient(new Array(1536).fill(0.1)));
  await assert.rejects(() => azureEmbed('hello'), /dim mismatch.*1536.*expected 768/);
});

test('azureEmbed throws on empty vector', async (t) => {
  t.after(_resetClientForTest);
  _setClientForTest(fakeClient([]));
  await assert.rejects(() => azureEmbed('hello'), /empty embedding/);
});

test('azureEmbed rejects empty input text without calling the API', async (t) => {
  t.after(_resetClientForTest);
  let called = false;
  _setClientForTest({ embeddings: { create: async () => { called = true; return { data: [{ embedding: [] }] }; } } });
  await assert.rejects(() => azureEmbed('   '), /non-empty string/);
  assert.equal(called, false);
});
