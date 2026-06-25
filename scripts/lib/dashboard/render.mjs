/**
 * @fileoverview Dashboard orchestrator. `renderDocument(data, kind, assets)`
 * is a pure function with NO I/O. It validates input against the Zod schema,
 * builds the canonical `ui` helper bundle, then delegates each section to
 * a module under `sections/`.
 *
 * Plan: docs/plans/sustainability-cleanup-batch.md (WS2). The decomp moved
 * 8 section renderers + their helpers out of this file. The orchestrator
 * is the ONLY module that imports `helpers.mjs`; section modules under
 * `sections/` receive helpers via the `ui` argument. Enforced by
 * `tests/dashboard-section-contract.test.mjs`.
 *
 * Backward-compat re-exports: `escapeHtml` and `jsonScriptSafe` remain
 * importable from this file — existing tests and callers don't change.
 *
 * @module scripts/lib/dashboard/render
 */
import { validateDashboardData } from './schema.mjs';
import {
  escapeHtml, jsonScriptSafe, buildUi, tab, panel, emptyPanel, warningPanel,
} from './helpers.mjs';
import sectionSkills from './sections/skills.mjs';
import sectionCli from './sections/cli.mjs';
import sectionFlows from './sections/flows.mjs';
import sectionArchitecture from './sections/architecture.mjs';
import sectionNavAudit from './sections/nav-audit.mjs';
import sectionPlans from './sections/plans.mjs';
import sectionAuditRuns from './sections/audit-runs.mjs';
import sectionRequirements from './sections/requirements.mjs';
import sectionLearning from './sections/learning.mjs';
import sectionPromptVariants from './sections/prompt-variants.mjs';
import sectionShipHealth from './sections/ship-health.mjs';
import sectionAuditEffectiveness from './sections/audit-effectiveness.mjs';
import sectionSecurity from './sections/security.mjs';
import sectionPurpose from './sections/purpose.mjs';
import sectionPurposeHealth from './sections/purpose-health.mjs';
import sectionAuditRunDetail from './sections/audit-run-detail.mjs';
import sectionAuthorTier from './sections/author-tier.mjs';

// Backward-compat: existing callers import these from render.mjs.
export { escapeHtml, jsonScriptSafe };

// ── Per-section view-model selectors ─────────────────────────────────────
//
// Each section receives a narrow slice of `data` plus the frozen `ui`
// bundle — limits coupling (plan §2 #4 — the section can't reach into
// arbitrary `data` fields).
const SLICERS = {
  skills:       (d) => ({ src: d.sources.skills || { status: 'ok', detail: '' }, skills: d.skills }),
  cli:          (d) => ({ src: d.sources.cli || { status: 'ok', detail: '' }, cli: d.cli }),
  flows:        (d) => ({ src: d.sources.flows || { status: 'ok', detail: '' }, flows: d.flows }),
  architecture: (d) => ({ src: d.sources.architecture || { status: 'ok', detail: '' }, architecture: d.architecture }),
  navAudit:     (d) => ({ src: d.sources.navAudit || { status: 'missing-optional', detail: '' }, navAudit: d.navAudit || { scorecard: [], drift: [] } }),
  purpose:      (d) => ({ src: d.sources.purposes || { status: 'ok', detail: '' }, purposes: d.purposes || { status: 'missing-optional', detail: '', ledgerPresent: false, nodes: [], hygiene: { unmappedDomains: [], unattachedRequirements: [], skippedRequirements: 0, unknownDomains: [], domainsMissingArchitecture: [] } } }),
  plans:        (d) => ({ src: d.sources.plans || { status: 'ok', detail: '' }, plans: d.plans }),
  auditRuns:    (d) => ({ src: d.sources.auditRuns || { status: 'ok', detail: '' }, auditRuns: d.auditRuns }),
  requirements: (d) => ({ src: d.sources.requirements || { status: 'ok', detail: '' }, requirements: d.requirements }),
  learning:     (d) => ({ src: d.sources.learning || { status: 'ok', detail: '' }, learning: d.learning }),
  promptVariants:(d) => ({ src: d.sources.promptVariants || { status: 'ok', detail: '' }, promptVariants: d.promptVariants || { cloud: false, arms: [] } }),
  shipHealth:   (d) => ({ src: d.sources.shipHealth || { status: 'ok', detail: '' }, shipHealth: d.shipHealth || { cloud: false, byOutcome: [], recent: [] } }),
  auditEffectiveness:(d) => ({ src: d.sources.auditEffectiveness || { status: 'ok', detail: '' }, auditEffectiveness: d.auditEffectiveness || { cloud: false, confirmedHits: 0, auditMisses: 0, falsePositives: 0, severityUnderstated: 0, severityOverstated: 0, precision: null, recall: null } }),
  authorTier:   (d) => ({ src: d.sources.authorTier || { status: 'ok', detail: '' }, authorTier: d.authorTier || { cloud: false, total: 0, bySuggestedTier: [], ladders: [], distinctProviderLadders: 0, diversityGateMet: false, agreement: { agree: 0, disagree: 0, declaredUnknown: 0 } } }),
  security:     (d) => ({ src: d.sources.security || { status: 'ok', detail: '' }, security: d.security || { cloud: false, totalIncidents: 0, embedded: 0, byStatus: [], eventCounts: [], lastRefreshAt: null, recentEvents: [] } }),
  purposeHealth:(d) => ({ src: d.sources.purposeHealth || { status: 'ok', detail: '' }, purposeHealth: d.purposeHealth || { asOf: '', windowDays: 30, repoWide: { recentHighFindings: null, plansWithFailingCriteria: null, refusedSecrets: null }, purposeBadges: [] } }),
  // audit-run uses a top-level `src` (discriminated collector status code), NOT
  // the `sources` map — see AuditRunDataSchema (docs/plans/dashboard-audit-run-viewer.md).
  auditRunDetail:(d) => ({ src: d.src, auditRun: d.auditRun }),
};

