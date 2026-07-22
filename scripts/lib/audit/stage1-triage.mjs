/**
 * @fileoverview Stage 1 — cheap-model triage for Stage-0 survivors. Phase 7
 * of the tiered-recall audit pipeline.
 *
 * Plan: docs/plans/tiered-recall-audit-pipeline.md Phase 7.
 *
 * **Scoped-Cluster-D note** (2026-07-10): this module is new, tested, and
 * NOT wired into `openai-audit.mjs`'s production chooser in this pass — see
 * `gpt-sentinel-trigger.mjs`'s module header for the same note and
 * `.audit/cycle-cluster-state.json` for the full rationale. In production
 * this would call the model chosen by Cluster C's `cheap-triager-validate.mjs`
 * manifest (freshness-checked via `datasetHash`, falling back to GPT-5.5 on
 * staleness) — that manifest does not exist yet (Cluster C's own documented
 * human-grading boundary), so `runStage1CheapTriage` takes the triager as an
 * injected adapter rather than resolving a model itself.
 *
 * **Dismissal validity is severity-independent; escalation-on-valid-dismissal
 * is severity-gated** (Gemini gate round-2 finding #G2): a dismissal is valid
 * ONLY when an explicit deterministic disproof is cited, regardless of
 * severity — an invalid dismissal attempt (no disproof cited) on ANY
 * candidate never produces `mechanical_dismissed`; it reverts to
 * `confirmed_survivor`. Severity only controls what happens to a VALID
 * dismissal: a valid dismissal of a HIGH-severity or omission-type candidate
 * is not trusted outright — it escalates to mandatory Stage 2 review; a valid
 * dismissal of a MEDIUM/LOW commission-type candidate becomes
 * `mechanical_dismissed` directly.
 *
 * @module scripts/lib/audit/stage1-triage
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Stage1DecisionSchema, StageOneTriageInputSchema, normalizeFindingEvidence, clampToJsonSchemaLimits } from '../schemas.mjs';

// JSON-schema form of the triage-input DTO, computed once. Used to CLAMP
// over-limit string fields before the schema parse below — the same primitive
// the discovery generators (tiered-pipeline.mjs glm/sonnet) already apply to
// producer output. A finding's `detail` (etc.) can exceed the cap (Sonnet/GLM
// write long details; redaction can also grow a field), and a raw `.parse`
// would throw and abort the WHOLE Stage-1 run over one candidate (live shadow
// failure, 2026-07-22). Clamp = the over-long finding degrades itself.
const StageOneTriageInputJsonSchema = z.toJSONSchema(StageOneTriageInputSchema);
import { generateTopicId, writeStage1MechanicalLedgerEntry } from '../ledger.mjs';
import { resolveAndClassify, classifyPath } from '../sensitive-paths.mjs';
import { redact } from '../redact.mjs';
import { nowIso } from './time-utils.mjs';

// ── Stage 1 triager DTO builder (audit-orchestrator-hardening Phase 8) ─────
// Boundary character set for the free-text path-mention scan: whitespace,
// backticks, parens, brackets, quotes split tokens apart; sentence
// punctuation (., ,, :, ;, !, ?) is trimmed from each token's EDGES
// afterward (Gemini gate fix G1, rounds 1-2 of that gate — the raw
// `SENSITIVE_PATTERNS` regexes are mostly `$`-end-anchored, so a token like
// `.env.` or `"secrets/db.yaml"` must have its enclosing punctuation
// stripped before `classifyPath` can match it). Deliberately bounded/best-
// effort, not a natural-language-complete parser (Gemini gate fix G1, round
// 2 — this is a SECONDARY, defense-in-depth net behind the structured
// `section` field, which is the primary, complete path-redaction contract).
const SPLIT_BOUNDARY = /[\s`()[\]{}"']+/;
// audit-code round-2 H1 (root-caused, not just patched): stripping a LEADING
// `.` was silently destroying the classification of any dotfile mention —
// ".env" -> "env" no longer matches `.env`'s sensitive pattern at all. This
// was a pre-existing gap (predates this plan's diff), invisible because no
// existing test used a leading-dot sensitive name (only extension-less
// "id_rsa" and slash-shaped "secrets/db.yaml" were covered). The leading
// strip now excludes `.` — a genuinely leading sentence-punctuation char
// (`,`/`:`/`;`/`!`/`?`) is still stripped; a leading `.` is preserved since
// it is semantically load-bearing for dotfile names. Trailing strip is
// unaffected — a sentence-ending period after a dotfile mention (".env.")
// still correctly leaves ".env".
// audit-code round-4 H1/H2: markup/wrapper punctuation (`**bold**`,
// `<angle>` markers) was not stripped, so a wrapped mention like `**.env**`
// or `<.env>` never reduced to the bare classifiable path. Added `*`/`<`
// to the leading class and `*`/`>` to the trailing class — `.` remains
// excluded from LEADING (dotfile-preserving, round-2 H1); trailing strip
// already covered sentence punctuation.
const EDGE_PUNCT_LEADING = /^[,:;!?*<]+/;
const EDGE_PUNCT_TRAILING = /[.,:;!?*>]+$/;
// audit-code round-2 H1 + round-4 H2: a source-location citation ("see
// .env:12 for the value") or a fragment-style reference ("see .env#L12" or
// a GitHub-style line-range fragment "see .env#L12-L15") wasn't being
// normalized before classification — `classifyPath` tests the LITERAL
// token, so ".env:12"/".env#L12"/".env#L12-L15" ≠ ".env" and the
// lexical/symlink checks below would both silently miss it. Mirrors the
// `section` field's OWN existing convention (`rawSection.split(':')[0]`) —
// strip a trailing `:line`, `:line:col`, or `#fragment` suffix before
// classifying, but keep the ORIGINAL token as the redaction match target so
// the whole citation (not just the path portion) gets replaced. The
// fragment class allows `-` (audit-code round-5 H1) — a bare `\w+` doesn't
// match GitHub-style hyphenated ranges like `#L12-L15`, leaving them
// unstripped and unredacted.
const SOURCE_LOCATION_SUFFIX = /(?::\d+(?::\d+)?|#[\w-]+)$/;

/**
 * Candidate-aware canonical classifier for free-text tokens (audit-code
 * round 1, H1/H3 — sustained twice with a concrete, proportionate remediation
 * request: "a dedicated design within this implementation... not a broad new
 * scanning framework"). `sensitive-paths.mjs::resolveAndClassify` is NOT
 * reusable here directly: its contract fail-closes to `'sensitive'` on ANY
 * `fs.realpathSync` error INCLUDING plain ENOENT — correct for a structured
 * field known to hold exactly one real repo path (`section`, an anchor's
 * `newFile`), but catastrophic for free-text tokenization, where the
 * overwhelming majority of tokens are ordinary English words that simply
 * don't exist on disk. Naively reusing `resolveAndClassify` per-token would
 * redact nearly all prose (verified directly: `fs.realpathSync('the')`
 * ENOENTs like any other non-path word).
 *
 * This helper inverts that default: ENOENT (the token doesn't correspond to
 * a real file) means "ordinary word, not a path at all" — benign, not
 * fail-closed. Only a token that resolves to a REAL, EXISTING filesystem
 * entry is classified further: if its canonical (symlink-resolved) target
 * is lexically sensitive, or escapes `repoRoot` entirely, it's sensitive —
 * closing the symlink-bypass gap H3 identified for candidate path-shaped
 * free-text mentions, without the false-positive blast radius a blind
 * `resolveAndClassify` swap would cause.
 *
 * @param {string} token
 * @param {string} repoRoot
 * @returns {boolean}
 */
