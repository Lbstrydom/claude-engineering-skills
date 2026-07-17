/**
 * @fileoverview Stage 0 — deterministic evidence triage for the tiered-recall
 * audit pipeline. Plan: docs/plans/tiered-recall-audit-pipeline.md Phase 3;
 * restructured into a fact/relevance split by
 * docs/plans/stage0-evidence-relevance-split.md — the discovery generator
 * (`tiered-pipeline.mjs`) is prompted with FULL current file content, not
 * diff-scoped content, so a real finding about pre-existing (unchanged) code
 * legitimately lives outside any diff hunk. The original single-gate design
 * (`verifyAnchor`, hunk-only) treated "outside a hunk" as "fabricated" —
 * this file now splits that into two sequential gates:
 *
 *   Gate A (`resolveAnchorLocation`) — is this quote REAL? Tries the hunk
 *   first (delegates to the unchanged `quoteAppearsOnSide`/`verifyAnchor`),
 *   then falls back to a line-indexed search of the current working-tree
 *   file content (`headContent`, supplied by the caller's
 *   `headContentAdapter` — this file stays I/O-free).
 *
 *   Gate B (`tagPreExisting`, reused unmodified) — for a quote found outside
 *   a hunk, does the shipped change depend on it? Diff-derived line mapping
 *   (`mapHeadLineToBase`) locates the quote's corresponding BASE-revision
 *   position (never by raw line-number equality across revisions — an
 *   earlier hunk shifts every later line number); `blameAdapter`/
 *   `impactAdapter` (both caller-injected) answer pre-existence + impact-
 *   independence against that exact, occurrence-specific location.
 *
 * `resolveAnchorLocation`, `mapHeadLineToBase`, and `tagPreExisting` are
 * PURE — no I/O, no VCS access — so they're directly unit-testable
 * (Tier 1). `runStage0EvidenceTriage` is the orchestration entry point that
 * supplies real diff text / file content / git-derived adapters, per the
 * plan's design.
 *
 * @module scripts/lib/audit/evidence-triage
 */

import { EvidenceAnchorSchema } from '../schemas.mjs';
import { promoteAlternative } from './candidate-envelope.mjs';
import { nowIso } from './time-utils.mjs';
import { normalizeWhitespace } from '../text-normalize.mjs';

/**
 * Extract the per-file section of a unified diff (from its `diff --git`
 * header to the next one, or end of string). Returns `null` if the file
 * isn't mentioned in the diff at all.
 *
 * PRE-EXISTING function (predates the Stage 0 relevance-split restructure —
 * `verifyAnchor` has always used it); `resolveAnchorLocation` (Gate A) now
 * also calls it, which is a genuine load-bearing dependency, not just
 * pre-existing debt to ignore. Round-1 code-audit M3/L2: the header regex
 * below handles unquoted paths and a narrow quoted-space case, not Git's
 * full C-style quoted-path grammar (octal escapes, embedded quotes/
 * backslashes) — an exotic filename can fail to match here. Documented
 * as accepted debt rather than fixed now because the failure direction is
 * SAFE: a header match miss returns `null` → the caller treats the anchor
 * as `unverifiable` (never a false match/wrong classification), and a full
 * grammar-compliant parser is a substantial, orthogonal scope expansion
 * this plan (evidence RELEVANCE, not diff-parsing robustness) does not
 * need to absorb. Revisit if a real discovery run surfaces a rejected
 * candidate citing a quote-grammar-affected filename.
 *
 * @param {string} diffText
 * @param {string} filePath - either the old or new path
 * @returns {{section: string, fileStatus: 'modified'|'added'|'deleted'|'renamed'|'copied'} | null}
 */
function extractFileDiffSection(diffText, filePath) {
  if (!diffText || !filePath) return null;
  // Thin filter over the shared parser (evidence-anchor-path-contract §7i).
  // Contract, return shape, and failure direction are BYTE-IDENTICAL to the
  // pre-refactor implementation — this file's existing tests are the pin.
  for (const s of parseAllDiffSections(diffText)) {
    if (s.oldPath !== filePath && s.newPath !== filePath) continue;
    return { section: s.section, fileStatus: s.fileStatus, oldPath: s.oldPath, newPath: s.newPath };
  }
  return null;
}

