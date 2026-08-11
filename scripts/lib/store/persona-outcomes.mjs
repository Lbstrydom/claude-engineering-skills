/**
 * @fileoverview Durable persona-finding outcome labels — WS4 of
 * docs/plans/persona-nav-feedback-recovery.md. REPO-scoped (not
 * session-scoped): a `dismissed`/`wont_fix` label must survive across
 * persona-test runs, or the ship gate re-flags the same false positive
 * every session — the "don't ask the user the same thing twice" failure
 * this workstream exists to prevent.
 *
 * Reconciled at implementation time: the plan's Cluster 3 declared `Files:`
 * list didn't name a dedicated store module (only `cross-skill.mjs`) —
 * co-locating ~150 lines of new SQL directly in the CLI would compound the
 * "God CLI" structural debt already flagged (and dismissed as pre-existing)
 * across the Cluster 1/2 audits. A new file matches the established
 * per-domain-module convention (`store/nav-audit.mjs`, `store/persona.mjs`).
 *
 * @module scripts/lib/store/persona-outcomes
 */
import { z } from 'zod';
import { many, one, upsert, withTx } from '../db/query.mjs';
import { isCloudEnabled } from './repo.mjs';
import {
  personaFindingHash, isP0OrP1, isMalformedFinding, buildStepUrlLookup,
  personaSeverityCode,
  PERSONA_FINDING_HASH_VERSION, PERSONA_FINDING_HASH_SHAPE,
} from '../persona/audit-correlator.mjs';
import { retireMissedCorrelationsForHash } from './plans-ship.mjs';

const OUTCOMES = ['fixed', 'dismissed', 'wont_fix', 'stale'];
const DISMISSIVE = new Set(['dismissed', 'wont_fix']);

// Gemini gate finding G1: a malformed finding (missing element/observed)
// collapses onto the SAME synthetic personaFindingHash as every other
// malformed finding in the repo — decideCorrelations already quarantines
// these before hashing; every read/write path here that filters P0/P1
// findings before hashing must ALSO exclude malformed ones, or a human
// dismissing one malformed finding silently wildcard-dismisses all others
// sharing that empty-fields hash.
const isIdentifiableP0OrP1 = (f) => isP0OrP1(f) && !isMalformedFinding(f);

/**
 * Resolve a `label` command's `--session <id> --hash <h>` pair into a
 * writable target — the store verifies the supplied hash exists in the
 * target session's OWN findings (via the shared `personaFindingHash` from
 * WS1) so an unknown/mistyped hash is a friendly CLI error, never a
 * silent orphan row (plan §WS4). Also resolves the session's `repo_id`
 * (persisted on the session row at record time) — the durable identity
 * `persona_finding_outcomes` is keyed on, so a `--repo` flag is never
 * needed on `label` (only on `summary`/`--worksheet`, which have no
 * single session to anchor to).
 *
 * @returns {Promise<{ok: boolean, repoId?: string, error?: string}>}
 */
export async function resolveLabelTarget({ sessionId, personaFindingHash: hash }) {
  if (!sessionId || !hash) return { ok: false, error: 'sessionId and personaFindingHash are required' };
  if (!await isCloudEnabled()) return { ok: false, error: 'cloud not configured' };
  try {
    const session = await one(
      `SELECT id, repo_id, findings, click_path FROM persona_test_sessions WHERE id = $1`,
      [sessionId],
    );
    if (!session) return { ok: false, error: `no session found for id ${sessionId}` };
    if (!session.repo_id) return { ok: false, error: `session ${sessionId} has no resolved repo_id — cannot scope a durable outcome label` };
    const stepUrlByNumber = buildStepUrlLookup(session.click_path);
    const known = (session.findings || []).filter(isIdentifiableP0OrP1).some((f) => personaFindingHash(f, stepUrlByNumber) === hash);
    if (!known) return { ok: false, error: `hash ${hash} does not match any P0/P1 finding in session ${sessionId}` };
    return { ok: true, repoId: session.repo_id };
  } catch (err) {
    process.stderr.write(`  [persona-outcomes] resolveLabelTarget failed: ${err.message}\n`);
    return { ok: false, error: err.message };
  }
}

