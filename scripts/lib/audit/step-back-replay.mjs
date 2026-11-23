/**
 * @fileoverview The step-back REPLAY harness core (docs/plans/verification-lessons.md
 * §2.4, "Replay baseline" and "Q1 test"): a SYNCHRONOUS replay over a frozen
 * dataset, never a passive collector.
 *
 * Arms: `none` (the recorded run — computed, never called), `same` (fresh
 * step-back on `latest-gpt`) and `different` (`latest-pro`). For each PR and each
 * checkpoint (R3, R6) it builds an immutable no-look-ahead snapshot, builds the
 * egress-gated context pack at that round's `audited_sha`, and calls an
 * INJECTED provider per arm. Arch-memory neighbours are OFF in the replay: the
 * store holds today's symbols, which would be look-ahead.
 *
 * **Spend.** Metered from provider usage (`estimateCostUsd`); `--max-usd` is a
 * hard stop checked BEFORE each call against spend-so-far plus a per-call
 * estimate (the preflight estimate, replaced by measured cost once an arm has
 * two measured calls and never below that arm's largest measured call). A call
 * that would cross the cap is not made.
 *
 * **Scoring** uses the verdict rule fixed in advance: an arm is ADOPTED only
 * with `falseStops = 0` and `earlyStops >= 2`. Ground truth comes from the
 * separate scoring file and is read only by `scoreReplay`, after every call.
 *
 * Nothing here is network-bound by itself: providers, the revision checkout and
 * file reads are all injected.
 *
 * Domain: audit-orchestration.
 *
 * @module scripts/lib/audit/step-back-replay
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { priceFor, FALLBACK_PRICE_USD } from '../model-pricing.mjs';
import { buildCheckpointSnapshot } from './step-back-snapshot.mjs';
import { assertNoDuplicates } from './step-back-dataset.mjs';
import { buildExportSnapshot } from './step-back-export.mjs';
import { createRevisionFs } from './step-back-gitfs.mjs';
import { buildStepBackPack, initialStepBackRecord, runStepBack, STEP_BACK_SYSTEM_PROMPT } from './step-back.mjs';
import { createStepBackProvider, estimateCostUsd, STEP_BACK_MAX_OUTPUT_TOKENS } from './step-back-provider.mjs';

/** Moved to the provider seam so the live meta-review and the replay price a call one way; re-exported here. */
export { estimateCostUsd };

/**
 * PREFLIGHT bound of one call's cost: input = chars / 2 tokens (conservative) at the input price + the output ceiling at the
 * output price. An unpriced model uses the conservative fallback rate, never zero. Characters cannot truly upper-bound
 * tokens (a pathological text can exceed 2 chars per token), so this is conservative, NOT absolute: the hard stop is
 * ultimately enforced on METERED actuals after every call (spent is the sum of provider-reported cost), and the preflight
 * bound only decides whether the next call may start.
 */
export function upperBoundUsd({ modelId, inputChars, outputCeilingTokens = STEP_BACK_MAX_OUTPUT_TOKENS }) {
  const inputTokens = Math.ceil(inputChars / 2);
  const rate = priceFor(modelId, { inputTokens }) || FALLBACK_PRICE_USD;
  return (inputTokens * rate.input + outputCeilingTokens * rate.output) / 1_000_000;
}

export const AUTH_CONFIG_STATUSES = Object.freeze([401, 403, 404]);
export const OVERRUN_FACTOR = 1.25;
export const BOUND_NOTE = 'chars/2 is a PREFLIGHT estimate of tokens, not an upper bound; the hard stop is enforced on METERED actuals after each call.';
export const REPLAY_ARMS = Object.freeze(['none', 'same', 'different', 'higher']);
export const PAID_ARMS = Object.freeze(['same', 'different', 'higher']);
export const ADOPTION_RULE = Object.freeze({ maxFalseStops: 0, minEarlyStops: 2 });
export const STOPPING_ACTIONS = Object.freeze(['stop', 'structural']);

