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
// NONE of the labels already on disk \u2014 strictly worse, for exactly the
// population the pin was written for. The provider is now resolved lazily, on
// the first cache MISS.
describe('labelWorkUnits: the cache is independent of provider availability', () => {
  test('cached labels are served when the labeller is unavailable', async (t) => {
    const root = mkRoot(t);
    // Warm the cache through a working labeller.
    const warm = await labelWorkUnits([unit('k-cached')], {
      repoRoot: root, labeller: async () => 'a cached cluster name',
    });
    assert.equal(warm.labelled, 1);

    // Now the same unit with NO labeller available at all.
    let asked = 0;
    const res = await labelWorkUnits([unit('k-cached')], {
      repoRoot: root,
      labeller: null,            // falsy \u2192 defaultLabeller(), which has no key here
    });
    assert.equal(res.cached, 1, 'the label is on disk; nothing about it needs a provider');
    assert.equal(res.units[0].labelSource, 'llm-cached');
    assert.equal(res.units[0].label, 'a cached cluster name');
    assert.equal(asked, 0);
  });

  test('a cache MISS with no labeller is underived, and says so once', async (t) => {
    const res = await labelWorkUnits([unit('k-miss')], { repoRoot: mkRoot(t), labeller: null });
    assert.equal(res.cached, 0);
    assert.equal(res.failed, 1);
    assert.equal(res.units[0].labelSource, 'underived');
    assert.equal(res.reason, 'labeller-unavailable', 'the provider WAS needed and absent');
  });

  // The provider must be constructed at most once across concurrent units:
  // `Promise.all` runs them together, and a resolved-flag set before the await
  // let every other unit read an undefined labeller and call it unavailable.
  test('the labeller is resolved ONCE across concurrent units', async (t) => {
    let built = 0;
    const labeller = async () => 'shared name';
    const res = await labelWorkUnits(
      [unit('c1'), unit('c2'), unit('c3')],
      { repoRoot: mkRoot(t), labeller: (() => { built++; return labeller; })() },
    );
    assert.equal(built, 1);
    assert.equal(res.labelled, 3, 'every unit got a label, not just the first');
    assert.equal(res.reason, null, 'and no unit concluded the provider was unavailable');
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
