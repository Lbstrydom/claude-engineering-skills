/**
 * @fileoverview Model-A/B/C + arm-evaluation registry commands
 * (docs/plans/cross-skill-command-registry.md — Cluster D, Phase 5).
 *
 * Behaviour-preserving moves. Two properties of this family are load-bearing
 * and easy to erode, so they are stated where they live:
 *
 * 1. **Adjudication is a HUMAN activity by design** (the scorer's
 *    anti-circularity), so the human worksheet is the DEFAULT surface and
 *    `--json` is the escape hatch. A raw-JSON default failed the operator
 *    twice before that inverted.
 * 2. **Execution eligibility is per-call, not env-global.** Only the CLI's own
 *    entry point may authorise a spending run; env flags express "the window
 *    is open", never "spend now".
 */
import { CommandError } from '../dispatch.mjs';

/** Legacy `try { … } catch { emitError('EXCEPTION', err.message) }` shape. */
async function passthroughErrors(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CommandError) throw err;
    throw new CommandError('EXCEPTION', err.message);
  }
}

/** Shared budget/decision inputs for the two model-ab reporting commands. */
async function decisionInputs(ctx, runId) {
  const { evaluateDecision, DECISION_CONSTANTS } = await import('../../model-ab-decision.mjs');
  const { auditShadowConfig } = await import('../../config.mjs');
  const findings = await ctx.deps.getModelAbFindingScores({ runId });
  const costs = await ctx.deps.getModelAbArmCost({});
  const decision = evaluateDecision(findings.rows, costs.rows, DECISION_CONSTANTS);
  const spentEur = await ctx.deps.cumulativeSpendEur({ activeTtlMs: auditShadowConfig.reservationTtlMs });
  return { findings, decision, spentEur, capEur: auditShadowConfig.budgetEur };
}

/** `model-ab-stats` — scorer rows + the cost–quality frontier + spend vs budget. */
export async function modelAbStatsCmd(ctx) {
  // §2b F3: cloud-off is a SUPPORTED MODE, not a failure — AGENTS.md says so
  // outright, and 55 of the 60 originally-measured invocations already reported
  // it as {ok:true, cloud:false}. Reporting it as a failure made a machine that
  // simply has no store indistinguishable from one whose write broke.
  if (!ctx.cloud.enabled) return { ok: true, cloud: false, rows: [] };
  const runId = ctx.flag('run-id');
  const eff = await ctx.deps.getModelAbEffectiveness({ runId });
  const { decision, spentEur, capEur } = await decisionInputs(ctx, runId);
  return {
    ok: true, cloud: eff.cloud, rows: eff.rows,
    frontier: decision.arms, // per-arm score/recall/€-frontier
    status: decision.status,
    distinctAssignments: decision.distinctAssignments,
    budget: { spentEur, capEur },
  };
}

/** `model-ab-decision` — two-level verdict: quality GATE → weighted RANK. */
export async function modelAbDecisionCmd(ctx) {
  // §2b F3: cloud-off is a SUPPORTED MODE, not a failure — AGENTS.md says so
  // outright, and 55 of the 60 originally-measured invocations already reported
  // it as {ok:true, cloud:false}. Reporting it as a failure made a machine that
  // simply has no store indistinguishable from one whose write broke.
  if (!ctx.cloud.enabled) return { ok: true, cloud: false };
  const runId = ctx.flag('run-id');
  const { findings, decision, spentEur, capEur } = await decisionInputs(ctx, runId);
  return {
    ok: true, cloud: findings.cloud,
    constants: decision.constants,
    status: decision.status,
    reason: decision.reason,
    baselineArm: decision.baselineArm,
    distinctAssignments: decision.distinctAssignments,
    totalAcceptedClusters: decision.totalAcceptedClusters,
    arms: decision.arms,
    ranking: decision.ranking,
    budget: { spentEur, capEur, exhausted: capEur != null && spentEur != null && spentEur >= capEur },
  };
}

/**
 * `model-ab-adjudicate` — the blinded human queue, or a ruling writeback.
 *
 * With no `--action` it PRESENTS the queue (source_model hidden); with
 * `--action` it writes the outcome. The worksheet is the default surface
 * because confirmed human rulings are the scorer's ONLY ground truth.
 */