/**
 * Parse EVERY file section out of a unified diff. The shared core extracted
 * from `extractFileDiffSection` (evidence-anchor-path-contract §7i, Gemini
 * gate G2): that function takes a KNOWN `filePath` and returns only that
 * file's section, so `buildDiffPathMap` — which must DISCOVER all files —
 * could not reuse it without already knowing the answer. Rather than
 * re-implement the parser (and silently lose the fixes below), the loop is
 * lifted here and both callers filter over it.
 *
 * The two header fixes are REGRESSION-LOCKED behaviour, not incidental:
 *
 * - Consolidated Gemini gate fix G1: `.` never matches a line terminator in
 *   JS regex (not just `\n` — `\r` is excluded too), so the original
 *   `a\/(.+?) b\/(.+?)\n` could never match a CRLF diff header at all — a
 *   Windows-generated diff (or one round-tripped through a CRLF-preserving
 *   tool) would silently fail EVERY file lookup, degrading Stage 0 to
 *   unverifiable-escalate-everything with no signal anything was wrong.
 * - Consolidated Gemini gate fix G3, round 3: git quotes each path in the
 *   header (`diff --git "a/path with spaces.js" "b/path with spaces.js"`)
 *   whenever it contains a space or other char core.quotepath treats as
 *   special — the unquoted-only regex returned null for every such file.
 *   Unlike G1 (which corrupted a valid match into a false 'fabricated'),
 *   this failure mode was already SAFE (unverifiable → escalate, never a
 *   silent wrong answer) — fixed anyway for correctness, not urgency.
 *
 * ACCEPTED DEBT, INHERITED not re-litigated (§7i): the header regex handles
 * unquoted paths and a narrow quoted-space case, NOT Git's full C-style
 * quoted-path grammar (octal escapes, embedded quotes/backslashes). An exotic
 * filename yields no section here — and the failure direction stays SAFE by
 * construction: no section → `extractFileDiffSection` returns null → the
 * anchor resolves `unverifiable` (never a false match), and `buildDiffPathMap`
 * simply mints no id for it, so no anchor can cite it.
 *
 * @param {string} diffText
 * @returns {Array<{section: string, fileStatus: 'modified'|'added'|'deleted'|'renamed'|'copied',
 *   oldPath: string, newPath: string}>} in diff-header order; `[]` when nothing parses.
 */
export function parseAllDiffSections(diffText) {
  if (!diffText) return [];
  const out = [];
  for (const part of String(diffText).split(/(?=^diff --git )/m)) {
    const header = part.match(/^diff --git "?a\/(.+?)"? "?b\/(.+?)"?\r?\n/);
    if (!header) continue;
    const [, oldPath, newPath] = header;
    let fileStatus = 'modified';
    if (/^new file mode/m.test(part)) fileStatus = 'added';
    else if (/^deleted file mode/m.test(part)) fileStatus = 'deleted';
    else if (/^rename from /m.test(part)) fileStatus = 'renamed';
    else if (/^copy from /m.test(part)) fileStatus = 'copied';
    out.push({ section: part, fileStatus, oldPath, newPath });
  }
  return out;
}

/**
 * Parse a `@@ -a,b +c,d @@` hunk header into line-number/count fields.
 * The count is 1 when the `,count` group is omitted (unified-diff
 * convention) — distinct from an EXPLICIT `,0` (a pure add/delete hunk on
 * that side), so the two are never conflated.
 *
 * @param {string} line
 * @returns {{baseStart:number, baseCount:number, headStart:number, headCount:number} | null}
 */
function parseHunkHeader(line) {
  const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!m) return null;
  return {
    baseStart: Number(m[1]),
    baseCount: m[2] !== undefined ? Number(m[2]) : 1,
    headStart: Number(m[3]),
    headCount: m[4] !== undefined ? Number(m[4]) : 1,
  };
}

/**
 * Split a file's diff section into individual hunks. Each hunk carries its
 * parsed `header` (line-number/count fields, `null` if the `@@` line failed
 * to parse) alongside its `lines` (the body content, unchanged shape from
 * before this module's Stage 0 restructure — every existing consumer of
 * "a hunk's lines" keeps working).
 *
 * @returns {Array<{header: object|null, lines: string[]}>}
 */
function splitIntoHunks(section) {
  const hunks = [];
  let current = null;
  for (const rawLine of section.split('\n')) {
    if (rawLine.startsWith('@@')) {
      if (current) hunks.push(current);
      current = { header: parseHunkHeader(rawLine), lines: [] };
      continue;
    }
    if (current === null) continue; // before the first hunk (file header lines)
    current.lines.push(rawLine);
  }
  if (current) hunks.push(current);
  return hunks;
}

