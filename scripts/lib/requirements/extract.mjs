/**
 * @fileoverview Requirements extraction — read source files, ask an LLM for
 * de-facto requirement assertions, run N times and merge.
 * Plan: docs/plans/requirements-layer.md — Plan-Phase A.
 *
 * De-facto assertions are HYPOTHESES, not requirements, until human/test-
 * confirmed — the prompt frames them descriptively. IDs are content-seeded
 * (`REQ-<kind>-<hash8>`), never positional, never LLM-supplied.
 *
 * @module scripts/lib/requirements/extract
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isPathSensitive, redactSecrets } from '../sensitive-egress-gate.mjs';
import { jaccardSimilarity } from '../ledger.mjs';
import { callOpenAI } from '../brainstorm/openai-adapter.mjs';
import { resolveModel, refreshModelCatalog } from '../model-resolver.mjs';
import { RawExtractionItemSchema } from './schema.mjs';
import { parseLlmJson } from './llm-json.mjs';
import { estimateTokens } from '../repo-context.mjs';

const MERGE_THRESHOLD = 0.6;            // assertion jaccard sim to count as "same"
// `CHUNK_TOKEN_BUDGET` caps a batch's *input*; it is deliberately small
// because extraction *output* scales with batch size — an invariant-rich
// file yields ~15-20 requirement objects, and too large a batch overflows
// `EXTRACT_MAX_OUTPUT_TOKENS` (a length-truncated response is unusable).
const CHUNK_TOKEN_BUDGET = 18_000;
const EXTRACT_MAX_OUTPUT_TOKENS = 16_000;

export const EXTRACTION_PROMPT = `You are extracting DE-FACTO REQUIREMENTS from existing source code — the
behavioural / safety / security / correctness / persistence invariants the
code already enforces (things that must remain TRUE as the code evolves).
These are DESCRIPTIVE observations of what the code does — hypotheses, not
yet confirmed intent.

Rules — each requirement:
- ONE sentence, a CHECKABLE assertion an automated audit could verify
  true/false against a future diff.
- NOT mechanical/low-level ("imports zod"). NOT vague ("must be secure").
- kind: one of security | safety | correctness | behavioural | persistence.
- checkable: true if an automated audit could verify it.
- provenance: [{file, anchor}] — WHERE it is declared/evidenced.
- appliesTo: [file or glob] — the files the invariant GOVERNS (often wider
  than provenance; [] if unknown).
- evidence: { code: [file refs], tests: [test refs] }.

Output STRICT JSON ONLY:
{"requirements":[{"assertion":"...","kind":"...","checkable":true,
  "provenance":[{"file":"...","anchor":"..."}],"appliesTo":["..."],
  "evidence":{"code":["..."],"tests":["..."]}}]}`;

/** Normalised assertion text for stable content-hashing. */
function normalizeAssertion(a) {
  return String(a).toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.;,]+$/, '').trim();
}

/** Content-seeded id: REQ-<kind>-<hash8> over kind + assertion + provenance files. */
export function assignId(c) {
  const provFiles = (c.provenance || []).map((p) => p.file).sort().join('|');
  const h = crypto.createHash('sha256')
    .update(`${c.kind}\x00${normalizeAssertion(c.assertion)}\x00${provFiles}`)
    .digest('hex').slice(0, 8);
  return `REQ-${c.kind}-${h}`;
}

/**
 * Merge raw extraction items across runs. Two items are "the same" when
 * `kind` matches AND assertion jaccard ≥ MERGE_THRESHOLD. The survivor's
 * `seenInRuns` counts distinct runs it appeared in (audit: spike found a
 * single run misses ~1 real invariant).
 *
 * @param {Array<Array<object>>} runResults - one raw-item array per run
 * @param {number} totalRuns
 * @returns {object[]} merged `RequirementCandidate`-shaped objects
 */
export function mergeRequirements(runResults, totalRuns) {
  const clusters = []; // { rep, runs:Set, items:[] }
  runResults.forEach((items, runIdx) => {
    for (const it of items || []) {
      if (!it || !it.assertion || !it.kind) continue;
      let c = clusters.find((cl) => cl.rep.kind === it.kind
        && jaccardSimilarity(normalizeAssertion(cl.rep.assertion), normalizeAssertion(it.assertion)) >= MERGE_THRESHOLD);
      if (!c) { c = { rep: it, runs: new Set(), items: [] }; clusters.push(c); }
      c.runs.add(runIdx);
      c.items.push(it);
    }
  });
  return clusters.map((c) => {
    const uniq = (arr) => [...new Set(arr.filter(Boolean))];
    const merged = {
      assertion: c.rep.assertion.trim().slice(0, 200),
      kind: c.rep.kind,
      checkable: c.items.some((i) => i.checkable === true),
      provenance: uniq(c.items.flatMap((i) => (i.provenance || []).map((p) => JSON.stringify({
        file: String(p.file || ''), anchor: String(p.anchor || '').slice(0, 200),
      })))).map((s) => JSON.parse(s)),
      appliesTo: uniq(c.items.flatMap((i) => i.appliesTo || [])),
      evidence: {
        code: uniq(c.items.flatMap((i) => i.evidence?.code || [])),
        tests: uniq(c.items.flatMap((i) => i.evidence?.tests || [])),
      },
      seenInRuns: c.runs.size,
      confidence: c.runs.size >= totalRuns ? 'high' : 'low',
    };
    if (merged.provenance.length === 0) merged.provenance = [{ file: c.rep.provenance?.[0]?.file || 'unknown', anchor: '' }];
    merged.id = assignId(merged);
    return merged;
  });
}

