/**
 * @fileoverview The trap guard: a Zod schema handed to a provider via
 * `z.toJSONSchema` SILENTLY loses every refinement it carries.
 *
 * This is not a hypothetical. It cost this repo three recurrences of one bug —
 * each read as mass model hallucination, each costing a live repro to find:
 *   1. V1 schema stripped evidence fields  -> every candidate Stage-0 `fabricated`
 *   2. GLM `modified`-anchor rule          -> loud generator failure, all runs fell back
 *   3. Sonnet omitted oldFile/newFile      -> every candidate `fabricated`, SILENTLY
 *      (measured: 4/4 rejected, 4/4 malformed by OUR schema, 0/4 real fabrications;
 *       stage0Verified > 0 in 1 of 62 completed shadow runs)
 *
 * The root cause is not any one schema — it is that `superRefine`/`refine` live
 * in a layer JSON Schema cannot express, so "the provider validates it" is
 * always false and always silent. That is mechanically detectable, therefore
 * lintable rather than memorable. This file is the lint.
 *
 * Two assertions, deliberately (plan §7d):
 *   1. COVERAGE — every `z.toJSONSchema(` call site's argument is registered.
 *      A hand-maintained list protects only today's schemas; the source scan is
 *      what stops the list falling behind a NEW provider contract.
 *   2. PROPERTY — every registered schema's tree is refinement-free.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PROVIDER_FACING_SCHEMAS, makeProducerFindingV3Schema } from '../scripts/lib/schemas.mjs';
// Provider-facing but defined at its call site. schemas.mjs must NOT import it
// (gemini-review.mjs imports schemas.mjs — that would be circular), so the
// TEST is the registry seam: it imports from both and covers both. Safe to
// import — the module's CLI sits behind an `import.meta.url` guard.
import { GeminiFinalReviewSchema } from '../scripts/gemini-review.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Zod 4 detection mechanics ────────────────────────────────────────────────
// Pinned as fixtures because the Zod-3 intuition is WRONG and will mislead the
// next reader — the Gemini gate asserted this exact error while reviewing the
// plan. In Zod 4 `.superRefine()` does NOT wrap the schema in a `ZodEffects`
// node; `ZodEffects` does not exist in Zod 4 at all. The node keeps
// `_def.type === 'object'` and gains a `_def.checks` entry.
describe('Zod 4 refinement mechanics — the trap, pinned', () => {
  it('a refinement is detectable on the node itself (NOT a ZodEffects wrapper)', () => {
    const plain = z.object({ a: z.string() });
    const refined = z.object({ a: z.string() }).superRefine(() => {});
    assert.equal(plain._def.type, 'object');
    assert.equal(refined._def.type, 'object', 'Zod 4 does NOT rewrap as ZodEffects — hunting for one finds nothing and passes silently');
    assert.equal((plain._def.checks || []).length, 0);
    assert.equal((refined._def.checks || []).length, 1, 'the refinement lands in _def.checks');
    assert.ok(!('ZodEffects' in z), 'ZodEffects is a Zod-3 concept; if this fails, Zod changed and this guard needs re-verifying');
  });

  it('only `custom` checks are dropped — .max/.min/.int ARE expressible and must NOT be flagged', () => {
    // A guard that fires on `.max(200)` gets switched off within a day, which
    // is worse than no guard. This pins the discriminator.
    assert.deepEqual(findRefinements(z.object({ a: z.string().max(3).min(1) })), [], '.max/.min emit as maxLength/minLength');
    assert.deepEqual(findRefinements(z.object({ a: z.number().int() })), [], '.int() emits as integer');
    assert.match(JSON.stringify(z.toJSONSchema(z.string().max(3))), /maxLength/, 'precondition: .max really does emit');
  });

  it('THE trap: z.toJSONSchema emits a byte-identical schema despite the refinement', () => {
    const plain = z.object({ a: z.string() });
    const refined = z.object({ a: z.string() }).superRefine(() => {});
    assert.equal(
      JSON.stringify(z.toJSONSchema(plain)),
      JSON.stringify(z.toJSONSchema(refined)),
      'if these ever differ, JSON Schema CAN carry the rule and this whole guard may be redundant — re-check before deleting it',
    );
  });

  it('a NESTED refinement leaves the root checks empty — which is why the walk is mandatory', () => {
    const nested = z.object({ a: z.string().refine(() => true) });
    assert.equal((nested._def.checks || []).length, 0, 'a root-only check would PASS this schema while its child carries a dropped constraint');
  });
});

/**
 * Is this check one `z.toJSONSchema` SILENTLY DROPS?
 *
 * Not every `_def.checks` entry is a trap — most are expressible and emit
 * correctly. Only `check: 'custom'` (i.e. `.refine()` / `.superRefine()`) has
 * no JSON Schema representation and vanishes without a word:
 *
 *   .max(3)   -> $ZodCheckMaxLength  / 'max_length'    -> maxLength   ✓ emitted
 *   .min(1)   -> $ZodCheckMinLength  / 'min_length'    -> minLength   ✓ emitted
 *   .int()    -> ZodNumberFormat     / 'number_format' -> integer     ✓ emitted
 *   .refine() -> ZodCustom           / 'custom'        -> NOTHING     ✗ DROPPED
 *
 * A guard that flags every check would fire on `.max(200)` and be turned off
 * within a day — which is worse than no guard.
 */
