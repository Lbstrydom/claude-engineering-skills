/**
 * @fileoverview Persona-test domain — personas + persona_test_sessions.
 *
 * Part of the postgres-parity M3 split. 6 functions covering persona
 * registration, session recording, and per-repo/url session queries.
 *
 * **Key simplification under M3**: the legacy `getPersonaSupabase()` lazy-
 * initialised a SEPARATE supabase-js client because the persona-test
 * Supabase project was historically distinct. Post-consolidation
 * (commit 9e43d9e — data migrated to the audit-loop project), the persona
 * tables live in the same DB as everything else. So this module just uses
 * the shared `getPool()` like every other domain — no special client.
 *
 * @module scripts/lib/store/persona
 */

import { many, one, insertReturning, upsert, updateWhere } from '../db/query.mjs';
import { isCloudEnabled } from './repo.mjs';

/**
 * True when cloud mode is on. Under the legacy path this checked a
 * persona-specific Supabase client; under the consolidated model the
 * persona tables are in the audit-loop DB so this just defers to
 * `isCloudEnabled()`.
 */
export async function isPersonaCloudEnabled() {
  return isCloudEnabled();
}

/**
 * List personas for an app URL via the `persona_dashboard` view (so
 * callers get running stats — test_count, last_verdict,
 * days_since_last_test — in one round-trip).
 */
export async function listPersonasForApp(appUrl) {
  if (!appUrl || !await isCloudEnabled()) return [];
  try {
    return await many(
      `SELECT * FROM persona_dashboard WHERE app_url = $1`,
      [appUrl]
    );
  } catch (err) {
    process.stderr.write(`  [persona] listPersonasForApp failed: ${err.message}\n`);
    return [];
  }
}

/**
 * Upsert a persona (idempotent on `(name, app_url)`). Returns the
 * persona id + an `existed` flag computed via a pre-select probe
 * (Postgres ON CONFLICT doesn't expose whether the row pre-existed).
 *
 * @returns {Promise<{personaId: string|null, existed: boolean}>}
 */
export async function upsertPersona(persona) {
  if (!persona?.name || !persona?.description || !persona?.appUrl) {
    return { personaId: null, existed: false };
  }
  if (!await isCloudEnabled()) return { personaId: null, existed: false };
  try {
    // Existed-detection probe — runs before upsert so the response can
    // distinguish insert from update.
    const existing = await one(
      `SELECT id FROM personas WHERE name = $1 AND app_url = $2 LIMIT 1`,
      [persona.name, persona.appUrl]
    );
    const existed = !!existing?.id;

    const rows = await upsert('personas', [{
      name: persona.name,
      description: persona.description,
      app_url: persona.appUrl,
      app_name: persona.appName || null,
      notes: persona.notes || null,
      repo_name: persona.repoName || null,
    }], { onConflict: ['name', 'app_url'], update: 'all', returning: ['id'] });

    return { personaId: rows[0]?.id || null, existed };
  } catch (err) {
    process.stderr.write(`  [persona] upsertPersona failed: ${err.message}\n`);
    return { personaId: null, existed: false };
  }
}

/**
 * Record a persona-test session + best-effort persona stats refresh.
 * Idempotent on session_id (re-posting returns the existing row).
 *
 * @returns {Promise<{sessionId: string|null, existed: boolean, statsUpdated: boolean}>}
 */
export async function recordPersonaSession(session) {
  if (!session?.sessionId || !await isCloudEnabled()) {
    return { sessionId: null, existed: false, statsUpdated: false };
  }
  let sessionId = null;
  try {
    const rows = await upsert('persona_test_sessions', [{
      session_id: session.sessionId,
      persona: session.persona,
      url: session.url,
      focus: session.focus || null,
      browser_tool: session.browserTool,
      steps_taken: session.stepsTaken || 0,
      verdict: session.verdict,
      p0_count: session.p0Count || 0,
      p1_count: session.p1Count || 0,
      p2_count: session.p2Count || 0,
      p3_count: session.p3Count || 0,
      avg_confidence: session.avgConfidence ?? null,
      findings: session.findings || [],
      report_md: session.reportMd || null,
      debrief_md: session.debriefMd || null,
      commit_sha: session.commitSha || null,
      deployment_id: session.deploymentId || null,
      repo_name: session.repoName || null,
      persona_id: session.personaId || null,
    }], { onConflict: 'session_id', update: 'all', returning: ['id'] });
    sessionId = rows[0]?.id || null;
  } catch (err) {
    process.stderr.write(`  [persona] recordPersonaSession failed: ${err.message}\n`);
    return { sessionId: null, existed: false, statsUpdated: false };
  }

  // Best-effort persona-stats refresh — separate failure mode from the
  // session-insert success, so a stats failure doesn't roll back the
  // session row (reconciler handles drift).
  let statsUpdated = false;
  if (session.personaId) {
    try {
      await updateWhere('personas',
        {
          last_tested_at: new Date().toISOString(),
          last_verdict: session.verdict,
          last_focus: session.focus || null,
        },
        { id: session.personaId }
      );
      statsUpdated = true;
    } catch (err) {
      process.stderr.write(`  [persona] WARN stats update failed — session recorded at ${sessionId}: ${err.message}\n`);
    }
  }

  return { sessionId, existed: false, statsUpdated };
}

/**
 * Fetch persona-test sessions filtered by repo name. Used by /plan
 * Phase 1, /ship Step 0.5a, and persona-test interop helpers (replaces
 * the curl-based anon reads after the 20260507 RLS hardening).
 */
export async function getPersonaSessionsByRepo({ repoName, limit = 5, p0Only = false, select = null }) {
  if (!repoName || !await isCloudEnabled()) return [];
  const cols = (Array.isArray(select) && select.length > 0)
    ? select.map((c) => `"${c}"`).join(', ')
    : '*';
  const n = Math.max(1, Math.min(limit, 100));
  try {
    if (p0Only) {
      return await many(
        `SELECT ${cols} FROM persona_test_sessions
          WHERE repo_name = $1 AND p0_count > 0
          ORDER BY created_at DESC
          LIMIT $2`,
        [repoName, n]
      );
    }
    return await many(
      `SELECT ${cols} FROM persona_test_sessions
        WHERE repo_name = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [repoName, n]
    );
  } catch (err) {
    process.stderr.write(`  [persona] getPersonaSessionsByRepo failed: ${err.message}\n`);
    return [];
  }
}

/**
 * Fetch persona-test sessions filtered by app URL. Used by persona-test
 * session-history reference (regression tracking).
 */
export async function getPersonaSessionsByUrl({ url, limit = 3, select = null }) {
  if (!url || !await isCloudEnabled()) return [];
  const cols = (Array.isArray(select) && select.length > 0)
    ? select.map((c) => `"${c}"`).join(', ')
    : '*';
  const n = Math.max(1, Math.min(limit, 100));
  try {
    return await many(
      `SELECT ${cols} FROM persona_test_sessions
        WHERE url = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [url, n]
    );
  } catch (err) {
    process.stderr.write(`  [persona] getPersonaSessionsByUrl failed: ${err.message}\n`);
    return [];
  }
}
