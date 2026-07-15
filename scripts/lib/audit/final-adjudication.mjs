/**
 * @fileoverview Stage 2 — Gemini final adjudicator + bounded clean-challenge.
 * Phase 9 of the tiered-recall audit pipeline.
 *
 * Plan: docs/plans/tiered-recall-audit-pipeline.md Phase 9.
 *
 * **Scoped-Cluster-D note** (2026-07-10, superseded by Phase 12 below): this
 * module shipped in Cluster D with `adapters.reviewCall`/`adapters.cleanRegionCall`
 * as injectable stubs only — no production implementation, and
 * `scripts/gemini-review.mjs` had no `--role adjudicator-only` mode yet.
 *
 * **Phase 12 (this revision)**: `createGeminiReviewSubprocessAdapters()`
 * below is the PRODUCTION implementation — it wraps a subprocess invocation
 * of `gemini-review.mjs review <plan> <transcript.json> --out <out> --role
 * adjudicator-only` (the same external-process pattern `/cycle`'s own skill
 * file already documents), one call per envelope/file (v1, no batching — an
 * accepted, explicitly-named simplification). `gemini-review.mjs` itself is
 * NOT modified beyond additively — see its own `--role` flag and
 * `runAdjudicatorOnlyReview` sibling function, which wrap the existing
 * `runReviewWithRetry`/`runFinalReview` from outside, mirroring the
 * already-shipped `runShadowReview` pattern. This module's own orchestration
 * value (sample selection, verdict interpretation, ledger finalization)
 * stays clean, fully-tested code; the subprocess boundary is covered by
 * `tests/final-adjudication-subprocess-adapter.test.mjs` and the mandatory
 * sensitive-egress gate by `tests/final-adjudication-egress.test.mjs`.
 *
 * Reviews: all `stage1_escalated` items, 100% of HIGH `stage1_mechanical_dismissed`
 * entries (re-verifying the cited disproof is genuinely sound — Gemini gate
 * round-1 finding #G2), 100% of omission-type `stage1_mechanical_dismissed`,
 * a smaller random tail sample, PLUS a bounded stratified "clean region"
 * sample (files/regions no discovery-portfolio model flagged at all — sized
 * `min(10%, N)` of changed files, seeded/reproducible). On the clean-region
 * sample ONLY, Gemini may emit a `stage2_missed_candidate` finding — this is
 * the one place "Gemini never emits net-new findings" is deliberately NOT an
 * absolute invariant (round-1's false-clean objection).
 *
 * @module scripts/lib/audit/final-adjudication
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Stage2DecisionSchema } from '../schemas.mjs';
import { mulberry32, seededShuffleCopy } from '../rng.mjs';
import { nowIso } from './time-utils.mjs';
import { resolveAndClassify } from '../sensitive-paths.mjs';
import { tieredAuditConfig } from '../config.mjs';

/**
 * Layout-aware default location of `gemini-review.mjs` — resolved as a
 * MODULE-RELATIVE sibling (`../../gemini-review.mjs` from `lib/audit/`),
 * NOT repo-root-relative. The previous default,
 * `path.join(repoRoot, 'scripts', 'gemini-review.mjs')`, only exists in the
 * SOURCE-repo layout; in a consumer the tooling lives under
 * `scripts/.claude-skills/`, so every Stage 2 subprocess spawn would have
 * been ENOENT there — the exact consumer-relocation defect class this
 * repo's own known-defect corpus curates (KD-021/KD-026). This module and
 * `gemini-review.mjs` are always shipped together at the same relative
 * offset in BOTH layouts, so module-relative resolution is correct in both.
 * Exported for direct test assertion.
 */
export function defaultGeminiReviewScriptPath() {
  return fileURLToPath(new URL('../../gemini-review.mjs', import.meta.url));
}

