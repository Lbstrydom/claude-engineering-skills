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
import { assertTrainId, probesDir, readTrain } from './registry.mjs';
import { buildStatusFrom, gatherFacts, payloadFromStatus } from './facts.mjs';
import { abandonTrain, branchOfRef, buildTrain, defaultDeps, resumeTrain, withTrainLock } from './train.mjs';
import { approveTrain, confirmTrain, reconcileTrain } from './train-approve.mjs';
import { approveSerial, readSerial, resumeSerial } from './serial.mjs';
import { approveShipBatch, buildShipBatch, readShipBatch, resumeShipBatch } from './ship-batch.mjs';
import { approveRollup, buildRollup, resumeRollup } from './rollup-land.mjs';
import { redTierLines } from './tier-failure.mjs';
import { resolveGitTimeoutMs } from './config.mjs';
import { LAND_RECORD_NUDGE, invalidateRecordCache, recordCommandFor } from './record-count.mjs';
import { unregisteredCacheDir } from './unregistered.mjs';
import {
  conflictVerdict, renderAbandon, renderApprove, renderBuilt, renderConfirm, renderDryRun, renderReconcile, renderSerial,
} from './render-train.mjs';

/**
 * `.fleet.json` `requiredChecks` for approval. Recovery verbs (--confirm/--reconcile/--abandon) never
 * read config; approval does, and a config that fails to load is carried as an ERROR — the inventory
 * then reads `unknown` (a WAIT on every merge line), never "nothing declared".
 * @returns {{requiredChecks?: string[], requiredChecksError?: string}}
 */
/** `.fleet.json` `serialTimeoutMs`, or the default when config cannot be read (approval reads the manifest). */
function serialTimeout(ctx) {
  try { return ctx.config.serialTimeoutMs; } catch { return undefined; }
}

function configuredRequiredChecks(ctx) {
  try { return { requiredChecks: ctx.config.requiredChecks }; } catch (e) { return { requiredChecksError: e.message }; }
}

const MODES = ['--approve', '--confirm', '--reconcile', '--resume', '--abandon'];
const withText = (r, text) => ({ ...r, text });
export const _internals = Object.freeze({ mergedSomething: (r) => mergedSomething(r) });
/**
 * A landing that MERGED is the moment the session log falls behind (docs/plans/ship-record-catchup.md §2.7): say so where the
 * coordinator is looking. The count is stale the instant a PR lands, so the line names the action, never a number.
 */
