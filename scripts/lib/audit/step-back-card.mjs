/**
 * @fileoverview The step-back section of the structural-or-stop card
 * (docs/plans/verification-lessons.md §2.4). Kept out of `structural-card.mjs`
 * (a size-ratcheted file) so the card CLI composes it instead of growing it.
 *
 * At code checkpoints 3 and 6 (the card requested for round 4 or 7) it computes
 * the three deterministic signals; with `stepBack: true` it builds the context
 * pack and runs the reviewer through an INJECTED provider. After round 6 it
 * prints the default: stop-to-debt or a human — rounds 7-8 only with
 * `--past-cap`. Caps are unchanged.
 *
 * Nothing here calls a model unless a provider is passed; the default provider
 * (`createStepBackProvider`) is built lazily by the CLI only for `--step-back`.
 *
 * Domain: audit-orchestration.
 *
 * @module scripts/lib/audit/step-back-card
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { computeRoundSignals, renderRoundSignals, makeGitRunner } from './round-signals.mjs';
import { initialStepBackRecord, buildStepBackPack, runStepBack } from './step-back.mjs';
import { discoverRoundResults, readRoundResult } from './transcript.mjs';
import { readLedgerEntries } from './cap-productivity.mjs';
import { classifyPath } from '../sensitive-paths.mjs';

const execFileP = promisify(execFile);

/** Code audits only; plan audits keep their own soft cap of 3. */
export const STEP_BACK_CHECKPOINTS = Object.freeze({ code: Object.freeze([3, 6]) });

/** The checkpoint a card requested for `round` reads: the last completed round, when it is 3 or 6 of a code audit. */
export function checkpointFor({ mode, round }) {
  const c = Number.isInteger(round) ? round - 1 : null;
  return mode === 'code' && c != null && STEP_BACK_CHECKPOINTS.code.includes(c) ? c : null;
}

/** Round results with their recorded audited sha, up to and including `upTo`. Never throws. */
export function readRoundsWithSha({ sid, auditDir, upTo }) {
  try {
    const found = discoverRoundResults({ sid, dir: auditDir }).filter((r) => r.round <= upTo);
    return { rounds: found.map(({ path: p, round }) => { const r = readRoundResult(p); return { round, auditedSha: r._auditedSha ?? null, verdict: r.verdict ?? null, findings: Array.isArray(r.findings) ? r.findings : null }; }), unmeasured: null };
  } catch (err) { return { rounds: null, unmeasured: `round results unreadable (${err.message})` }; }
}

/**
 * After round 6 the default is stop-to-debt or a human, whatever the signals say.
 * @returns {string|null}
 */
export function renderPostSixDefault({ mode, round }) {
  if (mode !== 'code' || !Number.isInteger(round) || round < 7) return null;
  return 'After round 6 the default is STOP-TO-DEBT or a human call (Louis, or the coordinator inside a chip\'s launch authority); '
    + 'rounds 7-8 only with --past-cap "<reason>". The 6/8 caps are unchanged.';
}

/**
 * Compute the checkpoint section. Everything read is rounds <= checkpoint and the live ledger.
 * @param {object} a
 * @param {boolean} [a.stepBack] - invoke the reviewer (needs `provider`)
 * @param {Function} [a.provider] - `({system, user, model}) => Promise<{text, usage}>`; never defaulted here
 * @param {object} [a.deps] - test seams: readRounds, readLedger, git, buildPack
 * @returns {Promise<null|{checkpoint: number, signals: object|null, record: object|null, pack: object|null, usage: object|null, lines: string[]}>}
 */
