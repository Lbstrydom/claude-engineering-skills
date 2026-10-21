/**
 * @fileoverview `fleet handover winddown`: the stage BEFORE `handover prepare` (docs/plans/fleet-handover-winddown.md §2.1).
 *
 * Run by the departing coordinator, from any repo with the bundle, as often as it likes: it doubles as the progress check. It
 * prints (1) the ONE standard directive per repo that needs a coordinator, (2) the measured readiness per repo, (3) the
 * worktrees whose sessions may be archived before the switch, (4) consumer bundles that are behind, and (5) spent one-off
 * scheduled tasks. It is read-only towards repos; its one write is a context SKELETON where none exists (exclusive create).
 *
 * Exit 0 only when every repo is ready, 3 when not, with the same envelope shape as prepare.
 *
 * @module scripts/lib/fleet/handover-winddown-cmd
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeConfigDir, samePath } from '../harness-paths.mjs';
import { ok, refused } from './commands.mjs';
import { BUNDLE_BUDGET_MS, consumerBundleState, syncCommands } from './consumer-bundle.mjs';
import { fleetSupports } from './fleet-capability.mjs';
import { contextHandedOver, contextPath, ensureSkeleton, handoverDirsOf, readContext } from './handover-context.mjs';
import { ARCHIVE_GUARD, renderDirective, safeToArchive, spentOneOffs, winddownReadiness } from './handover-winddown.mjs';
import { collectScheduledTasks, fleetCliFor, isSwitchWait, repoState, resolveRepoScope } from './handover.mjs';
import { repoNeedsCoordination } from './handover-render.mjs';
import { parseSchedulerSnapshot } from './handover-tasks.mjs';
import { quoteArg } from './shell-quote.mjs';
import { UNREGISTERED_BUDGET } from './unregistered.mjs';

/** The source repo's CLI by absolute path: a consumer without `propose` files its proposals there. */
const sourceCli = (sourcePath) => `node ${quoteArg(path.join(sourcePath, 'scripts', 'fleet.mjs'))}`;