/**
 * Does `quote` appear as CONTIGUOUS content, within a SINGLE hunk, on the
 * given `side`? `head` side = added (`+`) or unchanged context lines; `base`
 * side = removed (`-`) or unchanged context lines.
 *
 * Cluster B audit fix H4 (round 2 — a real bug in the round-1 fix): joining
 * matching-side lines across the ENTIRE FILE (spanning unrelated, non-
 * adjacent hunks) let a quote whose words merely appear in order ACROSS TWO
 * SEPARATE HUNKS pass as "verified" — a fabricated or stale multi-hunk quote
 * could defeat a load-bearing evidence gate. Matching is now scoped to one
 * hunk's contiguous same-side lines at a time; a quote must be genuinely
 * contiguous within a single hunk, never stitched across a hunk boundary.
 */
function quoteAppearsOnSide(section, quote, side) {
  const normQuote = normalizeWhitespace(quote);
  if (!normQuote) return false;
  const wantedPrefixes = side === 'head' ? ['+', ' '] : ['-', ' '];
  for (const hunk of splitIntoHunks(section)) {
    const contentLines = [];
    for (const rawLine of hunk.lines) {
      const prefix = rawLine[0];
      if (!wantedPrefixes.includes(prefix)) continue;
      contentLines.push(normalizeWhitespace(rawLine.slice(1)));
    }
    // Consolidated Gemini gate fix G1, round 3: each line is normalized
    // individually, but an EMPTY context line (blank line in the diff)
    // normalizes to `''` — `contentLines.join(' ')` then inserts a
    // separator on both sides of that empty entry, producing a DOUBLE
    // space at the join point (e.g. ['foo()','','bar()'].join(' ') ===
    // 'foo()  bar()'). Since `normQuote` has collapsed to single spaces,
    // `.includes(normQuote)` would then miss a perfectly valid quote that
    // spans a blank context line, silently marking it 'fabricated'.
    // Re-normalizing the JOINED string collapses that double space too.
    if (normalizeWhitespace(contentLines.join(' ')).includes(normQuote)) return true;
  }
  return false;
}

/**
 * Line-indexed sliding-window search for `quote` within `content` — never
 * normalizes the WHOLE blob first (a whole-blob normalize-then-search makes
 * the matched character offset impossible to map back to a line number
 * without a separate token-to-line index; Gemini final-review round-1 G3).
 * The window size is the quote's OWN raw line count, so a verbatim
 * multi-line quote is matched at its exact original span — a quote that was
 * reformatted to a different line count since being cited will miss (a
 * known, documented trade-off: `contentExistsAtMappedRange`'s own docblock
 * and the plan's Risk Register both cover this).
 *
 * @param {string} content
 * @param {string} quote
 * @returns {{startLine:number, endLine:number} | null} 1-indexed, inclusive
 */
function findLineRangeInContent(content, quote) {
  const normQuote = normalizeWhitespace(quote);
  if (!normQuote) return null;
  const lines = String(content || '').split('\n');
  const quoteLineCount = String(quote).split('\n').length;
  for (let start = 0; start + quoteLineCount <= lines.length; start++) {
    const windowLines = lines.slice(start, start + quoteLineCount).map(normalizeWhitespace);
    if (normalizeWhitespace(windowLines.join(' ')).includes(normQuote)) {
      return { startLine: start + 1, endLine: start + quoteLineCount };
    }
  }
  return null;
}

/**
 * Map a single HEAD-side line number to its corresponding BASE-side line
 * number, for a line that falls OUTSIDE every hunk in `hunks` (a line
 * WITHIN a hunk has no single stable base correspondence — that's the
 * `in_hunk` case, handled separately). Cumulative-offset diff-line mapping:
 * walks hunks in order, accumulating each hunk's net line-count delta
 * (`headCount - baseCount`) until it finds the gap `headLine` falls in.
 *
 * Never based on raw line-number equality across revisions (round-2
 * plan-audit H1 — an EARLIER hunk shifts every LATER line number in HEAD,
 * so comparing "line 40 in base" against "line 40 in HEAD" compares
 * unrelated content when any earlier edit changed the line count).
 *
 * @param {number} headLine - 1-indexed
 * @param {Array<{header: object|null, lines: string[]}>} hunks
 * @returns {number | null} the base line number, or `null` if `headLine`
 *   falls within a hunk, a hunk header failed to parse, or the computed
 *   result is out of bounds (< 1) — all ambiguous, never guessed.
 */
export function mapHeadLineToBase(headLine, hunks) {
  let delta = 0;
  for (const hunk of hunks) {
    const h = hunk.header;
    if (!h) return null; // an unparseable header anywhere makes every later offset unreliable
    if (headLine < h.headStart) {
      const baseLine = headLine - delta;
      return baseLine >= 1 ? baseLine : null;
    }
    const headEnd = h.headStart + h.headCount - 1;
    if (headLine <= headEnd) return null; // within this hunk — not this function's case
    delta += (h.headCount - h.baseCount);
  }
  const baseLine = headLine - delta;
  return baseLine >= 1 ? baseLine : null;
}

