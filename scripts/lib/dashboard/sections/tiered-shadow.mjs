/**
 * @fileoverview Tiered Shadow tab — the tiered-recall pipeline's Close-out
 * shadow-validation progress toward the Phase-14 production-flip decision
 * (docs/completed/tiered-recall-audit-pipeline.md). Read-only visual surface;
 * `npm run audit:tiered-shadow-report` stays the authoritative operator CLI
 * (both reuse the SAME summarize(), so they can never disagree on the math).
 * Signature: `default({src, tieredShadow}, ui) → string`.
 *
 * @module scripts/lib/dashboard/sections/tiered-shadow
 */

const SECTION = 'tieredShadow';

export default function sectionTieredShadow({ src, tieredShadow }, ui) {
  if (ui.NON_OK.has(src.status)) return ui.warningPanel(SECTION, src);
  const t = tieredShadow;
  if (src.status === 'missing-optional' || !t || t.source === 'none') {
    return ui.emptyPanel(null,
      'No shadow runs recorded yet. With AUDIT_TIERED_SHADOW_ENABLED=true in ~/.audit-loop.env, '
      + 'every /audit-code run silently also runs the new tiered pipeline and records a comparison here.');
  }

  // Gated on comparedRuns (decision-grade data points), not totalRuns — a
  // shadow attempt that failed outright contributes no cost/latency/overlap
  // signal, so it can't count toward "ready to decide" even though it's a
  // real, informative failure (surfaced separately via shadowFailures).
  // windowMet is computed server-side (collect-telemetry.mjs) against the
  // SAME threshold; re-derived here only for the two intermediate render
  // states (progress bar %, "within window but not met yet" message).
  const n = t.comparedRuns;
  const pctOfMax = Math.min(100, Math.round((100 * n) / t.windowMax));
  const windowState = t.windowMet
    ? { cls: 'ok', msg: `Window met (${n}/${t.windowMax} compared runs) — time for the Phase-14 production-flip review.` }
    : n >= t.windowMin
      ? { cls: 'ok', msg: `${n}/${t.windowMax} compared runs — inside the pre-registered ${t.windowMin}–${t.windowMax} window; a few more before the Phase-14 review.` }
      : { cls: 'muted', msg: `${n}/${t.windowMin}–${t.windowMax} compared runs — keep collecting before treating this as a decision basis.` };
  const attemptsNote = t.totalRuns !== t.comparedRuns
    ? `<p class="muted">${ui.escapeHtml(t.totalRuns)} total shadow attempts recorded (${ui.escapeHtml(t.totalRuns - t.comparedRuns)} did not produce a usable comparison — see failures below).</p>`
    : '';
  const truncatedNote = t.truncated
    ? '<p class="warn">⚠ This cloud read hit the query limit — the newest observations may be missing from this summary. Re-run once the row count settles, or narrow with <code>--repos</code>.</p>'
    : '';

  // The badge answers "is THIS machine/environment recording new runs right
  // now" — a distinct question from "does data already exist" (cloud data
  // can be aggregated from OTHER repos' shadow-enabled runs even when this
  // repo's own flag is off). Labelled accordingly so the two can't be
  // conflated (L1 fix, 2026-07-13).
  const flagBadge = t.flagEnabled
    ? '<span class="badge badge-ok" title="AUDIT_TIERED_SHADOW_ENABLED=true in this environment — every /audit-code run here records a comparison">recording here: ON</span>'
    : '<span class="badge badge-warn" title="AUDIT_TIERED_SHADOW_ENABLED is not true in THIS environment — no new comparisons are being recorded from here (the numbers below may still include runs from other repos/machines)">recording here: OFF</span>';

  // Suffix/prefix render ONLY with a real value — "—s"/"$—" would read as a
  // broken number rather than "no data yet".
  const fmt = (v, digits = 2, prefix = '', suffix = '') => (v == null ? '—' : `${prefix}${v.toFixed(digits)}${suffix}`);
  const pctFmt = (v) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`);

  const perRepoRows = t.perRepo.length
    ? t.perRepo.map((r) => `<tr><td>${ui.escapeHtml(r.label)}</td><td>${ui.escapeHtml(r.count)}</td></tr>`).join('')
    : `<tr><td colspan="2" class="muted">${t.source === 'cloud' ? 'No runs recorded yet in any repo.' : 'No per-repo breakdown (local-only view).'}</td></tr>`;

  const statusCounts = Object.entries(t.tieredRunStatusCounts);
  const statusLine = statusCounts.length
    ? statusCounts.map(([k, v]) => `${ui.escapeHtml(k)}: ${ui.escapeHtml(v)}`).join(' · ')
    : '—';

  return `<p class="panel-lede">The <strong>tiered audit pipeline</strong> is a cheaper, staged alternative to the
    current always-on 5-pass GPT audit. Before it can become the default, it runs in <em>shadow mode</em>:
    every real <code>/audit-code</code> run ALSO runs the new pipeline silently and records a side-by-side
    comparison (cost, speed, finding overlap). Once ${ui.escapeHtml(t.windowMin)}–${ui.escapeHtml(t.windowMax)} comparisons accumulate,
    the <strong>Phase-14 decision</strong> reviews these numbers and decides: flip the new pipeline to
    production default, or stay on the current one. ${flagBadge}</p>

    <h3>Window progress</h3>
    <div class="progress-track" role="progressbar" aria-valuenow="${ui.escapeHtml(n)}" aria-valuemin="0" aria-valuemax="${ui.escapeHtml(t.windowMax)}"
      aria-label="Compared shadow-validation runs collected toward the Phase-14 window">
      <div class="progress-fill" style="width:${pctOfMax}%"></div>
      <span class="progress-label">${ui.escapeHtml(n)} / ${ui.escapeHtml(t.windowMax)} compared runs</span>
    </div>
    <p class="${windowState.cls}">${ui.escapeHtml(windowState.msg)}</p>
    ${attemptsNote}
    ${truncatedNote}

    <div class="kv">
      <div><span class="muted">Data source</span> <strong>${ui.escapeHtml(t.source === 'cloud' ? `cloud (cross-repo)` : 'local log (this repo only)')}</strong></div>
      <div><span class="muted">Compared runs</span> <strong>${ui.escapeHtml(t.comparedRuns)}</strong> <span class="muted">(both pipelines completed)</span></div>
      <div><span class="muted">Legacy failures</span> <strong>${ui.escapeHtml(t.legacyFailures)}</strong> · <span class="muted">Shadow failures</span> <strong>${ui.escapeHtml(t.shadowFailures)}</strong></div>
      <div><span class="muted">Cost delta (tiered − legacy)</span> <strong>${fmt(t.costDeltaUsd.mean, 3, '$')}</strong> <span class="muted">mean · negative = tiered cheaper</span></div>
      <div><span class="muted">Latency delta</span> <strong>${fmt(t.latencyDeltaSec.mean, 1, '', 's')}</strong> <span class="muted">mean · negative = tiered faster</span></div>
      <div><span class="muted">Finding overlap</span> <strong>${pctFmt(t.findingOverlapRate.mean)}</strong> <span class="muted">mean · how much of the legacy audit's findings the tiered run also caught</span></div>
      <div><span class="muted">Tiered run status</span> <span>${statusLine}</span></div>
    </div>

    <h3>Runs per repo</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Repo</th><th>Shadow runs</th></tr></thead>
      <tbody>${perRepoRows}</tbody>
    </table></div>

    <p class="muted">Authoritative CLI: <code>npm run audit:tiered-shadow-report</code> (add
    <code>--repos &lt;path,...&gt;</code> from a sibling checkout). The Phase-14 review is a
    decision gate — an operator reads these numbers before any flip; inconclusive means stay
    on legacy and extend the window. Plan: docs/completed/tiered-recall-audit-pipeline.md.</p>`;
}
