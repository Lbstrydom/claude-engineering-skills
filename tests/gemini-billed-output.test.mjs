/**
 * @fileoverview One Gemini billed-output oracle — behaviour + a discovery census.
 *
 * The census is DISCOVERY-based, not a hand-written adapter list. A list cannot
 * fail when a sixth adapter is added; it reports `5/5 green` while the new one
 * under-meters. It also triggers on `usageMetadata` rather than
 * `candidatesTokenCount`, which closes the other half: a new caller reading
 * `promptTokenCount`/`thoughtsTokenCount` and never mentioning candidates still
 * has to touch `usageMetadata` to get at them.
 *
 * This is not hypothetical. When the census was first written the plan named
 * FOUR adapters; the scan found seven files touching `usageMetadata` — including
 * `llm-wrappers.mjs`, which handed callers Google's raw object, and
 * `embed-text.mjs`, which is legitimately different.
 *
 * @module tests/gemini-billed-output
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeGeminiUsage } from '../scripts/lib/gemini-usage.mjs';
import { _internals as efficacy } from '../scripts/lib/efficacy-lints.mjs';

/**
 * Source with comments and string literals blanked, so the census reads CODE.
 *
 * Reused from `efficacy-lints.mjs` rather than re-implemented: it is already the
 * repo's tested comment/string stripper, and the alternative — rewording the
 * comments that document this very fix so a scanner stops tripping on them — is
 * letting the instrument dictate the prose. Without it the census flags three
 * files whose only "offence" is explaining why `candidatesTokenCount` excludes
 * `thoughtsTokenCount`, which is the exact text-census false-fail the plan
 * criticised.
 */
const codeOf = (file, src) => efficacy.stripForDetection(src, efficacy.stylesFor(file));

describe('normalizeGeminiUsage — billed output means candidates PLUS thoughts', () => {
  it('folds thoughts into output_tokens', () => {
    // The measured real case: bake-off snapshot 21245f6aae1c.
    const u = normalizeGeminiUsage({ promptTokenCount: 54288, candidatesTokenCount: 310, thoughtsTokenCount: 17792 });
    assert.equal(u.output_tokens, 18102);
    assert.equal(u.input_tokens, 54288);
  });

  it('reports thinking as the share WITHIN output, never an addend', () => {
    const u = normalizeGeminiUsage({ promptTokenCount: 1, candidatesTokenCount: 310, thoughtsTokenCount: 17792 });
    assert.equal(u.thinking_tokens, 17792);
    assert.ok(u.thinking_tokens < u.output_tokens, 'summing the two would double-count');
  });

  it('a model that reports no thoughts is complete, not missing', () => {
    // A non-thinking model omits the field entirely. That is a full response.
    const u = normalizeGeminiUsage({ promptTokenCount: 10, candidatesTokenCount: 5 });
    assert.equal(u.thinking_tokens, 0);
    assert.equal(u.output_tokens, 5);
    assert.equal(u.usageMissing, false);
  });

  it('a MEASURED zero survives as a measured zero', () => {
    // The distinction the whole change set exists to protect: 0 tokens actually
    // reported is not the same fact as "the provider told us nothing".
    const u = normalizeGeminiUsage({ promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0 });
    assert.equal(u.usageMissing, false);
    assert.equal(u.output_tokens, 0);
  });

  it('absent or partial metadata sets usageMissing', () => {
    for (const bad of [null, undefined, {}, { promptTokenCount: 5 }, { candidatesTokenCount: 5 },
      { promptTokenCount: 'x', candidatesTokenCount: 1 }, { promptTokenCount: NaN, candidatesTokenCount: 1 }]) {
      assert.equal(normalizeGeminiUsage(bad).usageMissing, true, `should be missing: ${JSON.stringify(bad)}`);
    }
  });

  it('never emits a negative or non-finite count', () => {
    const u = normalizeGeminiUsage({ promptTokenCount: -5, candidatesTokenCount: Infinity, thoughtsTokenCount: -1 });
    for (const v of [u.input_tokens, u.output_tokens, u.thinking_tokens]) {
      assert.ok(Number.isFinite(v) && v >= 0, `bad count ${v}`);
    }
    assert.equal(u.usageMissing, true);
  });
});

