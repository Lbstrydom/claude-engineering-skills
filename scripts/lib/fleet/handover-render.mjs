/**
 * @fileoverview Rendering for `fleet handover`: the handover markdown, the coordination prompt, and the receive
 * text. Pure functions of a manifest or a receive result; no I/O (split from handover.mjs to keep each module
 * one job and under the size bound).
 *
 * @module scripts/lib/fleet/handover-render
 */
import path from 'node:path';
import { renderChipPrompt } from './render-train.mjs';
import { quoteArg, renderCommand } from './shell-quote.mjs';
import { RISK_KINDS } from './unregistered.mjs';

/** Does an unregistered item block a handover? A manifest item written before verdicts existed always does. */
export const blocksHandover = (u) => Boolean(u.unknown) || u.blocks !== false;

/** The line a repo whose PR state is unknown gets: what is needed, never a silent "no PRs". */
export const ghUnknownLine = (r) => `PR state unknown in ${r.path ?? r.repo} (${r.gh?.reason ?? 'not queried'}) — sign in to gh with an account that can read ${r.ghRepo ?? "this repo's origin"}`;

// ── rendering ───────────────────────────────────────────────────────────────

/** Repos that need a coordinator: live sessions or unregistered work. */
const reposNeedingCoordination = (m) => m.scope.repos.filter((r) => r.fleet === 'error' || r.sessions.length || r.unregistered?.length || r.unregisteredUnknown);

/**
 * Step 6: ONE coordinator chip per repo with work, each started IN its repo (spawn_task `cwd`) and handed only
 * its own section. Every repo — the one prepare ran in included — gets an explicit cwd, so the prompt means the
 * same thing whichever repo the receiving session was opened in.
 */
function coordinationStep6(m, art) {
  const repos = reposNeedingCoordination(m);
  if (!repos.length) return ['6. No live sessions or unregistered work in any repo — nothing to resume.'];
  const L = ['6. Resume the work — spin out ONE coordinator chip per repo below with spawn_task, using the cwd given (whatever repo you are in):'];
  for (const r of repos) {
    const unmeasured = r.fleet === 'error' || r.unregisteredUnknown ? ' Its state was NOT fully measured at prepare (see the handover): run fleet status first and report what it shows.' : '';
    L.push(`   - cwd "${r.path}", prompt: "You coordinate ${path.basename(r.path)} after an account handover. Read the ${r.path} sections of ${art.md} (Sessions to resume, Unregistered work). Run ${r.fleetCli ?? 'node scripts/.claude-skills/fleet.mjs'} status, spin out one chip per session with its resume prompt, and ask the user about each unregistered worktree before touching it.${unmeasured}"`);
  }
  return L;
}

/**
 * The receive command as a pasteable line. `fleetCommand` is ALREADY shell-rendered (`selfCommand`), so it is used as
 * a prefix, never re-split; only the arguments added here go through the one shell quoter.
 */
export const receiveCommand = (fleetCommand, json, platform = process.platform) => `${fleetCommand} ${renderCommand(['handover', 'receive', '--from', json], platform)}`;

function coordinationPrompt(m, art) {
  return [
    'You are taking over coordination of Claude Code work on this machine from another account.',
    '0. Put every coordinator session in the same permission mode before posting anything to it (a message to a session in another mode is held, not read).',
    `1. Read the handover: ${art.md}`,
    `2. From any repo with the skills bundle, run: ${receiveCommand(m.fleetCommand, art.json)}`,
    '   (in a consumer repo the CLI is node scripts/.claude-skills/fleet.mjs). Exit 1 = a memory file failed; exit 3 = a blocking step remains (conflicts, blocking unregistered work, unmeasured state); resolve those first.',
    '   Exit 0 with a "follow-ups (not failures)" block is a successful receive: work through each follow-up, but nothing failed.',
    '3. Confirm each "memory <dir> → <path>" line receive printed is where this account reads that repo\'s memory.',
    '4. Scheduled tasks: call list_scheduled_tasks, diff its ids against "Scheduled tasks" below, skip a one-off whose fireAt has passed (spent), and recreate only what is still wanted — the CLI cannot see the scheduler.',
    `   Then report every task whose lastRunAt is later than this handover's creation (${m.createdAt}): those fired because of the switch.`,
    '5. Review settings and MCP-server differences receive listed, by hand; they are never copied.',
    `   A claim parked with --waiting-on ${'human:account-switch'} is unblocked now: run the touch command receive printed for it.`,
    ...coordinationStep6(m, art),
    '7. Only the user approves a merge or push. Run `node scripts/check-setup.mjs` once to confirm this account\'s environment.',
  ].join('\n');
}

