/**
 * @fileoverview Arm-eval run orchestration (produce → judge → cross-check → persist).
 *
 * Plan: docs/plans/arm-eval-framework.md §6 (CLIs) / D7 (inert). Ties the pieces
 * together for ONE session (one task, all arms): build the repo-intent pack,
 * produce each arm's output, judge the set blinded+double-pass, run the objective
 * cross-checks, and persist the session/runs/outputs/judgments/crosschecks.
 *
 * INERT by default: refuses without a budget cap (no unbounded burn) and no-ops
 * off-cloud. Egress is enforced inside the producers + judge. PURE orchestration
 * — producers, judge, cross-checks, and store are injectable (`deps`) for tests.
 *
 * @module scripts/lib/arm-eval/run
 */

import { randomUUID } from 'node:crypto';
import { getExperiment } from './experiments.mjs';
import { buildIntentContext } from './intent-context.mjs';
import { judgeSession } from './judge.mjs';
import { runCrossChecks } from './cross-checks.mjs';
import { producePlan } from './producers/plan.mjs';
import { produceBrainstorm } from './producers/brainstorm.mjs';
import { parsePlanIntent } from './plan-seed.mjs';
import { exportSession } from './export.mjs';
import { redactSecrets as shapeRedact } from '../secret-patterns.mjs';

function defaultDeps() {
  return {
    producePlan, produceBrainstorm, judgeSession, runCrossChecks, buildIntentContext,
    // store writers (dynamic import to keep this module load-light off-cloud)
    store: null,
    // cross-check underlying tools (unwired → checks report 'unavailable')
    crossCheckDeps: {},
    seed: null,
  };
}

/**
 * Run one arm-eval session.
 * @param {{ experimentType:string, task:string, repoId?:string|null, phase?:string,
 *   seed?:number, budgetCapEur?:number|null, deps?:object }} input
 * @returns {Promise<{ state:string, sessionId?:string, arms?:string[], judged?:boolean,
 *   conformance?:Record<string,boolean>, missing?:string[] }>}
 */
export async function runArmEvalSession({ experimentType, task, repoId = null, phase = 'prospective', seed = null, budgetCapEur = null, deps = {} }) {
  const d = { ...defaultDeps(), ...deps };
  if (typeof task !== 'string' || !task.trim()) throw new Error('runArmEvalSession: task/topic required');
  const exp = getExperiment(experimentType);   // throws on unknown

  // Budget refusal (D7 — no unbounded burn). The framework spends real API on
  // produce + judge; require an explicit ceiling.
  if (budgetCapEur == null) return { state: 'refused-no-budget' };

  const store = d.store || await import('../store/arm-eval.mjs');
  const schema = await store.armEvalSchemaReady();
  if (!schema.cloud) return { state: 'skipped-cloud-off' };
  if (!schema.ready) return { state: 'refused-schema-preflight', missing: schema.missing };

  const sessionId = randomUUID();
  const runSeed = Number.isFinite(seed) ? (seed >>> 0) : (Math.floor(Math.random() * 0xffffffff) >>> 0);

  // Repo-intent pack (plan experiment grounds the coherence/intent dims).
  const intent = experimentType === 'plan-authoring' ? d.buildIntentContext({ repoRoot: process.cwd() }) : { present: false, pack: null, intentScorable: false };

  // task_text: verbatim prompt for the committed archive (shape-redacted at
  // write; the egress gate in the producers covers the wire path separately).
  await store.recordSession({ sessionId, repoId, experimentType, taskId: hashTask(task), taskText: shapeRedact(task).text, phase, configVersion: '1', rubricVersion: '1', seed: runSeed });

  // ── Produce each arm's output ──────────────────────────────────────────────
  const outputs = [];
  const conformance = {};
  for (const arm of exp.arms) {
    const runId = randomUUID();
    let produced;
    if (experimentType === 'plan-authoring') produced = await d.producePlan({ task, arm, contextPack: intent.pack, deps: d.producerDeps });
    else produced = await d.produceBrainstorm({ topic: task, arm, deps: d.producerDeps });
    conformance[arm.id] = !!produced.conformant;
    await store.recordRun({ runId, sessionId, arm: arm.id, resolvedModel: { models: arm.models, resolved: produced.resolvedModel || produced.resolvedModels } });
    if (produced.outputHash) {
      // Store the produced text as output_ref so the blinded human-adjudication
      // queue can show it (label-only, arm hidden) without re-generating.
      await store.recordOutput({ runId, outputHash: produced.outputHash, outputRef: produced.output ?? null, producerConformant: !!produced.conformant, normalized: false });
      if (produced.conformant) outputs.push({ arm: arm.id, runId, outputHash: produced.outputHash, text: produced.output });
    }
  }

  // ── Judge the conformant outputs (blinded, double-pass) ─────────────────────
  let judged = false;
  if (outputs.length >= 2) {
    const jr = await d.judgeSession({ experimentType, outputs, contextPack: intent.pack, intentScorable: intent.intentScorable, seed: runSeed, deps: d.judgeDeps });
    if (jr.conformant) {
      judged = true;
      for (let pass = 0; pass < jr.passes.length; pass++) {
        for (const [label, arm] of Object.entries(jr.labelToArm)) {
          const o = outputs.find((x) => x.arm === arm);
          if (o && jr.passes[pass][label]) {
            await store.recordJudgment({ runId: o.runId, outputHash: o.outputHash, judgePass: pass + 1, presentationOrder: Number(label.replace('output-', '')), rubricVersion: '1', scores: jr.passes[pass][label] });
          }
        }
      }
    }
  }

  // ── Objective cross-checks (plan experiment) ────────────────────────────────
  if (exp.crossChecks.length && experimentType === 'plan-authoring') {
    for (const o of outputs) {
      const results = await d.runCrossChecks({ checks: exp.crossChecks, planText: o.text, planIntent: parsePlanIntent(o.text), intentDescription: task, deps: d.crossCheckDeps });
      for (const r of results) await store.recordCrossCheck({ runId: o.runId, checkName: r.checkName, checkVersion: r.checkVersion, status: r.status, score: r.score, findings: r.findings, evidenceRefs: r.evidenceRefs, failureReason: r.failureReason });
    }
  }

  // ── Committed archive export (auto-capture; best-effort, never fails the run) ─
  let archived = null;
  try {
    const ex = await exportSession(sessionId, { store: d.store || undefined });
    archived = ex.written ? ex.file : null;
  } catch (err) {
    process.stderr.write(`  [arm-eval] archive export failed (non-fatal): ${err.message}\n`);
  }

  return { state: 'ran', sessionId, arms: exp.arms.map((a) => a.id), judged, conformance, seed: runSeed, archived };
}

/** Stable task-id: a normalized content hash (whitespace/case) — the diversity unit. */
export function hashTask(task) {
  const norm = String(task).toLowerCase().replace(/\s+/g, ' ').trim();
  // small FNV-1a → hex (deterministic, no crypto import needed for a short id)
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) { h ^= norm.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return 'task-' + (h >>> 0).toString(16).padStart(8, '0');
}