function isDroppedRefinement(check) {
  return (check?._zod?.def?.check ?? check?._def?.check) === 'custom';
}

/**
 * Walk a Zod schema tree, returning the paths of every node carrying a
 * DROPPED refinement. Recurses object shapes, array elements, union options,
 * and optional/nullable/default inners — a root-only check is not sufficient
 * (see the nested fixture above).
 *
 * The single-node key set covers every Zod-4 wrapper that hangs a child schema
 * off `_def`:
 *   element/innerType/valueType/keyType — array / optional·nullable·default /
 *     record value / map key (`innerType` ALSO carries ZodPromise's inner —
 *     Zod 4 names it `innerType`, NOT `type`; `_def.type` is the string
 *     discriminator, so hunting for a `type` child finds a string, never a
 *     schema).
 *   left/right — ZodIntersection's two branches.
 *   rest — ZodTuple's rest element (its fixed `items` are walked as an array).
 * The last three closed a known walker hole: no provider schema uses an
 * intersection or tuple-rest today, but the walker is the safety net, and a net
 * with a known gap is the exact thing it exists to prevent.
 */
function findRefinements(schema, cursor = '(root)', seen = new Set()) {
  if (!schema || typeof schema !== 'object' || seen.has(schema)) return [];
  seen.add(schema);
  const def = schema._def;
  if (!def) return [];
  const hits = (def.checks || []).some(isDroppedRefinement) ? [cursor] : [];

  if (def.shape) {
    for (const [k, v] of Object.entries(typeof def.shape === 'function' ? def.shape() : def.shape)) {
      hits.push(...findRefinements(v, `${cursor}.${k}`, seen));
    }
  } else if (schema.shape) {
    for (const [k, v] of Object.entries(schema.shape)) hits.push(...findRefinements(v, `${cursor}.${k}`, seen));
  }
  for (const key of ['element', 'innerType', 'valueType', 'keyType', 'left', 'right', 'rest']) {
    if (def[key]) hits.push(...findRefinements(def[key], `${cursor}<${key}>`, seen));
  }
  for (const key of ['options', 'items']) {
    if (Array.isArray(def[key])) def[key].forEach((o, i) => hits.push(...findRefinements(o, `${cursor}[${i}]`, seen)));
  }
  return hits;
}

describe('every provider-facing schema is refinement-free (the PROPERTY)', () => {
  const cases = [
    ['ProducerEvidenceAnchorSchema', PROVIDER_FACING_SCHEMAS.ProducerEvidenceAnchorSchema],
    // The per-run V3 is dynamic — refinement-freeness is a property of the
    // factory, so instantiate it with a probe id.
    ['makeProducerFindingV3Schema(["f0001"])', makeProducerFindingV3Schema(['f0001'])],
    // Covered directly rather than allow-listed: it IS provider-facing, and
    // "verified refinement-free by inspection" is exactly the manual claim
    // this guard exists to replace.
    ['GeminiFinalReviewSchema', GeminiFinalReviewSchema],
  ];

  for (const [name, schema] of cases) {
    it(`${name} carries no refinement anywhere in its tree`, () => {
      const hits = findRefinements(schema);
      assert.deepEqual(hits, [], `${name} carries refinement(s) at: ${hits.join(', ')} — a provider CANNOT enforce these, and z.toJSONSchema drops them SILENTLY. Derive the fact instead of asking for it, or express the rule as required/enum/discriminatedUnion.`);
    });
  }

  it('the guard actually catches a refinement (a lint that cannot fail is theatre)', () => {
    assert.deepEqual(findRefinements(z.object({ a: z.string() }).superRefine(() => {})), ['(root)']);
    assert.deepEqual(findRefinements(z.object({ a: z.string().refine(() => true) })), ['(root).a'], 'must catch it NESTED too');
  });

  it('catches a refinement inside a ZodIntersection branch (left/right), and does NOT flag a clean one', () => {
    // The closed walker hole: an intersection hangs its two branches off
    // `_def.left`/`_def.right`, which the walker did not visit before G3.
    const clean = z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() }));
    assert.deepEqual(findRefinements(clean), [], 'a refinement-free intersection must NOT be flagged');

    const dirtyLeft = z.intersection(z.object({ a: z.string() }).superRefine(() => {}), z.object({ b: z.number() }));
    const dirtyRight = z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() }).superRefine(() => {}));
    assert.ok(findRefinements(dirtyLeft).some((p) => p.includes('left')), `a superRefine on the LEFT branch must be caught (got ${JSON.stringify(findRefinements(dirtyLeft))})`);
    assert.ok(findRefinements(dirtyRight).some((p) => p.includes('right')), `a superRefine on the RIGHT branch must be caught (got ${JSON.stringify(findRefinements(dirtyRight))})`);
    // NESTED inside a branch too — the walk must not stop at the branch node.
    const nested = z.intersection(z.object({ a: z.string().refine(() => true) }), z.object({ b: z.number() }));
    assert.ok(findRefinements(nested).some((p) => p.includes('left') && p.endsWith('.a')), 'a refinement nested inside a branch must be caught');
  });

  it('catches a refinement in a ZodTuple rest element and a ZodPromise inner (the other two closed gaps)', () => {
    // Tuple `rest` was unvisited before G3; ZodPromise's inner is `innerType`
    // (already walked) — pinned here so a future reader does not "fix" it to a
    // non-existent `_def.type` schema child.
    assert.ok(findRefinements(z.tuple([z.string()], z.number().superRefine(() => {}))).some((p) => p.includes('rest')), 'tuple rest element must be caught');
    assert.ok(findRefinements(z.promise(z.string().superRefine(() => {}))).some((p) => p.includes('innerType')), 'promise inner (innerType, NOT type) must be caught');
  });

  it('discriminatedUnion expresses the commission/omission rule ENFORCEABLY (the V2 superRefine it replaces)', () => {
    const js = JSON.stringify(z.toJSONSchema(makeProducerFindingV3Schema(['f0001'])));
    assert.match(js, /oneOf|anyOf/, 'must emit per-branch alternatives the provider can enforce');
    assert.match(js, /causalChain/, 'the omission branch must require causalChain in the schema the provider SEES');
    assert.match(js, /f0001/, 'diffPathId must be enum-narrowed to this run\'s real ids');
  });
});

