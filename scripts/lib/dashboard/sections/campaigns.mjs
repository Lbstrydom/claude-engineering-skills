/**
 * @fileoverview Campaigns tab — the decision console from plan §2.5d.
 *
 * TWO panes, strictly ordered, and the order is the design (§3): evidence
 * quality first, standings second. The eye must cross the gates that qualify a
 * number before it reaches the number.
 *
 * Signature: `default({src, campaigns}, ui) → string`.
 *
 * **This page renders the least trustworthy content in the repo** — model-
 * authored finding prose, and free-text human override notes. "It's a local
 * static file" is not a safety argument: the file is generated from provider
 * output and opened in a browser. Every dynamic value goes through
 * `ui.escapeHtml`, attribute contexts are quoted and escaped separately from
 * text contexts, and the copy affordance carries its command in a `data-`
 * attribute read by a delegated handler — never an inline `onclick` built from
 * a finding id.
 *
 * No CSP is emitted, deliberately (plan §4, corrected by shadow/S6): this is a
 * SECTION of one generated document whose `<style>`/`<script>` are inline by
 * design, so a document-level `script-src` without `'unsafe-inline'` would
 * disable `dashboard.js` outright and break every existing tab. Escaping is the
 * control here, and the injection sink is text content.
 *
 * @module scripts/lib/dashboard/sections/campaigns
 */

const SECTION = 'campaigns';

/** `unknown` is a WORD, never a dash and never $0.00 — lesson (e) applied to
 *  pixels. A blank or an em-dash reads as zero at a glance, and a zero here
 *  would be a claim that the call was measured and cost nothing. */
function money(usd, evidence) {
  if (evidence && evidence !== 'known') return 'unknown';
  if (usd == null || !Number.isFinite(usd)) return 'unknown';
  return `$${Number(usd).toFixed(4)}`;
}

function pct(v) {
  return v == null ? 'unknown' : `${Math.round(v * 100)}%`;
}

export default function sectionCampaigns({ src, campaigns }, ui) {
  if (ui.NON_OK.has(src.status)) return ui.warningPanel(SECTION, src);
  const data = campaigns || { campaigns: [], degraded: false };

  if (src.status === 'missing-optional') {
    return ui.emptyPanel(null, src.detail
      || 'No campaigns declared — see docs/runbooks/model-campaigns.md to declare one in .campaigns/.');
  }

  // Store-offline: the evidence pane still renders (it says WHY), and standings
  // are ABSENT rather than empty. An empty standings table and an unmeasured one
  // are the same pixels.
  if (data.degraded) {
    return `<section data-testid="campaign-evidence" role="region" aria-label="Campaign evidence quality">`
      + `<h4>Evidence quality</h4>`
      + `<p class="summary">⚠ <strong>Store unavailable — standings withheld.</strong> ${ui.escapeHtml(data.degradedReason || '')}</p>`
      + (data.declaredIds?.length
          ? `<p class="summary">Declared campaigns: ${data.declaredIds.map((i) => `<code>${ui.escapeHtml(i)}</code>`).join(', ')}</p>`
          : '')
      + `</section>`;
  }

  if (!data.campaigns?.length) {
    return ui.emptyPanel(null, 'No campaigns declared — see docs/runbooks/model-campaigns.md.');
  }

  return data.campaigns.map((c) => renderCampaign(c, ui)).join('');
}

function renderCampaign(c, ui) {
  return `<article class="campaign">${evidencePane(c, ui)}${standingsPane(c, ui)}${reviewPane(c, ui)}</article>`;
}

