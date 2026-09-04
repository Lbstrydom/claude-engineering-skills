#!/usr/bin/env node
/**
 * @fileoverview debt-reconcile — bring the machine-local debt cache and the
 * private store back into agreement, without ever losing a finding.
 *
 * **The problem.** `.audit/tech-debt.json` is gitignored, per-machine, and was
 * documented as the source of truth while the private store was called its
 * mirror. The reverse is true, and the drift is real: measured on this repo
 * 2026-09-04, local 106 entries against 136 in the store, overlap 69 — **37
 * entries existed on one disk and nowhere else**, and 67 store entries were
 * invisible to every local reader.
 *
 * **What this does, and deliberately does not.** It pushes local-only entries
 * into the store through the durable-write seam, and it prunes local rows the
 * store has provably closed. It does NOT adjudicate, re-score, or invent
 * events: pushing an already-recorded deferral into the store that should hold
 * it is relocation, not new audit evidence. Stopping data loss and triaging
 * debt are two jobs, and conflating them would fabricate the second.
 *
 * **Safety, in order of how badly each could go wrong:**
 *   1. `--dry-run` is the DEFAULT. `--push` and `--prune-resolved` are explicit.
 *   2. Nothing is ever deleted from the store. The only deletion is local, and
 *      only on positive per-topic evidence (see `debt-reconcile.mjs`'s
 *      `isProvablyResolvedRemotely` — absence is never evidence, and neither is
 *      a stale `resolved` event on a topic that was later reopened).
 *   3. An unavailable snapshot REFUSES to act. Degrading to an empty snapshot
 *      would classify every local entry as an orphan.
 *
 * Exit codes: 0 success (including a clean dry run) · 1 operational error ·
 *             2 unknown flag / refusal to act on an unavailable snapshot.
 *
 * Usage:
 *   node scripts/debt-reconcile.mjs [--push] [--prune-resolved] [--json]
 *                                   [--ledger <path>]
 *
 * Plan: docs/plans/backlog-and-drift-reduction.md §2 A2/A8/A10, Phase 3.
 *
 * @module scripts/debt-reconcile
 */

import './lib/load-env.mjs';

import fs from 'node:fs';
import path from 'node:path';
import { assertKnownFlags, ArgvError, argOption } from './lib/cli-io.mjs';
import { readDebtLedger, removeDebtEntry, DEFAULT_DEBT_LEDGER_PATH } from './lib/debt-ledger.mjs';
import { classifyReconciliation, evaluatePostcondition } from './lib/debt-reconcile.mjs';
import { durableWrite, SPILL_DIR } from './lib/durable-write.mjs';
import './lib/audit-store-writers.mjs'; // side-effecting: the registry's only bootstrap
// Through the barrel, not `lib/store/debt.mjs` directly: `tech-debt -> stores`
// is not a declared edge, and the sibling `debt-memory.mjs` reaches the store
// the same way. Refactor before declaring an edge.
import {
  initLearningStore, isCloudEnabled, resolveRepoForStore, readReconciliationSnapshot,
} from './learning-store.mjs';
import { generateRepoProfile } from './lib/context.mjs';

const KNOWN_FLAGS = [
  '--push', '--prune-resolved', '--json', '--ledger', '--help', '-h',
  '--selfcheck-relocation',
];

function parseArgs(argv) {
  const args = argv.slice(2);
  // `argOption` from cli-io is the repo's single option reader: it handles the
  // `--name=value` form, refuses to swallow a FOLLOWING FLAG as a value
  // (`--ledger --push` used to consume `--push`), and stops at `--`. A
  // hand-rolled `get()` here was a fourth copy of that logic, missing all three.
  const i = args.indexOf('--ledger');
  if (i !== -1 && (args[i + 1] === undefined || args[i + 1].startsWith('-'))) {
    throw new ArgvError('debt-reconcile: --ledger requires a path.');
  }
  return {
    push: args.includes('--push'),
    prune: args.includes('--prune-resolved'),
    jsonMode: args.includes('--json'),
    ledgerPath: argOption('ledger', DEFAULT_DEBT_LEDGER_PATH),
    help: args.includes('--help') || args.includes('-h'),
  };
}