// docs/plans/persona-finding-hash-versioning.md, code-audit R1 findings
// M1/M7, tightened at R2 (H1/H5/H6 — the R1 fix accepted EITHER shape but
// still unconditionally stamped `hash_version: PERSONA_FINDING_HASH_VERSION`
// (2), so a v1-shaped (8-hex) hash could be persisted confidently
// mislabeled as v2): `upsertPersonaFindingOutcome` is the write path for
// NEW durable labels going forward — there is no legitimate caller that
// should ever target a v1-shaped hash here (the backfill writes v2 rows
// via its own direct SQL, never through this function). Only the CURRENT
// v2 shape (64-hex) is accepted; v1 (8-hex) values are historical-only and
// belong exclusively to the backfill's read path (`personaFindingHashV1`).
// `PERSONA_FINDING_HASH_SHAPE` itself now lives in audit-correlator.mjs —
// shared with `plans-ship.mjs`'s `recordPersonaAuditCorrelation` (Gemini
// gate R2 shadow finding 6277c9df).

const LabelArgsSchema = z.object({
  repoId: z.string().min(1),
  personaFindingHash: z.string().regex(PERSONA_FINDING_HASH_SHAPE, 'must be a 64-hex (v2) persona finding hash — v1 (8-hex) hashes are historical-only and never a valid write target'),
  outcome: z.enum(OUTCOMES),
  lastSeenSessionId: z.string().nullable().optional(),
  labeledBy: z.string().min(1),
  rationale: z.string().nullable().optional(),
}).refine(
  (v) => !DISMISSIVE.has(v.outcome) || (v.rationale && v.rationale.trim().length > 0),
  { message: 'rationale is required for dismissed/wont_fix outcomes' },
);

/**
 * Upsert one durable outcome label — `ON CONFLICT (repo_id,
 * persona_finding_hash) DO UPDATE`, preserving `created_at` (the table's
 * own default only applies on first insert) while a DB-side trigger
 * (`touch_persona_finding_outcomes_updated_at`) bumps `updated_at` to the
 * SERVER's `now()` on every UPDATE — deliberately NOT a client-JS
 * timestamp: an empirical smoke test caught real clock skew between this
 * machine and the remote Supabase instance producing a nonsensical
 * `updated_at < created_at` reading when both columns used different
 * clock sources. Last-write-wins is the deliberate single-operator design
 * (an append-only revision ledger is the over-engineered version — see
 * the plan's WS4 section).
 *
 * A `dismissed`/`wont_fix` label CASCADES to retire any auto-emitted
 * `audit_missed` correlation row for the same hash, SCOPED TO THIS REPO
 * (code-audit H5 fix — the retirement is now repo_id-joined, closing a
 * real cross-repo contamination gap; Gemini gate round-3 finding — a
 * human rejecting a finding retires its false ground truth the same way
 * a human CONFIRMING it retires the stale miss via WS1's manual-repair
 * path). `fixed`/`stale` do not touch correlations — those outcomes
 * don't contest the correlation's truth, only the finding's current
 * status. The upsert and the cascade run in ONE transaction (code-audit
 * H6 fix) — a dismissal must never commit the label without also
 * retiring the stale ground truth (or vice versa on failure).
 *
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function upsertPersonaFindingOutcome(rawArgs) {
  const parsed = LabelArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return { ok: false, error: `invalid args: ${parsed.error.message}` };
  const args = parsed.data;
  if (!await isCloudEnabled()) return { ok: true };
  try {
    await withTx(async () => {
      // `updated_at` is deliberately absent here — the DB-side touch
      // trigger owns it on UPDATE, and the column DEFAULT owns it on
      // INSERT, keeping both `created_at`/`updated_at` on the same
      // (server) clock. buildUpsert requires every `update` column to be
      // present in the inserted row, so it cannot be listed here either.
      const { rowCount } = await upsert(
        'persona_finding_outcomes',
        [{
          repo_id: args.repoId,
          persona_finding_hash: args.personaFindingHash,
          outcome: args.outcome,
          last_seen_session_id: args.lastSeenSessionId ?? null,
          labeled_by: args.labeledBy,
          rationale: args.rationale ?? null,
          // docs/plans/persona-finding-hash-versioning.md, R2 finding M3 —
          // NOT MATCHER_VERSION, a separate concern.
          hash_version: PERSONA_FINDING_HASH_VERSION,
          // code-audit R4 finding H2 (compromise): a direct human label is
          // ALWAYS authoritative over a backfill's provenance — clearing
          // `migrated_at` here (on both insert AND re-label) means the
          // backfill's conditional-reconciliation `WHERE migrated_at IS
          // NOT NULL` can never touch a row a human has directly written
          // or re-labeled, protecting genuine intent from ever being
          // silently overwritten by a later backfill run.
          migrated_at: null,
        }],
        {
          onConflict: ['repo_id', 'persona_finding_hash'],
          update: ['outcome', 'last_seen_session_id', 'labeled_by', 'rationale', 'hash_version', 'migrated_at'],
        },
      );
      // code-audit R1 finding H2: the write's success was never actually
      // verified — a silently-swallowed conflict or RLS denial would still
      // return {ok:true}. One row affected is the only expected outcome
      // for a single-row upsert.
      if (rowCount !== 1) {
        throw new Error(`upsertPersonaFindingOutcome: expected exactly 1 affected row, got ${rowCount}`);
      }
      if (DISMISSIVE.has(args.outcome)) {
        await retireMissedCorrelationsForHash(args.repoId, args.personaFindingHash);
      }
    });
    return { ok: true };
  } catch (err) {
    process.stderr.write(`  [persona-outcomes] upsertPersonaFindingOutcome failed: ${err.message}\n`);
    return { ok: false, error: err.message };
  }
}

/**
 * `staleHashCount` = rows still on an older hash scheme than the current
 * `PERSONA_FINDING_HASH_VERSION` — a plain, honest fact ("N rows are on
 * the old scheme"), NOT a proxy for "N rows need action." The backfill is
 * additive-only (a v1 row is never deleted whether recovered or
 * unrecoverable), so this count can NEVER mechanically reach zero for a
 * repo with even one genuinely unrecoverable finding — the hint text below
 * says so explicitly rather than implying an unconditional "run this to
 * fix it" (docs/plans/persona-finding-hash-versioning.md, Gemini gate R3
 * finding G1 — a real UX bug: an unconditional hint would nag every
 * `/ship` forever). Deliberately no new "already attempted" tracking
 * column — that would itself go stale the day a matching new session
 * makes a previously-unrecoverable finding recoverable after all.
 * @returns {Promise<{staleHashCount: number, hint: string|null}>}
 */
