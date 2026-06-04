/**
 * @fileoverview Prompt-variant (bandit) effectiveness tab — surfaces the
 * Thompson-sampling arms (pass × variant) with their posterior mean + pulls.
 *
 * Cluster D / Phase 7 of docs/plans/learning-store-signal-recovery.md.
 *
 * Signature: `default({src, promptVariants}, ui) → string`.
 *
 * @module scripts/lib/dashboard/sections/prompt-variants
 */

const SECTION = 'promptVariants';

export default function sectionPromptVariants({ src, promptVariants }, ui) {
  if (ui.NON_OK.has(src.status)) return ui.warningPanel(SECTION, src);
  const pv = promptVariants;
  if (src.status === 'missing-optional') {
    return ui.emptyPanel(null, src.detail || 'Prompt-variant telemetry unavailable.');
  }
  if (!pv || !pv.cloud) {
    return ui.emptyPanel(null, 'Bandit telemetry needs cloud + a service-role key.');
  }
  if (!pv.arms.length) {
    return ui.emptyPanel(null, 'No bandit arms yet — they accrue from deliberation/rebuttal runs.');
  }
  const rows = pv.arms.map((a) => {
    // A `default` variant with 0 pulls is a cold-start seed, not learned signal.
    const seed = a.pulls === 0 ? ' <span class="muted">(cold-start)</span>' : '';
    return `<tr>
      <td>${ui.escapeHtml(a.passName)}</td>
      <td><code>${ui.escapeHtml(a.variantId)}</code>${seed}</td>
      <td>${ui.escapeHtml(a.pulls)}</td>
      <td>${ui.escapeHtml(a.mean.toFixed(2))}</td>
      <td class="muted">${ui.escapeHtml(a.alpha)}/${ui.escapeHtml(a.beta)}</td>
    </tr>`;
  }).join('');
  return `<p class="muted">Thompson-sampling arms (global bucket). Posterior mean = α/(α+β); higher = the deliberation sustained that variant's findings more often.</p>
  <div class="table-wrap"><table><thead><tr>
    <th>Pass</th><th>Variant</th><th>Pulls</th><th>Posterior mean</th><th>α/β</th>
  </tr></thead><tbody>${rows}</tbody></table></div>`;
}
