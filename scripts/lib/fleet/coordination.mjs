/**
 * @fileoverview The coordination verbs that need no host messaging: `next` (what
 * should this session do now?), `directive` (a coordinator's request, stored in
 * the shared registry), and the checkpoint footer `claim`/`touch`/`ready` append.
 *
 * Why not messages: a host holds messages between sessions whose permission
 * modes differ, and a delivered peer message is — correctly — untrusted data to
 * the receiving model, so sessions second-guess it. Here the session asks fleet,
 * at checkpoints it already hits, for obligations derived from facts it can
 * re-check, and the user's own launch prompt (participant rules) pre-authorises
 * acting on VERIFIED directives of five safe kinds.
 *
 * Plan: docs/plans/fleet-consumer-feedback-oct.md §2.4.
 *
 * @module scripts/lib/fleet/coordination
 */
import { ArgvError } from '../cli-io.mjs';
import { readSessions, transact } from './registry.mjs';
import { isTerminalState } from './overlap.mjs';
import { buildStatusFrom, gatherFacts } from './facts.mjs';
import { baseAdvance } from './merged-facts.mjs';
import {
  DEFAULT_EXPIRY_HOURS, DIRECTIVE_KINDS, REASON_KINDS, ackDirective, newDirectiveId, readDirectives, sweepDirectives, writeDirective,
} from './directives.mjs';
import { deriveObligations, renderObligations } from './obligations.mjs';
import { currentBranch, lockFailed, nowIso, ok, refused, selfId } from './commands.mjs';

/**
 * The `checkpoint` fact profile for ONE session: its own merged evidence, its own
 * worktree's uncommitted files, base-advance facts for its branch, the hold and
 * the active directives. Never gathers untracked branches.
 * @returns {{ok: true, result: object, item: object} | {ok: false, reason: string}}
 */
export function obligationsFor(ctx, id) {
  const session = readSessions(ctx.dir).sessions.find((s) => s.id === id) ?? null;
  if (!session) return { ok: false, reason: `no session ${id} is registered` };
  const branch = session.source?.branch ?? null;
  const facts = gatherFacts({
    cwd: ctx.cwd, config: ctx.config, now: ctx.now, env: ctx.env, prs: false, patches: true, worktrees: true, untracked: false,
    merged: branch ? [branch] : false, uncommitted: branch ? [branch] : false,
  });
  const status = buildStatusFrom(facts);
  const item = status.items.find((i) => i.id === id);
  if (!item) return { ok: false, reason: `session ${id} is not in the status join` };
  const tip = item.oid;
  const baseRev = facts.base.measure?.ok ? facts.base.measure.oid : null;
  const advance = tip && baseRev ? baseAdvance(ctx.cwd, { baseRev, tipOid: tip }) : { queried: false, complete: false, reason: 'branch tip or base not resolved', commits: [] };
  const c = branch ? facts.changed?.[branch] : null;
  const u = branch ? facts.uncommitted?.[branch] : null;
  const filesUnknown = [
    ...(c && !c.queried ? [`committed files: ${c.reason ?? 'not read'}`] : []),
    ...(u && !u.queried ? [`uncommitted files: ${u.reason ?? 'not read'}`] : []),
  ];
  const myFiles = [...new Set([...(c?.queried ? c.files : []), ...(u?.queried ? u.files : [])])];
  const result = deriveObligations({
    item, session, advance, myFiles, filesUnknown, hold: facts.hold, directives: readDirectives(ctx.dir), now: ctx.now,
  });
  return { ok: true, result, item };
}

/**
 * Footer lines for `claim`/`touch`/`ready`: the top obligations. Never fails the
 * verb — a footer that cannot be derived says so.
 */
export function checkpointFooter(ctx, id, { limit = 3 } = {}) {
  try {
    const r = obligationsFor(ctx, id);
    if (!r.ok) return [`next: not derived (${r.reason})`];
    return renderObligations(r.result, { limit, cmd: ctx.cmd }).map((l) => (l.startsWith('next:') ? l : `next: ${l}`));
  } catch (e) {
    return [`next: not derived (${e.message})`];
  }
}

/** `fleet next [--id] [--json]` — read-only. Exit 0; 3 when the session is unknown. */
export function cmdNext(ctx, flags) {
  const id = selfId(ctx, flags);
  const r = obligationsFor(ctx, id);
  if (!r.ok) return refused(r.reason);
  return ok({ id, ...r.result, text: [`next for ${id}:`, ...renderObligations(r.result, { cmd: ctx.cmd }).map((l) => `  ${l}`)].join('\n') });
}

// ── directive ───────────────────────────────────────────────────────────────

const MODES = ['--to', '--list', '--ack'];

function parseHours(v) {
  if (v === undefined) return DEFAULT_EXPIRY_HOURS;
  const h = Number(v);
  if (!Number.isFinite(h) || h <= 0 || h > 24 * 30) throw new ArgvError(`fleet directive: --expires-hours must be a positive number of hours, at most 720 (got ${JSON.stringify(v)})`);
  return h;
}

/**
 * The reason block from `--reason`/`--ref`/`--note` — three flags, because a hold
 * reference is an ISO time and a note may contain colons. `--reason hold` without
 * `--ref` resolves to the CURRENT hold event inside the transaction.
 */
