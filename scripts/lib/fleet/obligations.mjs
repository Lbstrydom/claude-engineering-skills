/**
 * @fileoverview What should THIS session do now? Derived from facts every session
 * can re-derive itself — never from a peer's say-so.
 *
 * `deriveObligations` turns the status item, the base-advance facts, the hold and
 * the directives addressed to a session into a short ordered list. A directive is
 * `verified` for a recipient ONLY when fleet independently derives the same
 * action for that recipient from current facts (`verifyDirective`): a directive
 * adds attention, never authority. Facts outrank directives — a `resume` while the
 * hold is still on, or a `pause` after it was released, is `superseded`.
 *
 * Pure: no git, no gh, no clock reads (the caller passes `now`).
 *
 * Plan: docs/plans/fleet-consumer-feedback-oct.md §2.4.
 *
 * @module scripts/lib/fleet/obligations
 */
import { advanceTouching } from './merged-facts.mjs';
import { isOpenFor } from './directives.mjs';
import { isTerminalState, mergedWhat } from './overlap.mjs';
import { renderCommand } from './shell-quote.mjs';

/** A lease that lapses within this window is worth a `touch`. */
export const LEASE_WARN_MS = 30 * 60 * 1000;

/** What each directive kind asks for — the kind never names anything beyond its row. */
export const KIND_ACTION = Object.freeze({
  pause: 'stop heavy local runs and pushes until the hold clears',
  resume: 'continue normal work',
  rebase: 'restack your branch onto the base (fleet restack; adopt the -restack ref yourself)',
  release: 'run fleet archive-check, then fleet release',
  'rerun-ready': 're-test, then run fleet ready',
});

/**
 * Safety priority among obligations of the same act: a hold must survive footer
 * truncation, then work the session would otherwise lose, then hygiene.
 */
const PRIORITY = Object.freeze({ hold: 0, directive: 1, merged: 2, 'partially-merged': 3, 'base-advanced': 4, 'ready-stale': 5, lease: 6 });