/** Default revision checkout: a detached worktree under the OS temp dir, removed by `cleanup`. */
export async function gitCheckout(sha, { cwd = process.cwd() } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'step-back-replay-'));
  execFileSync('git', ['worktree', 'add', '--detach', '--force', root, sha], { cwd, stdio: 'ignore' });
  const repoFiles = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
  return { root, repoFiles, cleanup: () => { try { execFileSync('git', ['worktree', 'remove', '--force', root], { cwd, stdio: 'ignore' }); } catch { /* best effort */ } } };
}

/** Build the snapshot + pack for every recoverable PR-checkpoint; unrecoverable ones are listed, never reconstructed. */
/** sha256 hex of bytes. */
export const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/**
 * A store-export dataset records the sha256 of the export file and the spec it was frozen from; `run` verifies both
 * BEFORE any call, so a regenerated or edited input can never be replayed under an old freeze.
 * @param {object} dataset
 * @param {(p: string) => Buffer|string} readBytes
 */
export function verifyDatasetInputs(dataset, readBytes) {
  if (dataset.source !== 'store-export') return;
  const inp = dataset.inputs;
  if (!inp?.exportSha256 || !inp?.specSha256 || !inp?.specPath) throw new Error('dataset records no input hashes (exportSha256, specSha256, specPath): re-freeze it');
  const check = (label, p, want) => {
    let got; try { got = sha256Hex(readBytes(p)); } catch (err) { throw new Error(`cannot read the ${label} (${p}) to verify it: ${err?.code || err?.message}`); }
    if (got !== want) throw new Error(`the ${label} (${p}) changed since the dataset was frozen (sha256 ${got.slice(0, 12)} != ${want.slice(0, 12)}): re-freeze`);
  };
  check('export file', dataset.exportPath, inp.exportSha256);
  check('spec file', inp.specPath, inp.specSha256);
}

export async function prepareItems({ dataset, deps = {} }) {
  assertNoDuplicates(dataset.prs);
  if (dataset.source === 'store-export') return prepareStoreItems({ dataset, deps });
  const checkout = deps.checkout || gitCheckout;
  const readJson = deps.readJson;
  const items = []; const unrecoverable = [];
  for (const pr of dataset.prs) {
    if (pr.status !== 'recoverable') { unrecoverable.push({ pr: pr.pr, checkpoint: null, reason: pr.reason }); continue; }
    for (const { checkpoint } of pr.checkpoints) {
      const snap = buildCheckpointSnapshot({ sid: pr.sid, checkpoint, auditDir: pr.auditDir, ...(readJson ? { readJson } : {}) });
      if (!snap.ok) { unrecoverable.push({ pr: pr.pr, checkpoint, reason: snap.reason }); continue; }
      const co = await checkout(snap.snapshot.auditedSha);
      try {
        const pack = await buildStepBackPack({
          repoRoot: co.root, planFile: pr.planFile, ledgerEntries: snap.snapshot.ledgerEntries, rounds: snap.snapshot.rounds,
          repoFiles: co.repoFiles, archNeighbours: null, ...(deps.topicOf ? { topicOf: deps.topicOf } : {}),
        });
        items.push({ pr: pr.pr, label: pr.label, checkpoint, auditedSha: snap.snapshot.auditedSha, pack, inputChars: STEP_BACK_SYSTEM_PROMPT.length + pack.text.length });
      } finally { await co.cleanup?.(); }
    }
  }
  return { items, unrecoverable };
}

/**
 * Run (or plan) the replay.
 *
 * **Spend is gated by a conservative preflight bound per call, and enforced on metered actuals**: input = pack chars / 2 (a conservative
 * chars-per-token; chars cannot truly upper-bound tokens) at the input price, plus the provider's output ceiling at the output price. Before each call,
 * `spent + upperBound <= maxUsd` or the run stops. A call that returns no usable usage, or fails after the provider
 * may have processed it, is charged its upper bound, never $0.
 *
 * **Results are never held only in memory**: every record (the plan, then each call as it completes) goes to
 * `deps.onRecord` BEFORE anything is scored; the CLI appends them to a JSONL file and scores from that file.
 *
 * @param {object} a
 * @param {object} a.dataset - the frozen dataset
 * @param {string[]} a.arms - subset of REPLAY_ARMS
 * @param {number} a.maxUsd - hard stop; required unless dryRun
 * @param {boolean} [a.dryRun]
 * @param {object} [a.deps] - makeProvider(arm) => {model, call, outputCeilingTokens?}; checkout; readJson; topicOf; onRecord
 */