function reasonFrom(flags) {
  const kind = flags['--reason'];
  if (!REASON_KINDS.includes(kind)) throw new ArgvError(`fleet directive: --reason must be one of ${REASON_KINDS.join(', ')} (got ${JSON.stringify(kind)})`);
  return { kind, ...(flags['--ref'] !== undefined ? { ref: flags['--ref'] } : {}), ...(flags['--note'] !== undefined ? { note: flags['--note'] } : {}) };
}

/** `fleet directive --to <id|all> --kind <k> --reason <r> [--ref] [--note] [--expires-hours]` | `--list [--all]` | `--ack <id> --outcome done|declined`. */
export function cmdDirective(ctx, flags) {
  const modes = MODES.filter((m) => flags[m] !== undefined);
  if (modes.length !== 1) throw new ArgvError(`fleet directive: pass exactly one of ${MODES.join(', ')}`);
  if (modes[0] === '--list') return listDirectives(ctx, flags);
  if (modes[0] === '--ack') return ackMode(ctx, flags);
  return createDirective(ctx, flags);
}

function createDirective(ctx, flags) {
  const kind = flags['--kind'];
  if (!DIRECTIVE_KINDS.includes(kind)) throw new ArgvError(`fleet directive: --kind must be one of ${DIRECTIVE_KINDS.join(', ')} (got ${JSON.stringify(kind)}); merge, push, override and delete are deliberately not expressible`);
  const reason = reasonFrom(flags);
  const hours = parseHours(flags['--expires-hours']);
  const to = flags['--to'];
  const by = flags['--id'] ?? currentBranch(ctx.cwd) ?? 'coordinator';
  const tx = transact(ctx.dir, (t) => {
    if (to !== 'all' && !t.sessions.some((s) => s.id === to && !isTerminalState(s.state))) return { noTarget: true };
    let r = reason;
    if (r.kind === 'hold' && r.ref === undefined) {
      const h = t.readHold();
      if (!h.at) return { noHoldEvent: true };
      r = { ...r, ref: h.at };
    }
    const stamp = nowIso(ctx);
    const d = writeDirective(ctx.dir, {
      schemaVersion: 1, id: newDirectiveId(ctx.now), to, kind, reason: r, by, createdAt: stamp,
      expiresAt: new Date(ctx.now.getTime() + hours * 3_600_000).toISOString(), acks: [],
    });
    sweepDirectives(ctx.dir, ctx.now);
    return { directive: d };
  });
  if (!tx.ok) return lockFailed();
  if (tx.value.noTarget) return refused(`--to ${JSON.stringify(to)} names no live session (use a registered session id, or all)`);
  if (tx.value.noHoldEvent) return refused('--reason hold: there is no hold event to cite (run `fleet hold on` first, or pass --ref)');
  const d = tx.value.directive;
  return ok({
    directive: d,
    text: [`directive ${d.id}: ${d.kind} → ${d.to} (${d.reason.kind}${d.reason.ref ? ` ${d.reason.ref}` : ''}${d.reason.note ? ` — ${d.reason.note}` : ''}), expires ${d.expiresAt}`,
      `  each recipient sees it in \`${ctx.cmd} next\` and acts only when fleet shows it VERIFIED for them`].join('\n'),
  });
}

function listDirectives(ctx, flags) {
  const r = readDirectives(ctx.dir, { archive: Boolean(flags['--all']) });
  const line = (d) => `  ${d.id}  ${d.kind} → ${d.to}  (${d.reason.kind}${d.reason.ref ? ` ${d.reason.ref}` : ''})  by ${d.by || '?'} · expires ${d.expiresAt} · acks: ${d.acks.map((a) => `${a.session}=${a.outcome}`).join(', ') || 'none'}`;
  const L = [`active directives (${r.active.length})${r.complete ? '' : ` — INCOMPLETE: ${r.reason}`}:`, ...r.active.map(line)];
  if (flags['--all']) L.push(`archived (${r.archived.length}):`, ...r.archived.map(line));
  for (const u of r.unsupported) L.push(`  unsupported ${u.file}: ${u.reason} (never acted on)`);
  for (const i of r.invalid) L.push(`  invalid ${i.file}: ${i.reason}`);
  return ok({ active: r.active, archived: r.archived, unsupported: r.unsupported, invalid: r.invalid, complete: r.complete, text: L.join('\n') });
}

function ackMode(ctx, flags) {
  const outcome = flags['--outcome'];
  if (outcome !== 'done' && outcome !== 'declined') throw new ArgvError('fleet directive --ack: --outcome must be done or declined');
  const session = selfId(ctx, flags);
  const tx = transact(ctx.dir, () => {
    const r = ackDirective(ctx.dir, flags['--ack'], { session, at: nowIso(ctx), outcome, ...(flags['--note'] !== undefined ? { note: flags['--note'] } : {}) });
    if (r.ok) sweepDirectives(ctx.dir, ctx.now);
    return r;
  });
  if (!tx.ok) return lockFailed();
  if (!tx.value.ok) return refused(tx.value.reason);
  return ok({ directive: tx.value.directive, changed: tx.value.changed, text: tx.value.changed ? `acked ${flags['--ack']} as ${outcome} (${session})` : `${session} had already acked ${flags['--ack']} — nothing changed` });
}

