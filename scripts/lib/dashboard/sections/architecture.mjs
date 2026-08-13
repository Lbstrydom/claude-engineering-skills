/**
 * @fileoverview Architecture tab — layered domain graph + observed-deps
 * provenance subtitle.
 *
 * Plan: docs/plans/sustainability-cleanup-batch.md (WS2).
 * Subtitle from: docs/plans/observed-domain-deps.md §6.
 *
 * Signature: `default({src, architecture}, ui) → string`.
 *   architecture = { domains, deps, mergedDeps, depsSource, mapPath }
 *
 * @module scripts/lib/dashboard/sections/architecture
 */

import { archDomainElementId, purposeTitleElementId } from '../anchors.mjs';

const SECTION = 'architecture';

const ARCH_TIER_LABELS = ['foundation', 'core', 'top-level'];

/**
 * Classify each domain into one of three dependency tiers. A coarse 3-way
 * bucket rather than a strict topological sort — `allowedDeps` is NOT a DAG
 * (e.g. findings ↔ shared-lib), so depth-based layering degenerates.
 *   0 foundation — depends on no other domain
 *   1 core       — has deps, AND is itself depended upon by others
 *   2 top-level  — has deps, and nothing depends on it (a consumer)
 * @returns {Map<string, number>}
 */
function archTiers(domains, deps) {
  const names = new Set(domains.map((d) => d.name));
  const ownDeps = (n) => (deps[n] || []).filter((d) => names.has(d) && d !== n);
  const dependedUpon = new Set();
  for (const [from, list] of Object.entries(deps)) {
    if (!names.has(from)) continue;
    for (const to of list || []) {
      if (names.has(to) && to !== from) dependedUpon.add(to);
    }
  }
  const tier = new Map();
  for (const d of domains) {
    if (ownDeps(d.name).length === 0) tier.set(d.name, 0);
    else if (dependedUpon.has(d.name)) tier.set(d.name, 1);
    else tier.set(d.name, 2);
  }
  return tier;
}

/**
 * The coverage banner — the surface that must NEVER read green on an
 * unmeasured or lossy graph.
 *
 * Mirrors nav-audit's and visual-audit's capture-status banners (🟡 for a
 * degraded capture, ⚪ for "not measured"). The load-bearing rule: `unknown`
 * gets its own neutral icon and is never collapsed into the verified branch.
 * Absence of a measurement is not evidence of a clean one — that conflation is
 * the entire bug class this feature exists to end.
 */
function formatCoverageBanner(coverage, ui) {
  if (!coverage) return '';
  const status = coverage.verdict?.status || 'unknown';
  const reason = coverage.verdict?.reason || null;
  const LABEL = {
    verified:   ['🟢', 'coverage verified'],
    degraded:   ['🟡', 'coverage degraded'],
    unverified: ['🟡', 'coverage unverified — this graph is not an authority'],
    unknown:    ['⚪', 'coverage not measured'],
  };
  const [icon, text] = LABEL[status] || ['⚪', 'coverage unknown'];
  const cls = status === 'verified' ? 'section-note' : 'section-note section-warn';

  const e = coverage.extraction;
  const a = coverage.attribution;
  const bits = [];
  if (e && Number.isFinite(e.cruised) && Number.isFinite(e.eligible)) {
    bits.push(`${e.cruised}/${e.eligible} eligible files cruised`);
  } else if (status !== 'verified') {
    // Explicitly say the numbers are absent rather than omitting the clause —
    // a missing count must not read as a zero-drop clean run.
    bits.push('no extraction measurement');
  }
  if (a && Number.isFinite(a.attributed) && Number.isFinite(a.attributable)) {
    bits.push(`${a.attributed}/${a.attributable} attributable edges`);
  }
  if (coverage.stale === true) bits.push('copied forward — not measured this run');

  const detail = bits.length ? ` · ${ui.escapeHtml(bits.join(' · '))}` : '';
  const why = reason ? ` (${ui.escapeHtml(reason)})` : '';
  return `<p class="${cls}">${icon} <strong>${ui.escapeHtml(text)}</strong>${why}${detail}</p>`;
}

