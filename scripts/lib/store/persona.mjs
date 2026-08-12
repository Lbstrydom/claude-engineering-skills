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
import { ClickPathStepSchema } from '../schemas.mjs';
import { redactSecrets } from '../secret-patterns.mjs';

/** Max stored click-path steps (R2-M1) — truncate, never reject the session. */
const CLICK_PATH_CAP = 40;

/**
 * Does a URL/path segment or query value look like a secret/token/PII that must
 * never be stored (R1-H3/H4, R2-H1)? uuid · long hex/base64 · JWT · email · long
 * digit run. Conservative: when in doubt, collapse to `:param`.
 * @param {string} s
 * @returns {boolean}
 */
/** Percent-decode once, tolerating a malformed `%` sequence (returns raw). The
 *  single decode helper so EVERY secret/route heuristic sees the same decoded
 *  form — an encoded token or auth keyword can't bypass one check by matching a
 *  different one's encoding assumption (audit HIGH — encoded-auth-keyword bypass). */
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function looksSecret(s) {
  if (typeof s !== 'string' || s.length === 0) return false;
  // Percent-decode first so encoded secrets (`jane%40example.com`, `%2F`) can't
  // bypass the shape checks (audit HIGH — safe-decode).
  s = safeDecode(s);
  if (s.includes('@')) return true;                                  // email
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true; // uuid
  if (/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./.test(s)) return true; // JWT-ish
  if (/^[0-9a-f]{16,}$/i.test(s)) return true;                       // long hex
  if (/^[A-Za-z0-9+/_-]{24,}={0,2}$/.test(s) && /[0-9]/.test(s) && /[A-Za-z]/.test(s)) return true; // base64-ish token
  if (/^\d{12,}$/.test(s)) return true;                              // long digit run (ids/cards)
  return false;
}

/**
 * Sanitize a step URL for storage (R1-H3/H4, R2-H1): strip origin (host can be a
 * private staging URL), collapse token-shaped path segments + hash-route segments
 * to `:param`, redact token-shaped query VALUES while keeping routing keys/values
 * (so nav-audit can still recover `?view=cellar`), then a final secret-redactor
 * backstop. Pure. Returns a relative path+query+hash, or '' on unparseable input.
 * @param {string} rawUrl
 * @returns {string}
 */
// Substring (not exact) so compound auth slugs collapse too: `/reset-password/<tok>`,
// `/magic-link/<tok>`, `/password-reset/<tok>` → the following segment is a secret
// whatever its shape (audit HIGH). Over-collapsing a legit `/password-settings/x`
// segment to `:param` is the safe direction — nav-audit drops unnormalizable seeds.
const AUTH_KEYWORD = /(reset|verify|confirm|activate|invite|magic|password|recover|otp|token|oauth|callback|unsubscribe)/i;
// Query/fragment values are REDACTED BY DEFAULT (a short `?code=123456` / `?otp=` /
// `?phone=` is still a secret — value-shape heuristics miss them). Only an allowlist
// of routing keys with a short, non-secret value is preserved, so nav-audit can
// still recover `?view=cellar` but tokens never reach the cloud ledger.
const ROUTING_KEYS = new Set(['view', 'tab', 'page', 'panel', 'mode', 'section', 'route', 'screen', 'step', 'filter', 'sort', 'category', 'cat']);

/** Redact a `k=v&…` param string: secret-shaped KEYS → `:param`; values kept only
 *  for short non-secret routing keys, else `:param`. Used for both query + OAuth
 *  hash fragments (`#access_token=…`). */
function redactParams(paramStr) {
  const out = new URLSearchParams();
  for (const [k, v] of new URLSearchParams(paramStr)) {
    const safeKey = looksSecret(k) ? ':param' : k;
    const keepValue = ROUTING_KEYS.has(k.toLowerCase()) && v.length <= 32 && !looksSecret(v);
    out.append(safeKey, keepValue ? v : ':param');
  }
  return out.toString();
}