describe('discovery census — no second place may decide what billed output means', () => {
  /** Files allowed to touch `usageMetadata`, each with the reason it is exempt. */
  const ALLOWLIST = new Map([
    ['scripts/lib/gemini-usage.mjs', 'IS the oracle'],
    ['scripts/lib/embed-text.mjs',
      'embeddings: reads totalTokenCount only. An embedding has no candidates/thoughts, '
      + 'so there is no billed OUTPUT to under-count — a different quantity, not a second opinion.'],
  ]);

  /** Every .mjs under scripts/, recursively. */
  function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.name.endsWith('.mjs')) out.push(p.replaceAll(path.sep, '/'));
    }
    return out;
  }

  // The FIELD names are where the semantics live. A call site must mention
  // `usageMetadata` to hand it over — that is not the offence. Reading a field
  // OFF it is: that is a second place deciding what billed output means.
  const SEMANTIC_FIELDS = /\b(candidatesTokenCount|promptTokenCount|thoughtsTokenCount|totalTokenCount)\b/;

  it('no file outside the oracle INTERPRETS Gemini usage fields', () => {
    const offenders = [];
    for (const f of walk('scripts')) {
      if (ALLOWLIST.has(f)) continue;
      if (SEMANTIC_FIELDS.test(codeOf(f, fs.readFileSync(f, 'utf8')))) offenders.push(f);
    }
    assert.deepEqual(offenders, [], 'these decode Gemini usage themselves instead of via normalizeGeminiUsage()');
  });

  it('any file that touches usageMetadata must route it through the oracle', () => {
    // Closes the pass-through hole: handing callers Google's raw object (what
    // llm-wrappers.mjs did) mentions no field name at all, so the field rule
    // alone would miss it.
    const offenders = [];
    for (const f of walk('scripts')) {
      if (ALLOWLIST.has(f)) continue;
      const src = codeOf(f, fs.readFileSync(f, 'utf8'));
      if (src.includes('usageMetadata') && !src.includes('normalizeGeminiUsage')) offenders.push(f);
    }
    assert.deepEqual(offenders, [], 'these see usageMetadata without importing the oracle');
  });

  it('the census actually SCANS something — a vacuous pass is a failing census', () => {
    // If the walk broke (wrong dir, wrong extension) the assertion above would
    // pass having read nothing, which is the sandbox-honesty failure in
    // miniature. Anchor it: the oracle itself must be found by the same walk.
    const files = walk('scripts');
    assert.ok(files.length > 100, `walk found only ${files.length} files — scan is broken`);
    assert.ok(files.includes('scripts/lib/gemini-usage.mjs'));
    const withUsage = files.filter((f) => fs.readFileSync(f, 'utf8').includes('usageMetadata'));
    assert.ok(withUsage.length >= 2, 'expected the oracle + at least one allowlisted site to be found');
  });

  it('every allowlist entry still exists — a stale exemption is a silent hole', () => {
    for (const f of ALLOWLIST.keys()) {
      assert.ok(fs.existsSync(f), `allowlisted file is gone: ${f} — drop the entry`);
    }
  });
});

describe('call sites map the oracle into their OWN shape, and keep usageMissing', () => {
  // Each adapter has an established, differing contract. Converging them would
  // trade an under-metering bug for a zeroed-field bug in its consumers; what
  // must survive everywhere is the provenance flag.
  const SITES = [
    ['scripts/lib/audit-shadow.mjs', /output_tokens: g\.output_tokens/, /usageMissing: g\.usageMissing/],
    ['scripts/lib/brainstorm/gemini-adapter.mjs', /outputTokens: g\.output_tokens/, /usageMissing: g\.usageMissing/],
    ['scripts/lib/arm-eval/producers/model-call.mjs', /output_tokens: g\.output_tokens/, /usageMissing: g\.usageMissing/],
    ['scripts/gemini-review.mjs', /output_tokens: g\.output_tokens/, /usageMissing: g\.usageMissing/],
  ];

  /**
   * A call site must IMPORT the oracle, not merely mention it.
   *
   * This caught the same defect twice: an automated wiring pass reported
   * "already wired" because the literal `gemini-usage.mjs` appeared in a COMMENT
   * it had just written, so `gemini-review.mjs` and
   * `model-eval/provider-adapter.mjs` both called `normalizeGeminiUsage`
   * without importing it. Neither a module-load check nor a symbol-presence
   * check finds that — the reference sits inside a function body, so it only
   * throws when the branch actually runs, and the symbol IS present.
   */
  const importsOracle = (src) => /^import\s*\{[^}]*\bnormalizeGeminiUsage\b[^}]*\}\s*from\s*['"][^'"]*gemini-usage\.mjs['"]/m.test(src);

  for (const [file, outputRe, missingRe] of SITES) {
    it(`${file} takes billed output from the oracle and carries usageMissing`, () => {
      const src = fs.readFileSync(file, 'utf8');
      assert.ok(importsOracle(src), `${file} calls normalizeGeminiUsage without importing it — a ReferenceError at runtime`);
      assert.match(src, outputRe);
      assert.match(src, missingRe, 'dropping usageMissing here reconciles an unmeterable call to a fake €0');
    });
  }

  it('provider-adapter preserves its null-usage contract while using the oracle', () => {
    // This one legitimately returns `null` (not a zeroed object) when metadata
    // is absent, because the cost layer keys `usageStatus:'missing'` off that.
    const src = fs.readFileSync('scripts/lib/model-eval/provider-adapter.mjs', 'utf8');
    assert.ok(src.includes('normalizeGeminiUsage'));
    assert.match(src, /g\.usageMissing\s*\n?\s*\?\s*null/);
  });
});

