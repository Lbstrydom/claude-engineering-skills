/**
 * @fileoverview Persona-domain registry commands (docs/plans/cross-skill-command-registry.md
 * — Cluster A template trio; grows in Phases 3–4).
 *
 * Behaviour-preserving moves. `persona-outcomes` is the template for an
 * `explicit-required` write: `--repo` decides the repo (never the ambient
 * checkout — the F4/F10 class), resolved lazily through `ctx.resolveScope`,
 * whose error kinds arrive as thrown CommandError with the legacy codes and
 * messages.
 */
import { CommandError } from '../dispatch.mjs';

const PERSONA_OUTCOME_VALUES = ['fixed', 'dismissed', 'wont_fix', 'stale'];

/**
 * `persona-outcomes <summary|label|backfill-hash>` / `--worksheet`.
 * Moved from `cmdPersonaOutcomes`. The one declared softFail: `summary`
 * returns the store's result verbatim, whose error path is `{ok:false}` at
 * exit 0 (frozen legacy quirk — see the registry entry).
 */
export async function personaOutcomesCmd(ctx) {
  const sub = ctx.verb;

  if (ctx.hasFlag('worksheet')) {
    const repoName = ctx.flag('repo');
    if (!repoName) throw new CommandError('BAD_INPUT', '--repo <name> is required for --worksheet');
    // 88bc75e1/8993b96f: repoName alone is an ambiguous, caller-supplied
    // display string — the scope policy resolves the stable repoId FROM
    // `--repo` itself, never from the ambient checkout.
    const scope = await ctx.resolveScope({ explicitRepoName: repoName });
    const repoId = scope.repoId;
    const res = await ctx.deps.getActionablePersonaOutcomeItems({ repoName, repoId });
    if (!res.ok) throw new CommandError('STORE_ERROR', res.error || 'worksheet query failed');
    if (!res.cloud) return { ok: true, cloud: false, count: 0 };
    const { renderAdjudicationWorksheet } = await import('../../adjudication-worksheet.mjs');
    const { writeFileSync, mkdirSync, existsSync } = await import('node:fs');
    const md = renderAdjudicationWorksheet({
      title: `Persona-finding outcome labels — repo ${repoName}`,
      introLines: [
        'Actionable P0/P1 persona findings: never labeled, OR labeled fixed/stale but' +
        ' reappearing in the latest session (a regression). Labeling a finding' +
        ' dismissed/wont_fix requires --rationale and retires any auto-emitted' +
        ' audit_missed ground truth for the same hash.',
        res.truncated
          ? `Showing 50 of more actionable findings — re-run after labeling to see the rest.`
          : '',
      ].filter(Boolean),
      items: res.items.map((it) => ({
        runId: it.sessionId, fingerprint: it.personaFindingHash, severity: it.severity,
        category: it.outcome ? `relabel (was: ${it.outcome})` : 'unlabeled',
        file: it.element, detail: it.observed,
      })),
      actions: ['fixed', 'dismissed', 'wont_fix', 'stale'],
      commandFor: (it, a) => `node scripts/cross-skill.mjs persona-outcomes label --session ${it.runId} --hash ${it.fingerprint} --outcome ${a}${(a === 'dismissed' || a === 'wont_fix') ? ' --rationale "<why>"' : ''}`,
      generatedAt: new Date().toISOString(),
    });
    const dir = existsSync('docs/arm-eval') ? 'docs/arm-eval/worksheets' : '.audit';
    const out = ctx.flag('out') || `${dir}/persona-outcomes-worksheet.md`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(out, md);
    process.stderr.write(`  [persona-outcomes] worksheet: ${res.items.length} actionable finding(s) → ${out}\n`);
    return { ok: true, cloud: true, count: res.items.length, truncated: res.truncated, worksheet: out };
  }

  if (sub === 'summary') {
    const repoName = ctx.flag('repo') || process.env.PERSONA_TEST_REPO_NAME;
    if (!repoName) throw new CommandError('BAD_INPUT', '--repo <name> is required (or set PERSONA_TEST_REPO_NAME)');
    const scope = await ctx.resolveScope({ explicitRepoName: repoName });
    const repoId = scope.repoId;
    // The store's result travels VERBATIM (legacy `emit(res)`) — including
    // its `{ok:false}` error shape at exit 0, which is why this command is
    // the registry's one declared softFail.
    return ctx.deps.getPersonaOutcomesSummary({ repoName, repoId });
  }

  if (sub === 'label') {
    const p = ctx.payload();
    const sessionId = p.sessionId ?? ctx.flag('session');
    const hash = p.personaFindingHash ?? ctx.flag('hash');
    const outcome = p.outcome ?? ctx.flag('outcome');
    const rationale = p.rationale ?? ctx.flag('rationale') ?? null;
    const labeledBy = p.labeledBy ?? ctx.flag('by') ?? 'agent';
    if (!sessionId || !hash || !outcome) {
      throw new CommandError('BAD_INPUT', '--session <id> --hash <h> --outcome <fixed|dismissed|wont_fix|stale> are all required');
    }
    if (!PERSONA_OUTCOME_VALUES.includes(outcome)) {
      throw new CommandError('BAD_INPUT', `--outcome must be one of ${PERSONA_OUTCOME_VALUES.join('|')}, got "${outcome}"`);
    }
    if ((outcome === 'dismissed' || outcome === 'wont_fix') && !(rationale && rationale.trim())) {
      throw new CommandError('BAD_INPUT', `--rationale is required for outcome "${outcome}"`);
    }
    const target = await ctx.deps.resolveLabelTarget({ sessionId, personaFindingHash: hash });
    if (!target.ok) throw new CommandError('BAD_INPUT', target.error);
    const result = await ctx.deps.upsertPersonaFindingOutcome({
      repoId: target.repoId, personaFindingHash: hash, outcome,
      lastSeenSessionId: sessionId, labeledBy, rationale,
    });
    if (!result.ok) throw new CommandError('WRITE_FAILED', result.error || 'label write failed');
    return { ok: true, cloud: true };
  }

  if (sub === 'backfill-hash') {
    const repoName = ctx.flag('repo');
    if (!repoName) throw new CommandError('BAD_INPUT', '--repo <name> is required for backfill-hash');
    // MUTATING path — the `--repo`-vs-ambient split mattered most here: the
    // pre-F4 code would migrate the AMBIENT repo's rows while the log line
    // named `--repo`.
    const scope = await ctx.resolveScope({ explicitRepoName: repoName });
    const repoId = scope.repoId;
    if (!repoId) throw new CommandError('BAD_INPUT', 'could not resolve a repoId — pass --repo-id explicitly');
    const dryRun = ctx.hasFlag('dry-run');
    const reportPath = ctx.flag('report-path');
    const res = await ctx.deps.backfillPersonaFindingHashV2({ repoId, dryRun, reportPath });
    if (res.alreadyCurrent) {
      process.stderr.write(`  [persona-outcomes backfill-hash] repo ${repoName}: already current, nothing to migrate\n`);
    } else {
      process.stderr.write(
        `  [persona-outcomes backfill-hash] repo ${repoName}${dryRun ? ' (dry-run)' : ''}: ` +
        `scanned=${res.scanned} recoveredThisRun=${res.recoveredThisRun} ` +
        `reconciledThisRun=${res.reconciledThisRun} ` +
        `targetAlreadyExists=${res.targetAlreadyExists} unrecoverable=${res.unrecoverable} ` +
        `ambiguous=${res.ambiguousCount}${res.ambiguousReportPath ? ` (report: ${res.ambiguousReportPath})` : ''}\n`,
      );
    }
    return { ok: true, ...res };
  }

  throw new CommandError('BAD_INPUT', 'usage: persona-outcomes <summary|label|backfill-hash> [flags] | persona-outcomes --worksheet --repo <name>');
}