/**
 * Map a HEAD-side line RANGE to its corresponding BASE-side range. Requires
 * BOTH endpoints to map successfully AND the mapped range to preserve the
 * original range's length — a hunk boundary crossing partway through the
 * cited range makes the whole range ambiguous (some of it maps cleanly,
 * some doesn't), so that case returns `null` rather than a partial answer.
 *
 * @param {{startLine:number, endLine:number}} headRange
 * @param {Array<{header: object|null, lines: string[]}>} hunks
 * @returns {{startLine:number, endLine:number} | null}
 */
export function mapHeadRangeToBase(headRange, hunks) {
  const mappedStart = mapHeadLineToBase(headRange.startLine, hunks);
  const mappedEnd = mapHeadLineToBase(headRange.endLine, hunks);
  if (mappedStart === null || mappedEnd === null) return null;
  const expectedLength = headRange.endLine - headRange.startLine;
  if (mappedEnd - mappedStart !== expectedLength) return null;
  return { startLine: mappedStart, endLine: mappedEnd };
}

/**
 * resolveAnchorLocation — Gate A. Confirms an anchor's `quote` is real,
 * content-verified against the actual diff OR (on a hunk miss, head-side
 * anchors only) the current working-tree file content, AND that the
 * anchor's claimed `fileStatus`/paths match what the diff itself shows —
 * an anchor claiming `added` against a file the diff shows as merely
 * `modified` is fabricated metadata even if the quote text happens to
 * match (same cross-checks `verifyAnchor` already performs).
 *
 * Stays PURE — `headContent` is a plain parameter, supplied by the caller
 * (`runStage0EvidenceTriage`, via `adapters.headContentAdapter`); this
 * function never reads a file itself.
 *
 * **Three failure classes, never one word** (evidence-anchor-path-contract
 * plan §7a, 2026-07-17). This function previously returned `'fabricated'` —
 * "the model hallucinated this" — for FIVE distinct causes, two of which are
 * not about the model at all. That conflation is why a schema bug read as
 * mass hallucination for weeks: measured on a real Sonnet run, 4/4 candidates
 * were rejected `fabricated` and 4/4 were malformed by OUR schema, with 0/4
 * genuine fabrications. The classes are now distinct because they have
 * different owners and different fixes:
 *
 * | status | means | whose bug |
 * |---|---|---|
 * | `malformed` | the claim could not be PARSED — says nothing about the finding | **ours** (contract) |
 * | `contradicted` | well-formed, but the diff DISPROVES its metadata | the model's |
 * | `unsupported` | well-formed, but the quote is not in the diff or HEAD | the model's |
 *
 * `malformed` is deliberately NOT more permissive than the old behaviour — it
 * still never reaches Stage 1 (its quote was never content-verified, and
 * routing unverified evidence to a human is the failure INC-001 warns about).
 * The change is attribution and visibility, not permissiveness.
 *
 * @param {object} anchor - EvidenceAnchorSchema shape
 * @param {string} diffText - the full unified diff for this commit
 * @param {string|null} [headContent] - the file's current working-tree
 *   content, for the HEAD-fallback search on a hunk miss
 * @returns {{status: 'in_hunk'|'outside_hunk_in_head'|'unverifiable'|'unsupported'|'contradicted'|'malformed',
 *   reasonDetail?: string,
 *   headLineRange?: {startLine:number, endLine:number},
 *   hunks?: Array<{header: object|null, lines: string[]}>}}
 */
