/**
 * Adjudication ledger and R2+ suppression logic.
 *
 * Extracted from shared.mjs — handles ledger read/write, finding metadata,
 * fuzzy suppression of re-raised findings, and Round 2+ prompt construction.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';

import { normalizePath, atomicWriteFileSync } from './file-io.mjs';
import { LedgerEntrySchema, BatchLedgerEntrySchema, Stage1MechanicalLedgerEntrySchema } from './schemas.mjs';
import { semanticId } from './findings.mjs';
import { buildFileReferenceRegex } from './language-profiles.mjs';
// The rulings block is an outbound provider payload and the GPT audit pass path
// has no egress gate of its own — `buildRulingsBlock` redacts at its render
// point. Import is shared-lib → shared-lib (no cycle: sensitive-egress-gate
// pulls only sensitive-paths/secret-patterns/redact).
import { redactSecrets } from './sensitive-egress-gate.mjs';
import { jaccardSimilarity } from './text-similarity.mjs';

// Re-exported for backward compatibility — existing consumers import
// jaccardSimilarity from here (and via shared.mjs's barrel). The
// implementation itself moved to text-similarity.mjs (zero dependencies,
// no transitive I/O) so deterministic-scorer.mjs could reuse it without
// pulling in this file's shared-cloud-config env read at module-load time.
export { jaccardSimilarity };

// Factory — creates a fresh regex per call to avoid .lastIndex state bugs.
// The global regex pattern is stateful; sharing one instance across calls
// required manual .lastIndex = 0 resets, which is a latent-bug magnet.
function getFileRegex() { return buildFileReferenceRegex(); }

// ── Topic ID & Ledger Write ─────────────────────────────────────────────────

/**
 * Deterministic fingerprint from structured fields. No content hash (stable across rewordings).
 * @param {object} finding - Finding object with section, principle, category, _pass fields
 * @returns {string} 12-char hex topic ID
 */
export function generateTopicId(finding) {
  const normFile = normalizePath(finding._primaryFile || finding.section?.split(':')[0] || 'unknown');
  const normPrinciple = (finding.principle || 'unknown').split('/')[0].split('—')[0].trim().toLowerCase().replaceAll(/\s+/g, '-');
  const normCategory = (finding.category || 'unknown').replaceAll(/\[.*?\]\s*/g, '').trim().toLowerCase().replaceAll(/\s+/g, '-');
  const pass = finding._pass || 'unknown';
  // Include semantic hash for disambiguation — prevents collisions when multiple
  // findings share the same file/principle/category/pass combination.
  const contentHash = finding._hash || semanticId(finding);
  const content = `${normFile}|${normPrinciple}|${normCategory}|${pass}|${contentHash}`;
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
}

/**
 * Shared upsert-by-topicId, read-modify-write, atomic-write mechanics for
 * any single-entry ledger schema (session, stage1-mechanical, ...). Extracted
 * (tiered-recall pipeline Phase 8) so `writeStage1MechanicalLedgerEntry`
 * doesn't duplicate `writeLedgerEntry`'s read/upsert/write logic verbatim.
 *
 * @param {string} ledgerPath
 * @param {object} entry
 * @param {import('zod').ZodType} schema
 * @param {string} logLabel - prefixes stderr diagnostics (e.g. '[ledger]')
 */