export async function runReplay({ dataset, arms, maxUsd, dryRun = false, deps = {} }) {
  const paid = arms.filter((a) => PAID_ARMS.includes(a));
  if (!dryRun && !(Number.isFinite(maxUsd) && maxUsd > 0)) throw new Error('runReplay: a positive --max-usd is required for a paid run');
  const makeProvider = deps.makeProvider || ((arm) => createStepBackProvider(arm, deps.providerSeams || {}));
  const allProviders = Object.fromEntries(paid.map((a) => [a, makeProvider(a)]));
  // An arm whose route is unavailable (the higher arm without an sdk route) is UNMEASURED with its reason: no plan rows, no call, no fallback.
  const unmeasured = Object.fromEntries(paid.filter((a) => allProviders[a].unmeasuredReason).map((a) => [a, allProviders[a].unmeasuredReason]));
  const providers = Object.fromEntries(Object.entries(allProviders).filter(([a]) => !unmeasured[a]));
  const live = paid.filter((a) => !unmeasured[a]);
  const prepared = await prepareItems({ dataset, deps });
  const { items, unrecoverable } = prepared;

  const plan = [];
  for (const item of items) {
    for (const arm of live) {
      const prov = providers[arm];
      const upperUsd = upperBoundUsd({ modelId: prov.model, inputChars: item.inputChars, outputCeilingTokens: prov.outputCeilingTokens });
      plan.push({ pr: item.pr, checkpoint: item.checkpoint, arm, model: prov.model, packChars: item.pack.text.length, estimateUsd: upperUsd, upperBoundUsd: upperUsd, item });
    }
  }
  const publicPlan = plan.map(({ item, ...row }) => row);
  const estimatedUsd = publicPlan.reduce((s, p) => s + p.upperBoundUsd, 0);
  const base = { plan: publicPlan, unmeasured, unrecoverable, controls: prepared.controls || [], estimatedUsd, upperBoundTotalUsd: estimatedUsd, preparedPrs: items.length };
  if (dryRun) return { ...base, calls: [], spentUsd: 0, stopped: null };

  deps.onRecord?.({ type: 'plan', plan: publicPlan, maxUsd, arms, inputs: deps.inputHashes ?? null });
  for (const [arm, reason] of Object.entries(unmeasured)) deps.onRecord?.({ type: 'unmeasured', arm, reason });
  const calls = []; let spent = 0; let stopped = null; const maxMeasured = {};
  for (const row of plan) {
    const { item, ...meta } = row;
    const emit = (c) => { calls.push(c); deps.onRecord?.({ type: 'call', ...c }); };
    // A measured overrun raises the remaining bounds: never below 1.25x the largest MEASURED call of the same arm so far.
    const bound = Math.max(row.upperBoundUsd, OVERRUN_FACTOR * (maxMeasured[row.arm] || 0));
    if (stopped?.abort) { emit({ ...meta, status: 'skipped-aborted', action: null, costUsd: 0, spendSource: 'none' }); continue; }
    if (stopped || spent + bound > maxUsd) {
      stopped ||= { reason: 'max-usd', detail: `spent $${spent.toFixed(4)} + upper bound $${bound.toFixed(4)} would exceed the $${maxUsd} cap`, before: `PR #${row.pr} R${row.checkpoint} ${row.arm}` };
      emit({ ...meta, status: 'skipped-budget', action: null, costUsd: 0, spendSource: 'none' });
      continue;
    }
    const prov = providers[row.arm];
    const record = initialStepBackRecord({ round: row.checkpoint, signals: { anyFires: true, unmeasured: [] } });
    const { record: out, usage, truncated = false, failure: reported = null, thrown = null } = await runStepBack({ record, pack: item.pack, provider: prov.call, model: prov.model });
    const failure = reported ?? (thrown ? `provider threw: ${thrown.message} (status ${thrown.status ?? 'none'}, code ${thrown.code ?? 'none'})` : null);
    const exact = usage && !usage.usageMissing && Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens)
      ? estimateCostUsd({ modelId: prov.model, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }) : null;
    // No usable usage (absent, unpriced model, or an error after the provider may have processed the call): charge the bound.
    const cost = exact ?? bound;
    if (exact != null) maxMeasured[row.arm] = Math.max(maxMeasured[row.arm] || 0, exact);
    spent += cost;
    emit({
      ...meta, status: failure ? 'provider-failure' : truncated ? 'truncated' : out.state === 'step-back-valid' ? 'ok' : out.state === 'step-back-invalid' ? 'invalid' : 'unavailable',
      action: out.output?.action ?? null, output: out.output ?? null, raw: out.state === 'step-back-invalid' ? out.raw : undefined,
      error: failure ?? out.error ?? out.reason ?? null, truncated, failure, httpStatus: thrown?.status ?? null, errorCode: thrown?.code ?? null, usage: usage ?? null,
      inputTokens: usage?.usageMissing ? null : (usage?.input_tokens ?? null), outputTokens: usage?.usageMissing ? null : (usage?.output_tokens ?? null), costUsd: cost, spendSource: exact == null ? 'upper-bound' : 'usage',
    });
    // 401/403 (auth/permission) and 404 (model not found) hit every planned call the same way: ABORT, never keep charging estimates.
    if (thrown && AUTH_CONFIG_STATUSES.includes(Number(thrown.status)) && !stopped) {
      stopped = { reason: `provider-auth-or-config: ${row.arm} ${thrown.status}`, detail: thrown.message, after: `PR #${row.pr} R${row.checkpoint} ${row.arm}`, abort: true };
      deps.onRecord?.({ type: 'stopped', ...stopped });
    }
    // The cap is checked on METERED actuals too: a final call that overruns still stops the run (exit 5).
    if (spent > maxUsd && !stopped) {
      stopped = { reason: 'over-cap-after-call', detail: `spent $${spent.toFixed(4)} exceeds the $${maxUsd} cap after PR #${row.pr} R${row.checkpoint} ${row.arm}`, after: `PR #${row.pr} R${row.checkpoint} ${row.arm}` };
      deps.onRecord?.({ type: 'stopped', ...stopped });
    }
  }
  return { ...base, calls, spentUsd: spent, stopped };
}