export async function buildCheckpointSection({ sid, mode, round, planFile = null, auditDir, cwd = process.cwd(), stepBack = false, provider = null, model = null, deps = {} }) {
  const lines = [];
  const post = renderPostSixDefault({ mode, round });
  const checkpoint = checkpointFor({ mode, round });
  if (checkpoint == null) return post ? { checkpoint: null, signals: null, record: null, pack: null, usage: null, lines: [post] } : null;

  const { rounds, unmeasured } = (deps.readRounds || readRoundsWithSha)({ sid, auditDir, upTo: checkpoint });
  if (!rounds || !rounds.some((r) => r.round === checkpoint)) {
    lines.push(`Round signals @ round ${checkpoint}: UNMEASURED — ${unmeasured || `no result for round ${checkpoint}`}. The step-back trigger is unmeasured (an unmeasured signal never fires and is not quiet).`);
    if (post) lines.push(post);
    return { checkpoint, signals: null, record: null, pack: null, usage: null, lines };
  }
  const ledgerAll = (deps.readLedger || readLedgerEntries)({ sid, auditDir });
  // As-of boundary: an entry that mentions a round after the checkpoint is later state and is not read (M6).
  const laterRound = (e) => ['round', 'firstSeenRound', 'lastSeenRound', 'resolvedRound'].some((k) => Number.isInteger(e?.[k]) && e[k] > checkpoint);
  const ledger = ledgerAll.entries ? { ...ledgerAll, entries: ledgerAll.entries.filter((e) => !laterRound(e)) } : ledgerAll;
  const signals = computeRoundSignals({ round: checkpoint, rounds, ledgerEntries: ledger.entries, git: deps.git || makeGitRunner(cwd) });
  let record = initialStepBackRecord({ round: checkpoint, signals });
  lines.push(renderRoundSignals(signals));
  let pack = null; let usage = null;

  if (stepBack) {
    if (record.state !== 'signals-fired') {
      lines.push(`--step-back not run: state is ${record.state}${record.triggerMeasured ? '' : ' (trigger partly unmeasured)'} — the reviewer is invoked only when a signal fires.`);
    } else {
      pack = await (deps.buildPack || buildStepBackPack)({
        repoRoot: cwd, planFile, ledgerEntries: ledger.entries || [], rounds,
        repoFiles: (deps.repoFiles || defaultRepoFiles)(cwd), archNeighbours: deps.archNeighbours === undefined ? defaultArchNeighbours(cwd) : deps.archNeighbours,
      });
      for (const l of pack.skipLog) process.stderr.write(`${l}\n`);
      const out = await runStepBack({ record, pack, provider, model });
      record = out.record; usage = out.usage;
      lines.push(`Step-back: ${record.state} — ${record.next.decision}`);
      if (record.output) lines.push(`  ${JSON.stringify(record.output)}`);
      if (record.error) lines.push(`  rejected: ${record.error}${record.raw ? ' (raw output kept in the card file)' : ''}`);
      if (record.reason) lines.push(`  unavailable: ${record.reason}`);
    }
  } else if (record.state === 'signals-fired') {
    lines.push(`A signal fired: run  node scripts/audit-structural-card.mjs --sid ${sid} --mode code --round ${round} --dir ${JSON.stringify(auditDir)}${planFile ? ` --plan ${JSON.stringify(planFile)}` : ''} --step-back  (no round is admitted on the strength of a fired trigger alone).`);
  }
  if (post) lines.push(post);
  return { checkpoint, signals, record, pack, usage, lines };
}

export function defaultRepoFiles(cwd) {
  return execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
}

/** Top arch-memory neighbours through the repo's own CLI (needs the cloud store; any failure degrades to a note in the pack). */
export function defaultArchNeighbours(cwd) {
  return async ({ files, intent }) => {
    const { stdout } = await execFileP(process.execPath, ['scripts/cross-skill.mjs', 'get-neighbourhood', '--json', JSON.stringify({ targetPaths: files, intentDescription: intent, k: 8 })], { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
    const line = stdout.split('\n').reverse().find((l) => l.startsWith('{'));
    const j = line ? JSON.parse(line) : null;
    // Neighbour source paths are classified like any other egress path (H2): a sensitive one is dropped.
    return (j?.records || []).filter((r) => classifyPath(String(r.filePath || '')) !== 'sensitive').map((r) => ({ symbol: r.symbolName, file: r.filePath, purpose: r.purposeSummary, recommendation: r.recommendation }));
  };
}