/**
 * The pre-switch step (plan r), first in prepare's text and markdown whenever scheduled tasks are listed: relaunching
 * fires every overdue one-off at once, so they are disabled or re-dated BEFORE the relaunch, here in the source
 * account. The CLI cannot read the scheduler; `--scheduler-checked` is the operator saying the step was done.
 */
export function renderBeforeRelaunch(m) {
  if (!m.scheduledTasks.length) return [];
  return [
    `BEFORE YOU RELAUNCH (${m.scheduledTasks.length} scheduled task(s) on disk${m.schedulerChecked ? '; confirmed with --scheduler-checked' : ''}):`,
    '  1. Call list_scheduled_tasks. For every ENABLED one-off whose fireAt has passed and whose lastRunAt is absent or earlier than fireAt,',
    '     disable it (update_scheduled_task) or give it a new date: a relaunch runs every overdue one-off at once.',
    `  2. Then run prepare again with --scheduler-checked.${m.schedulerChecked ? '' : ' Until then this handover is NOT ready (exit 3).'} Pass it only after step 1 is done.`,
  ];
}

/** The human-readable handover (no memory CONTENT — only names, counts and hashes). */
export function renderHandoverMarkdown(m, art) {
  const relaunch = renderBeforeRelaunch(m);
  const L = [`# Fleet handover ${m.id}`, '', ...(relaunch.length ? ['## BEFORE YOU RELAUNCH', '', '```text', ...relaunch, '```', ''] : []),
    `- Created: ${m.createdAt}`, `- Source config root: \`${m.sourceConfigDir}\``,
    `- Invoking repo: \`${m.invokingRepo}\``, `- Machine-readable manifest: \`${art.json}\``, ''];
  const id = m.identity;
  if (id) {
    L.push('## Account (from .claude.json, whitelisted keys only)', '',
      id.account ? `- account: ${id.account.emailAddress ?? '(no address)'} · accountUuid ${id.account.accountUuid ?? '(none)'} · organizationUuid ${id.account.organizationUuid ?? '(none)'}` : `- account: unknown (${id.reason})`,
      ...(id.mcp ? [`- MCP servers (names only): ${id.mcp.global.length ? id.mcp.global.join(', ') : 'none top-level'}`, ...id.mcp.projects.map((p) => `  - \`${p.path}\`: ${p.names.join(', ')}`)] : []), '');
  }
  const sr = m.scope.sourceRepo;
  L.push('## Scope', '', sr.type === 'resolved'
    ? `Source repo resolved (\`${sr.path}\`); registered consumers included.${sr.registryError ? ` Registry read failed: ${sr.registryError}` : ''}`
    : `**Source repo NOT resolved (${sr.type}: ${sr.reason ?? ''}) — the per-repo layer covers only the invoking repo and --repo.**`, '');
  for (const r of m.scope.repos) L.push(`- \`${r.path}\` — fleet ${r.fleet}${r.error ? ` (${r.error})` : ''}${r.fleet === 'present' ? ` · ${r.sessions.length} live session(s), ${r.directives ?? 0} directive(s), ${r.trains ?? 0} open train(s)` : ''}${r.gh && !r.gh.queried ? ` · **${ghUnknownLine(r)}**` : ''}`);
  L.push('', '## Memory (account-wide)', '');
  for (const mem of m.memory) L.push(`- \`${mem.dirName}\`: ${mem.files.length} file(s)${mem.skipped.length ? `, ${mem.skipped.length} skipped (links/specials)` : ''}`);
  if (!m.memory.length) L.push('- (no memory dirs under this config root)');
  L.push('', '### Folder anomalies', '');
  L.push(...(m.anomalies.length ? m.anomalies.map((a) => `- ${a.kind}: \`${a.detail}\` — review; never auto-merged`) : ['- none']));
  L.push('', '## Sessions to resume', '');
  const sessions = m.scope.repos.flatMap((r) => r.sessions.map((s) => ({ ...s, repo: r.path, cmd: r.fleetCli ?? m.fleetCommand })));
  if (!sessions.length) L.push('- none live');
  let lastRepo = null;
  for (const s of sessions) {
    if (s.repo !== lastRepo) { L.push(`### ${s.repo}`, ''); lastRepo = s.repo; }
    const unc = s.uncommittedUnknown ? `UNKNOWN (${s.uncommittedUnknown})` : `${(s.uncommittedFiles ?? []).length}`;
    L.push(`#### ${s.id}`, '', `- state ${s.state}${s.ready ? `, ready at ${String(s.ready.oid ?? '').slice(0, 12)}${s.readyStale ? ' (stale)' : ''}` : ''}; uncommitted files: ${unc}`,
      ...(s.waitingOn?.length ? [`- waiting on: ${s.waitingOn.map((w) => `${w.kind}:${w.ref}`).join(', ')}`] : []),
      ...(s.risks ? [`- worktree risks: ${Object.entries(s.risks).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}`] : []),
      '', '```text', renderChipPrompt({ branch: s.branch ?? s.id, worktree: s.worktree ?? '(none)', task: s.intent || s.id, paths: s.paths ?? [], cmd: s.cmd }), '```', '');
  }
  L.push(...renderMergedUnreleased(m));
  L.push(...renderUnregistered(m));
  L.push('## Scheduled tasks (recreate in the new account; registration is never visible to the CLI)', '');
  L.push(...(m.scheduledTasks.length ? m.scheduledTasks.map((t) => `- \`${t.id}\` — ${t.description}`) : ['- none']));
  L.push('', '## User settings (presence only; never copied)', '');
  for (const s of m.settings) L.push(`- ${s.name}: ${s.exists ? 'present' : 'absent'} (\`${s.path}\`)`);
  L.push('', '## Coordination prompt for the new account', '', '```text', coordinationPrompt(m, art), '```', '');
  return L.join('\n');
}