async function getStaleHashSummary(repoId, repoName) {
  const row = await one(
    `SELECT count(*)::int AS n FROM persona_finding_outcomes
      WHERE repo_id = $1 AND hash_version < $2`,
    [repoId, PERSONA_FINDING_HASH_VERSION],
  );
  const staleHashCount = row?.n ?? 0;
  if (staleHashCount === 0) return { staleHashCount: 0, hint: null };
  const hint = `${staleHashCount} outcome label(s) are on an old hash scheme. ` +
    `Run: node scripts/cross-skill.mjs persona-outcomes backfill-hash --repo ${repoName ?? '<name>'} ` +
    `(safe to re-run). Some may be permanently unrecoverable — this count is not guaranteed to reach zero.`;
  return { staleHashCount, hint };
}

/**
 * Ship-gate read path: the repo's LATEST session's raw P0/P1 findings
 * joined against the repo-level outcome ledger's row per hash.
 * `dismissed`/`wont_fix` close a finding durably across sessions;
 * `fixed`/`stale`/no-row leave it OPEN — a finding relabeled `fixed` that
 * the current session still observes is exactly a regression, and must
 * re-flag, not silently close (the plan's regression-handling rule).
 *
 * Closed failure semantics (never a NEW ship-gate blocker):
 * `cloud:false` → caller falls back to today's raw p0_count read exactly
 * as before. No session found → `{ok:true, sessionId:null}` (gate
 * silent). Store/query failure → `{ok:false, error}` (caller falls back).
 *
 * Repo scope, once a session is selected, comes from that SESSION's OWN
 * `repo_id` column (code-audit H4 fix), not a second
 * `repo_id = getRepoIdByName(repoName)` lookup — re-resolving it
 * independently of the session that was just selected risked the session
 * lookup and the ledger join silently landing on two DIFFERENT canonical
 * repos.
 *
 * 88bc75e1/8993b96f (2026-07-27 correction): H4's fix above only made the
 * lookup INTERNALLY consistent (whatever session gets picked, its own
 * repo_id is used everywhere) — it did not address the SELECTION itself.
 * `repo_name` is a caller-supplied display string (`PERSONA_TEST_REPO_NAME`,
 * a free-form per-project `.env` value, not derived from git remote the
 * way `LEARNING_REPO_NAME` is), so two distinct repos sharing or reusing a
 * name still had a real path to selecting the WRONG repo's session
 * entirely. `repoId`, when the caller can resolve one (via the same
 * `resolveRepoIdentity()` mechanism used elsewhere), is now the PRIMARY
 * selection key — `repo_name` is used only as a fallback when identity
 * resolution genuinely fails (not a git repo, not yet registered), which
 * is the same class of degradation this function already applies for a
 * session with no resolved `repo_id`.
 *
 * @param {{repoName: string, repoId?: string|null}} args
 */