/**
 * Select which envelopes/regions Stage 2 reviews. Pure — no I/O.
 *
 * @param {object} triageResult - Stage 1's `{mechanicalDismissed, escalated, confirmedSurvivor}`
 * @param {string[]} cleanRegionFiles - changed files NO discovery-portfolio generator flagged at all
 * @param {{tailSampleRate?: number, cleanRegionRate?: number, seed: number, totalChangedFilesCount?: number}} opts -
 *   `totalChangedFilesCount` is the plan's own sizing baseline ("sized as
 *   min(10%, N) of CHANGED FILES per commit" — audit fix M7, round 1: the
 *   original implementation computed 10% of the already-filtered
 *   `cleanRegionFiles` pool instead, which is a different, smaller baseline
 *   than the plan specifies). Defaults to `cleanRegionFiles.length` when
 *   omitted (backward-safe — degrades to the pre-fix behavior rather than
 *   throwing, since a caller may not always know the total changed-file
 *   count at this call site).
 * @returns {{mandatory: object[], tailSample: object[], cleanRegionSample: string[]}}
 */
export function selectAdjudicationSample(triageResult, cleanRegionFiles, { tailSampleRate = 0.1, cleanRegionRate = 0.1, seed, totalChangedFilesCount } = {}) {
  const rng = mulberry32(seed >>> 0);
  const mandatory = [];
  const tailCandidates = [];

  for (const e of triageResult.escalated || []) mandatory.push(e);
  // Consolidated Gemini gate fix G1, round 2 (secondary point): every entry in
  // `mechanicalDismissed` is, by construction, a MEDIUM/LOW commission-type
  // candidate — `stage1-triage.mjs::classifyStage1Outcome` routes ANY valid
  // HIGH/omission dismissal to `escalated` instead (that's the entire point
  // of the severity gate), so it never reaches `mechanicalDismissed` at all.
  // The prior HIGH/omission branch here was dead code (unreachable given
  // `runStage1CheapTriage`'s own invariant) that implied a path that can't
  // execute; removed rather than kept as defensive noise for an internal
  // pipeline invariant, not user input.
  for (const e of triageResult.mechanicalDismissed || []) {
    tailCandidates.push(e);
  }

  const tailSize = Math.ceil(tailCandidates.length * tailSampleRate);
  const tailSample = seededShuffleCopy(tailCandidates, rng).slice(0, tailSize);

  const cleanFiles = cleanRegionFiles || [];
  const sizingBaseline = totalChangedFilesCount ?? cleanFiles.length;
  const cleanRegionSize = Math.min(Math.ceil(sizingBaseline * cleanRegionRate), cleanFiles.length);
  const cleanRegionSample = seededShuffleCopy(cleanFiles, rng).slice(0, cleanRegionSize);

  return { mandatory, tailSample, cleanRegionSample };
}

/**
 * @typedef {object} FinalAdjudicationBudget
 * @property {number} [tailSampleRate] - passed through to `selectAdjudicationSample`
 * @property {number} [cleanRegionRate] - passed through to `selectAdjudicationSample`
 * @property {number} [seed] - passed through to `selectAdjudicationSample`
 * @property {number} [totalChangedFilesCount] - passed through to `selectAdjudicationSample`
 * @property {number} [maxCleanRegionFiles] - additive hard cap on the clean-region sample size
 * @property {number} [maxMechanicalTailItems] - additive hard cap on the mechanical-dismissed tail sample size
 */