// Nudged when ANYTHING merged, not only on overall success (C-R1-M1/M4): a serial run can merge PRs and then stop.
const mergedSomething = (r) => Boolean(r.ok || r.run?.steps?.some((s) => s.step === 'merged'));
const withRecordNudge = (r, cmd, ctx = null) => {
  if (!mergedSomething(r)) return r;
  // The cached count is stale the moment anything merges (C-R4-H2): invalidate it so `next` cannot stay quiet on it.
  // Stamped NOW — after the merge, never the verb's start time (C-R5-H1) — so a refresh that began before the merge loses
  // the ordering check. A failed invalidation is said, not swallowed (C-R5-H2).
  const stamp = new Date(Math.max(Date.now(), ctx?.now instanceof Date ? ctx.now.getTime() : 0));
  const invalidated = ctx ? invalidateRecordCache(unregisteredCacheDir(ctx.cwd), stamp) : false;
  const warn = ctx && !invalidated ? `\nwarning: the records cache could not be invalidated — run \`${cmd} status\` before trusting \`${cmd} next\`'s records line` : '';
  return { ...r, text: `${r.text}\n${LAND_RECORD_NUDGE(recordCommandFor(cmd), cmd)}${warn}`, recordCacheInvalidated: invalidated };
};

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
  if (modes.length && (flags['--select'] !== undefined || flags['--dry-run'] || flags['--tier'] !== undefined || flags['--include-stale'])) throw new ArgvError('fleet land: --select/--dry-run/--tier/--include-stale apply only when building a train');
  if (flags['--tier'] !== undefined && !flags['--dry-run']) throw new ArgvError('fleet land: --tier applies only with --dry-run (a probe that runs one tier and is never approvable); a train you can approve runs every pre-land tier');
  if (flags['--accept-rerun'] && modes[0] !== '--approve') throw new ArgvError('fleet land: --accept-rerun applies only to --approve');
  if (flags['--accept-guard'] !== undefined && (modes[0] !== '--approve' || flags['--ship-batch'] || flags['--rollup'])) throw new ArgvError('fleet land: --accept-guard <dec-id> applies only to --approve (with or without --serial), never --ship-batch or --rollup');
  if (flags['--serial'] && modes[0] !== '--approve') throw new ArgvError('fleet land: --serial applies only to --approve (a stopped serial run continues with --resume)');
  if (flags['--ship-batch']) {
    if (modes.length && modes[0] !== '--approve' && modes[0] !== '--resume') throw new ArgvError('fleet land: --ship-batch applies to a build, --approve or --resume (a recovery verb never needs the grant)');
    if (flags['--serial'] || flags['--dry-run'] || flags['--tier'] !== undefined || flags['--accept-rerun'] || flags['--include-stale']) throw new ArgvError('fleet land: --ship-batch is always serial and always builds a real train: it cannot be combined with --serial/--dry-run/--tier/--accept-rerun/--include-stale');
  }
  if (flags['--rollup']) {
    if (modes.length && modes[0] !== '--approve' && modes[0] !== '--resume') throw new ArgvError('fleet land: --rollup applies to a build, --approve or --resume');
    if (flags['--serial'] || flags['--ship-batch'] || flags['--dry-run'] || flags['--tier'] !== undefined || flags['--accept-rerun'] || flags['--include-stale']) throw new ArgvError('fleet land: --rollup always builds a real train: it cannot be combined with --serial/--ship-batch/--dry-run/--tier/--accept-rerun/--include-stale');
    if (flags['--hold'] !== undefined && modes.length) throw new ArgvError('fleet land: --hold applies only when building a rollup (a held member needs a rebuild)');
  } else if (flags['--hold'] !== undefined) throw new ArgvError('fleet land: --hold applies only with --rollup');
  const { cwd, cmd } = ctx; // NOTE: ctx.config is lazy — manifest-driven verbs below never touch it
  // The machine's FLEET_GIT_TIMEOUT_MS applies to every verb; .fleet.json gitTimeoutMs only where the config is read anyway (build, resume).
  deps.gitTimeoutMs = resolveGitTimeoutMs({ env: ctx.env ?? process.env }).ms;
  const withConfigTimeout = () => { deps.gitTimeoutMs = resolveGitTimeoutMs({ env: ctx.env ?? process.env, configValue: () => ctx.config.gitTimeoutMs }).ms; };

  if (flags['--rollup'] && modes[0] === '--approve') {
    const r = approveRollup({ cwd, dir: ctx.dir, trainId: validId(flags['--approve']), deps, serialOpts: { ...configuredRequiredChecks(ctx), timeoutMs: serialTimeout(ctx) } });
    return withRecordNudge(r.text ? r : withText(r, `REFUSED: ${r.reason}`), cmd, ctx);
  }
  if (flags['--rollup'] && modes[0] === '--resume') {
    const trainId = validId(flags['--resume']);
    const r = resumeRollup({ cwd, dir: ctx.dir, trainId, deps, serialOpts: configuredRequiredChecks(ctx) });
    return withRecordNudge(r.text ? r : withText(r, `REFUSED: ${r.reason}`), cmd, ctx);
  }
  if (flags['--rollup']) {
    const r = buildRollup(ctx, flags, deps, { parseSelect });
    return r.text ? r : withText(r, `REFUSED: ${r.reason}`);
  }

  if (flags['--ship-batch'] && modes[0] === '--approve') {
    // The ONE land that needs no chat go-ahead, and only for a train this verb built under the grant (docs/plans/coordinator-aggregate-ship.md section 2.4).
    const r = approveShipBatch({ cwd, dir: ctx.dir, trainId: validId(flags['--approve']), deps, serialOpts: { ...configuredRequiredChecks(ctx), timeoutMs: serialTimeout(ctx) } });
    return withRecordNudge(r.text ? r : withText(r, `REFUSED: ${r.reason}`), cmd, ctx);
  }
  if (flags['--ship-batch'] && modes[0] === '--resume') {
    const trainId = validId(flags['--resume']);
    if (!readSerial(ctx.dir, trainId).ok) throw new ArgvError(`fleet land: ${trainId} has no serial run to resume with --ship-batch`);
    const r = resumeShipBatch({ cwd, dir: ctx.dir, trainId, deps, serialOpts: configuredRequiredChecks(ctx) });
    return withRecordNudge(r.text ? r : withText(r, `REFUSED: ${r.reason}`), cmd, ctx);
  }
  if (flags['--ship-batch']) return buildShipBatch(ctx, flags, deps, build, { parseSelect });
  if (modes[0] === '--approve' && flags['--serial']) {
    const r = approveSerial({ cwd, trainId: validId(flags['--approve']), acceptRerun: Boolean(flags['--accept-rerun']), acceptGuard: flags['--accept-guard'] ?? null, deps, ...configuredRequiredChecks(ctx), timeoutMs: serialTimeout(ctx) });
    return withRecordNudge(withText(r, renderSerial(r, cmd)), cmd, ctx);
  }
  if (modes[0] === '--approve') {
    const r = approveTrain({ cwd, trainId: validId(flags['--approve']), acceptRerun: Boolean(flags['--accept-rerun']), acceptGuard: flags['--accept-guard'] ?? null, cmd, deps, ...configuredRequiredChecks(ctx) });
    return withRecordNudge(withText(r, renderApprove(r, cmd)), cmd, ctx);
  }
  if (modes[0] === '--confirm') {
    const r = confirmTrain({ cwd, trainId: validId(flags['--confirm']), deps });
    return withRecordNudge(withText(r, renderConfirm(r)), cmd, ctx);
  }
  if (modes[0] === '--reconcile') {
    const r = reconcileTrain({ cwd, trainId: validId(flags['--reconcile']), deps });
    return withText(r, renderReconcile(r, cmd));
  }
  if (modes[0] === '--abandon') {
    const r = abandonTrain({ cwd, trainId: validId(flags['--abandon']), deps });
    return withText(r, renderAbandon(r));
  }
  if (modes[0] === '--resume' && readSerial(ctx.dir, validId(flags['--resume'])).ok) {
    const r = resumeSerial({ cwd, trainId: flags['--resume'], deps, ...configuredRequiredChecks(ctx) });
    return withRecordNudge(withText(r, renderSerial(r, cmd)), cmd, ctx);
  }
  if (modes[0] === '--resume') {
    const trainId = validId(flags['--resume']);
    const t = readTrain(ctx.dir, trainId);
    withConfigTimeout();
    // Resume works from the manifest; the live config / status are read only if the hook has not run yet.
    const r = resumeTrain({
      cwd, trainId, deps,
      getChecks: () => ctx.config.checks ?? [],
      checkPayload: () => payloadFromStatus(buildStatusFrom(gatherFacts({ cwd, config: { baseBranch: branchOfRef(t.train.destination.ref), hotFiles: ctx.config.hotFiles }, now: ctx.now, env: ctx.env, prs: false, patches: false }))),
    });
    return r.train ? finishBuilt(r, cmd) : withText(r, `REFUSED: ${r.reason}`);
  }
  withConfigTimeout();
  return build(ctx, flags, deps);
}