/** Collapse path segments: a segment that LOOKS secret OR follows an auth-route
 *  keyword (`/reset/<token>` → `/reset/:param`) becomes `:param`. */
function collapsePath(segments) {
  // Decode the preceding segment before the auth-keyword test — matches
  // looksSecret's decode, so `/%72eset/123456` (encoded "reset") collapses its
  // token just like `/reset/123456` does (audit HIGH — encoded-auth-keyword
  // bypass: `new URL().pathname` does NOT decode, so a raw-form test missed it).
  return segments.map((seg, i) => (
    looksSecret(seg) || (i > 0 && AUTH_KEYWORD.test(safeDecode(segments[i - 1])) && seg.length > 0) ? ':param' : seg
  )).join('/');
}

export function sanitizeStepUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return '';
  // Non-navigable schemes aren't reached destinations (mirrors normalizeLiveTarget) —
  // and a `javascript:`/`data:` URL is junk/risk in the ledger. Drop them.
  if (/^(mailto:|tel:|javascript:|data:|blob:|file:)/i.test(rawUrl.trim())) return '';
  let u;
  try { u = new URL(rawUrl, 'http://x'); } catch { return ''; }
  // Authoritative scheme guard: `new URL` normalizes away embedded tab/newline
  // obfuscation (`java\nscript:` → `javascript:`) the raw regex above can't see,
  // so re-check the PARSED protocol (audit LOW). Relative URLs inherit http:.
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  const path = collapsePath(u.pathname.split('/'));
  const q = redactParams(u.search);
  // Hash disambiguation (audit HIGH): a fragment STARTING with `/` is a SPA
  // hash-route path (`#/users/:id`, possibly with its own `?query`) — collapse the
  // path + sanitize the query separately. A fragment with NO leading slash but
  // carrying `=` is an OAuth/implicit-flow token bag (`#access_token=…&id_token=…`)
  // → redact wholesale. Otherwise treat it as a bare route path.
  let hash = '';
  if (u.hash) {
    const frag = u.hash.slice(1);
    if (frag.startsWith('/')) {
      const qIdx = frag.indexOf('?');
      const fp = qIdx >= 0 ? frag.slice(0, qIdx) : frag;
      const fq = qIdx >= 0 ? redactParams(frag.slice(qIdx + 1)) : '';
      hash = `#${collapsePath(fp.split('/'))}${fq ? `?${fq}` : ''}`;
    } else if (frag.includes('=')) {
      hash = `#${redactParams(frag)}`;
    } else {
      hash = `#${collapsePath(frag.split('/'))}`;
    }
  }
  // Uniform redaction sentinel: URLSearchParams percent-encodes the `:` in a
  // redacted query/hash value (`%3Aparam`), while path segments stay `:param`.
  // Normalize so BOTH read `:param` (field-test #6 — nav-audit's normalizer then
  // sees one sentinel). Only our own sentinel is rewritten; a kept routing value's
  // literal `:` encodes as `%3A<other>` and is untouched.
  return redactSecrets(`${path}${q ? `?${q}` : ''}${hash}`).text.replace(/%3Aparam/gi, ':param');
}

/**
 * Build the stored click_path from a raw posted array (R1-H3/H4, R2-M1/M5, R3-H1):
 * per-entry validate against the STRICT ClickPathStepSchema (an injected
 * `value`/`input` key → drop), sanitize the url, redact targetText, cap to 40.
 * @param {unknown} raw
 * @returns {{steps: Array<{step?:number, action:string, url:string, targetText:string|null}>, dropped:number, truncated:boolean}}
 */
