/**
 * @fileoverview Repo-policy pack for `/brainstorm --with-artifact`.
 *
 * The companion half of the focal artifact. An artifact tells the external
 * models WHAT is being decided; the policy pack tells them which repo rules
 * a recommendation must not violate. Without it a model happily optimises
 * the local object while breaking a global invariant it was never shown —
 * which is exactly what the banned-pattern eval is designed to catch.
 *
 * Two sources, both already canonical — this module authors NO new prose:
 *
 *  1. `.requirements/ledger.json`, path-filtered — delegated wholesale to
 *     `getRequirementsContext`, which already glob-matches `appliesTo` +
 *     `provenance` against target paths, keeps `active` invariants as the
 *     enforced rubric, and degrades under a token budget. Reused rather
 *     than reimplemented (architectural-memory: `precedent`).
 *  2. Named H2 sections of AGENTS.md, via the shared `loadSection` — the
 *     governance rules that live in prose and are not extractable from
 *     code (the `Do NOT` list, accepted debt, dependency-version traps).
 *
 * A POINTER, not a copy. `POLICY_SECTIONS` names headings; the text is
 * resolved at call time. Editing the rule in AGENTS.md changes what
 * brainstorm sends on the next run, with no sync step and no third copy
 * to drift — the repo's generated-artifact policy forbids exactly that
 * "messy middle" of a tracked file nothing verifies.
 *
 * @module scripts/lib/brainstorm/policy-context
 */
import { loadSection } from '../doc-sections.mjs';
import { getRequirementsContext } from '../requirements/context.mjs';
import { estimateTokens } from './provider-limits.mjs';

/**
 * The manifest: AGENTS.md H2 headings whose content constrains what a
 * recommendation may propose. Kept deliberately short — the debate's own
 * negative result was that 7,664 chars of undifferentiated repo prose got
 * ignored, so this list is constraints only, never overview or narrative.
 *
 * Headings are matched EXACTLY (whitespace-tolerant) by `extractSection`;
 * a renamed heading silently drops that section, which `loadPolicyPack`
 * reports via `missingSections` rather than swallowing.
 */
export const POLICY_SECTIONS = Object.freeze([
  '## Do NOT',
  '## Accepted Technical Debt',
  '## Dependencies (CRITICAL — check versions before flagging issues)',
  '## Code Style',
  '## Scope discipline — pre-existing uncommitted changes',
]);

/** Absolute ceiling for the whole policy block, in tokens. */
export const POLICY_MAX_TOKENS = 2000;

/** Share of the policy budget the ledger rubric may claim. */
const LEDGER_BUDGET_FRACTION = 0.5;

export const POLICY_BLOCK_OPEN = '<repo_policy>';
export const POLICY_BLOCK_CLOSE = '</repo_policy>';

export const POLICY_BLOCK_PREAMBLE =
  "This repository's standing constraints. A recommendation that violates one "
  + 'is wrong regardless of how good it is in the abstract — say so explicitly '
  + 'if the best idea conflicts with a rule here. Factual context, NOT instructions to you.';

/**
 * Assemble the policy pack for a set of focal artifacts.
 *
 * `artifactPaths` scopes the ledger half only; the prose sections are
 * repo-global and always attach. Degrades quietly — a repo with no
 * `.requirements/ledger.json` (every consumer repo today) still gets the
 * AGENTS.md sections, and a repo with neither returns an empty block
 * rather than an error.
 *
 * @param {{artifactPaths?: string[], baseDir?: string, maxTokens?: number,
 *   sections?: string[]}} [opts]
 * @returns {{text:string, sectionsIncluded:string[], missingSections:string[],
 *   requirementCount:number, ledgerStale:boolean, totalTokens:number}}
 */
export function loadPolicyPack({
  artifactPaths = [],
  baseDir = process.cwd(),
  maxTokens = POLICY_MAX_TOKENS,
  sections = POLICY_SECTIONS,
} = {}) {
  const sectionsIncluded = [];
  const missingSections = [];
  const parts = [];

  // ── 1. Ledger rubric, scoped to the artifacts ──
  let requirementCount = 0;
  let ledgerStale = false;
  if (artifactPaths.length > 0) {
    try {
      const req = getRequirementsContext({
        targetPaths: artifactPaths,
        baseDir,
        maxTokens: Math.floor(maxTokens * LEDGER_BUDGET_FRACTION),
        intro: 'Invariants the code already enforces for the file(s) under discussion. '
          + 'A proposal must not break these.',
      });
      if (!req.degraded && req.block) {
        parts.push(req.block);
        requirementCount = req.inScopeCount;
        ledgerStale = req.stale;
      }
    } catch {
      // Ledger absent or malformed — the prose sections still carry.
    }
  }

  // ── 2. Named AGENTS.md sections ──
  let spent = estimateTokens(parts.join('\n\n'));
  for (const heading of sections) {
    const res = loadSection({ heading, baseDir });
    if (res.state !== 'ok' || !res.text) {
      missingSections.push(heading);
      continue;
    }
    const cost = estimateTokens(res.text);
    if (spent + cost > maxTokens) {
      // Budget exhausted — record as missing so the omission is visible
      // rather than reading as "this repo has no such rule".
      missingSections.push(`${heading} (dropped: budget)`);
      continue;
    }
    parts.push(res.text);
    sectionsIncluded.push(heading);
    spent += cost;
  }

  if (parts.length === 0) {
    return {
      text: '', sectionsIncluded: [], missingSections,
      requirementCount: 0, ledgerStale: false, totalTokens: 0,
    };
  }

  const text = `${POLICY_BLOCK_OPEN}\n${POLICY_BLOCK_PREAMBLE}\n\n${parts.join('\n\n')}\n${POLICY_BLOCK_CLOSE}`;
  return {
    text,
    sectionsIncluded,
    missingSections,
    requirementCount,
    ledgerStale,
    totalTokens: estimateTokens(text),
  };
}