const prOf = (ref) => (typeof ref === 'string' && /^#\d+$/.test(ref) ? Number(ref.slice(1)) : null);

/**
 * Is directive `d` corroborated for recipient `sessionId` by the facts fleet
 * itself derived (`obligations`) and the current hold?
 * @returns {{status: 'verified'|'unverified'|'superseded', why: string}}
 */
export function verifyDirective(d, { obligations = [], hold = null, advance = null, merged = null }) {
  const has = (kind) => obligations.some((o) => o.kind === kind);
  const r = d.reason;
  if (d.kind === 'pause' || d.kind === 'resume') {
    const on = Boolean(hold?.held);
    if (d.kind === 'pause' && !on) return { status: 'superseded', why: 'the hold is off now' };
    if (d.kind === 'resume' && on) return { status: 'superseded', why: 'the hold is on now' };
    if (r.kind !== 'hold') return { status: 'unverified', why: `a ${d.kind} must cite the hold event (--reason hold)` };
    if (r.ref !== hold?.at) return { status: 'superseded', why: `it cites hold event ${r.ref}, but the current hold event is ${hold?.at ?? 'none'}` };
    return { status: 'verified', why: `the current hold (${on ? 'on' : 'off'} at ${hold.at}) matches` };
  }
  if (r.kind === 'note') return { status: 'unverified', why: 'a note is not a fact fleet can check — ask the user' };
  if (d.kind === 'release') {
    if (!has('merged')) return { status: 'unverified', why: 'fleet sees no merged evidence for your own branch' };
    const n = prOf(r.ref);
    if (r.kind === 'pr-merged' && n !== null) {
      const viaPr = merged?.via === 'pr' && merged.pr === n;
      const viaSquash = merged?.via === 'squash' && (advance?.commits ?? []).some((c) => c.oid === merged.commit && c.pr === n);
      if (!viaPr && !viaSquash) return { status: 'unverified', why: `your branch's merged evidence is not PR #${n}` };
    }
    return { status: 'verified', why: `your own branch was ${mergedWhat(merged)}` };
  }
  if (d.kind === 'rebase') {
    const candidates = obligations.filter((x) => x.kind === 'base-advanced' || x.kind === 'partially-merged');
    if (!candidates.length) return { status: 'unverified', why: 'fleet sees no base change touching your files' };
    const n = prOf(r.ref);
    if (r.kind !== 'pr-merged' || n === null) return { status: 'verified', why: candidates[0].text };
    // A cited PR must be the evidence itself — among the commits touching your files, or the PR that partially merged you.
    const hit = candidates.find((o) => (o.kind === 'base-advanced' ? (o.evidence.prs ?? []).includes(n) : o.evidence.pr === n));
    return hit ? { status: 'verified', why: hit.text } : { status: 'unverified', why: `PR #${n} is not the evidence fleet sees for a rebase` };
  }
  if (d.kind === 'rerun-ready') {
    return has('ready-stale') ? { status: 'verified', why: 'your ready mark is stale' } : { status: 'unverified', why: 'your ready mark is current' };
  }
  return { status: 'unverified', why: `unknown kind ${d.kind}` };
}

/**
 * The obligations of ONE session, most urgent first.
 * @param {object} a
 * @param {object} a.item          the session's status item (`buildStatusFrom`)
 * @param {object|null} a.session  its registry record
 * @param {object|null} a.advance  `baseAdvance` for its branch
 * @param {string[]} a.myFiles     its changed files (committed ∪ uncommitted)
 * @param {string[]} [a.filesUnknown] reasons any part of `myFiles` could not be read (a partial list is never read as complete)
 * @param {object|null} a.hold     `readHold`
 * @param {{active: object[], complete: boolean, reason?: string}|null} a.directives
 * @param {Date} a.now
 * @returns {{obligations: object[], directives: object[], notes: string[]}}
 */
export function deriveObligations({ item, session = null, advance = null, myFiles = [], filesUnknown = [], hold = null, directives = null, now }) {
  const ob = [];
  // `command` is an argv (first token 'fleet'), rendered shell-safe by `renderObligations` — never a string built from a branch name.
  const add = (kind, act, text, evidence = {}, command = null) => ob.push({ kind, act, text, evidence, ...(command ? { command } : {}) });
  const branch = item?.branch ?? session?.source?.branch ?? null;
  const restack = branch ? ['fleet', 'restack', branch] : ['fleet', 'restack'];
  const m = item?.merged;
  if (m?.merged === true) {
    const work = item.workRemaining === true ? ' — but your worktree still holds work: commit or move it' : item.workRemaining === null ? ' — your worktree was not inspected' : '';
    add('merged', 'do', `your ${mergedWhat(m)}${work}`, { via: m.via, pr: m.pr ?? null, commit: m.commit ?? null }, ['fleet', 'archive-check']);
  } else if (m?.merged === 'partially') {
    add('partially-merged', 'do', `${mergedWhat(m)}; ${m.extraCommits ?? 'some'} newer commit(s) on your branch are not in base`, { pr: m.pr ?? null }, restack);
  }
  if (advance?.queried && m?.merged !== true) {
    const touching = advanceTouching(advance, myFiles);
    if (touching.length) {
      const prs = [...new Set(touching.map((c) => c.pr).filter((n) => n !== null))];
      const files = [...new Set(touching.flatMap((c) => c.files))];
      const what = touching.slice(0, 3).map((c) => `${c.oid.slice(0, 9)}${c.pr ? ` (#${c.pr})` : ''}`).join(', ');
      add('base-advanced', 'do', `base gained ${touching.length} commit(s) touching your files (${files.slice(0, 4).join(', ')}): ${what}`, { prs, files, commits: touching.map((c) => c.oid) }, restack);
    }
    if (!advance.complete) add('base-advanced-unmeasured', 'info', advance.reason ?? 'base advance not fully measured');
    if (filesUnknown.length) add('base-advanced-unmeasured', 'info', `your changed files are not fully known (${filesUnknown.join('; ')}), so a base change touching them may be missed`);
  } else if (advance && !advance.queried) {
    add('base-advanced-unmeasured', 'info', `base advance not measured (${advance.reason ?? 'unknown reason'})`);
  }
  if (item?.readyStale) add('ready-stale', 'do', 'your head moved since `ready`; the mark is stale — re-test first', {}, ['fleet', 'ready']);
  if (hold?.held) add('hold', 'do', `HOLD on heavy runs${hold.by ? ` by ${hold.by}` : ''}${hold.reason ? `: ${hold.reason}` : ''}`, { at: hold.at });
  const lease = session?.leaseExpiresAt && !isTerminalState(session.state) ? Date.parse(session.leaseExpiresAt) - now.getTime() : null;
  if (lease !== null && Number.isFinite(lease) && lease < LEASE_WARN_MS) {
    add('lease', 'do', lease <= 0 ? 'your lease has lapsed — others may treat your claim as stale' : `your lease lapses in ${Math.max(1, Math.round(lease / 60_000))} min`, {}, ['fleet', 'touch']);
  }
  for (const o of item?.overlaps ?? []) {
    if (o.known) continue;
    add('overlap', 'info', `overlaps ${o.with} (${o.via.join('+')})${o.files?.length ? ` on ${o.files.join(', ')}` : ''}${o.uncommittedFiles?.length ? ` · uncommitted: ${o.uncommittedFiles.join(', ')}` : ''}`);
  }
  const notes = [];
  const views = [];
  if (directives) {
    if (!directives.complete) notes.push(`directives not fully read (${directives.reason ?? 'incomplete'})`);
    const id = item?.id ?? session?.id;
    for (const d of directives.active ?? []) {
      if (!isOpenFor(d, id, now)) continue;
      const v = verifyDirective(d, { obligations: ob, hold, advance, merged: m });
      views.push({ id: d.id, kind: d.kind, by: d.by, reason: d.reason, ...v, action: KIND_ACTION[d.kind] });
    }
    for (const v of views) {
      const act = v.status === 'verified' ? 'do' : v.status === 'superseded' ? 'info' : 'ask';
      add('directive', act, `directive ${v.id}: ${v.kind} from ${v.by || 'unknown'} — ${v.status.toUpperCase()} (${v.why})${act === 'do' ? ` → ${v.action}` : act === 'ask' ? ' → ask the user' : ''}`, { directive: v.id });
    }
    if ((directives.unsupported ?? []).length) notes.push(`${directives.unsupported.length} directive(s) not understood by this fleet version (listed by \`fleet directive --list\`, never acted on)`);
  }
  const rank = { do: 0, ask: 1, info: 2 };
  ob.sort((a, b) => (rank[a.act] - rank[b.act]) || ((PRIORITY[a.kind] ?? 9) - (PRIORITY[b.kind] ?? 9)));
  return { obligations: ob, directives: views, notes };
}

/** Text lines for `next`, or the first `limit` for a checkpoint footer. */
export function renderObligations(r, { limit = Infinity, cmd = 'fleet' } = {}) {
  if (!r.obligations.length && !r.notes.length) return ['next: nothing to do'];
  const shown = r.obligations.slice(0, limit);
  // Commands are written as `fleet …`; print them as the CLI is really invoked here.
  // A command is an argv whose first token is `fleet`: rendered as the CLI is really invoked, each argument
  // shell-quoted, so a branch name is data, never shell syntax.
  const render = (argv) => [cmd, renderCommand(argv.slice(1))].filter(Boolean).join(' ');
  const L = shown.map((o) => `${o.act === 'do' ? 'DO  ' : o.act === 'ask' ? 'ASK ' : 'info'} ${o.text}${Array.isArray(o.command) && o.act !== 'info' ? ` → ${render(o.command)}` : ''}`);
  if (r.obligations.length > shown.length) L.push(`… ${r.obligations.length - shown.length} more — run \`${cmd} next\``);
  for (const n of r.notes) L.push(`note: ${n}`);
  return L;
}