/** Pane 1 — always shown, always first. */
function evidencePane(c, ui) {
  const rows = [];
  rows.push(`<tr><th scope="row">Lock digest</th><td><code>${ui.escapeHtml(c.lockDigest || 'not yet collected')}</code>`
    + `${c.cohortSuperseded ? ' <strong>SUPERSEDED</strong> — this cohort was orphaned by a contract change' : ''}</td></tr>`);
  rows.push(`<tr><th scope="row">N complete</th><td>${ui.escapeHtml(c.nComplete ?? 0)} of ${ui.escapeHtml(c.targetN)} target</td></tr>`);

  if (c.completion?.incomplete?.length) {
    const list = c.completion.incomplete
      .map((r) => `<li><code>${ui.escapeHtml(r.snapshotId)}</code> — missing ${ui.escapeHtml((r.missingArms || []).join(', '))}</li>`)
      .join('');
    // Named, never rounded up to complete and never silently dropped: N is the
    // denominator every effectiveness number divides by.
    rows.push(`<tr><th scope="row">Incomplete snapshots</th><td><ul>${list}</ul></td></tr>`);
  }

  const spend = Object.entries(c.spend || {}).map(([armId, s]) => {
    const attempts = s.attempts > 1 ? ` <em>(${ui.escapeHtml(s.attempts)} attempts — a retried arm was paid for twice)</em>` : '';
    return `<tr><td>${ui.escapeHtml(armId)}</td><td data-testid="campaign-spend-${ui.escapeHtml(armId)}">${ui.escapeHtml(money(s.spendUsd, s.costEvidence))}${attempts}</td></tr>`;
  }).join('');
  rows.push(`<tr><th scope="row">Per-arm spend</th><td><table><thead><tr><th>Arm</th><th>Spend</th></tr></thead><tbody>${spend}</tbody></table>`
    + `<p class="summary">Sums ALL attempts, superseded included — a superseded attempt was still paid for.</p></td></tr>`);

  rows.push(`<tr><th scope="row">Adjudication overhead</th><td>${ui.escapeHtml(money(c.overhead?.spendUsd, c.overhead?.costEvidence))}`
    + ` over ${ui.escapeHtml(c.overhead?.attempts ?? 0)} attempt(s) — campaign overhead, never folded into per-arm cost-per-accepted</td></tr>`);

  rows.push(`<tr><th scope="row">Adjudication coverage</th><td>${ui.escapeHtml(c.adjudication?.unadjudicatedFindings ?? 0)} finding(s) unadjudicated · `
    + `${ui.escapeHtml(c.adjudication?.humanQueuePending ?? 0)} awaiting a human disposition</td></tr>`);

  const calib = Object.entries(c.calibration || {}).map(([armId, k]) => `<tr><td>${ui.escapeHtml(armId)}</td>`
    + `<td>${ui.escapeHtml(k.dispositioned)}/${ui.escapeHtml(k.assigned)}</td>`
    + `<td>${ui.escapeHtml(pct(k.overrideRate))}</td>`
    + `<td>${ui.escapeHtml(pct(k.selfFamilyShare))}</td></tr>`).join('');
  rows.push(`<tr><th scope="row">Calibration</th><td>${calib
    ? `<table><thead><tr><th>Arm</th><th>Sample reviewed</th><th>Override rate</th><th>Self-family</th></tr></thead><tbody>${calib}</tbody></table>`
    : 'no agent verdicts yet'}</td></tr>`);

  rows.push(`<tr><th scope="row">Replicates</th><td>${c.replicates?.length
    ? `${c.replicates.map((r) => `<code>${ui.escapeHtml(r)}</code>`).join(', ')} — collected, excluded from model-level evidence`
    : 'none declared'}</td></tr>`);

  const notCollected = c.collected === false
    ? `<p class="summary">⚪ ${ui.escapeHtml(c.collectedReason || 'no cohort recorded yet')} — run <code>node scripts/campaign.mjs reconcile --campaign ${ui.escapeHtml(c.id)}</code>.</p>`
    : '';

  return `<section data-testid="campaign-evidence" role="region" aria-label="Campaign evidence quality">`
    + `<h4>Evidence quality — <code>${ui.escapeHtml(c.id)}</code></h4>${notCollected}`
    + `<div class="table-wrap"><table><tbody>${rows.join('')}</tbody></table></div>`
    + `<p class="summary">Lock drift is shown as recorded supersession; run <code>node scripts/campaign.mjs status --campaign ${ui.escapeHtml(c.id)}</code> for a live re-resolution.</p>`
    + `</section>`;
}

/** Pane 2 — watermarked until every gate passes, and the watermark NAMES the
 *  failing gates. Text, not just style: colour alone fails accessibility and
 *  screenshots (§3), and a gate that does not say why reads as arbitrary. */
