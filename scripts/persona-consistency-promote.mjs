#!/usr/bin/env node
/**
 * @fileoverview Phase 6 candidate-promotion CLI for /ship integration.
 *
 * Plan: docs/plans/persona-test-consistency-mode.md.
 *
 * Promotes `regression_specs` rows from `persona-consistency-candidate`
 * to `persona-consistency-locked`. The transition materialises the
 * Playwright spec file from the candidate's stored witness + contradiction
 * + journey context (no LLM, deterministic via `renderCandidateSpec`).
 *
 * Crash-tolerant two-phase pipeline (resolves R4-M2):
 *   1. Write a journal entry (.persona-test/promotion-journal/<specId>.json)
 *      with stage='pending', intendedPath, body
 *   2. Write the spec body to `<intendedPath>.tmp`
 *   3. Atomic DB UPDATE candidate → locked
 *   4. On DB success → journal advances to stage='db-committed'
 *   5. Atomic-rename `.tmp` → final path; journal advances to 'finalised'
 *   6. Record one `ship_event` per promotion
 *   7. Delete journal entry
 *
 * Recovery at next run: `reconcilePromotionJournal()` finds any non-
 * finalised entry, queries the DB:
 *   - If the row is `persona-consistency-locked`: complete the rename
 *     (DB committed but file rename never landed)
 *   - Otherwise: unlink the `.tmp` file (DB never committed); leave the
 *     candidate row untouched so it can be re-promoted
 *
 * @module scripts/persona-consistency-promote
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

import { atomicWriteFileSync } from './lib/file-io.mjs';
import { retrySync } from './lib/retry-transient-fs.mjs';
import { renderCandidateSpec } from './lib/ux-lock/candidate-spec.mjs';
import {
  WitnessRecordSchema,
  ContradictionSchema,
} from './lib/persona-test/schemas.mjs';
import {
  initLearningStore,
  isCloudEnabled,
  getRepoIdByUuid,
} from './learning-store.mjs';
// Resolves Gemini-final-G3 + Gemini-final-wronglyDismissed-R4-M4 (round-1
// code-audit finding 470f7e66 — the two comment blocks these replace
// contradicted each other on which calls go through the facade). The
// actual, current contract: `promoteRegressionSpec`, `recordShipEvent`,
// and `list-consistency-candidates` ALL route through the cross-skill CLI
// facade (`callCrossSkill` below) as subprocess invocations — the plan's
// Phase 6 explicitly mandates this for all three persistence/read
// operations. `getRepoIdByUuid` stays a direct `learning-store.mjs`
// import — it's a read-only identity-resolution helper used by
// reconcile-time DB disambiguation, not a persistence write, and was
// never part of the facade mandate.
// Resolve cross-skill.mjs as a sibling of this script (source layout:
// `scripts/cross-skill.mjs`; consumer layout: `scripts/.claude-skills/cross-skill.mjs`).
// Hardcoding `scripts/...` would break after consumer-side relocation.
const CROSS_SKILL_PATH = fileURLToPath(new URL('./cross-skill.mjs', import.meta.url));

function callCrossSkill(repoRoot, command, payload) {
  try {
    // process.execPath (not a bare 'node'), matching the same PATH-drift
    // reasoning already applied to this plan's own migration test
    // (tests/quickfix-patterns.test.mjs) — a bare 'node' can resolve to a
    // different runtime than the parent process, or not resolve at all,
    // under a version manager, a stripped PATH (git hooks, CI containers,
    // launchd/systemd), or certain Windows shells (Gemini gate shadow
    // finding 58e35e26).
    const out = execFileSync(
      process.execPath,
      [CROSS_SKILL_PATH, command, '--json', JSON.stringify(payload)],
      { cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return JSON.parse(out.trim());
  } catch (err) {
    // Resolves Gemini-final-G3: when the cross-skill CLI exits non-zero,
    // execFileSync throws an Error with `.stdout` containing the structured
    // JSON error response (per scripts/cross-skill.mjs `emitError` shape:
    // `{ok:false, code:'...', message:'...'}`). The previous catch
    // collapsed every failure to `{ok:false, error:'Command failed...'}`
    // — callers couldn't distinguish BAD_INPUT from "node not found" or
    // an empty-result success-with-cloud-off. Parse stdout when present.
    const stdout = (err.stdout || '').toString().trim();
    if (stdout) {
      try {
        const parsed = JSON.parse(stdout);
        return { ok: false, error: parsed.message || parsed.code || 'cross-skill returned error', code: parsed.code };
      } catch { /* fall through to generic error */ }
    }
    return { ok: false, error: err.message };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Failure-contract refactor (docs/plans/refactor-failure-contract.md,
// Cluster B) — pure interpreters for each callCrossSkill() response, so the
// actual decision logic (a real dependency failure must never read as an
// empty/cloud-off/successful result) is directly assertable with plain
// objects, no DB/subprocess involved.
// ────────────────────────────────────────────────────────────────────────────

/**
 * A malformed top-level `callCrossSkill` result (`null`, an array, a
 * string, a number, or an object with a non-boolean `ok`) must never reach
 * an interpreter's own field access — that would throw a TypeError BEFORE
 * the interpreter's own failure-handling logic (including
 * `EXIT.DEPENDENCY_FAILURE`) ever runs. Checked first by every interpreter
 * below.
 * @param {unknown} parsed
 * @returns {boolean}
 */
function isWellFormedCliResponse(parsed) {
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.ok === 'boolean';
}

/**
 * Interpret `list-consistency-candidates`'s response. A real dependency
 * failure (`ok:false`) must never be conflated with a legitimate empty
 * result — that conflation was Defect 3 (a broken candidate-list check
 * looked identical, in every log and exit code, to a repo with genuinely
 * nothing to promote).
 * @param {unknown} parsed
 * @returns {{ok:true, candidates: Array} | {ok:false, message: string}}
 */
export function interpretCandidateListResult(parsed) {
  if (!isWellFormedCliResponse(parsed)) {
    return { ok: false, message: 'list-consistency-candidates returned an invalid response envelope (not a well-formed {ok:boolean,...} object)' };
  }
  if (parsed.ok === true) {
    if (!Array.isArray(parsed.candidates)) {
      return { ok: false, message: `list-consistency-candidates returned ok:true without a candidates array (got ${typeof parsed.candidates}) — protocol violation` };
    }
    return { ok: true, candidates: parsed.candidates };
  }
  return { ok: false, message: parsed.error || parsed.code || 'list-consistency-candidates failed' };
}

/**
 * Turn an interpreted candidate-list result into the caller's actual
 * decision: continue with the candidates, report a genuine empty queue, or
 * treat a dependency failure as UNKNOWN (never as zero).
 * @param {{ok:true, candidates: Array} | {ok:false, message: string}} listResult
 * @returns {{shouldContinue:false, exitCode:number, message:string} | {shouldContinue:true, candidates: Array}}
 */
export function evaluateCandidateListOutcome(listResult) {
  if (!listResult.ok) {
    return {
      shouldContinue: false,
      exitCode: EXIT.DEPENDENCY_FAILURE,
      message: `Could not check for consistency candidates: ${listResult.message} — treating this as unknown, not zero.`,
    };
  }
  if (listResult.candidates.length === 0) {
    return { shouldContinue: false, exitCode: EXIT.OK, message: 'No pending consistency candidates.' };
  }
  return { shouldContinue: true, candidates: listResult.candidates };
}

/**
 * Interpret `record-ship-event`'s response. Defect 4: the old guard
 * (`!parsed.ok && !parsed.cloud`) conflated "cloud deliberately off" with
 * "a real failure" — every failure response lacks a `cloud` field
 * entirely, so `!parsed.cloud` was true for BOTH cases, silently reporting
 * every real failure as `{ok:true}`.
 * @param {unknown} parsed
 * @returns {{ok:true, cloud:boolean} | {ok:false, message:string}}
 */
export function interpretShipEventResult(parsed) {
  if (!isWellFormedCliResponse(parsed)) {
    return { ok: false, message: 'record-ship-event returned an invalid response envelope (not a well-formed {ok:boolean,...} object)' };
  }
  if (parsed.ok === true) {
    if (typeof parsed.cloud !== 'boolean') {
      return { ok: false, message: `record-ship-event returned ok:true with a non-boolean cloud field (got ${typeof parsed.cloud}) — protocol violation` };
    }
    return { ok: true, cloud: parsed.cloud };
  }
  return { ok: false, message: parsed.error || parsed.code || 'record-ship-event failed' };
}

/**
 * Interpret `promote-regression-spec`'s response — the third, previously
 * unguarded `callCrossSkill` consumer (round-4 shadow finding da923982).
 * Behavior-preserving for the already-handled case (`promoteOne`'s
 * existing `!updateResult.ok || updateResult.rowsAffected === 0` check is
 * unchanged); this replaces an uncaught TypeError on a malformed envelope
 * with a typed failure result.
 *
 * Round-2 code-audit finding c014fb2a (genuine bug in this file's own
 * round-1 fix): the original `parsed.rowsAffected || 0` only checked the
 * top-level `ok` boolean, not `rowsAffected` itself — a malformed response
 * like `{ok:true, rowsAffected:'0'}` (a STRING, truthy in JS) would pass
 * through as the string `'0'`, and `promoteOne`'s strict `=== 0` guard
 * would then fail to catch it (`'0' === 0` is `false`), letting a
 * zero-row DB write silently proceed as a reported success. `rowsAffected`
 * on an `ok:true` response must now be a finite, non-negative safe
 * integer; anything else is a protocol violation.
 * @param {unknown} parsed
 * @returns {{ok:true, rowsAffected:number} | {ok:false, rowsAffected:0, error:string}}
 */
export function interpretPromoteRegressionSpecResult(parsed) {
  if (!isWellFormedCliResponse(parsed)) {
    return { ok: false, rowsAffected: 0, error: 'promote-regression-spec returned an invalid response envelope (not a well-formed {ok:boolean,...} object)' };
  }
  if (parsed.ok === true) {
    const rows = parsed.rowsAffected;
    if (!(typeof rows === 'number' && Number.isSafeInteger(rows) && rows >= 0)) {
      return { ok: false, rowsAffected: 0, error: `promote-regression-spec returned ok:true with a non-integer rowsAffected (got ${JSON.stringify(rows)}) — protocol violation` };
    }
    return { ok: true, rowsAffected: rows };
  }
  return { ok: false, rowsAffected: 0, error: parsed.error || parsed.code || 'promote-regression-spec failed' };
}

function listConsistencyCandidatesViaCli(repoRoot, repoId, sinceTs) {
  const parsed = callCrossSkill(repoRoot, 'list-consistency-candidates', {
    repoId, sinceTs, limit: 100,
  });
  const result = interpretCandidateListResult(parsed);
  if (!result.ok) {
    process.stderr.write(`  [promote] list-consistency-candidates failed: ${result.message}\n`);
  }
  return result;
}

async function promoteRegressionSpecViaCli(repoRoot, args) {
  const parsed = callCrossSkill(repoRoot, 'promote-regression-spec', args);
  return interpretPromoteRegressionSpecResult(parsed);
}

async function recordShipEventViaCli(repoRoot, args) {
  const parsed = callCrossSkill(repoRoot, 'record-ship-event', args);
  return interpretShipEventResult(parsed);
}

const JOURNAL_DIR = path.join('.persona-test', 'promotion-journal');
const E2E_DIR     = path.join('tests', 'e2e');

export const EXIT = Object.freeze({
  OK:                 0,
  NOTHING_PENDING:    0,    // empty queue is success, not failure
  CLOUD_OFF:          0,    // no candidates to promote when cloud is off
  USER_DECLINED:      0,    // user said n — also success
  BAD_INPUT:          1,
  PARTIAL_FAILURE:    2,    // some promotions succeeded, some failed
  DEPENDENCY_FAILURE: 3,    // the candidate-list call itself failed — unknown, not zero
});

// ────────────────────────────────────────────────────────────────────────────
// Arg parsing
// ────────────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const args = {
    auto: false,
    since: null,
    repoRoot: process.cwd(),
    out: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--auto')           args.auto = true;
    else if (a === '--since')     args.since = argv[++i];
    else if (a === '--repo-root') args.repoRoot = argv[++i];
    else if (a === '--out')       args.out = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function usage() {
  return [
    'persona-consistency-promote — batch-promote consistency candidates to locked specs',
    '',
    'Usage:',
    '  node scripts/persona-consistency-promote.mjs [--auto] [--since <iso-ts>]',
    '',
    'Flags:',
    '  --auto              Skip TTY prompts and promote every pending candidate',
    '  --since <iso>       Only candidates created at/after this ISO timestamp',
    '  --repo-root <dir>   Override repo root (defaults to cwd)',
    '  --out <path>        Emit a JSON result summary to <path>',
  ].join('\n');
}

// ────────────────────────────────────────────────────────────────────────────
// Public entry — exported for tests; main() at the bottom wires process.exit
// ────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} PromoteResult
 * @property {number} exitCode
 * @property {number} promoted
 * @property {number} declined
 * @property {number} failed
 * @property {Array<{specId: string, path?: string, error?: string}>} details
 */

/**
 * @param {ReturnType<typeof parseArgs>} args
 * @param {object} [deps]
 * @param {(question: string) => Promise<string>} [deps.prompt]
 * @returns {Promise<PromoteResult>}
 */
export async function promoteCandidates(args, deps = {}) {
  const result = { exitCode: EXIT.OK, promoted: 0, declined: 0, failed: 0, details: [] };
  if (args.help) {
    process.stdout.write(usage() + '\n');
    return result;
  }

  // 0. Reconcile any incomplete journals from prior crashed runs.
  await reconcilePromotionJournal(args.repoRoot);

  await initLearningStore();
  if (!await isCloudEnabled()) {
    process.stdout.write('Cloud off — no candidates to promote.\n');
    return result;
  }

  // Resolve repoId.
  let repoId = null;
  try {
    const uuid = readLocalRepoUuid(args.repoRoot);
    if (uuid) repoId = await getRepoIdByUuid(uuid);
  } catch { /* fall through */ }
  if (!repoId) {
    process.stderr.write(
      'No resolved repoId — consistency candidates need a known repo. ' +
      'Run `node scripts/cross-skill.mjs resolve-repo-identity --persist` first.\n',
    );
    result.exitCode = EXIT.BAD_INPUT;
    return result;
  }

  const listResult = listConsistencyCandidatesViaCli(args.repoRoot, repoId, args.since || null);
  const outcome = evaluateCandidateListOutcome(listResult);
  if (!outcome.shouldContinue) {
    (outcome.exitCode === EXIT.OK ? process.stdout : process.stderr).write(outcome.message + '\n');
    result.exitCode = outcome.exitCode;
    return result;
  }
  const candidates = outcome.candidates;

  // Render header.
  process.stdout.write(`\n${candidates.length} consistency candidate(s) pending:\n`);
  for (const c of candidates) {
    process.stdout.write(`  · ${c.description}  [fingerprint=${(c.candidate_fingerprint || '').slice(0, 10)}]\n`);
  }
  process.stdout.write('\n');

  const promotedBy = safeGitEmail(args.repoRoot) || 'unknown@local';

  for (const cand of candidates) {
    // Decide approval.
    let approve;
    if (args.auto) approve = true;
    else {
      const ask = deps.prompt || defaultPrompt;
      const ans = (await ask(`Promote ${cand.description}? [y/N]: `)).trim().toLowerCase();
      approve = ans === 'y' || ans === 'yes';
    }
    if (!approve) {
      result.declined += 1;
      continue;
    }

    try {
      const promoted = await promoteOne(args.repoRoot, repoId, cand, promotedBy);
      result.promoted += 1;
      result.details.push({ specId: cand.id, path: promoted.specPath });
      process.stdout.write(`  ✓ Promoted → ${promoted.specPath}\n`);
    } catch (err) {
      result.failed += 1;
      result.details.push({ specId: cand.id, error: err.message });
      process.stderr.write(`  ✗ Promote failed for ${cand.id}: ${err.message}\n`);
    }
  }

  if (args.out) {
    try { atomicWriteFileSync(args.out, JSON.stringify(result, null, 2)); } catch { /* swallow */ }
  }

  if (result.failed > 0) result.exitCode = EXIT.PARTIAL_FAILURE;
  process.stdout.write(
    `\nPromoted: ${result.promoted}   Declined: ${result.declined}   Failed: ${result.failed}\n`,
  );
  return result;
}

// ────────────────────────────────────────────────────────────────────────────
// Single-candidate two-phase promotion (with journal)
// ────────────────────────────────────────────────────────────────────────────

async function promoteOne(repoRoot, repoId, cand, promotedBy) {
  // Resolves R1-H4 — re-validate JSONB columns on the read boundary. The
  // candidate row was written by a prior runner; row-shape CHECK enforces
  // structure but not full schema. Parse before rendering so a corrupt or
  // shape-drifted record fails LOUDLY here (not via cryptic stack from
  // deep inside renderCandidateSpec).
  const witnessParsed = WitnessRecordSchema.safeParse(cand.witness_snapshot);
  if (!witnessParsed.success) {
    throw new Error(`witness_snapshot fails schema: ${witnessParsed.error.message}`);
  }
  const contradictionParsed = ContradictionSchema.safeParse(cand.contradiction_payload);
  if (!contradictionParsed.success) {
    throw new Error(`contradiction_payload fails schema: ${contradictionParsed.error.message}`);
  }
  const jc = cand.journey_context;
  if (!jc || !Array.isArray(jc.journeySteps) || jc.journeySteps.length === 0) {
    throw new Error('journey_context.journeySteps[] is empty or malformed');
  }

  // 1. Render the spec body (deterministic — same candidate → same body).
  // Resolves R4-H8: thread `contradictionStepIndex` through so the
  // renderer can validate the replay-boundary contract (R3-H4 fix). The
  // field is optional in journeyContext for backward compat with pre-R3
  // candidate rows that don't carry it; current runner always sets it.
  const { filename, body } = renderCandidateSpec(
    witnessParsed.data,
    contradictionParsed.data,
    {
      journeySteps:             jc.journeySteps,
      contradictionStepIndex:   jc.contradictionStepIndex,
      routes:                   jc.routes,
      authBootstrap:            jc.authBootstrap,
      candidateFingerprint:     cand.candidate_fingerprint,
    },
  );

  const e2eDir   = path.join(repoRoot, E2E_DIR);
  fs.mkdirSync(e2eDir, { recursive: true });
  const finalPath = path.join(e2eDir, filename);
  const tmpPath   = finalPath + '.tmp';

  // 2. Write journal entry FIRST — durable evidence of the intent.
  writeJournal(repoRoot, cand.id, {
    stage: 'pending',
    specId: cand.id,
    intendedPath: finalPath,
    tmpPath,
    body,
    candidateFingerprint: cand.candidate_fingerprint,
    repoId,
    timestamp: new Date().toISOString(),
  });

  try {
    // 3. Write spec to .tmp (atomic temp+rename pattern via file-io).
    atomicWriteFileSync(tmpPath, body);

    // 4. DB UPDATE candidate → locked. Routed through cross-skill CLI
    // (Gemini-final-G3: the plan's Phase 6 explicitly mandates the facade
    // here, NOT a direct learning-store call).
    const updateResult = await promoteRegressionSpecViaCli(repoRoot, {
      specId: cand.id,
      specPath: path.relative(repoRoot, finalPath).replace(/\\/g, '/'),
      promotedBy,
      candidateFingerprint: cand.candidate_fingerprint,
    });
    if (!updateResult.ok || updateResult.rowsAffected === 0) {
      // DB didn't transition — remove the .tmp and bail.
      try { retrySync(() => fs.unlinkSync(tmpPath)); } catch { /* swallow */ }
      removeJournal(repoRoot, cand.id);
      throw new Error('DB update returned zero rows (candidate may have been promoted by a concurrent run)');
    }

    // 5. Journal advances — DB committed.
    writeJournal(repoRoot, cand.id, {
      stage: 'db-committed',
      specId: cand.id,
      intendedPath: finalPath,
      tmpPath,
      body,
      candidateFingerprint: cand.candidate_fingerprint,
      repoId,
      timestamp: new Date().toISOString(),
    });

    // 6. Atomic rename — moves the file out of .tmp suffix into place.
    // Resolves R3-H6: refuse to overwrite an existing finalPath. A
    // collision here means either (a) a previous promotion attempt left
    // the file in place (reconcilePromotionJournal should have cleared
    // it; if not, we're racing with a concurrent run) or (b) a fingerprint
    // short-hash collision (R2-H7 bumped slice to 16 chars but defence in
    // depth). Refuse rather than silently overwrite — the candidate row
    // remains locked in DB; next reconcile run will catch the disagreement.
    if (fs.existsSync(finalPath)) {
      // Read both files; if they're byte-identical, the rename is idempotent
      // (re-running the same promotion is safe). Otherwise refuse loudly.
      let existing, incoming;
      try {
        existing = fs.readFileSync(finalPath, 'utf-8');
        incoming = fs.readFileSync(tmpPath,   'utf-8');
      } catch (err) {
        throw new Error(`promote rename refused — could not compare existing and incoming spec: ${err.message}`);
      }
      if (existing === incoming) {
        // Idempotent re-run — discard the .tmp; the locked file already matches.
        try { retrySync(() => fs.unlinkSync(tmpPath)); } catch { /* swallow */ }
      } else {
        throw new Error(
          `promote rename refused — ${finalPath} already exists with different content (possible concurrent promotion or fingerprint collision)`,
        );
      }
    } else {
      retrySync(() => fs.renameSync(tmpPath, finalPath));
    }

    // 7. Journal finalised; record ship_event; delete journal.
    writeJournal(repoRoot, cand.id, {
      stage: 'finalised',
      specId: cand.id,
      finalPath,
      candidateFingerprint: cand.candidate_fingerprint,
      repoId,
      timestamp: new Date().toISOString(),
    });
    try {
      // Routed through cross-skill CLI (Gemini-final-G3). Promotion still
      // never blocks on this result (unchanged, deliberate, pre-existing
      // design) — only the previous silence on a REAL failure is fixed
      // (Defect 4: recordShipEventViaCli's old guard misreported every
      // failure as {ok:true}, so there was nothing for this caller to
      // observe even if it had looked).
      const r = await recordShipEventViaCli(repoRoot, {
        repoId,
        commitSha: safeGitSha(repoRoot),
        branch: safeGitBranch(repoRoot),
        outcome: 'shipped',
        blockReasons: [],
      });
      if (!r.ok) process.stderr.write(`  [promote] ship-event recording failed for ${cand.id}: ${r.message}\n`);
    } catch { /* observability — never block promotion on it */ }

    removeJournal(repoRoot, cand.id);
    return { specPath: finalPath };
  } catch (err) {
    // Leave the journal so reconcilePromotionJournal can resolve on next run.
    throw err;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Journal reconciliation (crash recovery)
// ────────────────────────────────────────────────────────────────────────────

export async function reconcilePromotionJournal(repoRoot) {
  const dir = path.join(repoRoot, JOURNAL_DIR);
  if (!fs.existsSync(dir)) return { recovered: 0, rolledBack: 0 };

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return { recovered: 0, rolledBack: 0 };

  let recovered = 0;
  let rolledBack = 0;

  // Resolves Gemini-final-G1: a `pending` entry can mean (a) DB never
  // committed (the journal is honest) OR (b) we crashed between
  // promoteRegressionSpec returning success and writing the
  // 'db-committed' journal update. Cases (a) and (b) need opposite
  // recovery actions, so we MUST query the DB on pending entries to
  // disambiguate. `finalised` and `db-committed` are safe to act on
  // without DB; only `pending` disambiguation needs the live candidate
  // set.
  await initLearningStore();
  let repoId = null;
  if (await isCloudEnabled()) {
    try {
      const uuid = readLocalRepoUuid(repoRoot);
      if (uuid) repoId = await getRepoIdByUuid(uuid);
    } catch { /* fall through */ }
  }
  const canQueryDb = !!repoId;
  const candidateByFingerprint = new Map();
  if (canQueryDb) {
    // Pre-fetch the current candidate set so we can probe individual
    // fingerprints below. (Listing via the CLI honours the cross-skill
    // facade per the plan.) A dependency failure here degrades to "can't
    // disambiguate any pending entry this run" (same as !canQueryDb below)
    // rather than throwing — reconcile is a best-effort recovery pass, and
    // a stale journal entry is safely picked up again on the NEXT run.
    const listResult = listConsistencyCandidatesViaCli(repoRoot, repoId, null);
    for (const c of (listResult.ok ? listResult.candidates : [])) {
      if (c.candidate_fingerprint) candidateByFingerprint.set(c.candidate_fingerprint, c);
    }
  }

  for (const f of files) {
    const journalPath = path.join(dir, f);
    let entry;
    try { entry = JSON.parse(fs.readFileSync(journalPath, 'utf-8')); }
    catch { retrySync(() => fs.unlinkSync(journalPath)); continue; }

    if (entry.stage === 'finalised') {
      retrySync(() => fs.unlinkSync(journalPath));
      continue;
    }

    if (entry.stage === 'db-committed') {
      // The DB UPDATE landed; we crashed before the rename. Complete it.
      try {
        if (fs.existsSync(entry.tmpPath) && !fs.existsSync(entry.intendedPath)) {
          retrySync(() => fs.renameSync(entry.tmpPath, entry.intendedPath));
        }
        retrySync(() => fs.unlinkSync(journalPath));
        recovered += 1;
        process.stderr.write(`[reconcile] Completed deferred rename for ${entry.specId}\n`);
      } catch (err) {
        process.stderr.write(`[reconcile] Failed to complete ${entry.specId}: ${err.message}\n`);
      }
      continue;
    }

    if (entry.stage === 'pending') {
      // Without DB access, we cannot safely disambiguate "DB never
      // committed" from "DB committed but journal not yet updated".
      // Per Gemini-final-G1, the wrong action either corrupts state
      // (delete a committed file) or leaves a stranded row. Leave the
      // journal entry alone and let a future reconcile with DB access
      // resolve it.
      if (!canQueryDb) {
        process.stderr.write(
          `[reconcile] cannot disambiguate pending entry ${entry.specId} — no DB access; leaving untouched\n`,
        );
        continue;
      }
      // Disambiguate via DB query. If the candidate row STILL exists as
      // a candidate, the DB UPDATE didn't land — safe to roll back the
      // .tmp. If the row is missing from the candidate list, the UPDATE
      // landed (it's now locked) — we crashed before writing the
      // 'db-committed' journal entry. Treat as db-committed and complete
      // the rename.
      const stillCandidate = entry.candidateFingerprint
        && candidateByFingerprint.has(entry.candidateFingerprint);

      if (stillCandidate) {
        try {
          if (entry.tmpPath && fs.existsSync(entry.tmpPath)) retrySync(() => fs.unlinkSync(entry.tmpPath));
          retrySync(() => fs.unlinkSync(journalPath));
          rolledBack += 1;
          process.stderr.write(`[reconcile] Rolled back incomplete promotion for ${entry.specId} (DB confirmed never committed)\n`);
        } catch (err) {
          process.stderr.write(`[reconcile] Failed rollback ${entry.specId}: ${err.message}\n`);
        }
      } else {
        // DB committed silently between our journal write and crash.
        // Complete the rename.
        try {
          if (fs.existsSync(entry.tmpPath) && !fs.existsSync(entry.intendedPath)) {
            retrySync(() => fs.renameSync(entry.tmpPath, entry.intendedPath));
          }
          retrySync(() => fs.unlinkSync(journalPath));
          recovered += 1;
          process.stderr.write(`[reconcile] DB query reveals ${entry.specId} was committed despite stale journal; completed rename\n`);
        } catch (err) {
          process.stderr.write(`[reconcile] Failed to complete ${entry.specId}: ${err.message}\n`);
        }
      }
      continue;
    }

    // Unknown stage — orphan the entry; don't touch files.
    process.stderr.write(`[reconcile] Unknown journal stage "${entry.stage}" for ${entry.specId}; left untouched\n`);
  }

  return { recovered, rolledBack };
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function writeJournal(repoRoot, specId, entry) {
  const dir = path.join(repoRoot, JOURNAL_DIR);
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(path.join(dir, `${specId}.json`), JSON.stringify(entry, null, 2));
}

function removeJournal(repoRoot, specId) {
  const p = path.join(repoRoot, JOURNAL_DIR, `${specId}.json`);
  try { retrySync(() => fs.unlinkSync(p)); } catch { /* ignore */ }
}

function defaultPrompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

function readLocalRepoUuid(repoRoot) {
  try {
    const p = path.join(repoRoot, '.audit-loop', 'repo-identity.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'))?.uuid || null;
  } catch { return null; }
}

function safeGitEmail(repoRoot) {
  try {
    return execFileSync('git', ['config', 'user.email'], {
      cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch { return null; }
}
function safeGitSha(repoRoot) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch { return null; }
}
function safeGitBranch(repoRoot) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch { return null; }
}

// Test-internal exports.
export const _internals = Object.freeze({
  JOURNAL_DIR,
  E2E_DIR,
  writeJournal,
  removeJournal,
});

// ────────────────────────────────────────────────────────────────────────────
// Main (skipped when imported)
// ────────────────────────────────────────────────────────────────────────────

const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
  } catch { return false; }
})();

if (isMain) {
  const result = await promoteCandidates(parseArgs(process.argv.slice(2)));
  process.exit(result.exitCode);
}