function printUsage() {
  process.stderr.write(`Usage: node scripts/debt-reconcile.mjs [options]

Reconcile the machine-local debt cache (.audit/tech-debt.json) with the private
store. Dry run by default.

Options:
  --push              Push local-only entries into the store (durable-write)
  --prune-resolved    Drop local entries the store has PROVABLY closed
  --ledger <path>     Ledger path (default: ${DEFAULT_DEBT_LEDGER_PATH})
  --json              Machine-readable output
  --help              Show this message

Safety: nothing is ever deleted from the store. A local entry is pruned only
when its topic's LATEST lifecycle event is 'resolved' and postdates the entry —
a later 'reopened', or a resolve older than the entry, keeps it.

Exit codes: 0=ok, 1=operational error, 2=bad flag / refused to act
`);
}

/**
 * Count spill artifacts awaiting a drain — the open loss window (plan R4-M1).
 *
 * Returns `null`, never 0, when the directory cannot be read. An undrained
 * spill is a SOLE LOCAL COPY, so "I could not look" and "the window is empty"
 * are opposite claims; collapsing them into 0 reports the most reassuring
 * possible answer to a question that failed. ENOENT is genuinely zero — the
 * directory only exists once something has spilled.
 */
function countUndrainedSpills() {
  try {
    return fs.readdirSync(SPILL_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.json')).length;
  } catch (err) {
    return err && err.code === 'ENOENT' ? 0 : null;
  }
}

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  let opts;
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'debt-reconcile' });
    opts = parseArgs(process.argv);
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); process.exit(2); }
    throw err;
  }
  if (opts.help) { printUsage(); process.exit(0); }

  // ── Local side ────────────────────────────────────────────────────────────
  let ledger;
  try {
    ledger = readDebtLedger({ ledgerPath: opts.ledgerPath });
  } catch (err) {
    process.stderr.write(`debt-reconcile: corrupt ledger: ${err.message}\n`);
    process.exit(1);
  }
  if (!ledger.available) {
    // Not an error and not a success — there is simply nothing local to
    // reconcile from. Never reported as "in sync".
    // `ok:false`, exactly as the unavailable-SNAPSHOT branch below does. This
    // said ok:true, so the two unverifiable paths disagreed and a machine
    // consumer reading `ok` got a green from one of them — the false-green
    // this plan exists to remove, reintroduced in its own CLI.
    const out = { ok: false, verdict: 'unverifiable', reason: ledger.reason, action: 'none' };
    process.stdout.write(opts.jsonMode ? `${JSON.stringify(out)}\n`
      : `debt-reconcile: UNVERIFIABLE — no local ledger at ${opts.ledgerPath} (${ledger.reason}).\n`
        + '  Nothing was compared. This is not a clean bill of health.\n');
    process.exit(0);
  }

  // ── Store side ────────────────────────────────────────────────────────────
  await initLearningStore();
  let repoId = null;
  if (await isCloudEnabled()) {
    const profile = await generateRepoProfile();
    // `repoRowId`, NOT `repoUuid` — the resolver returns BOTH, and they are
    // different columns: `debt_entries.repo_id` references `audit_repos(id)`,
    // which is `repoRowId`. Passing the uuid yields an authoritative-looking
    // empty result for a repo that was never queried. Same convention as
    // debt-resolve.mjs:96-97 and debt-auto-capture.mjs:231-232.
    const ref = await resolveRepoForStore({ profile }).catch(() => null);
    repoId = ref?.repoRowId ?? null;
  }
  const snapshot = await readReconciliationSnapshot(repoId);
  if (!snapshot.available) {
    const out = {
      ok: false, verdict: 'unverifiable', reason: snapshot.reason, action: 'refused',
      localEntries: ledger.entries.length,
    };
    process.stdout.write(opts.jsonMode ? `${JSON.stringify(out)}\n`
      : `debt-reconcile: REFUSED — store snapshot unavailable (${snapshot.reason}).\n`
        + '  Acting on an empty snapshot would classify every local entry as an orphan.\n');
    process.exit(2);
  }

  const cloudEntries = snapshot.rows.filter((r) => r.hasEntry).map((r) => ({ topicId: r.topicId }));
  const latestEventByTopic = new Map(
    snapshot.rows.filter((r) => r.latestEvent)
      .map((r) => [r.topicId, { event: r.latestEvent, ts: r.latestTs }]),
  );
  const c = classifyReconciliation({
    localEntries: ledger.entries, cloudEntries, latestEventByTopic,
  });

  const result = {
    ok: true,
    verdict: 'measured',
    both: c.both.length,
    localOnly: c.localOnly.length,
    cloudOnly: c.cloudOnly.length,
    locallyResolved: c.locallyResolved.length,
    ambiguous: c.ambiguous.length,
    localTotal: ledger.entries.length,
    cloudTotal: cloudEntries.length,
    undrainedSpills: countUndrainedSpills(),
    pushed: { written: 0, spilled: 0, lost: 0, skipped: 0 },
    pruned: 0,
    dryRun: !opts.push && !opts.prune,
  };

  // ── Push ──────────────────────────────────────────────────────────────────
  if (opts.push && c.localOnly.length > 0) {
    // One durable write per entry so a single bad row cannot strand the batch,
    // and so `spilled` is attributable to the entry that spilled.
    for (const entry of c.localOnly) {
      const r = await durableWrite('debt.entries', { repoId, entries: [entry] });
      result.pushed[r.outcome] = (result.pushed[r.outcome] || 0) + 1;
    }
  }

  // ── Prune ─────────────────────────────────────────────────────────────────
  if (opts.prune && c.locallyResolved.length > 0) {
    for (const entry of c.locallyResolved) {
      const removed = await removeDebtEntry(entry.topicId, { ledgerPath: opts.ledgerPath });
      if (removed) result.pruned += 1;
    }
  }

  // `skipped` counts as still-local. It means the store DECLINED the write
  // (cloud off, or a no-op) — the entry is not there, so excluding it would let
  // a declined push report the orphan as reconciled, which is the same
  // "unasked question renders as good news" defect this whole plan is about.
  // `lost` likewise: evidence was kept, but nothing will replay it.
  const post = evaluatePostcondition({
    localOnly: opts.push
      ? result.pushed.spilled + result.pushed.lost + result.pushed.skipped
      : c.localOnly.length,
    spilled: result.pushed.spilled,
  });
  result.postcondition = post;

  if (opts.jsonMode) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    const lines = [
      `debt-reconcile: local ${result.localTotal} · store ${result.cloudTotal}`,
      `  in both:          ${result.both}`,
      `  local-only:       ${result.localOnly}  ${result.localOnly > 0 ? '← at risk: this machine is the only copy' : ''}`,
      `  store-only:       ${result.cloudOnly}  (invisible to local readers)`,
      `  closed remotely:  ${result.locallyResolved}  (prunable from the local cache)`,
      `  ambiguous:        ${result.ambiguous}  (a resolve exists but does not clearly postdate the entry — pushed, never pruned)`,
      `  undrained spills: ${result.undrainedSpills}`,
    ];
    if (opts.push) {
      lines.push(`  pushed: written ${result.pushed.written} · spilled ${result.pushed.spilled} · lost ${result.pushed.lost} · skipped ${result.pushed.skipped}`);
    }
    if (opts.prune) lines.push(`  pruned locally: ${result.pruned}`);
    if (result.dryRun) {
      lines.push('', '  DRY RUN — nothing written. Re-run with --push to persist local-only entries.');
    } else {
      lines.push('', `  postcondition: ${post.satisfied ? 'satisfied' : 'NOT satisfied'} — ${post.detail}`);
    }
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`debt-reconcile: ${err.stack || err.message}\n`);
  process.exit(1);
});
