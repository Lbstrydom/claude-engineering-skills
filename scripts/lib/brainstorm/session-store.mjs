/**
 * @fileoverview Session ledger — append-only JSONL with per-file locking.
 * Plan: docs/plans/brainstorm-quickfix-v1.md §10.D, §11.E, §12.B, §13.B.
 *
 * Storage: `.brainstorm/sessions/<sid>.jsonl` — one JSON envelope per line.
 * Locking: `<sid>.jsonl.lock` via withFileLock (atomic writeFileSync wx).
 *
 * Round numbering happens INSIDE the lock (§12.B) so concurrent writers
 * get distinct round numbers. V1 records (no round field) are normalised
 * deterministically by file-index (§13.B) so mixed-V1/V2 files work.
 *
 * @module scripts/lib/brainstorm/session-store
 */
import fs from 'node:fs';
import path from 'node:path';
import { withFileLock } from '../file-lock.mjs';
import { BrainstormEnvelopeV2Schema, BrainstormEnvelopeWriteSchema } from './schemas.mjs';
import { validateSid } from './id-validator.mjs';
import { ensureDir } from '../cli-io.mjs';
import { atomicWriteFileSync } from '../file-io.mjs';

const SESSION_DIR_DEFAULT = '.brainstorm/sessions';
const PRUNE_SENTINEL = '.last-prune';
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;        // 24h
const PRUNE_DEFAULT_DAYS = 30;
const QUARANTINE_CAP = 100;                             // max quarantined lines per session

function sessionDir(rootOverride = null) {
  return rootOverride ?? SESSION_DIR_DEFAULT;
}

function sessionPath(sid, rootOverride = null) {
  return path.join(sessionDir(rootOverride), `${sid}.jsonl`);
}

function lockPath(sid, rootOverride = null) {
  return path.join(sessionDir(rootOverride), `${sid}.jsonl.lock`);
}

function quarantinePath(sid, rootOverride = null) {
  return path.join(sessionDir(rootOverride), `${sid}.quarantine.jsonl`);
}


/**
 * Read raw lines for round-number computation under the lock. Applies
 * §13.B file-index fallback for V1 records (no `round` field). Audit
 * R1-H9: a non-numeric `round` field would poison Math.max — coerce
 * to file-index whenever the parsed value isn't a finite integer.
 *
 * @returns {Array<{round: number, _raw: object|null, _invalid?: boolean}>}
 */
function readLinesUnvalidated(sid, rootOverride = null) {
  const file = sessionPath(sid, rootOverride);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
  return lines.map((line, idx) => {
    try {
      const parsed = JSON.parse(line);
      const r = parsed.round;
      const safeRound = (Number.isInteger(r) && r >= 0) ? r : idx;
      return { round: safeRound, _raw: parsed };
    } catch {
      return { round: idx, _raw: null, _invalid: true };
    }
  });
}

/**
 * Append a new envelope to the session, assigning the next round
 * number under the lock. Caller passes envelope WITHOUT round field;
 * this function fills it in.
 *
 * @param {{sid: string, envelope: object, root?: string}} args
 * @returns {Promise<{round: number, path: string}>}
 */
export async function appendSession({ sid, envelope, root = null }) {
  validateSid(sid, 'appendSession.sid');
  if (!envelope || typeof envelope !== 'object') throw new Error('appendSession: envelope required');

  ensureDir(sessionDir(root));
  const lock = lockPath(sid, root);

  return await withFileLock(lock, {}, () => {
    // Audit R3-M5: filter out invalid lines from round-numbering so a
    // corrupt persisted line cannot poison the next-round computation.
    // Quarantined lines stay on disk for forensics but are excluded
    // from the sequence the writer sees.
    const existing = readLinesUnvalidated(sid, root).filter(e => !e._invalid);
    const nextRound = existing.length === 0
      ? 0
      : Math.max(...existing.map(e => e.round)) + 1;

    const finalEnvelope = {
      ...envelope,
      sid,
      round: nextRound,
      schemaVersion: 2,
      capturedAt: envelope.capturedAt || new Date().toISOString(),
    };

    const parsed = BrainstormEnvelopeWriteSchema.safeParse(finalEnvelope);
    if (!parsed.success) {
      const err = new Error(`appendSession: envelope failed schema validation`);
      err.code = 'SCHEMA_INVALID';
      err.issues = parsed.error.issues;
      throw err;
    }

    const file = sessionPath(sid, root);
    fs.appendFileSync(file, JSON.stringify(parsed.data) + '\n');
    return { round: nextRound, path: file };
  });
}

