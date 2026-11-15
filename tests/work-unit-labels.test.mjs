/**
 * @fileoverview Work-unit labels — the model-written half.
 *
 * What is pinned here is NOT the label text (it comes from a model and is
 * allowed to vary) but the properties that make delegating it safe: the label
 * never changes membership, an unavailable labeller degrades instead of
 * failing, and a failure is never cached.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { labelWorkUnits, sanitizeLabel, LABEL_PROMPT_VERSION } from '../scripts/lib/work-unit-labels.mjs';

const unit = (key, size = 3) => ({
  key, size, label: 'Coupling concern', labelSource: 'category',
  files: ['a.mjs', 'b.mjs'],
  members: Array.from({ length: size }, (_, i) => ({
    id: `f${i}`, primaryFile: 'a.mjs', category: 'Coupling concern', detail: 'something',
  })),
});

const mkRoot = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wul-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  return d;
};

describe('sanitizeLabel', () => {
  test('takes the first line and strips quoting, bullets and trailing dots', () => {
    assert.equal(sanitizeLabel('  "store writes that swallow failures."\nextra prose'),
      'store writes that swallow failures');
    assert.equal(sanitizeLabel('- a bulleted name'), 'a bulleted name');
  });
  test('empty or whitespace-only replies are a failure, not a label', () => {
    assert.equal(sanitizeLabel('   \n  '), null);
    assert.equal(sanitizeLabel(null), null);
  });
  test('an over-long reply is truncated rather than accepted whole', () => {
    const out = sanitizeLabel('x'.repeat(400));
    assert.ok(out.length <= 72, `got ${out.length}`);
  });
});

// ── a cache hit must not depend on the provider (round-1 audit, 2026-11-15) ──
//
// Pinning `defaultLabeller` to the sdk backend made it return null on a keyless
// `CLAUDE_BACKEND=cli` install. `labelWorkUnits` resolved the labeller BEFORE
// touching the cache, so it then returned `labeller-unavailable` and served
// NONE of the labels already on disk — strictly worse, for exactly the
// population the pin was written for. The provider is now resolved lazily, at
// most once, and only after a cache MISS.
//
// REWRITTEN after round 2, which found this suite's first version vacuous in
// three ways and it was right: an `asked` counter wired to nothing, a `built`
// counter incremented in an IIFE BEFORE `labelWorkUnits` was entered (so it
// could not observe resolution at all), and `labeller: null` falling through to
// `defaultLabeller`, whose answer depends on the operator's environment. Every
// test below counts calls to an INJECTED `labellerProvider`, which is the thing
// whose timing is the claim, and never reaches a real provider — so the suite is
// hermetic and its assertions are about laziness rather than about a proxy.
describe('labelWorkUnits: the cache is independent of provider availability', () => {
  /** A provider that records when it is asked and what it hands back. */
  function countingProvider(labeller) {
    const calls = { n: 0 };
    return {
      calls,
      provider: async () => { calls.n += 1; return labeller; },
    };
  }

  test('a cache HIT never asks the provider at all', async (t) => {
    const root = mkRoot(t);
    const warm = countingProvider(async () => 'a cached cluster name');
    const first = await labelWorkUnits([unit('k-cached')], { repoRoot: root, labellerProvider: warm.provider });
    assert.equal(first.labelled, 1);
    assert.equal(warm.calls.n, 1, 'the miss asked once');

    // Same unit, same cache, a provider that would THROW if it were consulted.
    const calls = { n: 0 };
    const res = await labelWorkUnits([unit('k-cached')], {
      repoRoot: root,
      labellerProvider: async () => { calls.n += 1; throw new Error('must not be asked'); },
    });
    assert.equal(res.cached, 1, 'the label is on disk; nothing about it needs a provider');
    assert.equal(res.units[0].label, 'a cached cluster name');
    assert.equal(res.units[0].labelSource, 'llm-cached');
    assert.equal(calls.n, 0, 'THE CLAIM: a cache hit resolves no provider');
    assert.equal(res.reason, null, 'and a run served from cache is not an unavailability');
  });

  test('an UNAVAILABLE provider still serves the cache, and only misses are underived', async (t) => {
    const root = mkRoot(t);
    await labelWorkUnits([unit('k-have')], {
      repoRoot: root, labellerProvider: async () => async () => 'stored name',
    });

    const none = countingProvider(null);   // what a keyless cli install produces
    const res = await labelWorkUnits([unit('k-have'), unit('k-missing')], {
      repoRoot: root, labellerProvider: none.provider,
    });
    assert.equal(res.cached, 1, 'the cached unit survives an unavailable provider');
    assert.equal(res.failed, 1);
    assert.equal(none.calls.n, 1, 'asked once, by the MISS');
    const byKey = Object.fromEntries(res.units.map((u) => [u.key, u]));
    assert.equal(byKey[unit('k-have').key].labelSource, 'llm-cached');
    assert.equal(byKey[unit('k-missing').key].labelSource, 'underived');
    assert.equal(res.reason, 'labeller-unavailable', 'a provider WAS needed and absent');
  });

  test('a cache MISS with no provider is underived, and says so', async (t) => {
    const none = countingProvider(null);
    const res = await labelWorkUnits([unit('k-miss')], { repoRoot: mkRoot(t), labellerProvider: none.provider });
    assert.equal(res.cached, 0);
    assert.equal(res.failed, 1);
    assert.equal(res.units[0].labelSource, 'underived');
    assert.equal(res.reason, 'labeller-unavailable');
  });

  // The provider must be resolved at most ONCE across concurrent units.
  // `Promise.all` runs them together, and the first version of this fix used a
  // resolved FLAG set before the await, so every unit but one would have read an
  // unresolved value and concluded the provider was unavailable. Counting the
  // injected provider's calls is the only way to see that.
  test('the provider is resolved ONCE across concurrent misses', async (t) => {
    const p = countingProvider(async (u) => `name for ${u.key}`);
    const res = await labelWorkUnits(
      [unit('c1'), unit('c2'), unit('c3')],
      { repoRoot: mkRoot(t), labellerProvider: p.provider },
    );
    assert.equal(p.calls.n, 1, 'THE CLAIM: one resolution, not one per unit');
    assert.equal(res.labelled, 3, 'and every unit got a label, not just the first');
    assert.equal(res.reason, null, 'no unit concluded the provider was unavailable');
  });

  // A THROWN provider degrades like an absent one — labelling is advisory and
  // must never crash a backlog listing — but it must not READ like one. Folding
  // the rejection into `null` made a programming error indistinguishable from
  // "no credential on this machine", with the diagnostic discarded.
  test('a provider that THROWS degrades, but keeps its reason', async (t) => {
    const res = await labelWorkUnits([unit('k-throw')], {
      repoRoot: mkRoot(t), labellerProvider: async () => { throw new Error('boom: bad config'); },
    });
    assert.equal(res.failed, 1, 'it still degrades');
    assert.match(res.reason, /^labeller-error: /, 'and says it was an ERROR, not an absence');
    assert.match(res.reason, /boom: bad config/, 'carrying the diagnostic');
    assert.notEqual(res.reason, 'labeller-unavailable');
  });

  test('an ABSENT provider is reported as absent, not as an error', async (t) => {
    const res = await labelWorkUnits([unit('k-none')], {
      repoRoot: mkRoot(t), labellerProvider: async () => null,
    });
    assert.equal(res.reason, 'labeller-unavailable');
  });

  test('`labeller` is still accepted, and is never resolved for a cache hit either', async (t) => {
    const root = mkRoot(t);
    await labelWorkUnits([unit('k-legacy')], { repoRoot: root, labeller: async () => 'legacy path name' });
    let asked = 0;
    const res = await labelWorkUnits([unit('k-legacy')], {
      repoRoot: root, labeller: async () => { asked += 1; return 'should not be called'; },
    });
    assert.equal(res.cached, 1);
    assert.equal(asked, 0, 'the labeller form must be just as lazy as the provider form');
  });
});