/**
 * Split ONE oversized file into parts that each fit the budget.
 *
 * **Why this exists.** The budget is sound — it is derived from
 * `EXTRACT_MAX_OUTPUT_TOKENS`, because extraction output scales with input and a
 * length-truncated response is unusable — but its UNIT was the whole file, so a
 * file's SIZE decided whether its invariants could be represented at all. Size
 * correlates with invariant density, so the modules most worth indexing were
 * exactly the ones refused: on 2026-08-12 `store/runs-findings.mjs` (~23.6K
 * tokens) and `store/plans-ship.mjs` (~20.0K) — which between them own the
 * findings upsert, the write receipts, the fingerprint oracle and the
 * `upsertPlan` result contract — were absent from a 269-entry ledger for that
 * reason alone. That is selection bias, not a rounding error, and raising the
 * cap would only move the cliff.
 *
 * Splits at TOP-LEVEL boundaries (a line starting in column 0 with `export`,
 * `function`, `const`, `class`, …) so a part is a set of whole declarations
 * rather than an arbitrary byte range — the extractor is reading for
 * invariants, and half a function has none. Each part keeps the REAL file path,
 * so provenance and `appliesTo` are unaffected; only the prompt header says
 * which part it is.
 *
 * @returns {{file: string, body: string, part: number, parts: number}[]}
 */
export function splitOversizedFile(fb, budget = CHUNK_TOKEN_BUDGET) {
  const lines = fb.body.split('\n');
  // Boundary = a plausible top-level declaration start. Deliberately generous:
  // a missed boundary only makes a part larger, and the size check below is
  // what actually bounds it.
  const isBoundary = (l) => /^(export\s|async\s+function\s|function\s|const\s|let\s|var\s|class\s|\/\*\*)/.test(l);
  const parts = [];
  let cur = [];
  const flush = () => { if (cur.length) { parts.push(cur.join('\n')); cur = []; } };
  for (const line of lines) {
    // Start a new part only AT a boundary, and only once the current one is
    // already large enough to be worth closing.
    if (cur.length && isBoundary(line) && estimateTokens(cur.join('\n')) > budget * 0.6) flush();
    cur.push(line);
  }
  flush();
  return parts.map((body, i) => ({ file: fb.file, body, part: i + 1, parts: parts.length }));
}

/**
 * Which files are genuinely covered by a run — ALL-OR-NOTHING per file.
 *
 * Pure and exported because this is where splitting could cause silent data
 * loss: `reconcile` scoped-REPLACES a covered file's requirements, so marking a
 * file covered after only some of its parts came back would delete the
 * invariants the failed parts carry. That is the same shape as the existing
 * per-batch coverage rule (a failed batch's files are not covered, Gemini
 * wrongly_dismissed H1) — splitting just made it possible one level down.
 *
 * @param {Map<string, number>} required - parts needed per file
 * @param {Map<string, number>} succeeded - parts that came back per file
 * @returns {string[]} files safe to mark covered
 */
export function computeCovered(required, succeeded) {
  const covered = [];
  for (const [file, need] of required) {
    const got = succeeded.get(file) ?? 0;
    if (got >= need) covered.push(file);
    else if (got > 0) {
      process.stderr.write(
        `  [requirements] WARN: ${file} extracted ${got}/${need} part(s) — NOT marked covered, `
        + 'so its existing requirements are preserved rather than replaced by a partial set\n',
      );
    }
  }
  return covered;
}

