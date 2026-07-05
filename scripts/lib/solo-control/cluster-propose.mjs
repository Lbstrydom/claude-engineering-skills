/**
 * @fileoverview Phase 4 cluster PROPOSER for the audit-effectiveness experiment —
 * the single, isolated, testable seam that suggests duplicate groups across arms'
 * findings so the human adjudicator isn't fatigued reading the same bug N ways.
 *
 * LOAD-BEARING: it PROPOSES ONLY (biased to OVER-SPLIT), never arbitrates. The
 * human keeps a merge/split veto and per-arm finding text stays visible — a wrong
 * merge here would destroy the unique-vs-overlap signal the whole experiment
 * measures (audit R1-H3 / R2-M3; brainstorm "clusterer-as-judge" trap).
 *
 * EGRESS (audit R1-H3): finding rows carry file paths + code snippets. Before the
 * external call, each row is redacted + egress-gated; a sensitive-path row is
 * EXCLUDED from the payload and clustered deterministically by dupHash. Any egress
 * refusal (or LLM failure) falls back to pure dupHash clustering, flagged degraded —
 * it never blocks adjudication and never sends unsafe content.
 *
 * Plan: docs/plans/audit-effectiveness-experiment.md (Phase 4).
 *
 * @module scripts/lib/solo-control/cluster-propose
 */

import crypto from 'node:crypto';
import { classifyPath } from '../sensitive-paths.mjs';
import { redactSecrets } from '../secret-patterns.mjs';
import { assertEgressSafe } from '../sensitive-egress-gate.mjs';

/** Deterministic dup hash — the fallback clusterer + the exclusion path both use it. */
export function dupHash(category, file, detail) {
  const s = `${category || ''}|${file || ''}|${detail || ''}`.toLowerCase().trim();
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);
}

/** Group rows by exact dupHash (deterministic, no network). Used as the safety-net
 * fallback and for sensitive rows that are never sent. */
export function dupHashClusters(rows) {
  const groups = {};
  rows.forEach((r, i) => {
    const h = dupHash(r.category, r.file, r.detail);
    (groups[h] ||= []).push(i);
  });
  return groups;
}

const PROPOSE_SYSTEM = [
  'You group audit findings that describe the SAME underlying defect. BIAS STRONGLY TO OVER-SPLIT:',
  'only group two findings when their ROOT CAUSE and FIX are logically identical. When in doubt, keep them separate.',
  'You are proposing candidate groups for a human to confirm — a wrong merge destroys signal, a wrong split costs the human seconds.',
  'Respond with ONLY JSON: {"clusters":[[<rowIndex>,...], ...]} where each inner array is one group of row indices.',
  'Every provided index must appear in exactly one group. No prose.',
].join('\n');

/**
 * Propose clusters over the given rows. Returns
 * `{ clusters: {clusterId:[rowIdx]}, mode: 'llm'|'duphash-degraded', excludedSensitive: number }`.
 *
 * @param {Array<{category?:string, file?:string, detail?:string}>} rows
 * @param {{ client?: {messages:{create:Function}}, model?: string }} deps
 */
export async function proposeClusters(rows, { client, model = 'claude-sonnet-5' } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return { clusters: {}, mode: 'llm', excludedSensitive: 0 };

  // Partition: sensitive-path rows never leave the machine — cluster them by dupHash.
  const sendable = []; const sendableIdx = []; const sensitiveIdx = [];
  for (let i = 0; i < rows.length; i++) {
    if (classifyPath(rows[i].file || '') !== null) sensitiveIdx.push(i);
    else { sendable.push(rows[i]); sendableIdx.push(i); }
  }

  const fallback = () => {
    // dupHash over ALL rows (safety net), preserving original indices.
    const groups = dupHashClusters(rows);
    const clusters = {};
    Object.values(groups).forEach((idxs, n) => { clusters[`c${n}`] = idxs; });
    return { clusters, mode: 'duphash-degraded', excludedSensitive: sensitiveIdx.length };
  };

  if (!client || sendable.length === 0) return fallback();

  // Build a redacted, egress-safe payload of the SENDABLE rows.
  const lines = sendable.map((r, j) => {
    const text = redactSecrets(`[${j}] ${r.category || ''} :: ${r.file || ''} :: ${r.detail || ''}`).text;
    return text;
  });
  const payload = lines.join('\n');
  try {
    assertEgressSafe(payload, { label: 'cluster-propose' });
  } catch {
    return fallback(); // a secret slipped the redactor → never send
  }

  let parsed = null;
  try {
    const resp = await client.messages.create({
      model, max_tokens: 4000, system: PROPOSE_SYSTEM,
      messages: [{ role: 'user', content: `Group these ${sendable.length} findings (indices are LOCAL to this list):\n${payload}` }],
    }, { timeoutMs: 120000 });
    const raw = Array.isArray(resp.content) ? resp.content.map((c) => c.text || '').join('') : '';
    const m = raw.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : null;
  } catch { return fallback(); }

  if (!parsed || !Array.isArray(parsed.clusters)) return fallback();

  // Map LOCAL sendable indices back to ORIGINAL row indices; validate the partition
  // (every sendable index appears exactly once — else fall back, don't trust it).
  const seen = new Set();
  const clusters = {};
  let n = 0;
  for (const group of parsed.clusters) {
    if (!Array.isArray(group)) continue;
    const orig = [];
    for (const li of group) {
      if (typeof li !== 'number' || li < 0 || li >= sendable.length || seen.has(li)) continue;
      seen.add(li); orig.push(sendableIdx[li]);
    }
    if (orig.length) clusters[`c${n++}`] = orig;
  }
  // Any sendable index the LLM dropped → its own singleton (over-split, never lost).
  for (let li = 0; li < sendable.length; li++) if (!seen.has(li)) clusters[`c${n++}`] = [sendableIdx[li]];
  // Sensitive rows → dupHash groups appended (kept out of the LLM entirely).
  const sensGroups = dupHashClusters(sensitiveIdx.map((i) => rows[i]));
  Object.values(sensGroups).forEach((localIdxs) => { clusters[`s${n++}`] = localIdxs.map((li) => sensitiveIdx[li]); });

  return { clusters, mode: 'llm', excludedSensitive: sensitiveIdx.length };
}
