/**
 * @fileoverview Pure HTML renderer for the local dashboard. `renderDocument`
 * is a pure function — `(data, kind, assets) -> string` — with NO I/O. It
 * validates input against the Zod schema, then assembles a self-contained
 * page. All repo-derived strings pass through `escapeHtml` (markup) or
 * `jsonScriptSafe` (the embedded JSON block) — the security boundary of the
 * subsystem (docs/plans/local-dashboard.md §4 / Gemini-H3).
 *
 * @module scripts/lib/dashboard/render
 */
import { validateDashboardData } from './schema.mjs';

// ── Encoders (mandatory — see plan §4) ───────────────────────────────────

/**
 * HTML-escape a value for element content or a double-quoted attribute.
 * @param {unknown} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Serialize an object for embedding inside a `<script type="application/json">`
 * block. Escapes `<` `>` `&` and the U+2028/U+2029 line separators so the
 * literal `</script>` can never close the block and the JSON survives HTML
 * parsing.
 * @param {unknown} obj
 * @returns {string}
 */
export function jsonScriptSafe(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// ── Small markup helpers ─────────────────────────────────────────────────

const NON_OK = new Set(['invalid', 'unexpected-error']);

function statusDot(status) {
  if (status === 'ok') return '<span class="status-dot status-ok"></span>';
  if (status === 'missing-optional') return '<span class="status-dot status-warn"></span>';
  return '<span class="status-dot status-err"></span>';
}

/** A visible warning panel for an `invalid` / `unexpected-error` source. */
function warningPanel(name, src) {
  return `<div class="panel warn-panel">
    <p class="warn-title">${statusDot(src.status)}Source "${escapeHtml(name)}" is ${escapeHtml(src.status)}</p>
    <p class="empty">${escapeHtml(src.detail || 'No detail provided.')}</p>
  </div>`;
}

/** An empty-state panel. */
function emptyPanel(testId, msg) {
  const id = testId ? ` data-testid="${escapeHtml(testId)}"` : '';
  return `<div class="panel empty"${id}>${escapeHtml(msg)}</div>`;
}

function tab(id, label, selected) {
  return `<button role="tab" id="tab-${escapeHtml(id)}" aria-controls="panel-${escapeHtml(id)}" `
    + `aria-selected="${selected ? 'true' : 'false'}" tabindex="${selected ? '0' : '-1'}">`
    + `${escapeHtml(label)}</button>`;
}

function panel(id, selected, inner) {
  return `<div role="tabpanel" id="panel-${escapeHtml(id)}" aria-labelledby="tab-${escapeHtml(id)}"`
    + `${selected ? '' : ' hidden'}>${inner}</div>`;
}

// ── Reference sections ───────────────────────────────────────────────────

function sectionSkills(data) {
  const src = data.sources.skills || { status: 'ok', detail: '' };
  if (NON_OK.has(src.status)) return warningPanel('skills', src);
  if (!data.skills.length) return emptyPanel(null, 'No skills found in skills/.');
  const cards = data.skills.map((s) => {
    // Usage lines are part of the search haystack too — so a query like
    // "--with-gemini" finds /brainstorm.
    const haystack = escapeHtml(
      [s.name, s.oneLiner, s.triggers.join(' '), s.usage.join(' ')].join(' ').toLowerCase(),
    );
    const chips = s.triggers.slice(0, 6)
      .map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join('');
    const lock = s.disableModelInvocation ? ' <span class="lock" title="manual invocation only">&#128274;</span>' : '';
    const hid = `skill-h-${escapeHtml(s.name)}`;
    // Usage / flag shortlist — the invocation forms + flags for the skill.
    const usage = s.usage.length
      ? `<div class="usage-block"><span class="usage-label">Usage</span>`
        + `<pre class="usage">${s.usage.map((u) => escapeHtml(u)).join('\n')}</pre></div>`
      : '';
    return `<article class="card" data-search="${haystack}" aria-labelledby="${hid}">
      <h3 id="${hid}"><code>/${escapeHtml(s.name)}</code>${lock}</h3>
      <p class="oneliner">${escapeHtml(s.oneLiner)}</p>
      ${usage}
      ${chips ? `<div class="chips">${chips}</div>` : ''}
    </article>`;
  }).join('');
  return `<div class="searchbar">
      <label for="skill-search">Filter skills</label>
      <input type="search" role="searchbox" id="skill-search"
        data-role="skill-search" placeholder="name, trigger, summary…">
      <p role="status" class="search-count" data-role="skill-count"></p>
    </div>
    <div class="grid">${cards}</div>`;
}

function sectionFlows(data) {
  const src = data.sources.flows || { status: 'ok', detail: '' };
  if (NON_OK.has(src.status)) return warningPanel('flows', src);
  if (!data.flows || !data.flows.nodes.length) {
    return emptyPanel(null, 'Flow data unavailable (flows.json absent).');
  }
  // `missing-optional` here (flows present, but skill refs not cross-checked
  // because the skills source failed) is a real degraded state — surface it.
  const caveat = src.status === 'missing-optional' && src.detail
    ? `<p class="section-note"><span class="status-dot status-warn"></span>${escapeHtml(src.detail)}</p>`
    : '';
  const nodes = data.flows.nodes.map((n) =>
    `<div class="flow-node"><span class="flow-skill">/${escapeHtml(n.skill)}</span> &mdash; ${escapeHtml(n.label)}</div>`,
  ).join('');
  const edges = data.flows.edges.map((e) => {
    const lbl = e.label ? ` (${escapeHtml(e.label)})` : '';
    return `<div class="flow-edge">${escapeHtml(e.from)} &rarr; ${escapeHtml(e.to)}${lbl}</div>`;
  }).join('');
  return `${caveat}<p class="section-note">Skill-chain process flow.</p>
    <div class="flow">${nodes}</div>
    <h3>Transitions</h3>${edges}`;
}

function sectionArchitecture(data) {
  const src = data.sources.architecture || { status: 'ok', detail: '' };
  if (NON_OK.has(src.status)) return warningPanel('architecture', src);
  if (!data.architecture.domains.length) {
    return emptyPanel('arch-empty',
      'No architecture-map.md — run `npm run arch:render` to generate it.');
  }
  const rows = data.architecture.domains.map((d) => `<details class="row">
    <summary><strong>${escapeHtml(d.name)}</strong> &mdash; ${d.symbolCount == null ? '?' : escapeHtml(d.symbolCount)} symbols</summary>
    <div>${escapeHtml(d.summary || 'No summary.')}</div>
  </details>`).join('');
  const path = data.architecture.mapPath ? escapeHtml(data.architecture.mapPath) : 'docs/architecture-map.md';
  return `<p class="section-note">${data.architecture.domains.length} domains · full map: <code>${path}</code></p>${rows}`;
}

function planList(plans) {
  if (!plans.length) return '<p class="empty">None.</p>';
  return plans.map((p) => `<details class="row">
    <summary><strong>${escapeHtml(p.title)}</strong>${p.status ? ` &mdash; ${escapeHtml(p.status)}` : ''}</summary>
    <div>${p.date ? `Date: ${escapeHtml(p.date)}<br>` : ''}<code>${escapeHtml(p.path)}</code>${p.malformed ? ' <span class="lock">(metadata unparsed)</span>' : ''}</div>
  </details>`).join('');
}

function sectionPlans(data) {
  const src = data.sources.plans || { status: 'ok', detail: '' };
  const { active, completed } = data.plans;
  // A non-ok status (e.g. one plan file failed to read) gets a warning
  // PREFIX — but any plans that WERE discovered are still rendered;
  // discarding them would be a degraded-mode data-loss bug.
  const warn = NON_OK.has(src.status) ? warningPanel('plans', src) : '';
  if (!active.length && !completed.length) {
    return warn || emptyPanel(null, 'No plans found.');
  }
  return `${warn}<h3>Active (${active.length})</h3>${planList(active)}
    <h3>Completed (${completed.length})</h3>${planList(completed)}`;
}

// ── Telemetry sections ───────────────────────────────────────────────────

function sectionAuditRuns(data) {
  const src = data.sources.auditRuns || { status: 'ok', detail: '' };
  const a = data.auditRuns;
  // A non-ok status gets a warning panel — but it is a PREFIX, not an
  // early return: a cloud failure still leaves usable local fallback data
  // in `a`, and discarding it would be a degraded-mode data-loss bug.
  const warn = NON_OK.has(src.status) ? warningPanel('auditRuns', src) : '';
  const hasData = a.cloud || a.local.total > 0;
  if (!hasData) {
    return warn || emptyPanel('telemetry-empty',
      'No audit data yet — run /audit-code to generate audit telemetry.');
  }
  // The Supabase query is filtered by date only — it is project-wide, not
  // per-repo (inherited from audit-metrics.mjs). Labelled honestly so the
  // user is not misled; per-repo filtering is deferred (plan §Out of Scope).
  let out = warn + `<p class="section-note">${a.cloud ? 'Supabase (project-wide)' : 'local-only'} · `
    + `${escapeHtml(a.runCount)} runs · ${escapeHtml(a.labeledCount)} labeled</p>`;
  if (a.passes.length) {
    const rows = a.passes.map((p) => `<tr>
      <td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.runs)}</td>
      <td>${escapeHtml(p.raised)}</td><td>${escapeHtml(p.accepted)}</td>
      <td>${escapeHtml(p.dismissed)}</td></tr>`).join('');
    out += `<div class="table-wrap"><table><thead><tr><th>Pass</th><th>Runs</th><th>Raised</th>
      <th>Accepted</th><th>Dismissed</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  if (a.local.total) {
    out += `<p class="section-note">Local outcomes: ${escapeHtml(a.local.total)} total, ${escapeHtml(a.local.labeled)} labeled.</p>`;
  }
  // Accepted/Dismissed come from triage labelling. When nothing is labelled
  // those columns are legitimately all-zero — say so rather than letting
  // bare zeros read as a bug.
  if (a.cloud && a.labeledCount === 0) {
    out += `<p class="section-note"><span class="status-dot status-warn"></span>`
      + `Accepted / Dismissed are 0 because no run has been triage-labelled — `
      + `the audit pipeline records findings raised, not their adjudication outcome.</p>`;
  }
  return out;
}

// Most-actionable status first, within each requirement kind.
const REQ_STATUS_ORDER = { active: 0, 'needs-review': 1, 'inferred-only': 2 };

function sectionRequirements(data) {
  const src = data.sources.requirements || { status: 'ok', detail: '' };
  if (NON_OK.has(src.status)) return warningPanel('requirements', src);
  const r = data.requirements;
  if (!r.present) return emptyPanel(null, 'No requirements ledger — run `node scripts/requirements.mjs`.');
  if (r.total === 0) return emptyPanel(null, 'Requirements ledger is empty.');

  // Group invariants by `kind` (behavioural / security / safety / …); within
  // a kind, sort most-actionable status first.
  const byKind = new Map();
  for (const i of r.items) {
    if (!byKind.has(i.kind)) byKind.set(i.kind, []);
    byKind.get(i.kind).push(i);
  }
  const rank = (s) => (s in REQ_STATUS_ORDER ? REQ_STATUS_ORDER[s] : 3);
  const note = r.truncated
    ? `${escapeHtml(r.active)} active of ${escapeHtml(r.total)} invariants — first ${escapeHtml(r.items.length)} shown, grouped by kind.`
    : `${escapeHtml(r.active)} active of ${escapeHtml(r.total)} invariants, grouped by kind.`;
  let out = `<p class="section-note">${note}</p>`;
  for (const kind of [...byKind.keys()].sort()) {
    const items = byKind.get(kind)
      .sort((a, b) => rank(a.status) - rank(b.status) || a.id.localeCompare(b.id));
    const rows = items.map((i) => `<tr>
      <td><code>${escapeHtml(i.id)}</code></td>
      <td>${escapeHtml(i.statement)}</td>
      <td>${escapeHtml(i.status)}</td></tr>`).join('');
    out += `<h3>${escapeHtml(kind)} <span class="kind-count">(${items.length})</span></h3>
      <div class="table-wrap"><table><thead><tr><th>ID</th><th>Statement</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }
  return out;
}

function sectionLearning(data) {
  const src = data.sources.learning || { status: 'ok', detail: '' };
  if (NON_OK.has(src.status)) return warningPanel('learning', src);
  const l = data.learning;
  // `missing-optional` carries a specific reason (cloud off vs repo not
  // found) — surface that detail rather than collapsing every non-ok
  // state into a generic "no decisions" message.
  if (src.status === 'missing-optional') {
    return emptyPanel(null, src.detail || 'Learning telemetry unavailable.');
  }
  if (!l.cloud) {
    return emptyPanel(null, 'Learning telemetry needs cloud + a service-role key.');
  }
  if (!l.pendingTriageCount && !l.noBrainerCount && !l.staleClusterCount) {
    return emptyPanel(null, 'No learning decisions recorded yet.');
  }
  return `<div class="table-wrap"><table><thead><tr><th>Metric</th><th>Count</th></tr></thead><tbody>
    <tr><td>Pending triage</td><td>${escapeHtml(l.pendingTriageCount)}</td></tr>
    <tr><td>No-brainer recommendations</td><td>${escapeHtml(l.noBrainerCount)}</td></tr>
    <tr><td>Stale clusters</td><td>${escapeHtml(l.staleClusterCount)}</td></tr>
  </tbody></table></div>`;
}

// ── Section registry ─────────────────────────────────────────────────────

const REGISTRY = {
  reference: [
    { id: 'skills', title: 'Skills', build: sectionSkills },
    { id: 'flows', title: 'Process Flows', build: sectionFlows },
    { id: 'architecture', title: 'Architecture', build: sectionArchitecture },
    { id: 'plans', title: 'Plans', build: sectionPlans },
  ],
  telemetry: [
    { id: 'audit', title: 'Audit Runs', build: sectionAuditRuns },
    { id: 'requirements', title: 'Requirements', build: sectionRequirements },
    { id: 'learning', title: 'Learning', build: sectionLearning },
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

function nav(kind) {
  const refCur = kind === 'reference' ? ' class="current" aria-current="page"' : '';
  const telCur = kind === 'telemetry' ? ' class="current" aria-current="page"' : '';
  return `<nav class="dash-nav" aria-label="Dashboard pages">
    <a href="./index.html"${refCur}>Reference</a>
    <a href="./telemetry.html"${telCur}>Telemetry</a>
    <span class="nav-hint">local pages: <code>npm run dashboard:build</code></span>
  </nav>`;
}

// ── Document ─────────────────────────────────────────────────────────────

/**
 * Render a complete self-contained dashboard page.
 * Pure: no I/O. Validates `data` against the schema for `kind` first.
 * @param {object} data — collected reference or telemetry data object
 * @param {'reference'|'telemetry'} kind
 * @param {{css: string, js: string}} assets
 * @returns {string} a complete HTML document
 */
export function renderDocument(data, kind, assets) {
  const validated = validateDashboardData(kind, data);
  const sections = REGISTRY[kind];
  const title = kind === 'reference'
    ? 'Claude Engineering Skills — Reference'
    : 'Claude Engineering Skills — Telemetry';

  // Telemetry: the page-level placeholder is for the genuine "nothing
  // collected yet" case — i.e. every section is `missing-optional`. A
  // section that is `invalid` / `unexpected-error` has a warning (and
  // possibly fallback data) to show, so the tabs render instead.
  let pageLevelEmpty = '';
  if (kind === 'telemetry') {
    const allMissing = ['auditRuns', 'requirements', 'learning']
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
      inner = s.build(validated);
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
<title>${escapeHtml(title)}</title>
<style>${assets.css}</style>
</head>
<body>
<a href="#main" class="skip-link">Skip to content</a>
<header class="dash-header">
  <div class="dash-titlerow">
    <h1>${escapeHtml(title)}</h1>
    ${nav(kind)}
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

export const __test__ = { escapeHtml, jsonScriptSafe, warningPanel, REGISTRY };
