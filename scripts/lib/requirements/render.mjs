/**
 * @fileoverview Render the requirements ledger as a human-readable map.
 * Plan: docs/plans/requirements-layer.md.
 *
 * A PURE projection of `ledger.json` → a grouped markdown document: a
 * Mermaid pie of the enforced surface, a status table, the needs-review
 * queue, active invariants grouped by kind, and a per-file index. No LLM,
 * no network — the requirements analogue of `arch-render`.
 *
 * @module scripts/lib/requirements/render
 */
import { REQUIREMENT_KINDS } from './schema.mjs';

const STATUS_LABEL = {
  active: '🟢 active — enforced by /audit-code',
  'needs-review': '🟡 needs-review — awaiting your call',
  'inferred-only': '⚪ inferred-only — refine backlog',
  superseded: '⚫ superseded',
};

/** Markdown-table-safe one-liner — strips newlines, escapes pipes. */
const cell = (s) => String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();

/** Distinct provenance files for a requirement. */
const provFiles = (r) => [...new Set((r.provenance || []).map((p) => p.file))];

/**
 * Render the ledger as a grouped markdown map.
 *
 * @param {object} ledger - a `RequirementsLedger`
 * @param {{repoName?: string}} [opts]
 * @returns {string} markdown document
 */
export function renderRequirementsMap(ledger, { repoName = 'this repo' } = {}) {
  const reqs = [...(ledger.requirements || [])].sort((a, b) => a.id.localeCompare(b.id));
  const coveredFiles = [...(ledger.coveredFiles || [])].sort();
  const byStatus = {};
  for (const r of reqs) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  const active = reqs.filter((r) => r.status === 'active');
  const needsReview = reqs.filter((r) => r.status === 'needs-review');

  const out = [];
  out.push(`# Requirements Map — ${repoName}`);
  out.push('');
  out.push(`_Generated from \`.requirements/ledger.json\` — ${reqs.length} requirement(s) `
    + `across ${coveredFiles.length} file(s). Do not hand-edit; regenerate with `
    + `\`node scripts/requirements.mjs render\`._`);
  out.push('');

  // ── At a glance ──────────────────────────────────────────────────────
  out.push('## At a glance');
  out.push('');
  const activeByKind = {};
  for (const r of active) activeByKind[r.kind] = (activeByKind[r.kind] || 0) + 1;
  const pieKinds = REQUIREMENT_KINDS.filter((k) => activeByKind[k]);
  if (pieKinds.length) {
    out.push('```mermaid');
    out.push('pie title Active invariants by kind');
    for (const k of pieKinds) out.push(`  "${k}" : ${activeByKind[k]}`);
    out.push('```');
  } else {
    out.push('_No `active` invariants yet — accept some via `.requirements/overrides.json` '
      + 'to populate the enforced rubric._');
  }
  out.push('');
  out.push('| Status | Count |');
  out.push('|---|---|');
  for (const s of ['active', 'needs-review', 'inferred-only', 'superseded']) {
    if (byStatus[s]) out.push(`| ${STATUS_LABEL[s]} | ${byStatus[s]} |`);
  }
  out.push('');

  // ── Needs review ─────────────────────────────────────────────────────
  if (needsReview.length) {
    out.push(`## 🟡 Needs review (${needsReview.length})`);
    out.push('');
    out.push('| Gap | Assertion | Files |');
    out.push('|---|---|---|');
    for (const r of needsReview) {
      out.push(`| ${cell(r.gap?.gap || '—')} | ${cell(r.assertion)} | ${cell(provFiles(r).join(', '))} |`);
    }
    out.push('');
  }

  // ── Active invariants by kind ────────────────────────────────────────
  out.push('## 🟢 Active invariants — by kind');
  out.push('');
  if (!active.length) {
    out.push('_None yet._');
    out.push('');
  } else {
    for (const k of REQUIREMENT_KINDS) {
      const inKind = active.filter((r) => r.kind === k);
      if (!inKind.length) continue;
      out.push(`### ${k} (${inKind.length})`);
      out.push('');
      out.push('| ID | Assertion | Governs |');
      out.push('|---|---|---|');
      for (const r of inKind) {
        out.push(`| \`${r.id}\` | ${cell(r.assertion)} | ${cell(provFiles(r).join(', '))} |`);
      }
      out.push('');
    }
  }

  // ── Per-file index ───────────────────────────────────────────────────
  out.push('## By file');
  out.push('');
  out.push('| File | 🟢 | 🟡 | ⚪ |');
  out.push('|---|--:|--:|--:|');
  for (const f of coveredFiles) {
    const inF = reqs.filter((r) => provFiles(r).includes(f));
    const a = inF.filter((r) => r.status === 'active').length;
    const n = inF.filter((r) => r.status === 'needs-review').length;
    const i = inF.filter((r) => r.status === 'inferred-only').length;
    out.push(`| \`${f}\` | ${a} | ${n} | ${i} |`);
  }
  out.push('');

  return out.join('\n');
}