function writeSingleLedgerEntry(ledgerPath, entry, schema, logLabel) {
  const absPath = path.resolve(ledgerPath);
  let ledger = { version: 1, entries: [] };

  const validated = schema.safeParse(entry);
  if (!validated.success) {
    process.stderr.write(`  ${logLabel} Entry validation failed: ${validated.error.message.slice(0, 200)}\n`);
    return; // Refuse to write invalid data
  }
  const validEntry = validated.data;

  // Read existing — fail loudly on corruption rather than silently overwriting
  if (fs.existsSync(absPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
      // Structural check only — strict schema validation rejects batch entries with
      // adjudicationOutcome:'pending' (pre-adjudication state), causing false warnings.
      // We only need version + entries array to be present; individual entry shape is
      // validated at write time by the schema passed in.
      if (raw && typeof raw === 'object' && Array.isArray(raw.entries)) {
        ledger = raw;
      } else {
        process.stderr.write(`  ${logLabel} WARNING: ${absPath} has invalid structure — backing up and starting fresh\n`);
        fs.copyFileSync(absPath, `${absPath}.bak`);
      }
    } catch (err) {
      process.stderr.write(`  ${logLabel} WARNING: ${absPath} corrupted — backing up and starting fresh: ${err.message}\n`);
      try { fs.copyFileSync(absPath, `${absPath}.bak`); } catch { /* ignore */ }
    }
  }

  // Upsert by topicId
  const idx = ledger.entries.findIndex(e => e.topicId === validEntry.topicId);
  if (idx >= 0) {
    ledger.entries[idx] = validEntry;
  } else {
    ledger.entries.push(validEntry);
  }

  // Atomic write — temp file + rename for crash safety
  try {
    atomicWriteFileSync(absPath, JSON.stringify(ledger, null, 2));
    // Echo the RESOLVED absolute path (A3) — on Windows git-bash a `/tmp/...` argv is
    // MSYS-rewritten to %LOCALAPPDATA%\Temp, so the literal path the caller typed is
    // NOT where the file lands; the resolved path is the one to read back.
    process.stderr.write(`  ${logLabel} wrote ${ledger.entries.length} entr${ledger.entries.length === 1 ? 'y' : 'ies'} → ${absPath}\n`);
  } catch (err) {
    process.stderr.write(`  ${logLabel} Failed to write ${absPath}: ${err.message}\n`);
  }
}

/**
 * Upsert a ledger entry by topicId. Read-modify-write (not append).
 * @param {string} ledgerPath - Path to ledger JSON file
 * @param {object} entry - LedgerEntry-shaped object
 */
export function writeLedgerEntry(ledgerPath, entry) {
  writeSingleLedgerEntry(ledgerPath, entry, LedgerEntrySchema, '[ledger]');
}

/**
 * Upsert a Stage 1 mechanical-dismissal entry (tiered-recall pipeline Phase 8)
 * into the SAME ledger file session entries live in — `suppressReRaises`
 * reads `source` per-entry to route stage1-mechanical entries through the
 * fuzzy/reopen-on-touch path (like session) while excluding them from
 * `overruleCountIndex`'s hard-suppress-at-3 count (see `suppressReRaises`).
 *
 * @param {string} ledgerPath
 * @param {object} entry - Stage1MechanicalLedgerEntrySchema shape
 */
export function writeStage1MechanicalLedgerEntry(ledgerPath, entry) {
  writeSingleLedgerEntry(ledgerPath, entry, Stage1MechanicalLedgerEntrySchema, '[ledger:stage1-mechanical]');
}

/**
 * Batch-write ledger entries. Reads existing ledger (if any), upserts all entries
 * by topicId with idempotent merge, performs exactly one atomic write.
 * Only treats ENOENT as 'new file' — permission/corruption errors surface to caller.
 * Preserves both adjudication axes on upsert (adjudicationOutcome + remediationState).
 *
 * Invalid entries are returned in `rejected[]` with a per-entry reason — the caller
 * decides whether to proceed or fail. Never silently drops data.
 *
 * When `targetMetaPath` is set and `meta` is non-null, performs a locked
 * read-modify-write on `targetMetaPath` to merge the meta fields into the
 * existing `meta` block. Uses proper-lockfile for concurrent write safety and
 * atomicWriteFileSync for crash safety.
 *
 * @param {string} ledgerPath - Path to ledger JSON file
 * @param {object[]} entries - Array of LedgerEntry-shaped objects
 * @param {object} [opts]
 * @param {object|null} [opts.meta] - Meta fields to merge into targetMetaPath
 * @param {string|null} [opts.targetMetaPath] - Path to session ledger for meta updates
 * @returns {{ inserted: number, updated: number, total: number, rejected: Array<{entry:object,reason:string}> }}
 * @throws {Error} on permission errors or corrupt ledger
 */
/** Read ledger JSON from disk; returns default shape on ENOENT, throws on other errors. */
function readLedgerJson(absPath) {
  try {
    const raw = fs.readFileSync(absPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed.entries || !Array.isArray(parsed.entries)) {
      throw new Error('Corrupted ledger: missing entries array');
    }
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, entries: [] };
    throw err;
  }
}

