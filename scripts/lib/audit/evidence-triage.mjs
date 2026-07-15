/**
 * @fileoverview Stage 0 — deterministic evidence triage for the tiered-recall
 * audit pipeline. Plan: docs/plans/tiered-recall-audit-pipeline.md Phase 3.
 *
 * `verifyAnchor` and `tagPreExisting` are PURE — no I/O, no VCS access — so
 * they're directly unit-testable (Tier 1). `runStage0EvidenceTriage` is the
 * orchestration entry point that supplies real diff text / git access via
 * injectable `adapters`, per the plan's design (round-2 finding #3 —
 * `findings-pipeline.mjs::processFindings` stays pure; Stage 0 does NOT live
 * inside it, and lives here instead as its own orchestration layer).
 *
 * @module scripts/lib/audit/evidence-triage
 */

import { EvidenceAnchorSchema } from '../schemas.mjs';
import { promoteAlternative } from './candidate-envelope.mjs';
import { nowIso } from './time-utils.mjs';

/**
 * Normalise whitespace for content comparison — a quote copied from a diff
 * may have different leading indentation or line-ending style than what a
 * naive substring search would require. Collapses all whitespace runs to a
 * single space and trims.
 */
function normalizeWhitespace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Extract the per-file section of a unified diff (from its `diff --git`
 * header to the next one, or end of string). Returns `null` if the file
 * isn't mentioned in the diff at all.
 *
 * @param {string} diffText
 * @param {string} filePath - either the old or new path
 * @returns {{section: string, fileStatus: 'modified'|'added'|'deleted'|'renamed'|'copied'} | null}
 */
function extractFileDiffSection(diffText, filePath) {
  if (!diffText || !filePath) return null;
  const parts = diffText.split(/(?=^diff --git )/m);
  for (const part of parts) {
    // Consolidated Gemini gate fix G1: `.` never matches a line terminator in
    // JS regex (not just `\n` — `\r` is excluded too), so the original
    // `a\/(.+?) b\/(.+?)\n` could never match a CRLF diff header at all — a
    // Windows-generated diff (or one round-tripped through a CRLF-preserving
    // tool) would silently fail EVERY file lookup, degrading Stage 0 to
    // unverifiable-escalate-everything with no signal anything was wrong.
    //
    // Consolidated Gemini gate fix G3, round 3: git quotes each path in the
    // header (`diff --git "a/path with spaces.js" "b/path with spaces.js"`)
    // whenever it contains a space or other char core.quotepath treats as
    // special — the unquoted-only regex returned null for every such file.
    // Unlike G1 (which corrupted a valid match into a false 'fabricated'),
    // this failure mode was already SAFE (unverifiable → escalate, never a
    // silent wrong answer) — fixed anyway for correctness, not urgency.
    const header = part.match(/^diff --git "?a\/(.+?)"? "?b\/(.+?)"?\r?\n/);
    if (!header) continue;
    const [, oldPath, newPath] = header;
    if (oldPath !== filePath && newPath !== filePath) continue;
    let fileStatus = 'modified';
    if (/^new file mode/m.test(part)) fileStatus = 'added';
    else if (/^deleted file mode/m.test(part)) fileStatus = 'deleted';
    else if (/^rename from /m.test(part)) fileStatus = 'renamed';
    else if (/^copy from /m.test(part)) fileStatus = 'copied';
    return { section: part, fileStatus, oldPath, newPath };
  }
  return null;
}

/**
 * Split a file's diff section into individual `@@ ... @@` hunks. Each hunk's
 * body is everything up to (not including) the next `@@` line or EOF.
 */