/**
 * A stable reorder so a source that is a git ANCESTOR of another lands before it (consumer report 2026-11-27: a branch and
 * its ancestor in one train stopped at "produced no commit"; `proposeLandingOrder` sees no ancestry). `isAncestor(a, b)` is
 * true when a is a STRICT ancestor of b (the caller answers equal commits with no edge, so the graph is acyclic); anything else
 * (false, null = unanswered) adds no edge. Pure.
 * @param {string[]} ids
 * @param {(a: string, b: string) => boolean|null} isAncestor
 * @returns {string[]}
 */
export function ancestorsFirst(ids, isAncestor) {
  const before = new Map(ids.map((b) => [b, ids.filter((a) => a !== b && isAncestor(a, b) === true)]));
  const placed = new Set(); const out = [];
  while (out.length < ids.length) {
    const next = ids.find((id) => !placed.has(id) && before.get(id).every((a) => placed.has(a))) ?? ids.find((id) => !placed.has(id));
    placed.add(next); out.push(next);
  }
  return out;
}

/** Most sources a train orders by ancestry (pairwise `merge-base --is-ancestor`); over it the order is left as proposed, and said. */
export const MAX_ANCESTRY_SOURCES = 30;
const ANCESTRY_TIMEOUT_MS = 15_000;

/**
 * Put a source that is an ancestor of another first (`ancestorsFirst`), asking git. An unanswered question adds no edge.
 * @returns {{ids: string[], note: string|null}}
 */
