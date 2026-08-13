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

const PERSONA_OUTCOME_VALUES = ['fixed', 'dismissed', 'wont_fix', 'stale'];

const AddPersonaRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  appUrl: z.url(),
  appName: z.string().optional(),
  notes: z.string().optional(),
  repoName: z.string().optional(),
});

const RecordPersonaSessionRequestSchema = z.object({
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
  verdict: z.enum(['Ready for users', 'Needs work', 'Blocked']),
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
      // Every interpolated value is SHELL-QUOTED (audit CB-r2). A rendered
      // command is read as evidence the operator can paste it — that is the
      // whole reason it saves typing — and `sessionId` reaches the database
      // from a caller-supplied payload that validates only "non-empty string",
      // so backticks / `$(…)` / `$VAR` can ride into a pasteable line. The
      // sibling lock-with-test worksheet closed exactly this with the same
      // oracle; this one had not been given it.
      commandFor: (it, a) => 'node scripts/cross-skill.mjs persona-outcomes label'
        + ` --session ${shellQuoteSingle(String(it.runId))}`
        + ` --hash ${shellQuoteSingle(String(it.fingerprint))}`
        + ` --outcome ${a}`
        + ((a === 'dismissed' || a === 'wont_fix') ? ' --rationale "<why>"' : ''),
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
    // The store's result travels VERBATIM, INCLUDING its `{ok:false}` error
    // shape — which is a real store failure carrying its own diagnosis, so
    // `reportsFailure` keeps the payload and exits 1. Under the old softFail
    // it exited 0, telling every caller that checks $? that a failed summary
    // query had succeeded.
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
  return { cloud: true, ...result, sessionKey: data.sessionId, correlationSummary };
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
  const base = { attempted: false, candidates: 0, exact: 0, fuzzy: 0, missed: 0, skippedExisting: 0, malformed: 0, writeFailed: 0, matcherVersion: MATCHER_VERSION };
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

    let exact = 0, fuzzy = 0, missed = 0, writeFailed = 0;
    for (const emission of emissions) {
      if (emission._tier === 'exact') exact += 1;
      else if (emission._tier === 'fuzzy') fuzzy += 1;
      else missed += 1;
      const writeResult = await deps.recordPersonaAuditCorrelation(sessionId, emission);
      if (!writeResult.ok) {
        writeFailed += 1;
        process.stderr.write(`  [correlator] write failed for finding ${emission.personaFindingHash}: ${writeResult.error}\n`);
      }
    }

    const summary = {
      attempted: true, candidates: candResult.rows.length,
      exact, fuzzy, missed, skippedExisting, malformed, writeFailed, matcherVersion: MATCHER_VERSION,
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
 * NOTE (Cluster F): `personaSessionId` is an opaque parent id with no
 * ownership check — the deferred `parent: {table:'persona_test_sessions'}`
 * declaration lands here.
 */
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
    const code = result.reason === 'parent-not-found' ? 'PARENT_NOT_FOUND'
      : result.reason === 'parent-not-owned' ? 'PARENT_NOT_OWNED' : 'WRITE_FAILED';
    throw new CommandError(code, result.error || 'correlation write failed', { reason: result.reason }, 1);
  }
  return { ok: true, cloud: true };
}

// ── Cluster D (Phase 5) — persona readers ─────────────────────────────────
// Post-RLS-hardening these ARE the supported read path: anon curl reads are
// blocked at the policy boundary, so the SKILL.md files call these commands.

const ListPersonasRequestSchema = z.object({ url: z.url() });

const GetPersonaSessionsByRepoSchema = z.object({
  repoName: z.string().min(1),
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
 * The repoId comes from the REQUESTED name, never the ambient checkout: the
 * store predicate is `repo_name = $1 AND (repo_id = $3 OR repo_id IS NULL)`,
 * so an ambient id made the two clauses name different repos and returned
 * `rows: []` alongside `scopedByRepoId: true` — a false zero wearing a field
 * that asserts correct scoping (F10).
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
    throw new CommandError('BAD_INPUT', '--repo <name> required (optional: --limit <n>, --p0-only, --select <csv>)', { issues: parsed.error.issues });
  }
  if (!await ctx.deps.isPersonaCloudEnabled()) return { ...ctx.degrade(), rows: [] };
  const scope = await ctx.resolveScope({ explicitRepoName: parsed.data.repoName });
  const repoId = scope.repoId;
  const rows = await ctx.deps.getPersonaSessionsByRepo({ ...parsed.data, repoId });
  return { ok: true, cloud: true, rows, scopedByRepoId: Boolean(repoId) };
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
