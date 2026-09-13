/**
 * @fileoverview Final-review registry commands (docs/plans/cross-skill-command-registry.md
 * — Cluster B, Phase 3 writes; the readers `final-review-stats`/`-pending`
 * join in Cluster C).
 *
 * Behaviour-preserving moves. Both commands emit `{ok:false, cloud:false,
 * updated:0}` at EXIT 0 when cloud is off — a frozen legacy quirk, declared
 * `softFail` in the registry and pinned by the golden fixtures, not a
 * loophole discovered later.
 */
import { readFileSync } from 'node:fs';
import { CommandError } from '../dispatch.mjs';
import { groupIntoWorkUnits, wantsWorkUnits } from '../work-unit-grouping.mjs';
import { findRepoRootFromCwd } from '../../assert-repo-root.mjs';
import { classifyReadPath } from '../../path-validation.mjs';
import { checkFindingGrounding, formatGroundingNote } from '../../audit/finding-grounding.mjs';
import {
  classifyFinalReviewOutcome, summariseCounts, orderItems, isActionable, renderFinalReviewCard,
} from '../../final-review-credit.mjs';

/**
 * Keyset cursor for `final-review-pending` — the LAST RAW row of a page, in the
 * queue's total order (docs/plans/backlog-tooling-honesty.md §2). Opaque to the
 * caller (base64url JSON); `createdAt` is the store's `created_at_cursor`
 * text, never a Date, so a microsecond tie neither repeats nor skips a row.
 */
export function encodeQueueCursor({ severityRank, createdAt, fingerprint, runId }) {
  return Buffer.from(JSON.stringify({ v: 1, severityRank, createdAt, fingerprint, runId }), 'utf8').toString('base64url');
}

const PG_TIMESTAMPTZ_TEXT = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/;

/** Inverse of `encodeQueueCursor`; a malformed cursor is BAD_INPUT, never a silent first page. */
export function decodeQueueCursor(raw) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
  } catch {
    throw new CommandError('BAD_INPUT', '--after is not a cursor this command issued (undecodable)');
  }
  // Value DOMAINS, not just types (audit-code cluster B R1 M2): each member is
  // bound into the ordering query, so an out-of-domain value would surface as
  // a Postgres cast error — or, worse, compare as something. severity_rank is
  // the query's own CASE (0..3); createdAt must parse as a timestamp; runId is
  // a uuid; the fingerprint is the store's hex id.
  const ok = parsed && parsed.v === 1
    && Number.isInteger(parsed.severityRank) && parsed.severityRank >= 0 && parsed.severityRank <= 3
    // Postgres' own `timestamptz::text` shape (`2026-09-13 10:00:00.000001+00`),
    // pinned explicitly rather than through Date.parse, whose acceptance of this
    // shape is engine leniency, not a contract.
    && typeof parsed.createdAt === 'string' && PG_TIMESTAMPTZ_TEXT.test(parsed.createdAt)
    && typeof parsed.fingerprint === 'string' && /^[0-9a-f-]{1,64}$/i.test(parsed.fingerprint)
    && typeof parsed.runId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.runId);
  if (!ok) throw new CommandError('BAD_INPUT', '--after is not a cursor this command issued (field out of domain)');
  const { severityRank, createdAt, fingerprint, runId } = parsed;
  return { severityRank, createdAt, fingerprint, runId };
}

/** Shared bucket parsing: `--bucket primary|none` names the NULL bucket. */
function bucketOpt(ctx) {
  // `argOption` returns NULL for an absent flag, never `undefined` — the
  // `undefined` test once made the omitted-bucket branch UNREACHABLE, so every
  // caller that omitted `--bucket` silently got "scope to the PRIMARY bucket"
  // rather than the documented "let the store resolve it", and a shadow-only
  // finding matched 0 rows.
  const raw = ctx.flag('bucket');
  return raw === null ? {}
    : { bucket: (raw === 'primary' || raw === 'none') ? null : raw };
}

function bucketHint(res, extraReason, extraText) {
  if (res.reason === 'ambiguous-bucket') {
    return ` — fingerprint spans buckets [${(res.buckets || []).map((b) => b ?? 'primary').join(', ')}]; re-run with --bucket <name>`;
  }
  if (res.reason === extraReason) return extraText;
  return '';
}

/**
 * `final-review-adjudicate` — write the accepted/dismissed axis.
 *
 * A 0-row adjudication is a FAILURE, not a quiet success: reporting ok:true
 * there is how a hardcoded bucket filter went unnoticed — every primary
 * finding "adjudicated" fine and nothing changed.
 */