export function orderAncestorsFirst(ids, facts, git, cwd) {
  if (ids.length < 2) return { ids, note: null };
  if (ids.length > MAX_ANCESTRY_SOURCES) return { ids, note: `landing order: ${ids.length} sources is over ${MAX_ANCESTRY_SOURCES}, so ancestry was not checked` };
  const oid = new Map(ids.map((id) => [id, facts.registry.sessions.find((x) => x.id === id)?.ready?.oid ?? null]));
  // Equal commits are no edge (strict ancestry is acyclic). One timed-out question stops the asking: the rest stays unanswered
  // rather than spending a timeout per pair.
  let gaveUp = null;
  const isAncestor = (a, b) => {
    if (gaveUp || !oid.get(a) || !oid.get(b) || oid.get(a) === oid.get(b)) return null;
    const r = git(['merge-base', '--is-ancestor', oid.get(a), oid.get(b)], cwd, { timeoutMs: ANCESTRY_TIMEOUT_MS });
    if (r.timedOut) gaveUp = r.reason;
    return r.ok ? true : r.status === 1 ? false : null;
  };
  const next = ancestorsFirst(ids, isAncestor);
  const moved = next.some((id, i) => id !== ids[i]);
  const notes = [moved ? `landing order: ancestors first — ${next.join(', ')} (was ${ids.join(', ')})` : null, gaveUp ? `landing order: ancestry only partly checked (${gaveUp})` : null].filter(Boolean);
  return { ids: next, note: notes.length ? notes.join('; ') : null };
}

/** `--select a,b`: present-but-empty (or with an empty element) is an argv error, never "no selection". */
export function parseSelect(v) {
  const ids = String(v).split(',').map((x) => x.trim());
  if (ids.length === 0 || ids.some((x) => x === '')) throw new ArgvError(`fleet land: --select ${JSON.stringify(String(v))} has an empty entry; name the sessions to land (a,b) or omit --select`);
  return ids;
}

/**
 * A built (or resumed) train's verb result. A train whose tiers RAN and went red is its own outcome, `red` (exit 4), with the
 * runner's failure summary printed — never folded into `refused` (exit 3), which means nothing ran or it was not allowed.
 */
function finishBuilt(r, cmd) {
  const red = r.train.result === 'red';
  if (r.probe) {
    // A probe is never approvable: green exits 0, a tier that ran red exits 4, a conflict (no tier ran) exits 3.
    const green = r.train.result === 'green' || r.train.result === 'green-after-rerun';
    const code = red ? 'red' : green && !r.train.conflict ? 'ok' : 'refused';
    const verdict = r.train.conflict ? conflictVerdict(r.train.conflict) : r.train.result ?? 'none';
    const text = [`PROBE (tier ${r.train.testCommand[0]?.name} only, never approvable) — ${verdict}`,
      renderBuilt({ train: r.train, approvability: r.approvability, cmd }), ...(red ? redTierLines(r.train) : [])].join('\n');
    return { ...r, ok: code === 'ok', code, reason: code === 'ok' ? undefined : `probe: ${verdict}`, trainId: r.train.trainId, text };
  }
  const text = [renderBuilt({ train: r.train, approvability: r.approvability, cmd }), ...(red ? redTierLines(r.train) : [])].join('\n');
  const usable = r.approvability.ok || r.approvability.needsAcceptRerun === true;
  const code = usable ? 'ok' : red ? 'red' : 'refused';
  return { ...r, ok: usable, code, reason: usable ? undefined : r.approvability.reason, trainId: r.train.trainId, text };
}

