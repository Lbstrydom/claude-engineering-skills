/**
 * @fileoverview Purpose tab — the outcome/requirement view. Renders the
 * curated purpose taxonomy as labelled collapsible regions, each showing the
 * domains that deliver it (chips that cross-link to the Architecture tab) and
 * the typed requirements that constrain it (grouped by kind), plus a hygiene
 * region surfacing curation gaps.
 *
 * Plan: docs/plans/dashboard-purpose-view.md.
 * Signature: `default({src, purposes}, ui) → string`.
 *
 * ALL dynamic values (labels, summaries, assertions, domain ids, anchors) are
 * emitted through `ui.escapeHtml` — the inputs are committed file content that
 * a contributor (or a synced consumer repo) controls.
 *
 * @module scripts/lib/dashboard/sections/purpose
 */

const SECTION = 'purpose';

/** Short, de-noised invariant ref: the trailing hash of `REQ-<kind>-<hash>`. */
function shortReqId(id) {
  const m = String(id).match(/([0-9a-f]{6,})$/i);
  return m ? `#${m[1].slice(0, 6)}` : String(id);
}

export default function sectionPurpose({ src, purposes }, ui) {
  const esc = ui.escapeHtml;
  // `invalid` / `unexpected-error` → warning panel (NON_OK).
  if (ui.NON_OK.has(src.status)) return ui.warningPanel(SECTION, src);
  const p = purposes || {};
  if (src.status === 'missing-optional' || !Array.isArray(p.nodes) || p.nodes.length === 0) {
    return ui.emptyPanel('purpose-empty',
      src.detail || 'No purpose map — add a `purposes` block to .audit-loop/domain-map.json.');
  }

  const h = p.hygiene || {};
  const mappedDomains = new Set();
  const invariantIds = new Set();
  for (const n of p.nodes) {
    for (const d of n.domains) mappedDomains.add(d.id);
    for (const r of n.requirements) invariantIds.add(r.id);
  }

  // Coverage ratio (Sofia/persona P2): show the DENOMINATOR so the reader sees
  // that the mapped invariants are a fraction of the ledger, not the whole.
  const totalInvariants = invariantIds.size + (h.unattachedRequirements?.length || 0);
  const summary = `<p class="section-note">`
    + `<strong>${esc(p.nodes.length)}</strong> purposes · `
    + `<strong>${esc(mappedDomains.size)}</strong> domains mapped · `
    + `<strong>${esc(invariantIds.size)}</strong>${totalInvariants > invariantIds.size ? ` of ${esc(totalInvariants)}` : ''} invariants mapped`
    + (h.unmappedDomains?.length ? ` · ${esc(h.unmappedDomains.length)} domains unmapped` : '')
    + (p.ledgerPresent ? '' : ' · <em>no requirements ledger</em>')
    + `</p>`;

  const regions = p.nodes.map((n) => renderNode(n, p.ledgerPresent, esc)).join('');
  const hygiene = renderHygiene(h, esc);

  return summary + `<div class="purpose-list">${regions}</div>` + hygiene;
}

