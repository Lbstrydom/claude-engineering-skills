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
import 'dotenv/config';

import { atomicWriteFileSync } from './lib/file-io.mjs';
import { renderCandidateSpec } from './lib/ux-lock/candidate-spec.mjs';
import {
  initLearningStore,
  isCloudEnabled,
  listConsistencyCandidates,
  promoteRegressionSpec,
  getRepoIdByUuid,
  recordShipEvent,
} from './learning-store.mjs';

const JOURNAL_DIR = path.join('.persona-test', 'promotion-journal');
const E2E_DIR     = path.join('tests', 'e2e');

export const EXIT = Object.freeze({
  OK:               0,
  NOTHING_PENDING:  0,    // empty queue is success, not failure
  CLOUD_OFF:        0,    // no candidates to promote when cloud is off
  USER_DECLINED:    0,    // user said n — also success
  BAD_INPUT:        1,
  PARTIAL_FAILURE:  2,    // some promotions succeeded, some failed
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
  if (!isCloudEnabled()) {
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

  const candidates = await listConsistencyCandidates(repoId, { sinceTs: args.since });
  if (!candidates || candidates.length === 0) {
    process.stdout.write('No pending consistency candidates.\n');
    return result;
  }

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
  // 1. Render the spec body (deterministic — same candidate → same body).
  const { filename, body } = renderCandidateSpec(
    cand.witness_snapshot,
    cand.contradiction_payload,
    {
      journeySteps:           cand.journey_context?.journeySteps || [],
      routes:                 cand.journey_context?.routes,
      authBootstrap:          cand.journey_context?.authBootstrap,
      candidateFingerprint:   cand.candidate_fingerprint,
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

    // 4. DB UPDATE candidate → locked.
    const updateResult = await promoteRegressionSpec(cand.id, {
      specPath: path.relative(repoRoot, finalPath).replace(/\\/g, '/'),
      promotedBy,
      candidateFingerprint: cand.candidate_fingerprint,
    });
    if (!updateResult.ok || updateResult.rowsAffected === 0) {
      // DB didn't transition — remove the .tmp and bail.
      try { fs.unlinkSync(tmpPath); } catch { /* swallow */ }
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
    fs.renameSync(tmpPath, finalPath);

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
      await recordShipEvent(repoId, {
        commitSha: safeGitSha(repoRoot),
        branch: safeGitBranch(repoRoot),
        outcome: 'shipped',
        blockReasons: [],
      });
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

  for (const f of files) {
    const journalPath = path.join(dir, f);
    let entry;
    try { entry = JSON.parse(fs.readFileSync(journalPath, 'utf-8')); }
    catch { fs.unlinkSync(journalPath); continue; }

    if (entry.stage === 'finalised') {
      fs.unlinkSync(journalPath);
      continue;
    }

    if (entry.stage === 'db-committed') {
      // The DB UPDATE landed; we crashed before the rename. Complete it.
      try {
        if (fs.existsSync(entry.tmpPath) && !fs.existsSync(entry.intendedPath)) {
          fs.renameSync(entry.tmpPath, entry.intendedPath);
        }
        fs.unlinkSync(journalPath);
        recovered += 1;
        process.stderr.write(`[reconcile] Completed deferred rename for ${entry.specId}\n`);
      } catch (err) {
        process.stderr.write(`[reconcile] Failed to complete ${entry.specId}: ${err.message}\n`);
      }
      continue;
    }

    if (entry.stage === 'pending') {
      // DB never committed. Roll back the .tmp file; leave the candidate row.
      try {
        if (entry.tmpPath && fs.existsSync(entry.tmpPath)) fs.unlinkSync(entry.tmpPath);
        fs.unlinkSync(journalPath);
        rolledBack += 1;
        process.stderr.write(`[reconcile] Rolled back incomplete promotion for ${entry.specId}\n`);
      } catch (err) {
        process.stderr.write(`[reconcile] Failed rollback ${entry.specId}: ${err.message}\n`);
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
  try { fs.unlinkSync(p); } catch { /* ignore */ }
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
