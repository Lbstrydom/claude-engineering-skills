/**
 * @fileoverview Semantics-bearing digest for the tiered-shadow measurement
 * contract — the general guard against the omission class that produced all
 * five prior false "window met" incidents: a fix changes what a comparison
 * row MEANS, and `TIERED_SHADOW_CONTRACT_EPOCH` (tiered-shadow-summary.mjs)
 * doesn't get bumped because nothing forces the human to notice.
 *
 * That constant's OWN guard (tests/tiered-shadow-summary.test.mjs — "the
 * collector stamps the same constant the verifier checks") covers ONE failure
 * mode: the collector silently stopping stamping. It does NOT cover the other,
 * which is the omission class behind all five prior incidents: a semantic
 * change to the compare/summarize logic landing WITHOUT an epoch bump — each
 * patch changed what a row means and nobody reset the counter. This module
 * closes that gap with a PINNED DIGEST of the exact functions/predicates that
 * decide row eligibility and correlation — the established pattern in this
 * repo (`skills.manifest.json`'s `bundleVersion`, nav-audit's contract
 * digest): a committed artifact's freshness is verified against a
 * deterministic function of its real inputs, never eyeballed.
 *
 * **Why AST-based, not regex-based.** `tiered-shadow-compare.mjs`'s
 * `findingLine` contains a regex literal (`/:(\d+)\b/`); a naive text-based
 * comment stripper cannot reliably tell a `/` starting a regex from one
 * starting a comment, and getting that wrong either lets a real semantic
 * change through undetected or makes the guard cry wolf on an unrelated
 * string. This module reuses `scripts/lib/ast.mjs`'s existing Babel-based
 * `parseSource`/`walk` — already the established tool for exactly this class
 * of source analysis elsewhere in this repo (the adjacency detector, nav's
 * extractor) — so region and comment boundaries come from the real parser's
 * token stream, not a lexer this module would have to get right itself.
 *
 * **What's hashed** (`SEMANTICS_REGIONS` below is the single source of truth
 * for the list — read it, don't re-derive it here): the correlation logic AND
 * its direct helpers in `tiered-shadow-compare.mjs` (a change to `findingFile`'s
 * resolution logic changes correlation results without touching
 * `findingsCorrelate`'s own text, which would otherwise be an invisible gap),
 * plus the fields `compareAuditRunResults` persists onto the comparison row;
 * `summarize()`'s eligibility predicates in `tiered-shadow-summary.mjs`; and (added
 * 2026-07-26, the same day this digest caught its first real change; widened
 * 2026-07-27 by docs/plans/refactor-evidence-integrity.md, which rewrote
 * `findQuoteLineInHunk` into `findQuoteLineRangesInHunk` + the new shared
 * `selectAnchoredMatch` selector) the pure, location-verification functions in
 * `evidence-triage.mjs` that decide whether/what `_primaryLine` gets attached
 * to a tiered finding — upstream of the other two files, but just as
 * meaning-changing: it changed what `overlapCount`/`*UnlocalizedCount` mean
 * for real data without touching either of them.
 *
 * **What's deliberately excluded**: comments (JSDoc + inline) and whitespace,
 * so a documentation edit or reformat never fires this guard — coarse enough
 * not to fire on comments/formatting, because a guard that cries wolf gets
 * bypassed with `--no-verify` (AGENTS.md's own pre-push doctrine). CRLF is
 * canonicalised to LF before parsing for the same reason `skills.manifest.json`'s
 * `bundleVersion` does: a working-tree file can carry CRLF even though
 * `.gitattributes` pins `eol=lf` (git reports it clean on comparison), so
 * hashing raw bytes would make the digest a function of local line endings,
 * not committed source — the exact incident that made a fresh clone read a
 * STALE `bundleVersion` (`scripts/build-manifest.mjs`'s own doc comment).
 *
 * @module scripts/lib/audit/tiered-shadow-contract-digest
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseSource, walk } from '../ast.mjs';
import { canonicaliseForHash } from '../canonical-hash.mjs';

export const COMPARE_FILE = 'scripts/lib/audit/tiered-shadow-compare.mjs';
export const SUMMARY_FILE = 'scripts/lib/audit/tiered-shadow-summary.mjs';
// Added 2026-07-26 (the same day) — a real gap this digest's OWN first catch
// exposed: giving tiered findings a Stage-0-VERIFIED `_primaryLine` changed
// what a comparison row means (overlapCount/*UnlocalizedCount now read
// differently for real data) WITHOUT touching either file above — findingLine
// already preferred `_primaryLine`; nothing upstream had ever set it. Pinning
// just the two PURE, location-specific functions (not the much larger
// orchestrator around them) keeps this coarse — an unrelated Gate-B
// blame/impact edit in the same file must not force an epoch bump.
export const EVIDENCE_TRIAGE_FILE = 'scripts/lib/audit/evidence-triage.mjs';

/**
 * Named regions per file, in hash order. Order is part of the digest's
 * stability contract — reordering this list moves the pinned value exactly
 * as much as a real semantic change would, so don't reorder casually.
 *
 * `findingsCorrelate`'s helpers are listed explicitly (not just the function
 * that calls them) for the reason in the module doc above: they are called BY
 * NAME, so editing one changes real correlation behaviour while leaving
 * `findingsCorrelate`'s own source text byte-identical.
 */