function isSensitiveViaSymlinkResolution(token, repoRoot) {
  let abs;
  try {
    abs = path.isAbsolute(token) ? token : path.resolve(repoRoot, token);
  } catch {
    return false; // not a resolvable path shape at all — ordinary token
  }
  let canonical;
  try {
    canonical = fs.realpathSync(abs);
  } catch (err) {
    // audit-code round-2 H2: ENOENT/ENOTDIR specifically mean "this path
    // segment doesn't exist" — the EXPECTED, overwhelmingly common case for
    // an ordinary English word being resolved as a path candidate, and the
    // only case safe to treat as benign. Any OTHER error (EACCES — exists
    // but permission-denied; ELOOP — symlink cycle; etc.) means the path
    // DOES exist but its target could not be verified — that must fail-
    // closed to sensitive, matching `resolveAndClassify`'s own contract for
    // genuine resolution problems, not be conflated with "just a word".
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return false;
    return true;
  }
  const rel = path.relative(path.resolve(repoRoot), canonical);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return true; // escapes repo — fail-safe
  return classifyPath(canonical) === 'sensitive';
}

/**
 * Tokenize-then-classify a free-text string for embedded sensitive-path
 * mentions, then run `redactSecrets` over the result. Two independent
 * checks — a bare path mention (e.g. ".env" in prose) isn't secret-SHAPED
 * so `redactSecrets` alone would miss it (Gemini gate fix G1, round 1);
 * a hardcoded credential isn't path-shaped so the path scan alone would
 * miss it. EVERY extracted token is tested via `classifyPath` — no
 * "plausible path shape" pre-filter (Gemini gate fix G1, round 3 — several
 * `SENSITIVE_PATTERNS` entries are bare, extension-less filenames like
 * `id_rsa`/`secret`/`password`/`token`, which a shape pre-filter would
 * discard before `classifyPath` ever saw them). A classified-sensitive
 * token has its EXACT original (un-trimmed) substring replaced, so
 * enclosing punctuation redacts along with it.
 *
 * A token that survives the lexical check is ALSO checked via
 * `isSensitiveViaSymlinkResolution` (audit-code round-1 H1/H3) — a token
 * whose lexical name is innocent but which resolves (as a real, existing
 * file) to a sensitive canonical target is caught too, closing the
 * symlink-bypass gap the structured `section`/anchor-file fields already
 * close via `resolveAndClassify`.
 *
 * @param {string|null|undefined} text
 * @param {string} repoRoot
 * @returns {{text: string, redacted: boolean}}
 */
