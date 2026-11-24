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
 * **On the Azure work profile the same-family gate is the design, not a
 * fallback (field report 5, 2026-11-23).** Work tenants have no Gemini, so
 * `selectProvider` picks `azure-claude` by policy whatever keys are present:
 * the GPT audit passes are the cross-vendor view, and only the final gate shares
 * a family with a Claude author. The plain weaker-check sentence was true but left
 * that out, and a consumer agent read it as "no Gemini key, routing broken". So
 * `azure-claude` gets the pairing sentence; public `claude-opus` (a real
 * fallback for a missing Gemini key) keeps the plain one.
 *
 * @module scripts/lib/final-review/gate-label
 */
import { modelFamily } from '../model-resolver.mjs';

/** Provider → vendor family, for providers whose model id may be a bare deployment name. */
const PROVIDER_FAMILY = Object.freeze({ gemini: 'google', 'claude-opus': 'anthropic', 'azure-claude': 'anthropic' });

export const WEAKER_CHECK_SENTENCE = 'same model family as the author — a weaker independent check than a cross-vendor reviewer';

/** The Azure work profile's designed pairing: says where the cross-vendor view comes from. No key, no fallback. */
export const AZURE_PAIRING_SENTENCE = "the Azure work profile's designed pairing: the GPT audit passes are the cross-vendor view, "
  + 'and only this final gate shares a model family with a Claude author';

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
    if (sameFamilyAsAuthor) {
      independenceNote = provider === 'azure-claude'
        ? `${AZURE_PAIRING_SENTENCE} (author ${authorModel})`
        : `${WEAKER_CHECK_SENTENCE} (author ${authorModel})`;
    }
  } else if (provider === 'azure-claude') {
    independenceNote = authorModel ? `${AZURE_PAIRING_SENTENCE} (author model "${authorModel}" unclassified)` : AZURE_PAIRING_SENTENCE;
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