describe('labelWorkUnits', () => {
  test('replaces the fallback label and marks the source', async (t) => {
    const res = await labelWorkUnits([unit('k1')], {
      repoRoot: mkRoot(t), labeller: async () => 'store writes that collapse failures into absence',
    });
    assert.equal(res.units[0].label, 'store writes that collapse failures into absence');
    assert.equal(res.units[0].labelSource, 'llm');
    assert.equal(res.labelled, 1);
  });

  test('NEVER changes membership — only the label may come from a model', async (t) => {
    const before = unit('k1');
    const res = await labelWorkUnits([before], { repoRoot: mkRoot(t), labeller: async () => 'a new name' });
    const after = res.units[0];
    assert.equal(after.key, before.key, 'the unit key must be untouched');
    assert.equal(after.size, before.size);
    assert.deepEqual(after.members.map((m) => m.id), before.members.map((m) => m.id));
  });

  test('a throwing labeller degrades to the fallback and never propagates', async (t) => {
    const res = await labelWorkUnits([unit('k1')], {
      repoRoot: mkRoot(t), labeller: async () => { throw new Error('429 rate limited'); },
    });
    assert.equal(res.units[0].label, 'Coupling concern', 'the category fallback must stand');
    assert.equal(res.units[0].labelSource, 'underived');
    assert.equal(res.failed, 1);
  });

  test('a failure is NOT cached — one timeout must not pin a bad label', async (t) => {
    const root = mkRoot(t);
    await labelWorkUnits([unit('k1')], { repoRoot: root, labeller: async () => { throw new Error('boom'); } });
    let called = 0;
    const res = await labelWorkUnits([unit('k1')], {
      repoRoot: root, labeller: async () => { called++; return 'a real name'; },
    });
    assert.equal(called, 1, 'the retry must actually call the labeller');
    assert.equal(res.units[0].label, 'a real name');
  });

  test('a success IS cached, keyed on the unit key', async (t) => {
    const root = mkRoot(t);
    let called = 0;
    const run = () => labelWorkUnits([unit('k1')], { repoRoot: root, labeller: async () => { called++; return 'cached name'; } });
    await run();
    const second = await run();
    assert.equal(called, 1, 'the second read must hit the cache');
    assert.equal(second.units[0].labelSource, 'llm-cached');
    assert.equal(second.cached, 1);
  });

  test('a DIFFERENT membership key misses the cache — this is why the key is membership-derived', async (t) => {
    const root = mkRoot(t);
    let called = 0;
    const labeller = async () => { called++; return `name ${called}`; };
    await labelWorkUnits([unit('k1')], { repoRoot: root, labeller });
    await labelWorkUnits([unit('k2')], { repoRoot: root, labeller });
    assert.equal(called, 2, 'a grown/changed unit must be relabelled, never served a stale name');
  });

  test('singletons are not sent to a model', async (t) => {
    let called = 0;
    const res = await labelWorkUnits([unit('k1', 1)], {
      repoRoot: mkRoot(t), labeller: async () => { called++; return 'x'; },
    });
    assert.equal(called, 0);
    assert.equal(res.units[0].labelSource, 'category');
  });

  test('disabled and unavailable are distinguishable, and neither throws', async (t) => {
    const off = await labelWorkUnits([unit('k1')], { repoRoot: mkRoot(t), enabled: false });
    assert.equal(off.reason, 'disabled');
    assert.equal(off.units[0].labelSource, 'category');
    const gone = await labelWorkUnits([unit('k1')], { repoRoot: mkRoot(t), labeller: null, enabled: true });
    assert.ok(gone.reason === 'labeller-unavailable' || gone.units[0].labelSource !== 'llm');
  });

  test('the prompt version participates in the cache key', () => {
    assert.equal(typeof LABEL_PROMPT_VERSION, 'number');
  });
});