export function buildSanitizedClickPath(raw) {
  if (!Array.isArray(raw)) return { steps: [], dropped: 0, truncated: false };
  const steps = [];
  let dropped = 0;
  let truncated = false;
  for (const entry of raw) {
    if (steps.length >= CLICK_PATH_CAP) { truncated = true; break; } // truncate, don't reject (R2-M1)
    const parsed = ClickPathStepSchema.safeParse(entry);
    if (!parsed.success) { dropped += 1; continue; }     // drop-invalid (incl. .strict `value` key)
    const s = parsed.data;
    steps.push({
      ...(s.step !== undefined ? { step: s.step } : {}),
      action: s.action,
      url: sanitizeStepUrl(s.url),
      targetText: s.targetText != null ? redactSecrets(String(s.targetText)).text : null,
    });
  }
  // Surface drops/truncation (audit MED — never lose evidence silently): both via
  // stderr AND the structured counts the caller returns through the CLI result.
  if (dropped || truncated) {
    process.stderr.write(`  [persona] clickPath: stored ${steps.length}, dropped ${dropped} invalid/injected${truncated ? `, truncated at ${CLICK_PATH_CAP}` : ''}\n`);
  }
  return { steps, dropped, truncated };
}

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

    // @on-conflict-ok: a persona is scoped to the APP, not the repo — the table declares `unique (name, app_url)` ("Unique per app"), carries personas_app_url_idx, and listPersonasForApp reads by app_url alone. Adding repo_name would fragment one app's persona into per-repo copies and break that reader; repo_name is an annotation for cross-referencing audit findings, not identity. Evidence-backed omission per the WS-C2 escape hatch, not a deferral.
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
  // Discriminated since plan §2b F2 (2026-08-12). `{sessionId: null}` was
  // returned for a missing sessionId, for cloud-off, AND for a caught write
  // failure, and the CLI wrote `ok: !!result.sessionId` — so a store outage read
  // as "no session was recorded", which is also what a legitimate local-only run
  // looks like. `ok`/`cloud`/`reason` are ADDITIVE: every existing field is
  // still present and unchanged, so a caller reading `.sessionId` is unaffected.
  if (!session?.sessionId) {
    return { ok: false, cloud: true, reason: 'invalid-input', message: 'recordPersonaSession requires session.sessionId', sessionId: null, existed: false, statsUpdated: false };
  }
  if (!await isCloudEnabled()) {
    return { ok: false, cloud: false, reason: 'cloud-off', message: 'cloud store is disabled', sessionId: null, existed: false, statsUpdated: false };
  }
  let sessionId = null;
  let clickPathMeta = null;
  try {
    const row = {
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
      findings: session.findings || [],   // jsonb — serialized by the db-layer seam (serializeWriteParam)
      report_md: session.reportMd || null,
      debrief_md: session.debriefMd || null,
      commit_sha: session.commitSha || null,
      deployment_id: session.deploymentId || null,
      repo_name: session.repoName || null,
      // Canonical unified identity (audit_repos.id), resolved by the caller from
      // the repo root — lets sessions join natively to audit_runs/findings
      // regardless of the bare-vs-owner/repo display name. Falls back to null.
      repo_id: session.repoId || null,
      persona_id: session.personaId || null,
    };
    // Preserve-on-omit (R3-M1): include click_path in the upsert SET only when the
    // caller provided it (`update:'all'` updates just the row's keys). An omitted
    // clickPath on a re-posted session_id leaves existing evidence untouched —
    // never writes `[]` over a real path. Sanitized/redacted/capped server-side.
    if (session.clickPath !== undefined) {
      clickPathMeta = buildSanitizedClickPath(session.clickPath);
      row.click_path = clickPathMeta.steps;   // jsonb — serialized by the db-layer seam
    }
    // @on-conflict-ok: a session is a globally-unique EVENT whose identity is its own id; repo_id/repo_name are annotations on it. session_id is now collision-resistant by construction (buildPersonaSessionId — unix seconds + a full crypto.randomUUID suffix), which is the root-cause fix for the weak `persona-test-<unix>` shape. Widening to (repo_id, session_id) was measured and REJECTED as a band-aid: repo_id is legitimately NULL when persona-test runs against a deployed URL from outside a resolvable repo, so it needs a sentinel bucket in which two same-second sessions still collide (WS-C2).
    const rows = await upsert('persona_test_sessions', [row],
      { onConflict: 'session_id', update: 'all', returning: ['id'] });
    sessionId = rows[0]?.id || null;
    if (!sessionId) {
      const message = 'upsert returned no row — the write did not verify';
      process.stderr.write(`  [persona] recordPersonaSession: ${message}\n`);
      return { ok: false, cloud: true, reason: 'write-failed', message, sessionId: null, existed: false, statsUpdated: false };
    }
  } catch (err) {
    process.stderr.write(`  [persona] recordPersonaSession failed: ${err.message}\n`);
    return { ok: false, cloud: true, reason: 'write-failed', message: err.message, error: err, sessionId: null, existed: false, statsUpdated: false };
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

  return {
    ok: true,
    cloud: true,
    sessionId,
    existed: false,
    statsUpdated,
    // Structured click-path outcome so callers see partial sanitization, not just
    // a stderr line (audit MED). Absent when no clickPath was provided.
    ...(clickPathMeta ? { clickPathStored: clickPathMeta.steps.length, clickPathDropped: clickPathMeta.dropped, clickPathTruncated: clickPathMeta.truncated } : {}),
  };
}

