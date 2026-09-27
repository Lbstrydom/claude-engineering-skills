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
import { z } from 'zod';
import { CommandError } from '../dispatch.mjs';
import { reconcileRepoIdentity } from '../../repo-scope.mjs';
import { decideCorrelations, isP0OrP1, MATCHER_VERSION } from '../../persona/audit-correlator.mjs';
import { buildPersonaSessionId } from '../../persona-test/session-id.mjs';
import { shellQuoteSingle } from '../../shell-quote.mjs';
import {
  PERSONA_VERDICTS, LifecycleSchema, capPersonaVerdict,
} from '../../persona-test/verdict-eligibility.mjs';
import { derivePairOverlapRate } from '../../persona-test/pair-overlap.mjs';

const PERSONA_OUTCOME_VALUES = ['fixed', 'dismissed', 'wont_fix', 'stale'];

const AddPersonaRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  appUrl: z.url(),
  appName: z.string().optional(),
  notes: z.string().optional(),
  repoName: z.string().optional(),
});

/**
 * The `record-persona-session` request contract. EXPORTED so the prose↔code
 * contract test (tests/persona-session-payload-contract.test.mjs) can compare
 * its emitted JSON-schema key set with the payload skills/persona-test/SKILL.md
 * Phase 6 tells the model to send — the SKILL once sent
 * `browserDriver`/`browserStatus` against a required `browserTool`, so every
 * documented call failed validation and nothing on either side could see it.
 */
export const RecordPersonaSessionRequestSchema = z.object({
  // OPTIONAL since WS-C2 — omit it and the CLI mints a collision-resistant id
  // via buildPersonaSessionId (the single oracle). Pass one explicitly ONLY to
  // re-post an existing session: session_id is the idempotency key, so a
  // supplied value is honoured verbatim, legacy weak ids included.
  sessionId: z.string().min(1).optional(),
  persona: z.string().min(1),
  url: z.url(),
  focus: z.string().optional(),
  browserTool: z.string().min(1),
  stepsTaken: z.number().int().nonnegative().optional(),
  verdict: z.enum(PERSONA_VERDICTS),
  // The stateful-mission checklist outcome (SKILL.md Phase 3). OPTIONAL on the
  // wire, but ABSENT is not a pass: capPersonaVerdict treats an unreported
  // lifecycle as a failing `Ready for users` conjunct. A PRESENT-but-malformed
  // lifecycle is refused here at the boundary (golden
  // `rec-session-lifecycle-partial-empty`); capPersonaVerdict re-validates with
  // the same schema for every other caller (audit H13/H29), so the predicate
  // never trusts an unparsed lifecycle either way. Omitted p0/p1 counts are NOT
  // refused — they cap the verdict (`severity counts not reported`).
  lifecycle: LifecycleSchema.optional(),
  // Session work-record fields (SKILL.md Phase 3). Optional for callers that
  // predate them; when present they feed the same eligibility predicate.
  terminalReason: z.enum(['goal-reached', 'step-budget-exhausted', 'abandonment-threshold-hit',
    'auth-wall-blocked', 'tool-error', 'safety-refusal']).optional(),
  authState: z.enum(['n/a-no-auth-encountered', 'authenticated-via-bootstrap', 'auth-wall-untested']).optional(),
  originPolicyResult: z.enum(['same-origin-only', 'cross-origin-attempted-and-blocked', 'n/a']).optional(),
  p0Count: z.number().int().nonnegative().optional(),
  p1Count: z.number().int().nonnegative().optional(),
  p2Count: z.number().int().nonnegative().optional(),
  p3Count: z.number().int().nonnegative().optional(),
  avgConfidence: z.number().min(0).max(1).optional(),
  findings: z.array(z.any()).optional(),
  reportMd: z.string().optional(),
  debriefMd: z.string().optional(),
  commitSha: z.string().optional(),
  deploymentId: z.string().optional(),
  repoName: z.string().optional(),
  repoId: z.string().optional(),
  personaId: z.string().optional(),
  // WS1 — deterministic persona<->audit correlator. Default ON; the caller
  // (persona-test skill) can pass `false` when audit_link context isn't
  // resolvable, matching today's opt-in gate.
  autoCorrelate: z.boolean().default(true),
  // LENIENT at the request boundary (Gemini1-H2/Gemini2-M2): a malformed or
  // over-length clickPath entry must NOT fail the whole session record. The cap
  // (40), per-entry ClickPathStepSchema validation + drop-invalid, and the
  // sanitize/redact controls all live in recordPersonaSession (store/persona.mjs).
  clickPath: z.array(z.unknown()).optional(),
});

/**
 * `persona-outcomes <summary|label|backfill-hash>` / `--worksheet`.
 * Moved from `cmdPersonaOutcomes`. The one declared softFail: `summary`
 * returns the store's result verbatim, whose error path is `{ok:false}` at
 * exit 0 (frozen legacy quirk — see the registry entry).
 */
