/**
 * @fileoverview A/B/C Testing tab — the model-A/B/C auditor experiment
 * (arm-eval accumulation state, read-only). Per-arm human-labelled outcomes,
 * native structured-output conformance, spend vs the € budget guard, the
 * pre-registered decision status, and the pending adjudication queue depth.
 * Experiment-wide (assignments accumulate across every toggled-on repo).
 * Signature: `default({src, modelAb}, ui) → string`.
 * Runbook: docs/research/runbooks/model-ab-experiment.md.
 *
 * @module scripts/lib/dashboard/sections/model-ab
 */

const SECTION = 'modelAb';

const ARM_LABELS = {
  A: 'A — GPT audit + Gemini (production control)',
  B: 'B — OSS + 1 GPT round + Gemini',
  C: 'C — OSS + Gemini',
};

export default function sectionModelAb({ src, modelAb }, ui) {
  if (ui.NON_OK.has(src.status)) return ui.warningPanel(SECTION, src);
  const m = modelAb;
  if (src.status === 'missing-optional' || !m || !m.cloud) {
    return ui.emptyPanel(null, (src && src.detail) || 'Model-A/B/C telemetry needs the cloud store.');
  }

  const pct = (num, den) => (den > 0 ? `${((100 * num) / den).toFixed(1)}%` : '—');
  const armRows = m.arms.length
    ? m.arms.map((a) => {
      const labelled = a.accepted + a.dismissed;
      return `<tr>
        <td>${ui.escapeHtml(ARM_LABELS[a.arm] || a.arm)}</td>
        <td>${ui.escapeHtml(a.rows)}</td>
        <td>${ui.escapeHtml(a.accepted)}</td>
        <td>${ui.escapeHtml(a.acceptedHigh)}</td>
        <td>${ui.escapeHtml(a.dismissed)}</td>
        <td>${ui.escapeHtml(pct(a.accepted, labelled))}</td>
        <td>${ui.escapeHtml(a.pending)}</td>
        <td>${ui.escapeHtml(a.passExecutions ? pct(a.conformant, a.passExecutions) : '—')}</td>
        <td>${a.costUsd ? `$${ui.escapeHtml(a.costUsd.toFixed(2))}` : '—'}</td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="9" class="muted">No arm data yet — enable the shadow (arm-eval-toggle on) and run a code audit.</td></tr>';

  const budget = m.capEur != null
    ? `€${ui.escapeHtml(m.spentEur.toFixed(2))} / €${ui.escapeHtml(m.capEur)}`
    : `€${ui.escapeHtml(m.spentEur.toFixed(2))} (no cap configured)`;
  const queueNote = m.pendingAdjudication > 0
    ? `<span class="warn">${ui.escapeHtml(m.pendingAdjudication)} pending</span> — run <code>node scripts/cross-skill.mjs model-ab-adjudicate</code> for the worksheet`
    : '<span class="ok">0 pending</span>';

  return `<p class="muted">Observation-only A/B/C auditor experiment — nothing an arm produces gates or ships.
    Rankings come from the pre-registered decision rule over YOUR adjudication ledger (precision/recall
    caveats: arm A spans historical heterogeneous work; B/C only shadowed runs). Experiment-wide view.</p>
    <div class="kv">
      <div><span class="muted">Decision status</span> <strong>${ui.escapeHtml(m.status)}</strong> <span class="muted">${ui.escapeHtml(m.reason)}</span></div>
      <div><span class="muted">Distinct assignments</span> <strong>${ui.escapeHtml(m.distinctAssignments)}</strong> / ${ui.escapeHtml(m.minAssignments)} required</div>
      <div><span class="muted">Budget</span> <strong>${budget}</strong></div>
      <div><span class="muted">Adjudication queue</span> ${queueNote}</div>
    </div>
    <h3>Per-arm labelled outcomes (human ledger = ground truth)</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Arm</th><th>Runs</th><th>Accepted</th><th>… HIGH</th><th>Dismissed</th><th>Precision (labelled)</th><th>Pending</th><th>Native conformance</th><th>OSS cost</th></tr></thead>
      <tbody>${armRows}</tbody>
    </table></div>
    <p class="muted">CLIs: <code>model-ab-stats</code> (frontier + spend) · <code>model-ab-decision</code> (pre-registered rule) ·
    <code>model-ab-adjudicate</code> (worksheet-first labelling). Runbook: docs/research/runbooks/model-ab-experiment.md.</p>`;
}