/** Upsert one entry into a topicId→entry map. Returns 'inserted' | 'updated' | 'rejected'. */
function upsertEntry(byTopic, entry) {
  const validated = BatchLedgerEntrySchema.safeParse(entry);
  if (!validated.success) {
    return { status: 'rejected', reason: validated.error.message.slice(0, 200) };
  }
  const validEntry = validated.data;
  if (byTopic.has(validEntry.topicId)) {
    const existing = byTopic.get(validEntry.topicId);
    byTopic.set(validEntry.topicId, {
      ...existing,
      lastSeenRound: validEntry.round,
      latestFindingId: validEntry.findingId,
      detail: validEntry.detail,
      severity: validEntry.severity,
      adjudicationOutcome: existing.adjudicationOutcome,
      remediationState: existing.remediationState,
      ruling: existing.ruling,
      rulingRationale: existing.rulingRationale,
      firstSeenRound: existing.firstSeenRound ?? existing.round ?? validEntry.round
    });
    return { status: 'updated' };
  }
  byTopic.set(validEntry.topicId, { ...validEntry, firstSeenRound: validEntry.round, lastSeenRound: validEntry.round });
  return { status: 'inserted' };
}

/** Locked read-modify-write of the meta block in a session ledger file. */
function mergeMetaLocked(absMetaPath, meta) {
  if (!fs.existsSync(absMetaPath)) {
    atomicWriteFileSync(absMetaPath, JSON.stringify({ version: 1, meta: {}, entries: [] }, null, 2));
  }
  let release;
  try {
    release = lockfile.lockSync(absMetaPath, { stale: 10000 });
    let existing;
    try {
      const parsed = JSON.parse(fs.readFileSync(absMetaPath, 'utf-8'));
      existing = (parsed && typeof parsed === 'object') ? parsed : { version: 1, meta: {}, entries: [] };
    } catch {
      existing = { version: 1, meta: null, entries: [] };
    }
    existing.meta = { ...(existing.meta ?? {}), ...meta };
    atomicWriteFileSync(absMetaPath, JSON.stringify(existing, null, 2));
  } finally {
    if (release) release();
  }
}

export function batchWriteLedger(ledgerPath, entries, { meta = null, targetMetaPath = null } = {}) {
  const ledger = readLedgerJson(path.resolve(ledgerPath));
  const byTopic = new Map(ledger.entries.map(e => [e.topicId, e]));
  const rejected = [];
  let inserted = 0, updated = 0;

  for (const entry of entries) {
    const { status, reason } = upsertEntry(byTopic, entry);
    if (status === 'rejected') { rejected.push({ entry, reason }); continue; }
    if (status === 'inserted') inserted++;
    else updated++;
  }

  ledger.entries = [...byTopic.values()];
  if (ledger.entries.some(e => !e.topicId)) {
    throw new Error('Ledger integrity check failed: entry without topicId');
  }
  atomicWriteFileSync(path.resolve(ledgerPath), JSON.stringify(ledger, null, 2));

  if (targetMetaPath && meta) {
    mergeMetaLocked(path.resolve(targetMetaPath), meta);
  }

  return { inserted, updated, total: ledger.entries.length, rejected };
}

// ── Finding Metadata ────────────────────────────────────────────────────────

/**
 * Enrich GPT finding with structured fields for suppression matching.
 * @param {object} finding - Raw finding from GPT
 * @param {string} passName - Current pass name
 * @returns {object} Enriched finding (mutated in place)
 */
export function populateFindingMetadata(finding, passName) {
  // Extract file paths from GPT's free-text section field using the shared
  // registry-derived regex (handles .py, .pyi, relative/absolute paths).
  const section = finding.section || '';
  const files = [];
  const fileRegex = getFileRegex();
  let match;
  while ((match = fileRegex.exec(section)) !== null) {
    files.push(normalizePath(match[1]));
  }

  finding._primaryFile = files[0] || normalizePath(section.split(':')[0].split('(')[0].trim());
  finding.affectedFiles = files.length > 0 ? files : [finding._primaryFile];
  finding._pass = passName || finding._pass || 'unknown';
  if (!finding.principle) finding.principle = 'unknown';
  // Ensure stable content hash is always present
  if (!finding._hash) finding._hash = semanticId(finding);
  return finding;
}