export async function modelAbAdjudicateCmd(ctx) {
  const action = ctx.flag('action');
  // ARGV VALIDATION BEFORE THE CLOUD GATE (§2b F3). An argument contract does
  // not depend on store availability, and the old order made that concrete:
  // with cloud off, `--action bogus` returned the cloud-off envelope having
  // never been validated. Under F3 that envelope became `ok:true`, so a typo'd
  // action would have reported SUCCESS — the flip would have turned a wrong
  // exit code into a wrong answer. Found by the F3 fixture census, not by the
  // audit: four fixtures named as "refusals" were nothing of the kind.
  if (action) {
    const validActions = new Set(['accepted', 'dismissed', 'duplicate', 'not-actionable']);
    if (!validActions.has(action)) {
      throw new CommandError('BAD_INPUT', `--action must be one of ${[...validActions].join('|')}, got '${action}'`);
    }
    if (!ctx.flag('run-id') || !ctx.flag('fingerprint')) {
      throw new CommandError('BAD_INPUT', '--run-id and --fingerprint are required with --action');
    }
    if (action === 'duplicate' && !ctx.flag('canonical')) {
      throw new CommandError('BAD_INPUT', "--action duplicate requires --canonical <fingerprint>");
    }
  }
  // §2b F3: cloud-off is a SUPPORTED MODE, not a failure — AGENTS.md says so
  // outright, and 55 of the 60 originally-measured invocations already reported
  // it as {ok:true, cloud:false}. Reporting it as a failure made a machine that
  // simply has no store indistinguishable from one whose write broke.
  if (!ctx.cloud.enabled) return { ok: true, cloud: false };

  if (!action) {
    const runId = ctx.flag('run-id');
    const limit = Number(ctx.flag('limit')) || 50;
    const q = await ctx.deps.getModelAbAdjudicationQueue({ runId, limit });
    if (!ctx.hasFlag('json')) {
      const { renderAdjudicationWorksheet } = await import('../../adjudication-worksheet.mjs');
      const { writeFileSync, mkdirSync, existsSync, readFileSync } = await import('node:fs');
      // `--suggestions <file>`: advisory pre-judgments rendered per item with
      // the command pre-filled. The file itself NEVER writes rulings — the
      // human confirms by pasting or overrides by editing.
      let suggestions = {};
      const sugPath = ctx.flag('suggestions');
      if (sugPath) {
        try { suggestions = JSON.parse(readFileSync(sugPath, 'utf8')); }
        catch (err) { throw new CommandError('BAD_INPUT', `--suggestions ${sugPath}: ${err.message}`); }
      }
      const md = renderAdjudicationWorksheet({
        title: `Model-A/B/C blinded adjudication${runId ? ` — run ${runId.slice(0, 8)}…` : ''}`,
        introLines: [
          'Blinded: arm identity is hidden; the `stage` tag (oss-gen/gpt-round/gemini) is a pipeline stage, not an arm.',
          'Your confirmed rulings are the scorer\'s ONLY ground truth (anti-circularity).',
          ...(sugPath ? [`Suggested verdicts loaded from ${sugPath} — advisory only, you confirm or override each.`] : []),
        ],
        items: q.items.map((f) => ({
          runId: f.run_id, fingerprint: f.finding_fingerprint, severity: f.severity,
          stage: f.stage, category: f.category, file: f.primary_file, detail: f.detail_snapshot,
          suggestion: suggestions[f.finding_fingerprint] || undefined,
        })),
        actions: ['accepted', 'dismissed', 'not-actionable', 'duplicate'],
        duplicateHowTo: { action: 'duplicate', canonicalHint: '--canonical ROOT_FINGERPRINT' },
        commandFor: (it, a, canonical) => `node scripts/cross-skill.mjs model-ab-adjudicate --run-id ${it.runId} --fingerprint ${it.fingerprint} --action ${a}${canonical ? ` --canonical ${canonical}` : ''}`,
        generatedAt: new Date().toISOString(),
      });
      // Discoverable home next to the arm-eval session archives (gitignored —
      // Category-A volatile state); .audit/ fallback.
      const dir = existsSync('docs/arm-eval') ? 'docs/arm-eval/worksheets' : '.audit';
      const out = ctx.flag('out') || `${dir}/model-ab-adjudication-worksheet.md`;
      mkdirSync(dir, { recursive: true });
      writeFileSync(out, md);
      process.stderr.write(`  [model-ab-adjudicate] worksheet: ${q.items.length} pending finding(s) → ${out}\n  (raw queue JSON: add --json)\n`);
      return { ok: true, cloud: q.cloud, blinded: true, count: q.items.length, worksheet: out };
    }
    return { ok: true, cloud: q.cloud, blinded: true, count: q.items.length, queue: q.items };
  }

  const validActions = new Set(['accepted', 'dismissed', 'duplicate', 'not-actionable']);
  if (!validActions.has(action)) {
    throw new CommandError('BAD_INPUT', `--action must be one of ${[...validActions].join('|')}, got '${action}'`);
  }
  const runId = ctx.flag('run-id');
  const fingerprint = ctx.flag('fingerprint');
  if (!runId || !fingerprint) throw new CommandError('BAD_INPUT', '--run-id and --fingerprint are required with --action');
  const canonicalFingerprint = ctx.flag('canonical');
  if (action === 'duplicate' && !canonicalFingerprint) {
    throw new CommandError('BAD_INPUT', "--action duplicate requires --canonical <fingerprint>");
  }
  return passthroughErrors(async () => {
    const res = await ctx.deps.applyModelAbAdjudication({
      runId, fingerprint, action, canonicalFingerprint, actor: ctx.flag('actor'),
    });
    return { ok: true, ...res };
  });
}