/**
 * Load a session — returns rounds in chronological order (= file order).
 * V1 lines (no schemaVersion) are normalised to V2 shape with synthesised
 * sid/round/capturedAt and `_synthesised` populated. One stderr WARN per
 * session reports the synthesis count.
 *
 * Invalid lines are SKIPPED (not deleted) and appended to the quarantine
 * file (capped at QUARANTINE_CAP lines per session).
 *
 * @param {string} sid
 * @param {{root?: string}} [opts]
 * @returns {{sid: string, rounds: Array<object>, synthesisedCount: number, invalidCount: number}|null}
 */
/**
 * Read-side canonicalisation for arch-context fields — the SINGLE owner
 * of legacy-row normalization (plan: docs/plans/brainstorm-arch-context.md).
 * Legacy V2 rows written before the arch-context feature lack these
 * fields; `BrainstormEnvelopeV2Schema` permits that via `.optional()`,
 * and this coerces missing values to their zero form so downstream
 * consumers never branch on `undefined`. No Zod `.default()` is used —
 * this function is the one place legacy rows are canonicalised.
 *
 * @param {object} envelope - a schema-valid round envelope
 * @returns {object} same envelope with arch fields guaranteed present
 */
function normalizeArchFields(envelope) {
  return {
    ...envelope,
    archContextAttached: envelope.archContextAttached ?? false,
    archContextChars: envelope.archContextChars ?? 0,
    archContextWarning: envelope.archContextWarning ?? null,
  };
}

export function loadSession(sid, { root = null } = {}) {
  validateSid(sid, 'loadSession.sid');
  const file = sessionPath(sid, root);
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
  const rounds = [];
  let synthesisedCount = 0;
  let invalidCount = 0;
  const invalidLines = [];

  for (const [idx, line] of lines.entries()) {
    let parsed;
    try { parsed = JSON.parse(line); }
    catch {
      invalidCount++;
      invalidLines.push({ lineIdx: idx, raw: line, reason: 'json-parse-error' });
      continue;
    }
    // Audit Gemini-G-M2: JSON.parse('null') returns null; JSON.parse('"x"')
    // returns a string. Both would crash on `.schemaVersion`. Guard the
    // type before any property access.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      invalidCount++;
      invalidLines.push({ lineIdx: idx, raw: line, reason: 'non-object-json' });
      continue;
    }
    if (parsed.schemaVersion === 2) {
      // Audit R1-H13/M5: validate V2 records against the schema before
      // they enter application state. A line that JSON-parses but is
      // structurally wrong (missing providers array, wrong types) gets
      // quarantined like a parse failure.
      const v = BrainstormEnvelopeV2Schema.safeParse(parsed);
      if (!v.success) {
        invalidCount++;
        invalidLines.push({ lineIdx: idx, raw: line, reason: 'v2-schema-invalid', issues: v.error.issues.slice(0, 3) });
        continue;
      }
      rounds.push(normalizeArchFields(v.data));
    } else if (typeof parsed.schemaVersion === 'number' && parsed.schemaVersion > 2) {
      // Audit R2-M8: future-version records should NOT be silently
      // downcast through the V1 synthesis path. Quarantine and warn so
      // operators see a forward-incompatibility explicitly.
      invalidCount++;
      invalidLines.push({ lineIdx: idx, raw: line, reason: `unsupported-future-schema-version-${parsed.schemaVersion}` });
      continue;
    } else {
      // V1 — synthesise V2 fields
      const synthesised = {
        ...parsed,
        sid,
        round: idx,
        schemaVersion: 2,
        capturedAt: parsed.capturedAt || new Date(0).toISOString(),
        _synthesised: { fields: ['sid', 'round', 'schemaVersion', 'capturedAt'] },
      };
      // Validate the SYNTHESISED envelope too so a V1 line missing
      // required base fields (providers etc.) gets quarantined as well.
      const vsynth = BrainstormEnvelopeV2Schema.safeParse(synthesised);
      if (!vsynth.success) {
        invalidCount++;
        invalidLines.push({ lineIdx: idx, raw: line, reason: 'v1-promotion-invalid', issues: vsynth.error.issues.slice(0, 3) });
        continue;
      }
      rounds.push(normalizeArchFields(vsynth.data));
      synthesisedCount++;
    }
  }

  if (synthesisedCount > 0) {
    process.stderr.write(`  [session-store] WARN: session ${sid} uses pre-v2 schema; auto-synthesising sid/round/capturedAt for ${synthesisedCount} line(s)\n`);
  }
  if (invalidCount > 0) {
    process.stderr.write(`  [session-store] WARN: session ${sid} ${invalidCount} invalid line(s) quarantined\n`);
    appendQuarantine(sid, invalidLines, root);
  }

  return { sid, rounds, synthesisedCount, invalidCount };
}