export async function finalReviewAdjudicateCmd(ctx) {
  // §2b F3: cloud-off is a SUPPORTED MODE, not a failure — AGENTS.md says so
  // outright, and 55 of the 60 originally-measured invocations already reported
  // it as {ok:true, cloud:false}. Reporting it as a failure made a machine that
  // simply has no store indistinguishable from one whose write broke.
  if (!ctx.cloud.enabled) return { ok: true, cloud: false, updated: 0 };
  const runId = ctx.flag('run-id');
  const fingerprint = ctx.flag('fingerprint');
  const action = ctx.flag('action');
  if (!runId || !fingerprint || !action) {
    throw new CommandError('BAD_INPUT', '--run-id <id> --fingerprint <hash> --action <accepted|dismissed> are all required');
  }
  if (action !== 'accepted' && action !== 'dismissed') {
    throw new CommandError('BAD_INPUT', `--action must be 'accepted' or 'dismissed', got '${action}'`);
  }
  const res = await ctx.deps.adjudicateFinalReviewFinding(runId, fingerprint, action, bucketOpt(ctx));
  if (!res.ok) {
    const hint = bucketHint(res, 'no-match-in-bucket',
      ` — no row in that bucket; present in [${(res.buckets || []).map((b) => b ?? 'primary').join(', ')}]`);
    throw new CommandError('ADJUDICATION_FAILED', `${res.reason || 'unknown'}${hint}`, {
      updated: 0, cloud: res.cloud, buckets: res.buckets,
    });
  }
  return res;
}

/**
 * `final-review-record-fix` — write the remediation axis.
 *
 * Deliberately separate from `--action`: accepted and fixed are orthogonal
 * axes (AGENTS.md two-axis model), and collapsing them would make "accepted,
 * fix pending" unrepresentable.
 */
export async function finalReviewRecordFixCmd(ctx) {
  // §2b F3: cloud-off is a SUPPORTED MODE, not a failure — AGENTS.md says so
  // outright, and 55 of the 60 originally-measured invocations already reported
  // it as {ok:true, cloud:false}. Reporting it as a failure made a machine that
  // simply has no store indistinguishable from one whose write broke.
  if (!ctx.cloud.enabled) return { ok: true, cloud: false, updated: 0 };
  const runId = ctx.flag('run-id');
  const fingerprint = ctx.flag('fingerprint');
  if (!runId || !fingerprint) {
    throw new CommandError('BAD_INPUT', '--run-id <id> and --fingerprint <hash> are both required');
  }
  const state = ctx.flag('state');
  const opts = {
    commitSha: ctx.flag('commit'),
    ...(state ? { state } : {}),
    ...bucketOpt(ctx),
  };
  const res = await ctx.deps.recordFinalReviewFix(runId, fingerprint, opts);
  if (!res.ok) {
    const hint = bucketHint(res, 'dismissed-cannot-be-fixed',
      ' — this finding was adjudicated `dismissed`; recording a fix for a non-issue is incoherent');
    throw new CommandError('RECORD_FIX_FAILED', `${res.reason || 'unknown'}${hint}`, {
      updated: 0, cloud: res.cloud, buckets: res.buckets,
    });
  }
  return res;
}

// ── Cluster D (Phase 5) — final-review readers ────────────────────────────

/**
 * Pre-fetch disconfirming evidence for one queued finding.
 *
 * Best-effort by contract: this decorates a review surface, so any failure
 * degrades to "no note". `primary_file` is MODEL-AUTHORED text — an untrusted
 * path source that is then READ and fed into a prompt bound for a third-party
 * LLM — so it goes through the single containment oracle. A prior version used
 * a bare `startsWith(resolve(root))`, wrong twice: no separator (so
 * `/repo-evil/x` passed for `/repo`) and no symlink resolution (INC-001's
 * bypass class landing on the sensitive-egress seam).
 */
function groundingNoteFor(f) {
  try {
    // The repo ROOT, not the cwd (audit-code cluster B R1 M1): `primary_file` is
    // repo-relative, and from a subdirectory every grounding read missed.
    const root = findRepoRootFromCwd();
    const res = checkFindingGrounding({
      detail: f.detail_snapshot || '',
      primaryFile: f.primary_file || '',
      readFile: (rel) => {
        const verdict = classifyReadPath({ repoRoot: root, candidate: rel });
        if (!verdict.ok) return null;
        return readFileSync(verdict.canonical, 'utf8');
      },
    });
    return formatGroundingNote(res);
  } catch { return ''; }
}