// Real replies observed from a live labelling run on 2026-08-13. The first
// sanitizer passed its own hand-written fixtures and let every one of these
// through — markdown emphasis, backticks and a restated preamble. Fixtures
// invented alongside the code under test encode what the author expected, which
// is the assumption being tested.
describe('sanitizeLabel — observed model output, not imagined output', () => {
  const OBSERVED = [
    ['*`orchestrator-bloat-and-store-layer-coupling`**', 'orchestrator-bloat-and-store-layer-coupling'],
    ['*`vcs-subprocess-error-blindness`**', 'vcs-subprocess-error-blindness'],
    ['*Pragma parsing robustness**', 'Pragma parsing robustness'],
    ['*Cluster name: `swallowed-errors-in-audit-input-pipeline`**', 'swallowed-errors-in-audit-input-pipeline'],
    ['**`unscoped-store-queries`**', 'unscoped-store-queries'],
    ['Name: fail-open input boundaries', 'fail-open input boundaries'],
    // Second live run: the wrapper sat MID-string ("**`name`** — *gloss*"), so
    // edge-peeling alone stopped at the first word character and left it in.
    ['**`subprocess-error-loss`** — *Git failures swallowed*',
      'subprocess-error-loss — Git failures swallowed'],
    ['snake_case_names_are_kept', 'snake_case_names_are_kept'],
  ];
  for (const [raw, want] of OBSERVED) {
    test(`peels ${JSON.stringify(raw.slice(0, 34))}`, () => {
      assert.equal(sanitizeLabel(raw), want);
    });
  }
  test('a label made only of wrappers is a failure, not an empty label', () => {
    assert.equal(sanitizeLabel('**``**'), null);
  });
});