export async function personaOutcomesCmd(ctx) {
  const sub = ctx.verb;

  if (ctx.hasFlag('worksheet')) {
    // Same read chain as `summary` (2026-09-07): this worksheet is the surface
    // the ship gate's own remediation line points at, so if the gate can now be
    // read without `--repo`, refusing here would send the operator to a command
    // that cannot run. Writes (`label`, `backfill-hash`) keep requiring it.
    const repoName = ctx.flag('repo') || process.env.PERSONA_TEST_REPO_NAME || null;
    // 88bc75e1/8993b96f: repoName alone is an ambiguous, caller-supplied
    // display string — the scope policy resolves the stable repoId FROM
    // `--repo` itself when one is given, and only falls back to the ambient
    // checkout when the caller named nothing at all.
    const scope = await ctx.resolveScope({ explicitRepoName: repoName });
    if (scope.kind === 'unresolved') {
      return {
        ok: true, cloud: scope.reason !== 'cloud-off', measured: false,
        reason: scope.reason, count: 0,
        scope: { mode: 'unresolved', repoId: null, slug: null },
      };
    }
    const repoId = scope.repoId;
    const effectiveName = repoName ?? scope.slug ?? null;
    const res = await ctx.deps.getActionablePersonaOutcomeItems({ repoName: effectiveName, repoId });
    if (!res.ok) throw new CommandError('STORE_ERROR', res.error || 'worksheet query failed');
    if (!res.cloud) return { ok: true, cloud: false, count: 0 };
    const { renderAdjudicationWorksheet } = await import('../../adjudication-worksheet.mjs');
    const { writeFileSync, mkdirSync, existsSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const md = renderAdjudicationWorksheet({
      title: `Persona-finding outcome labels — repo ${effectiveName ?? '(ambient)'}`,
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
      // Every interpolated value is SHELL-QUOTED (audit CB-r2). A rendered
      // command is read as evidence the operator can paste it — that is the
      // whole reason it saves typing — and `sessionId` reaches the database
      // from a caller-supplied payload that validates only "non-empty string",
      // so backticks / `$(…)` / `$VAR` can ride into a pasteable line. The
      // sibling lock-with-test worksheet closed exactly this with the same
      // oracle; this one had not been given it.
      // `--repo` is carried (audit H15/H28) so the pasted line names the repo
      // this worksheet was rendered for, and `label` REFUSES it when the
      // addressed session belongs to a different repo — a worksheet from one
      // checkout pasted into another cannot relabel the wrong repo silently.
      commandFor: (it, a) => 'node scripts/cross-skill.mjs persona-outcomes label'
        + (effectiveName ? ` --repo ${shellQuoteSingle(String(effectiveName))}` : '')
        + ` --session ${shellQuoteSingle(String(it.runId))}`
        + ` --hash ${shellQuoteSingle(String(it.fingerprint))}`
        + ` --outcome ${a}`
        + ((a === 'dismissed' || a === 'wont_fix') ? ' --rationale "<why>"' : ''),
      generatedAt: new Date().toISOString(),
    });
    const dir = existsSync('docs/arm-eval') ? 'docs/arm-eval/worksheets' : '.audit';
    const out = ctx.flag('out') || `${dir}/persona-outcomes-worksheet.md`;
    // The PARENT of the actual output path (audit 8edd7583/cbf7d266) — a
    // custom `--out` naming a nested directory that doesn't exist yet used to
    // fail with ENOENT, because only the unrelated DEFAULT root was created.
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, md);
    process.stderr.write(`  [persona-outcomes] worksheet: ${res.items.length} actionable finding(s) → ${out}\n`);
    return { ok: true, cloud: true, count: res.items.length, truncated: res.truncated, worksheet: out };
  }

  if (sub === 'summary') {
    // THE READ CHAIN (2026-09-07). `--repo` → `PERSONA_TEST_REPO_NAME` →
    // ambient git identity → `measured:false`. The env layer alone was not
    // enough: `/ship` invoked this as `--repo "$PERSONA_TEST_REPO_NAME"`, a
    // SHELL expansion, and a Claude Code session inherits neither the
    // consumer's `.env` nor `~/.audit-loop.env` — so the flag arrived EMPTY,
    // the env fallback never ran (an empty flag is falsy but the CLI never saw
    // the variable either), and the gate refused in every consumer that had not
    // exported it. `scope.mode` is echoed so a blind gate is visible in the
    // ship transcript instead of reading like a quiet repo.
    const repoName = ctx.flag('repo') || process.env.PERSONA_TEST_REPO_NAME || null;
    const scope = await ctx.resolveScope({ explicitRepoName: repoName });
    if (scope.kind === 'unresolved') {
      return {
        ok: true, cloud: scope.reason !== 'cloud-off',
        measured: false, reason: scope.reason,
        scope: { mode: 'unresolved', repoId: null, slug: null },
        sessionId: null,
      };
    }
    const repoId = scope.repoId;
    // The ambient slug is `audit_repos.name`; `--repo`/env is the caller's
    // display string. Whichever produced the scope is the one that must reach
    // the store, so the name-fallback query inside it can never land on a
    // different repo than the id-scoped one did.
    const effectiveName = repoName ?? scope.slug ?? null;
    // The store's result travels VERBATIM, INCLUDING its `{ok:false}` error
    // shape — which is a real store failure carrying its own diagnosis, so
    // `reportsFailure` keeps the payload and exits 1. Under the old softFail
    // it exited 0, telling every caller that checks $? that a failed summary
    // query had succeeded.
    const res = await ctx.deps.getPersonaOutcomesSummary({ repoName: effectiveName, repoId });
    if (!res || res.ok !== true) return res;
    return {
      ...res,
      measured: res.cloud !== false,
      scope: {
        mode: repoName ? 'explicit' : 'ambient',
        repoId: repoId ?? null,
        slug: effectiveName,
      },
    };
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
    // The session decides the repo (see the registry note). An explicit
    // `--repo` — which the worksheet's generated commands carry — is a claim
    // about that repo, so it is CHECKED, never silently ignored: a mismatch
    // means the command was pasted against the wrong repository.
    const repoFlag = ctx.flag('repo');
    if (repoFlag) {
      const scope = await ctx.resolveScope({ explicitRepoName: repoFlag });
      if (scope.repoId && scope.repoId !== target.repoId) {
        throw new CommandError('PARENT_NOT_OWNED',
          `--repo "${repoFlag}" does not own session ${sessionId} — refusing to label another repository's finding`, {}, 1);
      }
    }
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

/** `add-persona` — register a persona for an app URL. Moved from `cmdAddPersona`. */
export async function addPersonaCmd(ctx) {
  const parsed = AddPersonaRequestSchema.safeParse(ctx.payload());
  if (!parsed.success) {
    throw new CommandError('BAD_INPUT', 'name, description, appUrl are required', { issues: parsed.error.issues });
  }
  if (!await ctx.deps.isPersonaCloudEnabled()) {
    return { ...ctx.degrade(), personaId: null, existed: false };
  }
  const res = await ctx.deps.upsertPersona(parsed.data);
  // `ok: !!personaId` is unwritable now — upsertPersona reports its own
  // outcome, so there is no null left to infer from. A refused input is exit
  // 2, a failed write exit 1; cloud-off never reaches here (the degrade branch
  // above returns first).
  if (!res.ok) {
    const failed = res.reason === 'write-failed';
    throw new CommandError(failed ? 'WRITE_FAILED' : 'BAD_INPUT',
      `upsertPersona: ${res.message}`, { reason: res.reason }, failed ? 1 : 2);
  }
  return { ok: true, cloud: true, personaId: res.personaId, existed: res.existed };
}

/**
 * `record-persona-session` — the session row plus its auto-correlation.
 *
 * Moved from `cmdRecordPersonaSession`. Two invariants ride here: identity
 * reconciliation is UNCONDITIONAL (a payload carrying repo A's id with repo
 * B's name used to be written verbatim when BOTH were supplied), and a
 * resolver ERROR refuses rather than letting reconciliation silently become a
 * no-op exactly when the store is unhealthy.
 */
export async function recordPersonaSessionCmd(ctx) {
  const p = ctx.payload();
  if (!p.commitSha) p.commitSha = ctx.git.commitSha() || undefined;
  const parsed = RecordPersonaSessionRequestSchema.safeParse(p);
  if (!parsed.success) {
    throw new CommandError('BAD_INPUT', 'session payload failed validation', { issues: parsed.error.issues });
  }

  if (!await ctx.deps.isPersonaCloudEnabled()) {
    return { ...ctx.degrade(), sessionId: null, existed: false, statsUpdated: false };
  }

  const data = { ...parsed.data };
  // The composed `Ready for users` predicate, decided in CODE (2026-09-27).
  // The prose rule alone let a run that reached its goal without verifying the
  // state it passed through store `Ready for users`. Only ever caps DOWN, and
  // the envelope says so — a silent rewrite of the caller's verdict would be
  // its own defect.
  const cap = capPersonaVerdict(data);
  if (cap.capped) {
    process.stderr.write(
      `  [persona] verdict capped: "Ready for users" → "${cap.verdict}" — ${cap.blockers.join('; ')}\n`,
    );
    data.verdict = cap.verdict;
  }
  // WS-C2: mint the session_id in code when the caller omitted it, keeping the
  // weak `persona-test-<unix>` shape the LLM used to author out of the identity
  // path entirely (an explicit id passes through, so re-posts still work).
  const mintedSessionId = data.sessionId ? null : buildPersonaSessionId();
  if (mintedSessionId) data.sessionId = mintedSessionId;
  {
    const refResult = await ctx.deps.resolveRepoForStoreResult({}).catch(
      (err) => ({ kind: 'error', error: err?.message ?? String(err) }),
    );
    if (refResult.kind === 'error') {
      throw new CommandError('REPO_RESOLVE_FAILED',
        `cannot verify this session's repo identity (${refResult.error}) — refusing rather than recording an `
        + 'unreconciled repoId/repoName pair that could put the two on different repositories.');
    }
    const ref = refResult.kind === 'resolved'
      ? { repoRowId: refResult.repoRowId, repoUuid: refResult.repoUuid, name: refResult.name }
      : null;
    const merged = reconcileRepoIdentity(data, ref);
    if (!merged.ok) {
      throw new CommandError('REPO_IDENTITY_CONFLICT',
        `refusing: supplied repo ${merged.conflict} "${merged.supplied}" does not match this checkout ("${merged.ambient}") — recording would put repo_id and repo_name on different repositories.`);
    }
    data.repoId = merged.repoId;
    data.repoName = merged.repoName;
  }

  const result = await ctx.deps.recordPersonaSession(data);
  const correlationSummary = await runAutoCorrelate(ctx.deps, data, result.sessionId);
  // §2b F2. `ok: !!result.sessionId` is gone — the writer reports its own
  // outcome now, so there is nothing to infer. This one does NOT throw, and the
  // reason is in its softFail declaration: a throw would DISCARD
  // `correlationSummary`, which is the field that names WHY the correlation
  // pass did nothing (`reason: 'session-write-failed'`). Losing the diagnosis
  // to signal the failure would trade one silence for another. So the envelope
  // carries the store's own `ok`/`reason` and the payload survives.
  //
  // `sessionKey` is the persona_test_sessions.session_id TEXT (the idempotency
  // key); `sessionId` is the row's uuid PK, which downstream correlation calls take.
  return {
    cloud: true, ...result, sessionKey: data.sessionId, correlationSummary,
    ...(cap.capped ? { verdictCap: { claimed: 'Ready for users', stored: cap.verdict, blockers: cap.blockers, label: cap.label } } : {}),
  };
}

/**
 * WS1 — deterministic persona<->audit correlator orchestration. ALWAYS returns
 * a structured summary (never throws to the caller, never silently no-ops) so
 * `attempted:false` + a reason and `attempted:true` + a real failure are both
 * externally visible.
 *
 * Takes `deps` (the store port) as its first argument rather than importing
 * the store: the injected-orchestrator pattern from plan D5b, so the
 * store-call goldens intercept its writes like any other.
 */
async function runAutoCorrelate(deps, data, sessionId) {
  const base = { attempted: false, candidates: 0, route: 0, fuzzy: 0, missed: 0, skippedExisting: 0, malformed: 0, writeFailed: 0, refused: 0, matcherVersion: MATCHER_VERSION };
  // A null sessionId means recordPersonaSession's OWN write failed (a genuine
  // DB error inside its catch block — cloud is already confirmed on by this
  // point) — distinct from "no repo identity", which is a resolvable-input
  // problem, not a write failure.
  if (!sessionId) return { ...base, reason: 'session-write-failed' };
  if (data.autoCorrelate === false) return { ...base, reason: 'disabled-by-flag' };
  if (!data.repoId) return { ...base, reason: 'no-repo-identity' };

  // Delegate to the correlator's own `isP0OrP1` oracle — this line used to
  // re-implement the predicate inline, and when the two drifted apart (`code`
  // here vs the contract's `severity`) nothing could notice.
  const p0p1 = (data.findings || []).filter(isP0OrP1);
  if (p0p1.length === 0) {
    // A caller-declared P0/P1 count with zero parseable P0/P1 findings is a
    // SHAPE problem, not an absence — the exact condition that hid the
    // `code`-vs-`severity` divergence for a month behind a reason string that
    // reads identically to a genuinely clean run.
    const declared = (Number(data.p0Count) || 0) + (Number(data.p1Count) || 0);
    if (declared > 0) {
      process.stderr.write(
        `  [correlator] session declares ${declared} P0/P1 finding(s) but none parsed from findings[] — `
        + `every finding needs a "severity" (or legacy "code") of P0/P1; nothing correlated\n`,
      );
      return { ...base, reason: 'p0p1-shape-mismatch', declaredP0P1: declared };
    }
    return { ...base, reason: 'no-p0p1-findings' };
  }

  try {
    const candResult = await deps.getCandidateAuditFindings({ repoId: data.repoId, exactCommitSha: data.commitSha || null });
    if (!candResult.ok) {
      process.stderr.write(`  [correlator] candidate read failed: ${candResult.error}\n`);
      return { ...base, attempted: true, reason: 'candidate-read-failed' };
    }
    if (candResult.rows.length === 0) {
      // Ground-truth integrity (WS1): a session with zero eligible audit runs
      // is NOT evidence of an audit miss — emit nothing.
      return { ...base, attempted: true, reason: 'no-candidate-runs' };
    }

    const existResult = await deps.getExistingCorrelationHashesForSession(sessionId);
    if (!existResult.ok) {
      process.stderr.write(`  [correlator] existence check failed: ${existResult.error}\n`);
      return { ...base, attempted: true, candidates: candResult.rows.length, reason: 'existence-check-failed' };
    }

    const { emissions, skippedExisting, malformed } = decideCorrelations({
      findings: data.findings, clickPath: data.clickPath,
      candidates: candResult.rows, alreadyCorrelatedHashes: existResult.hashes,
    });
    if (malformed > 0) {
      process.stderr.write(`  [correlator] session ${sessionId}: ${malformed} P0/P1 finding(s) quarantined (missing element/observed) — not correlated\n`);
    }

    // Each emission is counted by what the WRITER says happened, never by what
    // was attempted. `writeFailed` counts every emission that did not land
    // (a refusal included — the row is absent either way); `refused` is the
    // subset the writer declined by NAME (a tenancy/shape refusal, audit
    // H1/H2/H23), so a store outage and a cross-repo candidate stay
    // distinguishable in the summary.
    let route = 0, fuzzy = 0, missed = 0, writeFailed = 0, refused = 0;
    for (const emission of emissions) {
      if (emission._tier === 'route') route += 1;
      else if (emission._tier === 'fuzzy') fuzzy += 1;
      else missed += 1;
      const writeResult = await deps.recordPersonaAuditCorrelation(sessionId, emission, { repoId: data.repoId });
      if (!writeResult?.ok || writeResult.written === false) {
        writeFailed += 1;
        if (writeResult?.reason && !['write-failed', 'cloud-off'].includes(writeResult.reason)) refused += 1;
        process.stderr.write(
          `  [correlator] correlation not written for finding ${emission.personaFindingHash}: `
          + `${writeResult?.reason ?? 'unknown'} — ${writeResult?.error ?? 'no detail'}\n`,
        );
      }
    }

    const summary = {
      attempted: true, candidates: candResult.rows.length,
      route, fuzzy, missed, skippedExisting, malformed, writeFailed, refused, matcherVersion: MATCHER_VERSION,
    };
    if (writeFailed > 0) {
      process.stderr.write(`  [correlator] session ${sessionId}: ${writeFailed}/${emissions.length} correlation writes failed\n`);
    }
    return summary;
  } catch (err) {
    // Best-effort invariant (graceful degradation #16): correlator failure
    // NEVER fails the already-committed session write — but is always visible
    // via stderr + the reason union, never a silent no-op.
    process.stderr.write(`  [correlator] unexpected failure: ${err.message}\n`);
    return { ...base, attempted: true, reason: 'candidate-read-failed', error: err.message };
  }
}

/**
 * `record-correlation` — /persona-test links a finding to an audit row.
 * Moved from `cmdRecordCorrelation`.
 *
 * Ownership is enforced in the WRITER (store/persona-correlations.mjs): the
 * session row's repo is the tenant, and a supplied audit run/finding must
 * belong to it (and the finding to the run) — whether or not scope resolved
 * here. Each refusal keeps its own exit code: a dangling id, a cross-repo id
 * and a finding/run mismatch are different things for the operator to fix.
 */
const CORRELATION_REFUSAL_CODES = Object.freeze({
  'invalid-input': 'BAD_INPUT',
  'parent-not-found': 'PARENT_NOT_FOUND',
  'audit-run-not-found': 'PARENT_NOT_FOUND',
  'audit-finding-not-found': 'PARENT_NOT_FOUND',
  'parent-not-owned': 'PARENT_NOT_OWNED',
  'parent-repo-unknown': 'PARENT_NOT_OWNED',
  'audit-run-cross-tenant': 'PARENT_NOT_OWNED',
  'audit-finding-cross-tenant': 'PARENT_NOT_OWNED',
  'audit-finding-run-mismatch': 'PARENT_NOT_OWNED',
});

export async function recordCorrelationCmd(ctx) {
  const p = ctx.payload();
  if (!p.personaSessionId || !p.personaFindingHash || !p.personaSeverity || !p.correlationType) {
    throw new CommandError('BAD_INPUT', 'personaSessionId, personaFindingHash, personaSeverity, correlationType required');
  }
  if (!ctx.cloud.enabled) return ctx.degrade();
  // D7 / Phase 8: thread the RESOLVED repo into the writer's parent join.
  // `null` for unresolved/none scope relaxes the TENANT predicate only —
  // the parent-existence join always applies, so a dangling id is refused
  // either way. The registry's `parent:` declaration is for conformance;
  // the SQL is the enforcement.
  const scope = await ctx.resolveScope();
  const repoId = scope.kind === 'scoped' ? scope.repoId : null;
  const result = await ctx.deps.recordPersonaAuditCorrelation(p.personaSessionId, {
    personaFindingHash: p.personaFindingHash,
    personaSeverity: p.personaSeverity,
    auditFindingId: p.auditFindingId,
    auditRunId: p.auditRunId,
    correlationType: p.correlationType,
    matchScore: p.matchScore,
    matchRationale: p.matchRationale,
  }, { repoId });
  if (!result.ok) {
    // An ownership refusal is exit 1 with its own code, not a generic
    // WRITE_FAILED: 'that session does not exist' and 'that session belongs to
    // another repository' are different things for the operator to do next.
    // An invalid input the writer caught is the caller's to fix — exit 2.
    const code = CORRELATION_REFUSAL_CODES[result.reason] ?? 'WRITE_FAILED';
    throw new CommandError(code, result.error || 'correlation write failed', { reason: result.reason ?? null },
      code === 'BAD_INPUT' ? 2 : 1);
  }
  // `ok:true` without a written row is the writer's cloud-off outcome; this
  // handler's cloud gate returned before reaching the store, so it should be
  // unreachable — but it must never read as a write if it happens.
  if (result.written === false) return { ok: true, cloud: false, written: false, reason: result.reason ?? null };
  return { ok: true, cloud: true, written: true };
}

/**
 * The `link-persona-pair` request contract (skills/persona-test/SKILL.md Step
 * P7). Exported for the same prose↔code key-set test as the session schema.
 * `sessionA`/`sessionB` are the Phase 6 response's `sessionId` — the row's
 * uuid PK — never `sessionKey`, the minted text idempotency key.
 * `overlapRate` is OPTIONAL: the writer derives it from the counts, and a
 * supplied value that disagrees is refused rather than silently replaced.
 */
export const LinkPersonaPairRequestSchema = z.object({
  sessionA: z.uuid(),
  sessionB: z.uuid(),
  consensusCount: z.number().int().nonnegative(),
  aOnlyCount: z.number().int().nonnegative(),
  bOnlyCount: z.number().int().nonnegative(),
  overlapRate: z.number().min(0).max(1).optional(),
}).refine((v) => v.sessionA !== v.sessionB, { message: 'sessionA and sessionB must be different sessions', path: ['sessionB'] });

/** Tolerance for a caller-computed overlapRate: the report prints 2 decimals. */
const OVERLAP_RATE_TOLERANCE = 0.005;

/**
 * `link-persona-pair` — persist a /persona-test --pair run as one row joining
 * its two sessions (`persona_pair_sessions`). SKILL.md Step P7 documented this
 * call from the day pair mode shipped; until 2026-09-27 no subcommand existed,
 * so every pair run's linkage silently never happened.
 */
export async function linkPersonaPairCmd(ctx) {
  const parsed = LinkPersonaPairRequestSchema.safeParse(ctx.payload());
  if (!parsed.success) {
    throw new CommandError('BAD_INPUT',
      'sessionA, sessionB (the two Phase 6 sessionId uuids), consensusCount, aOnlyCount, bOnlyCount are required',
      { issues: parsed.error.issues });
  }
  const p = parsed.data;
  const derived = derivePairOverlapRate(p);
  if (p.overlapRate !== undefined && Math.abs(p.overlapRate - derived) > OVERLAP_RATE_TOLERANCE) {
    throw new CommandError('BAD_INPUT',
      `overlapRate ${p.overlapRate} disagrees with the counts (consensus / total = ${derived}) — send the counts, the rate is derived`);
  }
  if (!await ctx.deps.isPersonaCloudEnabled()) return { ...ctx.degrade(), pairId: null };
  const scope = await ctx.resolveScope();
  const repoId = scope.kind === 'scoped' ? scope.repoId : null;
  const res = await ctx.deps.recordPersonaPairLink(p, { repoId });
  if (!res.ok) {
    const code = res.reason === 'session-not-found' ? 'PARENT_NOT_FOUND'
      : (res.reason === 'cross-repo-pair' || res.reason === 'session-not-owned') ? 'PARENT_NOT_OWNED'
        : 'WRITE_FAILED';
    throw new CommandError(code, res.message || 'pair link write failed', { reason: res.reason }, 1);
  }
  return { ok: true, cloud: true, pairId: res.pairId, overlapRate: res.overlapRate };
}

// ── Cluster D (Phase 5) — persona readers ─────────────────────────────────
// Post-RLS-hardening these ARE the supported read path: anon curl reads are
// blocked at the policy boundary, so the SKILL.md files call these commands.

const ListPersonasRequestSchema = z.object({ url: z.url() });

const GetPersonaSessionsByRepoSchema = z.object({
  // OPTIONAL since 2026-09-07 — omitted means "the repo I am standing in".
  // The store still needs a NAME (its predicate is `repo_name = $1`), so the
  // handler supplies the ambient slug; what is optional is the CALLER having
  // to know it.
  repoName: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).optional(),
  p0Only: z.boolean().optional(),
  select: z.array(z.string().min(1)).optional(),
});

const GetPersonaSessionsByUrlSchema = z.object({
  url: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),
  select: z.array(z.string().min(1)).optional(),
});