function splitIntoHunks(section) {
  const hunks = [];
  let current = null;
  for (const rawLine of section.split('\n')) {
    if (rawLine.startsWith('@@')) {
      if (current) hunks.push(current);
      current = [];
      continue;
    }
    if (current === null) continue; // before the first hunk (file header lines)
    current.push(rawLine);
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
    for (const rawLine of hunk) {
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
 * verifyAnchor — confirms an anchor's `quote` is real, content-verified
 * against the actual diff, on the correct side of the correct file, AND
 * (Cluster B audit fix H3, round 1) that the anchor's claimed `fileStatus`
 * matches what the diff itself shows for that file — an anchor claiming
 * `added` against a file the diff shows as merely `modified` is fabricated
 * metadata even if the quote text happens to match.
 *
 * Round-2 residual H3: the diff section was previously located via ONLY
 * `filePath` (whichever of `oldFile`/`newFile` the anchor's `side` selects),
 * so a `renamed`/`copied` anchor could fabricate the OTHER path field (the
 * one not used to locate the section) while still verifying — e.g. a real
 * rename `a.js -> b.js` anchored with `side: 'head'` only ever checked
 * `newFile === 'b.js'` against the located section, never cross-checking
 * `oldFile` against that same section's actual old path. Now BOTH fields
 * are cross-checked against the section's real `oldPath`/`newPath` whenever
 * the anchor declares both (renamed/copied; schema already requires both
 * there — see `EvidenceAnchorSchema`'s `superRefine`).
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
 * Verify one anchor field (`'anchor'` for commission, `'triggerAnchor'` for
 * omission) with the envelope-aware fallback (Gemini gate round-2 finding
 * #G1): if the canonical claim's anchor is fabricated, try every OTHER
 * contributing source's anchor before giving up on the whole envelope.
 * Shared between commission and omission handling (Cluster B audit fix H3 —
 * omission's `triggerAnchor` is itself a commission-type fact per the plan's
 * round-3 refinement and must be verified the same way, not skipped).
 *
 * @returns {{envelope: object, outcome: 'verified'|'unverifiable'|'rejected'}}
 */
function verifyWithFallback(envelope, anchorField, diffText) {
  const originalAnchor = envelope.canonicalFinding[anchorField];
  let outcome = verifyAnchor(originalAnchor, diffText);
  if (outcome !== 'fabricated') return { envelope, outcome };

  for (let i = 0; i < envelope.evidenceAlternatives.length; i++) {
    const alt = envelope.evidenceAlternatives[i];
    if (alt[anchorField] === originalAnchor) continue; // that's the one that just failed
    if (!alt[anchorField]) continue;
    const altOutcome = verifyAnchor(alt[anchorField], diffText);
    if (altOutcome === 'verified') {
      return { envelope: promoteAlternative(envelope, i), outcome: 'verified' };
    }
  }
  return { envelope, outcome: 'rejected' };
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
 * `stage0_rejected` envelopes are returned separately in `rejected` and MUST
 * be treated by the caller as local diagnostic telemetry ONLY — never written
 * to the adjudication ledger (per the state machine in the plan's §1.5).
 *
 * @param {Array<import('./candidate-envelope.mjs').AuditCandidateEnvelope>} envelopes
 * @param {object} ctx
 * @param {string} ctx.diffText
 * @param {object} adapters
 * @param {(file: string, startLine: number, endLine: number) => boolean|null} [adapters.blameAdapter]
 * @param {(file: string) => boolean|null} [adapters.impactAdapter]
 * @param {() => string} [adapters.clock] - injectable for deterministic tests; defaults to the real clock in production
 * @returns {{verified: Array<object>, rejected: Array<object>}}
 */
export function runStage0EvidenceTriage(envelopes, ctx, adapters = {}) {
  const verified = [];
  const rejected = [];

  for (const rawEnvelope of envelopes) {
    const evidenceType = rawEnvelope.canonicalFinding.evidenceType;
    const anchorField = evidenceType === 'omission' ? 'triggerAnchor' : 'anchor';
    const reasonPrefix = evidenceType === 'omission' ? 'omission_trigger' : 'commission_anchor';

    const { envelope, outcome } = verifyWithFallback(rawEnvelope, anchorField, ctx.diffText);

    if (outcome === 'rejected') {
      envelope.stageDecisions.push({
        stage: 'stage0', outcome: 'rejected', reasonCode: `${reasonPrefix}_fabricated_all_alternatives_failed`,
        evidenceRef: envelope.fingerprint, createdAt: nowIso(adapters.clock),
      });
      rejected.push(envelope); // LOCAL TELEMETRY ONLY — caller must never write this to the ledger
      continue;
    }

    envelope.stageDecisions.push({
      stage: 'stage0',
      outcome: outcome === 'verified' ? 'verified' : 'unverifiable',
      reasonCode: outcome === 'verified' ? `${reasonPrefix}_content_verified` : `${reasonPrefix}_diff_section_unavailable`,
      evidenceRef: envelope.fingerprint,
      createdAt: nowIso(adapters.clock),
    });
    verified.push(envelope);
  }

  return { verified, rejected };
}