function redactFreeText(text, repoRoot) {
  if (text == null) return { text: '', redacted: false };
  const raw = String(text);
  let scanned = raw;
  let anyRedacted = false;
  const rawTokens = raw.split(SPLIT_BOUNDARY).filter(Boolean);
  for (const rawToken of rawTokens) {
    const trimmed = rawToken.replace(EDGE_PUNCT_LEADING, '').replace(EDGE_PUNCT_TRAILING, '');
    if (!trimmed) continue;
    // Strip a trailing source-location suffix (":12", ":12:4") BEFORE
    // classification (round-2 H1) — ".env:12" must classify the same as
    // ".env"; the ORIGINAL rawToken (still carrying the suffix) remains the
    // redaction match target so the whole citation is replaced.
    const pathCandidate = trimmed.replace(SOURCE_LOCATION_SUFFIX, '');
    if (classifyPath(pathCandidate) === 'sensitive' || isSensitiveViaSymlinkResolution(pathCandidate, repoRoot)) {
      anyRedacted = true;
      scanned = scanned.split(rawToken).join('[REDACTED]');
    }
  }
  const secretResult = redact(scanned);
  if (secretResult.count > 0) anyRedacted = true;
  return { text: secretResult.redacted, redacted: anyRedacted };
}

/**
 * Resolve which evidence anchor (and quote) applies to a finding's
 * evidenceStatus — commission cites `anchor`, omission cites
 * `triggerAnchor`. Both map onto the DTO's single flat `anchorQuote` field.
 */
function resolveEvidenceAnchor(evidence) {
  if (evidence.evidenceStatus === 'commission') return { anchor: evidence.anchor, quote: evidence.anchor?.quote ?? null };
  if (evidence.evidenceStatus === 'omission') return { anchor: evidence.triggerAnchor, quote: evidence.triggerAnchor?.quote ?? null };
  return { anchor: null, quote: null };
}