const csv = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

/** `list-personas` — registered personas for an app URL. */
export async function listPersonasCmd(ctx) {
  const urlFlag = ctx.flag('url');
  const parsed = ListPersonasRequestSchema.safeParse(urlFlag ? { url: urlFlag } : ctx.payload());
  if (!parsed.success) {
    throw new CommandError('BAD_INPUT', '--url <app_url> is required', { issues: parsed.error.issues });
  }
  if (!await ctx.deps.isPersonaCloudEnabled()) return { ...ctx.degrade(), rows: [] };
  const rows = await ctx.deps.listPersonasForApp(parsed.data.url);
  return { ok: true, cloud: true, rows };
}

/**
 * `get-persona-sessions-by-repo` — sessions for a named repo.
 *
 * When the caller NAMES a repo, the repoId comes from that name and never from
 * the ambient checkout: the store predicate is
 * `repo_name = $1 AND (repo_id = $3 OR repo_id IS NULL)`, so an ambient id
 * beside a requested name made the two clauses name different repos and
 * returned `rows: []` alongside `scopedByRepoId: true` — a false zero wearing a
 * field that asserts correct scoping (F10).
 *
 * Since 2026-09-07 `--repo` is OPTIONAL, and omitting it resolves BOTH halves
 * from the ambient identity — which is not the F10 shape: F10 was an ambient id
 * contradicting a requested name, and here there is no requested name to
 * contradict. An unresolvable ambient identity reports `measured:false`; it must
 * never degrade to an unscoped read, and never to a bare empty `rows`.
 */