const REGISTRY = {
  reference: [
    { id: 'skills',       title: 'Skills',         build: sectionSkills,       slice: SLICERS.skills },
    { id: 'cli',          title: 'CLI',            build: sectionCli,          slice: SLICERS.cli },
    { id: 'flows',        title: 'Process Flows',  build: sectionFlows,        slice: SLICERS.flows },
    { id: 'architecture', title: 'Architecture',   build: sectionArchitecture, slice: SLICERS.architecture },
    { id: 'navAudit',     title: 'Nav Audit',      build: sectionNavAudit,     slice: SLICERS.navAudit },
    { id: 'purpose',      title: 'Purpose',        build: sectionPurpose,      slice: SLICERS.purpose },
    { id: 'plans',        title: 'Plans',          build: sectionPlans,        slice: SLICERS.plans },
  ],
  telemetry: [
    { id: 'audit',        title: 'Audit Runs',     build: sectionAuditRuns,    slice: SLICERS.auditRuns },
    { id: 'requirements', title: 'Requirements',   build: sectionRequirements, slice: SLICERS.requirements },
    { id: 'learning',     title: 'Learning',       build: sectionLearning,     slice: SLICERS.learning },
    { id: 'promptVariants',title: 'Prompt Variants',build: sectionPromptVariants, slice: SLICERS.promptVariants },
    { id: 'auditEffectiveness',title: 'Audit Effectiveness',build: sectionAuditEffectiveness, slice: SLICERS.auditEffectiveness },
    { id: 'shipHealth',   title: 'Ship Health',    build: sectionShipHealth,   slice: SLICERS.shipHealth },
    { id: 'security',     title: 'Security',       build: sectionSecurity,     slice: SLICERS.security },
    { id: 'purposeHealth',title: 'Purpose Health', build: sectionPurposeHealth,slice: SLICERS.purposeHealth },
    { id: 'authorTier',   title: 'Author Tier',    build: sectionAuthorTier,   slice: SLICERS.authorTier },
  ],
  // Single-section per-run detail page (docs/plans/dashboard-audit-run-viewer.md).
  'audit-run': [
    { id: 'auditRunDetail', title: 'Audit Run', build: sectionAuditRunDetail, slice: SLICERS.auditRunDetail },
  ],
};

// ── Header / banner ──────────────────────────────────────────────────────

function freshnessBanner(data) {
  if (data.kind === 'reference') {
    const p = data.provenance;
    const dirty = p.dirty ? '+local' : '';
    return `<p class="freshness" data-testid="freshness-banner">built from `
      + `<code>${escapeHtml(p.baseSha)}</code>${escapeHtml(dirty)} `
      + `· source <code>${escapeHtml(p.sourceHash)}</code></p>`;
  }
  const p = data.provenance;
  return `<p class="freshness" data-testid="freshness-banner">Generated `
    + `${escapeHtml(p.generatedAt)} · base <code>${escapeHtml(p.baseSha)}</code> `
    + `· ${escapeHtml(p.mode)}</p>`;
}