/**
 * ⚠ Whitespace inside STRING, TEMPLATE and REGEX literals is collapsed along with
 * formatting whitespace (see `extractNamedRegions`). That coarseness is deliberate —
 * a digest that fires on reformatting gets `--no-verify`'d — and it is safe for the
 * regions below because every one is a PREDICATE or comparison function whose
 * semantics do not live in literal spacing.
 *
 * **Before adding a region, check that property still holds.** A region whose
 * behaviour depends on whitespace inside a literal (a formatter, a template that
 * emits significant newlines, a regex matching literal runs of spaces) can be
 * changed WITHOUT moving this digest — the guard would go quiet exactly where it
 * is needed. Such a region needs literal-preserving canonicalisation first.
 */
export const SEMANTICS_REGIONS = Object.freeze({
  [COMPARE_FILE]: Object.freeze([
    'OVERLAP_LINE_WINDOW', 'findingFile', 'findingLine',
    'normSeverityForOverlap', 'findingsCorrelate', 'compareAuditRunResults',
  ]),
  [SUMMARY_FILE]: Object.freeze([
    'hasComparablePopulation', 'isContractFailure', 'isCurrentEpoch', 'compared',
  ]),
  [EVIDENCE_TRIAGE_FILE]: Object.freeze([
    'findQuoteLineRangesInHunk', 'selectAnchoredMatch', 'resolveAnchorLocation',
  ]),
});

/**
 * Find every declaration named in `names` anywhere in `source` (top-level or
 * nested — `hasComparablePopulation`/`isContractFailure`/`isCurrentEpoch`/
 * `compared` are all local `const`s inside `summarize()`'s body, not
 * module-level) and return each one's exact source slice, comments blanked
 * and whitespace collapsed.
 *
 * Matches a `FunctionDeclaration`'s own range by `id.name` (so
 * `compareAuditRunResults`, `findingFile`, etc. are function DECLARATIONS and
 * are matched directly), and a `VariableDeclarator`'s `init` range by
 * `id.name` (so a `const foo = ...` — whether the value is an arrow function
 * like `isCurrentEpoch` or a plain expression like the `compared` filter
 * chain — is matched uniformly). Using `.init`'s range rather than the whole
 * declarator means a rename of the binding itself doesn't move the digest;
 * only the VALUE'S semantics does.
 *
 * @param {string} source - already CRLF-canonicalised
 * @param {string[]} names
 * @returns {Map<string,string>} name -> canonicalised source
 */