export async function getPersonaSessionsByRepoCmd(ctx) {
  const repoFlag = ctx.flag('repo');
  const limitFlag = ctx.flag('limit');
  const selectFlag = ctx.flag('select');
  const p = repoFlag
    ? {
        repoName: repoFlag,
        ...(limitFlag ? { limit: Number(limitFlag) } : {}),
        ...(ctx.hasFlag('p0-only') ? { p0Only: true } : {}),
        ...(selectFlag ? { select: csv(selectFlag) } : {}),
      }
    : ctx.payload();

  const parsed = GetPersonaSessionsByRepoSchema.safeParse(p);
  if (!parsed.success) {
    throw new CommandError('BAD_INPUT', 'optional: --repo <name>, --limit <n>, --p0-only, --select <csv>', { issues: parsed.error.issues });
  }
  if (!await ctx.deps.isPersonaCloudEnabled()) return { ...ctx.degrade(), rows: [] };
  const requestedName = parsed.data.repoName ?? process.env.PERSONA_TEST_REPO_NAME ?? null;
  const scope = await ctx.resolveScope({ explicitRepoName: requestedName });
  if (scope.kind === 'unresolved') {
    // NOT `rows: []` alone. This command is /ship Step 0.5a's LEGACY fallback,
    // and an empty row list there is read as "no session with open P0s" — the
    // exact false-clean the 2026-09-07 consumer report was about.
    return {
      ok: true, cloud: true, measured: false, reason: scope.reason,
      scope: { mode: 'unresolved', repoId: null, slug: null },
      rows: [], scopedByRepoId: false,
    };
  }
  const repoId = scope.repoId;
  const effectiveName = requestedName ?? scope.slug ?? null;
  if (!effectiveName) {
    // The store filters on `repo_name`; without one it would return [] for a
    // reason that has nothing to do with the repo's persona history.
    return {
      ok: true, cloud: true, measured: false, reason: 'repo-name-unresolvable',
      scope: { mode: 'unresolved', repoId: repoId ?? null, slug: null },
      rows: [], scopedByRepoId: false,
    };
  }
  const rows = await ctx.deps.getPersonaSessionsByRepo({ ...parsed.data, repoName: effectiveName, repoId });
  return {
    ok: true, cloud: true, measured: true, rows, scopedByRepoId: Boolean(repoId),
    scope: { mode: requestedName ? 'explicit' : 'ambient', repoId: repoId ?? null, slug: effectiveName },
  };
}

