/**
 * @fileoverview The sync's end-of-run VERDICT, as lines — the one place that decides what a run is allowed to claim.
 *
 * Extracted from `sync-to-repos.mjs` because the verdict had become two concerns in two files: the counts and the green/amber/red
 * line here, and the UNMEASURED label that `describeUnmeasuredTargets` (lib/sync-base-lag.mjs) now owns. A verdict split across a
 * CLI body and a library is a verdict nobody can read whole, and that file is over the file-size ratchet's governed limit — the
 * same two reasons `describeSafeToCommit` sits in `lib/sync-status.mjs` rather than inline.
 *
 * PURE: takes a tally, returns lines. It prints nothing and reads no globals, so every branch — including the two that must NOT
 * read as success — is assertable without running a sync.
 *
 * @module scripts/lib/sync-run-summary
 */

/**
 * @param {{
 *   dryRun: boolean, targetCount: number, totalSkipped: number, totalErrors: number,
 *   totalNew: number, totalUpdated: number, totalUnchanged: number,
 *   unmeasured: {verdict: string|null, lines: string[]},
 *   hookLines?: string[],
 * }} tally `unmeasured` is `describeUnmeasuredTargets`'s result, already coloured by the caller.
 * @param {{R?: string, G?: string, Y?: string, D?: string, X?: string}} [colors] — ANSI codes, caller's own
 * @returns {string[]}
 */
export function describeRunSummary(tally, { R = '', G = '', Y = '', D = '', X = '' } = {}) {
  const {
    dryRun, targetCount, totalSkipped, totalErrors, totalNew, totalUpdated, totalUnchanged,
    unmeasured, hookLines = [],
  } = tally;
  const out = [];
  if (dryRun) {
    out.push(unmeasured.verdict ?? `${Y}DRY RUN complete${X} — no files written`);
    out.push(`  Would create: ${totalNew}  update: ${totalUpdated}  unchanged: ${totalUnchanged}`);
    out.push(...unmeasured.lines);
    if (totalNew + totalUpdated > 0) out.push(`\nRun without --dry-run to apply.`);
    return out;
  }
  const reached = targetCount - totalSkipped;
  if (totalErrors > 0) {
    out.push(`${R}Sync completed with errors${X}`);
  } else if (reached === 0) {
    // NOT the green line. A run that resolved no target at all propagated nothing, and saying "Sync complete" for it is the false
    // green that hid the worktree-anchoring bug: a push printed success having written to zero consumers (2026-07-30). Still exit
    // 0 — a machine that simply has not checked out the maintainer's consumers is a legitimate state, not an error, and nagging
    // every public cloner on every push would be worse.
    out.push(`${Y}Sync reached no consumer${X} — ${totalSkipped} target(s) skipped, nothing propagated`);
  } else {
    out.push(`${G}Sync complete${X}`);
  }
  out.push(...unmeasured.lines);
  out.push(
    `  Targets: ${reached}/${targetCount} reached`
    + (totalSkipped ? ` (${totalSkipped} skipped)` : '')
    + `  Created: ${totalNew}  Updated: ${totalUpdated}  Unchanged: ${totalUnchanged}  Errors: ${totalErrors}`,
  );
  // Hook-refresh reminder (reference-integrity-gate Cluster C, R2-H3/R16): the pre-push audit hook is versioned and refreshes on
  // `hooks:install`, but sync does not re-install git hooks (opt-in, per-consumer). A consumer running an older hook body picks up
  // the v2 Status-aware plan selection only after a re-install — a strict improvement, never a regression (worst case = today's
  // behaviour). Surfaced, not auto-run, so we never clobber an operator hook.
  //
  // The `--` before `--target` is load-bearing, not style. Without it npm eats `--target` as its own config and forwards the VALUE
  // as a bare positional, which the script ignores — so `hooks:install` written WITHOUT the `--` (the one-token form that
  // `npm-args:gate` refuses, which is why it is described here rather than quoted) silently installs into EVERY consumer repo
  // instead of one. Verified 2026-07-20: the no-`--` form reports both wine-cellar-app and ai-organiser; the `--`
  // form reports only the named repo. Same "silently did more than you asked" family as the unknown-flag gate, which cannot catch
  // it because the flag never reaches argv at all.
  out.push(`  ${D}If a consumer uses the pre-push audit hook, re-run \`npm run hooks:install -- --target <name>\` to pick up bundle hook changes.${X}`);
  // Per consumer, read-only (the effective hook as git resolves it): which ones are actually stale, and the exact command.
  out.push(...hookLines.map((line) => `  ${Y}hook${X}  ${line}`));
  return out;
}
