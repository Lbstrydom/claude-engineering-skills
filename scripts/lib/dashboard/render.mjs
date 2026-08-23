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
import sectionCampaigns from './sections/campaigns.mjs';
import sectionVisualAudit from './sections/visual-audit.mjs';
import sectionPlans from './sections/plans.mjs';
import sectionAuditRuns from './sections/audit-runs.mjs';
import sectionRequirements from './sections/requirements.mjs';
import sectionLearning from './sections/learning.mjs';
import sectionPromptVariants from './sections/prompt-variants.mjs';
import sectionShipHealth from './sections/ship-health.mjs';
import sectionAuditEffectiveness from './sections/audit-effectiveness.mjs';
import sectionSkillCensus from './sections/skill-census.mjs';
import sectionSecurity from './sections/security.mjs';
import sectionPurpose from './sections/purpose.mjs';
import sectionPurposeHealth from './sections/purpose-health.mjs';
import sectionAuditRunDetail from './sections/audit-run-detail.mjs';
import sectionAuthorTier from './sections/author-tier.mjs';
import sectionModelAb from './sections/model-ab.mjs';
import sectionTieredShadow from './sections/tiered-shadow.mjs';
import sectionStartHere from './sections/start-here.mjs';
import sectionPersonaTests from './sections/persona-tests.mjs';

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
  campaigns:    (d) => ({ src: d.sources.campaigns || { status: 'missing-optional', detail: '' }, campaigns: d.campaigns || { campaigns: [], degraded: false, degradedReason: null, declaredIds: [] } }),
  visualAudit:  (d) => ({ src: d.sources.visualAudit || { status: 'missing-optional', detail: '' }, visualAudit: d.visualAudit || { scorecard: [], findings: [], diagnostics: [] } }),
  purpose:      (d) => ({ src: d.sources.purposes || { status: 'ok', detail: '' }, purposes: d.purposes || { status: 'missing-optional', detail: '', ledgerPresent: false, nodes: [], hygiene: { unmappedDomains: [], unattachedRequirements: [], skippedRequirements: 0, unknownDomains: [], domainsMissingArchitecture: [] } } }),
  plans:        (d) => ({ src: d.sources.plans || { status: 'ok', detail: '' }, plans: d.plans }),
  auditRuns:    (d) => ({ src: d.sources.auditRuns || { status: 'ok', detail: '' }, auditRuns: d.auditRuns }),
  requirements: (d) => ({ src: d.sources.requirements || { status: 'ok', detail: '' }, requirements: d.requirements }),
  learning:     (d) => ({ src: d.sources.learning || { status: 'ok', detail: '' }, learning: d.learning }),
  promptVariants:(d) => ({ src: d.sources.promptVariants || { status: 'ok', detail: '' }, promptVariants: d.promptVariants || { cloud: false, arms: [] } }),
  shipHealth:   (d) => ({ src: d.sources.shipHealth || { status: 'ok', detail: '' }, shipHealth: d.shipHealth || { cloud: false, byOutcome: [], recent: [] } }),
  personaTests: (d) => ({ src: d.sources.personaTests || { status: 'missing-optional', detail: '' }, personaTests: d.personaTests || { cloud: false, latestByPersona: [], trend: [], correlations: { total: 0, byType: [] } } }),
  auditEffectiveness:(d) => ({ src: d.sources.auditEffectiveness || { status: 'ok', detail: '' }, auditEffectiveness: d.auditEffectiveness || { cloud: false, confirmedHits: 0, auditMisses: 0, falsePositives: 0, severityUnderstated: 0, severityOverstated: 0, precision: null, recall: null } }),
  skillCensus:  (d) => ({ src: d.sources.skillCensus || { status: 'missing-optional', detail: '' }, skillCensus: d.skillCensus || { cloud: false, repoId: null, repoName: null, windowDays: 14, rows: [] } }),
  authorTier:   (d) => ({ src: d.sources.authorTier || { status: 'ok', detail: '' }, authorTier: d.authorTier || { cloud: false, total: 0, bySuggestedTier: [], ladders: [], distinctProviderLadders: 0, diversityGateMet: false, agreement: { agree: 0, disagree: 0, declaredUnknown: 0 } } }),
  modelAb:      (d) => ({ src: d.sources.modelAb || { status: 'missing-optional', detail: '' }, modelAb: d.modelAb || { cloud: false, status: 'off', reason: '', distinctAssignments: 0, minAssignments: 12, spentEur: 0, capEur: null, pendingAdjudication: 0, arms: [] } }),
  security:     (d) => ({ src: d.sources.security || { status: 'ok', detail: '' }, security: d.security || { cloud: false, totalIncidents: 0, embedded: 0, byStatus: [], eventCounts: [], lastRefreshAt: null, recentEvents: [] } }),
  purposeHealth:(d) => ({ src: d.sources.purposeHealth || { status: 'ok', detail: '' }, purposeHealth: d.purposeHealth || { asOf: '', windowDays: 30, repoWide: { recentHighFindings: null, plansWithFailingCriteria: null, refusedSecrets: null }, purposeBadges: [] } }),
  tieredShadow: (d) => ({ src: d.sources.tieredShadow || { status: 'missing-optional', detail: '' }, tieredShadow: d.tieredShadow || null }),
  // Start Here is pure orientation prose — no collected data.
  startHere:    () => ({}),
  // audit-run uses a top-level `src` (discriminated collector status code), NOT
  // the `sources` map — see AuditRunDataSchema (docs/plans/dashboard-audit-run-viewer.md).
  auditRunDetail:(d) => ({ src: d.src, auditRun: d.auditRun }),
};

