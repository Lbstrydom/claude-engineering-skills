/**
 * @fileoverview Skills tab renderer.
 *
 * Plan: docs/plans/sustainability-cleanup-batch.md (WS2).
 *
 * Signature contract (locked): `default(viewModel, ui) → string`.
 *   viewModel = { src, skills }
 *     src    — `data.sources.skills` status object
 *     skills — `data.skills` array
 *   ui = frozen helpers bundle from helpers.mjs::buildUi()
 *
 * Sections do NOT import helpers.mjs directly — receive everything via
 * the `ui` arg. Enforced by tests/dashboard-section-contract.test.mjs.
 *
 * @module scripts/lib/dashboard/sections/skills
 */

const SECTION = 'skills';

/**
 * @param {{src: {status: string, detail: string}, skills: object[]}} viewModel
 * @param {object} ui  — { escapeHtml, warningPanel, emptyPanel, splitUsage, NON_OK, ... }
 */
export default function sectionSkills({ src, skills }, ui) {
  if (ui.NON_OK.has(src.status)) return ui.warningPanel(SECTION, src);
  if (!skills.length) return ui.emptyPanel(null, 'No skills found in skills/.');
  const cards = skills.map((s) => {
    // Usage lines are part of the search haystack too — so a query like
    // "--with-gemini" finds /brainstorm.
    const haystack = ui.escapeHtml(
      [s.name, s.oneLiner, s.triggers.join(' '), s.usage.join(' ')].join(' ').toLowerCase(),
    );
    const chips = s.triggers.slice(0, 6)
      .map((t) => `<span class="chip">${ui.escapeHtml(t)}</span>`).join('');
    const lock = s.disableModelInvocation ? ' <span class="lock" title="manual invocation only">&#128274;</span>' : '';
    const hid = `skill-h-${ui.escapeHtml(s.name)}`;
    // Usage / flag shortlist — command + description as a wrapping list, so
    // nothing is clipped at the card edge.
    const usage = s.usage.length
      ? `<div class="usage-block"><span class="usage-label">Usage</span><ul class="usage-list">`
        + s.usage.map((u) => {
          const { cmd, desc } = ui.splitUsage(u);
          return `<li><code>${ui.escapeHtml(cmd)}</code>`
            + `${desc ? `<span class="usage-desc">${ui.escapeHtml(desc)}</span>` : ''}</li>`;
        }).join('')
        + '</ul></div>'
      : '';
    return `<article class="card" data-search="${haystack}" aria-labelledby="${hid}">
      <h3 id="${hid}"><code>/${ui.escapeHtml(s.name)}</code>${lock}</h3>
      <p class="oneliner">${ui.escapeHtml(s.oneLiner)}</p>
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
