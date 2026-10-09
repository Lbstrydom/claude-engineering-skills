/**
 * @fileoverview The registry verbs of /fleet: status, add, claim, ready, touch,
 * hold, start, repair. Each returns plain data `{ok, code, text, ...}`; the CLI
 * (`scripts/fleet.mjs`) only dispatches and prints.
 *
 * Shape of every mutating verb (plan §2, "Every registry mutation is a
 * transaction"): gather slow git/gh facts OUTSIDE the lock → `transact` (takes
 * `fleet/.lock`, re-reads, evaluates the gate on the fresh read, writes) →
 * release. `status` takes no lock and writes nothing; it never renews a lease.
 *
 * Result `code`: `ok` (exit 0) · `refused` (3) · `error` (1) · `argv` (2).
 *
 * @module scripts/lib/fleet/commands
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ArgvError } from '../cli-io.mjs';
import {
  runGit, headOf, tipSubject, repoToplevel,
} from './git-facts.mjs';
import { listPullRequests, materializePrRef, prSourceIdentity } from './gh-facts.mjs';
import {
  claimMode, decideClaim, idleMsFrom, isBlockingConflict, isTerminalState, splitHidden, validateClaimPatterns,
} from './overlap.mjs';
import { renderClaimVerdict, renderStatus } from './render.mjs';
import { renderChipPrompt, renderOpenTrains } from './render-train.mjs';
import { WaitingOnSchema, listTrains, quarantine, transact } from './registry.mjs';
import {
  buildStatusFrom, gatherFacts, leaseMsFrom, othersFor, readyChecks, resolveUpstream, statusChecks,
} from './facts.mjs';
import { parseWaitingOn, splitPaths } from './argv.mjs';

export const ok = (extra) => ({ ok: true, code: 'ok', ...extra });
export const refused = (reason, extra = {}) => ({ ok: false, code: 'refused', reason, text: `REFUSED: ${reason}`, ...extra });
export const failed = (reason, extra = {}) => ({ ok: false, code: 'error', reason, text: `ERROR: ${reason}`, ...extra });
export const lockFailed = () => failed('could not acquire fleet/.lock (contention) — nothing was changed; retry');

/**
 * What HEAD is, with a detached HEAD and a FAILED `git` call kept apart: a branch
 * name, `{detached:true}` (git answered: no branch), or `{ok:false, reason}` (git did
 * not answer, so nothing is known about HEAD).
 * @returns {{ok: true, branch: string|null, detached: boolean} | {ok: false, reason: string}}
 */
export function headState(cwd) {
  const r = runGit(['branch', '--show-current'], cwd);
  if (!r.ok) return { ok: false, reason: r.reason ?? 'git branch failed' };
  const branch = r.stdout.trim();
  return branch ? { ok: true, branch, detached: false } : { ok: true, branch: null, detached: true };
}

/** Current branch name, or null when detached OR when git failed — use `headState` where the two differ. */
export function currentBranch(cwd) {
  const h = headState(cwd);
  return h.ok ? h.branch : null;
}

/** `git` could not answer a question the command needs (exit 1, unlike a bad argument, exit 2). */
export class GitUnavailableError extends Error {
  constructor(message) { super(message); this.name = 'GitUnavailableError'; }
}

/** The participant identity: `--id`, else the current branch. */
export function selfId(ctx, flags) {
  if (flags['--id'] !== undefined) return flags['--id'];
  const h = headState(ctx.cwd);
  // A failed `git` call is an operational error, not "you are on a detached HEAD" (which `--id` cures).
  if (!h.ok) throw new GitUnavailableError(`could not determine the current branch (${h.reason}); pass --id <name> to proceed without it`);
  if (!h.branch) throw new ArgvError('fleet: HEAD is detached — pass --id <name>');
  return h.branch;
}

export const leaseIso = (ctx) => new Date(ctx.now.getTime() + leaseMsFrom(ctx.env)).toISOString();
export const nowIso = (ctx) => ctx.now.toISOString();