/**
 * A pasteable claim for an unregistered worktree. A claim binds the worktree it runs FROM, so the directory
 * change is fail-closed: if it fails, the claim never runs against whatever directory the shell was in. The
 * CLI is the main checkout's, by absolute path — a linked worktree of a consumer has no synced tooling unless
 * hydrated. Every data argument goes through the one shell quoter.
 */
export function claimCommand(u, fleetCli, repo, platform = process.platform) {
  const [bin, script, ...rest] = fleetCli.split(' ');
  const claim = renderCommand([bin, path.resolve(repo, script), ...rest, 'claim', '--id', u.branch, '--intent', 'what it is', '--paths', 'changed/paths/**'], platform);
  return platform === 'win32'
    ? `Set-Location -LiteralPath ${quoteArg(u.worktree, platform)} -ErrorAction Stop; ${claim}`
    : `cd ${quoteArg(u.worktree, platform)} && ${claim}`;
}

/** Claims whose work landed but whose record was never released: listed to retire, never to resume (defect h). */
function renderMergedUnreleased(m) {
  const rows = m.scope.repos.flatMap((r) => (r.mergedUnreleased ?? []).map((x) => ({ ...x, repo: r.path })));
  if (!rows.length) return [];
  return ['## Merged but not released (release these; nothing to resume)', '', 'Their work landed, so they are not sessions to resume; their records are still open. Run each command in its repo.', '',
    ...rows.map((x) => `- \`${x.id}\` in \`${x.repo}\` — ${x.note}: \`${x.release}\``), ''];
}

/** One unregistered item's headline: where it is, its verdict and why (pre-verdict manifests: its risks). */
function describeUnregistered(u) {
  const where = u.worktree ? `\`${u.worktree}\` — ${u.branch ? `branch \`${u.branch}\`` : 'detached HEAD'}` : `branch \`${u.branch}\` (no worktree)`;
  const risk = RISK_KINDS.filter((k) => u.risks[k]).map((k) => `${u.risks[k]} ${k}`).join(', ');
  const what = u.verdict ? `${u.verdict}: ${u.reason}${risk ? ` (${risk})` : ''}` : (risk || 'unverifiable');
  return `${where}${u.locked ? ' (locked)' : ''}: ${what}${u.unverified?.length ? `; UNVERIFIED: ${u.unverified.join('; ')}` : ''}`;
}

/** "Unregistered work" section: worktrees and branches holding work that no live claim covers. */
function renderUnregistered(m) {
  const L = ['## Unregistered work (worktrees and branches holding work no live fleet claim covers)', '',
    'Blocking items hold work that exists nowhere else, or could not be measured. Claim each worktree from INSIDE it (a claim binds the worktree it is run from), commit and push it, or confirm with the user it can go; then re-run prepare. Receive re-checks these and refuses while a blocking one remains. Non-blocking items are listed so nothing is silent.', ''];
  const unreg = m.scope.repos.filter((r) => r.unregistered?.length || r.unregisteredUnknown);
  if (!unreg.length) L.push('- none', '');
  for (const r of unreg) {
    L.push(`### ${r.path}`, '');
    if (r.unregisteredUnknown) L.push(`- NOT MEASURED: ${r.unregisteredUnknown}`);
    const items = r.unregistered ?? [];
    for (const u of items.filter(blocksHandover)) {
      L.push(`- BLOCKING ${describeUnregistered(u)}`);
      if (u.branch && u.worktree) L.push(`  - claim (from inside the worktree; replace the intent and paths): \`${claimCommand(u, r.fleetCli ?? m.fleetCommand, r.path)}\``);
    }
    for (const u of items.filter((x) => !blocksHandover(x))) L.push(`- not blocking: ${describeUnregistered(u)}`);
    L.push('');
  }
  return L;
}