// Every entry carries `group` (gestalt: the tabstrip renders labeled group
// containers — proximity + common region for 9-11 peer tabs) and `desc` (a
// plain-English one-liner a NEW user understands, rendered as the panel's
// subtitle). Group labels must be identical for adjacent entries — the strip
// builder clusters consecutive same-group entries.
const REGISTRY = {
  reference: [
    { id: 'startHere',    title: 'Start Here',     group: 'Orientation', build: sectionStartHere, slice: SLICERS.startHere,
      desc: 'New to this dashboard? What everything is, in plain English, and where to find it.' },
    { id: 'skills',       title: 'Skills',         group: 'Understand the toolkit', build: sectionSkills,       slice: SLICERS.skills,
      desc: 'Every skill (slash-command) in the bundle — what it does, when to reach for it, and how to invoke it.' },
    { id: 'cli',          title: 'CLI',            group: 'Understand the toolkit', build: sectionCli,          slice: SLICERS.cli,
      desc: 'Every operator command-line tool, grouped by job, with copy-pasteable usage.' },
    { id: 'flows',        title: 'Process Flows',  group: 'Understand the toolkit', build: sectionFlows,        slice: SLICERS.flows,
      desc: 'How the skills chain together into an end-to-end workflow: plan → audit → implement → verify → ship.' },
    { id: 'architecture', title: 'Architecture',   group: 'Design & plans', build: sectionArchitecture, slice: SLICERS.architecture,
      desc: 'The repo’s domain map — what code lives where, how big each area is, and what depends on what.' },
    { id: 'purpose',      title: 'Purpose',        group: 'Design & plans', build: sectionPurpose,      slice: SLICERS.purpose,
      desc: 'Why each subsystem exists — the product purposes, mapped to the domains and invariants that serve them.' },
    { id: 'plans',        title: 'Plans',          group: 'Design & plans', build: sectionPlans,        slice: SLICERS.plans,
      desc: 'Design documents in docs/plans/, bucketed by their Status: line — plans no longer move directories.' },
    { id: 'navAudit',     title: 'Nav Audit',      group: 'UX quality lenses', build: sectionNavAudit,     slice: SLICERS.navAudit,
      desc: 'Navigation audit of a target app — can every kind of user actually reach the things they need?' },
    { id: 'visualAudit',  title: 'Visual Audit',   group: 'UX quality lenses', build: sectionVisualAudit,  slice: SLICERS.visualAudit,
      desc: 'Visual audit of a target app — does what the page paints match its declared design tokens and themes?' },
    { id: 'campaigns',    title: 'Campaigns',      group: 'Design & plans', build: sectionCampaigns,    slice: SLICERS.campaigns,
      desc: 'Model-comparison campaigns — evidence quality first, then standings, watermarked until every gate that qualifies them passes.' },
  ],
  telemetry: [
    { id: 'audit',        title: 'Audit Runs',     group: 'Audit pipeline', build: sectionAuditRuns,    slice: SLICERS.auditRuns,
      desc: 'Recent code/plan audit runs and how many findings each analysis pass raised vs. what a human accepted.' },
    { id: 'auditEffectiveness',title: 'Audit Effectiveness', group: 'Audit pipeline', build: sectionAuditEffectiveness, slice: SLICERS.auditEffectiveness,
      desc: 'Is the audit worth it? Precision and recall of audit findings measured against real user-visible impact.' },
    { id: 'skillCensus',  title: 'Skill Census',   group: 'Audit pipeline', build: sectionSkillCensus,  slice: SLICERS.skillCensus,
      desc: 'Which of the 16 bundled skills actually get invoked, how often, and whether their findings get fixed.' },
    { id: 'promptVariants',title: 'Prompt Variants', group: 'Audit pipeline', build: sectionPromptVariants, slice: SLICERS.promptVariants,
      desc: 'Which audit prompt wordings are winning — the bandit that learns from your accept/dismiss decisions.' },
    { id: 'authorTier',   title: 'Author Tier',    group: 'Audit pipeline', build: sectionAuthorTier,   slice: SLICERS.authorTier,
      desc: 'Observation only: which authoring-model tiers produce work that converges fastest through audits.' },
    { id: 'modelAb',      title: 'A/B/C Testing',  group: 'Audit pipeline', build: sectionModelAb,      slice: SLICERS.modelAb,
      desc: 'The concluded auditor-model experiment (A/B/C arms) — kept for its labelled-outcome record.' },
    { id: 'tieredShadow', title: 'Tiered Shadow',  group: 'Audit pipeline', build: sectionTieredShadow, slice: SLICERS.tieredShadow,
      desc: 'A cheaper audit pipeline is being trialled silently next to the current one — progress toward the go/no-go decision.' },
    { id: 'learning',     title: 'Learning',       group: 'Learning & invariants', build: sectionLearning,     slice: SLICERS.learning,
      desc: 'What the audit system is learning from your triage decisions — and what’s waiting for a human label.' },
    { id: 'requirements', title: 'Requirements',   group: 'Learning & invariants', build: sectionRequirements, slice: SLICERS.requirements,
      desc: 'The de-facto invariants your code already enforces — extracted into a ledger the audits check against.' },
    { id: 'shipHealth',   title: 'Ship Health',    group: 'Delivery & governance', build: sectionShipHealth,   slice: SLICERS.shipHealth,
      desc: 'Every /ship outcome — shipped, warned, blocked, overridden — and why.' },
    { id: 'personaTests', title: 'Persona Tests',  group: 'Delivery & governance', build: sectionPersonaTests, slice: SLICERS.personaTests,
      desc: 'Latest persona-test session per persona, the recent-session trend, and whether the persona↔audit correlation loop is actually firing.' },
    { id: 'security',     title: 'Security',       group: 'Delivery & governance', build: sectionSecurity,     slice: SLICERS.security,
      desc: 'Security incident memory and the secret-gate audit trail — what was indexed, what was refused or redacted.' },
    { id: 'purposeHealth',title: 'Purpose Health', group: 'Delivery & governance', build: sectionPurposeHealth,slice: SLICERS.purposeHealth,
      desc: 'A health badge per product purpose — recent HIGH findings or security events in the areas that serve it.' },
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
    // actually has data, hiding it entirely. (modelAb + tieredShadow added
    // 2026-07-13 — both had been omitted, the exact bug this comment warns of.)
    const allMissing = ['auditRuns', 'requirements', 'learning', 'promptVariants', 'auditEffectiveness', 'shipHealth', 'security', 'purposeHealth', 'authorTier', 'modelAb', 'tieredShadow', 'personaTests', 'skillCensus']
      .every((n) => (validated.sources[n]?.status || 'ok') === 'missing-optional');
    if (allMissing) {
      pageLevelEmpty = emptyPanel('telemetry-empty',
        'No telemetry yet — run /audit-code or /ship to populate this dashboard.');
    }
  }

  // Grouped tabstrip (gestalt: proximity + common region). Consecutive
  // same-`group` entries render inside one labeled container; entries with
  // no group (audit-run detail page) fall back to a flat strip. The strip
  // stays ONE role="tablist" and tab order is unchanged, so dashboard.js's
  // `[role="tab"]` query + arrow-key nav work exactly as before.
  let tabs;
  if (sections.some((s) => s.group)) {
    const clusters = [];
    sections.forEach((s, i) => {
      const last = clusters[clusters.length - 1];
      if (!last || last.label !== (s.group || '')) clusters.push({ label: s.group || '', items: [] });
      clusters[clusters.length - 1].items.push({ s, first: i === 0 });
    });
    tabs = clusters.map((c) =>
      `<div class="tabgroup">`
      + (c.label ? `<span class="tabgroup-label" aria-hidden="true">${escapeHtml(c.label)}</span>` : '')
      + c.items.map(({ s, first }) => tab(s.id, s.title, first)).join('')
      + `</div>`).join('');
  } else {
    tabs = sections.map((s, i) => tab(s.id, s.title, i === 0)).join('');
  }

  const panels = sections.map((s, i) => {
    let inner;
    try {
      inner = s.build(s.slice(validated), ui);
    } catch (err) {
      inner = warningPanel(s.id, { status: 'unexpected-error', detail: String(err && err.message || err) });
    }
    // Plain-English subtitle (signifier for new users) — group crumb + one
    // sentence on what the tab shows and why you'd look at it.
    const desc = s.desc
      ? `<p class="panel-desc">${s.group ? `<span class="panel-crumb">${escapeHtml(s.group)}</span> · ` : ''}${escapeHtml(s.desc)}</p>`
      : '';
    return panel(s.id, i === 0, desc + inner);
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