/** Validate `--waiting-on` / `--clear-waiting` into `{clear, adds}`. */
function waitingFromFlags(flags, ctx) {
  const adds = (flags['--waiting-on'] ?? []).map((spec) => {
    const { kind, ref, note } = parseWaitingOn(spec);
    const r = WaitingOnSchema.safeParse({ kind, ref, ...(note !== null ? { note } : {}), since: nowIso(ctx) });
    if (!r.success) throw new ArgvError(`--waiting-on ${JSON.stringify(spec)}: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
    return r.data;
  });
  return { clear: Boolean(flags['--clear-waiting']), adds };
}

function applyWaiting(existing, w) {
  let list = w.clear ? [] : [...existing];
  for (const a of w.adds) { list = list.filter((x) => !(x.kind === a.kind && x.ref === a.ref)); list.push(a); }
  return list;
}

/**
 * The commit a session began from: the merge-base of the MEASURED base (the fresher
 * of the local base and its upstream - `facts.base.measure`) and the session's head.
 * A baseline that cannot be established is REPORTED, never substituted (a branch
 * HEAD is not a start point).
 * @param {{cwd: string, config: {baseBranch: string}}} ctx
 * @param {string|null} branch
 * @param {ReturnType<typeof import('./git-facts.mjs').resolveMeasurementBase>} measure
 * @param {{git?: typeof runGit}} [opts] - injectable for tests
 * @returns {{ok: true, oid: string} | {ok: false, kind: 'base-unresolvable'|'no-merge-base'|'git-error', reason: string}}
 */
export function startOidFor(ctx, branch, measure, { git = runGit } = {}) {
  if (!measure?.ok) return { ok: false, kind: measure?.kind ?? 'base-unresolvable', reason: measure?.reason ?? `base branch ${ctx.config.baseBranch} was not measured` };
  const headRef = branch ? `refs/heads/${branch}` : 'HEAD';
  const head = git(['rev-parse', '--verify', '--quiet', `${headRef}^{commit}`], ctx.cwd);
  if (!head.ok) return { ok: false, kind: 'git-error', reason: `cannot resolve ${headRef}: ${head.reason ?? 'not found'}` };
  const mb = git(['merge-base', measure.oid, head.stdout.trim()], ctx.cwd);
  if (mb.ok) return { ok: true, oid: mb.stdout.trim() };
  if (mb.status === 1) return { ok: false, kind: 'no-merge-base', reason: `${headRef} and ${measure.ref} have no common ancestor (unrelated histories)` };
  return { ok: false, kind: 'git-error', reason: `git merge-base failed: ${mb.reason}` };
}

// ── status ──────────────────────────────────────────────────────────────────

/** `fleet status` — strictly read-only: no lock, no registry write, no lease renewal. */
export function cmdStatus(ctx, flags = {}) {
  const fetched = flags['--fetch'] ? fetchBase(ctx) : null;
  const facts = gatherFacts({ cwd: ctx.cwd, config: ctx.config, now: ctx.now, env: ctx.env, cmd: ctx.cmd });
  let status = buildStatusFrom(facts);
  const hook = statusChecks({ cwd: ctx.cwd, config: ctx.config, status });
  if (hook.findings.length) { facts.findings = [...(facts.findings ?? []), ...hook.findings]; status = buildStatusFrom(facts); }
  const warnings = [];
  if (fetched && !fetched.ok) warnings.push(`--fetch failed (${fetched.reason}); measured against the last fetch`);
  if (facts.hold?.invalid) warnings.push(`hold.json unreadable (${facts.hold.invalid})`);
  for (const t of facts.trainsInvalid) warnings.push(`train record unreadable: ${t.file} (${t.reason})`);
  const general = hook.findings.filter((f) => !f.sessions?.length);
  // The ONE place the default view hides stale untracked items; `status` itself stays complete.
  const view = splitHidden(status, { all: Boolean(flags['--all']), idleMs: idleMsFrom(ctx.config) });
  const lines = [renderStatus({ ...status, items: view.items }, { hidden: view.hidden })];
  if (general.length) lines.push('', 'checks:', ...general.map((f) => `  ${f.level}: ${f.message}`));
  const todo = renderOpenTrains(facts.trains, ctx.cmd);
  if (todo) lines.push('', todo);
  if (warnings.length) lines.push('', ...warnings.map((w) => `warning: ${w}`));
  return ok({ status: { ...status, items: view.items, hidden: view.hidden }, checks: hook.results, warnings, text: lines.join('\n') });
}

/**
 * `status --fetch`: bring the base's remote-tracking ref up to date first. A
 * failure is reported and the run continues on the last fetch — never fatal,
 * never silent.
 */
export function fetchBase(ctx, { git = runGit } = {}) {
  const base = ctx.config.baseBranch;
  // The SAME upstream the measurement will read (an open train's destination first), so the fetch
  // refreshes exactly the ref the overlaps are then measured from.
  const { upstream } = resolveUpstream(ctx.cwd, base, listTrains(ctx.dir).trains);
  // `<remote>/<branch>` - the branch is the UPSTREAM's own name, which need not equal baseBranch.
  const slash = upstream.indexOf('/');
  const remote = slash > 0 ? upstream.slice(0, slash) : 'origin';
  const branch = slash > 0 ? upstream.slice(slash + 1) : base;
  const r = git(['fetch', '--no-tags', remote, branch], ctx.cwd, { timeoutMs: 60_000 });
  return r.ok ? { ok: true, remote, branch } : { ok: false, remote, branch, reason: r.reason ?? 'git fetch failed' };
}

// ── claim ───────────────────────────────────────────────────────────────────

/** `fleet claim` — first registration (blocking gate) or an update (advisory). */
export function cmdClaim(ctx, flags) {
  const id = selfId(ctx, flags);
  const hasPaths = flags['--paths'] !== undefined;
  const paths = splitPaths(flags['--paths']);
  const pv = validateClaimPatterns(paths);
  if (!pv.ok) throw new ArgvError(`fleet claim: ${pv.errors.join('; ')}`);
  const waiting = waitingFromFlags(flags, ctx);
  const branch = currentBranch(ctx.cwd);
  const top = repoToplevel(ctx.cwd);
  // The `claim` fact profile: every live session's worktree is probed for UNCOMMITTED edits (advisory evidence).
  const facts = gatherFacts({ cwd: ctx.cwd, config: ctx.config, now: ctx.now, env: ctx.env, prs: false, patches: false, worktrees: true, untracked: false, uncommitted: 'all' });
  const start = startOidFor(ctx, branch, facts.base.measure);
  const startOid = start.ok ? start.oid : null; // claim stays lenient but never substitutes; the reason is surfaced below

  const tx = transact(ctx.dir, (t) => {
    const cur = t.sessions.find((s) => s.id === id) ?? null;
    const mode = claimMode(cur);
    const intent = flags['--intent'] ?? (mode === 'adopt' ? cur.intent : undefined);
    if (intent === undefined || String(intent).trim() === '') return { code: 'argv', reason: 'fleet claim: --intent is required to register a new session' };
    const claimPaths = hasPaths || mode === 'new' ? paths : cur.paths;
    const verdict = decideClaim({
      claim: { id, intent, paths: claimPaths, knownOverlaps: mode === 'adopt' ? cur.knownOverlaps : [] },
      mode, others: othersFor(facts, id, ctx.now, t.sessions), complete: t.complete, hotFiles: ctx.config.hotFiles ?? [],
    });
    const blocking = verdict.conflicts.filter(isBlockingConflict);
    const overriding = Boolean(flags['--override']) && blocking.length > 0 && verdict.verdict !== 'refused';
    if (verdict.verdict === 'refused' || (verdict.verdict === 'blocked' && !overriding)) return { verdict, mode };

    const stamp = nowIso(ctx);
    const known = [];
    if (overriding) {
      for (const c of blocking) {
        known.push({ with: c.with, by: 'human (--override)', at: stamp, note: 'override of a blocked claim' });
        const other = t.sessions.find((s) => s.id === c.with);
        t.writeSession({ ...other, rev: other.rev + 1, updatedAt: stamp, knownOverlaps: [...other.knownOverlaps, { with: id, by: 'human (--override)', at: stamp, note: 'override of a blocked claim' }] });
      }
    }
    const fresh = mode === 'new';
    const base = fresh
      ? { gen: cur ? cur.gen + 1 : 1, ready: null, waitingOn: [], knownOverlaps: [], createdAt: stamp, state: 'working', startOid,
        source: { kind: 'branch', branch, repo: null, prNumber: null, headRepo: null, headRef: branch, baseRef: ctx.config.baseBranch } }
      : { gen: cur.gen, ready: cur.ready, waitingOn: cur.waitingOn, knownOverlaps: cur.knownOverlaps, createdAt: cur.createdAt, state: cur.state, startOid: cur.startOid, source: cur.source };
    const record = t.writeSession({
      schemaVersion: 1, rev: cur ? cur.rev + 1 : 1, id, ...base,
      worktree: fresh ? (top.ok ? top.dir : null) : cur.worktree, intent, paths: claimPaths,
      waitingOn: applyWaiting(base.waitingOn, waiting), knownOverlaps: [...base.knownOverlaps, ...known],
      leaseExpiresAt: leaseIso(ctx), updatedAt: stamp,
    });
    return { verdict: overriding ? { ...verdict, overridden: true } : verdict, mode, record };
  });
  if (!tx.ok) return lockFailed();
  const v = tx.value;
  if (v.code === 'argv') throw new ArgvError(v.reason);
  const text = renderClaimVerdict(v.verdict, { id, cmd: ctx.cmd, measure: facts.base.measure, baseName: ctx.config.baseBranch })
    + (!start.ok && v.mode === 'new' && v.record ? `
warning: startOid not recorded — ${start.reason}` : '')
    + (v.record ? `\n${v.mode === 'new' ? 'registered' : 'updated'} ${id} (gen ${v.record.gen}, rev ${v.record.rev}): ${v.record.intent}${v.verdict.overridden ? '\n  --override: recorded as a known overlap on both sessions' : ''}` : '');
  const good = v.verdict.verdict === 'ok' || v.verdict.verdict === 'warn' || v.verdict.overridden;
  return {
    ok: Boolean(good), code: good ? 'ok' : 'refused', id, mode: v.mode, verdict: v.verdict.verdict, overridden: Boolean(v.verdict.overridden),
    ...(!start.ok && v.mode === 'new' ? { startOidWarning: start.reason } : {}),
    conflicts: v.verdict.conflicts, ...(v.verdict.reason ? { reason: v.verdict.reason } : {}), ...(v.record ? { record: v.record } : {}), text,
  };
}

// ── add (adoption) ──────────────────────────────────────────────────────────

/** `fleet add <branch|#PR|--all>` — adopt work that already exists. Advisory only; never blocks. */
export function cmdAdd(ctx, flags, positionals) {
  if (flags['--all'] && positionals.length) throw new ArgvError('fleet add: pass a branch/#PR OR --all, not both');
  if (!flags['--all'] && !positionals.length) throw new ArgvError('fleet add: pass a branch, #<PR> or --all');
  if (flags['--all'] && flags['--id']) throw new ArgvError('fleet add: --id cannot be combined with --all');
  const facts = gatherFacts({ cwd: ctx.cwd, config: ctx.config, now: ctx.now, env: ctx.env, prs: Boolean(positionals[0]?.startsWith('#')), patches: false, worktrees: false, untracked: false });
  const targets = [];
  const base = ctx.config.baseBranch;
  if (flags['--all']) {
    const tracked = new Set(facts.registry.sessions.filter((s) => !isTerminalState(s.state)).map((s) => s.id));
    for (const b of facts.branches.branches ?? []) if (b.name !== base && b.ahead > 0 && !tracked.has(b.name)) targets.push({ id: b.name, branch: b.name, kind: 'branch' });
    if (!facts.branches.queried) return failed(`branches not queried (${facts.branches.reason})`);
  } else if (positionals[0].startsWith('#')) {
    const n = Number.parseInt(positionals[0].slice(1), 10);
    if (!Number.isInteger(n) || n <= 0) throw new ArgvError(`fleet add: ${JSON.stringify(positionals[0])} is not a PR number`);
    if (!facts.prs.queried) return refused(`PRs not queried (${facts.prs.reason}) — cannot adopt #${n}`);
    const pr = facts.prs.prs.find((p) => p.number === n);
    if (!pr) return refused(`no open PR #${n} found`);
    const src = prSourceIdentity(pr);
    // A fork PR's head name may equal an unrelated local branch: never alias it.
    if (pr.isCrossRepository) { src.branch = null; src.headRef = pr.headRef; }
    targets.push({ id: flags['--id'] ?? `pr-${n}`, branch: src.branch, kind: 'pr', source: src, intent: pr.title, headOid: pr.headOid });
  } else {
    const name = positionals[0];
    if (!(facts.branches.branches ?? []).some((b) => b.name === name)) return refused(`no local branch ${name}`);
    targets.push({ id: flags['--id'] ?? name, branch: name, kind: 'branch' });
  }
  if (!targets.length) return ok({ added: [], skipped: [], warnings: [], text: 'nothing to adopt' });
  for (const t of targets) {
    if (t.kind === 'branch') {
      const s = tipSubject(ctx.cwd, `refs/heads/${t.branch}`);
      t.intent = s.ok && s.subject ? s.subject : t.branch;
    }
    if (t.kind === 'branch') {
      const so = startOidFor(ctx, t.branch, facts.base.measure);
      // Adoption without a known start is unsafe for the new-vs-adopt contract: refuse, naming the branch and why.
      if (!so.ok) return failed(`cannot adopt ${t.branch}: ${so.reason} (${so.kind}) — nothing was adopted`, { kind: so.kind });
      t.startOid = so.oid;
    } else t.startOid = null;
  }

  const tx = transact(ctx.dir, (tr) => {
    const added = []; const skipped = []; const warnings = [];
    for (const t of targets) {
      const cur = tr.sessions.find((s) => s.id === t.id) ?? null;
      if (cur && !isTerminalState(cur.state)) { skipped.push({ id: t.id, reason: 'already tracked' }); continue; }
      const v = decideClaim({ claim: { id: t.id, intent: t.intent, paths: [], knownOverlaps: [] }, mode: 'adopt', others: othersFor(facts, t.id, ctx.now, tr.sessions), complete: tr.complete, hotFiles: ctx.config.hotFiles ?? [] });
      if (v.verdict === 'refused') return { verdict: v };
      if (v.verdict === 'warn') warnings.push({ id: t.id, conflicts: v.conflicts });
      const stamp = nowIso(ctx);
      const rec = tr.writeSession({
        schemaVersion: 1, rev: cur ? cur.rev + 1 : 1, id: t.id,
        source: t.source ?? { kind: 'branch', branch: t.branch, repo: null, prNumber: null, headRepo: null, headRef: t.branch, baseRef: base },
        worktree: null, intent: t.intent, paths: [], state: 'working', gen: cur ? cur.gen + 1 : 1, startOid: t.startOid,
        waitingOn: [], ready: null, knownOverlaps: [], leaseExpiresAt: leaseIso(ctx), updatedAt: stamp, createdAt: stamp,
      });
      added.push(rec.id);
    }
    return { added, skipped, warnings };
  });
  if (!tx.ok) return lockFailed();
  if (tx.value.verdict) return refused(tx.value.verdict.reason, { verdict: 'refused' });
  const { added, skipped, warnings } = tx.value;
  const lines = [];
  if (added.length) lines.push(`adopted: ${added.join(', ')}`);
  for (const s of skipped) lines.push(`skipped ${s.id}: ${s.reason}`);
  for (const w of warnings) lines.push(`WARN ${w.id}: overlaps ${w.conflicts.filter((c) => !c.hotOnly).map((c) => c.with).join(', ')} (advisory)`);
  return ok({ added, skipped, warnings, text: lines.join('\n') || 'nothing to adopt' });
}

// ── ready / touch ───────────────────────────────────────────────────────────

/** `fleet ready` — record the current head as ready; renews the lease. */
export function cmdReady(ctx, flags) {
  const id = selfId(ctx, flags);
  const waiting = waitingFromFlags(flags, ctx);
  const readyFacts = gatherFacts({ cwd: ctx.cwd, config: ctx.config, now: ctx.now, env: ctx.env, prs: false, patches: false, worktrees: false, untracked: false });
  const peek = readyFacts.registry.sessions.find((s) => s.id === id);
  if (!peek || isTerminalState(peek.state)) return refused(`no live session ${id} — run \`${ctx.cmd} claim\` first`);
  let oid;
  if (peek.source.kind === 'pr') {
    const prs = listPullRequests(ctx.cwd, { env: ctx.env });
    if (!prs.queried) return refused(`PRs not queried (${prs.reason}) — cannot verify the PR head for ${id}`);
    const pr = prs.prs.find((p) => p.number === peek.source.prNumber);
    if (!pr) return refused(`PR #${peek.source.prNumber} is not open`);
    const m = materializePrRef(ctx.cwd, pr.number, pr.headOid);
    if (!m.ok) return refused(m.reason);
    oid = m.oid;
  } else {
    const h = peek.source.branch ? headOf(ctx.cwd, `refs/heads/${peek.source.branch}`) : headOf(ctx.cwd, 'HEAD');
    if (!h.ok) return refused(`cannot resolve the head of ${peek.source.branch ?? 'HEAD'}: ${h.reason}`);
    oid = h.oid;
  }
  // Checks opted into `runIn: ["ready"]` run BEFORE the mark, outside the lock (slow, consumer-owned).
  const gate = readyChecks({ cwd: ctx.cwd, config: ctx.config, session: peek, oid, baseOid: readyFacts.base.measure.ok ? readyFacts.base.measure.oid : null });
  const gateLines = gate.findings.map((f) => `  ${f.level}: ${f.message}`);
  if (gate.blocks) {
    const reason = `${gate.blocks} — ${id} was NOT marked ready`;
    return refused(reason, { checks: gate.results, text: [`REFUSED: ${reason}`, ...gateLines].join('\n') });
  }
  const tx = transact(ctx.dir, (t) => {
    const cur = t.sessions.find((s) => s.id === id);
    if (!cur || isTerminalState(cur.state)) return { gone: true };
    const stamp = nowIso(ctx);
    return { record: t.writeSession({
      ...cur, rev: cur.rev + 1, state: 'ready', ready: { oid, at: stamp }, waitingOn: applyWaiting(cur.waitingOn, waiting),
      leaseExpiresAt: leaseIso(ctx), updatedAt: stamp,
    }) };
  });
  if (!tx.ok) return lockFailed();
  if (tx.value.gone) return refused(`session ${id} is no longer live`);
  return ok({ id, record: tx.value.record, checks: gate.results, text: [`ready: ${id} @ ${oid.slice(0, 12)} (lease renewed)`, ...gateLines].join('\n') });
}

/** `fleet touch` — explicit heartbeat. */
export function cmdTouch(ctx, flags) {
  const id = selfId(ctx, flags);
  const waiting = waitingFromFlags(flags, ctx);
  const tx = transact(ctx.dir, (t) => {
    const cur = t.sessions.find((s) => s.id === id);
    if (!cur || isTerminalState(cur.state)) return { gone: true };
    return { record: t.writeSession({ ...cur, rev: cur.rev + 1, waitingOn: applyWaiting(cur.waitingOn, waiting), leaseExpiresAt: leaseIso(ctx), updatedAt: nowIso(ctx) }) };
  });
  if (!tx.ok) return lockFailed();
  if (tx.value.gone) return refused(`no live session ${id} — run \`${ctx.cmd} claim\` first`);
  return ok({ id, record: tx.value.record, text: `touched: ${id} (lease until ${tx.value.record.leaseExpiresAt})` });
}

// ── hold / repair ───────────────────────────────────────────────────────────

/** `fleet hold on|off [--reason]`. */
export function cmdHold(ctx, flags, positionals) {
  const mode = positionals[0];
  if (mode !== 'on' && mode !== 'off') throw new ArgvError('fleet hold: expected "on" or "off"');
  const by = flags['--id'] ?? currentBranch(ctx.cwd);
  const tx = transact(ctx.dir, (t) => t.writeHold(mode === 'on'
    ? { held: true, by, reason: flags['--reason'] ?? null, at: nowIso(ctx) }
    : { held: false, by: null, reason: null, at: null }));
  if (!tx.ok) return lockFailed();
  return ok({ hold: tx.value, text: mode === 'on' ? `HOLD on heavy runs${flags['--reason'] ? `: ${flags['--reason']}` : ''}` : 'hold released' });
}

/** `fleet repair --quarantine <file>` — human-run; moves, never deletes. */
export function cmdRepair(ctx, flags) {
  const file = flags['--quarantine'];
  if (!file) throw new ArgvError('fleet repair: --quarantine <file> is required');
  const tx = transact(ctx.dir, () => quarantine(ctx.dir, file));
  if (!tx.ok) return lockFailed();
  return tx.value.ok ? ok({ quarantined: file, to: tx.value.to, text: `quarantined ${file} -> ${tx.value.to}` }) : refused(tx.value.reason);
}

// ── start ───────────────────────────────────────────────────────────────────

/** Deterministic chip names: a slug of the task plus a 4-hex digest of (index, task). */
export function chipNameFor(task, index) {
  const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '') || 'task';
  const h = crypto.createHash('sha1').update(`${index}:${task}`).digest('hex').slice(0, 4);
  return `${slug}-${h}`;
}

function removeChip(ctx, p) {
  runGit(['worktree', 'remove', '--force', p.dir], ctx.cwd);
  runGit(['worktree', 'prune'], ctx.cwd);
  if (!p.branchPreexisted) runGit(['branch', '-D', p.branch], ctx.cwd);
}

/**
 * `fleet start --task "…" [--paths a,b] [--task …]…` — ONE atomic operation:
 * every task goes through the NEW-session gate against the registry AND against
 * each other; any conflict blocks the whole batch with the pairs named, creating
 * nothing. Worktrees are created from the resolved base OID; if worktree k
 * fails, 1..k-1 are removed and NO record is written.
 * @param {object} ctx
 * @param {Array<{task: string, paths: string[]}>} tasks
 */
export function cmdStart(ctx, tasks) {
  for (const t of tasks) {
    const pv = validateClaimPatterns(t.paths);
    if (!pv.ok) throw new ArgvError(`fleet start: task ${JSON.stringify(t.task)}: ${pv.errors.join('; ')}`);
  }
  const facts = gatherFacts({ cwd: ctx.cwd, config: ctx.config, now: ctx.now, env: ctx.env, prs: false, patches: false, worktrees: true, untracked: false, uncommitted: 'all' });
  // Chips start from the base the overlaps were measured against: the fresher of local and upstream.
  const base = facts.base.measure;
  if (!base.ok) return failed(`cannot resolve the base branch ${ctx.config.baseBranch}: ${base.reason}`);
  const plan = tasks.map((t, i) => {
    const name = chipNameFor(t.task, i);
    const branch = `fleet/${name}`;
    return { ...t, name, branch, dir: path.join(ctx.config.worktreeRoot, 'chips', name), branchPreexisted: headOf(ctx.cwd, `refs/heads/${branch}`).ok };
  });

  const tx = transact(ctx.dir, (t) => {
    // 1. The gate: every task as a NEW session vs the registry and vs the earlier tasks of this batch.
    const batch = []; const blocked = [];
    for (const p of plan) {
      const verdict = decideClaim({
        claim: { id: p.branch, intent: p.task, paths: p.paths, knownOverlaps: [] }, mode: 'new', complete: t.complete, hotFiles: ctx.config.hotFiles ?? [],
        others: [...othersFor(facts, p.branch, ctx.now, t.sessions), ...batch.map((b) => ({ session: b, live: true, changedFiles: [] }))],
      });
      if (verdict.verdict === 'refused') return { verdict, refusedAll: true };
      if (verdict.verdict === 'blocked') blocked.push({ task: p, conflicts: verdict.conflicts.filter(isBlockingConflict) });
      batch.push({ id: p.branch, intent: p.task, paths: p.paths, state: 'working', knownOverlaps: [] });
    }
    if (blocked.length) return { blocked };

    // 2. Create every worktree; roll ALL back if any fails.
    const made = [];
    try {
      for (const p of plan) {
        fs.mkdirSync(path.dirname(p.dir), { recursive: true });
        const r = runGit(['worktree', 'add', '-b', p.branch, p.dir, base.oid], ctx.cwd);
        if (!r.ok) throw new Error(`worktree for ${JSON.stringify(p.task)} failed: ${r.reason}`);
        made.push(p);
      }
      // 3. One transaction writes every record.
      const stamp = nowIso(ctx);
      const records = plan.map((p) => t.writeSession({
        schemaVersion: 1, rev: 1, id: p.branch,
        source: { kind: 'branch', branch: p.branch, repo: null, prNumber: null, headRepo: null, headRef: p.branch, baseRef: ctx.config.baseBranch },
        worktree: p.dir, intent: p.task, paths: p.paths, state: 'working', gen: 1, startOid: base.oid, waitingOn: [], ready: null,
        knownOverlaps: [], leaseExpiresAt: leaseIso(ctx), updatedAt: stamp, createdAt: stamp,
      }));
      return { records };
    } catch (e) {
      for (const p of [...made].reverse()) removeChip(ctx, p);
      return { failure: e.message };
    }
  });
  if (!tx.ok) return lockFailed();
  const v = tx.value;
  if (v.refusedAll) return refused(`${v.verdict.reason} — nothing was created`, { verdict: 'refused' });
  if (v.blocked) {
    const lines = ['BLOCKED: the batch conflicts — NOTHING was created (no worktrees, no records):'];
    for (const b of v.blocked) for (const c of b.conflicts) lines.push(`  ${JSON.stringify(b.task.task)} vs ${c.with}: ${c.via.join('+')}${c.paths?.length ? ` (${c.paths.slice(0, 2).map(([a, bb]) => `${a} ~ ${bb}`).join(', ')})` : ''}`);
    return { ok: false, code: 'refused', verdict: 'blocked', blocked: v.blocked.map((b) => ({ task: b.task.task, conflicts: b.conflicts })), reason: 'batch conflicts', text: lines.join('\n') };
  }
  if (v.failure) return failed(`${v.failure} — every worktree created by this batch was removed and no record was written`);
  const chips = plan.map((p) => ({ id: p.branch, branch: p.branch, worktree: p.dir, task: p.task, paths: p.paths, startOid: base.oid }));
  return ok({
    chips, baseOid: base.oid,
    text: chips.map((c) => renderChipPrompt({ branch: c.branch, worktree: c.worktree, task: c.task, paths: c.paths, cmd: ctx.cmd })).join('\n\n'),
  });
}
