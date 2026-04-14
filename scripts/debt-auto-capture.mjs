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
 * Usage:
 *   node scripts/debt-auto-capture.mjs --ledger <path>
 *   node scripts/debt-auto-capture.mjs --ledger <path> --reason blocked-by --blocked-by "owner/repo#123"
 *   node scripts/debt-auto-capture.mjs --ledger <path> --dry-run
 *   node scripts/debt-auto-capture.mjs --ledger <path> --run <SID>
 *
 * Exit codes:
 *   0 — success (including "0 deferred entries found")
 *   1 — missing required args, ledger not found, or write failure
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { buildDebtEntry } from './lib/debt-capture.mjs';
import { writeDebtEntries } from './lib/debt-ledger.mjs';
import { upsertRepo, upsertDebtEntries, initLearningStore } from './learning-store.mjs';
import { generateRepoProfile } from './lib/context.mjs';

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
    run: null,                  // SID override; defaults to timestamp
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--ledger':       args.ledger      = argv[++i]; break;
      case '--reason':       args.reason      = argv[++i]; break;
      case '--blocked-by':   args.blockedBy   = argv[++i]; break;
      case '--followup-pr':  args.followupPr  = argv[++i]; break;
      case '--approver':     args.approver    = argv[++i]; break;
      case '--approved-at':  args.approvedAt  = argv[++i]; break;
      case '--policy-ref':   args.policyRef   = argv[++i]; break;
      case '--run':          args.run         = argv[++i]; break;
      case '--dry-run':      args.dryRun      = true;      break;
      case '--help': case '-h': args.help     = true;      break;
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
  --run <SID>            Session ID stamp (default: auto-generated)
  --dry-run              Print what would be captured, but do not write
  --help                 Show this message
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
 * Sync entries to Supabase. Returns true on success, false on failure,
 * null when Supabase is not configured.
 * Non-blocking — callers must not fail on a false return.
 */
async function syncToCloud(entries) {
  try {
    await initLearningStore();
    const profile = generateRepoProfile();
    const repoName = path.basename(process.cwd());
    const repoId = await upsertRepo(profile, repoName);
    if (!repoId) return null;
    const { ok } = await upsertDebtEntries(repoId, entries);
    return ok;
  } catch {
    return false;
  }
}

// ── Summary card ─────────────────────────────────────────────────────────────

function cloudSyncLabel(cloudOk) {
  if (cloudOk === null) return 'skipped (no Supabase)';
  return cloudOk ? 'ok' : 'failed (non-blocking)';
}

function printSummary({ built, skipped, result, reason, sid, cloudOk }) {
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
    `  Cloud sync: ${cloudSyncLabel(cloudOk)}`,
    `  Run SID: ${sid}`,
    '═══════════════════════════════════════',
  ].join('\n'));

  if (result.rejected.length > 0) {
    console.log('\nRejected entries:');
    for (const r of result.rejected) {
      console.log(`  [${r.entry?.topicId || '?'}] ${r.reason?.slice(0, 120)}`);
    }
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

  let result;
  try {
    result = await writeDebtEntries(entries);
  } catch (err) {
    console.error(`Error writing debt ledger: ${err.message}`);
    process.exit(1);
  }

  const cloudOk = await syncToCloud(entries);

  printSummary({ built, skipped, result, reason, sid, cloudOk });

  if (result.rejected.length > 0 && result.rejected.length === built.length) {
    process.exit(1); // All rejected — something systemic is wrong
  }
}

try {
  await main();
} catch (err) {
  console.error(`debt-auto-capture failed: ${err.message}`);
  process.exit(1);
}