// `pathPrefix` lets a nested page (e.g. dashboard/audit-runs/<id>.html) link
// back up to the top-level pages without 404ing (G1). Existing kinds pass the
// default './'; the audit-run kind passes '../'.
function nav(kind, pathPrefix = './') {
  const refCur = kind === 'reference' ? ' class="current" aria-current="page"' : '';
  const telCur = kind === 'telemetry' ? ' class="current" aria-current="page"' : '';
  return `<nav class="dash-nav" aria-label="Dashboard pages">
    <a href="${pathPrefix}index.html"${refCur}>Reference</a>
    <a href="${pathPrefix}telemetry.html"${telCur}>Telemetry</a>
    <span class="nav-hint">local pages: <code>npm run dashboard:setup</code> (first run) · <code>npm run dashboard:build</code> (refresh)</span>
  </nav>`;
}

// ── Document ─────────────────────────────────────────────────────────────

/**
 * Render a complete self-contained dashboard page.
 * Pure: no I/O. Validates `data` against the schema for `kind` first.
 * @param {object} data — collected reference / telemetry / audit-run data object
 * @param {'reference'|'telemetry'|'audit-run'} kind
 * @param {{css: string, js: string}} assets
 * @returns {string} a complete HTML document
 */
export function renderDocument(data, kind, assets) {
  const validated = validateDashboardData(kind, data);
  const sections = REGISTRY[kind];
  const ui = buildUi();
  const title = kind === 'reference'
    ? 'Claude Engineering Skills — Reference'
    : kind === 'telemetry'
      ? 'Claude Engineering Skills — Telemetry'
      : 'Claude Engineering Skills — Audit Run';

  // Telemetry: the page-level placeholder is for the genuine "nothing
  // collected yet" case — i.e. every section is `missing-optional`. A
  // section that is `invalid` / `unexpected-error` has a warning (and
  // possibly fallback data) to show, so the tabs render instead.
  let pageLevelEmpty = '';
  if (kind === 'telemetry') {
    // Must list EVERY telemetry section source — omitting one (e.g. security)
    // would show the page-level "nothing yet" placeholder while that section
    // actually has data, hiding it entirely.
    const allMissing = ['auditRuns', 'requirements', 'learning', 'promptVariants', 'auditEffectiveness', 'shipHealth', 'security', 'purposeHealth', 'authorTier']
      .every((n) => (validated.sources[n]?.status || 'ok') === 'missing-optional');
    if (allMissing) {
      pageLevelEmpty = emptyPanel('telemetry-empty',
        'No telemetry yet — run /audit-code or /ship to populate this dashboard.');
    }
  }

  const tabs = sections.map((s, i) => tab(s.id, s.title, i === 0)).join('');
  const panels = sections.map((s, i) => {
    let inner;
    try {
      inner = s.build(s.slice(validated), ui);
    } catch (err) {
      inner = warningPanel(s.id, { status: 'unexpected-error', detail: String(err && err.message || err) });
    }
    return panel(s.id, i === 0, inner);
  }).join('');

  const body = pageLevelEmpty
    ? `<div role="tabpanel">${pageLevelEmpty}</div>`
    : `<div class="tabstrip" role="tablist" aria-label="${escapeHtml(title)}">${tabs}</div>${panels}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>${escapeHtml(title)}</title>
<style>${assets.css}</style>
</head>
<body>
<a href="#main" class="skip-link">Skip to content</a>
<header class="dash-header">
  <div class="dash-titlerow">
    <h1>${escapeHtml(title)}</h1>
    ${nav(kind, kind === 'audit-run' ? '../' : './')}
  </div>
  ${freshnessBanner(validated)}
</header>
<main id="main">${body}</main>
<script type="application/json" id="dashboard-data">${jsonScriptSafe(validated)}</script>
<script>${assets.js}</script>
</body>
</html>
`;
}

// Backward-compat: existing tests import `__test__` (legacy bundle).
// Kept as a thin pass-through — `REGISTRY` is the only piece tests touched.
export const __test__ = { escapeHtml, jsonScriptSafe, warningPanel, REGISTRY };