export function resolveAnchorLocation(anchor, diffText, headContent) {
  const parsed = EvidenceAnchorSchema.safeParse(anchor);
  if (!parsed.success) {
    // OUR contract rejected the claim before any evidence was examined. Carry
    // the first issue so a recurrence is diagnosable from telemetry alone
    // rather than needing a live repro (the 2026-07-17 root-cause hunt).
    const issue = parsed.error.issues[0];
    return { status: 'malformed', reasonDetail: `${issue.path.join('.') || '(root)'}: ${issue.message}` };
  }
  const filePath = anchor.side === 'base' ? anchor.oldFile : anchor.newFile;
  if (!filePath) return { status: 'malformed', reasonDetail: `no path for side='${anchor.side}'` };
  if (!diffText) return { status: 'unverifiable' };
  const section = extractFileDiffSection(diffText, filePath);
  if (!section) return { status: 'unverifiable' };
  // Metadata the diff can positively DISPROVE — a model claim, checked and refuted.
  if (section.fileStatus !== anchor.fileStatus) {
    return { status: 'contradicted', reasonDetail: `claimed fileStatus='${anchor.fileStatus}', diff shows '${section.fileStatus}'` };
  }
  if (anchor.oldFile && anchor.oldFile !== section.oldPath) {
    return { status: 'contradicted', reasonDetail: 'oldFile does not match the diff section' };
  }
  if (anchor.newFile && anchor.newFile !== section.newPath) {
    return { status: 'contradicted', reasonDetail: 'newFile does not match the diff section' };
  }

  if (quoteAppearsOnSide(section.section, anchor.quote, anchor.side)) {
    return { status: 'in_hunk' };
  }

  // HEAD-fallback only makes sense for head-side anchors — discovery only
  // ever reads current (head) file content, so a base-side quote missing
  // from the hunk has no head-content equivalent to search.
  if (anchor.side === 'head' && headContent) {
    const range = findLineRangeInContent(headContent, anchor.quote);
    if (range) {
      return { status: 'outside_hunk_in_head', headLineRange: range, hunks: splitIntoHunks(section.section) };
    }
  }

  return { status: 'unsupported', reasonDetail: 'quote not found in the diff section or HEAD content' };
}

/**
 * The terminal-failure statuses `resolveAnchorLocation` can return — i.e. this
 * anchor yielded no usable location. Exported as the single source of truth so
 * a future class cannot be added to the resolver while a consumer's hardcoded
 * status list silently keeps treating it as a success (the contract-drift
 * shape this whole plan exists to close).
 */
export const ANCHOR_FAILURE_STATUSES = Object.freeze(['malformed', 'contradicted', 'unsupported']);

/**
 * verifyAnchor — UNCHANGED (round-1/round-2 plan-audit M2 — a new
 * discriminator value does not preserve a closed 3-state contract for any
 * consumer that branches exhaustively on `verified | unverifiable |
 * fabricated`; `resolveAnchorLocation` above is the Stage-0-only detailed
 * resolver, used nowhere else). Every existing caller keeps working with
 * zero modification.
 *
 * @param {object} anchor - EvidenceAnchorSchema shape
 * @param {string} diffText - the full unified diff for this commit
 * @returns {'verified'|'unverifiable'|'fabricated'}
 */
export function verifyAnchor(anchor, diffText) {
  if (!EvidenceAnchorSchema.safeParse(anchor).success) return 'fabricated';
  const filePath = anchor.side === 'base' ? anchor.oldFile : anchor.newFile;
  if (!filePath) return 'fabricated'; // anchor claims a side with no path for it — schema should already catch this, belt-and-suspenders
  if (!diffText) return 'unverifiable';
  const section = extractFileDiffSection(diffText, filePath);
  if (!section) return 'unverifiable'; // file not found in diff at all — can't confirm OR refute
  if (section.fileStatus !== anchor.fileStatus) return 'fabricated'; // metadata mismatch — the diff disagrees with the anchor's own claim
  if (anchor.oldFile && anchor.oldFile !== section.oldPath) return 'fabricated'; // the OTHER path field, cross-checked against the same located section
  if (anchor.newFile && anchor.newFile !== section.newPath) return 'fabricated';
  return quoteAppearsOnSide(section.section, anchor.quote, anchor.side) ? 'verified' : 'fabricated';
}

/**
 * tagPreExisting — two-check requirement (round-1 finding #3): blame alone is
 * NEVER sufficient. Both line-ancestry (via `blameAdapter`) AND
 * impact-independence (via `impactAdapter`) must hold before a candidate may
 * be tagged `pre_existing_independent` — matching this repo's own documented
 * "scope by impact, not authorship" invariant. Either adapter returning
 * `null` (blame failed, or reachability unknown) yields `'unknown'` — NEVER
 * silently treated as pre-existing.
 *
 * @param {{file: string, startLine: number, endLine: number}} citation
 * @param {object} adapters
 * @param {(file: string, startLine: number, endLine: number) => boolean|null} adapters.blameAdapter
 *   Returns true if the cited lines predate the commit under audit, false if
 *   they were introduced by it, null if blame could not be determined
 *   (shallow clone, rename, merge commit).
 * @param {(file: string) => boolean|null} adapters.impactAdapter
 *   Returns true if no changed file in this diff depends on/references
 *   `file`, false if at least one does, null if reachability is unknown
 *   (analysis unavailable for this run).
 * @returns {'pre_existing_independent'|'unknown'}
 */
export function tagPreExisting({ file, startLine, endLine }, { blameAdapter, impactAdapter }) {
  const predatesCommit = typeof blameAdapter === 'function' ? blameAdapter(file, startLine, endLine) : null;
  if (predatesCommit !== true) return 'unknown';
  const isIndependent = typeof impactAdapter === 'function' ? impactAdapter(file) : null;
  if (isIndependent !== true) return 'unknown';
  return 'pre_existing_independent';
}