/**
 * Build the minimized, redacted `StageOneTriageInputSchema` DTO an
 * `adapters.triagerCall` receives — never the raw envelope (audit-plan fix
 * H1/H2/M1 round 2; Gemini gate fixes G1-G2 rounds 1-4). `repoRoot` is
 * REQUIRED (no default, no `process.cwd()` fallback) — matches
 * `resolveAndClassify`'s own existing contract, precisely so an implementer
 * cannot accidentally wire up a naive/no-root classification (the INC-001
 * symlink-bypass class).
 *
 * Redaction is uniform:
 *  - `section` (a real structured path field, never embedded in prose) →
 *    `resolveAndClassify`/`classifyPath` directly on its file portion (the
 *    part before `:line`, matching this repo's own `generateTopicId`
 *    convention) → `'[REDACTED]'` + `redacted: true` on a sensitive hit.
 *  - Free-text fields (`category`, `detail`, `anchorQuote`, `causalChain`)
 *    → the tokenize-then-`classifyPath` scan (`redactFreeText`), THEN
 *    `redactSecrets` for secret-shaped content the path scan doesn't catch.
 *  - `anchorQuote`/`causalChain`'s SOURCE anchor file is additionally
 *    gated through `resolveAndClassify` — a sensitive source file degrades
 *    the whole quote/chain to `null`, independent of the content-level scan
 *    above (two independent risks; neither substitutes for the other).
 *  - `severity`/`evidenceStatus` are genuinely closed enums — never
 *    redacted.
 *
 * @param {object} finding - `envelope.canonicalFinding` (or any FindingSchema-
 *   shaped object). audit-orchestrator-hardening H9: a `finding` missing
 *   `severity`/`category`/`detail` ENTIRELY throws `Error{code:'MALFORMED_FINDING'}`
 *   rather than silently manufacturing a safe-looking default DTO — the
 *   caller (`runStage1CheapTriage`) catches this specifically and escalates
 *   just that one candidate, never the whole run. Individual PRESENT-but-
 *   optional fields (e.g. no `anchorQuote`) still degrade gracefully.
 * @param {{repoRoot: string}} opts
 * @returns {import('../schemas.mjs').StageOneTriageInput}
 * @throws {TypeError} if `opts.repoRoot` is missing (config wiring bug)
 * @throws {Error} with `.code === 'MALFORMED_FINDING'` if `finding` is
 *   missing/empty (a per-candidate producer bug, not a wiring bug)
 */
