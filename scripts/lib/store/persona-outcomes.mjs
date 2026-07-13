/**
 * @fileoverview Durable persona-finding outcome labels — WS4 of
 * docs/completed/persona-nav-feedback-recovery.md. REPO-scoped (not
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
import { personaFindingHash } from '../persona/audit-correlator.mjs';
import { retireMissedCorrelationsForHash } from './plans-ship.mjs';

const OUTCOMES = ['fixed', 'dismissed', 'wont_fix', 'stale'];
const DISMISSIVE = new Set(['dismissed', 'wont_fix']);

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
      `SELECT id, repo_id, findings FROM persona_test_sessions WHERE id = $1`,
      [sessionId],
    );
    if (!session) return { ok: false, error: `no session found for id ${sessionId}` };
    if (!session.repo_id) return { ok: false, error: `session ${sessionId} has no resolved repo_id — cannot scope a durable outcome label` };
    const known = (session.findings || []).filter(isP0OrP1).some((f) => personaFindingHash(f) === hash);
    if (!known) return { ok: false, error: `hash ${hash} does not match any P0/P1 finding in session ${sessionId}` };
    return { ok: true, repoId: session.repo_id };
  } catch (err) {
    process.stderr.write(`  [persona-outcomes] resolveLabelTarget failed: ${err.message}\n`);
    return { ok: false, error: err.message };
  }
}

const LabelArgsSchema = z.object({
  repoId: z.string().min(1),
  personaFindingHash: z.string().min(1),
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
      await upsert(
        'persona_finding_outcomes',
        [{
          repo_id: args.repoId,
          persona_finding_hash: args.personaFindingHash,
          outcome: args.outcome,
          last_seen_session_id: args.lastSeenSessionId ?? null,
          labeled_by: args.labeledBy,
          rationale: args.rationale ?? null,
        }],
        {
          onConflict: ['repo_id', 'persona_finding_hash'],
          update: ['outcome', 'last_seen_session_id', 'labeled_by', 'rationale'],
        },
      );
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

/** P0/P1 only — matches the correlator's ground-truth scope (WS1). */
function isP0OrP1(finding) {
  return finding?.code === 'P0' || finding?.code === 'P1';
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
 * Repo scope comes from the SESSION's OWN `repo_id` column (code-audit
 * H4 fix), not a second `repo_id = getRepoIdByName(repoName)` lookup —
 * `repo_name` is a display string that can drift (renames, two repos
 * sharing a bare name); re-resolving it independently of the session
 * that was just selected BY that same name risked the session lookup and
 * the ledger join silently landing on two DIFFERENT canonical repos. A
 * session with no resolved `repo_id` (couldn't be identified at record
 * time) correctly degrades to "no ledger data" rather than guessing.
 *
 * @param {{repoName: string}} args
 */
export async function getPersonaOutcomesSummary({ repoName }) {
  if (!repoName) return { ok: false, error: 'repoName is required' };
  if (!await isCloudEnabled()) return { ok: true, cloud: false, sessionId: null };
  try {
    // persona/verdict included (code-audit M1 fix) — /ship's UX-GATE
    // warning template renders `Last persona test: "<persona>" ... →
    // <verdict>`, which the original summary shape didn't carry.
    const session = await one(
      `SELECT id, repo_id, persona, verdict, created_at, findings
         FROM persona_test_sessions
        WHERE repo_name = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [repoName],
    );
    if (!session) return { ok: true, cloud: true, sessionId: null };

    const p0p1 = (session.findings || []).filter(isP0OrP1);
    const rawP0 = p0p1.filter((f) => f.code === 'P0').length;
    const rawP1 = p0p1.filter((f) => f.code === 'P1').length;

    const repoId = session.repo_id;
    const outcomeByHash = new Map();
    if (repoId && p0p1.length > 0) {
      const hashes = p0p1.map((f) => personaFindingHash(f));
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
      const hash = personaFindingHash(f);
      const outcome = outcomeByHash.get(hash);
      const isOpen = !DISMISSIVE.has(outcome);
      if (!isOpen) { closed += 1; continue; }
      if (outcome === 'fixed') openRelabeledFixed += 1;
      else if (outcome === 'stale') openRelabeledStale += 1;
      else unlabeled += 1;
      if (f.code === 'P0') openP0 += 1; else openP1 += 1;
    }

    return {
      ok: true, cloud: true,
      sessionId: session.id, sessionCreatedAt: session.created_at,
      persona: session.persona, verdict: session.verdict,
      rawP0, rawP1,
      labeled: { closed, open_relabeled_fixed: openRelabeledFixed, open_relabeled_stale: openRelabeledStale, unlabeled },
      openP0, openP1,
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
 * Repo scope comes from the LATEST session's OWN `repo_id` (code-audit
 * H4 fix), matching `getPersonaOutcomesSummary` — never a second
 * `getRepoIdByName` lookup independent of which session/name was
 * actually selected.
 *
 * @param {{repoName: string}} args
 * @returns {Promise<{ok: boolean, cloud: boolean, items: Array<object>, truncated: boolean, error?: string}>}
 */
export async function getActionablePersonaOutcomeItems({ repoName }) {
  if (!repoName) return { ok: false, cloud: false, items: [], truncated: false, error: 'repoName is required' };
  if (!await isCloudEnabled()) return { ok: true, cloud: false, items: [], truncated: false };
  try {
    const sessions = await many(
      `SELECT id, repo_id, created_at, findings
         FROM persona_test_sessions
        WHERE repo_name = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [repoName, WORKSHEET_SESSION_LIMIT],
    );
    if (sessions.length === 0) return { ok: true, cloud: true, items: [], truncated: false };

    const latestSessionId = sessions[0].id;
    const latestHashes = new Set((sessions[0].findings || []).filter(isP0OrP1).map((f) => personaFindingHash(f)));

    // Dedupe by hash across the scanned sessions, keeping the NEWEST
    // occurrence for display (sessions are already newest-first).
    const byHash = new Map();
    for (const s of sessions) {
      for (const f of (s.findings || []).filter(isP0OrP1)) {
        const hash = personaFindingHash(f);
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
        severity: entry.finding.code,
        element: entry.finding.element,
        observed: entry.finding.observed,
      });
    }
    // Newest-session-first (already the dedup-keep order); cap the OUTPUT,
    // never the underlying scan — truncation is observable, not silent.
    actionable.sort((a, b) => new Date(b.sessionCreatedAt) - new Date(a.sessionCreatedAt));
    const truncated = actionable.length > WORKSHEET_ROW_LIMIT;
    return {
      ok: true, cloud: true,
      items: actionable.slice(0, WORKSHEET_ROW_LIMIT),
      truncated,
      latestSessionId,
    };
  } catch (err) {
    process.stderr.write(`  [persona-outcomes] getActionablePersonaOutcomeItems failed: ${err.message}\n`);
    return { ok: false, cloud: true, items: [], truncated: false, error: err.message };
  }
}