export async function getPersonaOutcomesSummary({ repoName, repoId: callerRepoId = null }) {
  if (!repoName) return { ok: false, error: 'repoName is required' };
  if (!await isCloudEnabled()) return { ok: true, cloud: false, sessionId: null };
  try {
    // persona/verdict included (code-audit M1 fix) — /ship's UX-GATE
    // warning template renders `Last persona test: "<persona>" ... →
    // <verdict>`, which the original summary shape didn't carry.
    const session = callerRepoId
      ? await one(
        `SELECT id, repo_id, persona, verdict, created_at, findings, click_path
           FROM persona_test_sessions
          WHERE repo_id = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        [callerRepoId],
      )
      : await one(
        `SELECT id, repo_id, persona, verdict, created_at, findings, click_path
           FROM persona_test_sessions
          WHERE repo_name = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        [repoName],
      );
    if (!session) return { ok: true, cloud: true, sessionId: null };

    const stepUrlByNumber = buildStepUrlLookup(session.click_path);
    const p0p1 = (session.findings || []).filter(isIdentifiableP0OrP1);
    const rawP0 = p0p1.filter((f) => personaSeverityCode(f) === 'P0').length;
    const rawP1 = p0p1.filter((f) => personaSeverityCode(f) === 'P1').length;

    const repoId = session.repo_id;
    const outcomeByHash = new Map();
    if (repoId && p0p1.length > 0) {
      const hashes = p0p1.map((f) => personaFindingHash(f, stepUrlByNumber));
      const rows = await many(
        `SELECT persona_finding_hash, outcome
           FROM persona_finding_outcomes
          WHERE repo_id = $1 AND persona_finding_hash = ANY($2)`,
        [repoId, hashes],
      );
      for (const r of rows) outcomeByHash.set(r.persona_finding_hash, r.outcome);
    }

    let closed = 0, openRelabeledFixed = 0, openRelabeledStale = 0, unlabeled = 0, openP0 = 0, openP1 = 0;
    for (const f of p0p1) {
      const hash = personaFindingHash(f, stepUrlByNumber);
      const outcome = outcomeByHash.get(hash);
      const isOpen = !DISMISSIVE.has(outcome);
      if (!isOpen) { closed += 1; continue; }
      if (outcome === 'fixed') openRelabeledFixed += 1;
      else if (outcome === 'stale') openRelabeledStale += 1;
      else unlabeled += 1;
      if (personaSeverityCode(f) === 'P0') openP0 += 1; else openP1 += 1;
    }

    const { staleHashCount, hint } = repoId
      ? await getStaleHashSummary(repoId, repoName)
      : { staleHashCount: 0, hint: null };

    return {
      ok: true, cloud: true,
      sessionId: session.id, sessionCreatedAt: session.created_at,
      persona: session.persona, verdict: session.verdict,
      rawP0, rawP1,
      labeled: { closed, open_relabeled_fixed: openRelabeledFixed, open_relabeled_stale: openRelabeledStale, unlabeled },
      openP0, openP1,
      staleHashCount, hint,
    };
  } catch (err) {
    process.stderr.write(`  [persona-outcomes] getPersonaOutcomesSummary failed: ${err.message}\n`);
    return { ok: false, error: err.message };
  }
}

const WORKSHEET_SESSION_LIMIT = 10;
const WORKSHEET_ROW_LIMIT = 50;

/**
 * Actionable worksheet items — NOT merely "unlabeled" (Gemini gate
 * round-3 finding: a finding relabeled `fixed` but reappearing in a
 * newer session already HAS a ledger row, so a naive unlabeled-only
 * filter would hide it from the exact surface meant to re-adjudicate
 * it). Actionable = no ledger row exists for the hash (an accumulating
 * backlog of never-triaged findings, regardless of which of the last
 * `WORKSHEET_SESSION_LIMIT` sessions first raised it) OR the ledger's
 * latest outcome is `fixed`/`stale` AND the finding reappears in the
 * CURRENT (latest) session (a genuine regression) — the same
 * open-vs-closed rule `getPersonaOutcomesSummary` uses, so the worksheet
 * and the ship gate can never disagree about what's still open.
 *
 * Bounded + ordered: last `WORKSHEET_SESSION_LIMIT` sessions, max
 * `WORKSHEET_ROW_LIMIT` rows, newest first — never a silent truncation
 * (`truncated: true` when clipped).
 *
 * Repo scope, once sessions are selected, comes from the LATEST session's
 * OWN `repo_id` (code-audit H4 fix), matching `getPersonaOutcomesSummary`
 * — never a second `getRepoIdByName` lookup independent of which
 * session/name was actually selected.
 *
 * 88bc75e1/8993b96f (2026-07-27): same correction as
 * `getPersonaOutcomesSummary` — `repoId`, when the caller can resolve one,
 * is the PRIMARY selection key; `repo_name` is the fallback only when
 * identity resolution genuinely fails. See that function's docstring for
 * the full rationale.
 *
 * @param {{repoName: string, repoId?: string|null}} args
 * @returns {Promise<{ok: boolean, cloud: boolean, items: Array<object>, truncated: boolean, error?: string}>}
 */