/**
 * The SINGLE place that classifies every Stage 1 terminal state into its
 * Stage 2/human-queue destination (tiered-recall pipeline Phase 11, audit-
 * plan fix H2 round 2 — closes the §1.5 state-machine gap where
 * `stage1_confirmed_survivor` had no defined terminal path). Thin wrapper
 * around `selectAdjudicationSample` — same mandatory/tailSample/
 * cleanRegionSample selection, PLUS:
 *
 *   - `stage1_confirmed_survivor` envelopes are pulled out into
 *     `humanQueueDirect` — they route DIRECTLY to the human-review queue,
 *     NEVER entering `runFinalAdjudication`'s Gemini-call path (nothing was
 *     dismissed here, so there is no dismissal for Gemini to re-verify).
 *   - `budget.maxCleanRegionFiles`/`budget.maxMechanicalTailItems` apply an
 *     ADDITIVE hard cap on top of `selectAdjudicationSample`'s existing
 *     rate-based sizing — backward-compatible: omitting them (as Cluster D's
 *     existing tests do) leaves `selectAdjudicationSample`'s behavior
 *     unchanged.
 *
 * Both `runTieredAuditPipeline` and any future test import this SAME
 * function, so "does every Stage 1 outcome have a Stage 2/human-queue path"
 * is asserted once, not reimplemented per caller.
 *
 * @param {{mechanicalDismissed: object[], escalated: object[], confirmedSurvivor: object[]}} triageResult
 * @param {string[]} cleanRegionFiles
 * @param {FinalAdjudicationBudget} [budget]
 * @returns {{mandatory: object[], tailSample: object[], cleanRegionSample: string[], humanQueueDirect: object[]}}
 */
export function selectFinalAdjudicationWorkItems(triageResult, cleanRegionFiles, budget = {}) {
  const { maxCleanRegionFiles, maxMechanicalTailItems, ...sampleOpts } = budget;
  const sample = selectAdjudicationSample(triageResult, cleanRegionFiles, sampleOpts);
  const tailSample = Number.isFinite(maxMechanicalTailItems)
    ? sample.tailSample.slice(0, maxMechanicalTailItems)
    : sample.tailSample;
  const cleanRegionSample = Number.isFinite(maxCleanRegionFiles)
    ? sample.cleanRegionSample.slice(0, maxCleanRegionFiles)
    : sample.cleanRegionSample;
  return {
    mandatory: sample.mandatory,
    tailSample,
    cleanRegionSample,
    humanQueueDirect: triageResult.confirmedSurvivor || [],
  };
}

/**
 * Interpret one adapter review response into a Stage2 outcome. Pure.
 *
 * @param {object} envelope - the envelope under review (mandatory/tailSample entries only —
 *   clean-region entries have no envelope, see `runFinalAdjudication`)
 * @param {{verdict: 'reversed'|'confirmed'|'verified', rationale?: string}} response
 * @returns {{outcome: 'reversed'|'confirmed_dismissal'|'verified', reasonCode: string}}
 * @throws {Error} if `response.verdict` is not one of the three recognized values
 *   (audit fix H4, round 2 — an unvalidated external adapter response with an
 *   unknown/missing `verdict` previously fell through to the `verified` default,
 *   silently misclassifying a malformed response as a confident survivor
 *   verification rather than surfacing it as the adapter failure it is)
 */
function interpretVerdict(envelope, response) {
  const VALID_VERDICTS = new Set(['reversed', 'confirmed', 'verified']);
  if (!VALID_VERDICTS.has(response?.verdict)) {
    throw new Error(`interpretVerdict: unrecognized adapter response verdict "${response?.verdict}" — expected one of ${[...VALID_VERDICTS].join('|')}`);
  }
  // Consolidated Gemini gate fix G1, round 2: a HIGH/omission valid dismissal
  // is logged by Stage 1 as `outcome: 'escalated'` (with `reasonCode:
  // 'valid_dismissal_high_or_omission_escalated'`), NOT `mechanical_dismissed`
  // — that's the whole point of the severity gate (stage1-triage.mjs's
  // classifyStage1Outcome: "a valid dismissal of a HIGH-severity or
  // omission-type candidate ... sets the candidate to stage1_escalated for
  // mandatory Stage 2 review"). Checking only `mechanical_dismissed` here
  // meant `wasDismissed` was ALWAYS false for exactly the candidates this
  // mandatory-review path exists for — a Gemini-CONFIRMED HIGH/omission
  // dismissal fell through to `verified` (an active finding routed to the
  // human queue) instead of `confirmed_dismissal` (correctly suppressed).
  const wasDismissed = envelope.stageDecisions.some((d) =>
    d.stage === 'stage1' && (
      d.outcome === 'mechanical_dismissed' ||
      (d.outcome === 'escalated' && d.reasonCode === 'valid_dismissal_high_or_omission_escalated')
    )
  );
  if (response.verdict === 'reversed') {
    return { outcome: 'reversed', reasonCode: 'gemini_overturned_mechanical_dismissal' };
  }
  if (wasDismissed && response.verdict === 'confirmed') {
    return { outcome: 'confirmed_dismissal', reasonCode: 'gemini_confirmed_mechanical_dismissal' };
  }
  return { outcome: 'verified', reasonCode: 'gemini_verified_survivor' };
}

