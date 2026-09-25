#!/usr/bin/env node
/**
 * @fileoverview Automatic debt capture from adjudication ledger.
 *
 * Reads an adjudication ledger and converts every `ruling: 'defer'` entry
 * into a debt-ledger entry, writing it to `.audit/tech-debt.json` and
 * optionally syncing to Supabase.
 *
 * This is the single-command replacement for the manual `node -e` loop that
 * Step 3.6 previously required. Run it after Step 3.5 (ledger write) and
 * before Step 4 (fix) to make the blocking gate automatic.
 *
 * After a successful write, this also re-scans every round ledger in the
 * same `.audit/` directory (see `checkCaptureTrail()`) and WARNs — non-
 * fatally, this run already succeeded — about any `ruling: 'defer'` entry
 * from an EARLIER, forgotten invocation that still has no matching entry in
 * `.audit/tech-debt.json`. Nothing enforces that Step 3.6 runs every round —
 * it's a manual CLI invocation an LLM-driven audit session is only
 * *instructed* to run — so the standalone
 * `scripts/debt-capture-trail-check.mjs` (wired into `maintenance-checks.mjs`
 * as `debt-capture-trail`) is the deterministic backstop; this WARN is the
 * cheap version that surfaces the same gap the very next time ANY audit
 * round captures debt, without waiting for someone to separately run or
 * enable that maintenance check.
 *
 * Usage:
 *   node scripts/debt-auto-capture.mjs --ledger <path>
 *   node scripts/debt-auto-capture.mjs --ledger <path> --reason blocked-by --blocked-by "owner/repo#123"
 *   node scripts/debt-auto-capture.mjs --ledger <path> --dry-run
 *   node scripts/debt-auto-capture.mjs --ledger <path> --run <SID>
 *
 * Exit codes:
 *   0 — COMPLETE capture: every deferred ledger entry landed in the debt
 *       ledger (including the "0 deferred entries found" case)
 *   1 — missing required args, ledger not found, write failure, OR a PARTIAL
 *       capture: one or more deferred entries failed to build or were
 *       rejected by `PersistedDebtEntrySchema`
 *
 * A partial capture exits non-zero deliberately. The entries that DID validate
 * are still written (the write is idempotent, so re-running after fixing the
 * cause is safe), but a caller checking `$?` must never read "9 of 15 captured"
 * as "captured". Measured 2026-09-04: a run rejected 6 of 15 defers on the
 * `deferredRationale` length cap and exited 0, leaving those six absent from
 * debt memory and therefore un-suppressed in every future audit — the summary
 * card said so, but nothing mechanical did.
 */

import './lib/load-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { buildDebtEntry } from './lib/debt-capture.mjs';
import { readDebtLedger, DEFAULT_DEBT_LEDGER_PATH } from './lib/debt-ledger.mjs';
import { markDebtSuperseded, persistDebtEntries, selectEventSource as selectDebtEventSource } from './lib/debt-memory.mjs';
import {
  findRoundLedgers, readDeferredEntries, collectDebtIdentities, findUncapturedDeferrals,
} from './lib/debt-capture-trail.mjs';
import { resolveRepoForStore, initLearningStore, isCloudEnabled } from './learning-store.mjs';
import { generateRepoProfile } from './lib/context.mjs';
import { finishAndExit } from './lib/cli-io.mjs';
// Side-effecting import — populates the process-local writer registry
// (`debt.entries` among others) the same way the orchestrator does. Without
// it this CLI, run standalone, would find zero handlers and every write
// would report `lost` regardless of what actually happened.
import './lib/audit-store-writers.mjs';

// ── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    ledger: null,
    reason: 'out-of-scope',     // default deferredReason
    blockedBy: undefined,
    followupPr: undefined,
    approver: undefined,
    approvedAt: undefined,
    policyRef: undefined,
    reviewDeadline: undefined,
    supersedes: undefined,
    supersedesWith: undefined,
    run: null,                  // SID override; defaults to timestamp
    changed: undefined,         // comma-separated changed-file paths (same-file-batch nudge scoping)
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--ledger':          args.ledger         = argv[++i]; break;
      case '--reason':          args.reason         = argv[++i]; break;
      case '--blocked-by':      args.blockedBy      = argv[++i]; break;
      case '--followup-pr':     args.followupPr     = argv[++i]; break;
      case '--approver':        args.approver       = argv[++i]; break;
      case '--approved-at':     args.approvedAt     = argv[++i]; break;
      case '--policy-ref':      args.policyRef      = argv[++i]; break;
      case '--review-deadline': args.reviewDeadline = argv[++i]; break;
      case '--supersedes':      args.supersedes     = argv[++i]; break;
      case '--supersedes-with': args.supersedesWith = argv[++i]; break;
      case '--run':              args.run          = argv[++i]; break;
      case '--changed':          args.changed      = argv[++i]; break;
      case '--dry-run':          args.dryRun       = true;      break;
      case '--help': case '-h':  args.help         = true;      break;
    }
  }

  return args;
}

