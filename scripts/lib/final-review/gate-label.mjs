/**
 * @fileoverview Name the final gate by ROLE and the provider that actually ran.
 *
 * **The report (work consumer on the Azure profile, 2026-11-15).** The final
 * gate's artefacts are `*-gemini-result.json` and chips reported "Gemini
 * approved" while every result file recorded `_provider: azure-claude` — the
 * reviewer was Claude Opus on Foundry. The filename stays (every reader keys on
 * it: the skills, `debt-auto-capture`, the retention sweep, consumers' own
 * scripts), so the fix is the WORDING: every surface a human reads names the
 * gate as `final gate (<provider> / <model>)`, from the resolved provider.
 *
 * **Independence is stated, not assumed.** A reviewer from the authoring model's
 * own family is still a separate view (no conversation history, its own prompt)
 * but a weaker independent check than a cross-vendor one — `/brainstorm` already
 * says so for its Azure voice. The author model is read from
 * `AUDIT_AUTHOR_TIER_HINT`, which is observation-only and is used here only for
 * a disclosure sentence, never to route. Undeclared author + an Anthropic
 * reviewer is the common Claude Code case, so it is disclosed as `null`
 * (unmeasured) with the same plain sentence, never as "independent".
 *
 * @module scripts/lib/final-review/gate-label
 */
import { modelFamily } from '../model-resolver.mjs';

/** Provider → vendor family, for providers whose model id may be a bare deployment name. */
const PROVIDER_FAMILY = Object.freeze({ gemini: 'google', 'claude-opus': 'anthropic', 'azure-claude': 'anthropic' });

export const WEAKER_CHECK_SENTENCE = 'same model family as the author — a weaker independent check than a cross-vendor reviewer';

/**
 * @param {{provider: string, model: string|null, authorModel?: string|null}} input
 * @returns {{label: string, provider: string, model: string|null, reviewerFamily: string|null,
 *   authorFamily: string|null, sameFamilyAsAuthor: boolean|null, independenceNote: string|null}}
 */
export function describeFinalGate({ provider, model, authorModel = null }) {
  const reviewerFamily = PROVIDER_FAMILY[provider] ?? modelFamily(model);
  const authorFamily = authorModel ? modelFamily(authorModel) : null;
  let sameFamilyAsAuthor = null;
  let independenceNote = null;
  if (authorFamily && reviewerFamily) {
    sameFamilyAsAuthor = authorFamily === reviewerFamily;
    if (sameFamilyAsAuthor) independenceNote = `${WEAKER_CHECK_SENTENCE} (author ${authorModel})`;
  } else if (reviewerFamily === 'anthropic') {
    const why = authorModel ? `author model "${authorModel}" unclassified` : 'author model undeclared (AUDIT_AUTHOR_TIER_HINT unset)';
    independenceNote = `${why}; if Claude authored this change, the reviewer is the ${WEAKER_CHECK_SENTENCE}`;
  }
  return {
    label: `final gate (${provider} / ${model ?? 'unresolved'})`,
    provider, model: model ?? null, reviewerFamily: reviewerFamily ?? null, authorFamily,
    sameFamilyAsAuthor, independenceNote,
  };
}