/** `final-review-stats` — the shadow-only queue, or its operator worksheet. */
export async function finalReviewStatsCmd(ctx) {
  const repoName = ctx.flag('repo');
  if (!repoName) throw new CommandError('BAD_INPUT', '--repo <name> is required');
  const limitFlag = ctx.flag('queue-limit');
  const res = await ctx.deps.getFinalReviewStats(repoName, limitFlag ? { queueLimit: Number(limitFlag) } : {});

  if (ctx.hasFlag('worksheet') && res.ok) {
    const { renderAdjudicationWorksheet } = await import('../../adjudication-worksheet.mjs');
    const { writeFileSync, mkdirSync, existsSync } = await import('node:fs');
    const pending = (res.shadowOnlyQueue || []).filter((f) => !f.user_action);
    // Is the requested repo the one this process is standing in? Compared by
    // FULL identity, never basename — `getFinalReviewStats` resolves `--repo`
    // against `audit_repos.name` (the `owner/repo` slug), and
    // `resolveRepoIdentity().name` produces that same slug in the normal
    // (git-origin-present) case, so exact equality is both correct and
    // available. A basename-only comparison would let two distinct repos that
    // happen to share a directory name (e.g. two orgs each hosting "widget")
    // collide, pulling this checkout's grounding notes into another repo's
    // worksheet — the sensitive-egress class AGENTS.md's sensitive-paths
    // doctrine warns against ("compare full identity, never a
    // substring/basename").
    const { resolveRepoIdentity } = await import('../../repo-identity.mjs');
    const ambientName = resolveRepoIdentity(findRepoRootFromCwd())?.name ?? null;
    const groundingIsAmbient = Boolean(ambientName && ambientName === repoName);
    const md = renderAdjudicationWorksheet({
      title: `Final-review shadow-only spot-check — repo ${repoName}`,
      introLines: [
        'Findings the SHADOW final reviewer raised that the primary did not. Accepting one is evidence the second gate earns its keep (pre-registered stopping rule in AGENTS.md).',
        groundingIsAmbient
          ? ''
          : `Grounding notes OMITTED: this worksheet is for repo "${repoName}" but is being generated from a different checkout ("${ambientName ?? 'unresolvable'}"). A note computed here would read THIS repo's files at the other repo's paths.`,
      ].filter(Boolean),
      // GROUNDING NOTES ARE AMBIENT-ONLY (audit CD-r1). `--repo` selects which
      // repository's findings to list, but groundingNoteFor reads
      // `primary_file` against `process.cwd()` — repo identity and filesystem
      // root are independent. Asking for another repo's queue from this
      // checkout would read THIS repo's files at those paths and attach the
      // result as evidence about the other repo's findings: a confidently
      // wrong note, which is worse than no note. So the note is computed only
      // when the requested repo IS the ambient one; otherwise it is omitted
      // and the worksheet says why.
      items: pending.map((f) => ({
        runId: f.run_id, fingerprint: f.finding_fingerprint, severity: f.severity,
        category: f.category, file: f.primary_file, detail: f.detail_snapshot,
        groundingNote: groundingIsAmbient ? groundingNoteFor(f) : '',
      })),
      actions: ['accepted', 'dismissed'],
      // `--bucket shadow-only` is explicit, not implied: this queue is
      // shadow-only by construction, and stating it means the documented
      // operator flow can never hit the ambiguous-bucket refusal.
      commandFor: (it, a) => `node scripts/cross-skill.mjs final-review-adjudicate --run-id ${it.runId} --fingerprint ${it.fingerprint} --action ${a} --bucket shadow-only`,
      generatedAt: new Date().toISOString(),
    });
    const dir = existsSync('docs/arm-eval') ? 'docs/arm-eval/worksheets' : '.audit';
    const out = ctx.flag('out') || `${dir}/final-review-adjudication-worksheet.md`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(out, md);
    process.stderr.write(`  [final-review-stats] worksheet: ${pending.length} pending finding(s) → ${out}\n`);
    return { ok: true, cloud: res.cloud, count: pending.length, worksheet: out };
  }
  // The store's result travels VERBATIM (legacy `emit(res)`), error shape
  // included — hence the declared softFail on this entry.
  return res;
}

/**
 * `final-review-pending` — findings awaiting credit; the READ that makes
 * /ship's nudge possible.
 *
 * THREE states, exit 0 for all of them (`ready`/`disabled`/`unavailable`),
 * because /ship must continue through every one: a credit nudge that can fail
 * a ship is worse than no nudge. The `unavailable` diagnostic is a CODE from a
 * closed set — never `err.message`, whose contents can include a DSN or key.
 */
