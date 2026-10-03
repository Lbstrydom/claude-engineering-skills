#!/usr/bin/env node
/**
 * @fileoverview Phase D — manual debt-entry resolution CLI.
 *
 * Removes a debt entry from the LOCAL ledger and emits a 'resolved' event
 * to the authoritative event source (cloud or local). Used when an operator
 * confirms the underlying issue has been fixed (typically after a Step 5
 * verification audit surfaces the resolve prompt).
 *
 * `--accept-permanent --approver <who>` is the OTHER disposition: the finding
 * is real but deliberately not being fixed. Deleting that row would drop it
 * from debt memory, so the next audit re-raises it from scratch (a lock-bypass
 * finding was re-raised 7+ times that way). Instead the entry is upserted IN
 * PLACE to `deferredReason: accepted-permanent` (approver + approvedAt are
 * required by the schema), keeping its suppression; the prior deferral text is
 * preserved beneath the new rationale. No event is written - the entry's own
 * approver/approvedAt/rationale are the record, and the event enum has no
 * "accepted" kind.
 *
 * Exit codes (matching the Phase D CLI contract):
 *   0 - success
 *   1 - operational error (missing topicId, corrupt ledger, IO failure)
 *   2 - policy failure (entry not found, lock contention)
 *   3 - sensitivity gate (not used here — reserved)
 *
 * Usage:
 *   node scripts/debt-resolve.mjs <topicId> --rationale "<text>" [--run-id <id>]
 *                                          [--ledger <path>] [--events <path>]
 *                                          [--no-cloud]
 *   node scripts/debt-resolve.mjs <topicId> --accept-permanent --approver "<who>"
 *                                          --rationale "<text>" [--ledger <path>]
 *                                          [--no-cloud]
 *
 * @module scripts/debt-resolve
 */

// Load .env without the banner (keeps CLI stdout clean for JSON output)
import './lib/load-env.mjs';
import { initLearningStore, isCloudEnabled, resolveRepoForStore } from './learning-store.mjs';
import { selectEventSource, removeDebt, appendEvents, persistDebtEntries } from './lib/debt-memory.mjs';
import { readDebtLedger, DEFAULT_DEBT_LEDGER_PATH } from './lib/debt-ledger.mjs';
import { DEFAULT_DEBT_EVENTS_PATH } from './lib/debt-events.mjs';
import { generateRepoProfile } from './lib/context.mjs';
import { hasFlag, finishAndExit } from './lib/cli-io.mjs';
import fs from 'node:fs';
import path from 'node:path';

// Schema caps (scripts/lib/schemas.mjs DebtEntryPersistedFields): rationale 4000, approver 120.
const MAX_RATIONALE = 4000;
const MAX_APPROVER = 120;

function parseArgs(argv) {
  const args = argv.slice(2);
  // Positional topicId is the first non-flag token
  const first = args[0];
  const topicId = first && !first.startsWith('--') && !first.startsWith('-') ? first : null;
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1] : null;
  };
  return {
    topicId,
    rationale: get('--rationale'),
    runId: get('--run-id') || `resolve-${Date.now()}`,
    ledgerPath: get('--ledger') || DEFAULT_DEBT_LEDGER_PATH,
    eventsPath: get('--events') || DEFAULT_DEBT_EVENTS_PATH,
    noCloud: hasFlag('no-cloud'),
    acceptPermanent: hasFlag('accept-permanent'),
    approver: get('--approver'),
    help: hasFlag('help', { short: 'h' }),
  };
}

function printUsage() {
  console.error(`Usage: node scripts/debt-resolve.mjs <topicId> --rationale "<text>" [options]

Remove a debt entry and log a 'resolved' event - or, with --accept-permanent, keep
it as an approved permanent acceptance (the finding is real but deliberately not
being fixed; keeps it in debt memory so audits do not re-raise it).

Required:
  <topicId>              Entry topicId to resolve (8-char hex)
  --rationale "<text>"   Why this was resolved (>= 20 chars)

Options:
  --run-id <id>          Attribution for the event (default: resolve-<timestamp>)
  --ledger <path>        Debt ledger path (default: .audit/tech-debt.json)
  --events <path>        Local event log path (default: .audit/local/debt-events.jsonl)
  --no-cloud             Skip cloud mirror, local-only resolve
  --accept-permanent     Upsert the entry to deferredReason=accepted-permanent instead
                         of removing it (requires --approver; writes no event)
  --approver "<who>"     Who approved the permanent acceptance (recorded on the entry)

Exit codes: 0=ok, 1=op-error, 2=not-found or lock-contention
`);
}

/**
 * Build the upserted entry for an in-place permanent acceptance. Pure: the
 * caller supplies `now`. Takes the RAW persisted row (not the derived view
 * `readDebtLedger` returns) so no derived field is written back.
 * @param {object} raw persisted ledger row
 * @param {{rationale: string, approver: string}} opts
 * @param {string} now ISO timestamp
 */
function buildAcceptedPermanentEntry(raw, { rationale, approver }, now) {
  const prior = raw.deferredRationale
    ? `\n--\nPrior deferral (${raw.deferredReason}): ${raw.deferredRationale}`
    : '';
  return {
    ...raw,
    deferredReason: 'accepted-permanent',
    approver,
    approvedAt: now,
    deferredRationale: `${rationale}${prior}`.slice(0, MAX_RATIONALE),
  };
}

