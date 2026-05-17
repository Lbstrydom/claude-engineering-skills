/**
 * @fileoverview General prompt-context assembly + budget policy.
 * Plan: docs/plans/brainstorm-quickfix-v1.md §10.B, §11.F, §13.C, §14.A;
 *       docs/plans/brainstorm-arch-context.md (arch-context block).
 *
 * Given a prior session, optional --with-context, and optional
 * architecture context, assembles the systemPreface + userPrefix that get
 * prepended to the round-1 prompt. The "resume" name is kept for
 * back-compat — this is the general context-assembly path. Token budget
 * enforced per source; user input never silently truncated
 * (BUDGET_EXCEEDED raised before that happens).
 *
 * @module scripts/lib/brainstorm/resume-context
 */
import { redactSecrets } from '../secret-patterns.mjs';
import { loadSession, summariseRound } from './session-store.mjs';
import {
  estimateTokens,
  getCeilingTokens,
  smallestCeilingTokens,
  RESUME_BUDGET_FRACTION,
  WITH_CONTEXT_FRACTION,
  ARCH_CONTEXT_FRACTION,
} from './provider-limits.mjs';
import {
  ARCH_BLOCK_OPEN,
  ARCH_BLOCK_CLOSE,
  ARCH_BLOCK_PREAMBLE,
} from './arch-context.mjs';

/**
 * Wrap raw architecture text in its XML block and truncate it to fit
 * `budgetTokens`. Budgeting is **wrapper-aware**: the fixed cost of the
 * XML tags + preamble (and the truncation marker, when truncating) is
 * subtracted first so the FINAL serialized block fits the allocation
 * (plan audit R3-H1). XML tags — not ``` fences — survive Markdown
 * fences inside the section (plan audit Gemini-M1).
 *
 * @param {string} rawText - extracted, already-redacted arch section
 * @param {number} budgetTokens - ARCH_CONTEXT_FRACTION allowance
 * @returns {string} the wrapped block, or '' when rawText is empty
 */
function buildArchBlock(rawText, budgetTokens) {
  if (!rawText) return '';
  const head = `${ARCH_BLOCK_OPEN}\n${ARCH_BLOCK_PREAMBLE}\n\n`;
  const tail = `\n${ARCH_BLOCK_CLOSE}`;
  const full = `${head}${rawText}${tail}`;
  if (estimateTokens(full) <= budgetTokens) return full;

  const marker = `\n\n[truncated; original ${rawText.length} chars / ~${estimateTokens(rawText)} tokens > arch allocation]`;
  const fixedTokens = estimateTokens(head) + estimateTokens(tail) + estimateTokens(marker);
  const contentBudgetTokens = Math.max(0, budgetTokens - fixedTokens);
  const contentTokens = estimateTokens(rawText);
  const charsBudget = contentTokens > 0
    ? Math.floor(rawText.length * (contentBudgetTokens / contentTokens))
    : 0;
  return `${head}${rawText.slice(0, charsBudget)}${marker}${tail}`;
}

const VERBATIM_QUOTA = 2;       // §10.B rule 3 — last 2 rounds verbatim
const RESERVED_FOR_R1_PROMPT = 0.4;  // remaining 40% covers round-1 prompt + completion (60% total non-resume)

/**
 * Assemble resume context for `--continue-from <sid>`.
 *
 * @param {object} args
 * @param {string} [args.sid] - prior session id to load (optional)
 * @param {string} [args.withContextText] - assembled --with-context (may be empty)
 * @param {string} [args.archContextText] - raw architecture section (may be empty)
 * @param {Array<{provider: 'openai'|'gemini', model: string}>} args.providers
 * @param {{root?: string}} [args.opts]
 * @returns {{systemPreface: string, userPrefix: string, includedRounds: Array, droppedRounds: Array, withContextEffective: string, archContextEffective: string, archContextTokens: number, estimatedTokens: number, budgetTokens: number, drivenBy: object}}
 * @throws {Error} with code BUDGET_EXCEEDED when total exceeds provider ceiling
 */