// ── Fuzzy Suppression ───────────────────────────────────────────────────────
// jaccardSimilarity moved to text-similarity.mjs and is re-exported above.

/**
 * Three-step suppression: narrow by pass+scope, fuzzy score, reopen check.
 * @param {object[]} findings - Current round findings (with _primaryFile, _pass)
 * @param {object} ledger - Parsed adjudication ledger
 * @param {object} opts
 * @param {string[]} [opts.changedFiles] - Files changed since last round
 * @param {string[]} [opts.impactSet] - Files in the impact set
 * @returns {{kept: object[], suppressed: object[], reopened: object[]}}
 */
export function suppressReRaises(findings, ledger, { changedFiles = [], impactSet = [] } = {}) {
  // Threshold calibrated from real audit data — paraphrased re-raises score 0.3-0.6, new findings <0.2
  const threshold = parseFloat(process.env.SUPPRESS_SIMILARITY_THRESHOLD || '0.35');

  // Source-aware filter (Phase D fix H2; tiered-recall pipeline Phase 8 adds
  // stage1-mechanical):
  //   session entries suppress when adjudicationOutcome='dismissed' or
  //     remediationState='fixed'|'verified' (existing R2+ behavior)
  //   debt entries (Phase D) suppress unless they're escalated — escalation
  //     naturally bypasses suppression for re-deliberation
  //   stage1-mechanical entries (Phase 8) suppress the same way session does
  //     (adjudicationOutcome is always 'dismissed' per Stage1MechanicalLedgerEntrySchema)
  //     — they flow through the SAME fuzzy/reopen-on-touch path as session,
  //     just excluded from overruleCountIndex below (see that comment)
  //   Entries without an explicit source default to session (backward compat
  //     for ledger files written before Phase D)
  const resolved = (ledger?.entries || []).filter(e => {
    const src = e.source || 'session';
    if (src === 'debt') return !e.escalated;
    // session (default) and stage1-mechanical
    return e.adjudicationOutcome === 'dismissed' ||
           e.remediationState === 'fixed' ||
           e.remediationState === 'verified';
  });

  const kept = [], suppressed = [], reopened = [];
  const changedSet = new Set(changedFiles.map(normalizePath));

  // Fix #4: Build ruling count index. When a (category + primaryFile) pair has been
  // ruled 'overrule' 3+ times across rounds, hard-suppress regardless of hash drift.
  // The semantic hash drifts with GPT rewording, but the category+file is stable.
  //
  // stage1-mechanical entries are deliberately EXCLUDED (tiered-recall pipeline
  // Phase 8) — a mechanical dismissal reason (e.g. "the cited function doesn't
  // exist") can become false later (the function gets added) in a way a
  // human/GPT judgment overrule never does; counting it toward a PERMANENT
  // hard-suppress would let a stale mechanical fact silently outlive the code
  // state it was true about.
  const HARD_SUPPRESS_THRESHOLD = 3;
  const overruleCountIndex = new Map();
  for (const e of resolved) {
    if (e.source === 'stage1-mechanical') continue;
    if (e.ruling === 'overrule' || e.adjudicationOutcome === 'dismissed') {
      const catFile = `${(e.category || '').toLowerCase().trim()}|${normalizePath(e.affectedFiles?.[0] || e.section || '')}`;
      overruleCountIndex.set(catFile, (overruleCountIndex.get(catFile) || 0) + 1);
    }
  }

  for (const f of findings) {
    // Fix #4: Hard suppress check — category+file ruled overrule 3+ times
    const fCatFile = `${(f.category || '').toLowerCase().replaceAll(/\[.*?\]\s*/g, '').trim()}|${normalizePath(f._primaryFile || f.section || '')}`;
    const overruleCount = overruleCountIndex.get(fCatFile) || 0;
    if (overruleCount >= HARD_SUPPRESS_THRESHOLD) {
      suppressed.push({
        finding: f,
        matchedTopic: 'hard-suppress',
        matchScore: 1.0,
        matchedSource: 'ruling-count',
        reason: `Category+file overruled ${overruleCount} times — hard-suppressed`,
      });
      continue;
    }

    // Step 1: Narrow candidates by pass + file scope overlap
    const fFile = normalizePath(f._primaryFile || f.section || '');
    let candidates = resolved.filter(d =>
      d.pass === f._pass &&
      Array.isArray(d.affectedFiles) &&
      d.affectedFiles.some(af => normalizePath(af) === fFile || fFile.includes(normalizePath(af)))
    );

    // Step 1b: Cross-pass fallback — if no same-pass candidates, check ALL passes
    // with a higher similarity threshold (0.8) to catch conceptual duplicates
    // that GPT re-raises under a different pass label.
    if (candidates.length === 0) {
      candidates = resolved.filter(d =>
        d.pass !== f._pass &&
        Array.isArray(d.affectedFiles) &&
        d.affectedFiles.some(af => normalizePath(af) === fFile || fFile.includes(normalizePath(af)))
      );
      // Only use cross-pass candidates if they have high similarity (>0.8)
      if (candidates.length > 0) {
        candidates = candidates.filter(d => {
          const score = jaccardSimilarity(
            `${f.category} ${f.section} ${f.detail}`,
            `${d.category} ${d.section} ${d.detailSnapshot || d.detail}`
          );
          return score > 0.8;
        });
      }
    }

    if (candidates.length === 0) { kept.push(f); continue; }

    // Step 2: Score all candidates, pick highest
    let bestMatch = null, bestScore = 0;
    for (const d of candidates) {
      const score = jaccardSimilarity(
        `${f.category} ${f.section} ${f.detail}`,
        `${d.category} ${d.section} ${d.detailSnapshot || d.detail}`
      );
      if (score > bestScore) { bestScore = score; bestMatch = d; }
    }

    // Step 3: Threshold + reopen check
    if (bestMatch && bestScore > threshold) {
      const scopeDirectlyChanged = bestMatch.affectedFiles.some(af => changedSet.has(normalizePath(af)));
      if (scopeDirectlyChanged) {
        f._reopened = true;
        f._matchedTopic = bestMatch.topicId;
        f._matchScore = bestScore;
        reopened.push(f);
      } else {
        const src = bestMatch.source || 'session';
        const reason = src === 'debt'
          ? `Matches deferred debt entry (${bestMatch.deferredReason}), scope unchanged`
          : `Matches ${bestMatch.adjudicationOutcome} entry, scope unchanged`;
        suppressed.push({
          finding: f,
          matchedTopic: bestMatch.topicId,
          matchScore: bestScore,
          matchedSource: src,
          reason,
        });
      }
    } else {
      kept.push(f);
    }
  }

  return { kept, suppressed, reopened };
}

