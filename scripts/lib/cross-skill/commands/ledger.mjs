/**
 * @fileoverview `ledger` — the only writer verbs of the own-model decision ledger
 * (docs/plans/own-model-decision-ledger.md decision 14). Default-deny, secret-
 * redacted, repo-shaped: every event goes through `submitLedgerEvent`, never an
 * ad-hoc insert.
 *
 *   mint                              print a UUIDv7 work_item_id + the branch / PR-footer conventions
 *   record  --kind K [defaults]       event JSON on STDIN (never argv)
 *   task | outcome | usage            `record --kind <verb>`
 *   handover                          `record --kind decision` with snapshot:true
 *   correction --decision ID --proposal-file F --revision-file F --class C [--source S]
 *   flush                             drain the local spool into the store (idempotent)
 *   purge --work-item ID | --repo NAME   delete rows, barrier, and local copies
 *   sweep-reverts [--limit N]         close observation windows of merged outcomes
 *   rollup [--limit N]                per-work-item cost (own_model_task_cost)
 *   status                            spool backlog, quarantine, hook errors, ledger counts
 *
 * @module scripts/lib/cross-skill/commands/ledger
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CommandError } from '../dispatch.mjs';
import { mintWorkItemId, isWorkItemId, workItemFromBranch } from '../../ledger/work-item.mjs';
import { submitLedgerEvent } from '../../ledger/submit.mjs';
import {
  ledgerDir, ledgerEnabled, flushSpool, purgeLocal, spoolStatus, writeState, readState,
} from '../../ledger/spool.mjs';

const VERBS = new Set(['mint', 'record', 'task', 'outcome', 'usage', 'handover', 'correction', 'flush', 'purge', 'sweep-reverts', 'rollup', 'status']);
const ALIAS_KIND = { task: 'task', outcome: 'outcome', usage: 'usage', handover: 'decision' };
const USAGE = 'usage: ledger mint | record --kind K (event JSON on stdin) | task|outcome|usage|handover | correction --decision ID --proposal-file F --revision-file F --class C | flush | purge --work-item ID|--repo NAME | sweep-reverts | rollup | status';

function parseLimit(raw, dflt) {
  if (raw == null) return dflt;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 1000) throw new CommandError('BAD_INPUT', `--limit must be an integer 1-1000 (got ${raw})`);
  return Number(raw);
}

/** Work item: explicit flag, then env, then the wi- segment of the current branch; never guessed. */
function resolveWorkItem(flagValue, env = process.env) {
  const given = flagValue ?? env.OWN_MODEL_WORK_ITEM_ID ?? null;
  if (given != null) {
    if (!isWorkItemId(given)) throw new CommandError('BAD_INPUT', `work item must be a UUIDv7 (got ${given})`);
    return given;
  }
  try {
    const b = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return workItemFromBranch(b);
  } catch { return null; }
}

function envelopeDefaults(ctx, kind) {
  return {
    kind,
    work_item_id: resolveWorkItem(ctx.flag('work-item')),
    coordinator: ctx.flag('coordinator') ?? 'other',
    actor: ctx.flag('actor') ?? 'coordinator',
    event_at: new Date().toISOString(),
  };
}

function receiptToEnvelope(res) {
  // `failed-retryable` (spool full) means the event was NOT kept anywhere: a failure, not a deferral.
  const refused = res.state === 'refused' || res.state === 'failed-permanent' || res.state === 'failed-retryable';
  if (refused) throw new CommandError('WRITE_FAILED', `ledger event ${res.state}: ${res.reason ?? res.error ?? 'unknown'}`, { receipt: res }, 1);
  return { ok: true, cloud: res.state === 'persisted' || res.state === 'duplicate', receipt: res };
}