function appendQuarantine(sid, invalidLines, root = null) {
  const qPath = quarantinePath(sid, root);
  try {
    ensureDir(sessionDir(root));
  } catch (err) {
    // atomic-write-adoption plan: ensureDir sat unprotected right above the
    // write it exists to serve — a failure here (e.g. a transient Windows
    // lock) escaped uncaught, breaking this function's own best-effort,
    // never-crash-the-caller contract. Folded into the same swallow-and-warn
    // pattern as the read/write failures below.
    process.stderr.write(`  [session-store] WARN: cannot prepare quarantine dir for ${qPath}: ${err.code || err.message}\n`);
    return;
  }
  // Audit R2-M5: best-effort write. Quarantine is diagnostic — missing
  // writes don't corrupt active state. Use a brief synchronous swap via
  // tmp+rename to avoid torn writes; concurrent loadSession invocations
  // will each see the union eventually since this is append-then-trim.
  let existing = [];
  if (fs.existsSync(qPath)) {
    try { existing = fs.readFileSync(qPath, 'utf-8').split('\n').filter(Boolean); }
    catch (err) {
      process.stderr.write(`  [session-store] WARN: cannot read quarantine ${qPath}: ${err.code || err.message}\n`);
      return;
    }
  }
  const combined = [...existing, ...invalidLines.map(l => JSON.stringify({ ...l, quarantinedAt: new Date().toISOString() }))];
  const trimmed = combined.slice(-QUARANTINE_CAP);
  // Atomic-rename for crash-safety; if two loaders write concurrently the
  // last writer wins on the ENTIRE file but neither leaves a torn artefact.
  try {
    atomicWriteFileSync(qPath, trimmed.join('\n') + '\n');
  } catch (err) {
    process.stderr.write(`  [session-store] WARN: quarantine write failed: ${err.code || err.message}\n`);
  }
}

/**
 * Summarise older rounds via deterministic head/tail truncation
 * (per plan §10.B — LLM summary deferred to v1.1).
 *
 * @param {object} round - V2 envelope
 * @returns {string} - one-line summary
 */
export function summariseRound(round) {
  const providerSummaries = (round.providers || []).map(p => {
    const text = p.text || '';
    const head = text.slice(0, 200);
    const tail = text.length > 400 ? text.slice(-200) : '';
    return `${p.provider}[${p.state}]: ${head}${tail ? ' … ' + tail : ''}`;
  });
  return `[round ${round.round} ${round.capturedAt}] topic="${(round.topic || '').slice(0, 100)}"\n${providerSummaries.join('\n')}`;
}

/**
 * Delete session files older than `maxAgeDays`. Returns count of files
 * deleted. Operates per-file with short-timeout locks (don't compete
 * with active writers). Lock-timeout per file is logged + skipped, not
 * thrown — pruning is best-effort housekeeping (plan §16.D).
 *
 * Lazy execution: re-checks last-prune sentinel mtime; runs only if
 * >24h since last prune.
 *
 * @param {number} maxAgeDays
 * @param {{root?: string}} [opts]
 * @returns {Promise<number>} count of files deleted
 */
export async function pruneOldSessions(maxAgeDays = PRUNE_DEFAULT_DAYS, { root = null } = {}) {
  const dir = sessionDir(root);
  if (!fs.existsSync(dir)) return 0;
  const sentinel = path.join(dir, PRUNE_SENTINEL);
  if (fs.existsSync(sentinel)) {
    try {
      const st = fs.statSync(sentinel);
      if (Date.now() - st.mtimeMs < PRUNE_INTERVAL_MS) return 0;
    } catch { /* recompute */ }
  }

  const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && !f.endsWith('.quarantine.jsonl'));
  let deleted = 0;
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs >= cutoff) continue;
      const sid = f.replace(/\.jsonl$/, '');
      const lock = lockPath(sid, root);
      try {
        await withFileLock(lock, { maxWaitMs: 500 }, () => {
          fs.unlinkSync(full);
          deleted++;
        });
      } catch (err) {
        if (err.code === 'LOCK_TIMEOUT') {
          process.stderr.write(`  [session-store] prune skipped ${f} — held by ${err.heldBy}\n`);
          continue;
        }
        throw err;
      }
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
  }
  // Touch sentinel
  try { fs.writeFileSync(sentinel, new Date().toISOString()); }
  catch (err) { /* sentinel update is best-effort */ void err; }
  return deleted;
}

// Internal — exported for tests
export const __test__ = { readLinesUnvalidated, sessionPath, lockPath, quarantinePath, appendQuarantine };