/** `arm-eval-decision` — gate → paired-delta rank + τ anchor + frontier. */
export async function armEvalDecisionCmd(ctx) {
  // §2b F3: cloud-off is a SUPPORTED MODE, not a failure — AGENTS.md says so
  // outright, and 55 of the 60 originally-measured invocations already reported
  // it as {ok:true, cloud:false}. Reporting it as a failure made a machine that
  // simply has no store indistinguishable from one whose write broke.
  // ARGV VALIDATION BEFORE THE CLOUD GATE (§2b F3) — see modelAbAdjudicateCmd.
  const experimentType = ctx.flag('experiment');
  if (!experimentType) throw new CommandError('BAD_INPUT', '--experiment required');
  if (!ctx.cloud.enabled) return { ok: true, cloud: false };
  return passthroughErrors(async () => {
    const { evaluateArmEval } = await import('../../arm-eval/decision.mjs');
    const { getExperiment } = await import('../../arm-eval/experiments.mjs');
    const exp = getExperiment(experimentType);
    const { sessions, cloud } = await ctx.deps.getSessionsForDecision({
      experimentType, repoId: ctx.flag('repo-id') || null,
      allRepos: ctx.hasFlag('all-repos'), phase: ctx.flag('phase') || 'prospective',
    });
    const decision = evaluateArmEval({ experimentType, baselineArm: exp.baselineArm, sessions });
    return { ok: true, cloud, ...decision };
  });
}

/** `arm-eval-stats` — leaderboard rows (repo-scoped unless --all-repos). */
export async function armEvalStatsCmd(ctx) {
  // §2b F3: cloud-off is a SUPPORTED MODE, not a failure — AGENTS.md says so
  // outright, and 55 of the 60 originally-measured invocations already reported
  // it as {ok:true, cloud:false}. Reporting it as a failure made a machine that
  // simply has no store indistinguishable from one whose write broke.
  if (!ctx.cloud.enabled) return { ok: true, cloud: false, rows: [] };
  return passthroughErrors(async () => {
    // The store REFUSES an unscoped read (throw unless repoId or allRepos), so
    // a flagless call fails loudly rather than silently widening.
    const lb = await ctx.deps.getArmEvalLeaderboard({
      experimentType: ctx.flag('experiment') || null,
      repoId: ctx.flag('repo-id') || null,
      allRepos: ctx.hasFlag('all-repos'),
    });
    return { ok: true, cloud: lb.cloud, rows: lb.rows };
  });
}

