/**
 * @fileoverview `fleet lease <acquire|attach|release|status|announce|peak>`: the verb over the machine-wide lease
 * (`lease.mjs`). It parses, runs each sub-command as one transaction, and renders; every POLICY rule lives in the pure
 * module. It also owns the one forced recovery of an unreadable file, because that is a decision about the CLI's own
 * input (`--force --reason`), and `leaseForNext`, the reader `fleet next` calls.
 *
 * Exit codes follow the fleet map: 0 ok, 3 refused (the slot is held, a window overlaps, nothing can verify an
 * expired holder, a limit, not the holder), 1 error (lock contention, an unreadable or newer-version file, a write
 * failure), 2 argv.
 *
 * Plan: docs/plans/fleet-machine-lease.md.
 *
 * @module scripts/lib/fleet/lease-cmd
 */
import path from 'node:path';
import { ArgvError } from '../cli-io.mjs';
import { failed, ok, refused, selfId } from './commands.mjs';
import { gitCommonDir, runGit } from './git-facts.mjs';
import {
  LIMITS, LeaseConfigError, measureSlotWaits, repoLabel, decideAcquire, decideAnnounce, decideAttach, decideClearWindow, decideGrant, decideRelease, decideTurnConfig, decideWait, defaultProbe,
  machineDir, nextLines, parsePeakHours, peakState, readLease, recoverUnreadable, renderLog, renderStatus, repoKeyOf, summarise,
  transactLease,
} from './lease.mjs';

export const SUBS = Object.freeze(['acquire', 'attach', 'release', 'status', 'announce', 'peak', 'wait', 'log', 'grant', 'turn']);

/** The flags each sub-command accepts (besides `--json`); anything else is an argument error, never ignored. */
const ALLOWED = Object.freeze({
  acquire: ['--kind', '--for', '--pid', '--token', '--note', '--id'],
  attach: ['--pid', '--token', '--id'],
  release: ['--token', '--id', '--force', '--reason', '--end-turn'],
  status: [],
  announce: ['--kind', '--from', '--until', '--note', '--id', '--clear-window', '--over-held', '--over-turn'],
  peak: ['--hours', '--clear'],
  wait: ['--for', '--cancel', '--note', '--id'],
  log: ['--limit'],
  grant: ['--window', '--from', '--until', '--to', '--id'],
  turn: ['--minutes', '--clear'],
});

const hhmm = (d) => `${d.toISOString().slice(11, 16)}Z`;

/** `owner/repo` from the origin URL, else the checkout's folder name, else `unknown`. Display only; never compared. */
function repoSlug(cwd) {
  const remote = runGit(['remote', 'get-url', 'origin'], cwd);
  const top = runGit(['rev-parse', '--show-toplevel'], cwd);
  return repoLabel(remote.ok ? remote.stdout : '', top.ok ? top.stdout : '');
}

/** This checkout's `{repoKey, repo}`, or null when git cannot say (a lease needs a repo to attribute to). */
export function repoIdentity(cwd) {
  const c = gitCommonDir(cwd);
  if (!c.ok) return null;
  try { return { repoKey: repoKeyOf(c.dir), repo: repoSlug(cwd) }; } catch { return null; }
}

function wholeNumber(flags, name) {
  if (flags[name] === undefined) return undefined;
  const s = String(flags[name]).trim();
  if (!/^\d{1,9}$/.test(s)) throw new ArgvError(`fleet lease: ${name} must be a whole number (got ${JSON.stringify(flags[name])})`);
  return Number(s);
}

const text = (v) => (v === undefined ? undefined : String(v));

function checkFlags(sub, flags) {
  const bad = Object.keys(flags).filter((f) => f !== '--json' && !ALLOWED[sub].includes(f));
  if (bad.length) throw new ArgvError(`fleet lease ${sub}: ${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not accepted here (accepted: ${['--json', ...ALLOWED[sub]].join(', ')})`);
}

/** A refusal from the pure module → the fleet result. `bad-request` is the caller's argument error. */
function fromDecision(d, sub, cmd) {
  if (d.code === 'bad-request') throw new ArgvError(`fleet lease ${sub}: ${d.reason}`);
  // An acquire refusal queues this repo as a waiter (or says it could not): the caller needs to know either way.
  const queue = d.queued === true ? ` This repo is now waiting for the slot (\`${cmd} lease wait --cancel\` withdraws it).`
    : d.queueFull ? ' NOT queued: the waiter list is full.' : '';
  return refused(d.reason + queue, { leaseCode: d.code, ...(d.queued !== undefined ? { queued: d.queued } : {}) });
}

