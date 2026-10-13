/**
 * @fileoverview `fleet propose`, `fleet proposal <id> --folded|--queued|--declined|--done <value>` and
 * `fleet proposals [--all]`: the verbs over the findings intake queue (`proposals.mjs`).
 *
 * Writes run under the registry lock and sweep any committed-but-unarchived final record first. The listing is
 * read-only; it rechecks `blockedBy` against facts (a label, never a scheduler).
 *
 * Plan: docs/plans/fleet-proposals-queue.md.
 *
 * @module scripts/lib/fleet/proposals-cmd
 */
import { ArgvError } from '../cli-io.mjs';
import { spawnGh } from './gh-facts.mjs';
import { runGit } from './git-facts.mjs';
import { currentBranch, failed, lockFailed, nowIso, ok, refused, selfId } from './commands.mjs';
import { transact } from './registry.mjs';
import {
  DIAGNOSTICS_LISTED, FINAL_STATES, NO_THEME, groupByTheme, isOpen, newProposal, newProposalId, parseBlockedBy,
  proposalsLine, proposalsSummary, readProposals, recheckBlockedBy, blockerKey, sweepStranded, transitionProposal, writeProposal,
} from './proposals.mjs';

const DAY_MS = 86_400_000;
const OUTCOME_FLAGS = Object.freeze({ '--folded': 'folded', '--queued': 'queued', '--declined': 'declined', '--done': 'done' });

const need = (flags, name) => {
  const v = flags[name];
  if (v === undefined || String(v).trim() === '') throw new ArgvError(`fleet propose: ${name} is required and must not be empty`);
  return String(v).trim();
};

const zodMessage = (e) => (e?.issues ? e.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ') : e.message);

/** Warning lines for a sweep that could not archive a stranded record. Never blocks the command. */
const sweepWarnings = (sw) => [
  ...sw.failed.map((f) => `archival of ${f.id} is pending (${f.reason}); it is committed and is not counted open`),
  ...(sw.truncated ? ['the active proposals directory is over its read limit; stranded final records beyond it were not swept'] : []),
];

// ── propose ─────────────────────────────────────────────────────────────────

/** `fleet propose --what --where --why [--evidence] [--theme] [--blocked-by] [--id]`. */
export function cmdPropose(ctx, flags, { rename } = {}) {
  const what = need(flags, '--what'); const where = need(flags, '--where'); const why = need(flags, '--why');
  let blockedBy;
  if (flags['--blocked-by'] !== undefined) {
    const b = parseBlockedBy(flags['--blocked-by']);
    if (!b.ok) throw new ArgvError(`fleet propose: ${b.reason}`);
    blockedBy = b.value;
  }
  const id = selfId(ctx, flags);
  const branch = currentBranch(ctx.cwd);
  const at = nowIso(ctx);
  let record;
  try {
    record = newProposal({
      id: newProposalId(ctx.now), what, where, why, originator: { id, branch: branch ?? null }, at,
      ...(flags['--evidence'] !== undefined ? { evidence: String(flags['--evidence']).trim() } : {}),
      ...(flags['--theme'] !== undefined ? { theme: String(flags['--theme']).trim() } : {}),
      ...(blockedBy ? { blockedBy } : {}),
    });
  } catch (e) { throw new ArgvError(`fleet propose: ${zodMessage(e)}`); }

  const tx = transact(ctx.dir, (t) => {
    const sw = sweepStranded(t.dir, { rename });
    let rec = record;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { return { proposal: writeProposal(t.dir, rec), sw }; } catch (e) {
        if (e.code === 'EPROPOSAL_TOO_LARGE') throw new ArgvError(`fleet propose: ${e.message}`);
        if (e.code === 'EPROPOSAL_UNVERIFIABLE') return { unverifiable: e.message, sw };
        if (e.code !== 'EPROPOSAL_EXISTS') throw e;
        rec = { ...record, id: newProposalId(new Date(ctx.now.getTime() + attempt + 1)) };
      }
    }
    throw new Error('could not allocate a unique proposal id');
  });
  if (!tx.ok) return lockFailed();
  if (tx.value.unverifiable) return failed(`${tx.value.unverifiable}; nothing was recorded (an id is only issued once its uniqueness is established)`);
  const p = tx.value.proposal;
  const warnings = sweepWarnings(tx.value.sw);
  const text = [
    `recorded ${p.id} (pending)${p.theme ? ` in theme ${p.theme}` : ''}: ${p.what}`,
    `  it outlives this session and worktree; the coordinator triages it with \`${ctx.cmd} proposal ${p.id} --queued|--folded|--declined|--done <value>\``,
    ...warnings.map((w) => `warning: ${w}`),
  ].join('\n');
  return ok({ id: p.id, proposal: p, warnings, text });
}

// ── proposal <id> --outcome <value> ─────────────────────────────────────────