/** `arm-eval-adjudicate` — present a blinded session, or record a ranking. */
export async function armEvalAdjudicateCmd(ctx) {
  // §2b F3: cloud-off is a SUPPORTED MODE, not a failure — AGENTS.md says so
  // outright, and 55 of the 60 originally-measured invocations already reported
  // it as {ok:true, cloud:false}. Reporting it as a failure made a machine that
  // simply has no store indistinguishable from one whose write broke.
  // ARGV VALIDATION BEFORE THE CLOUD GATE (§2b F3) — see modelAbAdjudicateCmd.
  const sessionId = ctx.flag('session-id');
  if (!sessionId) throw new CommandError('BAD_INPUT', '--session-id required');
  if (!ctx.cloud.enabled) return { ok: true, cloud: false };
  const ranked = ctx.flag('ranked'); // comma-separated labels best→worst
  return passthroughErrors(async () => {
    if (ranked) {
      const rankedLabels = ranked.split(',').map((s) => s.trim()).filter(Boolean);
      const r = await ctx.deps.recordHumanRanking({
        sessionId, rankedLabels, reviewer: ctx.flag('reviewer') || null,
      });
      // Ranking recorded → the committed archive upgrades blinded → full
      // attribution (best-effort; the DB row is canonical).
      let archived = null;
      try {
        const { exportSession } = await import('../../arm-eval/export.mjs');
        const ex = await exportSession(sessionId);
        archived = ex.written ? ex.file : null;
      } catch { /* non-fatal */ }
      return { ok: true, ...r, recorded: rankedLabels, archived };
    }
    const q = await ctx.deps.getBlindedSessionOutputs(sessionId);
    return { ok: true, cloud: q.cloud, blinded: true, outputs: q.outputs };
  });
}

/**
 * `arm-eval-export` — (re)generate the committed session archive.
 *
 * The blinding rule lives in `lib/arm-eval/export.mjs`: a prospective session
 * with no human ranking exports BLINDED.
 */
export async function armEvalExportCmd(ctx) {
  // §2b F3: cloud-off is a SUPPORTED MODE, not a failure — AGENTS.md says so
  // outright, and 55 of the 60 originally-measured invocations already reported
  // it as {ok:true, cloud:false}. Reporting it as a failure made a machine that
  // simply has no store indistinguishable from one whose write broke.
  // ARGV VALIDATION BEFORE THE CLOUD GATE (§2b F3) — see modelAbAdjudicateCmd.
  const one = ctx.flag('session-id');
  if (!one && !ctx.hasFlag('all')) {
    throw new CommandError('BAD_INPUT', '--session-id <id> or --all required');
  }
  if (!ctx.cloud.enabled) return { ok: true, cloud: false };
  const { exportSession } = await import('../../arm-eval/export.mjs');
  return passthroughErrors(async () => {
    if (one) {
      const r = await exportSession(one);
      return { ok: r.written, ...r };
    }
    const scope = await ctx.resolveScope();
    const { ids } = await ctx.deps.listSessionIds({
      repoId: scope.kind === 'scoped' ? scope.repoId : null,
      allRepos: ctx.hasFlag('all-repos'),
    });
    const results = [];
    for (const sid of ids) results.push(await exportSession(sid));
    return {
      ok: true,
      exported: results.filter((r) => r.written).length,
      total: ids.length,
      files: results.filter((r) => r.written).map((r) => r.file),
    };
  });
}

/**
 * `arm-eval-toggle on|off|status` — the one-command experiment switch.
 *
 * An explicit `AUDIT_MODEL_SHADOW` env always wins over the toggle (kill switch).
 */
export async function armEvalToggleCmd(ctx) {
  const sub = ctx.verb || 'status';
  const { readToggle, writeToggle, resolveShadowArmsWithToggle } = await import('../../arm-eval/toggle.mjs');
  if (sub === 'on' || sub === 'off') {
    const { armEvalConfig } = await import('../../config.mjs');
    // REJECT a bad --budget-eur; never coerce it to the default (audit M11).
    // `t.budgetEur ?? armEvalConfig.budgetEur` below means a null budget is the
    // €300 DEFAULT, not a refusal — so the old `isFinite && > 0 ? flag : default`
    // turned `--budget-eur 0` (or `abc`) into a €300 ceiling the operator never
    // asked for. Absent flag ⇒ default (deliberate); present-but-invalid ⇒ error.
    const rawBudget = ctx.flag('budget-eur');
    let budgetEur = armEvalConfig.budgetEur;
    if (rawBudget !== undefined && rawBudget !== null && String(rawBudget).trim() !== '') {
      const parsed = Number(String(rawBudget).trim());
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new CommandError(
          'BAD_INPUT',
          `--budget-eur must be a positive number, got ${JSON.stringify(String(rawBudget))}. `
          + 'Omit the flag to use the configured default '
          + `(€${armEvalConfig.budgetEur}); an invalid value is refused rather than silently defaulted.`,
        );
      }
      budgetEur = parsed;
    }
    const state = writeToggle({ enabled: sub === 'on', budgetEur: sub === 'on' ? budgetEur : null });
    const arms = resolveShadowArmsWithToggle();
    return {
      ok: true, toggle: state,
      activates: sub === 'on' ? {
        auditShadowArms: arms.enabled ? arms.requested : [],
        planCapture: 'plan-authoring', brainstormCapture: 'brainstorm',
        budgetEur,
      } : null,
      note: sub === 'on'
        ? 'Shadow arms + plan/brainstorm capture ACTIVE for this repo. Turn off: arm-eval-toggle off'
        : 'All experiment capture INERT for this repo.',
    };
  }
  if (sub !== 'status') throw new CommandError('BAD_INPUT', 'usage: arm-eval-toggle on|off|status [--budget-eur N]');
  const t = readToggle();
  const arms = resolveShadowArmsWithToggle();
  return { ok: true, toggle: t, shadowArms: { enabled: arms.enabled, requested: arms.requested, source: arms.source } };
}

