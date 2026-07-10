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

import { Stage1DecisionSchema, StageOneTriageInputSchema, normalizeFindingEvidence } from '../schemas.mjs';
import { generateTopicId, writeStage1MechanicalLedgerEntry } from '../ledger.mjs';
import { resolveAndClassify, classifyPath } from '../sensitive-paths.mjs';
import { redact } from '../redact.mjs';

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
const EDGE_PUNCT = /^[.,:;!?]+|[.,:;!?]+$/g;

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
 * @param {string|null|undefined} text
 * @returns {{text: string, redacted: boolean}}
 */
function redactFreeText(text) {
  if (text == null) return { text: '', redacted: false };
  const raw = String(text);
  let scanned = raw;
  let anyRedacted = false;
  const rawTokens = raw.split(SPLIT_BOUNDARY).filter(Boolean);
  for (const rawToken of rawTokens) {
    const trimmed = rawToken.replace(EDGE_PUNCT, '');
    if (!trimmed) continue;
    if (classifyPath(trimmed) === 'sensitive') {
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

  const categoryResult = redactFreeText(f.category);
  const detailResult = redactFreeText(f.detail);
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
      const r = redactFreeText(quote);
      anchorQuote = r.text;
      if (r.redacted) redacted = true;
    }
  }

  let causalChain = null;
  if (evidence.evidenceStatus === 'omission' && evidence.causalChain) {
    if (anchorIsSensitive) {
      redacted = true; // trigger anchor's file is sensitive — degrade the chain to null too
    } else {
      const r = redactFreeText(evidence.causalChain);
      causalChain = r.text;
      if (r.redacted) redacted = true;
    }
  }

  const severity = ['HIGH', 'MEDIUM', 'LOW'].includes(f.severity) ? f.severity : 'LOW';

  return StageOneTriageInputSchema.parse({
    category: categoryResult.text,
    detail: detailResult.text,
    section,
    severity,
    evidenceStatus: evidence.evidenceStatus,
    anchorQuote,
    causalChain,
    redacted,
  });
}

/**
 * Real clock by default (matches `evidence-triage.mjs`'s `nowIso` — a
 * production caller that forgets a clock adapter gets the real clock, never
 * an obviously-wrong epoch sentinel). Tests inject a fixed `adapters.clock`.
 */
function nowIso(clock) {
  return typeof clock === 'function' ? clock() : new Date().toISOString();
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
 * @param {() => string} [adapters.clock]
 * @param {{ledgerPath?: string|null, round?: number, repoRoot: string}} ledgerOpts -
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
 * @returns {Promise<{mechanicalDismissed: Array<object>, escalated: Array<object>, confirmedSurvivor: Array<object>}>}
 * @throws {Error} if an internally-constructed Stage1 decision record fails schema
 *   validation (audit fix H2 — a code bug, never expected in normal operation),
 *   or if `buildStageOneTriageInput` is invoked with no `repoRoot` wired.
 */
export async function runStage1CheapTriage(envelopes, adapters, ledgerOpts = null) {
  const mechanicalDismissed = [];
  const escalated = [];
  const confirmedSurvivor = [];
  const repoRoot = ledgerOpts?.repoRoot;

  for (const envelope of envelopes) {
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
      decision = { outcome: 'escalated', reasonCode: 'stage1_call_failed', hasDeterministicDisproof: false, errorMessage: err?.message || String(err) };
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
    };
    const parsed = Stage1DecisionSchema.safeParse(stageDecision);
    if (!parsed.success) {
      throw new Error(`runStage1CheapTriage: internally-constructed Stage1 decision failed schema validation — ${parsed.error.message.slice(0, 200)}`);
    }
    envelope.stageDecisions.push(parsed.data);

    if (decision.outcome === 'mechanical_dismissed') {
      if (ledgerOpts?.ledgerPath) writeMechanicalDismissalToLedger(envelope, decision.disproof, ledgerOpts);
      mechanicalDismissed.push(envelope);
    } else if (decision.outcome === 'escalated') escalated.push(envelope);
    else confirmedSurvivor.push(envelope);
  }

  return { mechanicalDismissed, escalated, confirmedSurvivor };
}
