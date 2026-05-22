/**
 * @fileoverview CLI tab renderer — groups npm scripts by category with
 * search + per-card command/description/output metadata.
 *
 * Plan: docs/plans/sustainability-cleanup-batch.md (WS2).
 *
 * Signature: `default({src, cli}, ui) → string`.
 *
 * @module scripts/lib/dashboard/sections/cli
 */

const SECTION = 'cli';

// Display order for CLI category groups. Categories not in the list
// fall through to alphabetical at the end; `test` and `other` sink last
// because the user almost never needs to scan them.
const CLI_CATEGORY_ORDER = [
  'audit', 'diagnostic', 'skills', 'sync', 'arch',
  'learning', 'plans', 'security', 'dashboard', 'hooks', 'parity', 'test', 'other',
];

const CLI_CATEGORY_TITLES = {
  audit:      'Audit',
  diagnostic: 'Diagnostics',
  skills:     'Skills management',
  sync:       'Sync + distribution',
  arch:       'Architectural memory',
  learning:   'Learning system',
  plans:      'Plans',
  security:   'Security memory',
  dashboard:  'Dashboard',
  hooks:      'Git hooks',
  parity:     'Postgres parity',
  test:       'Tests',
  other:      'Other / uncatalogued',
};

export default function sectionCli({ src, cli }, ui) {
  if (ui.NON_OK.has(src.status)) return ui.warningPanel(SECTION, src);
  const entries = cli || [];
  if (!entries.length) {
    return ui.emptyPanel(null, 'No npm scripts found in package.json.');
  }
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.category)) groups.set(e.category, []);
    groups.get(e.category).push(e);
  }
  const orderedCats = [
    ...CLI_CATEGORY_ORDER.filter((c) => groups.has(c)),
    ...[...groups.keys()].filter((c) => !CLI_CATEGORY_ORDER.includes(c)).sort(),
  ];

  const sections = orderedCats.map((cat) => {
    const rows = groups.get(cat).map((e) => {
      const haystack = ui.escapeHtml(
        [e.name, e.description, e.command, e.category, e.relatedSkill || ''].join(' ').toLowerCase(),
      );
      const linked = e.relatedSkill
        ? ` <span class="chip"><code>/${ui.escapeHtml(e.relatedSkill)}</code></span>`
        : '';
      const outputs = e.outputs
        ? ` <span class="chip" title="output file">writes ${ui.escapeHtml(e.outputs)}</span>`
        : '';
      const uncatLabel = e.uncatalogued
        ? ' <span class="chip warn" title="add metadata to scripts/.cli-catalog.json">uncatalogued</span>'
        : '';
      const desc = e.description
        ? `<p class="cli-desc">${ui.escapeHtml(e.description)}</p>`
        : `<p class="cli-desc cli-desc-muted">No description — add an entry to scripts/.cli-catalog.json.</p>`;
      return `<article class="card cli-card" data-search="${haystack}" data-category="${ui.escapeHtml(cat)}">
        <h3 class="cli-name"><code>npm run ${ui.escapeHtml(e.name)}</code>${uncatLabel}${linked}${outputs}</h3>
        ${desc}
        <pre class="cli-cmd"><code>${ui.escapeHtml(e.command)}</code></pre>
      </article>`;
    }).join('');
    return `<section class="cli-group" data-cli-category="${ui.escapeHtml(cat)}">
      <h2 class="cli-group-title">${ui.escapeHtml(CLI_CATEGORY_TITLES[cat] || cat)}
        <span class="cli-group-count">${groups.get(cat).length}</span>
      </h2>
      <div class="grid">${rows}</div>
    </section>`;
  }).join('');

  const catNote = src.detail && src.detail.includes('uncatalogued')
    ? `<p class="section-note"><span class="status-dot status-warn"></span>${ui.escapeHtml(src.detail)}</p>`
    : '';

  return `<div class="searchbar">
      <label for="cli-search">Filter CLI commands</label>
      <input type="search" role="searchbox" id="cli-search"
        data-role="cli-search" placeholder="name, description, category…">
      <p role="status" class="search-count" data-role="cli-count"></p>
    </div>
    ${catNote}
    ${sections}`;
}