export function buildStageOneTriageInput(finding, opts) {
  if (!opts || typeof opts.repoRoot !== 'string' || !opts.repoRoot) {
    throw new TypeError('buildStageOneTriageInput: opts.repoRoot is required');
  }
  // audit-orchestrator-hardening H9 (hardening-implementation audit round
  // 1): the previous `const f = finding || {}` silently normalized a
  // missing/malformed finding into a schema-valid DTO with safe-looking
  // defaults (severity:'LOW', evidenceStatus:'missing') — masking an
  // upstream producer bug as a clean, low-priority, "nothing to see here"
  // triage input instead of surfacing it. Distinguished from the repoRoot
  // check above via `.code` so the caller can tell "config wiring is
  // broken, abort everything" (TypeError, no code, thrown outside any
  // try/catch on purpose) apart from "this one candidate's producer output
  // is malformed" (this error, `.code: 'MALFORMED_FINDING'`) — the latter
  // must escalate just the one envelope, never abort the whole Stage 1 run.
  if (!finding || (finding.severity == null && finding.category == null && finding.detail == null)) {
    const err = new Error('buildStageOneTriageInput: finding is missing/empty — cannot build a triage input from a producer bug\'s output');
    err.code = 'MALFORMED_FINDING';
    throw err;
  }
  const { repoRoot } = opts;
  const f = finding;
  let redacted = false;

  // section — structured path field, classified directly (no tokenization
  // ambiguity). Extract the file portion before `:line` first (established
  // repo convention — see ledger.mjs::generateTopicId) so a `file:42`-shaped
  // section doesn't spuriously fail-closed on fs.realpathSync(ENOENT).
  const rawSection = f.section != null ? String(f.section) : '';
  const sectionFile = rawSection.split(':')[0];
  let section = rawSection;
  if (sectionFile && resolveAndClassify(sectionFile, { repoRoot }).category === 'sensitive') {
    section = '[REDACTED]';
    redacted = true;
  }

  const categoryResult = redactFreeText(f.category, repoRoot);
  const detailResult = redactFreeText(f.detail, repoRoot);
  if (categoryResult.redacted || detailResult.redacted) redacted = true;

  const evidence = normalizeFindingEvidence(f);
  const { anchor, quote } = resolveEvidenceAnchor(evidence);
  // audit-orchestrator-hardening H2 (hardening-implementation audit round
  // 2): the anchor-file sensitivity check previously only gated
  // `anchorQuote` — for an omission finding, `causalChain` describes the
  // SAME triggering context `anchor` (= `triggerAnchor`) points at, but
  // was built independently, going through `redactFreeText` only, never
  // inheriting the anchor-file-is-sensitive signal. A sensitive trigger
  // anchor now degrades BOTH fields, computed once.
  let anchorIsSensitive = false;
  if (anchor) {
    const anchorFile = anchor.newFile ?? anchor.oldFile ?? null;
    anchorIsSensitive = !!(anchorFile && resolveAndClassify(anchorFile, { repoRoot }).category === 'sensitive');
  }

  let anchorQuote = null;
  if (anchor) {
    if (anchorIsSensitive) {
      redacted = true; // source file itself is sensitive — degrade the quote to null
    } else if (quote) {
      const r = redactFreeText(quote, repoRoot);
      anchorQuote = r.text;
      if (r.redacted) redacted = true;
    }
  }

  let causalChain = null;
  if (evidence.evidenceStatus === 'omission' && evidence.causalChain) {
    if (anchorIsSensitive) {
      redacted = true; // trigger anchor's file is sensitive — degrade the chain to null too
    } else {
      const r = redactFreeText(evidence.causalChain, repoRoot);
      causalChain = r.text;
      if (r.redacted) redacted = true;
    }
  }

  const severity = ['HIGH', 'MEDIUM', 'LOW'].includes(f.severity) ? f.severity : 'LOW';

  // Clamp over-limit string fields to the schema caps BEFORE parsing — a
  // single verbose finding must never `too_big`-throw and crash the whole
  // Stage-1 run (2026-07-22 live shadow failure). Enums/booleans are untouched
  // by the clamp (a clipped enum is corruption), so a genuinely malformed
  // finding still fails loud here, exactly as before.
  const clamped = clampToJsonSchemaLimits({
    category: categoryResult.text,
    detail: detailResult.text,
    section,
    severity,
    evidenceStatus: evidence.evidenceStatus,
    anchorQuote,
    causalChain,
    redacted,
  }, StageOneTriageInputJsonSchema);
  return StageOneTriageInputSchema.parse(clamped);
}

/**
 * Classify one envelope's Stage 1 triage outcome per the severity-gated
 * escalation rule above. Pure — no I/O.
 *
 * Audit fix H2 (round 1): `dismissalAttempted` must be the STRICT boolean
 * `true` to count as an attempt — a malformed adapter response carrying any
 * other truthy value (e.g. a stray string `"no"`, an object) previously fell
 * through the falsy check and was silently trusted as an attempted
 * dismissal. Malformed input degrades to the SAFEST outcome
 * (`confirmed_survivor` — never mechanically dismissed on bad data), never a
 * crash and never a false dismissal.
 *
 * @param {{severity: string, evidenceType?: string}} canonicalFinding
 * @param {{dismissalAttempted: boolean, disproof: string|null}} triagerResponse
 * @returns {{outcome: 'mechanical_dismissed'|'escalated'|'confirmed_survivor', reasonCode: string, hasDeterministicDisproof: boolean}}
 */