function usage() {
  console.log(`
Usage: node scripts/debt-auto-capture.mjs --ledger <path> [options]

Reads an adjudication ledger and captures all ruling=defer entries to
.audit/tech-debt.json. Run after Step 3.5 and before Step 4.

Options:
  --ledger <path>        Path to adjudication ledger JSON (required)
  --reason <r>           deferredReason for all entries (default: out-of-scope)
                         Choices: out-of-scope | blocked-by | deferred-followup
                                  accepted-permanent | policy-exception
  --blocked-by <ref>     Required when --reason blocked-by  (issue/PR/topicId)
  --followup-pr <ref>    Required when --reason deferred-followup  (owner/repo#N)
  --approver <name>      Required when --reason accepted-permanent or policy-exception
  --approved-at <iso>    Required when --reason accepted-permanent
  --policy-ref <ref>     Required when --reason policy-exception
  --review-deadline <iso> Override the auto-computed revalidation trigger
                          (auto-set for blocked-by/deferred-followup, 90 days out)
  --supersedes <old-topic-id>       Link an existing entry as replaced by...
  --supersedes-with <new-topic-id>  ...this newly-captured entry. Both flags
                          are required together; refused if either topicId
                          cannot be verified to exist after this capture.
  --run <SID>            Session ID stamp (default: auto-generated)
  --changed <a,b,...>    Comma-separated changed-file paths for this run.
                         When set, the same-file-batch WARN (below) fires
                         only for a file that is ALSO in this list, and is
                         phrased as a statement rather than a hedge. Omitted
                         (or empty) falls back to a hedged count-only heuristic.
  --dry-run              Print what would be captured, but do not write
  --help                 Show this message

Same-file-batch WARN: when this batch captures 5+ out-of-scope defers
citing the same file (reason=out-of-scope only), a WARN names the file and
count — a nudge, never a gate. See AGENTS.md's "Scope is decided by impact,
not authorship" for why a same-file batch this size is worth a second look.

Template-rationale WARN: when 3+ out-of-scope defers in this batch share
near-identical rationale wording (only the named function/path differs),
a WARN names the topic ids — catches a copy-pasted excuse even when it's
split across files or rounds to duck the same-file count above.
`.trim());
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate per-reason required fields. Returns an error message or null.
 * @param {object} args
 * @returns {string|null}
 */
function validateReasonFields(args) {
  const { reason } = args;
  if (reason === 'blocked-by' && !args.blockedBy) {
    return '--reason blocked-by requires --blocked-by <ref>';
  }
  if (reason === 'deferred-followup' && !args.followupPr) {
    return '--reason deferred-followup requires --followup-pr <ref>';
  }
  if (reason === 'accepted-permanent' && (!args.approver || !args.approvedAt)) {
    return '--reason accepted-permanent requires --approver and --approved-at';
  }
  if (reason === 'policy-exception' && (!args.policyRef || !args.approver)) {
    return '--reason policy-exception requires --policy-ref and --approver';
  }
  return null;
}

/**
 * `--supersedes`/`--supersedes-with` are both-or-neither (docs/plans/
 * debt-ledger-persisted-record-contract.md §2 Fix D, round-3 GPT audit H6) —
 * a scalar flag alone is ambiguous the moment more than one topic is
 * captured, so both endpoints must be named explicitly.
 */
function validateSupersedesFields(args) {
  if (!!args.supersedes !== !!args.supersedesWith) {
    return '--supersedes and --supersedes-with must be given together, naming both the old and the new topicId';
  }
  if (args.supersedes && args.supersedes === args.supersedesWith) {
    return '--supersedes and --supersedes-with must name different topicIds';
  }
  return null;
}

// ── Rationale padding ────────────────────────────────────────────────────────

const MIN_RATIONALE = 20;

/**
 * Ensure rationale meets the 20-char minimum enforced by PersistedDebtEntrySchema.
 */
function ensureRationaleLength(rationale, category) {
  if (!rationale || rationale.trim().length === 0) {
    return `Deferred from adjudication: ${category || 'see ledger entry'}`.padEnd(MIN_RATIONALE, '.');
  }
  if (rationale.length < MIN_RATIONALE) {
    return rationale.padEnd(MIN_RATIONALE);
  }
  return rationale;
}

// ── Build helpers ─────────────────────────────────────────────────────────────

/**
 * Convert one adjudication-ledger entry into a finding-shaped object
 * suitable for buildDebtEntry().
 */
function ledgerEntryToFinding(ledgerEntry) {
  const files = ledgerEntry.affectedFiles || [];
  const primaryFile = files[0] || ledgerEntry.section?.split(':')[0] || '';
  return {
    _topicId:           ledgerEntry.topicId,
    topicId:            ledgerEntry.topicId,
    _hash:              ledgerEntry.semanticHash || ledgerEntry.topicId,
    semanticHash:       ledgerEntry.semanticHash,
    severity:           ledgerEntry.severity,
    category:           ledgerEntry.category,
    section:            ledgerEntry.section,
    detail:             ledgerEntry.detailSnapshot || '',
    affectedFiles:      files,
    _primaryFile:       primaryFile,
    affectedPrinciples: ledgerEntry.affectedPrinciples || [],
    principle:          (ledgerEntry.affectedPrinciples || [])[0] || '',
    _pass:              ledgerEntry.pass || 'unknown',
    classification:     ledgerEntry.classification || null,
  };
}

// ── Same-file-batch nudge ────────────────────────────────────────────────────
// AGENTS.md "Scope is decided by impact, not authorship" — measured 2026-09-25:
// several audit runs mass-deferred 19-46 out-of-scope findings citing the same
// file in one batch, each with near-identical "doesn't call my new function"
// boilerplate. Advisory only, never blocks a capture — same posture as the
// capture-trail WARN below. See references/debt-capture.md.

const SAME_FILE_BATCH_THRESHOLD = 5;

/**
 * Normalize a file path for cross-platform comparison: backslashes to
 * forward slashes, a leading `./` stripped. This repo develops on Windows;
 * `git diff --name-only` always emits forward slashes, but a model-authored
 * `affectedFiles` entry is not guaranteed to.
 */
function normalizeFilePath(p) {
  if (!p) return '';
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Group this batch's out-of-scope deferrals by file, counting a ledger entry
 * toward EVERY file in its `affectedFiles` array (not just index 0 — a cited
 * sibling file listed second must still count), falling back to the
 * `section` prefix only when `affectedFiles` is empty. Returns clusters at
 * or above `threshold`.
 *
 * `changedFiles` (from `--changed`), when non-empty, narrows each cluster's
 * `inDiff` flag — the caller uses this to choose assertive vs hedged
 * wording. An empty/absent `changedFiles` leaves `inDiff: null` (unknown),
 * never `false` — "no `--changed` given" is not evidence the file was
 * untouched.
 *
 * @param {object[]} deferredEntries - ledger entries with `ruling: 'defer'`
 * @param {{threshold?: number, changedFiles?: string[]}} [opts]
 * @returns {Array<{file: string, count: number, topicIds: string[], inDiff: boolean|null}>}
 */
function detectSameFileBatchDefers(deferredEntries, { threshold = SAME_FILE_BATCH_THRESHOLD, changedFiles } = {}) {
  const changedSet = Array.isArray(changedFiles) && changedFiles.length > 0
    ? new Set(changedFiles.map(normalizeFilePath))
    : null;
  const byFile = new Map();
  for (const entry of deferredEntries) {
    const files = Array.isArray(entry.affectedFiles) && entry.affectedFiles.length > 0
      ? entry.affectedFiles
      : [entry.section?.split(':')[0]].filter(Boolean);
    const seenForThisEntry = new Set();
    for (const rawFile of files) {
      const file = normalizeFilePath(rawFile);
      if (!file || seenForThisEntry.has(file)) continue; // one entry counts once per file
      seenForThisEntry.add(file);
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push(entry.topicId);
    }
  }
  const clusters = [];
  for (const [file, topicIds] of byFile.entries()) {
    if (topicIds.length < threshold) continue;
    // changedSet present + file NOT in it → positive evidence this file was
    // NOT touched by the current change; suppress the WARN entirely rather
    // than print a hedge we have evidence against.
    if (changedSet && !changedSet.has(file)) continue;
    clusters.push({
      file,
      count: topicIds.length,
      topicIds,
      // true = confirmed in --changed; null = no --changed given, unknown
      // (never false here — that case was filtered above).
      inDiff: changedSet ? true : null,
    });
  }
  return clusters;
}

// ── Template-rationale nudge ─────────────────────────────────────────────────
// A second, independent signal from the same investigation: the same-file
// count catches co-location, but the actual observed failure mode was
// near-IDENTICAL PHRASING — "unrelated to `getRunMeta`... verified zero
// coupling to `getRunMeta`" repeated 19-46 times with only the identifier
// changing. That is copy-pasted reasoning wearing a per-finding rationale's
// clothes, and it is a STRONGER, more specific tell than file co-location:
// it fires even when a batch is split across files or across rounds to stay
// under the same-file threshold, which the file-count check alone cannot see.

const TEMPLATE_RATIONALE_THRESHOLD = 3;
const MIN_TEMPLATE_LENGTH = 20; // shorter than this, a coincidental match is noise, not a template

/**
 * Strip anything that looks like a specific code identifier — backtick-quoted
 * tokens, and bare dotted/slashed/snake_case words — so what remains is the
 * surrounding PROSE TEMPLATE. Two rationales differing only in which
 * function/path they name collapse to the same normalized string; this is
 * deliberately an EXACT match on the normalized text, not a fuzzy-similarity
 * score — the observed pattern was templated substitution, not loose
 * paraphrasing, so exact-after-normalization catches it without pulling in a
 * similarity library to solve a problem that hasn't been observed.
 */
function normalizeRationaleTemplate(rationale) {
  return (rationale || '')
    .toLowerCase()
    .replace(/`[^`]*`/g, '‹id›')
    .replace(/\b[\w./-]*[_./][\w./-]*\b/g, '‹id›')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Group this batch's out-of-scope deferrals by normalized rationale template,
 * across ALL files (not scoped to one same-file cluster — a template split
 * across files is exactly the case this exists to catch). Returns clusters
 * at or above `threshold`.
 *
 * @param {object[]} deferredEntries - ledger entries with `ruling: 'defer'`
 * @param {{threshold?: number}} [opts]
 * @returns {Array<{template: string, count: number, topicIds: string[]}>}
 */
function detectTemplateRationales(deferredEntries, { threshold = TEMPLATE_RATIONALE_THRESHOLD } = {}) {
  const byTemplate = new Map();
  for (const entry of deferredEntries) {
    const template = normalizeRationaleTemplate(entry.rulingRationale);
    if (template.length < MIN_TEMPLATE_LENGTH) continue;
    if (!byTemplate.has(template)) byTemplate.set(template, []);
    byTemplate.get(template).push(entry.topicId);
  }
  const clusters = [];
  for (const [template, topicIds] of byTemplate.entries()) {
    if (topicIds.length < threshold) continue;
    clusters.push({ template, count: topicIds.length, topicIds });
  }
  return clusters;
}

/**
 * Build debt entries from all deferred ledger entries.
 * Returns { built, skipped } where built has { entry, sensitivity, redactions }.
 */
function buildEntries(deferredEntries, reason, sid, args) {
  const built = [];
  const skipped = [];

  for (const ledgerEntry of deferredEntries) {
    const finding = ledgerEntryToFinding(ledgerEntry);
    const captureArgs = {
      deferredReason:    reason,
      deferredRationale: ensureRationaleLength(ledgerEntry.rulingRationale, ledgerEntry.category),
      deferredRun:       sid,
      blockedBy:         args.blockedBy,
      followupPr:        args.followupPr,
      approver:          args.approver,
      approvedAt:        args.approvedAt,
      policyRef:         args.policyRef,
      reviewDeadline:    args.reviewDeadline,
    };

    try {
      const { entry, sensitivity, redactions } = buildDebtEntry(finding, captureArgs);
      built.push({ entry, sensitivity, redactions, topicId: ledgerEntry.topicId });
    } catch (err) {
      skipped.push({ topicId: ledgerEntry.topicId, reason: err.message });
      process.stderr.write(`  [auto-capture] Skipped ${ledgerEntry.topicId}: ${err.message.slice(0, 120)}\n`);
    }
  }

  return { built, skipped };
}

// ── Cloud sync ───────────────────────────────────────────────────────────────

/**
 * Sync entries to Supabase via the durable-write seam (`debt.entries` in
 * `scripts/lib/audit-store-writers.mjs`) — a failed upsert spills to
 * `.audit/write-spill/` for a later `cross-skill.mjs write-spill drain`
 * instead of being silently dropped (2026-08-27: a consumer's cloud mirror
 * had drifted 31 entries behind its local ledger with no way to recover
 * them).
 *
 * **Routed through `persistDebtEntries` (docs/plans/
 * debt-ledger-persisted-record-contract.md §2 Fix C), not a standalone
 * `writeDebtEntries` + `durableWrite` pair** — this file used to call both
 * separately, which meant this, the PRIMARY real-world capture path (Step
 * 3.6 of every audit round), never ran through `enrichDebtEntriesWithAliases`
 * at all: only `debt-backfill.mjs --promote` (a rare, one-off historical
 * import) went through the facade. Fix C's content-aliasing would have been
 * functionally dead on the path it was built for. `persistDebtEntries`
 * already does both writes (local first, then cloud) in one call, so this is
 * a straight replacement, not new plumbing.
 *
 * @param {object} debtContext - from resolveDebtContext()
 * @param {object[]} entries
 * @returns {Promise<{inserted:number, updated:number, total:number, rejected:object[], cloudOutcome:string, cloudMirrored:boolean}>}
 */
async function persistCapturedEntries(debtContext, entries) {
  // No `ledgerPath` option here — `persistDebtEntries` defaults to
  // `DEFAULT_DEBT_LEDGER_PATH` (`.audit/tech-debt.json`), the DEBT ledger.
  // `main()`'s own `ledgerPath` variable names the ROUND/adjudication ledger
  // (`--ledger <path>`, e.g. an audit round's `sid-ledger.json`) — a
  // completely different file that happens to share the variable name.
  // Passing it here was a real bug caught by this file's own test suite: it
  // silently wrote debt entries INTO the round ledger instead of the debt
  // ledger, corrupting the former and leaving the latter never created.
  return persistDebtEntries(debtContext, entries);
}

// ── Capture-trail check ─────────────────────────────────────────────────────

/**
 * After a successful write, re-scan every round ledger in the same directory
 * as the one just processed (including it — its entries should now resolve)
 * for `ruling: 'defer'` entries with no matching debt-ledger entry. Advisory
 * only: the CURRENT invocation already succeeded, so this never changes the
 * exit code — it exists so a gap from an EARLIER, forgotten invocation
 * surfaces the very next time this command runs at all, rather than staying
 * invisible until someone separately remembers to run
 * `debt-capture-trail-check.mjs` (round-3, gap #2 of the 2026-08-27 report:
 * 517 defer rulings across 11 days went uncaptured with no run of THIS
 * command to ever notice — reading round ledgers here closes that even when
 * nobody runs the standalone maintenance check either).
 *
 * @param {string} justProcessedLedgerPath
 * @returns {{deferredTotal: number, uncaptured: object[], corruptLedgers: object[]}|null} null on any read failure — never fatal
 */
function checkCaptureTrail(justProcessedLedgerPath) {
  try {
    const auditDir = path.dirname(justProcessedLedgerPath);
    const roundLedgers = findRoundLedgers(auditDir).map(readDeferredEntries);
    const debtLedgerPath = path.resolve(DEFAULT_DEBT_LEDGER_PATH);
    const debtIdentities = fs.existsSync(debtLedgerPath)
      ? collectDebtIdentities(readDebtLedger({ events: [] }).entries)
      : new Set();
    return findUncapturedDeferrals({ roundLedgers, debtIdentities });
  } catch {
    return null; // advisory — a read failure here must not affect this run's own result
  }
}

// ── Summary card ─────────────────────────────────────────────────────────────

function cloudSyncLabel(cloudSync) {
  if (cloudSync === null) return 'skipped (no Supabase)';
  switch (cloudSync.outcome) {
    case 'written': return 'ok';
    case 'skipped': return `skipped (${cloudSync.error || 'declined'})`;
    case 'spilled': return `failed — queued for retry via \`write-spill drain\` (${cloudSync.error || 'unknown'})`;
    case 'lost': return `failed — NOT queued for retry (${cloudSync.error || 'unknown'})`;
    default: return `unrecognised outcome: ${cloudSync.outcome}`;
  }
}

function printSummary({ built, skipped, result, reason, sid, cloudSync, trail, sameFileBatches = [], templateBatches = [] }) {
  const sensitive = built.filter(b => b.sensitivity.sensitive).length;
  const totalRedactions = built.reduce((n, b) => n + b.redactions.length, 0);
  const skippedLine = skipped.length > 0 ? `\n  Skipped:  ${skipped.length} (see stderr)` : '';
  const rejectedSuffix = result.rejected.length > 0 ? ` | Rejected: ${result.rejected.length}` : '';
  const redactionSuffix = totalRedactions > 0 ? ` (${totalRedactions} field redactions)` : '';

  console.log([
    '═══════════════════════════════════════',
    '  DEBT CAPTURE — Auto (Step 3.6)',
    `  Deferred: ${built.length} entries (reason: ${reason})${skippedLine}`,
    `  Inserted: ${result.inserted} | Updated: ${result.updated}${rejectedSuffix}`,
    `  Sensitive (redacted): ${sensitive}${redactionSuffix}`,
    `  Total ledger: ${result.total} entries`,
    `  Cloud sync: ${cloudSyncLabel(cloudSync)}`,
    `  Run SID: ${sid}`,
    '═══════════════════════════════════════',
  ].join('\n'));

  if (result.rejected.length > 0) {
    console.log('\nRejected entries:');
    for (const r of result.rejected) {
      console.log(`  [${r.entry?.topicId || '?'}] ${r.reason?.slice(0, 300)}`);
    }
  }

  // Advisory — never changes this run's own exit code (see checkCaptureTrail).
  // A non-zero uncaptured count here almost always means an EARLIER round's
  // debt-auto-capture invocation never ran at all, not this one.
  if (trail && trail.uncaptured.length > 0) {
    console.warn(`\nWARN: ${trail.uncaptured.length} deferred entr${trail.uncaptured.length === 1 ? 'y' : 'ies'} from other round ledger(s) in this directory ${trail.uncaptured.length === 1 ? 'is' : 'are'} still uncaptured:`);
    for (const u of trail.uncaptured) {
      console.warn(`  [${u.topicId}] ${u.severity || 'unknown'} — from ${u.ledgerPath}`);
    }
    console.warn('  Recapture with: node scripts/debt-auto-capture.mjs --ledger <round-ledger-path> --run <sid>');
  }
  if (trail && trail.corruptLedgers.length > 0) {
    console.warn(`\nWARN: ${trail.corruptLedgers.length} round ledger(s) could not be parsed — capture status unverifiable:`);
    for (const c of trail.corruptLedgers) console.warn(`  ${c.path} — ${c.error}`);
  }

  // Same-file-batch nudge — advisory, never changes the exit code (same
  // posture as the capture-trail WARN above). `inDiff === true` means
  // `--changed` confirmed the file is in this change's diff (assertive
  // wording); `inDiff === null` means no `--changed` was given (hedged —
  // this is a proxy signal, not a diff-membership claim).
  for (const b of sameFileBatches) {
    const claim = b.inDiff === true
      ? `is in your diff`
      : `may be in your diff — verify before trusting the independence claims`;
    console.warn(
      `\nWARN: ${b.count} out-of-scope defers in this batch cite ${b.file}, which ${claim}. `
      + 'Before trusting the independence rationale on each, see AGENTS.md\'s "Scope is decided '
      + 'by impact, not authorship" — a call-graph-only independence claim is not sufficient when '
      + 'the finding shares a column/constraint or a transaction with the new code.'
    );
  }

  // Same-file count catches co-location; this catches the sharper tell —
  // near-identical PHRASING, which fires even when a batch is split across
  // files or rounds to duck the count above.
  for (const t of templateBatches) {
    console.warn(
      `\nWARN: ${t.count} out-of-scope defers in this batch share near-identical rationale wording `
      + `(differing only in which function/path each names) — topics: ${t.topicIds.join(', ')}. `
      + 'A templated excuse repeated across findings is rarely genuine per-finding reasoning; '
      + 'check each one actually states the two-part independence test, not a copy-pasted line.'
    );
  }

  // Name the incompleteness in the operator's own words, right next to the
  // exit code that now carries it. Re-running after fixing the cause is safe:
  // writeDebtEntries upserts by topicId, so already-captured entries update in
  // place rather than duplicating.
  const missed = result.rejected.length + skipped.length;
  if (missed > 0) {
    const noun = missed === 1 ? 'entry' : 'entries';
    console.error(
      `\nPARTIAL CAPTURE: ${missed} of ${built.length + skipped.length} deferred ${noun} `
      + 'did NOT reach the debt ledger, and will therefore NOT be suppressed in future '
      + 'audits. Fix the cause above and re-run the same command (capture is idempotent).',
    );
  }
}

// ── Supersession (§2 Fix D) ──────────────────────────────────────────────────

/**
 * Resolve the debt-event context (cloud when configured + the repo resolves,
 * else local) — the ONE resolution this file uses for both the main capture
 * write and `--supersedes`, so the two always agree about where debt lives.
 */
async function resolveDebtContext() {
  try {
    if (!await isCloudEnabled()) return selectDebtEventSource({ cloudEnabled: false });
    await initLearningStore();
    const profile = generateRepoProfile();
    const ref = await resolveRepoForStore({ profile });
    const repoId = ref?.repoRowId ?? null;
    return selectDebtEventSource({ repoId, cloudEnabled: repoId != null });
  } catch {
    return selectDebtEventSource({ cloudEnabled: false });
  }
}

/**
 * `--supersedes <old> --supersedes-with <new>` (docs/plans/
 * debt-ledger-persisted-record-contract.md §2 Fix D). Non-fatal to the
 * capture that already happened — printed as a WARN, never changes this
 * run's exit code, mirroring `checkCaptureTrail`'s own advisory convention
 * in this file.
 */
async function runSupersedeIfRequested(args) {
  if (!args.supersedes || !args.supersedesWith) return;
  const context = await resolveDebtContext();
  const { local, cloud } = await markDebtSuperseded(context, args.supersedes, args.supersedesWith);
  console.log([
    '',
    '─── Supersession ───',
    `  ${args.supersedes} -> superseded by ${args.supersedesWith}`,
    `  Local: ${local.applied ? 'ok' : `failed (${local.error})`}`,
    `  Cloud: ${cloud.applied ? 'ok' : `not applied (${cloud.error})`}`,
  ].join('\n'));
  if (!local.applied) {
    console.warn(`\nWARN: supersession did not apply locally (${local.error}) — the debt capture above still succeeded.`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) { usage(); return; }

  if (!args.ledger) {
    console.error('Error: --ledger <path> is required');
    usage();
    process.exit(1);
  }

  const ledgerPath = path.resolve(args.ledger);
  if (!fs.existsSync(ledgerPath)) {
    console.error(`Error: ledger not found: ${ledgerPath}`);
    process.exit(1);
  }

  const reasonError = validateReasonFields(args);
  if (reasonError) {
    console.error(`Error: ${reasonError}`);
    process.exit(1);
  }
  const supersedesError = validateSupersedesFields(args);
  if (supersedesError) {
    console.error(`Error: ${supersedesError}`);
    process.exit(1);
  }

  let adjLedger;
  try {
    adjLedger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
  } catch (err) {
    console.error(`Error: failed to parse ledger: ${err.message}`);
    process.exit(1);
  }

  if (!adjLedger || !Array.isArray(adjLedger.entries)) {
    console.error('Error: ledger has no entries array');
    process.exit(1);
  }

  const deferredEntries = adjLedger.entries.filter(e => e.ruling === 'defer');
  if (deferredEntries.length === 0) {
    console.log('No deferred entries in ledger — nothing to capture.');
    return;
  }

  const sid = args.run || `auto-capture-${Date.now()}`;
  const reason = args.reason;

  // Same-file-batch nudge — only meaningful for the default out-of-scope
  // reason; the other four deferredReason values aren't about the
  // independence test this nudge exists to catch.
  const changedFiles = args.changed ? args.changed.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const sameFileBatches = reason === 'out-of-scope'
    ? detectSameFileBatchDefers(deferredEntries, { changedFiles })
    : [];
  const templateBatches = reason === 'out-of-scope'
    ? detectTemplateRationales(deferredEntries)
    : [];

  if (args.dryRun) {
    console.log(`\n[DRY RUN] Would capture ${deferredEntries.length} deferred entries:`);
    for (const e of deferredEntries) {
      console.log(`  [${e.topicId}] ${e.severity} — ${e.category}: ${(e.detailSnapshot || '').slice(0, 80)}`);
    }
    console.log(`  deferredReason: ${reason} | run: ${sid}`);
    return;
  }

  const { built, skipped } = buildEntries(deferredEntries, reason, sid, args);

  if (built.length === 0) {
    console.error(`All ${deferredEntries.length} entries failed to build. Check stderr for details.`);
    process.exit(1);
  }

  const entries = built.map(b => b.entry);

  const debtContext = await resolveDebtContext();
  let result;
  try {
    result = await persistCapturedEntries(debtContext, entries);
  } catch (err) {
    console.error(`Error writing debt ledger: ${err.message}`);
    process.exit(1);
  }

  const cloudSync = { outcome: result.cloudOutcome, error: result.cloudOutcomeError };
  const trail = checkCaptureTrail(ledgerPath);

  printSummary({ built, skipped, result, reason, sid, cloudSync, trail, sameFileBatches, templateBatches });

  await runSupersedeIfRequested(args);

  // ANY entry that failed to land makes this a partial capture, not a success.
  // Previously only an ALL-rejected run exited non-zero, so a run that dropped
  // SOME deferrals reported success to `$?` while its own summary card said
  // otherwise — the card is read by a human, the exit code by everything else.
  //
  // `finishAndExit`, not a bare `process.exit` — the new `--supersedes`
  // summary (runSupersedeIfRequested, above) writes to stdout, and on
  // Windows a piped stdout is asynchronous, so an unawaited exit can drop
  // whatever has not flushed yet.
  if (result.rejected.length > 0 || skipped.length > 0) {
    await finishAndExit(1);
    return;
  }
}

try {
  await main();
} catch (err) {
  console.error(`debt-auto-capture failed: ${err.message}`);
  process.exit(1);
}