export async function ledgerCmd(ctx) {
  const verb = ctx.verb;
  if (!VERBS.has(verb)) throw new CommandError('BAD_INPUT', USAGE);

  if (verb === 'mint') {
    const id = mintWorkItemId();
    return { ok: true, cloud: false, work_item_id: id, branch_segment: `wi-${id}`, pr_footer: `Work-Item: ${id}`, trailer: `AI-Work-Item: ${id}` };
  }

  if (verb === 'record' || ALIAS_KIND[verb]) {
    const kind = verb === 'record' ? ctx.flag('kind') : ALIAS_KIND[verb];
    if (!kind) throw new CommandError('BAD_INPUT', 'record needs --kind task|decision|correction|outcome|usage');
    const body = ctx.payload();
    const payload = verb === 'handover' ? { ...(body.payload ?? body), snapshot: true } : (body.payload ?? body);
    const envelope = { ...envelopeDefaults(ctx, kind), ...(body.payload ? body : {}), payload };
    return receiptToEnvelope(await submitLedgerEvent(envelope, { cwd: process.cwd() }));
  }

  if (verb === 'correction') {
    const read = (flag) => {
      const f = ctx.flag(flag);
      if (!f) throw new CommandError('BAD_INPUT', `correction needs --${flag} <file>`);
      const p = path.resolve(f);
      try { return fs.readFileSync(p, 'utf8').trim(); } catch (err) { throw new CommandError('BAD_INPUT', `cannot read --${flag} ${f}: ${err.code ?? err.message}`); }
    };
    const decision = ctx.flag('decision');
    if (!decision) throw new CommandError('BAD_INPUT', 'correction needs --decision <decision_id> (the decision being corrected)');
    const payload = { class: ctx.flag('class'), source: ctx.flag('source') ?? 'chat', proposal_text: read('proposal-file'), revision_text: read('revision-file') };
    const envelope = { ...envelopeDefaults(ctx, 'correction'), actor: ctx.flag('actor') ?? 'louis', decision_id: decision, payload };
    return receiptToEnvelope(await submitLedgerEvent(envelope, { cwd: process.cwd() }));
  }

  // ── store-backed verbs ────────────────────────────────────────────────────
  // The registry entry is cloud:'none' (mint/record must work with no store), so the dispatcher does NOT
  // initialise the store and `ctx.cloud.enabled` is always false here. Ask the port directly: its
  // isCloudEnabled() builds the pool lazily. (A first cut read ctx.cloud.enabled and every store verb
  // silently degraded: found when `ledger status` printed cloud:false against a reachable store.)
  const cloudOn = await ctx.deps.isCloudEnabled();
  if (verb === 'status') {
    const dir = ledgerDir();
    const local = spoolStatus(dir);
    let store = null;
    if (cloudOn) {
      const m = ctx.deps;
      try { store = { counts: await m.readLedgerCounts(), generation: await m.readPurgeGeneration() }; } catch (err) { store = { error: err.message }; }
    }
    const empty = local.spooled == null && (!store || !store.counts || store.counts.length === 0);
    return { ok: true, cloud: cloudOn, enabled: ledgerEnabled(), measured: !empty, local, store,
      ...(empty ? { note: 'UNMEASURED: nothing captured yet, which is not the same as zero events' } : {}) };
  }

  if (!cloudOn) return { ...ctx.degrade(), verb };
  const m = ctx.deps;

  if (verb === 'flush') {
    if (!ledgerEnabled()) return { ok: true, cloud: true, disabled: true };
    // Refresh the local eligibility cache for THIS repo (and the purge generation), so the
    // spool-only hooks keep content for a repo the store just confirmed.
    try {
      const { resolveRepoIdentity } = await import('../../repo-identity.mjs');
      const looked = await m.lookupRepoFlag(resolveRepoIdentity(process.cwd()).name);
      writeState(ledgerDir(), { generation: await m.readPurgeGeneration(), ...(looked.flag !== 'unknown' ? { repo: looked } : {}) });
    } catch { /* the cache stays as it was */ }
    const res = await flushSpool({ dir: ledgerDir(), write: m.recordLedgerEvents });
    if (res.error) throw new CommandError('WRITE_FAILED', `ledger not flushed: ${res.error}; ${res.remaining} event(s) stay spooled`, { ...res }, 1);
    return { ok: true, cloud: true, ...res };
  }

  if (verb === 'purge') {
    const workItem = ctx.flag('work-item') ?? null;
    const repo = ctx.flag('repo') ?? null;
    if (!workItem && !repo) throw new CommandError('BAD_INPUT', 'purge needs --work-item <id> or --repo <name>');
    if (workItem && !isWorkItemId(workItem)) throw new CommandError('BAD_INPUT', `--work-item must be a UUIDv7 (got ${workItem})`);
    const dir = ledgerDir();
    // Barrier + delete in ONE database transaction first; local copies after, so a
    // replay of a copy that survives is refused by its older generation.
    const res = await m.purgeLedger({ workItem, repo });
    writeState(dir, { generation: res.generation });
    const local = purgeLocal(dir, { workItem, repo });
    return { ok: true, cloud: true, ...res, localRemoved: local, generation: readState(dir).generation };
  }

  if (verb === 'rollup') return { ok: true, cloud: true, rows: await m.readTaskCost({ limit: parseLimit(ctx.flag('limit'), 50) }) };

  // sweep-reverts
  const { sweepReverts } = await import('../../ledger/sweep.mjs');
  const { resolveRepoIdentity } = await import('../../repo-identity.mjs');
  const dir = ledgerDir();
  // Resume where the last page ended (persisted in the local state file); a page that was not full clears it, so unobservable
  // candidates are revisited from the start next time instead of being starved behind a stale cursor.
  const res = await sweepReverts({
    cwd: process.cwd(), limit: parseLimit(ctx.flag('limit'), 200), after: readState(dir).sweepCursor ?? null,
    repoName: resolveRepoIdentity(process.cwd()).name,
    deps: { listCandidates: m.listMergedAwaitingObservation, submit: (e, o) => submitLedgerEvent(e, { cwd: process.cwd(), ...o }) },
  });
  if (res.status === 'ok') writeState(dir, { sweepCursor: res.next });
  return { ok: true, cloud: true, ...res };
}