/** Rebuild `{plan, calls, spentUsd, stopped}` from the results JSONL text. Scoring reads THIS, so it can be re-run any time. */
export function readResultsJsonl(text) {
  let plan = []; let maxUsd = null; let arms = null; let inputs = null; const calls = []; const unmeasured = {}; let stoppedRec = null; let tornFinalRecord = false;
  const str = String(text);
  const lines = str.split('\n');
  const lastIdx = (() => { for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return i; return -1; })();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (err) {
      // ONLY a torn FINAL line (no trailing newline: the write was cut off) is tolerated; the call in flight is lost.
      if (i === lastIdx && !str.endsWith('\n')) { tornFinalRecord = true; continue; }
      throw new Error(`results line ${i + 1} is not valid JSON (${err.message}); only a torn final line is tolerated`);
    }
    if (r.type === 'plan') { plan = r.plan; maxUsd = r.maxUsd; arms = r.arms; inputs = r.inputs ?? null; } else if (r.type === 'call') calls.push(r);
    else if (r.type === 'unmeasured') unmeasured[r.arm] = r.reason;
    else if (r.type === 'stopped') stoppedRec = { reason: r.reason, detail: r.detail, after: r.after, abort: r.abort === true };
  }
  const stoppedCall = calls.find((c) => c.status === 'skipped-budget');
  return { plan, calls, maxUsd, arms, inputs, unmeasured, tornFinalRecord, spentUsd: calls.reduce((s, c) => s + (c.costUsd || 0), 0), stopped: stoppedRec ?? (stoppedCall ? { reason: 'max-usd', before: `PR #${stoppedCall.pr} R${stoppedCall.checkpoint} ${stoppedCall.arm}` } : null) };
}