export async function cmdWinddown(ctx, flags, { homedir = os.homedir(), bundleState = consumerBundleState, supports = fleetSupports } = {}) {
  const scope = await resolveRepoScope(ctx.cwd, flags['--repo'] ?? []);
  const deadlineAt = Date.now() + UNREGISTERED_BUDGET.handoverMs;
  const keep = new Map();
  const repos = scope.repos.map((r) => repoState(r, { env: ctx.env, now: ctx.now, deadlineAt }, keep));
  const sourcePath = scope.sourceRepo.type === 'resolved' ? scope.sourceRepo.path : null;

  // The skeleton, where a repo needs a coordinator and has no context yet (never overwrites).
  const created = [];
  repos.forEach((r, i) => { if ((i === 0 || repoNeedsCoordination(r)) && ensureSkeleton(r.path) === 'created') created.push(r.path); });
  const contexts = new Map(repos.map((r) => [r.path, readContext(r.path)]));

  // R3: only a registered consumer, and only with the source's MAIN checkout to run the sync's own dry run from.
  const bundles = new Map();
  const bundleEnd = Date.now() + BUNDLE_BUDGET_MS; // one budget for every consumer: a probe gets what is left, and a spent budget is `unknown`, never skipped
  if (sourcePath) for (const c of scope.consumers) { const r = repos.find((x) => samePath(x.path, c.path)); if (r) bundles.set(r.path, { name: c.name, ...bundleState(sourcePath, c.name, { timeoutMs: bundleEnd - Date.now() }) }); }

  const dirs = handoverDirsOf(repos.map((r) => r.path));
  const readiness = winddownReadiness(repos, { contexts, isSwitchWait, bundles, handedOver: (repo, sha) => contextHandedOver(repo, sha, dirs) });

  const safe = {};
  const L = [`fleet handover winddown: ${readiness.ready ? 'READY' : 'NOT READY'} (${repos.length} repo(s))`];
  if (created.length) L.push(`  wrote a context skeleton for: ${created.join(', ')}`);
  for (const [i, r] of repos.entries()) {
    const w = readiness.repos[i];
    L.push('', `${path.basename(r.path)} (${r.path}): ${w.ready ? 'READY' : `NOT READY: ${w.reasons.join('; ')}`}${w.required ? '' : ' (no coordinator needed)'}`);
    if (w.required) L.push(renderDirective({ repo: r.path, cli: r.fleetCli ?? fleetCliFor(r.path), contextFile: contextPath(r.path),
      propose: supports(r.path, r.fleetCli ?? fleetCliFor(r.path), 'propose'), proposeCli: sourcePath ? sourceCli(sourcePath) : 'the source repo\'s fleet CLI' }).split('\n').map((l) => `  ${l}`).join('\n'));
    const b = bundles.get(r.path);
    if (b?.state === 'behind') L.push(`  consumer bundle behind: bring it current from the source repo's MAIN checkout (${sourcePath}) first: ${syncCommands(b.name).join('  then  ')}`);
    const k = keep.get(r.path);
    if (k) {
      const sa = safeToArchive({ worktrees: k.worktrees, items: r.unregistered ?? [], claimedWorktrees: k.claimedWorktrees, partial: r.unregisteredUnknown ?? (r.fleet === 'error' ? r.error : null) });
      safe[r.path] = sa;
      if (!sa.measured) L.push(`  safe to archive: NOT MEASURED (${sa.reason})`);
      else {
        L.push(`  safe to archive before the switch (${sa.safe.length}):${sa.safe.length ? '' : ' none'}`, ...sa.safe.map((x) => `    ${x.path}${x.branch ? ` (${x.branch})` : ''}`));
        for (const x of sa.heldRemotely) L.push(`    held remotely, NOT on base: ${x.path}${x.branch ? ` (${x.branch})` : ''}: removable without loss, but confirm with the user`);
        for (const x of sa.nested) L.push(`    nested worktree: ${x.path} contains ${x.nested.join(', ')}: remove it first`);
      }
    }
  }
  if (repos.some((r) => keep.get(r.path))) L.push('', ...ARCHIVE_GUARD);

  // Spent one-off scheduled tasks: informational (the scheduler is the authority, and the CLI cannot verify a deletion).
  const spent = [];
  if (flags['--scheduler-snapshot'] === undefined) L.push('', 'scheduled tasks not read: pass --scheduler-snapshot <file> (the list_scheduled_tasks answer) to list spent one-offs');
  else {
    let text = null;
    try { text = fs.readFileSync(path.resolve(ctx.cwd, String(flags['--scheduler-snapshot'])), 'utf8'); } catch (e) { L.push('', `scheduled tasks not read: cannot read the snapshot (${e.code ?? e.message})`); }
    const snap = text === null ? null : parseSchedulerSnapshot(text, collectScheduledTasks(claudeConfigDir(ctx.env, { homedir })).map((t) => t.id));
    if (snap && !snap.ok) L.push('', `scheduled tasks not read: ${snap.reason}`);
    else if (snap) {
      spent.push(...spentOneOffs(snap.byId, ctx.now instanceof Date ? ctx.now : new Date()));
      L.push('', spent.length ? `spent one-off scheduled tasks (${spent.length}): retire them in the scheduler (delete_scheduled_task, or update_scheduled_task to disable) so receive does not ask a human to confirm their files:` : 'no spent one-off scheduled tasks in the snapshot',
        ...spent.map((t) => `  ${t.id} (fireAt ${t.fireAt}${t.lastRunAt ? `, ran ${t.lastRunAt}` : ''}${t.enabled ? '' : ', disabled'})`));
    }
  }

  const payload = { winddown: { ready: readiness.ready, repos: readiness.repos, created, spent, safe, bundles: Object.fromEntries([...bundles].map(([p, b]) => [p, b])) }, text: L.join('\n') };
  return readiness.ready ? ok(payload) : refused('wind-down not ready', payload);
}