export async function getActionablePersonaOutcomeItems({ repoName, repoId: callerRepoId = null }) {
  if (!repoName) return { ok: false, cloud: false, items: [], truncated: false, error: 'repoName is required' };
  if (!await isCloudEnabled()) return { ok: true, cloud: false, items: [], truncated: false };
  try {
    const sessions = callerRepoId
      ? await many(
        `SELECT id, repo_id, created_at, findings, click_path
           FROM persona_test_sessions
          WHERE repo_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [callerRepoId, WORKSHEET_SESSION_LIMIT],
      )
      : await many(
        `SELECT id, repo_id, created_at, findings, click_path
           FROM persona_test_sessions
          WHERE repo_name = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [repoName, WORKSHEET_SESSION_LIMIT],
      );
    if (sessions.length === 0) return { ok: true, cloud: true, items: [], truncated: false };

    // One stepUrlByNumber PER session — `step` numbers are session-relative
    // indices, so a single shared map across sessions would misattribute
    // routes (docs/plans/persona-finding-hash-versioning.md, §4).
    const stepUrlBySessionId = new Map(
      sessions.map((s) => [s.id, buildStepUrlLookup(s.click_path)]),
    );
    const latestSessionId = sessions[0].id;
    const latestStepUrlByNumber = stepUrlBySessionId.get(latestSessionId);
    const latestHashes = new Set(
      (sessions[0].findings || []).filter(isIdentifiableP0OrP1).map((f) => personaFindingHash(f, latestStepUrlByNumber)),
    );

    // Dedupe by hash across the scanned sessions, keeping the NEWEST
    // occurrence for display (sessions are already newest-first).
    const byHash = new Map();
    for (const s of sessions) {
      const stepUrlByNumber = stepUrlBySessionId.get(s.id);
      for (const f of (s.findings || []).filter(isIdentifiableP0OrP1)) {
        const hash = personaFindingHash(f, stepUrlByNumber);
        if (!byHash.has(hash)) byHash.set(hash, { finding: f, sessionId: s.id, sessionCreatedAt: s.created_at });
      }
    }

    const repoId = sessions[0].repo_id;
    const outcomeByHash = new Map();
    if (repoId && byHash.size > 0) {
      const rows = await many(
        `SELECT persona_finding_hash, outcome
           FROM persona_finding_outcomes
          WHERE repo_id = $1 AND persona_finding_hash = ANY($2)`,
        [repoId, [...byHash.keys()]],
      );
      for (const r of rows) outcomeByHash.set(r.persona_finding_hash, r.outcome);
    }

    const actionable = [];
    for (const [hash, entry] of byHash) {
      const outcome = outcomeByHash.get(hash);
      const isActionable = !outcome || ((outcome === 'fixed' || outcome === 'stale') && latestHashes.has(hash));
      if (!isActionable) continue;
      actionable.push({
        personaFindingHash: hash,
        outcome: outcome ?? null,
        sessionId: entry.sessionId,
        sessionCreatedAt: entry.sessionCreatedAt,
        severity: personaSeverityCode(entry.finding),
        element: entry.finding.element,
        observed: entry.finding.observed,
      });
    }
    const { staleHashCount, hint } = repoId
      ? await getStaleHashSummary(repoId, repoName)
      : { staleHashCount: 0, hint: null };
    // Newest-session-first (already the dedup-keep order); cap the OUTPUT,
    // never the underlying scan — truncation is observable, not silent.
    actionable.sort((a, b) => new Date(b.sessionCreatedAt) - new Date(a.sessionCreatedAt));
    const truncated = actionable.length > WORKSHEET_ROW_LIMIT;
    return {
      ok: true, cloud: true,
      items: actionable.slice(0, WORKSHEET_ROW_LIMIT),
      truncated,
      latestSessionId,
      staleHashCount, hint,
    };
  } catch (err) {
    process.stderr.write(`  [persona-outcomes] getActionablePersonaOutcomeItems failed: ${err.message}\n`);
    return { ok: false, cloud: true, items: [], truncated: false, error: err.message };
  }
}