const unreadableResult = (read, sub, cmd) => failed(
  read.state === 'newer-version'
    ? `the lease was written by a newer fleet (${read.reason}); update this checkout before \`${sub}\``
    : `the lease file is unreadable (${read.reason}); nothing was changed. After a person has looked at it: \`${cmd} lease release --force --reason "<why>"\` keeps a copy and starts fresh`,
  { leaseState: read.state },
);

/** `fleet lease <sub> [flags]`. */
export function cmdLease(ctx, flags, positionals) {
  const sub = positionals[0];
  if (positionals.length !== 1) throw new ArgvError(`fleet lease: pass exactly one sub-command of ${SUBS.join(', ')} (got ${positionals.map((p) => JSON.stringify(p)).join(' ') || 'none'})`);
  if (!SUBS.includes(sub)) throw new ArgvError(`fleet lease: pass one sub-command of ${SUBS.join(', ')} (got ${JSON.stringify(sub)})`);
  checkFlags(sub, flags);
  let dir;
  try { dir = machineDir(ctx.env); } catch (e) { if (e instanceof LeaseConfigError) return failed(e.message); throw e; }
  const repo = repoIdentity(ctx.cwd);
  if (!repo) return failed('could not identify this repository (git did not answer); the lease needs a repo to attribute to');
  const probe = defaultProbe();

  if (sub === 'log') {
    const read = readLease(dir);
    const s = summarise(read, ctx.now, probe);
    if (!s.measured) return failed(`machine lease (${dir}):\n  UNMEASURED: ${s.reason}`, { sub, dir, lease: s });
    const limit = wholeNumber(flags, '--limit') ?? 50;
    if (limit < 1) throw new ArgvError('fleet lease log: --limit must be at least 1');
    return ok({ sub, dir, journal: s.journal.slice(-limit), measure: measureSlotWaits(s.journal, ctx.now), text: renderLog(s.journal, { limit }).join('\n') });
  }

  if (sub === 'status') {
    const read = readLease(dir);
    const s = summarise(read, ctx.now, probe);
    const lines = renderStatus(s, { dir, now: ctx.now, repoKey: repo.repoKey, cmd: ctx.cmd });
    // An unreadable or newer-version lease was not measured: a script reading the exit code must not take that for "free".
    if (!s.measured) return failed(lines.join('\n'), { sub, dir, lease: s });
    return ok({ sub, dir, lease: s, text: lines.join('\n') });
  }

  // `peak` is machine-wide config and attributes nothing to a session, so it needs no session identity (and takes no --id).
  const identity = { repoKey: repo.repoKey, holder: sub === 'peak' ? '-' : String(selfId(ctx, flags)) };
  const base = { identity, repo: repo.repo };
  let decide;
  let describe;
  let forced = false;

  switch (sub) {
    case 'acquire': {
      const req = {
        ...base, kind: text(flags['--kind']), forMin: wholeNumber(flags, '--for'), pid: wholeNumber(flags, '--pid'),
        token: text(flags['--token']), note: text(flags['--note']),
      };
      decide = (lease) => decideAcquire(lease, req, ctx.now, probe);
      describe = (d) => {
        const h = d.heavy;
        const warn = [];
        if (['gate', 'test'].includes(h.kind) && peakState(d.lease.peakHours, ctx.now).now) warn.push('WARNING: this is a peak-cost hour (see `lease status`); the slot was granted anyway');
        const verb = d.renewed ? 'renewed' : d.rotated ? 'extended with a NEW token' : 'granted';
        return {
          heavy: h, token: h.token, renewed: d.renewed, rotated: d.rotated, warnings: warn,
          text: [
            `OK: heavy slot ${verb} to ${h.holder} (${h.repo}) for ${h.kind} until ${hhmm(new Date(h.expiresAt))}`,
            `token: ${h.token}  (pass --token ${h.token} to attach/release/renew so a stale call is refused)`,
            ...(d.event ? [`taken over: ${d.event.reason}`] : []),
            ...(h.pid === undefined ? [`no pid recorded: once the job starts, \`${ctx.cmd} lease attach --pid <n>\` lets a later session verify it stopped`] : []),
            ...warn,
          ].join('\n'),
        };
      };
      break;
    }
    case 'attach': {
      const req = { identity, pid: wholeNumber(flags, '--pid'), token: text(flags['--token']) };
      if (req.pid === undefined) throw new ArgvError('fleet lease attach: --pid <n> is required');
      decide = (lease) => decideAttach(lease, req, ctx.now, probe);
      describe = (d) => ({ heavy: d.heavy, text: `OK: pid ${d.heavy.pid} recorded for the slot of ${d.heavy.holder} (${d.heavy.repo}), scope ${d.heavy.scope}` });
      break;
    }
    case 'release': {
      forced = flags['--force'] === true;
      const req = { ...base, token: text(flags['--token']), force: forced, reason: text(flags['--reason']), endTurn: flags['--end-turn'] === true };
      if (forced && req.endTurn) throw new ArgvError('fleet lease release: --end-turn is for the holder\'s own release, not --force');
      if (!forced && flags['--reason'] !== undefined) throw new ArgvError('fleet lease release: --reason is only for --force');
      decide = (lease) => decideRelease(lease, req, ctx.now, probe);
      describe = (d) => ({
        released: d.released, already: Boolean(d.already),
        text: d.already ? 'OK: the heavy slot was already free' : `OK: heavy slot released (was ${d.released.holder} (${d.released.repo}) for ${d.released.kind})${d.event ? `\nrecorded: ${d.event.reason}` : ''}`,
      });
      break;
    }
    case 'announce': {
      if (flags['--clear-window'] !== undefined) {
        for (const f of ['--kind', '--from', '--until', '--note']) if (flags[f] !== undefined) throw new ArgvError(`fleet lease announce: ${f} cannot be combined with --clear-window`);
        const req = { ...base, id: String(flags['--clear-window']) };
        decide = (lease) => decideClearWindow(lease, req, ctx.now, probe);
        describe = (d) => ({ window: d.window, text: `OK: window ${d.window.id} cleared${d.event ? ' (it belonged to another repo; recorded)' : ''}` });
        break;
      }
      if (flags['--kind'] === undefined || flags['--until'] === undefined) throw new ArgvError('fleet lease announce: --kind quiet|ci and --until <iso|+Nm> are required');
      const req = { ...base, kind: String(flags['--kind']), from: text(flags['--from']), until: String(flags['--until']), note: text(flags['--note']) };
      req.overHeld = flags['--over-held'] === true;
      req.overTurn = flags['--over-turn'] === true;
      decide = (lease) => decideAnnounce(lease, req, ctx.now, probe);
      describe = (d) => ({
        window: d.window,
        text: [
          `OK: ${d.window.kind} window ${d.window.id} for ${d.window.repo}, ${hhmm(new Date(d.window.from))} to ${hhmm(new Date(d.window.until))}`,
          ...(d.overHeld ? [`WARNING: recorded OVER the slot held by ${d.overHeld.holder} (${d.overHeld.repo}) until ${hhmm(new Date(d.overHeld.until))}; --over-held acknowledged`] : []),
          ...(d.overTurn ? [`WARNING: recorded OVER the turn of ${d.overTurn.repo}, which is waiting; --over-turn acknowledged`] : []),
        ].join('\n'),
      });
      break;
    }
    case 'grant': {
      if (flags['--window'] === undefined || flags['--until'] === undefined) throw new ArgvError('fleet lease grant: --window <id> and --until <iso|+Nm> are required (--from defaults to now, --to to anyone)');
      const req = { ...base, id: String(flags['--window']), from: flags['--from'] === undefined ? '+0m' : String(flags['--from']), until: String(flags['--until']), to: text(flags['--to']) };
      decide = (lease) => decideGrant(lease, req, ctx.now, probe);
      describe = (d) => ({
        window: d.window, gap: d.gap,
        text: `OK: gap ${hhmm(new Date(d.gap.from))} to ${hhmm(new Date(d.gap.until))} granted in window ${d.window.id} to ${d.gap.toRepo ?? 'anyone'}`,
      });
      break;
    }
    case 'turn': {
      const clear = flags['--clear'] === true;
      if (clear === (flags['--minutes'] !== undefined)) throw new ArgvError(`fleet lease turn: pass exactly one of --minutes <${LIMITS.minTurnMin}-${LIMITS.maxTurnMin}> or --clear`);
      const req = { clear, minutes: clear ? undefined : wholeNumber(flags, '--minutes') };
      decide = (lease) => decideTurnConfig(lease, req);
      describe = (d) => ({ turnMin: d.lease.turnMin ?? null, text: clear ? `OK: turn length restored to the default (${LIMITS.defaultTurnMin} minutes)` : `OK: turn length for this machine is ${req.minutes} minutes` });
      break;
    }
    case 'wait': {
      const req = { ...base, forMin: wholeNumber(flags, '--for'), note: text(flags['--note']), cancel: flags['--cancel'] === true };
      if (req.cancel && (req.forMin !== undefined || req.note !== undefined)) throw new ArgvError('fleet lease wait: --cancel cannot be combined with --for or --note');
      decide = (lease) => decideWait(lease, req, ctx.now, probe);
      describe = (d) => ({
        waiter: d.waiter, cancelled: d.cancelled,
        text: req.cancel ? (d.cancelled ? 'OK: this repo is no longer waiting for the slot' : 'OK: this repo was not waiting')
          : `OK: ${d.opened ? 'waiting' : 'already waiting'} since ${hhmm(new Date(d.waiter.since))} (${d.waiter.refusals} refusal${d.waiter.refusals === 1 ? '' : 's'}, wants ${d.waiter.forMin}m); \`${ctx.cmd} lease wait --cancel\` withdraws it`,
      });
      break;
    }
    case 'peak': {
      const clear = flags['--clear'] === true;
      if (clear === (flags['--hours'] !== undefined)) throw new ArgvError('fleet lease peak: pass exactly one of --hours "HH:MM-HH:MM,..." or --clear');
      let peakHours = [];
      if (!clear) {
        const p = parsePeakHours(flags['--hours']);
        if (!p.ok) throw new ArgvError(`fleet lease peak: ${p.reason}`);
        peakHours = p.peakHours;
      }
      decide = (lease) => ({ ok: true, lease: { ...lease, peakHours }, peakHours });
      describe = (d) => ({ peakHours: d.peakHours, text: d.peakHours.length ? `OK: peak hours (machine-local): ${d.peakHours.map((r) => `${r.from}-${r.to}`).join(', ')}` : 'OK: peak hours cleared' });
      break;
    }
    default: throw new ArgvError(`fleet lease: unhandled sub-command ${sub}`);
  }

  let tx;
  try {
    tx = transactLease(dir, (read) => {
    if (read.state === 'unreadable' && sub === 'release' && forced) {
      const by = `${identity.holder}@${repo.repo}`;
      const why = String(flags['--reason'] ?? '').trim();
      if (!why) return { value: { decision: { ok: false, code: 'bad-request', reason: '--force needs --reason' } } };
      const rec = recoverUnreadable(dir, read, { by, reason: why, now: ctx.now });
      return rec.ok ? { value: { recovered: rec }, write: rec.lease } : { value: { decision: rec } };
    }
    if (read.state === 'unreadable' || read.state === 'newer-version') return { value: { unreadable: read } };
    const d = decide(read.lease);
    // A refusal that carries a lease (a journal entry, a waiter, a settled expiry) is persisted; a bare one writes nothing.
    const write = d.ok ? d.lease : (d.lease && d.lease !== read.lease ? d.lease : undefined);
    return { value: { decision: d }, ...(write ? { write } : {}) };
    });
  } catch (e) {
    return failed(`could not use the lease directory ${dir} (${e.code ?? ''} ${e.message}); nothing was changed`);
  }
  if (!tx.ok) return failed('could not acquire the lease lock (contention) — nothing was changed; retry');
  const v = tx.value;
  if (v.unreadable) return unreadableResult(v.unreadable, sub, ctx.cmd);
  if (v.recovered) {
    return ok({ sub, recovered: true, copy: path.basename(v.recovered.aside), text: `OK: the unreadable lease was copied to ${path.basename(v.recovered.aside)} and replaced with a fresh one` });
  }
  if (!v.decision.ok) return fromDecision(v.decision, sub, ctx.cmd);
  const out = describe(v.decision);
  return ok({ sub, ...out });
}

/**
 * The FYI lines `fleet next` appends, plus the structured view for `--json`. Never throws: a lease that cannot be
 * read is `unmeasured` with its reason, never a missing line.
 * @returns {{lines: string[], lease: object}}
 */
export function leaseForNext(ctx) {
  try {
    const dir = machineDir(ctx.env);
    const read = readLease(dir);
    const repo = repoIdentity(ctx.cwd);
    const probe = defaultProbe();
    return {
      lines: nextLines(read, ctx.now, { cmd: ctx.cmd, repoKey: repo?.repoKey, probe }),
      lease: (({ events, journal, ...rest }) => rest)(summarise(read, ctx.now, probe)),
    };
  } catch (e) {
    const reason = e instanceof LeaseConfigError ? e.message : `could not read it (${e.message})`;
    return {
      lines: [`FYI for the user/coordinator, not an action for this session: machine lease unmeasured (${reason})`],
      lease: { state: 'unreadable', measured: false, reason },
    };
  }
}