function extractNamedRegions(source, names) {
  const wanted = new Set(names);
  const { ast, error, recoveredErrors } = parseSource(source);
  if (!ast) throw new Error(`tiered-shadow-contract-digest: failed to parse source: ${error}`);
  if (recoveredErrors.length > 0) {
    // A partial/recovered AST would silently hash a truncated region — the
    // exact "sound structural coverage" trap ast.mjs's own doc comment warns
    // about. Fail loudly rather than pin a digest of broken input.
    throw new Error(`tiered-shadow-contract-digest: source has recovered parse errors, refusing to hash a partial tree: ${recoveredErrors.join('; ')}`);
  }
  const found = new Map();
  walk(ast, (node) => {
    if (node.type === 'FunctionDeclaration' && node.id?.name && wanted.has(node.id.name)) {
      found.set(node.id.name, { start: node.start, end: node.end });
    } else if (
      node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' &&
      wanted.has(node.id.name) && node.init
    ) {
      found.set(node.id.name, { start: node.init.start, end: node.init.end });
    }
  });
  const missing = names.filter((n) => !found.has(n));
  if (missing.length > 0) {
    throw new Error(
      `tiered-shadow-contract-digest: could not locate ${missing.join(', ')} in the source — `
      + 'the digest can no longer see what it is meant to pin. If this is a deliberate rename, '
      + 'update SEMANTICS_REGIONS in this module to match, and bump TIERED_SHADOW_CONTRACT_EPOCH.'
    );
  }
  // Blank every comment inside each region, working end-to-start so earlier
  // offsets in the same slice stay valid. Comments come from the REAL
  // PARSER's token stream (ast.comments), never a regex — see the module doc
  // for why (a regex literal in this exact source makes naive stripping
  // unsafe).
  const comments = [...(ast.comments || [])].sort((a, b) => b.start - a.start);
  const out = new Map();
  for (const name of names) {
    const { start, end } = found.get(name);
    let slice = source.slice(start, end);
    for (const c of comments) {
      if (c.start >= start && c.end <= end) {
        const relStart = c.start - start;
        const relEnd = c.end - start;
        slice = slice.slice(0, relStart) + ' ' + slice.slice(relEnd);
      }
    }
    // Collapse ALL whitespace runs (including the original line breaks) to a
    // single space: this is what makes the digest insensitive to reformatting
    // and to the comment-blanking above leaving behind blank lines.
    // A duplicate name (e.g. a nested function shadowing a targeted top-level
    // one) would otherwise make the digest depend on TRAVERSAL ORDER: the last
    // match silently wins and the pinned region is whichever the walker reached
    // second. For a guard whose whole job is detecting semantic change, quietly
    // digesting the wrong region is the worst available outcome — fail loudly.
    if (out.has(name)) {
      throw new Error(
        `tiered-shadow-contract-digest: "${name}" matched more than once — the digested `
        + 'region would depend on traversal order. Rename the inner declaration, or narrow '
        + 'SEMANTICS_REGIONS to an unambiguous target.',
      );
    }
    out.set(name, slice.replace(/\s+/g, ' ').trim());
  }
  return out;
}

/**
 * Compute the live semantics digest from disk. Deterministic: same committed
 * source in, same digest out, regardless of local formatting/line-ending state
 * (CRLF-canonicalised) or comment edits.
 * @param {{repoRoot?: string}} [opts]
 * @returns {string} 16-hex-char SHA-256 prefix — the same short-hash
 *   convention `skills.manifest.json`'s `bundleVersion` uses.
 */
export function computeContractSemanticsDigest({ repoRoot = process.cwd() } = {}) {
  const parts = [];
  for (const [relPath, names] of Object.entries(SEMANTICS_REGIONS)) {
    const abs = path.resolve(repoRoot, relPath);
    const raw = canonicaliseForHash(fs.readFileSync(abs)).toString('utf-8');
    const regions = extractNamedRegions(raw, names);
    for (const name of names) parts.push(`${relPath}::${name}={${regions.get(name)}}`);
  }
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Same computation, but over IN-MEMORY source strings rather than disk reads
 * — the seam mutation tests use to prove the digest is sensitive to a
 * semantic change and insensitive to a comment/whitespace-only change,
 * without touching the real files on disk.
 * @param {Record<string,string>} sourcesByPath - relPath -> full file content
 *   (raw; CRLF-canonicalisation is applied here, matching computeContractSemanticsDigest)
 * @param {typeof SEMANTICS_REGIONS} [regions]
 * @returns {string}
 */
export function computeDigestFromSources(sourcesByPath, regions = SEMANTICS_REGIONS) {
  const parts = [];
  for (const [relPath, names] of Object.entries(regions)) {
    const raw = canonicaliseForHash(Buffer.from(sourcesByPath[relPath] ?? '', 'utf-8')).toString('utf-8');
    const extracted = extractNamedRegions(raw, names);
    for (const name of names) parts.push(`${relPath}::${name}={${extracted.get(name)}}`);
  }
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

// Self-check / regeneration: `node scripts/lib/audit/tiered-shadow-contract-digest.mjs`
// prints the live digest so a developer bumping the epoch can paste the new
// pinned value in the same commit.
const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
  } catch { return false; }
})();
if (isMain) {
  console.log(computeContractSemanticsDigest());
}
