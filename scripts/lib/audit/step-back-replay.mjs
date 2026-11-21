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
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateCostUsd, preflightEstimateUsd } from '../brainstorm/pricing.mjs';
import { buildCheckpointSnapshot } from './step-back-snapshot.mjs';
import { buildStepBackPack, initialStepBackRecord, runStepBack, STEP_BACK_SYSTEM_PROMPT } from './step-back.mjs';
import { createStepBackProvider, STEP_BACK_MAX_OUTPUT_TOKENS } from './step-back-provider.mjs';

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
export async function prepareItems({ dataset, deps = {} }) {
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

/** Per-call cost estimate for an arm: preflight, replaced by measured cost after 2 measured calls of that arm. */
export function estimateCall({ model, inputChars, measured }) {
  const pre = preflightEstimateUsd({ modelId: model, inputChars, maxOutputTokens: STEP_BACK_MAX_OUTPUT_TOKENS });
  if (!measured || measured.length < 2) return pre;
  const ratio = measured.reduce((s, m) => s + m.cost, 0) / Math.max(1e-9, measured.reduce((s, m) => s + m.pre, 0));
  return Math.max(pre * ratio, ...measured.map((m) => m.cost));
}

/**
 * Run (or plan) the replay.
 * @param {object} a
 * @param {object} a.dataset - the frozen dataset
 * @param {string[]} a.arms - subset of REPLAY_ARMS
 * @param {number} a.maxUsd - hard stop; required unless dryRun
 * @param {boolean} [a.dryRun]
 * @param {object} [a.deps] - makeProvider(arm) => {model, call}; checkout; readJson; topicOf
 * @returns {Promise<{plan: object[], calls: object[], unrecoverable: object[], spentUsd: number, stopped: object|null, estimatedUsd: number}>}
 */
export async function runReplay({ dataset, arms, maxUsd, dryRun = false, deps = {} }) {
  const paid = arms.filter((a) => PAID_ARMS.includes(a));
  if (!dryRun && !(Number.isFinite(maxUsd) && maxUsd > 0)) throw new Error('runReplay: a positive --max-usd is required for a paid run');
  const makeProvider = deps.makeProvider || ((arm) => createStepBackProvider(arm));
  const providers = Object.fromEntries(paid.map((a) => [a, makeProvider(a)]));
  const { items, unrecoverable } = await prepareItems({ dataset, deps });

  const measured = Object.fromEntries(paid.map((a) => [a, []]));
  const plan = []; const calls = [];
  let spent = 0; let stopped = null;
  for (const item of items) {
    for (const arm of paid) {
      const prov = providers[arm];
      const pre = preflightEstimateUsd({ modelId: prov.model, inputChars: item.inputChars, maxOutputTokens: STEP_BACK_MAX_OUTPUT_TOKENS });
      const est = estimateCall({ model: prov.model, inputChars: item.inputChars, measured: measured[arm] });
      const row = { pr: item.pr, checkpoint: item.checkpoint, arm, model: prov.model, packChars: item.pack.text.length, estimateUsd: est };
      plan.push(row);
      if (dryRun) continue;
      if (stopped || spent + est > maxUsd) {
        stopped ||= { reason: 'max-usd', detail: `spent $${spent.toFixed(4)} + estimate $${est.toFixed(4)} would exceed the $${maxUsd} cap`, before: `PR #${item.pr} R${item.checkpoint} ${arm}` };
        calls.push({ ...row, status: 'skipped-budget', action: null, costUsd: 0 });
        continue;
      }
      const record = initialStepBackRecord({ round: item.checkpoint, signals: { anyFires: true, unmeasured: [] } });
      const { record: out, usage } = await runStepBack({ record, pack: item.pack, provider: prov.call, model: prov.model });
      let cost = 0; let spendSource = 'none';
      if (usage) {
        const exact = usage.usageMissing ? null : estimateCostUsd({ modelId: prov.model, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens });
        cost = exact ?? est; spendSource = exact == null ? 'estimate' : 'usage';
        spent += cost; measured[arm].push({ cost, pre });
      }
      calls.push({
        ...row, status: out.state === 'step-back-valid' ? 'ok' : out.state === 'step-back-invalid' ? 'invalid' : 'unavailable',
        action: out.output?.action ?? null, output: out.output ?? null, raw: out.state === 'step-back-invalid' ? out.raw : undefined,
        error: out.error ?? out.reason ?? null, usage: usage ?? null, costUsd: cost, spendSource,
      });
    }
  }
  return { plan, calls, unrecoverable, spentUsd: spent, stopped, estimatedUsd: plan.reduce((s, p) => s + p.estimateUsd, 0), preparedPrs: items.length };
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
    const planned = plan.filter((p) => p.arm === arm).length;
    const done = mine.filter((c) => c.status === 'ok' || c.status === 'invalid').length;
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
    const complete = planned > 0 && done === planned;
    const adopted = complete && falseStops <= ADOPTION_RULE.maxFalseStops && earlyStops >= ADOPTION_RULE.minEarlyStops;
    out[arm] = {
      earlyStops, falseStops, invalidOutputs, complete, calls: { planned, completed: done }, detail,
      verdict: !complete ? 'incomplete (not adopted)' : adopted ? 'adopted' : 'not adopted',
    };
  }
  const badPrs = Object.values(truth).filter((t) => t.label === 'bad').length;
  return { rule: { ...ADOPTION_RULE, ofBadPrs: badPrs }, arms: out };
}

/** The dry-run text: every planned call and the estimated total, nothing sent. */
export function renderDryRun({ plan, unrecoverable, estimatedUsd, maxUsd = null, preparedPrs = 0 }) {
  const lines = ['step-back-replay DRY RUN - no provider call was made'];
  plan.forEach((p, i) => lines.push(`  call ${i + 1}: PR #${p.pr} R${p.checkpoint} arm=${p.arm} model=${p.model} pack=${p.packChars} chars est $${p.estimateUsd.toFixed(4)}`));
  lines.push(`planned calls: ${plan.length} (${preparedPrs} PR-checkpoints), estimated total $${estimatedUsd.toFixed(2)}${maxUsd ? ` against a hard stop of $${Number(maxUsd).toFixed(2)}` : ''}`);
  if (unrecoverable.length) lines.push(`unrecoverable (excluded, never imputed): ${unrecoverable.map((u) => `#${u.pr}${u.checkpoint ? ` R${u.checkpoint}` : ''} (${u.reason})`).join('; ')}`);
  return lines.join('\n');
}
