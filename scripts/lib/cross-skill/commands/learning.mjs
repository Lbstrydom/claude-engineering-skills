/**
 * @fileoverview Adaptive-learning registry commands (docs/plans/cross-skill-command-registry.md
 * — Cluster D, Phase 5). `learning-record` itself lives in `misc.mjs` (it
 * migrated with the Cluster B writers); this module holds the readers and the
 * sub-CLI wrappers.
 *
 * Most of these are `portExempt` **wrappers**: they hand control to a
 * self-contained sub-CLI (`scripts/learning/*.mjs`) that imports its own
 * stores. The store-call goldens cannot intercept those, and the plan says so
 * rather than pretending otherwise (D5b coverage boundary, pattern 3).
 */
import { CommandError } from '../dispatch.mjs';

/**
 * `learning-stats` — decision/cluster counts for a repo.
 *
 * The CLI (not the pure lib) owns the `LEARNING_REPO_NAME` env fallback. That
 * variable must be the `owner/repo` SLUG: a bare repo name silently misses the
 * `audit_repos.name` lookup, which is how weekly-review sat broken for weeks
 * in every consumer — hence `unknownRepo` being its own reported state rather
 * than an empty stats object.
 */
export async function learningStatsCmd(ctx) {
  const p = ctx.payload();
  const { getLearningStats } = await import('../../learning/stats.mjs');
  const r = await getLearningStats({
    repoId: p.repoId || null,
    repoName: p.repoName || process.env.LEARNING_REPO_NAME || null,
  });
  if (!r.cloud) return { ok: true, cloud: false, stats: null };
  if (!r.stats) return { ok: true, cloud: true, repoId: null, stats: { unknownRepo: true } };
  return { ok: true, cloud: true, repoId: r.repoId, repoName: r.repoName, stats: r.stats };
}

/** `learning-weekly-review` — wrapper over scripts/learning/weekly-review.mjs. */
export async function learningWeeklyReviewCmd(ctx) {
  const { runWeeklyReview } = await import('../../../learning/weekly-review.mjs');
  const res = await runWeeklyReview({
    repoName: ctx.flag('repo') || process.env.LEARNING_REPO_NAME || null,
    dryRun: ctx.hasFlag('dry-run'),
    format: ctx.flag('format') || 'json',
  });
  // §2b F3/F4. This forwarded the sub-command's result VERBATIM, so its
  // `{ok:false, error:{code:'BAD_INPUT'}}` for an unresolvable repoName reached
  // the operator at EXIT 0 — the last `ok:false at exit 0` left in the captured
  // set, and the one that would have made F4's invariant unenforceable. A
  // forwarded refusal is still a refusal: the sub-command's own code and
  // message are preserved, only the exit code is corrected.
  //
  // LEARNING_REPO_NAME must be the `owner/repo` slug; a bare repo name misses
  // the lookup silently, which is how weekly-review sat broken for weeks in
  // every consumer. Exiting 0 on that is what let it stay unnoticed.
  if (res && res.ok === false) {
    throw new CommandError(res.error?.code || 'BAD_INPUT',
      res.error?.message || 'weekly review failed', { forwarded: res });
  }
  return res;
}

/**
 * `learning-backfill-outcomes` — wrapper over scripts/learning/backfill-outcomes.mjs.
 *
 * `--repo` is accepted as well as `--repo-id`: the two entry points to
 * runBackfill disagreed on the spelling, so `--repo X` passed the global flag
 * guard, resolved to null, and ran the backfill UNSCOPED — silently wrong
 * scope on a mutating command. The standalone CLI has always mapped `--repo`
 * to repoId, so this makes the two agree rather than inventing a third
 * convention.
 */
export async function learningBackfillOutcomesCmd(ctx) {
  const { runBackfill } = await import('../../../learning/backfill-outcomes.mjs');
  return runBackfill({
    repoId: ctx.flag('repo-id') || ctx.flag('repo') || null,
    dryRun: ctx.hasFlag('dry-run'),
    skipDrain: ctx.hasFlag('skip-drain'),
    skipResolve: ctx.hasFlag('skip-resolve'),
    rebuildStats: ctx.hasFlag('rebuild-stats'),
  });
}

/**
 * `learning-quickfix-stats` — the pattern-effectiveness cache.
 *
 * An unrecognised `--action` used to fall through to the stats reader, so a
 * typo'd `--action rebuidl` printed a successful stats card and exited 0 —
 * reporting success for a command that never ran. Both the retired bootstrap
 * path and a failed cloud rebuild are typed errors with non-zero exits, so an
 * automation consumer checking only the exit code cannot read "did nothing"
 * as "rebuilt".
 */
export async function learningQuickfixStatsCmd(ctx) {
  const mod = await import('../../learning/quickfix-stats.mjs');
  const action = ctx.flag('action') || 'stats';
  const repoId = ctx.flag('repo-id') || null;
  if (action !== 'rebuild' && action !== 'stats') {
    throw new CommandError('BAD_INPUT',
      `unknown --action "${action}" for learning-quickfix-stats; expected "rebuild" or "stats"`, { action });
  }
  if (action === 'rebuild') {
    if (ctx.hasFlag('bootstrap')) {
      const result = await mod.rebuildFromBootstrap();
      throw new CommandError('BOOTSTRAP_RETIRED',
        'the bootstrap rebuild is retired and writes nothing; outcome detection is owned by backfill-outcomes',
        { action: 'rebuild', mode: 'bootstrap', hint: result.hint, retiredError: result.error });
    }
    const result = await mod.rebuildFromCloud({ repoId });
    if (!result.ok) {
      // rebuildFromCloud declines to overwrite a good cache on a read failure,
      // so exiting 0 here told an automation consumer "rebuilt" about a run
      // that deliberately wrote nothing.
      throw new CommandError('REBUILD_FAILED',
        `quickfix stats rebuild did not complete: ${result.error}`,
        { action: 'rebuild', mode: 'cloud', ...result });
    }
    return { ok: true, action: 'rebuild', mode: 'cloud', ...result };
  }
  const stats = mod.loadStats();
  const skipMap = {};
  for (const name of Object.keys(stats.patterns || {})) {
    skipMap[name] = mod.shouldSkipPattern(name, stats);
  }
  return {
    ok: true,
    action: 'stats',
    cacheExists: !!stats._generatedAt,
    generatedAt: stats._generatedAt || null,
    patterns: stats.patterns || {},
    wouldSkip: skipMap,
  };
}

/**
 * `learning-replay` — forwards argv to scripts/learning/replay.mjs.
 *
 * `runReplayCli` has ALREADY written stdout by the time it returns, so the
 * success path emits nothing (a second envelope would put two JSON values on
 * one stdout). A failure still needs a non-zero exit, which the thrown
 * CommandError provides.
 */
export async function learningReplayCmd(ctx) {
  const { runReplayCli } = await import('../../../learning/replay.mjs');
  const result = await runReplayCli(ctx.forwardArgs);
  // Legacy emitted a FLAT `{ok:false, error:'<string>'}` on failure (not the
  // `{code, message}` shape the rest of this CLI uses) and exited 1. Both are
  // preserved: the envelope travels verbatim as a forwarder result, and the
  // dispatcher derives exit 1 from its `ok:false`.
  if (result && result.ok === false) return { ok: false, error: result.error || 'replay failed' };
  return undefined; // success: stdout already written by the sub-CLI
}