function classifyStage1Outcome(canonicalFinding, triagerResponse) {
  if (triagerResponse?.dismissalAttempted !== true) {
    return { outcome: 'confirmed_survivor', reasonCode: 'no_dismissal_attempted', hasDeterministicDisproof: false, disproof: null };
  }
  const hasDisproof = typeof triagerResponse.disproof === 'string' && triagerResponse.disproof.trim().length > 0;
  if (!hasDisproof) {
    return { outcome: 'confirmed_survivor', reasonCode: 'invalid_dismissal_no_disproof', hasDeterministicDisproof: false, disproof: null };
  }
  const isHighOrOmission = String(canonicalFinding.severity || '').toUpperCase() === 'HIGH' || canonicalFinding.evidenceType === 'omission';
  if (isHighOrOmission) {
    return { outcome: 'escalated', reasonCode: 'valid_dismissal_high_or_omission_escalated', hasDeterministicDisproof: true, disproof: triagerResponse.disproof };
  }
  return { outcome: 'mechanical_dismissed', reasonCode: 'valid_dismissal_mechanical', hasDeterministicDisproof: true, disproof: triagerResponse.disproof };
}

/**
 * Write a `stage1_mechanical_dismissed` decision into the ledger via the
 * EXISTING, already-tested `writeStage1MechanicalLedgerEntry` (tiered-recall
 * pipeline Phase 11, Gemini gate fix G2 round 4 — closes a load-bearing gap
 * in already-shipped Phase 8 infrastructure: that function existed and was
 * unit-tested, but no production code path ever called it, so an unsampled
 * mechanical dismissal was silently lost every round). Best-effort: a ledger
 * write failure is logged, never thrown — a missing ledger entry degrades to
 * "this dismissal isn't durably suppressed yet", not a crashed triage pass.
 *
 * Stashes the generated `topicId` onto `envelope.canonicalFinding
 * ._stage1LedgerTopicId` — `ledger.mjs::finalizeLedgerOutcomes` (Stage 2's
 * terminal step) reads that field to know which ledger entry to
 * mark-regressed/confirm-dismissal against.
 *
 * @param {object} envelope
 * @param {string} disproof
 * @param {{ledgerPath?: string|null, round?: number, clock?: () => string}} ledgerOpts
 */
function writeMechanicalDismissalToLedger(envelope, disproof, ledgerOpts) {
  const { ledgerPath, round = 1 } = ledgerOpts || {};
  if (!ledgerPath) return; // opt-in — no ledgerPath means "don't write" (backward-compatible default)
  const f = envelope.canonicalFinding || {};
  const topicId = generateTopicId(f);
  try {
    writeStage1MechanicalLedgerEntry(ledgerPath, {
      topicId,
      semanticHash: f._hash || envelope.fingerprint || topicId,
      severity: f.severity,
      category: f.category,
      section: f.section,
      detailSnapshot: (f.detail || '').slice(0, 300),
      affectedFiles: f.affectedFiles || [f._primaryFile || f.file || ''],
      affectedPrinciples: f.principle ? [f.principle] : [],
      pass: f._pass || f.pass || 'unknown',
      disproof,
      resolvedRound: round,
    });
    f._stage1LedgerTopicId = topicId;
  } catch (err) {
    process.stderr.write(`  [stage1-triage] ledger write failed (non-blocking): ${err.message}\n`);
  }
}