// ── Rulings Block & R2+ Prompts ─────────────────────────────────────────────

/** Rendering policy — docs/plans/dismissed-fp-reopen-policy.md (Phase 1). */
const RULINGS_BLOCK_CAP = 2500;
/** The disproof IS the payload for a dismissal — 100 chars cut it mid-sentence. */
const DISMISSED_RATIONALE_BUDGET = 300;
const OTHER_GROUP_MAX_ENTRIES = 5;
const MARKER_MAX_IDS = 5;
/** Bounds the marker at the RENDER point — `topicId` is an unbounded string in
 *  the schema, so the width cannot be assumed of the data (audit R3-M2). */
const TOPIC_ID_WIDTH = 6;

const shortTopicId = (id) => String(id).slice(0, TOPIC_ID_WIDTH);

/**
 * Truncate on a word boundary. A mid-token cut turns a cited symbol into a
 * fragment that reads like a real identifier but matches nothing — worse than
 * omitting it. The space before the ellipsis is load-bearing, not cosmetic.
 */
function truncateAtWord(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  const body = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()} …`;
}

function renderOmissionMarker(omittedCount, ids) {
  const shown = ids.slice(0, MARKER_MAX_IDS);
  const extra = omittedCount - shown.length;
  return `  ... and ${omittedCount} more dismissed items (${shown.join(', ')}${extra > 0 ? `, +${extra} more` : ''} — see ledger)`;
}

/**
 * The marker's provable worst case: MARKER_MAX_IDS full-width ids and both
 * counts at maximum width. Computable from the entry count ALONE, before any
 * allocation — which is what makes the reservation non-circular. Reserving the
 * *actual* marker would require knowing what was omitted, which requires
 * allocating, which requires the reservation (Gemini gate G1).
 */
function omissionMarkerMaxLen(totalDismissed) {
  const ids = Array.from({ length: MARKER_MAX_IDS }, () => 'x'.repeat(TOPIC_ID_WIDTH));
  return renderOmissionMarker(totalDismissed, ids).length;
}

/** Most-recently-adjudicated first; `topicId` asc breaks ties. Total and stable
 *  — never relies on ledger array order, so the block is byte-identical across
 *  runs for the same entry set. */
function byDismissalPriority(a, b) {
  return (b.resolvedRound ?? 0) - (a.resolvedRound ?? 0)
    || String(a.topicId).localeCompare(String(b.topicId));
}

/**
 * Format ledger entries as system-prompt exclusions for a specific pass.
 *
 * **Per-group headers are load-bearing** (docs/plans/dismissed-fp-reopen-policy.md).
 * This function previously rendered DISMISSED, SEVERITY ADJUSTED and FIXED under
 * one header reading *"Do NOT re-raise them unless the code they affect has
 * materially changed"*. In an active fix loop the affected code has ALWAYS
 * changed — that is what a fix loop is — so for a dismissal that sentence was an
 * explicit licence to re-raise, and it directly contradicted `R2_ROUND_MODIFIER`
 * ("Paraphrase a dismissed finding as 'new' — that contradicts your own
 * judgment"), which `buildR2SystemPrompt` concatenates immediately above it. Given
 * a prohibition followed by an always-true escape clause, the model took the
 * permissive branch: a GPT false positive re-raised 3 consecutive rounds in the
 * field (2026-07-16) despite being dismissed each round with deterministic
 * disproof. The clause now attaches ONLY to FIXED, where it is correct.
 *
 * @param {string} ledgerPath - Path to ledger JSON file
 * @param {string} passName - Current pass name
 * @param {string[]} [impactSet] - Files in the impact set
 * @returns {string} Formatted rulings block for system prompt
 */
export function buildRulingsBlock(ledgerPath, passName, impactSet = []) {
  if (!ledgerPath) return '';
  const absPath = path.resolve(ledgerPath);
  if (!fs.existsSync(absPath)) {
    process.stderr.write(`  [rulings] Ledger not found: ${absPath}\n`);
    return '';
  }

  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
  } catch (err) {
    process.stderr.write(`  [rulings] Failed to parse ledger: ${err.message}\n`);
    return '';
  }

  const scoped = (Array.isArray(ledger.entries) ? ledger.entries : []).filter(e => e && e.pass === passName);
  if (scoped.length === 0) return '';

  // Defensive: an entry missing `topicId` (its identity) can't be rendered
  // (`.slice` below) or referenced, so skip it rather than throw and take down
  // the whole R2 audit. Mirrors the file-level graceful-degradation above —
  // this function must never crash the caller on a malformed/partial ledger.
  const entries = scoped.filter(e => typeof e.topicId === 'string' && e.topicId.length > 0);
  const skipped = scoped.length - entries.length;
  if (skipped > 0) {
    process.stderr.write(`  [rulings] skipped ${skipped} malformed ledger entr${skipped === 1 ? 'y' : 'ies'} (missing topicId)\n`);
  }
  if (entries.length === 0) return '';

  // Group by outcome
  const dismissed = entries.filter(e => e.adjudicationOutcome === 'dismissed');
  const adjusted = entries.filter(e => e.adjudicationOutcome === 'severity_adjusted');
  const fixed = entries.filter(e => e.remediationState === 'fixed' || e.remediationState === 'verified');

  // Optional-field guards: an entry can be well-formed enough to render (has
  // topicId) yet omit rationale/scope; `.slice`/`.join` on those must not throw.
  const files = (e) => (Array.isArray(e.affectedFiles) ? e.affectedFiles : []).join(', ');
  const cat = (e) => e.category ?? '(uncategorized)';

  const sections = [[
    '## YOUR PRIOR RULINGS (scoped to this pass)',
    '',
    'These items were deliberated in prior rounds.',
    '',
  ].join('\n')];
  let used = sections[0].length;

  // ── DISMISSED — allocated FIRST; its disproof is what stops the re-raise ──
  if (dismissed.length > 0) {
    const header = [
      '### DISMISSED — YOU ruled these claims FALSE',
      'Do NOT re-raise them. If you believe a code change has invalidated the',
      'stated reason, you MUST cite the specific changed line that does so — a',
      're-raise without that citation contradicts your own prior ruling.',
      '',
      '',
    ].join('\n');

    // Reserve the marker's worst case up front (see omissionMarkerMaxLen). If
    // nothing ends up omitted the slack is simply unused — deterministic, and
    // cheaper than a fixed-point re-allocation.
    const reservation = omissionMarkerMaxLen(dismissed.length);
    const budget = RULINGS_BLOCK_CAP - used - header.length - reservation;

    const ordered = [...dismissed].sort(byDismissalPriority);
    const lines = [];
    let spent = 0;
    for (const d of ordered) {
      // Redact BEFORE truncating: slicing first can bisect a secret into a
      // fragment the pattern scanner no longer matches, which would then ship.
      // This render point IS the egress boundary — the GPT audit pass path has
      // no assertEgressSafe gate (traced 2026-07-16; only ossStructuredCall
      // gates). `redactSecrets` is the gentle pattern-based redactor, NOT
      // sanitizer.mjs, whose blanket 20+-char-token rule would corrupt prose.
      const reason = truncateAtWord(redactSecrets(d.rulingRationale ?? ''), DISMISSED_RATIONALE_BUDGET);
      const line = `- [${shortTopicId(d.topicId)}] "${cat(d)}" — YOU ruled DISMISSED R${d.resolvedRound ?? '?'}. Reason: ${reason}. Scope: ${files(d)}`;
      if (spent + line.length + 1 > budget) break;
      lines.push(line);
      spent += line.length + 1;
    }

    const omitted = ordered.length - lines.length;
    if (omitted > 0) {
      // Rendered AFTER allocation, and ≤ the reservation by construction.
      lines.push(renderOmissionMarker(omitted, ordered.slice(lines.length).map((d) => shortTopicId(d.topicId))));
    }
    const section = `${header}${lines.join('\n')}\n`;
    sections.push(section);
    used += section.length;
  }

  // ── FIXED — the reopen-on-change clause lives HERE and only here ──
  if (fixed.length > 0) {
    const lines = [
      '### FIXED (do not re-raise)',
      'Re-raise ONLY if the code they affect has materially changed (in which case',
      'mark as REOPENED) — a fix can be undone by a later change.',
      '',
    ];
    for (const f of fixed.slice(0, OTHER_GROUP_MAX_ENTRIES)) {
      lines.push(`- [${shortTopicId(f.topicId)}] "${cat(f)}" — FIXED R${f.resolvedRound ?? '?'}. Scope: ${files(f)}`);
    }
    const section = `${lines.join('\n')}\n`;
    if (used + section.length <= RULINGS_BLOCK_CAP) { sections.push(section); used += section.length; }
  }

  if (adjusted.length > 0) {
    const lines = ['### SEVERITY ADJUSTED (do not re-escalate)'];
    for (const a of adjusted.slice(0, OTHER_GROUP_MAX_ENTRIES)) {
      lines.push(`- [${shortTopicId(a.topicId)}] "${cat(a)}" — ${a.originalSeverity ?? '?'}→${a.severity ?? '?'} R${a.resolvedRound ?? '?'}. Scope: ${files(a)}`);
    }
    const section = `${lines.join('\n')}\n`;
    if (used + section.length <= RULINGS_BLOCK_CAP) { sections.push(section); used += section.length; }
  }

  const block = sections.join('\n');
  process.stderr.write(`  [rulings] ${entries.length} entries for pass "${passName}" (${block.length} chars)\n`);
  return block;
}

/** Round 2+ system prompt modifier for verification-focused auditing. */
export const R2_ROUND_MODIFIER = `ROUND 2+ VERIFICATION MODE