/** `fleet proposal <id> --folded <session> | --queued <reason> | --declined <reason> | --done <PR> [--id]`. */
export function cmdProposal(ctx, flags, positionals, { rename } = {}) {
  const given = Object.keys(OUTCOME_FLAGS).filter((f) => flags[f] !== undefined);
  if (given.length !== 1) throw new ArgvError(`fleet proposal: pass exactly one of ${Object.keys(OUTCOME_FLAGS).join(', ')} with its value`);
  const flag = given[0];
  const detail = String(flags[flag]).trim();
  if (detail === '') throw new ArgvError(`fleet proposal: ${flag} needs ${flag === '--done' ? 'the PR that resolved it' : flag === '--folded' ? 'the session it was folded into' : 'a reason'}`);
  const by = selfId(ctx, flags);
  const at = nowIso(ctx);
  const tx = transact(ctx.dir, (t) => {
    const sw = sweepStranded(t.dir, { rename });
    return { r: transitionProposal(t.dir, positionals[0], { state: OUTCOME_FLAGS[flag], detail, by, at }, { rename }), sw };
  });
  if (!tx.ok) return lockFailed();
  const { r, sw } = tx.value;
  if (!r.ok) {
    if (r.code === 'refused' || r.code === 'final' || r.code === 'unknown' || r.code === 'bad-id') return refused(r.reason);
    return failed(r.reason);
  }
  const warnings = sweepWarnings(sw);
  if (r.archivalPending) warnings.push(`recorded as ${r.record.state}; archival to closed/ is pending (${r.archivalPending}) and will be retried by the next proposal command`);
  const last = r.record.history[r.record.history.length - 1];
  const text = [`${r.record.id} is now ${r.record.state}: ${last.detail}`, ...warnings.map((w) => `warning: ${w}`)].join('\n');
  return ok({ id: r.record.id, proposal: r.record, archived: r.archived, ...(r.archivalPending ? { archivalPending: r.archivalPending } : {}), warnings, text });
}

// ── proposals ───────────────────────────────────────────────────────────────

const ageDays = (p, nowMs) => Math.max(0, Math.floor((nowMs - Date.parse(p.createdAt)) / DAY_MS));

/** The base branch for the blocker recheck; a config that cannot be loaded is carried as the reason, not as "absent". */
function baseBranchOf(ctx) {
  try { return { baseBranch: ctx.config?.baseBranch ?? null, baseError: null }; } catch (e) {
    return { baseBranch: null, baseError: `fleet config could not be loaded: ${e.message.split('\n')[0]}` };
  }
}

function renderItem(p, nowMs, blockers) {
  const last = p.history[p.history.length - 1];
  const stateText = p.state === 'pending' ? 'pending' : `${p.state}: ${last.detail}`;
  const lines = [`  ${p.id}  ${stateText}  (${ageDays(p, nowMs)}d, by ${p.originator.id})  ${p.what}`, `      where: ${p.where}`, `      why: ${p.why}`];
  if (p.evidence) lines.push(`      evidence: ${p.evidence}`);
  if (p.blockedBy) {
    const b = blockers.get(blockerKey(p.blockedBy));
    lines.push(`      blocked by: ${b ? b.text : `${p.blockedBy.kind} ${p.blockedBy.repo ?? ''}${p.blockedBy.ref} (not rechecked)`}${b?.state === 'resolved' ? ' — the blocker is clear; ready to schedule' : ''}`);
  }
  return lines;
}

/** `fleet proposals [--all] [--json]` — read-only. */
export function cmdProposals(ctx, flags, { ghRun, gitRun } = {}) {
  const all = Boolean(flags['--all']);
  const read = readProposals(ctx.dir, { closed: all });
  const nowMs = ctx.now.getTime();
  if (read.unmeasured) {
    const summary = proposalsSummary(read, ctx.now);
    return failed(`proposals unmeasured: ${read.reason}`, { proposals: { summary, records: [] }, text: proposalsLine(summary, ctx.cmd) });
  }
  const shown = (all ? read.records : read.records.filter(isOpen));
  const blockers = recheckBlockedBy(shown.filter((p) => p.blockedBy && !FINAL_STATES.includes(p.state)), {
    ghRun: ghRun ?? ((args) => spawnGh(ctx.cwd, args, { env: ctx.env })),
    gitRun: gitRun ?? ((args) => runGit(args, ctx.cwd)),
    ...baseBranchOf(ctx),
  });
  const summary = proposalsSummary(read, ctx.now);
  const groups = groupByTheme(shown);
  const diag = [...read.unreadable.map((d) => ({ ...d, kind: 'unreadable' })), ...read.unsupported.map((d) => ({ ...d, kind: 'unsupported' }))];
  const lines = [proposalsLine(summary, ctx.cmd)];
  if (!shown.length) {
    // A definitive empty statement is for a COMPLETE read only; otherwise the queue's contents are unknown.
    lines.push(read.complete
      ? (all ? 'no proposals recorded' : 'no open proposals')
      : 'no readable open proposals were found, and some records could not be read: the queue\'s actual contents are unknown');
  }
  for (const g of groups) {
    lines.push('', `${g.theme === NO_THEME ? g.theme : `theme: ${g.theme}`} (${g.items.length})`);
    for (const p of g.items) lines.push(...renderItem(p, nowMs, blockers));
  }
  if (diag.length) {
    lines.push('', `records that could not be read (${diag.length}):`);
    for (const d of diag.slice(0, DIAGNOSTICS_LISTED)) lines.push(`  ${d.file}: ${d.reason}`);
    if (diag.length > DIAGNOSTICS_LISTED) lines.push(`  +${diag.length - DIAGNOSTICS_LISTED} more`);
  }
  if (read.reason) lines.push('', `warning: ${read.reason}`);
  return ok({
    proposals: {
      summary, complete: read.complete, truncated: read.truncated, all,
      records: shown.map((p) => ({ ...p, blocker: p.blockedBy ? (blockers.get(blockerKey(p.blockedBy)) ?? null) : null })),
      diagnostics: { total: diag.length, listed: diag.slice(0, DIAGNOSTICS_LISTED) },
    },
    text: lines.join('\n'),
  });
}