/**
 * Run Stage 1 cheap-model triage over Stage-0 survivors.
 *
 * @param {Array<import('./candidate-envelope.mjs').AuditCandidateEnvelope>} envelopes -
 *   Stage-0 survivors (`stage0_verified`/`stage0_unverifiable`) — this function does not
 *   re-filter by Stage 0 outcome; the caller is responsible for passing only survivors
 *   (mirrors `runStage0EvidenceTriage`'s own scoping discipline).
 * @param {object} adapters
 * @param {(envelope: object) => Promise<{dismissalAttempted: boolean, disproof: string|null}>} adapters.triagerCall -
 *   any parse/API failure MUST be surfaced by throwing (never by returning a
 *   fabricated `{dismissalAttempted: false}`) — this function treats a throw
 *   as `stage1_escalated` per §1.5's failure semantics ("never treated as an
 *   implicit dismissal")
 * @param {() => string} [adapters.clock] - ISO-timestamp clock for `createdAt`
 *   fields (distinct from `ledgerOpts.clock` below, a monotonic elapsed-time
 *   source for the admission guard).
 * @param {{ledgerPath?: string|null, round?: number, repoRoot: string,
 *   admissionBudgetMs?: number|null, candidateWorstCaseMs?: number|(() => number),
 *   clock?: () => number}} ledgerOpts -
 *   tiered-recall pipeline Phase 11 introduced `ledgerPath`/`round` as opt-in
 *   (omitting the whole object preserves the pre-Phase-11 no-ledger-I/O
 *   behavior). `repoRoot` (audit-orchestrator-hardening Phase 8) is now
 *   REQUIRED whenever `ledgerOpts` carries anything — every envelope is
 *   narrowed to a `StageOneTriageInputSchema` DTO via `buildStageOneTriageInput`
 *   before reaching `adapters.triagerCall`, and that builder throws loudly
 *   on a missing `repoRoot` rather than silently defaulting to `process.cwd()`
 *   (the INC-001 symlink-bypass class this repo has already been burned by).
 *   When `ledgerPath` is set, every `mechanical_dismissed` decision is ALSO
 *   written via `writeStage1MechanicalLedgerEntry` at the point the decision
 *   is made (not deferred to a later finalize step).
 *   **Admission guard** (docs/plans/oss-call-reliability-hardening.md, round-3
 *   M1 + Gemini-round-1 G2): `admissionBudgetMs` and `candidateWorstCaseMs` are
 *   BOTH caller-owned — this function never resolves an OSS policy or a
 *   deadline itself, keeping it a fully decoupled, reusable Stage-1 triage
 *   component (a caller using a non-OSS adapter, or with no outer deadline,
 *   simply omits both — the guard never triggers, every envelope is processed
 *   exactly as before this feature existed). `clock` defaults to
 *   `() => performance.now()` (monotonic — immune to NTP/VM wall-clock
 *   adjustments, unlike `Date.now()`); tests inject a fake monotonic counter.
 * @returns {Promise<{mechanicalDismissed: Array<object>, escalated: Array<object>,
 *   confirmedSurvivor: Array<object>, budgetExhausted: Array<object>,
 *   skippedBudgetExhaustedCount: number, failureCategories: Record<string, number>}>}
 *   `budgetExhausted` is a separate bucket, never merged into `escalated` — the
 *   caller must NOT route it into Stage 2 (that would inflate Stage 2's
 *   workload instead of reducing total worst-case time — round-2 H1).
 * @throws {Error} if an internally-constructed Stage1 decision record fails schema
 *   validation (audit fix H2 — a code bug, never expected in normal operation),
 *   or if `buildStageOneTriageInput` is invoked with no `repoRoot` wired.
 */
