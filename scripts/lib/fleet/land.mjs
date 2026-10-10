/**
 * @fileoverview `fleet land` — the dispatcher for the train verbs. Selecting
 * what to land is a read (status join); everything that changes git or the
 * remote is in `train.mjs` / `train-approve.mjs`.
 *
 * Exactly one of `--approve/--confirm/--reconcile/--resume/--abandon` per call,
 * or none (build a train). A train id is validated before any path is built from it.
 *
 * @module scripts/lib/fleet/land
 */
import { ArgvError } from '../cli-io.mjs';
import { assertTrainId, readTrain } from './registry.mjs';
import { buildStatusFrom, gatherFacts, payloadFromStatus } from './facts.mjs';
import { abandonTrain, branchOfRef, buildTrain, defaultDeps, resumeTrain, withTrainLock } from './train.mjs';
import { approveTrain, confirmTrain, reconcileTrain } from './train-approve.mjs';
import {
  renderAbandon, renderApprove, renderBuilt, renderConfirm, renderDryRun, renderReconcile,
} from './render-train.mjs';

/**
 * `.fleet.json` `requiredChecks` for approval. Recovery verbs (--confirm/--reconcile/--abandon) never
 * read config; approval does, and a config that fails to load is carried as an ERROR — the inventory
 * then reads `unknown` (a WAIT on every merge line), never "nothing declared".
 * @returns {{requiredChecks?: string[], requiredChecksError?: string}}
 */
function configuredRequiredChecks(ctx) {
  try { return { requiredChecks: ctx.config.requiredChecks }; } catch (e) { return { requiredChecksError: e.message }; }
}

const MODES = ['--approve', '--confirm', '--reconcile', '--resume', '--abandon'];
const withText = (r, text) => ({ ...r, text });

function validId(id) {
  try { return assertTrainId(id); } catch (e) { throw new ArgvError(`fleet land: ${e.message}`); }
}

/**
 * @param {object} ctx - `{cwd, config, dir, now, env, cmd}`
 * @param {Record<string, any>} flags
 * @param {ReturnType<typeof defaultDeps>} [deps]
 */
export function cmdLand(ctx, flags, deps = defaultDeps({ now: () => ctx.now })) {
  const modes = MODES.filter((m) => flags[m] !== undefined);
  if (modes.length > 1) throw new ArgvError(`fleet land: ${modes.join(' and ')} are mutually exclusive`);
  if (modes.length && (flags['--select'] !== undefined || flags['--dry-run'])) throw new ArgvError('fleet land: --select/--dry-run apply only when building a train');
  if (flags['--accept-rerun'] && modes[0] !== '--approve') throw new ArgvError('fleet land: --accept-rerun applies only to --approve');
  const { cwd, cmd } = ctx; // NOTE: ctx.config is lazy — manifest-driven verbs below never touch it

  if (modes[0] === '--approve') {
    const r = approveTrain({ cwd, trainId: validId(flags['--approve']), acceptRerun: Boolean(flags['--accept-rerun']), cmd, deps, ...configuredRequiredChecks(ctx) });
    return withText(r, renderApprove(r, cmd));
  }
  if (modes[0] === '--confirm') {
    const r = confirmTrain({ cwd, trainId: validId(flags['--confirm']), deps });
    return withText(r, renderConfirm(r));
  }
  if (modes[0] === '--reconcile') {
    const r = reconcileTrain({ cwd, trainId: validId(flags['--reconcile']), deps });
    return withText(r, renderReconcile(r, cmd));
  }
  if (modes[0] === '--abandon') {
    const r = abandonTrain({ cwd, trainId: validId(flags['--abandon']), deps });
    return withText(r, renderAbandon(r));
  }
  if (modes[0] === '--resume') {
    const trainId = validId(flags['--resume']);
    const t = readTrain(ctx.dir, trainId);
    // Resume works from the manifest; the live config / status are read only if the hook has not run yet.
    const r = resumeTrain({
      cwd, trainId, deps,
      getChecks: () => ctx.config.checks ?? [],
      checkPayload: () => payloadFromStatus(buildStatusFrom(gatherFacts({ cwd, config: { baseBranch: branchOfRef(t.train.destination.ref), hotFiles: ctx.config.hotFiles }, now: ctx.now, env: ctx.env, prs: false, patches: false }))),
    });
    return r.train ? finishBuilt(r, cmd) : withText(r, `REFUSED: ${r.reason}`);
  }
  return build(ctx, flags, deps);
}