/**
 * Fetch persona-test sessions filtered by repo name. Used by /plan
 * Phase 1, /ship Step 0.5a, and persona-test interop helpers (replaces
 * the curl-based anon reads after the 20260507 RLS hardening).
 */
export async function getPersonaSessionsByRepo({
  repoName, repoId = null, limit = 5, p0Only = false, select = null,
}) {
  if (!repoName || !await isCloudEnabled()) return [];
  const cols = (Array.isArray(select) && select.length > 0)
    ? select.map((c) => `"${c}"`).join(', ')
    : '*';
  const n = Math.max(1, Math.min(limit, 100));
  // Canonical-identity predicate, added for the "reader scopes only by
  // caller-provided repoName" finding. `repo_name` is `audit_repos.name` and is
  // unique, so name-scoping was never a cross-repo LEAK — what it could not
  // catch is a row whose two identity fields DISAGREE. That row was producible
  // until 2026-08-11: `cmdRecordPersonaSession` filled only the missing field,
  // so a caller supplying repo A's name from a checkout of repo B wrote A's name
  // beside B's id, and this reader served it as A's. The writer is fixed
  // (reconcileRepoIdentity); this makes the READ reject such a row instead of
  // trusting it — the two halves of the same defect.
  //
  // `OR repo_id IS NULL` is load-bearing, not laxity: the column is nullable BY
  // DESIGN — the writer records by name when ambient identity is unresolvable,
  // and dropping those rows would be a silent read regression for exactly the
  // degraded case they exist to cover. Measured 2026-08-11: 0 of 7 rows here
  // are null, but a consumer's store is not this store. Requiring the id would
  // be the "check verifying one direction only" trap.
  const scoped = Boolean(repoId);
  try {
    if (p0Only) {
      if (scoped) {
        return await many(
          `SELECT ${cols} FROM persona_test_sessions
            WHERE repo_name = $1 AND p0_count > 0 AND (repo_id = $3 OR repo_id IS NULL)
            ORDER BY created_at DESC
            LIMIT $2`,
          [repoName, n, repoId]
        );
      }
      return await many(
        `SELECT ${cols} FROM persona_test_sessions
          WHERE repo_name = $1 AND p0_count > 0
          ORDER BY created_at DESC
          LIMIT $2`,
        [repoName, n]
      );
    }
    if (scoped) {
      return await many(
        `SELECT ${cols} FROM persona_test_sessions
          WHERE repo_name = $1 AND (repo_id = $3 OR repo_id IS NULL)
          ORDER BY created_at DESC
          LIMIT $2`,
        [repoName, n, repoId]
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
 * Per-persona reachability evidence for /nav-audit --bootstrap seeding. Bounded by
 * a time window (sinceDays) AND a per-persona cap (so a chatty persona can't starve
 * others — R3-M4/Gemini2-M1) via `row_number() PARTITION BY persona`, plus an
 * overall ceiling. Unnests each session's click_path to per-persona reached URLs
 * (deduped by url; sessions count; most-recent non-null clickedText + lastSeen).
 * nav-audit normalizes url→destination — the reader stays nav-agnostic. Graceful
 * `{personas:[]}` on cloud-off / DB error (R2-H2 — never throws into --bootstrap).
 * @param {{repoName:string, perPersona?:number, sinceDays?:number}} args
 * @returns {Promise<{personas: Array<{persona:string, reached:Array<{url:string,clickedText:string|null,sessions:number,lastSeen:string|null}>}>}>}
 */
export async function getReachabilityEvidence({ repoName, perPersona = 10, sinceDays = 90 } = {}) {
  if (!repoName || !await isCloudEnabled()) return { personas: [] };
  const cap = Math.max(1, Math.min(perPersona, 50));
  const days = Math.max(1, Math.min(sinceDays, 365));
  let rows;
  try {
    rows = await many(
      `WITH ranked AS (
         SELECT persona, click_path, created_at,
                row_number() OVER (PARTITION BY persona ORDER BY created_at DESC) AS rn
           FROM persona_test_sessions
          WHERE repo_name = $1
            AND jsonb_array_length(click_path) > 0
            AND created_at >= now() - ($2 * interval '1 day')
       )
       SELECT persona, click_path, created_at
         FROM ranked
        WHERE rn <= $3
        ORDER BY persona, created_at DESC
        LIMIT 500`,
      [repoName, days, cap]
    );
  } catch (err) {
    process.stderr.write(`  [persona] getReachabilityEvidence failed: ${err.message}\n`);
    return { personas: [] };
  }

  return { personas: unnestReachabilityRows(rows) };
}

/**
 * Pure unnest of reachability rows → per-persona reached destinations. Rows MUST be
 * pre-sorted created_at DESC so the FIRST session reaching a url is the most recent
 * (its clickedText/lastSeen win). Deduped by url within a persona; `sessions` counts
 * distinct sessions reaching that url. Exported for fixture testing (no DB).
 * @param {Array<{persona:string, click_path:Array, created_at:string}>} rows
 * @returns {Array<{persona:string, reached:Array<{url:string,clickedText:string|null,sessions:number,lastSeen:string|null}>}>}
 */
export function unnestReachabilityRows(rows) {
  const byPersona = new Map();
  for (const r of rows || []) {
    const path = Array.isArray(r.click_path) ? r.click_path : [];
    const urlsInSession = new Map(); // url → most-recent-in-this-session clickedText
    for (const step of path) {
      const url = step && typeof step.url === 'string' ? step.url : null;
      if (!url) continue;
      const ct = step.targetText ?? null;
      if (!urlsInSession.has(url) || ct != null) urlsInSession.set(url, ct ?? urlsInSession.get(url) ?? null);
    }
    const pm = byPersona.get(r.persona) || new Map();
    byPersona.set(r.persona, pm);
    for (const [url, ct] of urlsInSession) {
      const e = pm.get(url) || { url, clickedText: null, sessions: 0, lastSeen: null };
      e.sessions += 1;
      if (e.lastSeen == null) { e.lastSeen = r.created_at; if (ct != null) e.clickedText = ct; }
      else if (e.clickedText == null && ct != null) e.clickedText = ct;
      pm.set(url, e);
    }
  }
  return [...byPersona.entries()].map(([persona, pm]) => ({ persona, reached: [...pm.values()] }));
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
