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
import { createStepBackProvider, STEP_BACK_MAX_OUTPUT_TOKENS } from './step-back-provider.mjs';

/** Cost of a metered call in USD, or null when the model is unpriced (tier-aware: input tokens are forwarded). */
export function estimateCostUsd({ modelId, inputTokens, outputTokens }) {
  const rate = priceFor(modelId, { inputTokens });
  return rate ? (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000 : null;
}

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

export const REPLAY_ARMS = Object.freeze(['none', 'same', 'different']);
export const PAID_ARMS = Object.freeze(['same', 'different']);
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
  const makeProvider = deps.makeProvider || ((arm) => createStepBackProvider(arm));
  const providers = Object.fromEntries(paid.map((a) => [a, makeProvider(a)]));
  const prepared = await prepareItems({ dataset, deps });
  const { items, unrecoverable } = prepared;

  const plan = [];
  for (const item of items) {
    for (const arm of paid) {
      const prov = providers[arm];
      const upperUsd = upperBoundUsd({ modelId: prov.model, inputChars: item.inputChars, outputCeilingTokens: prov.outputCeilingTokens });
      plan.push({ pr: item.pr, checkpoint: item.checkpoint, arm, model: prov.model, packChars: item.pack.text.length, estimateUsd: upperUsd, upperBoundUsd: upperUsd, item });
    }
  }
  const publicPlan = plan.map(({ item, ...row }) => row);
  const estimatedUsd = publicPlan.reduce((s, p) => s + p.upperBoundUsd, 0);
  const base = { plan: publicPlan, unrecoverable, controls: prepared.controls || [], estimatedUsd, upperBoundTotalUsd: estimatedUsd, preparedPrs: items.length };
  if (dryRun) return { ...base, calls: [], spentUsd: 0, stopped: null };

  deps.onRecord?.({ type: 'plan', plan: publicPlan, maxUsd, arms });
  const calls = []; let spent = 0; let stopped = null;
  for (const row of plan) {
    const { item, ...meta } = row;
    const emit = (c) => { calls.push(c); deps.onRecord?.({ type: 'call', ...c }); };
    if (stopped || spent + row.upperBoundUsd > maxUsd) {
      stopped ||= { reason: 'max-usd', detail: `spent $${spent.toFixed(4)} + upper bound $${row.upperBoundUsd.toFixed(4)} would exceed the $${maxUsd} cap`, before: `PR #${row.pr} R${row.checkpoint} ${row.arm}` };
      emit({ ...meta, status: 'skipped-budget', action: null, costUsd: 0, spendSource: 'none' });
      continue;
    }
    const prov = providers[row.arm];
    const record = initialStepBackRecord({ round: row.checkpoint, signals: { anyFires: true, unmeasured: [] } });
    const { record: out, usage } = await runStepBack({ record, pack: item.pack, provider: prov.call, model: prov.model });
    const exact = usage && !usage.usageMissing && Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens)
      ? estimateCostUsd({ modelId: prov.model, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }) : null;
    // No usable usage (absent, unpriced model, or an error after the provider may have processed the call): charge the bound.
    const cost = exact ?? row.upperBoundUsd;
    spent += cost;
    emit({
      ...meta, status: out.state === 'step-back-valid' ? 'ok' : out.state === 'step-back-invalid' ? 'invalid' : 'unavailable',
      action: out.output?.action ?? null, output: out.output ?? null, raw: out.state === 'step-back-invalid' ? out.raw : undefined,
      error: out.error ?? out.reason ?? null, usage: usage ?? null, costUsd: cost, spendSource: exact == null ? 'upper-bound' : 'usage',
    });
  }
  return { ...base, calls, spentUsd: spent, stopped };
}

/** Rebuild `{plan, calls, spentUsd, stopped}` from the results JSONL text. Scoring reads THIS, so it can be re-run any time. */
export function readResultsJsonl(text) {
  let plan = []; let maxUsd = null; let arms = null; const calls = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.type === 'plan') { plan = r.plan; maxUsd = r.maxUsd; arms = r.arms; } else if (r.type === 'call') calls.push(r);
  }
  const stoppedCall = calls.find((c) => c.status === 'skipped-budget');
  return { plan, calls, maxUsd, arms, spentUsd: calls.reduce((s, c) => s + (c.costUsd || 0), 0), stopped: stoppedCall ? { reason: 'max-usd', before: `PR #${stoppedCall.pr} R${stoppedCall.checkpoint} ${stoppedCall.arm}` } : null };
}

/**
 * Score with the pre-registered rule. `truth` is the SCORING file's `truth` map (pr -> {label, acceptedHighRounds}).
 * A PR's stop is its FIRST checkpoint with a stop/structural answer; `earlyStops` counts bad PRs stopped with no later
 * accepted HIGH, `falseStops` counts any PR stopped before a later accepted HIGH. An arm with calls missing is
 * `incomplete`, never adopted.
 */
export function scoreReplay({ calls, truth, arms, plan }) {
  const out = {};
  for (const arm of arms) {
    if (arm === 'none') { out.none = { earlyStops: 0, falseStops: 0, invalidOutputs: 0, verdict: 'recorded-baseline (computed, not called)' }; continue; }
    const mine = calls.filter((c) => c.arm === arm);
    const idOf = (c) => `${c.pr}@${c.checkpoint}`;
    const plannedIds = new Set(plan.filter((p) => p.arm === arm).map(idOf));
    const doneIds = new Set(mine.filter((c) => c.status === 'ok' || c.status === 'invalid').map(idOf));
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
    // A stop on a PR with no ground-truth entry cannot be scored: the arm is incomplete, never adoptable.
    const missingTruth = detail.some((d) => d.outcome === 'no-ground-truth');
    const complete = identitiesMatch && !missingTruth;
    const adopted = complete && falseStops <= ADOPTION_RULE.maxFalseStops && earlyStops >= ADOPTION_RULE.minEarlyStops;
    out[arm] = {
      earlyStops, falseStops, invalidOutputs, complete, calls: { planned, completed: done }, missingTruth, detail,
      verdict: !complete ? 'incomplete (not adopted)' : adopted ? 'adopted' : 'not adopted',
    };
  }
  const badPrs = Object.values(truth).filter((t) => t.label === 'bad').length;
  return { rule: { ...ADOPTION_RULE, ofBadPrs: badPrs }, arms: out };
}

/** The dry-run text: every planned call and the estimated total, nothing sent. */
export function renderDryRun({ plan, unrecoverable, estimatedUsd, maxUsd = null, preparedPrs = 0, controls = [] }) {
  const lines = ['step-back-replay DRY RUN - no provider call was made'];
  plan.forEach((p, i) => lines.push(`  call ${i + 1}: PR #${p.pr} R${p.checkpoint} arm=${p.arm} model=${p.model} pack=${p.packChars} chars upper bound $${p.upperBoundUsd.toFixed(4)}`));
  lines.push(`planned calls: ${plan.length} (${preparedPrs} PR-checkpoints), UPPER-BOUND total $${estimatedUsd.toFixed(2)}${maxUsd ? ` against a hard stop of $${Number(maxUsd).toFixed(2)}` : ''}`);
  if (unrecoverable.length) lines.push(`unrecoverable (excluded, never imputed): ${unrecoverable.map((u) => `#${u.pr}${u.checkpoint ? ` R${u.checkpoint}` : ''} (${u.reason})`).join('; ')}`);
  if (controls.length) lines.push(`controls (no checkpoint, no call): ${controls.map((c) => `#${c.pr} (${c.rounds} rounds)`).join(', ')}`);
  return lines.join('\n');
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