/**
 * Run Stage 2 adjudication.
 *
 * @param {object} triageResult - Stage 1's output
 * @param {string[]} cleanRegionFiles - changed files no generator flagged
 * @param {object} adapters
 * @param {(envelope: object) => Promise<{verdict: 'reversed'|'confirmed'|'verified', rationale?: string}>} adapters.reviewCall -
 *   any parse/API failure MUST be surfaced by throwing (never fabricating a
 *   verdict) — a throw leaves the candidate `stage1_escalated`/pending,
 *   retried next round, per §1.5's failure semantics ("never silently
 *   treated as accepted or dismissed")
 * @param {(file: string) => Promise<{verdict: 'missed_candidate', finding?: object}|{verdict: 'clean'}|{verdict: 'pending_security_review'}>} adapters.cleanRegionCall
 * @param {() => string} [adapters.clock]
 * @param {{tailSampleRate?: number, cleanRegionRate?: number, seed: number, totalChangedFilesCount?: number}} sampleOpts
 * @returns {Promise<{reversed: object[], confirmedDismissal: object[], verified: object[], missedCandidates: Array<{file: string, finding?: object}>, unresolved: object[], cleanRegionFailures: Array<{file: string, errorMessage: string, reason?: string}>, pendingSecurityReview: object[]}>}
 * @throws {Error} if an internally-constructed Stage2 decision record fails schema
 *   validation (audit fix H2 — a code bug, never expected in normal operation)
 */