/** `get-persona-sessions-by-url` — sessions for an app URL (no repo scope). */
export async function getPersonaSessionsByUrlCmd(ctx) {
  const urlFlag = ctx.flag('url');
  const limitFlag = ctx.flag('limit');
  const selectFlag = ctx.flag('select');
  const p = urlFlag
    ? {
        url: urlFlag,
        ...(limitFlag ? { limit: Number(limitFlag) } : {}),
        ...(selectFlag ? { select: csv(selectFlag) } : {}),
      }
    : ctx.payload();

  const parsed = GetPersonaSessionsByUrlSchema.safeParse(p);
  if (!parsed.success) {
    throw new CommandError('BAD_INPUT', '--url <app_url> required (optional: --limit <n>, --select <csv>)', { issues: parsed.error.issues });
  }
  if (!await ctx.deps.isPersonaCloudEnabled()) return { ...ctx.degrade(), rows: [] };
  const rows = await ctx.deps.getPersonaSessionsByUrl(parsed.data);
  return { ok: true, cloud: true, rows };
}

/**
 * `get-reachability-evidence` — per-persona reached destinations for
 * /nav-audit --bootstrap.
 *
 * The response is schema-validated BEFORE emission: it used to degrade a
 * malformed payload to `{ok:true, personas:[]}`, which withheld the bad data
 * (right) while calling that outcome a success (wrong) — the consumer cannot
 * tell "this repo has no evidence" from "the reader is broken", and reads the
 * second as the first.
 */