/** `--select a,b`: present-but-empty (or with an empty element) is an argv error, never "no selection". */
export function parseSelect(v) {
  const ids = String(v).split(',').map((x) => x.trim());
  if (ids.length === 0 || ids.some((x) => x === '')) throw new ArgvError(`fleet land: --select ${JSON.stringify(String(v))} has an empty entry; name the sessions to land (a,b) or omit --select`);
  return ids;
}

function finishBuilt(r, cmd) {
  const text = renderBuilt({ train: r.train, approvability: r.approvability, cmd });
  const usable = r.approvability.ok || r.approvability.needsAcceptRerun === true;
  return { ...r, ok: usable, code: usable ? 'ok' : 'refused', reason: usable ? undefined : r.approvability.reason, trainId: r.train.trainId, text };
}

function build(ctx, flags, deps) {
  const { cwd, config, cmd } = ctx;
  const selectGiven = flags['--select'] !== undefined;
  const selectIds = selectGiven ? parseSelect(flags['--select']) : null;
  const facts = gatherFacts({ cwd, config, now: ctx.now, env: ctx.env });
  if (!facts.registry.complete) {
    return { ok: false, code: 'refused', reason: 'registry incomplete — a train is never built on partial data', text: `REFUSED: registry incomplete (${facts.registry.invalid.map((i) => i.file).join(', ')}) — run \`${cmd} repair --quarantine <file>\`` };
  }
  const status = buildStatusFrom(facts);
  const readyIds = new Set(status.landingOrder);
  let wanted = status.landingOrder;
  if (selectGiven) {
    wanted = selectIds;
    const bad = wanted.filter((id) => !readyIds.has(id));
    if (bad.length) {
      const why = bad.map((id) => { const it = status.items.find((i) => i.id === id); return `${id} (${it ? it.display : 'unknown session'})`; });
      return { ok: false, code: 'refused', reason: `not ready to land: ${why.join(', ')}`, text: `REFUSED: not ready to land: ${why.join(', ')}` };
    }
    // Keep the proposed landing order among the selection.
    wanted = status.landingOrder.filter((id) => wanted.includes(id));
  }
  if (!wanted.length) return { ok: false, code: 'refused', reason: 'nothing is ready to land', text: 'REFUSED: nothing is ready to land (a session must be `ready` and its head not moved since)' };

  const sources = wanted.map((id) => {
    const s = facts.registry.sessions.find((x) => x.id === id);
    const item = status.items.find((i) => i.id === id);
    return {
      id, gen: s.gen, rev: s.rev, oid: s.ready.oid, kind: s.source.kind, repo: s.source.repo, prNumber: s.source.prNumber,
      headRepo: s.source.headRepo, baseRef: s.source.baseRef, pr: item?.pr ?? null,
    };
  });
  const dryRun = Boolean(flags['--dry-run']);
  // Concurrent land operations on one repo are refused by the exclusive trains/.lock.
  const r = withTrainLock(ctx.dir, () => buildTrain({ cwd, config, sources, checkPayload: payloadFromStatus(status), dryRun, deps }));
  if (!r.ok) return { ...r, text: `${r.code === 'error' ? 'ERROR' : 'REFUSED'}: ${r.reason}` };
  if (r.dryRun) return { ...r, code: 'ok', text: renderDryRun(r) };
  return finishBuilt(r, cmd);
}