function standingsPane(c, ui) {
  if (c.collected === false) return '';

  const watermark = c.watermark
    ? `<p class="summary" data-testid="campaign-watermark"><strong>${ui.escapeHtml(c.watermark.label)}</strong> — failing: `
      + c.watermark.failing.map((g) => `<span>${ui.escapeHtml(g.id)} (${ui.escapeHtml(g.detail)})</span>`).join('; ')
      + `</p>`
    : '';

  const advisories = (c.advisories || []).length
    ? `<p class="summary">⚠ ${c.advisories.map((a) => `${ui.escapeHtml(a.id)}: ${ui.escapeHtml(a.detail)}`).join(' · ')}</p>`
    : '';

  // Raw counts sit BESIDE accepted counts, always (§3): lesson (a) was
  // raw-count seduction, and the cure is adjacency, not hiding.
  const armRows = Object.entries(c.floor?.perArm || {}).map(([armId, f]) => {
    const cost = c.cost?.perArm?.[armId];
    const cpa = cost?.costPerAccepted == null ? 'undefined (0 accepted)' : `$${cost.costPerAccepted.toFixed(4)}`;
    return `<tr><td>${ui.escapeHtml(armId)}</td>`
      + `<td>${ui.escapeHtml(f.accepted)}</td>`
      + `<td>${ui.escapeHtml(f.perSnapshot)}</td>`
      + `<td>${f.clears ? '🟢 clears' : `🔴 blocked (relative ${f.clearsRelative ? 'ok' : 'fail'}, above-zero ${f.clearsAbsolute ? 'ok' : 'fail'})`}</td>`
      + `<td>${ui.escapeHtml(c.cost?.evaluated ? cpa : 'not evaluated')}</td></tr>`;
  }).join('');

  const verdict = c.verdict
    ? `<p class="summary"><strong>Verdict:</strong> ${ui.escapeHtml(c.verdict.outcome)}`
      + `${c.verdict.armId ? ` ${ui.escapeHtml(c.verdict.armId)}` : ''} — ${ui.escapeHtml(c.verdict.reason)}</p>`
    : `<p class="summary"><strong>Verdict:</strong> not decision-eligible.</p>`;

  const rule = c.analysisTimeFields || {};
  return `<section data-testid="campaign-standings" role="region" aria-label="Campaign standings">`
    + `<h4>Standings</h4>${watermark}${advisories}`
    + `<p class="summary">State: <strong>${ui.escapeHtml(c.state)}</strong> — ${ui.escapeHtml(c.stateReason)}</p>`
    + `<div class="table-wrap"><table><thead><tr><th>Arm</th><th>Accepted (raw)</th><th>Per snapshot</th><th>Effectiveness floor</th><th>Cost / accepted</th></tr></thead>`
    + `<tbody>${armRows}</tbody></table></div>${verdict}`
    + `<p class="summary">Applied rule (analysis-time, outside every digest): targetN ${ui.escapeHtml(rule.targetN)} · `
    + `${ui.escapeHtml(JSON.stringify(rule.decisionRule || {}))}</p>`
    + `</section>`;
}

/** Pane 3 — the operator's requirement: every finding row carries its evidence
 *  and ONE primary action (§3 #10 — minimal cognitive load). */
function reviewPane(c, ui) {
  const rows = c.review || [];
  if (!rows.length) return '';
  const body = rows.map((r) => {
    const ruled = r.outcome
      ? `${ui.escapeHtml(r.outcome)}${r.method ? ` (${ui.escapeHtml(r.method)})` : ''}${r.adjudicatorKind ? ` · ${ui.escapeHtml(r.adjudicatorKind)}` : ''}`
      : '<em>unadjudicated</em>';
    // The command rides in a data- attribute read by the delegated handler in
    // dashboard.js — never an inline onclick built from a finding id.
    return `<tr><td>${ui.escapeHtml(r.armId)}</td><td>${ui.escapeHtml(r.severity)}</td>`
      + `<td>${ui.escapeHtml(r.category)}</td>`
      + `<td><code>${ui.escapeHtml(r.section || '—')}</code></td>`
      + `<td>${ui.escapeHtml(r.detail || '')}</td>`
      + `<td>${ruled}</td>`
      + `<td><code data-testid="campaign-override-cmd">${ui.escapeHtml(r.overrideCommand)}</code>`
      + ` <button type="button" class="copy-btn" aria-label="Copy override command" `
      + `data-copy="${ui.escapeHtml(r.overrideCommand)}">Copy override</button></td></tr>`;
  }).join('');
  return `<section data-testid="campaign-review" role="region" aria-label="Campaign finding review">`
    + `<h4>Review queue</h4>`
    + `<div class="table-wrap"><table><thead><tr><th>Arm</th><th>Severity</th><th>Category</th><th>Section</th><th>Detail</th><th>Ruling</th><th>Override</th></tr></thead>`
    + `<tbody>${body}</tbody></table></div></section>`;
}