export async function getReachabilityEvidenceCmd(ctx) {
  const { ReachabilityEvidenceRequestSchema, ReachabilityEvidenceResponseSchema } = await import('../../schemas.mjs');
  const repoFlag = ctx.flag('repo');
  const limitFlag = ctx.flag('limit');
  const sinceDaysFlag = ctx.flag('since-days');
  const p = repoFlag
    ? {
        repoName: repoFlag,
        ...(limitFlag ? { limit: Number(limitFlag) } : {}),
        ...(sinceDaysFlag ? { sinceDays: Number(sinceDaysFlag) } : {}),
      }
    : ctx.payload();

  const parsed = ReachabilityEvidenceRequestSchema.safeParse(p);
  if (!parsed.success) {
    throw new CommandError('BAD_INPUT', '--repo <name> required (optional: --limit <n> per-persona, --since-days <d>)', { issues: parsed.error.issues });
  }
  if (!await ctx.deps.isPersonaCloudEnabled()) return { ...ctx.degrade(), personas: [] };

  const { personas } = await ctx.deps.getReachabilityEvidence({
    repoName: parsed.data.repoName,
    ...(parsed.data.limit ? { perPersona: parsed.data.limit } : {}),
    ...(parsed.data.sinceDays ? { sinceDays: parsed.data.sinceDays } : {}),
  });
  const validated = ReachabilityEvidenceResponseSchema.safeParse({ ok: true, cloud: true, personas });
  if (!validated.success) {
    throw new CommandError('PROTOCOL_VIOLATION',
      'reachability evidence failed its response schema — withholding the payload rather than reporting an empty success',
      { issues: validated.error.issues });
  }
  return validated.data;
}