This is a follow-up round. Your job has CHANGED from Round 1:

Round 1: Find ALL issues in the codebase.
Round 2+: VERIFY FIXES and CHECK FOR REGRESSIONS.

FOCUS ON:
1. Do the fixes resolve the original findings?
2. Did any fix introduce NEW problems in CHANGED code?
3. Did changes cause KNOCK-ON regressions in code that imports/depends on changed files?
4. Are there genuinely NEW issues not present in Round 1?

DO NOT:
- Re-raise findings from YOUR PRIOR RULINGS section below
- Paraphrase a dismissed finding as "new" — that contradicts your own judgment
- Re-audit unchanged, unaffected code for the same issue classes

If you believe a dismissed finding should be REOPENED because changed code
materially affects its scope, raise it with is_reopened: true.`;

/**
 * Build a Round 2+ system prompt with rulings context and pass rubric.
 * @param {string} passRubric - The pass-specific rubric text
 * @param {string} rulingsBlock - Output of buildRulingsBlock()
 * @returns {string} Complete R2+ system prompt
 */
export function buildR2SystemPrompt(passRubric, rulingsBlock) {
  return `${R2_ROUND_MODIFIER}\n\n${rulingsBlock}\n\n---\n\nPASS RUBRIC (what to check):\n${passRubric}`;
}

// ── Impact Set ──────────────────────────────────────────────────────────────

/**
 * Compute impact set: changed files + files that import them.
 * @param {string[]} changedFiles - Files directly changed
 * @param {string[]} allFiles - All project files to scan for imports
 * @returns {string[]} Sorted list of impacted file paths (normalized)
 */
export function computeImpactSet(changedFiles, allFiles) {
  const impact = new Set(changedFiles.map(normalizePath));

  for (const file of allFiles) {
    const normFile = normalizePath(file);
    if (impact.has(normFile)) continue;

    const absPath = path.resolve(file);
    if (!fs.existsSync(absPath)) continue;

    const content = fs.readFileSync(absPath, 'utf-8');
    for (const changed of changedFiles) {
      const basename = path.basename(changed, path.extname(changed));
      const normChanged = normalizePath(changed);
      if (content.includes(`from './${basename}`) || content.includes(`from './${normChanged}`)) {
        impact.add(normFile);
        break;
      }
    }
  }

  return [...impact].sort();
}

// ── Stage 2 Outcome Finalization (tiered-recall pipeline Phase 9) ──────────

/**
 * Compute the ledger updates a completed Stage 2 adjudication round implies
 * (`final-adjudication.mjs::runFinalAdjudication`'s output). PURE — returns
 * a plan of actions, does not perform I/O itself; the caller applies them
 * via `writeStage1MechanicalLedgerEntry`/`writeLedgerEntry`.
 *
 * - `stage2_reversed` — Gemini overturned a `stage1_mechanical_dismissed`
 *   entry: the underlying ledger fact was WRONG. The matching stage1-
 *   mechanical entry's `remediationState` moves to `'regressed'` (an
 *   existing lifecycle state — "we thought this was settled, it wasn't")
 *   rather than being silently deleted, preserving the audit trail of what
 *   was believed and when it was corrected.
 * - `stage2_confirmed_dismissal` — Gemini agrees with the mechanical
 *   dismissal: no ledger change needed, the entry already correctly reads
 *   `dismissed`. Reported for telemetry/audit-trail completeness only.
 * - `stage2_missed_candidate` — a NEW finding Gemini's clean-challenge
 *   sample surfaced, not a dismissal reversal — this is NOT a ledger write
 *   at all (the ledger records dismissals/debt, not active findings); it is
 *   reported so the caller can route it into the normal human-queue path,
 *   same as any other new finding.
 *
 * @param {{reversed: object[], confirmedDismissal: object[], verified: object[], missedCandidates: Array<{file: string, finding?: object}>}} adjudicationResult
 * @returns {{ledgerUpdates: Array<{action: 'mark-regressed'|'confirm-dismissal', topicId: string|null}>, newCandidates: Array<{file: string, finding?: object}>}}
 */
export function finalizeLedgerOutcomes(adjudicationResult) {
  const ledgerUpdates = [];

  for (const envelope of adjudicationResult.reversed || []) {
    ledgerUpdates.push({ action: 'mark-regressed', topicId: envelope.canonicalFinding?._stage1LedgerTopicId ?? null, fingerprint: envelope.fingerprint ?? null });
  }
  for (const envelope of adjudicationResult.confirmedDismissal || []) {
    ledgerUpdates.push({ action: 'confirm-dismissal', topicId: envelope.canonicalFinding?._stage1LedgerTopicId ?? null, fingerprint: envelope.fingerprint ?? null });
  }

  return {
    ledgerUpdates,
    newCandidates: adjudicationResult.missedCandidates || [],
  };
}
