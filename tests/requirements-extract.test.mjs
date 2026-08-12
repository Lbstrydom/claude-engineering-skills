/**
 * Tests for scripts/lib/requirements/extract.mjs — the pure merge + id logic.
 * (The LLM call itself is exercised by a live `requirements extract` run,
 * not unit-tested.) Plan: docs/plans/requirements-layer.md — Plan-Phase A.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assignId, mergeRequirements, extractRequirements, splitOversizedFile, computeCovered } from '../scripts/lib/requirements/extract.mjs';
import { estimateTokens } from '../scripts/lib/repo-context.mjs';

function raw(over = {}) {
  return {
    assertion: 'The inventory excludes sensitive paths.', kind: 'security',
    checkable: true, provenance: [{ file: 'a.mjs', anchor: 'fn' }],
    appliesTo: [], evidence: { code: [], tests: [] }, ...over,
  };
}

describe('assignId', () => {
  it('is content-derived and deterministic', () => {
    const a = assignId({ kind: 'security', assertion: 'X must hold.', provenance: [{ file: 'a.mjs' }] });
    const b = assignId({ kind: 'security', assertion: 'X must hold.', provenance: [{ file: 'a.mjs' }] });
    assert.equal(a, b);
    assert.match(a, /^REQ-security-[0-9a-f]{8}$/);
  });
  it('differs when content differs', () => {
    const a = assignId({ kind: 'security', assertion: 'X must hold.', provenance: [{ file: 'a.mjs' }] });
    const b = assignId({ kind: 'security', assertion: 'Y must hold.', provenance: [{ file: 'a.mjs' }] });
    assert.notEqual(a, b);
  });
  it('is insensitive to trivial whitespace/punctuation', () => {
    const a = assignId({ kind: 'safety', assertion: 'X holds', provenance: [{ file: 'a.mjs' }] });
    const b = assignId({ kind: 'safety', assertion: '  X   holds.  ', provenance: [{ file: 'a.mjs' }] });
    assert.equal(a, b);
  });
});

describe('mergeRequirements', () => {
  it('merges an identical assertion across 2 runs → seenInRuns:2, confidence:high', () => {
    const merged = mergeRequirements([[raw()], [raw()]], 2);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].seenInRuns, 2);
    assert.equal(merged[0].confidence, 'high');
    assert.match(merged[0].id, /^REQ-security-/);
  });
  it('keeps a run-1-only assertion as seenInRuns:1, confidence:low', () => {
    const merged = mergeRequirements([[raw()], [raw({ assertion: 'A totally different unrelated correctness invariant about parsing.' })]], 2);
    assert.equal(merged.length, 2);
    const solo = merged.find((m) => m.assertion.includes('parsing'));
    assert.equal(solo.seenInRuns, 1);
    assert.equal(solo.confidence, 'low');
  });
  it('never merges across different kinds even with similar text', () => {
    const merged = mergeRequirements([
      [raw({ kind: 'security' })],
      [raw({ kind: 'correctness' })],
    ], 2);
    assert.equal(merged.length, 2);
  });
  it('unions provenance / appliesTo / evidence across the cluster', () => {
    const merged = mergeRequirements([
      [raw({ provenance: [{ file: 'a.mjs', anchor: 'f1' }], appliesTo: ['a/**'] })],
      [raw({ provenance: [{ file: 'b.mjs', anchor: 'f2' }], appliesTo: ['b/**'] })],
    ], 2);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].provenance.length, 2);
    assert.deepEqual(merged[0].appliesTo.sort(), ['a/**', 'b/**']);
  });
});

// The sensitive-egress + repo-containment guards run BEFORE any file read or
// LLM call, so they are unit-testable without the network (audit M8 — these
// security paths previously had no direct regression coverage).
describe('extractRequirements — input guards (audit H2/H4/M8)', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-extract-'));

  it('rejects a path that escapes the repo root', async () => {
    await assert.rejects(
      extractRequirements({ files: ['../../etc/passwd'], baseDir, runs: 1 }),
      /escapes the repo root/,
    );
  });
  it('rejects a sensitive path before reading or sending it', async () => {
    await assert.rejects(
      extractRequirements({ files: ['.env'], baseDir, runs: 1 }),
      /sensitive path/,
    );
  });
  it('rejects a non-existent in-repo file with a clear error', async () => {
    await assert.rejects(
      extractRequirements({ files: ['does-not-exist.mjs'], baseDir, runs: 1 }),
      /file not found/,
    );
  });
  it('rejects an empty file set', async () => {
    await assert.rejects(extractRequirements({ files: [], baseDir, runs: 1 }), /files required/);
  });
});

// ── Oversized files: split, never refuse, never partially cover ─────────────
//
// The budget refused any single file over 18K tokens with "split or exclude
// them". Refusing beat truncating, but it made FILE SIZE decide whether a
// module's invariants could exist in the ledger at all — and size correlates
// with invariant density. Measured 2026-08-12: store/runs-findings.mjs (~23.6K)
// and store/plans-ship.mjs (~20.0K), which between them own the findings
// upsert, the write receipts, the fingerprint oracle and the upsertPlan result
// contract, were absent from a 269-entry ledger for that reason alone.
describe('splitOversizedFile', () => {
  const build = (decls) => decls.map((d, i) => `export function f${i}() {\n${d}\n}`).join('\n');

  it('is LOSSLESS — rejoining the parts reproduces the file exactly', () => {
    // The assertion that matters most: a lossy split silently drops code, and
    // the invariants in the dropped region simply never appear. Nothing
    // downstream could detect that.
    const body = build(Array.from({ length: 60 }, (_, i) => `  const x${i} = ${i}; // ${'pad '.repeat(40)}`));
    const parts = splitOversizedFile({ file: 'a.mjs', body }, 500);
    assert.ok(parts.length > 1, 'the fixture must actually split');
    assert.equal(parts.map((p) => p.body).join('\n'), body);
  });

  it('every part fits the budget, which is the point of splitting', () => {
    const body = build(Array.from({ length: 60 }, (_, i) => `  const x${i} = ${i}; // ${'pad '.repeat(40)}`));
    const parts = splitOversizedFile({ file: 'a.mjs', body }, 500);
    for (const p of parts) assert.ok(estimateTokens(p.body) <= 500, `part ${p.part} still over budget`);
  });

  it('parts keep the REAL file path, so provenance is unaffected', () => {
    const body = build(Array.from({ length: 60 }, (_, i) => `  const x${i} = ${i}; // ${'pad '.repeat(40)}`));
    const parts = splitOversizedFile({ file: 'scripts/lib/store/big.mjs', body }, 500);
    for (const p of parts) assert.equal(p.file, 'scripts/lib/store/big.mjs');
    assert.deepEqual([...new Set(parts.map((p) => p.parts))], [parts.length]);
  });

  it('splits AT declaration boundaries, not mid-construct', () => {
    // A fragment cut through a function body carries no invariant, so the
    // extractor would be reading noise. Each part must start at a top-level
    // declaration (or be the first part).
    const body = build(Array.from({ length: 60 }, (_, i) => `  const x${i} = ${i}; // ${'pad '.repeat(40)}`));
    const parts = splitOversizedFile({ file: 'a.mjs', body }, 500);
    for (const p of parts.slice(1)) {
      assert.match(p.body.split('\n')[0], /^(export|function|const|class|\/\*\*)/,
        `part ${p.part} starts mid-construct`);
    }
  });
});

describe('computeCovered — all-or-nothing per file', () => {
  it('a file whose parts ALL succeeded is covered', () => {
    const covered = computeCovered(new Map([['a.mjs', 3]]), new Map([['a.mjs', 3]]));
    assert.deepEqual(covered, ['a.mjs']);
  });

  it('a PARTIALLY extracted file is NOT covered — that is silent data loss', () => {
    // reconcile scoped-REPLACES a covered file's requirements, so marking this
    // covered would delete the invariants the missing part carries.
    const covered = computeCovered(new Map([['a.mjs', 3]]), new Map([['a.mjs', 2]]));
    assert.deepEqual(covered, [], 'a 2-of-3 extraction must not replace the file\'s requirements');
  });

  it('one file failing does not un-cover an unrelated file that succeeded', () => {
    const covered = computeCovered(
      new Map([['a.mjs', 2], ['b.mjs', 1]]),
      new Map([['a.mjs', 1], ['b.mjs', 1]]),
    );
    assert.deepEqual(covered, ['b.mjs']);
  });
});

// ── Tiered escalation: a single top-level declaration bigger than the budget ─
//
// The whole-repo run hit this for real: `legacy-production-audit.mjs`'s
// `runLegacyProductionAudit` is a single ~1,600-line `export async function`
// declaration, well over budget on its own. Tier 1 (top-level declarations)
// legitimately finds NO further boundary inside it — there is exactly one.
// Splitting has to escalate to a coarser tier or the file is unsplittable
// again, just one level down from where it was fixed.
describe('splitOversizedFile — escalates past a single oversized declaration', () => {
  it('a declaration with internal SECTION BANNERS splits at them (tier 2)', () => {
    // Each SECTION must fit the budget on its own (~43 tok here) while the
    // WHOLE declaration does not (~265 tok at budget 100) — otherwise the test
    // cannot tell "split at banners" from "couldn't split at all", which is
    // exactly the failure mode a badly-tuned fixture produced on the first
    // write: a section too dense to fit even after splitting made this test
    // fail for the RIGHT mechanism (tier 3 correctly finding nothing) and the
    // WRONG reason (the fixture, not the splitter).
    const banner = (n) => `  // ── Section ${n} ──────────────`;
    const filler = () => Array.from({ length: 6 }, (_, j) => `  const v${j} = ${j}; // pad`).join('\n');
    const body = `export async function big() {\n${[0, 1, 2, 3, 4, 5].map((n) => `${banner(n)}\n${filler()}`).join('\n')}\n}`;
    const parts = splitOversizedFile({ file: 'a.mjs', body }, 100);
    assert.ok(parts.length > 1, 'must actually split — this is the regression case');
    for (const p of parts) assert.ok(estimateTokens(p.body) <= 100, `part ${p.part} still over budget`);
    assert.equal(parts.map((p) => p.body).join('\n'), body, 'must stay lossless through the escalation');
  });

  it('with NO banners either, falls back to blank-line boundaries (tier 3)', () => {
    // Same sizing discipline as the tier-2 fixture above: one blank-delimited
    // block fits (~35 tok), the whole declaration does not (~216 tok at 100).
    const filler = () => Array.from({ length: 6 }, (_, j) => `  const v${j} = ${j}; // pad`).join('\n');
    const body = `export async function big() {\n${Array.from({ length: 6 }, filler).join('\n\n')}\n}`;
    const parts = splitOversizedFile({ file: 'a.mjs', body }, 100);
    assert.ok(parts.length > 1);
    for (const p of parts) assert.ok(estimateTokens(p.body) <= 100);
    assert.equal(parts.map((p) => p.body).join('\n'), body);
  });

  it('an individually oversized chunk found among several is ITSELF escalated', () => {
    // Distinct from the tier-2 test above: there, ONE PASS of banner-splitting
    // already produced all-under-budget chunks, so the per-chunk recursive
    // call (`splitBody(c, budget, tier+1)` inside the loop, as opposed to the
    // "this tier found nothing at all" escalation) was never exercised — a
    // mutation deleting it survived on that fixture alone.
    //
    // Two top-level declarations: one tiny, one over budget with two banner
    // sections. Tier 0 (top-level) finds the boundary between them — TWO
    // chunks, so this does NOT take the "found nothing" path — but the first
    // chunk (the whole big function) is itself still oversized and must be
    // escalated to tier 1 (banners) on its own, independently of the second.
    const block = (n) => Array.from({ length: 6 }, (_, j) => `  const v${n}_${j} = ${j}; // pad`).join('\n');
    const func1 = `export function f1() {\n  // ── A ──\n${block('a')}\n  // ── B ──\n${block('b')}\n}`; // ~88 tok
    const func2 = 'export const tiny = 1;'; // trivially fits; must survive un-split
    const body = `${func1}\n${func2}`;
    const budget = 60; // between one banner section (~41) and func1 whole (~88)
    const parts = splitOversizedFile({ file: 'a.mjs', body }, budget);
    assert.ok(parts.length >= 3, 'func1 must be split into its two sections, plus func2');
    for (const p of parts) assert.ok(estimateTokens(p.body) <= budget, `part ${p.part} still over budget — the per-chunk escalation did not run`);
    assert.equal(parts.map((p) => p.body).join('\n'), body);
  });

  it('a single line/statement bigger than the budget still throws loudly, never silently truncates', () => {
    const body = `export const x = "${'a'.repeat(200000)}";`; // one line, no boundary of any tier
    const parts = splitOversizedFile({ file: 'a.mjs', body }, 400);
    // splitOversizedFile itself does not throw (the caller decides); it
    // reports failure by returning the WHOLE oversized body as one part, which
    // the caller's own stillOver check turns into the loud error.
    assert.equal(parts.length, 1);
    assert.ok(estimateTokens(parts[0].body) > 400, 'the caller must see this as still-over-budget, not as success');
  });
});