const emptyCost = () => ({ totalUsd: 0, measuredUsd: 0, estimatedUsd: 0, callsWithMissingUsage: 0, basis: 'none', inputTokens: 0, outputTokens: 0, calls: 0, valid: 0, costPerEarlyStop: null, costPerFalseStop: null, costPerValidDecision: null, perCheckpoint: [] });
const ratio = (usd, n) => (n > 0 ? usd / n : null);

/** Cost as a first-class result: metered USD and tokens per arm and per checkpoint, and cost per early stop / false stop / valid decision (null when the denominator is 0). */
function costOf(mine, { earlyStops, falseStops }) {
  const made = mine.filter((c) => c.status !== 'skipped-budget');
  const totalUsd = mine.reduce((s, c) => s + (c.costUsd || 0), 0);
  const valid = mine.filter((c) => c.status === 'ok').length;
  // Token totals cover ONLY calls whose usage was reported; a call with missing usage is never counted as 0 tokens.
  const metered = made.filter((c) => c.spendSource === 'usage');
  const bound = made.filter((c) => c.spendSource !== 'usage');
  const measuredUsd = metered.reduce((s, c) => s + (c.costUsd || 0), 0);
  const estimatedUsd = bound.reduce((s, c) => s + (c.costUsd || 0), 0);
  return {
    totalUsd, measuredUsd, estimatedUsd, callsWithMissingUsage: bound.length,
    basis: !made.length ? 'none' : bound.length === 0 ? 'measured' : metered.length === 0 ? 'bound' : `mixed (${bound.length} bound)`,
    calls: made.length, valid,
    inputTokens: metered.reduce((s, c) => s + (c.inputTokens || 0), 0), outputTokens: metered.reduce((s, c) => s + (c.outputTokens || 0), 0),
    costPerEarlyStop: ratio(totalUsd, earlyStops), costPerFalseStop: ratio(totalUsd, falseStops), costPerValidDecision: ratio(totalUsd, valid),
    perCheckpoint: made.map((c) => ({ pr: c.pr, checkpoint: c.checkpoint, action: c.action ?? null, status: c.status, costUsd: c.costUsd || 0, costBasis: c.spendSource === 'usage' ? 'measured' : 'bound', inputTokens: c.inputTokens ?? null, outputTokens: c.outputTokens ?? null })),
  };
}

/**
 * Score with the pre-registered rule. `truth` is the SCORING file's `truth` map (pr -> {label, acceptedHighRounds}).
 * A PR's stop is its FIRST checkpoint with a stop/structural answer; `earlyStops` counts bad PRs stopped with no later
 * accepted HIGH, `falseStops` counts any PR stopped before a later accepted HIGH. An arm with calls missing is
 * `incomplete`, never adopted.
 */
