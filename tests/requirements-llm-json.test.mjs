/**
 * Tests for scripts/lib/requirements/llm-json.mjs — the shared LLM-response
 * JSON parser. Plan: docs/plans/requirements-layer.md (audit M3).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseLlmJson } from '../scripts/lib/requirements/llm-json.mjs';

describe('parseLlmJson', () => {
  it('parses bare JSON', () => {
    assert.deepEqual(parseLlmJson('{"a":1}'), { a: 1 });
  });
  it('strips a ```json fence', () => {
    assert.deepEqual(parseLlmJson('```json\n{"a":1}\n```'), { a: 1 });
  });
  it('strips a bare ``` fence', () => {
    assert.deepEqual(parseLlmJson('```\n{"a":1}\n```'), { a: 1 });
  });
  it('tolerates surrounding whitespace', () => {
    assert.deepEqual(parseLlmJson('  \n {"a":1}  \n'), { a: 1 });
  });
  it('extracts the fenced block even after model preamble', () => {
    assert.deepEqual(parseLlmJson('Here is the output:\n```json\n{"a":1}\n```'), { a: 1 });
  });
  it('throws on non-JSON', () => {
    assert.throws(() => parseLlmJson('not json at all'));
  });
});