export function renderReceiveText(h) {
  const s = h.summary;
  const L = [`fleet handover receive ${h.id} — ${h.mode}${h.dryRun ? ' (dry run: nothing written)' : ''}`,
    `  destination config root: ${h.destConfigDir}`,
    h.mode === 'same-config-root'
      ? `  memory: same config root — ${s.verified} verified, ${s.changedSincePrepare} changed since prepare, ${s.missingSincePrepare} missing since prepare`
      : `  memory: ${s.copied} copied${h.dryRun ? ' (would copy)' : ''}, ${s.present} already present, ${s.conflicts} conflict(s), ${s.errors} error(s)`];
  // Where each memory dir lands, in the spelling on disk (plan t): step 3 of the prompt compares against these.
  for (const d of h.memoryDest ?? []) L.push(`  memory ${d.dirName} → ${d.dest}`);
  for (const f of h.files.filter((x) => x.human)) L.push(`  ${f.outcome.toUpperCase()}: ${f.dirName}/${f.rel}${f.reason ? ` (${f.reason})` : ''}${f.target ? ` -> ${f.target}` : ''}`);
  if (h.sweep.swept.length) L.push(`  swept ${h.sweep.swept.length} dead staging run(s)`);
  if (h.sweep.kept.length) L.push(`  staging entries left alone (not ours): ${h.sweep.kept.join(', ')}`);
  if (h.lockContention) L.push('  LOCKED: another receive holds this config root — rerun when it finishes');
  const a = h.identity?.account;
  if (a) L.push(`  account: ${a.status === 'same' ? 'same account' : a.status === 'different' ? `source ${a.source ?? '?'} → this ${a.mine ?? '?'} (different account)` : `unknown (${a.reason})`}`);
  // The CLI sees task FILES only; whether the scheduler has them registered is not checked here (plan q).
  L.push(`  scheduled tasks: ${h.tasks.length - s.missingTasks} file(s) present${s.missingTasks ? `, ${s.missingTasks} missing here` : ''}; scheduler registration not checked here`);
  for (const t of h.tasks.filter((x) => x.file === 'missing')) L.push(`    missing: ${t.id} — ${t.description}`);
  L.push(`  sessions still live (adopt or resume from the handover prompts): ${h.liveSessions.length ? h.liveSessions.map((x) => x.id).join(', ') : 'none'}`);
  for (const x of h.mergedUnreleased ?? []) L.push(`  merged but not released (${x.note}) — release it: ${x.release}${x.repo ? ` (in ${x.repo})` : ''}`);
  const since = h.liveSessions.filter((x) => x.sincePrepare);
  if (since.length) L.push(`  claimed since prepare (no resume prompt in the handover — run fleet status in their repo): ${since.map((x) => `${x.id} (${x.repo})`).join(', ')}`);
  // A human wait worded some other way is still shown — matching is on the documented token, never on prose (plan s).
  for (const w of (h.waits ?? []).filter((x) => !x.onSwitch)) L.push(`  note: ${w.id} (${w.repo}) waits on human:${w.refs.join(', human:')} — not the human:account-switch token, so not unblocked by this receive`);
  for (const u of h.liveUnknown) L.push(`  LIVE STATE UNKNOWN in ${u.repo}: ${u.reason}`);
  for (const u of h.unregistered ?? []) {
    if (u.unknown) L.push(`  UNREGISTERED WORK UNKNOWN in ${u.repo}: ${u.unknown}`);
    else if (blocksHandover(u)) L.push(`  UNREGISTERED WORK: ${describeUnregistered(u).replace(/`/g, '')}; claim it or settle it with the user`);
    else L.push(`  unregistered, not blocking: ${describeUnregistered(u).replace(/`/g, '')}`);
  }
  for (const e of h.memoryErrors ?? []) L.push(`  memory dir NOT measured at prepare: ${e.dirName} (${e.reason})`);
  for (const an of h.anomalies) L.push(`  folder anomaly: ${an.kind} ${an.detail}`);
  if (h.followUps?.length) {
    L.push('  follow-ups (not failures):');
    for (const f of h.followUps) L.push(`    - ${f.detail}`);
  }
  return L.join('\n');
}
