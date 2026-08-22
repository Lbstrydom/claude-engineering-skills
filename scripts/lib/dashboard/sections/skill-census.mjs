/**
 * @fileoverview Skill-efficacy census tab — docs/plans/skill-efficacy-census.md
 * Phase 3. One row per bundled skill: signal source, evidence quality,
 * current/prior window, trend, conversion rate (where applicable), last-run.
 *
 * Signature contract (locked): `default(viewModel, ui) → string`.
 *   viewModel = { src, skillCensus }
 *     src         — `data.sources.skillCensus` status object
 *     skillCensus — `data.skillCensus` object ({cloud, repoId, repoName, windowDays, rows})
 *   ui = frozen helpers bundle from helpers.mjs::buildUi()
 *
 * @module scripts/lib/dashboard/sections/skill-census
 */

const SECTION = 'skillCensus';

function pct(v, ui) {
  if (v == null) return '<span class="muted">—</span>';
  return ui.escapeHtml(`${v > 0 ? '+' : ''}${v}%`);
}

function conversionRate(cr, ui) {
  if (!cr) return '<span class="muted">n/a</span>';
  const { numerator, denominator } = cr.current;
  if (denominator === 0) return '<span class="muted" title="no accepted findings in this window">—</span>';
  const p = Math.round((numerator / denominator) * 100);
  return `${ui.escapeHtml(String(p))}% <span class="muted">(${ui.escapeHtml(String(numerator))}/${ui.escapeHtml(String(denominator))}, right-censored)</span>`;
}

export default function sectionSkillCensus({ src, skillCensus }, ui) {
  // (1) collector-level failure → warningPanel, same as every other section.
  if (ui.NON_OK.has(src.status) && src.status !== 'missing-optional') return ui.warningPanel(SECTION, src);
  if (!skillCensus || !Array.isArray(skillCensus.rows) || skillCensus.rows.length === 0) {
    return ui.emptyPanel(null, src.detail || 'Skill-census telemetry unavailable.');
  }

  const rows = skillCensus.rows.map((r) => {
    // (2) all DB-backed rows missing-optional while trailer-proxy rows still
    // have data: each row renders its OWN caveat inline — never one blanket
    // panel for the whole tab.
    const current = r.window.current == null
      ? '<span class="muted" title="missing-optional">—</span>'
      : ui.escapeHtml(String(r.window.current));
    const prior = r.window.prior == null ? '<span class="muted">—</span>' : ui.escapeHtml(String(r.window.prior));
    const allTime = r.allTimeCount == null ? '<span class="muted">—</span>' : ui.escapeHtml(String(r.allTimeCount));
    // (4) a zero-count window still renders the row — count:0 is real data,
    // never a vanished row (indistinguishable from a rendering bug).
    return `<tr data-search="${ui.escapeHtml(r.skill.toLowerCase())}">
      <td><code>${ui.escapeHtml(r.skill)}</code></td>
      <td>${ui.escapeHtml(r.signalSource)}</td>
      <td>${ui.escapeHtml(r.signalQuality)}${r.effectiveSince ? ` <span class="muted">(since ${ui.escapeHtml(r.effectiveSince)})</span>` : ''}</td>
      <td>${current} <span class="muted">/ ${prior} prior</span></td>
      <td>${pct(r.trend.pct, ui)}</td>
      <td>${allTime}</td>
      <td>${conversionRate(r.conversionRate, ui)}</td>
      <td>${r.lastRunAt ? ui.escapeHtml(r.lastRunAt) : '<span class="muted">—</span>'}</td>
      <td class="muted">${ui.escapeHtml(r.caveat)}</td>
    </tr>`;
  }).join('');

  const cloudNote = skillCensus.cloud
    ? ''
    : '<p class="muted">⚠ cloud store off this run — DB-backed rows above show missing-optional; trailer-proxy rows still reflect this checkout.</p>';

  // (3) a skill with no conversion-rate metric renders "n/a" (via
  // conversionRate() above), never a blank cell — blank would read as
  // "data missing" rather than "doesn't apply to this skill".
  return `<p class="muted">Repo: ${ui.escapeHtml(skillCensus.repoName ?? '(unresolved)')} · window: ${ui.escapeHtml(String(skillCensus.windowDays))}d.</p>
  ${cloudNote}
  <div class="searchbar">
    <label for="skill-census-search">Filter skills</label>
    <input type="search" role="searchbox" id="skill-census-search" data-role="skill-census-search" placeholder="skill name…">
  </div>
  <div class="table-wrap"><table><thead><tr>
    <th>Skill</th><th>Signal source</th><th>Evidence quality</th><th>Window (current/prior)</th>
    <th>Trend</th><th>All-time</th><th>Conversion rate</th><th>Last run</th><th>Caveat</th>
  </tr></thead><tbody>${rows}</tbody></table></div>`;
}