function renderNode(n, ledgerPresent, esc) {
  const flows = (n.kind === 'skill-chain' && n.flowNodes.length)
    ? `<span class="purpose-flows">${esc(n.flowNodes.join(', '))}</span>`
    : '';

  // No aria-label on the chip container: it sits inside the purpose <section>
  // (already labelled by the purpose title), and a generic per-purpose group
  // label repeated for every purpose is a duplicate-aria-label a11y smell. The
  // chips are self-describing links.
  const chips = n.domains.length
    ? `<div class="domain-chips">`
      + n.domains.map((d) => renderChip(d, esc)).join('')
      + `</div>`
    : '';

  let reqs;
  if (!n.requirements.length) {
    reqs = ledgerPresent
      ? `<p class="purpose-noreq">No invariants mapped here.</p>`
      : `<p class="purpose-noreq">No requirements ledger — run <code>npm run requirements</code>.</p>`;
  } else {
    // Group by kind (already sorted kind→id by the collector).
    const byKind = new Map();
    for (const r of n.requirements) {
      if (!byKind.has(r.kind)) byKind.set(r.kind, []);
      byKind.get(r.kind).push(r);
    }
    reqs = [...byKind.entries()].map(([kind, list]) =>
      `<details class="kind-group"><summary>${esc(kind)} <span class="kind-count">${esc(list.length)}</span></summary>`
      // Assertion leads (what a human reads); the id is a trailing muted ref
      // (short hash shown, full id on hover) — persona P3: the REQ-<kind>-<hash>
      // prefix was reading noise ahead of the actual invariant text.
      + `<ul>${list.map((r) => `<li>${esc(r.assertion)} <span class="req-id" title="${esc(r.id)}">${esc(shortReqId(r.id))}</span></li>`).join('')}</ul>`
      + `</details>`).join('');
  }

  return `<section class="purpose" aria-labelledby="purpose-${esc(n.id)}-title">`
    + `<details open>`
    + `<summary><h3 id="purpose-${esc(n.id)}-title" class="purpose-title">${esc(n.label)}`
    + `<span class="purpose-kind">${esc(n.kind)}</span>${flows}</h3></summary>`
    + `<div class="purpose-body">`
    + `<p class="purpose-summary">${esc(n.summary)}</p>`
    + chips
    + `<div class="purpose-reqs">${reqs}</div>`
    + `</div></details></section>`;
}

function renderChip(d, esc) {
  const badge = d.alsoServes > 0
    ? ` <span class="chip-badge" data-testid="domain-also-serves" title="also serves ${esc(d.alsoServes)} other purpose(s)">+${esc(d.alsoServes)}</span>`
    : '';
  if (d.anchor) {
    return `<a class="domain-chip" data-cross-tab href="#${esc(d.anchor)}">${esc(d.id)}${badge}</a>`;
  }
  // No architecture-map entry → link-less chip (reported in hygiene).
  return `<span class="domain-chip domain-chip-nolink" title="no architecture-map entry">${esc(d.id)}${badge}</span>`;
}

function renderHygiene(h, esc) {
  const rows = [];
  if (h.unmappedDomains?.length) {
    rows.push(`<li><strong>Unmapped domains (${esc(h.unmappedDomains.length)})</strong>: `
      + `${h.unmappedDomains.map(esc).join(', ')} — add to <code>domainPurposes</code> in <code>.audit-loop/domain-map.json</code></li>`);
  }
  if (h.domainsMissingArchitecture?.length) {
    rows.push(`<li><strong>Mapped but no architecture entry (${esc(h.domainsMissingArchitecture.length)})</strong>: `
      + `${h.domainsMissingArchitecture.map(esc).join(', ')} — chips render without a cross-link (no symbols indexed)</li>`);
  }
  if (h.unknownDomains?.length) {
    rows.push(`<li><strong>Unknown domain keys (${esc(h.unknownDomains.length)})</strong>: `
      + `${h.unknownDomains.map(esc).join(', ')} — <code>domainPurposes</code> key matches no known domain</li>`);
  }
  if (h.unattachedRequirements?.length) {
    rows.push(`<li><strong>Unattached invariants (${esc(h.unattachedRequirements.length)})</strong>: `
      + `${h.unattachedRequirements.slice(0, 12).map(esc).join(', ')}${h.unattachedRequirements.length > 12 ? ' …' : ''} — `
      + `<code>appliesTo</code> resolves to no mapped domain</li>`);
  }
  if (h.skippedRequirements) {
    rows.push(`<li><strong>Skipped ledger entries</strong>: ${esc(h.skippedRequirements)} (missing id/assertion)</li>`);
  }
  if (!rows.length) return '';
  return `<section class="hygiene" role="region" aria-label="Purpose hygiene" data-testid="purpose-hygiene">`
    + `<h3 class="hygiene-title">⚠ Hygiene</h3><ul>${rows.join('')}</ul></section>`;
}