function build(ctx, flags, deps) {
  const { cwd, config, cmd } = ctx;
  const selectGiven = flags['--select'] !== undefined;
  const selectIds = selectGiven ? parseSelect(flags['--select']) : null;
  const facts = gatherFacts({ cwd, config, now: ctx.now, env: ctx.env, ghIdentity: 'ambient' /* mutates as the ambient account until p-20261119105615-d6fb */ });
  if (!facts.registry.complete) {
    return { ok: false, code: 'refused', reason: 'registry incomplete — a train is never built on partial data', text: `REFUSED: registry incomplete (${facts.registry.invalid.map((i) => i.file).join(', ')}) — run \`${cmd} repair --quarantine <file>\`` };
  }
  const status = buildStatusFrom(facts);
  // A ready mark on a branch ahead 0 of the base has expired (nothing left to land): out by default, `--include-stale` brings it back.
  const includeStale = Boolean(flags['--include-stale']);
  const staleReady = status.staleReady ?? [];
  const order = includeStale ? [...status.landingOrder, ...staleReady] : status.landingOrder;
  const readyIds = new Set(order);
  let wanted = order;
  const staleNote = !includeStale && staleReady.length
    ? `left out: ${staleReady.length} stale ready mark(s), ahead 0 of the base (${staleReady.join(', ')}) — \`--include-stale\` brings them back`
    : null;
  if (selectGiven) {
    wanted = selectIds;
    const bad = wanted.filter((id) => !readyIds.has(id));
    if (bad.length) {
      const why = bad.map((id) => { const it = status.items.find((i) => i.id === id); return `${id} (${it ? it.display : 'unknown session'})`; });
      const hint = bad.some((id) => staleReady.includes(id)) ? ' — `--include-stale` brings back a mark that is ahead 0 of the base' : '';
      return { ok: false, code: 'refused', reason: `not ready to land: ${why.join(', ')}`, text: `REFUSED: not ready to land: ${why.join(', ')}${hint}` };
    }
    // Keep the proposed landing order among the selection.
    wanted = order.filter((id) => wanted.includes(id));
  }
  if (!wanted.length) return { ok: false, code: 'refused', reason: 'nothing is ready to land', staleReady, text: `REFUSED: nothing is ready to land (a session must be \`ready\`, its head not moved since, and ahead of the base)${staleNote ? `\n${staleNote}` : ''}` };

  const ordered = orderAncestorsFirst(wanted, facts, deps.git, cwd);
  wanted = ordered.ids;
  const sources = wanted.map((id) => {
    const s = facts.registry.sessions.find((x) => x.id === id);
    const item = status.items.find((i) => i.id === id);
    return {
      id, gen: s.gen, rev: s.rev, oid: s.ready.oid, kind: s.source.kind, repo: s.source.repo, prNumber: s.source.prNumber,
      headRepo: s.source.headRepo, baseRef: s.source.baseRef, pr: item?.pr ?? null,
    };
  });
  const dryRun = Boolean(flags['--dry-run']);
  const probeTier = flags['--tier'] ?? null;
  // Concurrent land operations on one repo are refused by the exclusive trains/.lock (a probe locks its own root).
  const r = withTrainLock(probeTier ? probesDir(ctx.dir) : ctx.dir, () => buildTrain({ cwd, config, sources, checkPayload: payloadFromStatus(status), dryRun, probeTier, deps }));
  // fullSuite: "train": a train whose tiers RAN is the sessions' full-suite run — said only then (never on a refusal, an error or
  // a conflict), naming the tiers that ran so the reader can judge what "full" covered (audit R1 M2/H7/H8: fleet cannot know
  // which command a repo calls its full suite; its pre-land tiers are what it runs).
  const ranTiers = (r.train?.tierResults ?? []).map((t) => `${t.name}:${t.result}`);
  const suiteNote = !probeTier && !dryRun && config.fullSuite === 'train' && r.ok && r.train && ranTiers.length
    // Said of the repo's policy, never of each source (audit R2 M1): a branch may have been made ready under "session" or by
    // an older bundle, and nothing records which.
    ? `full suite: .fleet.json fullSuite: "train" defers it to the train; this train's pre-land tiers ran: ${ranTiers.join(', ')}${r.train.result === 'green' || r.train.result === 'green-after-rerun' ? '' : ' — NOT green, so the deferred suite has not passed'}` : null;
  const notes = [staleNote, ordered.note, suiteNote].filter(Boolean);
  const withStale = (x) => (notes.length ? { ...x, ...(staleNote ? { staleReady } : {}), text: `${x.text}\n${notes.join('\n')}` } : x);
  if (!r.ok) {
    // A rollup repo's chips open no PR: say what lands them (only under `landing: "rollup"`; the text is unchanged otherwise).
    let rollupHint = '';
    try { rollupHint = /has no open PR/.test(String(r.reason)) && config.landing === 'rollup' ? ` — this repo lands by rollup: ${cmd} land --rollup` : ''; } catch { rollupHint = ''; }
    return withStale({ ...r, text: `${r.code === 'error' ? 'ERROR' : 'REFUSED'}: ${r.reason}${rollupHint}` });
  }
  if (r.dryRun) return withStale({ ...r, code: 'ok', text: renderDryRun(r) });
  return withStale(finishBuilt(r, cmd));
}
