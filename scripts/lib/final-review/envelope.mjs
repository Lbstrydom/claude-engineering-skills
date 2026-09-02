/**
 * @fileoverview Final-review envelope assembly + budget. Pure: no fs, no env,
 * no I/O — code reading is injected as `renderCode`, so the whole truncation
 * algorithm is unit-testable against a fake renderer.
 *
 * Plan: docs/plans/final-review-scoped-second-reviewer.md §2, KD-2.
 *
 * TWO CONTRACTS LIVE HERE, and they are different in kind:
 *
 * 1. `full` is BYTE-IDENTICAL to the literal this was extracted from
 *    (gemini-review.mjs:1212-1238 @ 611e5be6). It is the bridge to the
 *    historical baseline — 38 recorded shadow runs — so a stray space here
 *    silently invalidates comparability rather than failing loudly. Guarded by
 *    a byte-identity test with a negative control.
 *
 * 2. `thin`/`gap` are BOUNDED. Capping only code files does not bound an
 *    envelope whose plan and transcript are both unbounded.
 *
 * @module scripts/lib/final-review/envelope
 */

/**
 * Total ceiling for reduced envelopes, in CHARACTERS.
 *
 * WHY CHARACTERS AND NOT TOKENS: the envelope is built ONCE and sent to four
 * different tokenizers, so there is no single true token count to budget
 * against. Characters are exact, provider-independent and deterministic.
 *
 * DERIVATION — `derived`, not `measured`, and it does NOT guarantee a Grok
 * tier. Measured (.audit/audit-code-1786613231-gemini-stderr.log): a prompt
 * estimated at ~53,106 tokens (= 212,424 chars, since the estimator is
 * `length/4`) tokenized by CLAUDE at 96,329 ⇒ 2.205 chars/token, a 1.81x
 * under-read. At 2.2 chars/token, 340,000 chars ⇒ ~154,500 tokens.
 *
 * That is a CLAUDE observation compared against GROK's 200K billing boundary,
 * which is not a worst case — stated plainly because the plan audit caught this
 * document asserting a bound it had not established. What the constant honestly
 * buys is a deterministic ceiling very likely inside tier 1. Crossing it is a
 * COST fact, not a correctness fault: the pricing layer prices both tiers, so a
 * >200K call bills correctly rather than being mis-priced or discarded.
 *
 * GAP CLOSED, 2026-08-14 — the Grok reasoning-effort pre-flight
 * (`docs/research/grok-effort-preflight-2026q3.json`) sent this exact fixture
 * shape and its `prompt_tokens` gives Grok's REAL ratio: 197,405 chars ÷
 * 47,655 tokens = **4.14 chars/token** — far ABOVE the 2.2 assumed above, i.e.
 * Grok's tokenizer is markedly more efficient than Claude's on this content.
 * 340,000 chars at 4.14 ⇒ ~82,100 Grok tokens, well inside tier 1 with wide
 * margin. Confirming evidence, not a correction: the Claude-derived ceiling
 * was conservative in the safe direction for Grok specifically.
 */
export const THIN_ENVELOPE_MAX_CHARS = 340_000;

/** Code-file budget for reduced scopes (vs 100_000 on the `full` path). */
export const THIN_CODE_MAX_CHARS = 30_000;
export const THIN_CODE_MAX_PER_FILE = 8_000;

export const NO_IN_SCOPE_CODE_MARKER =
  '(No in-scope code files — review the plan and transcript only)';

/** Headroom when re-rendering the gap block at a smaller budget (its header is fixed cost). */
const GAP_TRIM_SLACK = 512;
/** Bounded halving attempts, so a renderGap that cannot shrink cannot spin. */
const GAP_TRIM_STEPS = 6;

/** Thrown when the mandatory minimum cannot fit. Never a silent squeeze. */
export class EnvelopeBudgetError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'EnvelopeBudgetError';
    this.code = 'ENVELOPE_MANDATORY_MINIMUM_EXCEEDED';
    this.detail = detail;
  }
}

/**
 * Render the transcript exactly as the original literal did.
 * A raw (non-JSON) transcript is passed through; anything else is pretty-printed.
 */
function renderTranscript(transcript) {
  return typeof transcript === 'object' && transcript.raw
    ? transcript.raw
    : JSON.stringify(transcript, null, 2);
}

/**
 * Assemble the envelope string from already-rendered blocks.
 *
 * THIS IS THE BYTE-IDENTITY SURFACE. The array below is a verbatim transcription
 * of the extracted literal, with exactly one addition: `gapBlock`, which is
 * empty on every path except `gap` and therefore removed by `.filter(Boolean)` —
 * so `full` and `thin` produce the same bytes they would have without it.
 */
export function assembleEnvelope({
  projectContext,
  planContent,
  repoContextBlock = '',
  scopeBlock = '',
  transcript,
  debtBlock = '',
  codeContext = '',
  gapBlock = '',
}) {
  return [
    '## Project Context',
    projectContext,
    '',
    '---',
    '',
    '## Plan',
    planContent,
    '',
    '---',
    '',
    repoContextBlock,
    repoContextBlock ? '---' : '',
    scopeBlock,
    scopeBlock ? '---' : '',
    '## Audit Transcript (Claude-GPT Deliberation)',
    renderTranscript(transcript),
    '',
    '---',
    '',
    gapBlock,
    gapBlock ? '---' : '',
    debtBlock,
    debtBlock ? '---' : '',
    '## Code Files',
    codeContext || '(No code files found — review based on transcript only)',
  ].filter(Boolean).join('\n');
}