describe('COVERAGE — no z.toJSONSchema call site escapes the registry', () => {
  it('every provider-facing schema handed to z.toJSONSchema is registered', () => {
    const files = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
        else if (e.name.endsWith('.mjs')) files.push(p);
      }
    })(path.join(REPO, 'scripts'));

    // COVERED = the schemas.mjs registry PLUS schemas this test imports and
    // asserts on directly above. The property test's `cases` list is the real
    // contract; the registry is just its main source.
    const registered = new Set([...Object.keys(PROVIDER_FACING_SCHEMAS), 'GeminiFinalReviewSchema']);
    // Known-legacy call sites, each with a written justification. This list is
    // the pressure valve — it must stay SHORT and every entry must say why.
    //
    // Phase 6 (evidence-anchor-path-contract) RETIRED three entries whose
    // justification was literally "retired by Phase 6": `ProducerFindingV2Schema`
    // and its two local aliases (`strict` in model-eval-discovery.mjs,
    // `glmStrictSchema` in tiered-pipeline.mjs) no longer wrap V2 — both now
    // wrap the refinement-free V3 factory, so they are covered by the PROPERTY
    // test rather than excused here. A stale allowlist entry is a standing
    // licence for the exact bug the guard exists to catch, so they are deleted
    // rather than left inert.
    //
    // `glmStrictSchema` stays, with a NEW and different justification: it is a
    // local `z.object({findings: z.array(producerFindingSchema)})` wrapper whose
    // element IS registered, and whose own tree the property test covers via
    // `makeProducerFindingV3Schema`.
    const ALLOW = new Map([
      // §7d: "Dynamic per-run schemas (the id enum) are registered by their
      // FACTORY, which the scan treats as the call site; the factory's static
      // base is what carries (or must not carry) refinements." This is that
      // instance — `makeProducerFindingV3Schema` IS registered, and the property
      // test instantiates it with a probe id and walks the whole tree.
      ['producerFindingSchema', 'tiered-pipeline.mjs per-run instance of the REGISTERED makeProducerFindingV3Schema factory (the id enum is per-run, the shape is not) — refinement-freeness is a property of the factory and is asserted directly above.'],
      ['glmStrictSchema', 'tiered-pipeline.mjs local `{findings: [...]}` array wrapper around makeProducerFindingV3Schema — the element schema is registered and property-tested; the wrapper adds only .max(15).'],
      ['strict', 'model-eval-discovery.mjs local `{findings: [...]}` array wrapper around makeProducerFindingV3Schema — same shape, same coverage.'],
      ['zodSchema', 'oss-structured-output.mjs generic parameter — the caller owns the contract; the schema is whatever was passed in.'],
      ['schema', 'generic parameter name in a shared helper — the caller owns the contract.'],
      ['strictSchema', 'schemas.mjs-local alias inside zodToGeminiSchema — the caller owns the contract; the concrete schema is covered at ITS call site.'],
    ]);

    const unregistered = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf-8');
      for (const m of src.matchAll(/z\.toJSONSchema\(\s*([A-Za-z_$][\w$.]*)/g)) {
        const arg = m[1];
        if (registered.has(arg) || ALLOW.has(arg)) continue;
        unregistered.push(`${path.relative(REPO, file)}: z.toJSONSchema(${arg})`);
      }
    }
    assert.deepEqual(
      unregistered, [],
      'A schema reaches a provider without being registered in PROVIDER_FACING_SCHEMAS, so the refinement guard above never sees it — exactly how this bug class recurs. Register it (preferred), or add an ALLOW entry stating WHY it is knowingly unenforceable.',
    );
  });
});