/**
 * Resolve a finding's `scopeBucket` from its origin candidate(s) against the
 * Stage 0 routing manifest (decision #8 — round-3 plan-audit H6/H4). A
 * finding merged from multiple origin candidates takes the LEAST-restrictive
 * bucket among them (`change_related` if ANY origin is change-related —
 * safe-toward-inclusion, mirroring decision #2's default). An origin id with
 * no manifest entry (e.g. a Stage-2 clean-region `missed_candidate` finding,
 * which has no Stage 0 origin at all) is simply skipped, never treated as an
 * error — `originCandidateIds: []` correctly falls through to the same safe
 * default as an unresolvable id.
 *
 * Pure — no I/O. Co-located here (not tiered-pipeline.mjs) because it reads
 * the same routing-manifest shape `runStage0EvidenceTriage` produces
 * (`Map<fingerprint, scopeBucket>`, built by the caller from `verified` +
 * `preExistingIndependent`'s own `.scopeBucket` fields).
 *
 * @param {string[]} originCandidateIds
 * @param {Map<string, 'change_related'|'pre_existing_impactful'|'pre_existing_independent'>} routingManifest
 * @returns {'change_related'|'pre_existing_impactful'|'pre_existing_independent'}
 */
const SCOPE_BUCKET_RESTRICTIVENESS = {
  change_related: 0,
  pre_existing_impactful: 1,
  pre_existing_independent: 2,
};

export function resolveScopeBucketForFinding(originCandidateIds, routingManifest) {
  let best = null;
  for (const id of originCandidateIds || []) {
    const bucket = routingManifest?.get?.(id);
    if (!bucket) continue;
    if (best === null || SCOPE_BUCKET_RESTRICTIVENESS[bucket] < SCOPE_BUCKET_RESTRICTIVENESS[best]) {
      best = bucket;
    }
  }
  return best ?? 'change_related';
}

/**
 * Resolve one anchor field (`'anchor'` for commission, `'triggerAnchor'` for
 * omission) via `resolveAnchorLocation`, with the envelope-aware fallback
 * (Gemini gate round-2 finding #G1, ported from the pre-restructure
 * `verifyWithFallback`): if the canonical claim's anchor is fabricated, try
 * every OTHER contributing source's anchor before giving up on the whole
 * envelope. Shared between commission and omission handling (Cluster B
 * audit fix H3 — omission's `triggerAnchor` is itself a commission-type
 * fact and must be resolved the same way, not skipped).
 *
 * On total failure the TERMINAL CLASS is preserved rather than flattened to a
 * single `'rejected'` (plan §7a): which class the last-tried anchor failed
 * with decides whether this candidate is attributed to the model or to our own
 * contract, and a flattened word would put the whole distinction back where it
 * was. The fallback is still driven by "did we get a usable location", so
 * every failure class is equally eligible to try alternatives — a malformed
 * canonical anchor with a well-formed alternative still recovers.
 *
 * @returns {{envelope: object, status: 'in_hunk'|'outside_hunk_in_head'|'unverifiable'|'malformed'|'contradicted'|'unsupported',
 *   reasonDetail?: string, headLineRange?: object, hunks?: Array}}
 */
function resolveWithFallback(envelope, anchorField, diffText, headContentAdapter) {
  const originalAnchor = envelope.canonicalFinding[anchorField];
  const originalFilePath = originalAnchor?.side === 'base' ? originalAnchor?.oldFile : originalAnchor?.newFile;
  const originalHeadContent = typeof headContentAdapter === 'function' && originalFilePath
    ? headContentAdapter(originalFilePath) : null;
  const result = resolveAnchorLocation(originalAnchor, diffText, originalHeadContent);
  if (!ANCHOR_FAILURE_STATUSES.includes(result.status)) return { envelope, ...result };

  for (let i = 0; i < envelope.evidenceAlternatives.length; i++) {
    const alt = envelope.evidenceAlternatives[i];
    if (alt[anchorField] === originalAnchor) continue; // that's the one that just failed
    if (!alt[anchorField]) continue;
    const altFilePath = alt[anchorField].side === 'base' ? alt[anchorField].oldFile : alt[anchorField].newFile;
    const altHeadContent = typeof headContentAdapter === 'function' && altFilePath
      ? headContentAdapter(altFilePath) : null;
    const altResult = resolveAnchorLocation(alt[anchorField], diffText, altHeadContent);
    if (!ANCHOR_FAILURE_STATUSES.includes(altResult.status)) {
      return { envelope: promoteAlternative(envelope, i), ...altResult };
    }
  }
  // Every source failed. Keep the CANONICAL anchor's class as the envelope's
  // verdict — it is the claim under adjudication; an alternative's class would
  // attribute the candidate on evidence the finding didn't actually assert.
  return { envelope, ...result };
}