/** Peel the oldest round off a transcript, returning a NEW object (never mutating). */
function dropOldestRound(transcript) {
  if (!transcript || typeof transcript !== 'object') return null;
  if (!Array.isArray(transcript.rounds) || transcript.rounds.length <= 1) return null;
  return { ...transcript, rounds: transcript.rounds.slice(1) };
}

/**
 * Normalise an injected `renderCode` result.
 *
 * The reader may return a plain string (historical contract, still honoured by
 * every test fake) or `{text, stats}` where `stats` is a
 * `readFilesAsContextDetailed` record. A string carries NO measurement, so it
 * normalises to `stats: null` — which `codeRenderTruncation` below renders as
 * `unmeasured`, never as "nothing was truncated". That distinction is the whole
 * point: the previous `truncated: {}` literal on the `full` path was an
 * unmeasured value wearing a measurement's clothes (AGENTS.md — a hardcoded 0
 * in telemetry reads as a measurement).
 */
function callRenderCode(renderCode, paths) {
  const out = renderCode(paths);
  if (out && typeof out === 'object' && typeof out.text === 'string') {
    return { text: out.text, stats: out.stats ?? null };
  }
  return { text: typeof out === 'string' ? out : '', stats: null };
}

/**
 * Project a code-render record into the envelope's `truncated` vocabulary.
 * Returns `{code: 'unmeasured'}` when the reader reported nothing.
 */
export function codeRenderTruncation(stats) {
  if (!stats) return { code: 'unmeasured' };
  return {
    codeFilesHeadCut: stats.headTruncated.length,
    codeFilesBudgetOmitted: stats.budgetOmitted.length,
    codeFilesUnreadable: stats.unreadable.length,
    codeFilesSensitiveExcluded: stats.sensitiveExcluded.length,
    codeCharsDropped: Math.max(0, stats.charsOnDisk - stats.charsRendered),
  };
}

/**
 * Build the final-review envelope.
 *
 * @param {object} input
 * @param {string} input.scope - 'full' | 'thin' | 'gap'
 * @param {string[]} [input.codePaths] - paths to render into the Code Files block
 * @param {(paths:string[])=>string} [input.renderCode] - injected reader (keeps this module pure)
 * @param {number} [input.maxChars]
 * @returns {{userPrompt: string, accounting: object}}
 */
