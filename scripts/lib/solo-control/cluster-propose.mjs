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
 * INTERNAL SUB-BATCHING (found live, audit-effectiveness Phase 4 run 2): the
 * caller already batches PER COMMIT (a finding in commit X can never be "the same
 * defect" as one in commit Y), but a single large commit's batch can still exceed
 * one call's practical output budget — a ~300-row commit (ff20d85e, the 361K-char
 * wine-cellar commit) silently degraded EVERY row to its own singleton cluster
 * (312 sheet-rows, 312 clusters — essentially no grouping), because the model
 * cannot emit a full index-partition of 300 items within one response. So this
 * module now chunks internally at a safe size and unions the per-chunk proposals —
 * cross-chunk duplicates within the same giant commit won't merge (an accepted,
 * documented degradation), but WITHIN-chunk grouping works, which is far better
 * than silently degrading the whole commit to dupHash.
 *
 * Plan: docs/plans/audit-effectiveness-experiment.md (Phase 4).
 *
 * @module scripts/lib/solo-control/cluster-propose
 */

import crypto from 'node:crypto';
import { classifyPath } from '../sensitive-paths.mjs';
import { redactSecrets } from '../secret-patterns.mjs';
import { assertEgressSafe } from '../sensitive-egress-gate.mjs';

// Max rows per LLM clustering call. A full index-partition response for N rows
// needs roughly N small integers + brackets/commas — at N=300 that alone can
// approach the ~4000-token output budget before accounting for any grouping
// logic, and was observed to silently degrade in practice. 50 leaves real margin.
const MAX_ROWS_PER_CALL = 50;

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
].join('\n');

// The JSON contract goes LAST in the USER turn, not the system prompt — the
// agentic `claude -p` cli backend (used by createAnthropicClient's cli backend)
// ignores a JSON instruction placed only in system and writes conversational
// markdown instead (found live: a 3-row test returned "## Grouping Result" prose,
// the JSON regex found nothing, and the call silently fell back to dupHash).
// Same fix as solo-control-audit.mjs::runPass's JSON_CONTRACT.
const JSON_CONTRACT = [
  'CRITICAL OUTPUT REQUIREMENT: Respond with a SINGLE raw JSON object and NOTHING else —',
  'no markdown, no headers, no prose before or after. Your entire response must be valid JSON',
  'parseable by JSON.parse. Begin your response with { immediately.',
  'Schema: {"clusters":[[<rowIndex>,...], ...]} — each inner array is one group of row indices.',
  'Every provided index must appear in EXACTLY ONE group (no omissions, no duplicates).',
].join('\n');

/**
 * Cluster ONE call-sized chunk (already partitioned to <= MAX_ROWS_PER_CALL).
 * Returns `{clusters: {localClusterId:[localIdx,...]}, mode:'llm'|'duphash-degraded'}`
 * over LOCAL indices (0..chunk.length-1) — the caller remaps to its own index space.
 */
async function proposeChunk(chunk, { client, model }) {
  const dupFallback = () => {
    const groups = dupHashClusters(chunk);
    const clusters = {};
    Object.values(groups).forEach((idxs, n) => { clusters[`c${n}`] = idxs; });
    return { clusters, mode: 'duphash-degraded' };
  };
  if (chunk.length === 0) return { clusters: {}, mode: 'llm' };
  if (!client) return dupFallback(); // no client available → degrade, never silently drop rows

  const lines = chunk.map((r, j) => redactSecrets(`[${j}] ${r.category || ''} :: ${r.file || ''} :: ${r.detail || ''}`).text);
  const payload = lines.join('\n');
  try {
    assertEgressSafe(payload, { label: 'cluster-propose' });
  } catch {
    return dupFallback(); // a secret slipped the redactor → never send
  }

  let parsed = null;
  const userMsg = `Group these ${chunk.length} findings (indices are LOCAL to this list):\n${payload}\n\n${JSON_CONTRACT}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await client.messages.create({
        model, max_tokens: 4000, system: PROPOSE_SYSTEM,
        messages: [{ role: 'user', content: attempt === 1 ? userMsg : userMsg + '\n\nYour previous reply was not valid JSON. Reply with ONLY the JSON object.' }],
      }, { timeoutMs: 120000 });
      const raw = Array.isArray(resp.content) ? resp.content.map((c) => c.text || '').join('') : '';
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
      if (parsed) break;
    } catch { /* try next attempt, or fall through to dupFallback() below */ }
  }
  if (!parsed || !Array.isArray(parsed.clusters)) return dupFallback();

  // Validate the partition (every local index appears exactly once — else the
  // response can't be trusted as a real partition; fall back rather than guess).
  const seen = new Set();
  const clusters = {};
  let n = 0;
  for (const group of parsed.clusters) {
    if (!Array.isArray(group)) continue;
    const local = [];
    for (const li of group) {
      if (typeof li !== 'number' || li < 0 || li >= chunk.length || seen.has(li)) continue;
      seen.add(li); local.push(li);
    }
    if (local.length) clusters[`c${n++}`] = local;
  }
  // Any index the LLM dropped → its own singleton (over-split, never lost).
  for (let li = 0; li < chunk.length; li++) if (!seen.has(li)) clusters[`c${n++}`] = [li];
  return { clusters, mode: 'llm' };
}

/**
 * Propose clusters over the given rows. Internally sub-batches at
 * MAX_ROWS_PER_CALL and unions the per-chunk proposals (cross-chunk duplicates
 * within one oversized commit won't merge — accepted, documented degradation;
 * see module header). Returns
 * `{ clusters: {clusterId:[rowIdx]}, mode: 'llm'|'duphash-degraded'|'llm+duphash-degraded', excludedSensitive: number }`.
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

  const clusters = {};
  let n = 0;
  const modesUsed = new Set();

  if (sendable.length > 0) {
    for (let start = 0; start < sendable.length; start += MAX_ROWS_PER_CALL) {
      const chunk = sendable.slice(start, start + MAX_ROWS_PER_CALL);
      const chunkIdx = sendableIdx.slice(start, start + MAX_ROWS_PER_CALL);
      const result = await proposeChunk(chunk, { client, model });
      modesUsed.add(result.mode);
      for (const localIdxs of Object.values(result.clusters)) {
        clusters[`c${n++}`] = localIdxs.map((li) => chunkIdx[li]);
      }
    }
  }

  // Sensitive rows → dupHash groups appended (kept out of the LLM entirely).
  const sensGroups = dupHashClusters(sensitiveIdx.map((i) => rows[i]));
  Object.values(sensGroups).forEach((localIdxs) => { clusters[`s${n++}`] = localIdxs.map((li) => sensitiveIdx[li]); });

  const mode = modesUsed.size === 0 ? 'llm' : modesUsed.size === 1 ? [...modesUsed][0] : 'llm+duphash-degraded';
  return { clusters, mode, excludedSensitive: sensitiveIdx.length };
}