/**
 * runStage0EvidenceTriage — the Stage 0 orchestration entry point.
 *
 * First branch is ALWAYS `evidenceType` (Gemini gate round-1 finding #G4):
 * `commission` claims verify `anchor`; `omission` claims verify
 * `triggerAnchor` (Cluster B audit fix H3 — the TRIGGER is itself a
 * commission-type fact and must be deterministically checked; only the
 * obligation's *absence* is semantic and deferred to Stage 1/2 judgment).
 * Both paths share the same envelope-aware fallback-then-reject logic.
 *
 * Per-candidate result model (docs/plans/stage0-evidence-relevance-split.md):
 *   `in_hunk` → `scopeBucket: 'change_related'`, Gate B skipped (already
 *     directly touched — no relevance question to ask).
 *   `outside_hunk_in_head` → Gate B runs; `scopeBucket` is one of
 *     `change_related` (unmappable range, or blame/impact `unknown` —
 *     decision #2's safe default) / `pre_existing_impactful` (predates the
 *     commit, and a changed file depends on it) / `pre_existing_independent`
 *     (predates the commit, confirmed independent — routed OUT of `verified`
 *     into `preExistingIndependent`, never reaching Stage 1 directly).
 *   `unverifiable` (file not in diff at all) → unchanged from before this
 *     restructure — still Stage-1-eligible, `scopeBucket: 'change_related'`
 *     (decision #8's safe default; no Gate B ever ran).
 *   `fabricated` → unchanged — local telemetry only, never Stage-1-eligible.
 *
 * `rejected` envelopes are returned separately and MUST be treated by the
 * caller as local diagnostic telemetry ONLY — never written to the
 * adjudication ledger (per the state machine in the tiered-recall plan's
 * §1.5). `preExistingIndependent` envelopes are the caller's responsibility
 * to route through debt capture (`tiered-pipeline.mjs`) — restoring a
 * candidate to `verified` on a debt-write failure is the CALLER's job, not
 * this pure function's.
 *
 * @param {Array<import('./candidate-envelope.mjs').AuditCandidateEnvelope>} envelopes
 * @param {object} ctx
 * @param {string} ctx.diffText
 * @param {object} adapters
 * @param {(file: string, startLine: number, endLine: number, quote: string) => boolean|null} [adapters.blameAdapter]
 *   Given the MAPPED BASE-revision line range and the anchor's own quote
 *   text (threaded through by this function — `tagPreExisting`'s own
 *   3-arg contract is unchanged; this 4th arg is this module's own
 *   addition when constructing the per-candidate closure it hands to
 *   `tagPreExisting`), returns whether that exact content predates the
 *   commit.
 * @param {(file: string) => boolean|null} [adapters.impactAdapter]
 * @param {(filePath: string) => string|null} [adapters.headContentAdapter]
 *   The file's current working-tree content, for Gate A's HEAD-fallback
 *   search — explicit injected dependency (Gemini final-review round-1
 *   G2), matching `blameAdapter`/`impactAdapter`'s existing injection
 *   pattern rather than implicit threading.
 * @param {() => string} [adapters.clock] - injectable for deterministic tests; defaults to the real clock in production
 * @returns {{verified: Array<object>, preExistingIndependent: Array<object>,
 *   rejected: Array<object>, malformed: Array<object>}}
 *
 * `malformed` is a FOURTH bucket, split out of `rejected` (plan §7a): a
 * candidate our own contract could not parse is not evidence about the model,
 * and blending it into `rejected` is what made a 100%-schema-rejection run
 * read as 100% model hallucination. Both remain local telemetry only and
 * neither reaches Stage 1 — the split is attribution, not routing (D4).
 */