export function buildReviewEnvelope(input) {
  const {
    scope = 'full',
    projectContext,
    planContent,
    repoContextBlock = '',
    scopeBlock = '',
    transcript,
    debtBlock = '',
    gapBlock = '',
    /**
     * Injected re-renderer for the gap block at a smaller budget (truncation
     * step 3). `(maxChars) => {block, omitted}`. Optional — absent means the
     * gap block is treated as fixed and step 3 is a no-op.
     */
    renderGap = null,
    codePaths = [],
    renderCode = () => '',
    maxChars = THIN_ENVELOPE_MAX_CHARS,
  } = input;

  // ── full: no budget, byte-identical, one code render. ──────────────────────
  if (scope === 'full') {
    const rendered = callRenderCode(renderCode, codePaths);
    const userPrompt = assembleEnvelope({
      projectContext, planContent, repoContextBlock, scopeBlock,
      transcript, debtBlock, codeContext: rendered.text, gapBlock: '',
    });
    // `budgeted: false` is still true — this branch applies no ENVELOPE budget.
    // But the injected reader applies its own per-file and total caps, and for
    // its whole life this returned `truncated: {}` regardless: an APPROVE could
    // be issued over code that was head-cut before the reviewer ever saw it,
    // with the telemetry reporting a clean render. Measured now.
    return {
      userPrompt,
      accounting: {
        scope,
        chars: userPrompt.length,
        budgeted: false,
        truncated: codeRenderTruncation(rendered.stats),
        codeRender: rendered.stats,
        codeFilesIncluded: codePaths.length,
      },
    };
  }

  // ── thin / gap: bounded. ───────────────────────────────────────────────────
  // Reduced scopes never carry repo context (dropped by definition, not by
  // truncation) — the caller passes '' but we enforce it so a caller cannot
  // reintroduce ~32KB by accident.
  let repo = '';
  let debt = debtBlock;
  let tx = transcript;
  // The gap block belongs to `gap` ALONE. Keyed on the scope rather than on
  // "was a gapBlock passed?", so a caller that supplies one for a blind scope
  // cannot accidentally un-blind it — blindness must be enforced by what the
  // envelope contains, not by every caller remembering not to pass it.
  let gap = scope === 'gap' ? gapBlock : '';
  let paths = [...codePaths];

  const truncated = { debtRows: 0, transcriptRounds: 0, gapFindings: 0, codeFiles: 0 };
  // The reduced path re-renders on every truncation step, so the record that
  // reaches `accounting` must be the LAST one — the render that actually
  // produced the returned envelope, not an earlier discarded attempt.
  let lastCodeStats = null;
  const render = () => {
    let codeContext = NO_IN_SCOPE_CODE_MARKER;
    lastCodeStats = null;
    if (paths.length) {
      const rendered = callRenderCode(renderCode, paths);
      codeContext = rendered.text;
      lastCodeStats = rendered.stats;
    }
    return assembleEnvelope({
      projectContext, planContent, repoContextBlock: repo, scopeBlock,
      transcript: tx, debtBlock: debt, codeContext,
      gapBlock: gap,
    });
  };

  let out = render();
  if (out.length <= maxChars) {
    return { userPrompt: out, accounting: accountingFor(scope, out, truncated, paths, gap, lastCodeStats) };
  }

  // Step 1 — debt block. Lowest value, already bounded at 50 rows.
  if (debt) {
    truncated.debtRows = 1;
    debt = '';
    out = render();
    if (out.length <= maxChars) return { userPrompt: out, accounting: accountingFor(scope, out, truncated, paths, gap, lastCodeStats) };
  }

  // Step 2 — transcript, oldest rounds first. NEVER the last round.
  //
  // ORDER IS LOAD-BEARING: transcript BEFORE code files. An intermediate draft
  // had code files at step 2, which — because each step runs to completion —
  // mathematically guaranteed that EVERY in-scope code file was dropped before
  // a single stale round was touched. An envelope that fits by discarding all
  // the code while retaining historical deliberation is exactly inverted:
  // in-scope diff code is the highest-value content in a reduced envelope, and
  // cutting to it is the entire premise of the mode. Bounded ground truth must
  // outlive unbounded history. (Caught by the Gemini gate, R1.)
  for (;;) {
    const next = dropOldestRound(tx);
    if (!next) break;
    tx = next;
    truncated.transcriptRounds++;
    out = render();
    if (out.length <= maxChars) return { userPrompt: out, accounting: accountingFor(scope, out, truncated, paths, gap, lastCodeStats) };
  }

  // Step 3 — gap findings, lowest severity first. The projection already
  // ordered severity-descending, so shrinking its budget trims from the tail
  // and drops LOW before HIGH. The mandatory minimum keeps one finding when the
  // primary reported any, which is what stops `gap` silently degrading into a
  // more expensive `thin`.
  //
  // Implemented by RE-RENDERING at a smaller budget rather than string-slicing
  // the block: the projection owns its own field caps, ordering and omission
  // marker, and slicing its output here would defeat all three. `renderGap` is
  // injected so this module stays pure.
  if (gap && typeof renderGap === 'function') {
    const overBy = out.length - maxChars;
    let gapBudget = Math.max(0, gap.length - overBy - GAP_TRIM_SLACK);
    for (let i = 0; i < GAP_TRIM_STEPS && gapBudget > 0; i++) {
      const next = renderGap(gapBudget);
      if (!next || next.block === gap) break;
      gap = next.block;
      out = render();
      if (out.length <= maxChars) {
        truncated.gapFindings = next.omitted ?? 0;
        return { userPrompt: out, accounting: accountingFor(scope, out, truncated, paths, gap, lastCodeStats) };
      }
      gapBudget = Math.floor(gapBudget / 2);
    }
    truncated.gapFindings = 'trimmed';
  }

  // Step 4 — code files, dropped from the end of diff order.
  while (paths.length > 0) {
    paths = paths.slice(0, -1);
    truncated.codeFiles++;
    out = render();
    if (out.length <= maxChars) return { userPrompt: out, accounting: accountingFor(scope, out, truncated, paths, gap, lastCodeStats) };
  }

  // Step 5 — the plan is never truncated. If we are here, the mandatory minimum
  // (project context + plan + newest transcript round [+ one gap finding]) does
  // not fit. Fail BEFORE the call: a reviewer handed an envelope missing its
  // specification is worse than no reviewer, and a paid call that cannot answer
  // is pure loss.
  throw new EnvelopeBudgetError(
    `[final-review] mandatory minimum exceeds the ${maxChars}-char envelope ceiling `
    + `(${out.length} chars after dropping debt, ${truncated.transcriptRounds} transcript round(s) `
    + `and ${truncated.codeFiles} code file(s)). The plan and the newest transcript round cannot be cut.`,
    { scope, chars: out.length, maxChars, truncated },
  );
}

function accountingFor(scope, out, truncated, paths, gapBlock, codeStats = null) {
  return {
    scope,
    chars: out.length,
    budgeted: true,
    // Envelope-level drops (this module) MERGED with render-level drops (the
    // injected reader). `codeFiles` counts files this module removed from the
    // list; the `code*` keys count what the reader dropped from the files it
    // was still given. Both are truncation, and reporting only the first is how
    // a fully head-cut render read as clean.
    truncated: { ...truncated, ...codeRenderTruncation(codeStats) },
    codeRender: codeStats,
    codeFilesIncluded: paths.length,
    gapBlockChars: gapBlock ? gapBlock.length : 0,
  };
}