export async function runFinalAdjudication(triageResult, cleanRegionFiles, adapters, sampleOpts) {
  const { mandatory, tailSample, cleanRegionSample } = selectAdjudicationSample(triageResult, cleanRegionFiles, sampleOpts);
  const reviewed = [...mandatory, ...tailSample];

  const reversed = [], confirmedDismissal = [], verified = [], unresolved = [], pendingSecurityReview = [];
  for (const envelope of reviewed) {
    let response;
    try {
      response = await adapters.reviewCall(envelope);
    } catch {
      // Failure escalates to "unresolved / pending" — never silently accepted or dismissed.
      unresolved.push(envelope);
      continue;
    }

    // Phase 12 (audit-plan fix H2, round 4): `pending_security_review` is a
    // TYPED Stage 2 outcome, not a repurposed `reviewCall` value — the
    // mandatory sensitive-egress gate returns this when a candidate's
    // evidence is sensitive, meaning NOTHING was ever sent to Gemini. This
    // is checked BEFORE `interpretVerdict` (which only recognizes
    // reversed/confirmed/verified) so it routes to its OWN accumulator —
    // distinct from `unresolved` (a transient failure, blindly retried next
    // round) since this is a standing classification needing a HUMAN
    // decision, never a re-attempt. Never falls through to
    // `confirmed_dismissal`/`verified` — a sensitive-evidence item must
    // NEVER read as reviewed-and-clean (AGENTS.md "audit your success paths").
    if (response?.verdict === 'pending_security_review') {
      const stageDecision = { stage: 'stage2', outcome: 'pending_security_review', reasonCode: 'sensitive_evidence_pending_security_review', createdAt: nowIso(adapters.clock) };
      const parsed = Stage2DecisionSchema.safeParse(stageDecision);
      if (!parsed.success) {
        throw new Error(`runFinalAdjudication: internally-constructed Stage2 decision failed schema validation — ${parsed.error.message.slice(0, 200)}`);
      }
      envelope.stageDecisions.push(parsed.data);
      pendingSecurityReview.push(envelope);
      continue;
    }

    let decision;
    try {
      decision = interpretVerdict(envelope, response);
    } catch {
      // Failure escalates to "unresolved / pending" — never silently accepted or dismissed.
      unresolved.push(envelope);
      continue;
    }
    // audit fix H2: this is an INTERNALLY-CONSTRUCTED record (not raw external
    // data) — a safeParse failure here means OUR OWN code built a malformed
    // decision, which is a bug to surface loudly, not a case to silently
    // paper over by falling back to the unvalidated object (the original
    // `parsed.success ? parsed.data : stageDecision` made the schema check
    // decorative — it never actually gated anything).
    const stageDecision = { stage: 'stage2', outcome: decision.outcome, reasonCode: decision.reasonCode, createdAt: nowIso(adapters.clock) };
    const parsed = Stage2DecisionSchema.safeParse(stageDecision);
    if (!parsed.success) {
      throw new Error(`runFinalAdjudication: internally-constructed Stage2 decision failed schema validation — ${parsed.error.message.slice(0, 200)}`);
    }
    envelope.stageDecisions.push(parsed.data);

    if (decision.outcome === 'reversed') reversed.push(envelope);
    else if (decision.outcome === 'confirmed_dismissal') confirmedDismissal.push(envelope);
    else verified.push(envelope);
  }

  const missedCandidates = [];
  const cleanRegionFailures = [];
  for (const file of cleanRegionSample) {
    let response;
    try {
      response = await adapters.cleanRegionCall(file);
    } catch (err) {
      // audit fix M5: clean-region failures are advisory (never block the
      // round — a failed check here just means one fewer clean-region file
      // was audited this round) but must be VISIBLE to the caller, not
      // silently swallowed — a systematically failing adapter could
      // otherwise reduce clean-region coverage to zero with no signal.
      cleanRegionFailures.push({ file, errorMessage: err?.message || String(err) });
      continue;
    }
    if (response?.verdict === 'missed_candidate') {
      missedCandidates.push({ file, finding: response.finding });
    } else if (response?.verdict === 'pending_security_review') {
      // Phase 12: the clean-region path NEVER reports a sensitive file as
      // 'clean' — it reuses the EXISTING cleanRegionFailures field (this
      // file was not actually reviewed this round) with reason:'sensitive_path'
      // rather than a parallel list, since both represent the same
      // "not reviewed" state.
      cleanRegionFailures.push({ file, errorMessage: 'sensitive path — not sent for review', reason: 'sensitive_path' });
    }
  }

  return { reversed, confirmedDismissal, verified, missedCandidates, unresolved, cleanRegionFailures, pendingSecurityReview };
}

// ── Production adapters — gemini-review.mjs subprocess (Phase 12) ──────────

/**
 * File candidates (new-side first) referenced by one evidence anchor.
 * @param {{oldFile?: string, newFile?: string}|null|undefined} anchor
 * @returns {string[]}
 */
function anchorFileCandidates(anchor) {
  if (!anchor) return [];
  return [anchor.newFile, anchor.oldFile].filter(Boolean);
}

/**
 * Every file path an envelope's CANONICAL claim references — the set the
 * mandatory sensitive-egress gate classifies before a transcript is ever
 * built (plan Phase 12, audit-plan fix H2 round 3).
 * @param {object} envelope
 * @returns {string[]}
 */
function envelopeReferencedFiles(envelope) {
  const f = envelope?.canonicalFinding || {};
  return [...anchorFileCandidates(f.anchor), ...anchorFileCandidates(f.triggerAnchor)];
}

/**
 * @param {string|null|undefined} file
 * @param {string} repoRoot
 * @returns {boolean} true when `file` classifies sensitive OR cannot be
 *   classified at all (fail-closed — mirrors `resolveAndClassify`'s own
 *   fail-closed contract for resolution errors).
 */