/** Split files into batches whose combined token estimate fits the budget. */
function batchFiles(fileBodies) {
  const batches = [];
  let cur = [];
  let curTok = 0;
  for (const fb of fileBodies) {
    const t = estimateTokens(fb.body);
    if (cur.length && curTok + t > CHUNK_TOKEN_BUDGET) { batches.push(cur); cur = []; curTok = 0; }
    cur.push(fb);
    curTok += t;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/**
 * Run one extraction pass over all batches.
 * @returns {Promise<{items: object[], covered: Set<string>}>} `covered` lists
 *   only files whose batch SUCCEEDED — a file from a failed batch must NOT be
 *   reported as covered, or `reconcile` would scoped-replace its prior
 *   requirements with an empty set (silent data loss — Gemini wrongly_dismissed H1).
 */
async function extractOneRun(batches, model, timeoutMs) {
  const items = [];
  const covered = new Set();
  let batchesFailed = 0;
  // A split file is covered only when EVERY part succeeded. Counting parts
  // required vs parts succeeded, rather than adding to `covered` per batch, is
  // the whole safety of splitting: `reconcile` scoped-REPLACES a covered file's
  // requirements, so marking a file covered on a partial extraction would
  // delete the invariants its failed parts carry — the same silent-loss shape
  // the per-batch coverage rule already exists to prevent, one level down.
  const partsRequired = new Map();
  const partsSucceeded = new Map();
  for (const batch of batches) {
    for (const fb of batch) partsRequired.set(fb.file, Math.max(partsRequired.get(fb.file) ?? 0, fb.parts ?? 1));
  }
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const tag = `batch ${bi + 1}/${batches.length}`;
    try {
      const code = batch.map((fb) => {
        // Name the part in the header so the model knows it is reading a
        // fragment and does not assert invariants about "the whole file".
        const header = (fb.parts ?? 1) > 1 ? `${fb.file} (part ${fb.part}/${fb.parts})` : fb.file;
        return `\n### ${header}\n\`\`\`\n${fb.body}\n\`\`\``;
      }).join('\n');
      const r = await callOpenAI({ topic: `${EXTRACTION_PROMPT}\n\nFILES:${code}`, model, maxTokens: EXTRACT_MAX_OUTPUT_TOKENS, timeoutMs });
      if (r.state !== 'success') throw new Error(`LLM call ${r.state}: ${r.errorMessage || ''}`);
      let parsed;
      try {
        parsed = parseLlmJson(r.text);
      } catch (err) {
        throw new Error(`non-JSON response: ${err.message}`);
      }
      // Top-level shape guard — a response with no `requirements` array is a
      // FAILED batch, not a successful-but-empty one (audit H3/H5): the
      // throw routes to the catch, increments `batchesFailed`, and an
      // all-malformed run therefore fails outright instead of silently
      // producing an empty candidates file.
      if (!Array.isArray(parsed?.requirements)) {
        throw new Error("response missing a top-level 'requirements' array");
      }
      // Per-item validation at the LLM boundary (audit M4/M12): a single
      // malformed item (bad `kind`, missing `assertion`) is dropped with a
      // warning rather than allowed to poison the whole merge/candidates file.
      let dropped = 0;
      for (const it of parsed.requirements) {
        const v = RawExtractionItemSchema.safeParse(it);
        if (v.success) items.push(v.data);
        else dropped++;
      }
      if (dropped > 0) {
        process.stderr.write(`  [requirements] WARN: dropped ${dropped} malformed extraction item(s) from ${tag}\n`);
      }
      // The batch succeeded — record each part. Coverage is decided below,
      // once every batch has run, so a file split across batches is only
      // covered when all of its parts got through.
      for (const fb of batch) partsSucceeded.set(fb.file, (partsSucceeded.get(fb.file) ?? 0) + 1);
    } catch (err) {
      // A batch failure must NOT discard items already collected from earlier
      // batches in this run (audit M4) — count it and carry on. The run only
      // fails outright if EVERY batch failed. The failed batch's files are
      // deliberately NOT added to `covered`.
      batchesFailed++;
      process.stderr.write(`  [requirements] WARN: extraction ${tag} failed — ${err.message}\n`);
    }
  }
  if (batchesFailed > 0 && batchesFailed === batches.length) {
    throw new Error(`all ${batches.length} extraction batch(es) failed`);
  }
  for (const f of computeCovered(partsRequired, partsSucceeded)) covered.add(f);
  return { items, covered };
}

/**
 * Extract de-facto requirements from `files`.
 *
 * @param {object} args
 * @param {string[]} args.files - repo-relative paths
 * @param {string} [args.baseDir]
 * @param {number} [args.runs=2]
 * @param {number} [args.timeoutMs=120000]
 * @returns {Promise<{candidates: object[], coveredFiles: string[], runsSucceeded: number, runsRequested: number}>}
 */
export async function extractRequirements({ files, baseDir = process.cwd(), runs = 2, timeoutMs = 120_000 }) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('extractRequirements: files required');

  // Sensitive-egress guard — refuse user-specified sensitive paths before
  // ANY content is read or sent to the LLM (audit R2-H4). `--files` is
  // user-supplied, so every path is ALSO repo-root-contained (audit H2/H4):
  // a `../escape` or symlink-out target must never be read or sent.
  const repoRoot = (() => {
    try { return fs.realpathSync(path.resolve(baseDir)); }
    catch { return path.resolve(baseDir); }
  })();
  const escapesRoot = (p) => p !== repoRoot && !p.startsWith(repoRoot + path.sep);
  let fileBodies = [];
  for (const f of files) {
    const rel = String(f).replace(/\\/g, '/');
    // Lexical containment FIRST — reject `../` escapes before any FS access.
    const abs = path.resolve(repoRoot, rel);
    if (escapesRoot(abs)) {
      throw new Error(`refusing a path that escapes the repo root: ${rel}`);
    }
    if (isPathSensitive(rel)) {
      throw new Error(`refusing to extract from a sensitive path: ${rel}`);
    }
    if (!fs.existsSync(abs)) throw new Error(`file not found: ${rel}`);
    // Symlink guard — resolve the REAL target and re-check BOTH escape and
    // sensitivity on it (audit H2/H4): a benign-named in-repo symlink can
    // still point at a sensitive file (e.g. `innocent.mjs` → `.env`), which
    // the lexical-name `isPathSensitive(rel)` check above cannot catch.
    let realAbs = abs;
    try { realAbs = fs.realpathSync(abs); } catch { /* keep lexical abs */ }
    if (escapesRoot(realAbs)) {
      throw new Error(`refusing a path whose symlink target escapes the repo root: ${rel}`);
    }
    const realRel = path.relative(repoRoot, realAbs).replace(/\\/g, '/');
    if (isPathSensitive(realRel)) {
      throw new Error(`refusing a path whose resolved target is sensitive: ${rel} → ${realRel}`);
    }
    // Defence-in-depth: redact any secret-shaped content from the body.
    fileBodies.push({ file: rel, body: redactSecrets(fs.readFileSync(abs, 'utf-8')) });
  }

  // A single file larger than the chunk budget used to fail the whole run with
  // "split or exclude them" (audit M10). Refusing beat truncating, but it made
  // FILE SIZE the thing that decides whether a module's invariants can exist in
  // the ledger — and the biggest modules are the invariant-dense ones. So split
  // it here instead: the budget still binds (it protects the output ceiling),
  // the unit is just no longer a whole file.
  const expanded = [];
  for (const fb of fileBodies) {
    if (estimateTokens(fb.body) <= CHUNK_TOKEN_BUDGET) { expanded.push({ ...fb, part: 1, parts: 1 }); continue; }
    const parts = splitOversizedFile(fb);
    // A single top-level declaration bigger than the budget cannot be split
    // further without cutting mid-construct, which would hand the extractor a
    // fragment with no invariants in it. That still fails fast, loudly.
    const stillOver = parts.filter((p) => estimateTokens(p.body) > CHUNK_TOKEN_BUDGET);
    if (stillOver.length) {
      throw new Error(
        `${fb.file}: a single top-level declaration exceeds the ${CHUNK_TOKEN_BUDGET}-token `
        + 'extraction budget and cannot be split at a declaration boundary — split the FUNCTION, or exclude the file',
      );
    }
    process.stderr.write(`  [requirements] ${fb.file} split into ${parts.length} part(s) to fit the extraction budget\n`);
    expanded.push(...parts);
  }
  fileBodies = expanded;

  await refreshModelCatalog().catch(() => {});
  const model = resolveModel('latest-gpt');
  const batches = batchFiles(fileBodies);

  const settled = await Promise.allSettled(
    Array.from({ length: runs }, () => extractOneRun(batches, model, timeoutMs)),
  );
  const ok = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  const failed = settled.length - ok.length;
  if (ok.length === 0) {
    throw new Error(`all ${runs} extraction run(s) failed — no candidates produced`);
  }
  if (failed > 0) {
    process.stderr.write(`  [requirements] WARN: ${failed}/${runs} extraction run(s) failed — degraded result\n`);
  }

  // `coveredFiles` is the union of files whose batch SUCCEEDED in at least
  // one run — a file every run failed to extract is NOT reported as covered,
  // so `reconcile` leaves its prior requirements untouched instead of
  // scoped-replacing them with nothing (Gemini wrongly_dismissed H1).
  const coveredFiles = [...new Set(ok.flatMap((o) => [...o.covered]))].sort();

  // `seenInRuns` is counted over the runs that ACTUALLY succeeded.
  const candidates = mergeRequirements(ok.map((o) => o.items), ok.length);
  // Degraded extraction (fewer runs succeeded than requested) — no item can
  // honestly be `high` confidence on a shrunken comparison set (audit L3).
  if (ok.length < runs) {
    for (const c of candidates) {
      if (c.confidence === 'high') c.confidence = 'medium';
    }
  }
  return { candidates, coveredFiles, runsSucceeded: ok.length, runsRequested: runs };
}