export function scoreReplay({ calls, truth, arms, plan, unmeasured = {} }) {
  const out = {};
  for (const arm of arms) {
    if (arm === 'none') { out.none = { earlyStops: 0, falseStops: 0, invalidOutputs: 0, truncated: 0, cost: emptyCost(), verdict: 'recorded-baseline (computed, not called)' }; continue; }
    if (unmeasured[arm]) { out[arm] = { unmeasured: true, reason: unmeasured[arm], earlyStops: 0, falseStops: 0, invalidOutputs: 0, truncated: 0, complete: false, verdict: `unmeasured (${unmeasured[arm]})`, cost: emptyCost() }; continue; }
    const mine = calls.filter((c) => c.arm === arm);
    const idOf = (c) => `${c.pr}@${c.checkpoint}`;
    const plannedIds = new Set(plan.filter((p) => p.arm === arm).map(idOf));
    // Completeness = every planned identity has a VALID decision: an invalid or truncated checkpoint leaves the arm incomplete.
    const doneIds = new Set(mine.filter((c) => c.status === 'ok').map(idOf));
    const planned = plannedIds.size; const done = doneIds.size;
    // Completeness is the planned IDENTITY set against the completed one, never a count: a missing or an extra identity is incomplete.
    const identitiesMatch = planned > 0 && [...plannedIds].every((k) => doneIds.has(k)) && [...doneIds].every((k) => plannedIds.has(k));
    const byPr = new Map();
    for (const c of mine) if (c.status === 'ok' && STOPPING_ACTIONS.includes(c.action)) {
      if (!byPr.has(c.pr) || c.checkpoint < byPr.get(c.pr)) byPr.set(c.pr, c.checkpoint);
    }
    let earlyStops = 0; let falseStops = 0; const detail = [];
    for (const [pr, cp] of byPr) {
      const t = truth[pr];
      if (!t) { detail.push({ pr, checkpoint: cp, outcome: 'no-ground-truth' }); continue; }
      const later = t.acceptedHighRounds.some((r) => r > cp);
      if (later) { falseStops++; detail.push({ pr, checkpoint: cp, outcome: 'false-stop' }); }
      else if (t.label === 'bad') { earlyStops++; detail.push({ pr, checkpoint: cp, outcome: 'early-stop' }); }
      else detail.push({ pr, checkpoint: cp, outcome: 'harmless-stop' });
    }
    const invalidOutputs = mine.filter((c) => c.status === 'invalid').length;
    const truncated = mine.filter((c) => c.status === 'truncated').length;
    const providerFailures = mine.filter((c) => c.status === 'provider-failure').length;
    // A stop on a PR with no ground-truth entry cannot be scored: the arm is incomplete, never adoptable.
    const missingTruth = detail.some((d) => d.outcome === 'no-ground-truth');
    const complete = identitiesMatch && !missingTruth;
    const adopted = complete && falseStops <= ADOPTION_RULE.maxFalseStops && earlyStops >= ADOPTION_RULE.minEarlyStops;
    out[arm] = {
      earlyStops, falseStops, invalidOutputs, truncated, providerFailures, complete, calls: { planned, completed: done }, missingTruth, detail,
      cost: costOf(mine, { earlyStops, falseStops }),
      verdict: !complete ? 'incomplete (not adopted)' : adopted ? 'adopted' : 'not adopted',
    };
  }
  const badPrs = Object.values(truth).filter((t) => t.label === 'bad').length;
  return { rule: { ...ADOPTION_RULE, ofBadPrs: badPrs }, basis: BOUND_NOTE, arms: out };
}