/**
 * `arm-eval-maybe-capture` — the toggle-gated capture hook for /plan and
 * /brainstorm. Silent no-op when the toggle is off, so the skills can call it
 * unconditionally.
 */
export async function armEvalMaybeCaptureCmd(ctx) {
  const { readToggle } = await import('../../arm-eval/toggle.mjs');
  const t = readToggle();
  if (!t.enabled) return { ok: true, captured: false, reason: 'toggle-off' };
  const experimentType = ctx.flag('experiment');
  const task = ctx.flag('task');
  if (!experimentType || !task) {
    throw new CommandError('BAD_INPUT', '--experiment <plan-authoring|brainstorm> --task "<text>" required');
  }
  const { armEvalConfig } = await import('../../config.mjs');
  const budgetCapEur = t.budgetEur ?? armEvalConfig.budgetEur;
  const scope = await ctx.resolveScope();
  return passthroughErrors(async () => {
    const { runArmEvalSession } = await import('../../arm-eval/run.mjs');
    const r = await runArmEvalSession({
      experimentType, task, repoId: scope.kind === 'scoped' ? scope.repoId : null,
      phase: 'prospective', seed: null, budgetCapEur,
    });
    // A DECLINED capture is not a failure. `ok: r.state === 'ran'` reported
    // budget exhaustion and a toggle race as errors, when the runner declining
    // is the toggle working — the same 'supported mode is not a failure'
    // reasoning that took cloud-off to ok:true in F3. `captured` already
    // carries the fact, and `state`/`reason` say which decline it was.
    return { ok: true, captured: r.state === 'ran', ...r };
  });
}

/**
 * `arm-eval-run` — run ONE arm-eval session (produce → judge → cross-check →
 * persist). **SPENDS.**
 *
 * This is the CLI entry point that authorises a paid run, which is why it has
 * no cloud gate: the spend decision belongs to the operator invoking it, not
 * to whether a store happens to be reachable. That also means it is the one
 * command whose degrade path is NOT golden-covered — capturing it would mean
 * paying for LLM calls in a test — so only its input refusal is pinned.
 */
export async function armEvalRunCmd(ctx) {
  const experimentType = ctx.flag('experiment');
  const task = ctx.flag('task');
  if (!experimentType || !task) {
    throw new CommandError('BAD_INPUT', '--experiment <plan-authoring|brainstorm> --task "<text>" required');
  }
  const budgetFlag = Number.parseFloat(ctx.flag('budget-eur'));
  const seedFlag = ctx.flag('seed');
  const scope = await ctx.resolveScope();
  return passthroughErrors(async () => {
    // --budget-eur omitted → config default (ARM_EVAL_BUDGET_EUR). The library
    // seam still refuses null; the CLI is where the operator-facing default lives.
    const { armEvalConfig } = await import('../../config.mjs');
    const budgetCapEur = Number.isFinite(budgetFlag) && budgetFlag > 0 ? budgetFlag : armEvalConfig.budgetEur;
    const { runArmEvalSession } = await import('../../arm-eval/run.mjs');
    const r = await runArmEvalSession({
      experimentType, task,
      repoId: scope.kind === 'scoped' ? scope.repoId : null,
      phase: ctx.flag('phase') || 'prospective',
      seed: seedFlag ? Number.parseInt(seedFlag, 10) : null,
      budgetCapEur,
    });
    // Same as arm-eval-maybe-capture: a run the harness declined is a
    // legitimate non-run, and `state` reports which.
    return { ok: true, ran: r.state === 'ran', ...r };
  });
}