export function assembleResumeContext({ sid = null, withContextText = '', archContextText = '', providers, opts = {} }) {
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error('assembleResumeContext: providers array required');
  }

  const { ceilingTokens, drivenBy } = smallestCeilingTokens(providers);
  const resumeBudgetTokens = Math.floor(ceilingTokens * RESUME_BUDGET_FRACTION);
  const withContextBudgetTokens = Math.floor(ceilingTokens * WITH_CONTEXT_FRACTION);
  const archBudgetTokens = Math.floor(ceilingTokens * ARCH_CONTEXT_FRACTION);

  // --- Process architecture context (independent budget) ---
  // Redacted here (same place --with-context is redacted), then wrapped +
  // wrapper-aware-truncated by buildArchBlock. Lives in systemPreface.
  const archRedacted = archContextText ? redactSecrets(archContextText).text : '';
  const archContextEffective = buildArchBlock(archRedacted, archBudgetTokens);

  // --- Process --with-context first (independent budget) ---
  const wcRedacted = withContextText ? redactSecrets(withContextText).text : '';
  const wcTokens = estimateTokens(wcRedacted);
  let withContextEffective = wcRedacted;
  if (wcTokens > withContextBudgetTokens) {
    // Audit Gemini-G3-H2: the truncation marker itself costs tokens.
    // Subtract the marker cost from the slice budget so the FINAL string
    // (slice + marker) fits within the allocation rather than overshooting
    // and tripping BUDGET_EXCEEDED.
    const marker = `\n\n[truncated; original ${wcRedacted.length} chars / ~${wcTokens} tokens > 10% allocation]`;
    const markerTokens = estimateTokens(marker);
    const charsBudgetTokens = Math.max(0, withContextBudgetTokens - markerTokens);
    const charsBudget = Math.floor(wcRedacted.length * (charsBudgetTokens / wcTokens));
    withContextEffective = wcRedacted.slice(0, charsBudget) + marker;
  }

  // --- Process resume (--continue-from) ---
  let includedRounds = [];
  let droppedRounds = [];
  let verbatimSegments = [];
  let summarySegments = [];

  if (sid) {
    const session = loadSession(sid, opts);
    if (!session || session.rounds.length === 0) {
      // Session missing or empty — silent fallthrough; caller logs WARN.
      // Audit R1-H7: return ALL three budget fields with consistent
      // semantics so callers don't have to branch on which is populated.
      return {
        systemPreface: archContextEffective,
        userPrefix: '',
        includedRounds: [],
        droppedRounds: [],
        withContextEffective,
        archContextEffective,
        archContextTokens: estimateTokens(archContextEffective),
        estimatedTokens: estimateTokens(archContextEffective) + estimateTokens(withContextEffective),
        configuredBudgetTokens: resumeBudgetTokens,
        consumedBudgetTokens: estimateTokens(archContextEffective),
        providerCeilingTokens: ceilingTokens,
        budgetTokens: resumeBudgetTokens,  // back-compat alias = configured budget
        drivenBy,
      };
    }
    const rounds = session.rounds;  // chronological
    const verbatimCandidates = rounds.slice(-VERBATIM_QUOTA);   // last N
    const summaryCandidates  = rounds.slice(0, -VERBATIM_QUOTA); // older

    // Build verbatim block, oldest of the verbatim first
    let runningTokens = 0;
    for (const r of verbatimCandidates) {
      const segment = `[round ${r.round} — verbatim]\n${r.providers.map(p => `${p.provider}[${p.state}]: ${p.text || ''}`).join('\n\n')}`;
      const segTokens = estimateTokens(segment);
      if (runningTokens + segTokens <= resumeBudgetTokens) {
        verbatimSegments.push(segment);
        includedRounds.push({ round: r.round, treatment: 'verbatim' });
        runningTokens += segTokens;
      } else {
        // Demote to summary
        const summarised = summariseRound(r);
        const sumTokens = estimateTokens(summarised);
        if (runningTokens + sumTokens <= resumeBudgetTokens) {
          summarySegments.unshift(summarised);
          includedRounds.push({ round: r.round, treatment: 'summarised-from-verbatim' });
          runningTokens += sumTokens;
        } else {
          droppedRounds.push({ round: r.round, reason: 'budget' });
        }
      }
    }

    // Add summaries (oldest first; iterate newest of summary candidates back)
    for (let i = summaryCandidates.length - 1; i >= 0; i--) {
      const r = summaryCandidates[i];
      const summarised = summariseRound(r);
      const sumTokens = estimateTokens(summarised);
      if (runningTokens + sumTokens <= resumeBudgetTokens) {
        summarySegments.unshift(summarised);
        includedRounds.push({ round: r.round, treatment: 'summarised' });
        runningTokens += sumTokens;
      } else {
        droppedRounds.push({ round: r.round, reason: 'budget' });
      }
    }
  }

  // --- Compose preface + prefix ---
  const summaryBlock = summarySegments.length > 0
    ? `Earlier rounds (summarised):\n${summarySegments.join('\n\n')}\n`
    : '';
  const verbatimBlock = verbatimSegments.length > 0
    ? `\nLast ${verbatimSegments.length} round(s) verbatim:\n${verbatimSegments.join('\n\n')}\n`
    : '';
  const resumePreface = (summaryBlock || verbatimBlock)
    ? `Conversation so far:\n${summaryBlock}${verbatimBlock}`
    : '';
  // systemPreface order: arch block FIRST (stable → cache-friendly prefix),
  // then resume blocks. buildDebatePrompt reuses systemPreface verbatim, so
  // the debate round inherits the arch block for free (plan §2 / Gemini-H2).
  const systemPreface = archContextEffective
    ? (resumePreface ? `${archContextEffective}\n\n${resumePreface}` : archContextEffective)
    : resumePreface;
  const userPrefix = '';  // resume content lives in systemPreface; userPrefix is for future use

  // --- Audit R1-H8: budget enforcement on FINAL serialised output ---
  // Measure the exact strings we're about to return (preface + prefix +
  // with-context), not pre-truncation estimates. Wrappers/markers added
  // by truncation logic are now counted.
  const finalSystemPrefaceTokens = estimateTokens(systemPreface);
  const finalUserPrefixTokens = estimateTokens(userPrefix);
  const finalWithContextTokens = estimateTokens(withContextEffective);
  const totalEstimatedTokens = finalSystemPrefaceTokens + finalUserPrefixTokens + finalWithContextTokens;

  // Hard ceiling: assembled context must not exceed (resume + with-context) fractions.
  // No 5% fudge — that hid real overruns. If we got here over-budget, our truncation
  // logic above failed; abort cleanly so the caller sees BUDGET_EXCEEDED instead of
  // silently sending a too-large prompt.
  const totalAllowedTokens = Math.floor(ceilingTokens * (RESUME_BUDGET_FRACTION + WITH_CONTEXT_FRACTION + ARCH_CONTEXT_FRACTION));
  if (totalEstimatedTokens > totalAllowedTokens) {
    const err = new Error(`assembled context (${totalEstimatedTokens} tokens, post-construction) exceeds combined budget (${totalAllowedTokens} tokens) for provider ${drivenBy.provider}/${drivenBy.model}`);
    err.code = 'BUDGET_EXCEEDED';
    err.estimatedTokens = totalEstimatedTokens;
    err.budgetTokens = totalAllowedTokens;
    throw err;
  }

  return {
    systemPreface,
    userPrefix,
    includedRounds,
    droppedRounds,
    withContextEffective,
    archContextEffective,
    archContextTokens: estimateTokens(archContextEffective),
    estimatedTokens: totalEstimatedTokens,
    // R1-H7: distinct named fields with consistent semantics in EVERY branch
    configuredBudgetTokens: resumeBudgetTokens,
    consumedBudgetTokens: finalSystemPrefaceTokens + finalUserPrefixTokens,
    providerCeilingTokens: ceilingTokens,
    budgetTokens: resumeBudgetTokens,  // back-compat alias = configured budget
    drivenBy,
  };
}