export async function finalReviewPendingCmd(ctx) {
  const repoName = ctx.flag('repo');
  if (!repoName) throw new CommandError('BAD_INPUT', '--repo <name> is required');
  const wantRender = ctx.hasFlag('render');
  const commitSha = ctx.flag('commit') || null;
  // ONE paging resolver for every backlog reader (`resolveNudgePage`: default
  // 20, cap 200). `--page-size` is the documented alias of `--limit`; the
  // former 50-row clamp with no way past it left ~2,167 of 2,217 credit rows
  // unreachable through this CLI (backlog-tooling-honesty.md §1 item 2).
  const { limit } = ctx.deps.resolveNudgePage({ limit: ctx.flag('page-size') ?? ctx.flag('limit') ?? 10 });
  const afterRaw = ctx.flag('after');
  const after = afterRaw ? decodeQueueCursor(afterRaw) : null;

  const done = (result) => {
    if (!wantRender) return result;
    const text = renderFinalReviewCard(result, { commitSha });
    if (text) process.stdout.write(`${text}\n`);
    return undefined; // exit 0 with no JSON — the card IS the output
  };

  let res;
  try {
    if (!ctx.cloud.enabled) return done({ schemaVersion: 1, state: 'disabled' });
    res = await ctx.deps.getFinalReviewStats(repoName, { queueLimit: limit, after });
  } catch {
    // Boundary classifier: any thrown failure becomes ONE literal.
    return done({ schemaVersion: 1, state: 'unavailable', diagnostic: 'CLOUD_UNREACHABLE' });
  }
  if (!res?.ok) {
    const diagnostic = res?.error === 'NOT_MIGRATED' ? 'NOT_MIGRATED' : 'CLOUD_UNREACHABLE';
    return done({ schemaVersion: 1, state: 'unavailable', diagnostic });
  }
  if (!Array.isArray(res.pendingQueue) || !Array.isArray(res.actionablePairs)) {
    return done({ schemaVersion: 1, state: 'unavailable', diagnostic: 'MALFORMED_RESPONSE' });
  }

  const counts = summariseCounts(res.actionablePairs);
  // The store already returned ONE page in the queue's total order; `orderItems`
  // agrees with that order, so re-sorting is a no-op safety net, not paging.
  // No client-side slice: the page boundary is the store's, and the cursor is
  // derived from the last RAW row so a page whose every row was filtered out
  // still continues.
  const raw = orderItems(res.pendingQueue);
  const last = raw.length > 0 ? raw[raw.length - 1] : null;
  const nextCursor = last && raw.length >= limit
    ? encodeQueueCursor({
      severityRank: Number(last.severity_rank), createdAt: String(last.created_at_cursor ?? last.created_at),
      fingerprint: last.finding_fingerprint, runId: last.run_id,
    })
    : null;
  const classified = raw.map((r) => ({ ...r, classification: classifyFinalReviewOutcome(r) }));
  const actionable = classified.filter((r) => isActionable(r.classification));
  const pageFilteredOut = classified.length - actionable.length;
  const items = actionable
    // Display-safe projection ONLY — `detail_snapshot` is deliberately dropped:
    // it is free-form model prose and has no place in a ship card. `bucket`
    // is the row's REAL bucket (docs/plans/skill-efficacy-census.md Phase 1
    // fix) — an earlier version hardcoded `'shadow-only'` here, which made
    // every primary-bucket row's printed action resolve to the wrong bucket
    // even after the read side was widened.
    .map((r) => ({
      audit_finding_id: r.audit_finding_id ?? null,
      run_id: r.run_id, finding_fingerprint: r.finding_fingerprint, bucket: r.bucket ?? null,
      classification: r.classification, severity: r.severity, category: r.category,
      user_action: r.user_action ?? null, remediation_state: r.remediation_state ?? null,
      primary_file: r.primary_file ?? null, created_at: r.created_at ?? null,
    }));

  const base = {
    schemaVersion: 1, state: 'ready', cloud: true, repo: repoName, counts,
    shownCount: items.length, items,
    // Paging contract: loop on `nextCursor` (null = the store returned a short
    // page = exhausted), never on `shownCount` — `pageFilteredOut` says how many
    // raw rows this page fetched that were not actionable.
    limit, after: afterRaw ?? null, nextCursor, pageFilteredOut,
  };

  // Same grouper as the other two backlog readers; this reader's recency
  // column is `created_at`. Groups the ACTIONABLE rows of this page.
  const grouping = wantsWorkUnits(ctx);
  if (!grouping) return done(base);
  const grouped = await groupIntoWorkUnits(ctx, items, { total: counts.totalActionable, wantUnit: grouping.wantUnit, dateKey: 'created_at' });
  if (grouped.rows) grouped.items = grouped.rows;
  return done({ ...base, ...grouped });
}

/**
 * `shadow-overlap` — same-run overlap between a shadow reviewer and the
 * pipeline's own audit passes. Measures WITHIN-run overlap only.
 */
export async function shadowOverlapCmd(ctx) {
  const p = ctx.payload();
  if (!ctx.cloud.enabled) {
    return { ok: true, cloud: false, hint: 'cloud disabled — overlap is unmeasurable locally' };
  }
  const { computeShadowOverlap } = await import('../../model-eval/shadow-overlap.mjs');
  const res = await computeShadowOverlap({ runIds: p.runIds, shadowPass: p.shadowPass || 'final-review-shadow' });
  return { cloud: true, ...res };
}
