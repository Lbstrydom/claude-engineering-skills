/**
 * @fileoverview Canonical dashboard anchor ids — the SINGLE source of truth
 * for cross-tab link targets, so the writer (sections/architecture.mjs, which
 * stamps the element id) and the reader (collect-purposes.mjs, which builds the
 * `href`) can never drift. A plain pure helper module — importing it does NOT
 * violate the section import-direction contract (it is neither render.mjs nor
 * helpers.mjs).
 *
 * Plan: docs/plans/dashboard-purpose-view.md (cross-link contract).
 *
 * @module scripts/lib/dashboard/anchors
 */

/** Element id for a domain's box in the Architecture tab. */
export function archDomainElementId(domainName) {
  return `arch-domain-${domainName}`;
}

/**
 * Element id of a purpose's title in the Purpose tab — the same id
 * sections/purpose.mjs stamps as the `<section aria-labelledby>` target. Used
 * as the reverse cross-link target (Architecture "serves:" chip → Purpose).
 */
export function purposeTitleElementId(purposeId) {
  return `purpose-${purposeId}-title`;
}