export async function runStage1CheapTriage(envelopes, adapters, ledgerOpts = null) {
  const mechanicalDismissed = [];
  const escalated = [];
  const confirmedSurvivor = [];
  const budgetExhausted = [];
  const failureCategories = {};
  const repoRoot = ledgerOpts?.repoRoot;

  const admissionBudgetMs = ledgerOpts?.admissionBudgetMs ?? null;
  const candidateWorstCaseMsOpt = ledgerOpts?.candidateWorstCaseMs;
  // Monotonic elapsed-time source (round-3 M3, Gemini-round-1 G1's crash-bug
  // fix applied): an arrow-function wrapper, NEVER the bare `performance.now`
  // method reference — calling it unbound throws `TypeError: Illegal
  // invocation` (performance.now relies on `this` being bound internally).
  const admissionClock = ledgerOpts?.clock ?? (() => performance.now());
  const loopStartMs = admissionBudgetMs != null ? admissionClock() : null;

  for (const envelope of envelopes) {
    // Admission guard (round-1 H1's compromise ruling, round-2/3 fixes): only
    // active when the caller passed a budget. Re-evaluated every iteration —
    // once exhausted, elapsed time only grows, so every remaining envelope
    // is naturally skipped without an explicit early-exit branch.
    if (admissionBudgetMs != null) {
      const worstCaseMs = typeof candidateWorstCaseMsOpt === 'function' ? candidateWorstCaseMsOpt() : candidateWorstCaseMsOpt;
      if ((admissionClock() - loopStartMs) + worstCaseMs > admissionBudgetMs) {
        const skippedDecision = {
          stage: 'stage1', outcome: 'budget_exhausted', reasonCode: 'skipped_budget_exhausted',
          hasDeterministicDisproof: false, createdAt: nowIso(adapters.clock),
        };
        const parsedSkipped = Stage1DecisionSchema.safeParse(skippedDecision);
        if (!parsedSkipped.success) {
          throw new Error(`runStage1CheapTriage: internally-constructed budget-exhausted decision failed schema validation — ${parsedSkipped.error.message.slice(0, 200)}`);
        }
        envelope.stageDecisions.push(parsedSkipped.data);
        budgetExhausted.push(envelope);
        continue;
      }
    }
    // Phase 8: build the minimized, redacted DTO OUTSIDE the main try/catch —
    // a missing/misconfigured repoRoot is a wiring bug and must throw
    // loudly, never silently degrade into "escalate everything" via the
    // catch below. A malformed FINDING (audit-orchestrator-hardening H9),
    // by contrast, is a per-candidate producer bug — caught separately here
    // so it escalates just this one envelope, not the whole run.
    let dto;
    try {
      dto = buildStageOneTriageInput(envelope.canonicalFinding, { repoRoot });
    } catch (err) {
      if (err?.code !== 'MALFORMED_FINDING') throw err;
      const malformedDecision = {
        stage: 'stage1', outcome: 'escalated', reasonCode: 'malformed_finding_input',
        hasDeterministicDisproof: false, createdAt: nowIso(adapters.clock),
      };
      const parsedMalformed = Stage1DecisionSchema.safeParse(malformedDecision);
      if (!parsedMalformed.success) {
        throw new Error(`runStage1CheapTriage: internally-constructed malformed-finding decision failed schema validation — ${parsedMalformed.error.message.slice(0, 200)}`);
      }
      envelope.stageDecisions.push(parsedMalformed.data);
      escalated.push(envelope);
      continue;
    }
    let decision;
    try {
      const response = await adapters.triagerCall(dto);
      decision = classifyStage1Outcome(envelope.canonicalFinding, response);
    } catch (err) {
      // Classification now reaches the schema-validated record (round-3 H1,
      // the concrete fix after two prior rounds only fixed the DISCOVERY
      // path's category propagation): `validatedTriagerCall`/`ossCall` set
      // `err.category` on a classified failure; captured here instead of
      // being dropped.
      decision = {
        outcome: 'escalated', reasonCode: 'stage1_call_failed', hasDeterministicDisproof: false,
        errorMessage: err?.message || String(err), category: err?.category ?? null,
      };
    }

    // audit fix H2 (round 1): this is an INTERNALLY-CONSTRUCTED record — a
    // safeParse failure means OUR OWN code built a malformed decision (a
    // bug), which must surface loudly rather than silently falling back to
    // the unvalidated object (the schema check would otherwise be decorative).
    const stageDecision = {
      stage: 'stage1',
      outcome: decision.outcome,
      reasonCode: decision.reasonCode,
      hasDeterministicDisproof: decision.hasDeterministicDisproof,
      createdAt: nowIso(adapters.clock),
      category: decision.category ?? null,
    };
    const parsed = Stage1DecisionSchema.safeParse(stageDecision);
    if (!parsed.success) {
      throw new Error(`runStage1CheapTriage: internally-constructed Stage1 decision failed schema validation — ${parsed.error.message.slice(0, 200)}`);
    }
    envelope.stageDecisions.push(parsed.data);

    if (decision.outcome === 'mechanical_dismissed') {
      if (ledgerOpts?.ledgerPath) writeMechanicalDismissalToLedger(envelope, decision.disproof, ledgerOpts);
      mechanicalDismissed.push(envelope);
    } else if (decision.outcome === 'escalated') {
      escalated.push(envelope);
      // Aggregate tally of classified failure categories this round (round-3
      // H1) — the persisted answer to "classification remains lost for the
      // live sequential Stage-1 production route".
      if (decision.category) failureCategories[decision.category] = (failureCategories[decision.category] || 0) + 1;
    } else confirmedSurvivor.push(envelope);
  }

  return {
    mechanicalDismissed, escalated, confirmedSurvivor,
    budgetExhausted, skippedBudgetExhaustedCount: budgetExhausted.length, failureCategories,
  };
}