describe('audit fixes — absent, invalid, and unmeterable are three different facts', () => {
  it('an INVALID thoughtsTokenCount is missing, not a silent zero (M4)', () => {
    // Absent thoughts is a complete response from a non-thinking model.
    // Present-but-unreadable means the provider said something we could not
    // parse — reporting a confident billed total there is a fabricated number.
    const bad = normalizeGeminiUsage({ promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 'invalid' });
    assert.equal(bad.usageMissing, true);
    const absent = normalizeGeminiUsage({ promptTokenCount: 10, candidatesTokenCount: 5 });
    assert.equal(absent.usageMissing, false, 'absent thoughts must stay benign');
    const explicitNull = normalizeGeminiUsage({ promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: null });
    assert.equal(explicitNull.usageMissing, false, 'null reads as absent, not as unreadable');
  });

  it('brainstorm reports NULL cost when usage is unmeterable (H1)', () => {
    // Costing the zeros that absent metadata sanitizes to would report a
    // successful call as $0.00 — a fake measurement in the shape of a real one.
    const src = fs.readFileSync('scripts/lib/brainstorm/gemini-adapter.mjs', 'utf8');
    assert.match(src, /usage\.usageMissing \? null : estimateCostUsd/);
  });

  it('EVERY model-call branch carries usageMissing, not just Gemini (M3)', () => {
    // One honest branch beside two that coerce absent-to-zero is worse than
    // uniform silence: a consumer cannot tell which zeros it may trust.
    const src = codeOf('scripts/lib/arm-eval/producers/model-call.mjs',
      fs.readFileSync('scripts/lib/arm-eval/producers/model-call.mjs', 'utf8'));
    const returns = src.split('\n').filter((l) => l.includes('usage: {'));
    assert.equal(returns.length, 3, 'expected the OSS, Gemini and GPT return shapes');
    for (const r of returns) assert.match(r, /usageMissing/, `branch without usageMissing: ${r.trim().slice(0, 90)}`);
  });
});

describe('every oracle caller actually IMPORTS it (audit M1, twice)', () => {
  function walkAll(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walkAll(p, out);
      else if (e.name.endsWith('.mjs')) out.push(p.replaceAll(path.sep, '/'));
    }
    return out;
  }

  it('no file CALLS normalizeGeminiUsage without importing it', () => {
    // The failure mode is invisible to a module-load check: the reference lives
    // inside a function body, so it throws only when that branch runs. Two
    // files shipped in exactly that state before this test existed.
    const broken = [];
    for (const f of walkAll('scripts')) {
      if (f === 'scripts/lib/gemini-usage.mjs') continue;   // defines it
      const src = fs.readFileSync(f, 'utf8');
      const code = codeOf(f, src);
      if (!code.includes('normalizeGeminiUsage(')) continue;
      const imports = /^import\s*\{[^}]*\bnormalizeGeminiUsage\b[^}]*\}\s*from\s*['"][^'"]*gemini-usage\.mjs['"]/m.test(src);
      if (!imports) broken.push(f);
    }
    assert.deepEqual(broken, [], 'these call the oracle without importing it (ReferenceError at runtime)');
  });
});

describe('the DERIVED total is validated too, not just its inputs (audit M2)', () => {
  it('an overflowing sum of two finite counts is unmeterable, not Infinity', () => {
    // Number.MAX_VALUE + Number.MAX_VALUE === Infinity. An Infinite output would
    // reach costFromUsage and produce an Infinite cost that blows the € ceiling
    // while presenting itself as a measurement.
    const u = normalizeGeminiUsage({
      promptTokenCount: 1,
      candidatesTokenCount: Number.MAX_VALUE,
      thoughtsTokenCount: Number.MAX_VALUE,
    });
    assert.ok(Number.isFinite(u.output_tokens), `output_tokens must stay finite, got ${u.output_tokens}`);
    assert.equal(u.usageMissing, true, 'an unusable derived total is missing usage');
  });

  it('an ordinary large-but-finite sum is still measured', () => {
    const u = normalizeGeminiUsage({ promptTokenCount: 1, candidatesTokenCount: 1e6, thoughtsTokenCount: 1e6 });
    assert.equal(u.output_tokens, 2e6);
    assert.equal(u.usageMissing, false);
  });
});