function isPathSensitive(file, repoRoot) {
  if (!file) return false;
  try {
    return resolveAndClassify(file, { repoRoot }).category === 'sensitive';
  } catch {
    return true;
  }
}

/**
 * Build the "Alternative evidence" lines for one envelope (plan Phase 12,
 * audit-plan fix M1 round 4) — mirrors `candidate-envelope.mjs::flattenEnvelopeToFinding`'s
 * altLines construction, PLUS an additional per-line sensitive-egress check
 * (an alternative's anchor file can differ from the canonical claim's) —
 * a sensitive alternative is silently omitted from the block rather than
 * failing the whole review (only the CANONICAL claim's sensitivity routes
 * the whole envelope to `pending_security_review`).
 * @param {object} envelope
 * @param {string} repoRoot
 * @returns {string[]}
 */
function buildAlternativeEvidenceLines(envelope, repoRoot) {
  const { canonicalFinding, evidenceAlternatives = [] } = envelope;
  return evidenceAlternatives
    .filter((alt) => alt && alt.rawDetail !== canonicalFinding?.detail)
    .filter((alt) => {
      const files = [...anchorFileCandidates(alt.anchor), ...anchorFileCandidates(alt.triggerAnchor)];
      return !files.some((f) => isPathSensitive(f, repoRoot));
    })
    .map((alt) => `- ${alt.sourceModel ?? 'unknown'} (${alt.evidenceType ?? 'n/a'})${alt.verificationFailed ? ' [unverified anchor]' : ''}: ${alt.rawDetail ?? ''}`.trim());
}

/** Canonical claim's `detail`, with the alternative-evidence block appended when non-empty. */
function buildFindingDetail(envelope, repoRoot) {
  const base = envelope.canonicalFinding?.detail ?? '';
  const altLines = buildAlternativeEvidenceLines(envelope, repoRoot);
  return altLines.length > 0 ? `${base}\n\nAlternative evidence:\n${altLines.join('\n')}` : base;
}

/** The single file this envelope is "about", for the transcript's changed_files/code_files. */
function primaryFile(envelope) {
  const f = envelope.canonicalFinding || {};
  const sectionFile = typeof f.section === 'string' ? f.section.split(':')[0] : null;
  return sectionFile || f.file || f.anchor?.newFile || f.anchor?.oldFile
    || f.triggerAnchor?.newFile || f.triggerAnchor?.oldFile || 'unknown';
}

/**
 * Spawn `gemini-review.mjs review <plan> <transcript> --out <out> --role
 * adjudicator-only` in a private, exclusive-creation, 0o600 temp directory
 * (plan Phase 12, audit-plan fix M3 round 2) — removed in `finally`
 * regardless of success/failure/timeout (audit-plan fix G3, Gemini gate
 * round 4: the timeout is ACTIVELY enforced via `execFile`'s own `timeout`
 * option, which SIGTERMs the child on expiry; a `killed:true` error from
 * that path is thrown here exactly like a non-zero exit — same
 * adapter-FAILURE path either way).
 *
 * @param {object} opts
 * @param {object} opts.transcript - JSON-serializable transcript object
 * @param {string} opts.repoRoot
 * @param {string} opts.geminiReviewScript - absolute path to gemini-review.mjs
 * @param {number} opts.perCallTimeoutMs
 * @param {Function} [opts.execFileImpl] - injectable for tests
 * @param {string[]} [opts.extraCliArgs] - appended after the standard args (test-only `--provider fixture`)
 * @param {NodeJS.ProcessEnv} [opts.env] - injectable for tests
 * @returns {Promise<object>} the parsed `--out` JSON
 * @throws {Error} on non-zero exit, timeout/kill, or a missing/unparseable `--out` file
 */