/** The dry-run text: every planned call, the per-arm planned calls and upper bounds, and the estimated total; nothing sent. */
export function renderDryRun({ plan, unrecoverable, estimatedUsd, maxUsd = null, preparedPrs = 0, controls = [], unmeasured = {}, sdkAvailable = null }) {
  const lines = ['step-back-replay DRY RUN - no provider call was made'];
  plan.forEach((p, i) => lines.push(`  call ${i + 1}: PR #${p.pr} R${p.checkpoint} arm=${p.arm} model=${p.model} pack=${p.packChars} chars upper bound $${p.upperBoundUsd.toFixed(4)}`));
  const perArm = new Map();
  for (const p of plan) { const a = perArm.get(p.arm) || { model: p.model, calls: 0, usd: 0 }; a.calls++; a.usd += p.upperBoundUsd; perArm.set(p.arm, a); }
  for (const [arm, a] of perArm) lines.push(`  arm ${arm}: model=${a.model} planned calls ${a.calls}, upper bound $${a.usd.toFixed(4)}`);
  for (const [arm, reason] of Object.entries(unmeasured)) lines.push(`  arm ${arm}: UNMEASURED, 0 planned calls (${reason})`);
  if (sdkAvailable !== null) lines.push(`higher arm: sdk available = ${sdkAvailable}`);
  lines.push(BOUND_NOTE);
  lines.push(`planned calls: ${plan.length} (${preparedPrs} PR-checkpoints), UPPER-BOUND total $${estimatedUsd.toFixed(2)}${maxUsd ? ` against a hard stop of $${Number(maxUsd).toFixed(2)}` : ''}`);
  if (unrecoverable.length) lines.push(`unrecoverable (excluded, never imputed): ${unrecoverable.map((u) => `#${u.pr}${u.checkpoint ? ` R${u.checkpoint}` : ''} (${u.reason})`).join('; ')}`);
  if (controls.length) lines.push(`controls (no checkpoint, no call): ${controls.map((c) => `#${c.pr} (${c.rounds} rounds)`).join(', ')}`);
  return lines.join('\n');
}

/** The human score table: arm | model | calls | valid | early | false | invalid | truncated | USD | $/early stop | $/false stop. */
export function renderScoreTable(score, models = {}) {
  const usd = (n) => (n == null ? '-' : `$${n.toFixed(4)}`);
  const rows = [['arm', 'model', 'calls', 'valid', 'early', 'false', 'invalid', 'truncated', 'USD', 'basis', '$/early stop', '$/false stop']];
  for (const [arm, s] of Object.entries(score.arms)) {
    const c = s.cost || emptyCost();
    rows.push([arm, models[arm] || '-', c.calls, c.valid, s.earlyStops, s.falseStops, s.invalidOutputs, s.truncated ?? 0, usd(c.totalUsd), c.basis, usd(c.costPerEarlyStop), usd(c.costPerFalseStop)].map(String));
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((v, i) => v.padEnd(w[i])).join(' | ').trimEnd()).join('\n');
}

/**
 * Store-export datasets: snapshots are reconstructed from the exported events and repo content is read with
 * `git show <audited_sha>:<path>` through a virtual revision fs — never a checkout, never the current tree.
 * A revision git cannot read makes that checkpoint unrecoverable (counted), not a junk pack.
 */
async function prepareStoreItems({ dataset, deps }) {
  const exp = deps.readExport ? deps.readExport(dataset.exportPath) : JSON.parse(fs.readFileSync(dataset.exportPath, 'utf8'));
  const items = []; const unrecoverable = []; const controls = [];
  for (const pr of dataset.prs) {
    if (pr.status !== 'recoverable') { unrecoverable.push({ pr: pr.pr, checkpoint: null, reason: pr.reason }); continue; }
    if (pr.control) controls.push({ pr: pr.pr, rounds: pr.rounds, note: 'fewer than 3 rounds: the step-back cannot fire' });
    for (const cp of pr.checkpoints) {
      if (cp.status !== 'recoverable') { unrecoverable.push({ pr: pr.pr, checkpoint: cp.checkpoint, reason: cp.reason }); continue; }
      const snap = buildExportSnapshot({ exp, runIds: pr.runIds, checkpoint: cp.checkpoint });
      if (!snap.ok) { unrecoverable.push({ pr: pr.pr, checkpoint: cp.checkpoint, reason: snap.reason }); continue; }
      const rev = (deps.openRevision || createRevisionFs)({ sha: snap.snapshot.auditedSha, cwd: deps.cwd || process.cwd() });
      if (!rev.ok) { unrecoverable.push({ pr: pr.pr, checkpoint: cp.checkpoint, reason: rev.reason }); continue; }
      const pack = await buildStepBackPack({
        repoRoot: rev.root, fsImpl: rev.fs, planFile: snap.snapshot.planFile, ledgerEntries: snap.snapshot.ledgerEntries, rounds: snap.snapshot.rounds,
        repoFiles: rev.repoFiles, archNeighbours: null, ...(deps.topicOf ? { topicOf: deps.topicOf } : {}),
      });
      items.push({ pr: pr.pr, label: pr.label, checkpoint: cp.checkpoint, auditedSha: snap.snapshot.auditedSha, pack, inputChars: STEP_BACK_SYSTEM_PROMPT.length + pack.text.length });
    }
  }
  return { items, unrecoverable, controls };
}