export function runStage0EvidenceTriage(envelopes, ctx, adapters = {}) {
  const verified = [];
  const preExistingIndependent = [];
  const rejected = [];
  const malformed = [];

  for (const rawEnvelope of envelopes) {
    const evidenceType = rawEnvelope.canonicalFinding.evidenceType;
    const anchorField = evidenceType === 'omission' ? 'triggerAnchor' : 'anchor';
    const reasonPrefix = evidenceType === 'omission' ? 'omission_trigger' : 'commission_anchor';

    const { envelope, status, reasonDetail, headLineRange, hunks } = resolveWithFallback(
      rawEnvelope, anchorField, ctx.diffText, adapters.headContentAdapter,
    );

    if (ANCHOR_FAILURE_STATUSES.includes(status)) {
      // One reasonCode per class — never the old single
      // `_fabricated_all_alternatives_failed`, which could not distinguish
      // "we broke the contract" from "the model lied".
      const REASON_BY_STATUS = {
        malformed: 'malformed_anchor',
        contradicted: 'metadata_mismatch',
        unsupported: 'quote_not_found',
      };
      envelope.stageDecisions.push({
        stage: 'stage0a',
        outcome: status === 'malformed' ? 'malformed' : 'rejected',
        reasonCode: `${reasonPrefix}_${REASON_BY_STATUS[status]}`,
        reasonDetail: reasonDetail ?? null,
        evidenceRef: envelope.fingerprint,
        createdAt: nowIso(adapters.clock),
      });
      // LOCAL TELEMETRY ONLY — the caller must never write either to the ledger.
      (status === 'malformed' ? malformed : rejected).push(envelope);
      continue;
    }

    // Gate A decision — exactly one `stage0a` entry per candidate, always.
    const anchorVerified = status === 'in_hunk' || status === 'outside_hunk_in_head';
    envelope.stageDecisions.push({
      stage: 'stage0a',
      outcome: anchorVerified ? 'verified' : 'unverifiable',
      reasonCode: anchorVerified ? `${reasonPrefix}_content_verified` : `${reasonPrefix}_diff_section_unavailable`,
      evidenceRef: envelope.fingerprint,
      createdAt: nowIso(adapters.clock),
    });

    if (status !== 'outside_hunk_in_head') {
      // in_hunk (implicit change_related) and unverifiable (safe default) —
      // neither runs Gate B, per the result-model table above.
      envelope.scopeBucket = 'change_related';
      verified.push(envelope);
      continue;
    }

    // Gate B — only for outside_hunk_in_head candidates.
    const anchorObj = envelope.canonicalFinding[anchorField];
    const filePath = anchorObj.side === 'base' ? anchorObj.oldFile : anchorObj.newFile;
    const mappedBaseRange = mapHeadRangeToBase(headLineRange, hunks);

    if (mappedBaseRange === null) {
      // Unmappable range short-circuits straight to the safe default
      // WITHOUT calling blameAdapter at all (decision #4).
      envelope.scopeBucket = 'change_related';
      envelope.stageDecisions.push({
        stage: 'stage0b', outcome: 'unknown', reasonCode: `${reasonPrefix}_unmappable_base_range`,
        evidenceRef: envelope.fingerprint, createdAt: nowIso(adapters.clock),
      });
      verified.push(envelope);
      continue;
    }

    const blameAdapterForCandidate = typeof adapters.blameAdapter === 'function'
      ? (file, s, e) => adapters.blameAdapter(file, s, e, anchorObj.quote)
      : undefined;

    const relevance = tagPreExisting(
      { file: filePath, startLine: mappedBaseRange.startLine, endLine: mappedBaseRange.endLine },
      { blameAdapter: blameAdapterForCandidate, impactAdapter: adapters.impactAdapter },
    );

    let scopeBucket;
    if (relevance === 'pre_existing_independent') {
      scopeBucket = 'pre_existing_independent';
    } else {
      // tagPreExisting's binary output conflates "not confirmed pre-
      // existing" with "pre-existing but impactful" — re-derive the finer
      // 3-way split decision #8 needs. blameAdapter/impactAdapter results
      // are memoized per (file, range)/(file) by the caller's
      // Stage0RelevanceContext, so this is a cache hit, not a second live
      // query.
      const predatesCommit = blameAdapterForCandidate
        ? blameAdapterForCandidate(filePath, mappedBaseRange.startLine, mappedBaseRange.endLine)
        : null;
      if (predatesCommit === true) {
        const isIndependent = typeof adapters.impactAdapter === 'function' ? adapters.impactAdapter(filePath) : null;
        scopeBucket = isIndependent === false ? 'pre_existing_impactful' : 'change_related';
      } else {
        scopeBucket = 'change_related';
      }
    }

    envelope.scopeBucket = scopeBucket;
    envelope.stageDecisions.push({
      stage: 'stage0b', outcome: scopeBucket, reasonCode: `${reasonPrefix}_relevance_${scopeBucket}`,
      evidenceRef: envelope.fingerprint, createdAt: nowIso(adapters.clock),
    });

    if (scopeBucket === 'pre_existing_independent') {
      preExistingIndependent.push(envelope);
    } else {
      verified.push(envelope);
    }
  }

  return { verified, preExistingIndependent, rejected, malformed };
}
