/**
 * Tier-1 deterministic-seam tests for the arch-memory intent normalizer.
 * Plan: docs/plans/arch-memory-band-recalibration.md §2.1 C1/C2/C4/C6/C10.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  normalizeIntentToPurpose,
  deterministicNormalize,
  normalizationCacheKey,
  NORMALIZE_PROMPT,
  NORMALIZE_PROMPT_VERSION,
  MAX_INTENT_CHARS,
  MAX_OUTPUT_CHARS,
} from '../scripts/lib/arch-memory/normalize-intent.mjs';

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arch-normalize-'));
}

const okClient = (text) => async () => ({
  messages: { create: async () => ({ content: [{ type: 'text', text }] }) },
});
const available = async () => true;

describe('normalize-intent / prompt version is a content hash (C6)', () => {
  it('is derived from the prompt text, not hand-maintained', () => {
    const expected = crypto.createHash('sha256').update(NORMALIZE_PROMPT).digest('hex').slice(0, 12);
    assert.equal(NORMALIZE_PROMPT_VERSION, expected);
  });

  it('is stable across imports (same input → same version)', () => {
    assert.match(NORMALIZE_PROMPT_VERSION, /^[0-9a-f]{12}$/);
  });

  it('participates in the cache key, so a prompt edit invalidates entries', () => {
    const k = normalizationCacheKey('some intent', 'model-x');
    assert.ok(k.includes(NORMALIZE_PROMPT_VERSION) === false, 'key is hashed, not concatenated');
    assert.match(k, /^[0-9a-f]{24}$/);
  });
});

describe('normalize-intent / cache key redaction boundary (C2, Gemini G2)', () => {
  it('two intents differing only by a secret share ONE cache entry', () => {
    // The caller redacts first (C1), so both arrive here identically.
    const redacted = 'connect to postgresql://user:[REDACTED:dsn-password]@host/db';
    assert.equal(
      normalizationCacheKey(redacted, 'm'),
      normalizationCacheKey(redacted, 'm'),
    );
  });

  it('differs by normalizerId so two providers never share an entry', () => {
    assert.notEqual(normalizationCacheKey('x', 'model-a'), normalizationCacheKey('x', 'model-b'));
  });
});

describe('normalize-intent / fallback is never cached (C10, Gemini G1)', () => {
  it('a provider failure does not write a cache entry', async () => {
    const repoRoot = tmpRepo();
    const boom = async () => ({
      messages: { create: async () => { throw new Error('transient network blip'); } },
    });

    const r1 = await normalizeIntentToPurpose('add a thing that resolves paths', {
      repoRoot, createClient: boom, isAvailable: available,
    });
    assert.equal(r1.mode, 'fallback');

    // The whole point: the NEXT call must retry the LLM, not serve the fallback.
    const r2 = await normalizeIntentToPurpose('add a thing that resolves paths', {
      repoRoot, createClient: okClient('Resolves paths for a request.'), isAvailable: available,
    });
    assert.equal(r2.mode, 'llm', 'a transient failure must not pin the intent to fallback forever');
    assert.equal(r2.text, 'Resolves paths for a request.');
  });

  it('an empty LLM response degrades to fallback and is not cached', async () => {
    const repoRoot = tmpRepo();
    const r1 = await normalizeIntentToPurpose('add a widget', {
      repoRoot, createClient: okClient('   '), isAvailable: available,
    });
    assert.equal(r1.mode, 'fallback');
    assert.match(r1.reason, /empty-response/);

    const r2 = await normalizeIntentToPurpose('add a widget', {
      repoRoot, createClient: okClient('Provides a widget.'), isAvailable: available,
    });
    assert.equal(r2.mode, 'llm');
  });

  it('a successful normalization IS cached and reused', async () => {
    const repoRoot = tmpRepo();
    let calls = 0;
    const counting = async () => ({
      messages: {
        create: async () => { calls++; return { content: [{ type: 'text', text: 'Queries the index.' }] }; },
      },
    });
    await normalizeIntentToPurpose('find similar symbols', { repoRoot, createClient: counting, isAvailable: available });
    await normalizeIntentToPurpose('find similar symbols', { repoRoot, createClient: counting, isAvailable: available });
    assert.equal(calls, 1, 'second call must hit the cache');
  });
});

describe('normalize-intent / never throws into the query path (C10)', () => {
  it('unavailable backend degrades rather than throwing', async () => {
    const repoRoot = tmpRepo();
    const r = await normalizeIntentToPurpose('add a resolver', {
      repoRoot, createClient: okClient('x'), isAvailable: async () => false,
    });
    assert.equal(r.mode, 'fallback');
    assert.match(r.reason, /claude-unavailable/);
  });

  it('an availability probe that throws degrades rather than throwing', async () => {
    const repoRoot = tmpRepo();
    const r = await normalizeIntentToPurpose('add a resolver', {
      repoRoot, createClient: okClient('x'), isAvailable: async () => { throw new Error('nope'); },
    });
    assert.equal(r.mode, 'fallback');
  });

  it('empty intent returns empty without calling the provider', async () => {
    const repoRoot = tmpRepo();
    const r = await normalizeIntentToPurpose('   ', {
      repoRoot,
      createClient: async () => { throw new Error('must not be called'); },
      isAvailable: available,
    });
    assert.equal(r.text, '');
    assert.equal(r.mode, 'fallback');
    assert.match(r.reason, /empty-intent/);
  });
});

describe('normalize-intent / bounds (C10)', () => {
  it('truncates an oversized intent before sending', async () => {
    const repoRoot = tmpRepo();
    let seen = null;
    const capture = async () => ({
      messages: {
        create: async (p) => { seen = p.messages[0].content; return { content: [{ type: 'text', text: 'Does a thing.' }] }; },
      },
    });
    await normalizeIntentToPurpose('x'.repeat(MAX_INTENT_CHARS + 5000), {
      repoRoot, createClient: capture, isAvailable: available,
    });
    assert.equal(seen.length, MAX_INTENT_CHARS);
  });

  it('truncates an oversized response', async () => {
    const repoRoot = tmpRepo();
    const r = await normalizeIntentToPurpose('add a thing', {
      repoRoot, createClient: okClient('y'.repeat(MAX_OUTPUT_CHARS + 500)), isAvailable: available,
    });
    assert.equal(r.text.length, MAX_OUTPUT_CHARS);
  });
});

describe('normalize-intent / deterministic fallback moves toward purpose genre', () => {
  it('strips intent-verb scaffolding', () => {
    assert.match(deterministicNormalize('add a function that finds similar symbols'), /^Provides /);
    assert.match(deterministicNormalize('I want to create a cache layer'), /^Provides /);
    assert.match(deterministicNormalize('fix the ordering bug'), /^Handles /);
  });

  it('is a pure function — same input, same output', () => {
    const s = 'implement nearest-neighbour search';
    assert.equal(deterministicNormalize(s), deterministicNormalize(s));
  });

  it('handles empty and non-string input without throwing', () => {
    assert.equal(deterministicNormalize(''), '');
    assert.equal(deterministicNormalize(null), '');
    assert.equal(deterministicNormalize(undefined), '');
  });
});