function formatDepsSourceLine(ds, ui) {
  if (!ds) return '';
  const { observed = 0, manual = 0, both = 0 } = ds.edgeCounts || {};
  const total = observed + manual + both;
  if (ds.observedAvailable) {
    const refresh = ds.observedRefreshId ? ` · refresh <code>${ui.escapeHtml(ds.observedRefreshId.slice(0, 8))}</code>` : '';
    if (manual === 0 && both === 0) {
      return `<p class="section-note">${ui.escapeHtml(total)} edges (all observed)${refresh}</p>`;
    }
    return `<p class="section-note">${ui.escapeHtml(total)} edges: `
      + `${ui.escapeHtml(observed)} observed · ${ui.escapeHtml(manual)} manual-only · ${ui.escapeHtml(both)} confirmed-by-both`
      + `${refresh}</p>`;
  }
  if (total === 0) {
    return '<p class="section-note section-warn">No dependency data — run <code>npm run dashboard:setup</code></p>';
  }
  const reason = ds.observedRejectedReason || 'absent';
  const hint = {
    'absent': 'run <code>npm run dashboard:setup</code> to enable observed deps',
    'stale-rules': 'observed deps rejected as stale; run <code>npm run arch:render</code>',
    'schema-invalid': 'observed deps file corrupt; check stderr',
    // Two different remedies, so two different hints: `malformed` is corrupt
    // CONTENT (regenerate), `unreadable` is an I/O fault (check the filesystem).
    'malformed': 'observed deps file corrupt; run <code>npm run arch:render</code>',
    'unreadable': 'observed deps file could not be read; check permissions and stderr',
  }[reason] || 'observed deps unavailable';
  return `<p class="section-note section-warn">${ui.escapeHtml(total)} edges (manual intent only — ${hint})</p>`;
}

export default function sectionArchitecture({ src, architecture }, ui) {
  if (ui.NON_OK.has(src.status)) return ui.warningPanel(SECTION, src);
  const { domains, deps = {}, depsSource = null, mapPath, domainPurposes = {} } = architecture;
  if (!domains.length) {
    return ui.emptyPanel('arch-empty',
      'No architecture-map.md — run `npm run arch:render` to generate it.');
  }
  const names = new Set(domains.map((d) => d.name));
  const tiers = archTiers(domains, deps);
  // Symbol count drives a per-box BAR, scaled against the global max — so
  // the size signal is honest everywhere (boxes are uniform width; an
  // earlier flex-grow scheme normalised per-row and misled across rows).
  const maxSym = Math.max(1, ...domains.map((d) => d.symbolCount || 0));
  // Render top-level tier first — consumers on top, foundations at the bottom.
  let bands = '';
  let tierCount = 0;
  for (let t = 2; t >= 0; t -= 1) {
    const inTier = domains
      .filter((d) => tiers.get(d.name) === t)
      .sort((a, b) => (b.symbolCount || 0) - (a.symbolCount || 0));
    if (!inTier.length) continue;
    tierCount += 1;
    const boxes = inTier.map((d) => {
      const sym = d.symbolCount || 0;
      const barPct = Math.max(2, Math.round((sym / maxSym) * 100));
      const ds = (deps[d.name] || []).filter((x) => names.has(x) && x !== d.name);
      const depLine = ds.length
        ? `<div class="arch-deps">&#8627; depends on: ${ds.map((x) => ui.escapeHtml(x)).join(', ')}</div>`
        : '<div class="arch-deps arch-deps-none">foundation — no domain deps</div>';
      // v2 Part 2 — reverse cross-link: which purpose(s) this domain serves.
      // Silent when none (no empty "serves:" label).
      const purposes = domainPurposes[d.name] || [];
      const servesLine = purposes.length
        ? `<div class="arch-serves">serves: ${purposes.map((p) =>
            `<a class="serves-chip" data-cross-tab href="#${ui.escapeHtml(purposeTitleElementId(p.id))}">${ui.escapeHtml(p.label)}</a>`).join('')}</div>`
        : '';
      return `<details class="arch-domain" id="${ui.escapeHtml(archDomainElementId(d.name))}">
        <summary>
          <span class="arch-name">${ui.escapeHtml(d.name)}</span>
          <span class="arch-sym">${ui.escapeHtml(sym)}</span>
          <span class="arch-bar" title="${ui.escapeHtml(sym)} symbols"><span style="width:${barPct}%"></span></span>
        </summary>
        <div class="arch-body"><p>${ui.escapeHtml(d.summary || 'No summary.')}</p>${depLine}${servesLine}</div>
      </details>`;
    }).join('');
    bands += `<div class="arch-layer">
      <span class="arch-layer-label">${ui.escapeHtml(ARCH_TIER_LABELS[t])}</span>
      <div class="arch-row">${boxes}</div>
    </div>`;
  }
  const mp = mapPath ? ui.escapeHtml(mapPath) : 'docs/architecture-map.md';
  const depsLine = formatDepsSourceLine(depsSource, ui);
  // Coverage banner goes ABOVE the edge counts on purpose: the reader must
  // learn whether this graph can be believed BEFORE reading numbers derived
  // from it.
  const coverageLine = formatCoverageBanner(depsSource?.coverage, ui);
  return `<p class="section-note">${ui.escapeHtml(domains.length)} domains · `
    + `${ui.escapeHtml(tierCount)} dependency tiers (top-level → foundation) · `
    + `bar width &prop; symbol count · full map: <code>${mp}</code></p>
    ${coverageLine}
    ${depsLine}
    <div class="arch-graph">${bands}</div>`;
}

// Exported for testing only — keeps the contract-test able to verify
// archTiers + formatDepsSourceLine without re-rendering the whole section.
export const __test__ = { archTiers, formatDepsSourceLine, ARCH_TIER_LABELS };