/**
 * `get-recent-findings` — recent HIGH/MEDIUM audit findings for a repo,
 * for /persona-test Phase 0d enrichment.
 *
 * An explicit `--repo` is a deliberate cross-repo override and WINS: cwd
 * auto-resolution is skipped entirely when either identity field is supplied,
 * because checking only `!p.repoId` let cwd resolution clobber an explicit
 * `--repo` every time (the flag only ever populates `repoName`). `--repo-id`
 * is read here too (F16 — it was allowlisted but never read).
 */
export async function getRecentFindingsCmd(ctx) {
  const repoFlag = ctx.flag('repo');
  const repoIdFlag = ctx.flag('repo-id');
  const limitFlag = ctx.flag('limit');
  const severityFlag = ctx.flag('severity');
  const p = (repoFlag || repoIdFlag || limitFlag || severityFlag)
    ? {
        ...(repoFlag ? { repoName: repoFlag } : {}),
        ...(repoIdFlag ? { repoId: repoIdFlag } : {}),
        ...(limitFlag ? { limit: Number(limitFlag) } : {}),
        ...(severityFlag ? { severities: csv(severityFlag) } : {}),
      }
    : ctx.payload();

  if (!ctx.cloud.enabled) return { ...ctx.degrade(), findings: [] };

  if (!p.repoId && !p.repoName) {
    const { resolveRepoIdentity } = await import('../../repo-identity.mjs');
    const repoUuid = resolveRepoIdentity(process.cwd())?.repoUuid;
    const row = repoUuid ? await ctx.deps.getRepoIdByUuid(repoUuid).catch(() => null) : null;
    if (row?.id) p.repoId = row.id;
  }
  if (!p.repoId && !p.repoName) {
    throw new CommandError('BAD_INPUT',
      'no repo identity — run from a repo root or pass --repo <name> (optional: --limit <n>, --severity HIGH,MEDIUM)');
  }
  const findings = await ctx.deps.getRecentFindingsByRepo(p);
  return { ok: true, cloud: true, findings };
}