async function invokeGeminiReviewSubprocess({ transcript, repoRoot, geminiReviewScript, perCallTimeoutMs, execFileImpl, extraCliArgs = [], env }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-adjudication-'));
  try {
    const transcriptPath = path.join(dir, 'transcript.json');
    const planPath = path.join(dir, 'plan.md');
    const outPath = path.join(dir, 'result.json');
    fs.writeFileSync(transcriptPath, JSON.stringify(transcript), { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(
      planPath,
      '# Stage 2 Adjudication\n\nSingle-candidate re-verification pass (tiered-recall audit pipeline) — see the audit transcript below for full context.\n',
      { mode: 0o600, flag: 'wx' }
    );

    const runExecFile = execFileImpl || execFile;
    await new Promise((resolvePromise, reject) => {
      runExecFile(
        process.execPath,
        [geminiReviewScript, 'review', planPath, transcriptPath, '--out', outPath, '--role', 'adjudicator-only', '--mode', 'code', ...extraCliArgs],
        { cwd: repoRoot, timeout: perCallTimeoutMs, env: env || process.env, maxBuffer: 10 * 1024 * 1024 },
        (err) => { if (err) reject(err); else resolvePromise(); }
      );
    });

    // Exit-code handling: a non-zero exit is already surfaced by the reject()
    // above (execFile's callback receives `err` — including `err.killed` on
    // SIGTERM timeout). Exit 0 with a missing/unparseable `--out` is ALSO an
    // adapter FAILURE (audit-plan fix — never silently treated as success).
    let raw;
    try {
      raw = fs.readFileSync(outPath, 'utf8');
    } catch (err) {
      throw new Error(`gemini-review subprocess produced no --out file: ${err.message}`);
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(`gemini-review subprocess --out file is not valid JSON: ${err.message}`);
    }
  } finally {
    // Entire directory, not just the two files — robust to the adapter having
    // written anything else transient into it. Success or failure, always runs.
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * PRODUCTION `adapters.reviewCall`/`adapters.cleanRegionCall` for
 * `runFinalAdjudication` — one `gemini-review.mjs --role adjudicator-only`
 * subprocess invocation per envelope/file (plan Phase 12).
 *
 * Mandatory sensitive-egress gate runs BEFORE any transcript is written or
 * subprocess spawned (audit-plan fix H2 round 3): every path an envelope's
 * canonical claim references (`anchor.oldFile`/`newFile`, `triggerAnchor`'s
 * file) — or, for `cleanRegionCall`, the file itself — is classified via the
 * EXISTING `resolveAndClassify` (`scripts/lib/sensitive-paths.mjs`). A
 * sensitive classification short-circuits to `{verdict:
 * 'pending_security_review'}` with NO subprocess spawned and NO transcript
 * ever written — the content-level gate this repo already applies to every
 * other GPT/Gemini call site, reused here rather than reinvented.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot - REQUIRED (no `process.cwd()` fallback —
 *   matches `sensitive-paths.mjs`'s own contract, precisely so a caller
 *   cannot accidentally wire up naive/no-root classification, the INC-001
 *   symlink-bypass class).
 * @param {number} [opts.perCallTimeoutMs] - defaults to `tieredAuditConfig.adjudicationPerCallTimeoutMs`
 * @param {string} [opts.geminiReviewScript] - defaults to `<repoRoot>/scripts/gemini-review.mjs`
 * @param {Function} [opts.execFileImpl] - injectable for tests (defaults to `node:child_process`'s `execFile`)
 * @param {string[]} [opts.extraCliArgs] - test-only passthrough (e.g. `['--provider', 'fixture']`)
 * @param {NodeJS.ProcessEnv} [opts.env] - injectable for tests
 * @returns {{reviewCall: Function, cleanRegionCall: Function}}
 * @throws {TypeError} if `opts.repoRoot` is missing
 */
export function createGeminiReviewSubprocessAdapters({
  repoRoot,
  perCallTimeoutMs = tieredAuditConfig.adjudicationPerCallTimeoutMs,
  geminiReviewScript,
  execFileImpl,
  extraCliArgs = [],
  env,
  // Test-only: shallow-merged into the built transcript before it's sent —
  // lets the subprocess-adapter test drive `gemini-review.mjs --provider
  // fixture`'s deterministic `_fixtureVerdict` switch (see gemini-review.mjs
  // `runFixtureReview`) through the REAL subprocess round trip, exercising
  // this adapter's OWN verdict-mapping logic end-to-end rather than only its
  // default 'confirmed'/'clean' branch. No-op (`{}`) in production.
  transcriptOverrides = {},
} = {}) {
  if (!repoRoot) {
    throw new TypeError('createGeminiReviewSubprocessAdapters: repoRoot is required');
  }
  // Module-relative sibling, NOT path.join(repoRoot, 'scripts', ...) — the
  // repo-root form breaks under the consumer scripts/.claude-skills/ layout
  // (see defaultGeminiReviewScriptPath's docblock).
  const scriptPath = geminiReviewScript || defaultGeminiReviewScriptPath();

  async function reviewCall(envelope) {
    const referencedFiles = envelopeReferencedFiles(envelope);
    if (referencedFiles.some((f) => isPathSensitive(f, repoRoot))) {
      return { verdict: 'pending_security_review' };
    }

    const cf = envelope.canonicalFinding || {};
    const file = primaryFile(envelope);
    const findingId = cf.id || envelope.candidateId || 'C1';
    const detail = buildFindingDetail(envelope, repoRoot);
    const transcript = {
      audit_mode: 'code',
      changed_files: [file],
      code_files: [file],
      summary: 'Stage 2 adjudication — single-candidate re-verification (tiered-recall audit pipeline).',
      rounds: [{ round: 1, findings: [{ id: findingId, severity: cf.severity || 'MEDIUM', file, detail }] }],
      claude_resolutions: [],
      ...transcriptOverrides,
    };

    const result = await invokeGeminiReviewSubprocess({
      transcript, repoRoot, geminiReviewScript: scriptPath, perCallTimeoutMs, execFileImpl, extraCliArgs, env,
    });

    // Verdict mapping (plan Phase 12): reversed iff the reviewed finding
    // appears in wrongly_dismissed[]; otherwise 'confirmed' — interpretVerdict
    // (the caller) already implements the wasDismissed → confirmed_dismissal
    // vs. verified split, so the adapter itself never needs to distinguish
    // 'confirmed' from 'verified' — a bare-survivor envelope (wasDismissed
    // false) correctly downgrades a 'confirmed' response to `verified` there.
    const reversedEntry = Array.isArray(result?.wrongly_dismissed)
      ? result.wrongly_dismissed.find((w) => w.original_finding_id === findingId)
      : null;
    if (reversedEntry) {
      return { verdict: 'reversed', rationale: reversedEntry.reason_claude_was_wrong };
    }
    return { verdict: 'confirmed', rationale: result?.overall_reasoning };
  }

  async function cleanRegionCall(file) {
    if (isPathSensitive(file, repoRoot)) {
      return { verdict: 'pending_security_review' };
    }

    const transcript = {
      audit_mode: 'code',
      changed_files: [file],
      code_files: [file],
      summary: `Stage 2 clean-region sample — no discovery-portfolio model flagged ${file}.`,
      rounds: [{ round: 1, findings: [] }],
      claude_resolutions: [],
      ...transcriptOverrides,
    };

    const result = await invokeGeminiReviewSubprocess({
      transcript, repoRoot, geminiReviewScript: scriptPath, perCallTimeoutMs, execFileImpl, extraCliArgs, env,
    });

    // Verdict mapping: missed_candidate iff Gemini surfaced a new finding on
    // this clean region; otherwise clean.
    if (Array.isArray(result?.new_findings) && result.new_findings.length > 0) {
      return { verdict: 'missed_candidate', finding: result.new_findings[0] };
    }
    return { verdict: 'clean' };
  }

  return { reviewCall, cleanRegionCall };
}