async function acceptPermanent(ctx, opts, entry) {
  if (!opts.approver || opts.approver.trim().length === 0) {
    console.error('Error: --accept-permanent requires --approver "<who>"');
    process.exit(1);
  }
  if (opts.approver.length > MAX_APPROVER) {
    console.error(`Error: --approver must be <= ${MAX_APPROVER} chars (got ${opts.approver.length})`);
    process.exit(1);
  }
  if (opts.rationale.length > MAX_RATIONALE) {
    console.error(`Error: --rationale must be <= ${MAX_RATIONALE} chars (got ${opts.rationale.length})`);
    process.exit(1);
  }
  // The raw row, not readDebtLedger's view: persisting a derived view would
  // write recurrence metrics back into the ledger.
  const raw = JSON.parse(fs.readFileSync(path.resolve(opts.ledgerPath), 'utf-8')).entries
    .find((e) => e.topicId === entry.topicId);
  const updated = buildAcceptedPermanentEntry(raw, opts, new Date().toISOString());

  process.stderr.write(`  [debt-resolve] Accepting ${opts.topicId} as permanent (${raw.deferredReason} -> accepted-permanent): ${entry.category || 'unknown category'}\n`);
  let result;
  try {
    result = await persistDebtEntries(ctx, [updated], { ledgerPath: opts.ledgerPath });
  } catch (err) {
    console.error(`Error: failed to update entry: ${err.message}`);
    process.exit(err.message.includes('lock') ? 2 : 1);
  }
  if (result.rejected?.length) {
    console.error(`Error: entry rejected by schema: ${result.rejected[0].reason}`);
    process.exit(1);
  }
  if (result.updated !== 1) {
    console.error(`Error: entry ${opts.topicId} not updated in local ledger`);
    process.exit(1);
  }
  console.log(JSON.stringify({
    ok: true,
    topicId: opts.topicId,
    action: 'accepted-permanent',
    updatedLocal: true,
    cloudOutcome: result.cloudOutcome,
  }));
  process.stderr.write(`  [debt-resolve] accepted-permanent topicId=${opts.topicId} approver=${opts.approver} cloud=${result.cloudOutcome}\n`);
  await finishAndExit(0);
}

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.help || !opts.topicId) {
    printUsage();
    process.exit(opts.help ? 0 : 1);
  }
  if (!opts.rationale) {
    console.error('Error: --rationale is required');
    printUsage();
    process.exit(1);
  }
  if (opts.rationale.length < 20) {
    console.error(`Error: --rationale must be >= 20 chars (got ${opts.rationale.length})`);
    process.exit(1);
  }

  // Initialize cloud (optional)
  let repoId = null;
  if (!opts.noCloud) {
    await initLearningStore().catch(() => {});
    if (await isCloudEnabled()) {
      const profile = generateRepoProfile();
      // Cluster A (§2.1): stable repo_uuid identity, not the volatile fingerprint.
      const ref = await resolveRepoForStore({ profile }).catch(() => null);
      repoId = ref?.repoRowId ?? null;
    }
  }

  // repoId is only set inside the `await isCloudEnabled()` block above, so a
  // non-null repoId is itself proof that cloud is on and resolved.
  const ctx = selectEventSource({ repoId, cloudEnabled: repoId != null });

  // Verify entry exists
  const ledger = readDebtLedger({ ledgerPath: opts.ledgerPath, events: [] });
  const entry = ledger.entries.find(e => e.topicId === opts.topicId);
  if (!entry) {
    console.error(`Error: no debt entry with topicId "${opts.topicId}" in ${opts.ledgerPath}`);
    process.exit(2);
  }

  if (opts.acceptPermanent) {
    await acceptPermanent(ctx, opts, entry);
    return;
  }

  process.stderr.write(`  [debt-resolve] Resolving ${opts.topicId}: ${entry.category || 'unknown category'}\n`);

  // Emit 'resolved' event BEFORE removing (preserves history if remove fails)
  const eventResult = await appendEvents(ctx, [{
    ts: new Date().toISOString(),
    runId: opts.runId,
    topicId: opts.topicId,
    event: 'resolved',
    resolutionRationale: opts.rationale,
    resolvedBy: opts.runId,
  }], { eventsPath: opts.eventsPath });

  // Remove entry from both local ledger + cloud mirror
  let removed;
  try {
    removed = await removeDebt(ctx, opts.topicId, { ledgerPath: opts.ledgerPath });
  } catch (err) {
    console.error(`Error: failed to remove entry: ${err.message}`);
    if (err.message.includes('lock')) process.exit(2);
    process.exit(1);
  }

  if (!removed.removedLocal) {
    console.error(`Error: entry ${opts.topicId} not removed from local ledger`);
    process.exit(1);
  }

  // Summary
  console.log(JSON.stringify({
    ok: true,
    topicId: opts.topicId,
    removedLocal: removed.removedLocal,
    removedCloud: removed.removedCloud,
    eventWritten: eventResult.written > 0,
    eventSource: eventResult.source,
  }));
  process.stderr.write(`  [debt-resolve] ✓ resolved topicId=${opts.topicId} local=${removed.removedLocal} cloud=${removed.removedCloud}\n`);
  process.exit(0);
}

main().catch(err => {
  console.error('Unhandled error:', err.message);
  process.exit(1);
});
