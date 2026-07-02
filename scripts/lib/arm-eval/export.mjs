/**
 * @fileoverview Committed session archive for the arm-eval experiment
 * (operator request 2026-07-02): every session exports a timestamped markdown
 * record under `docs/arm-eval/sessions/` so the experiment is auditable by a
 * third party WITHOUT database access. The DB stays canonical; these files are
 * an append-style export (write-once per session + ONE upgrade when the human
 * ranking lands), not a regenerable build artifact — which is why they are
 * committed rather than gitignored.
 *
 * BLINDING RULE (load-bearing — protects the human-anchor integrity):
 *   - `phase='prospective'` session WITHOUT a human ranking → exports BLINDED:
 *     outputs appear under their opaque presentation labels; arm identity,
 *     per-arm models, and judge scores are withheld (any of them would let the
 *     operator infer attribution before ranking).
 *   - session WITH a human ranking, or `phase='calibration'` (never part of
 *     the anchor pool) → exports FULL: attribution, models, judge scores,
 *     ranking.
 *   `arm-eval-adjudicate --ranked` re-exports, upgrading blinded → full.
 *
 * Filename: `<UTC yyyymmdd-hhmmss>__<experiment>__<phase>__<taskId>__<sid8>.md`
 * — sorts chronologically, self-describes what ran when.
 *
 * @module scripts/lib/arm-eval/export
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../file-io.mjs';
import { redactSecrets as shapeRedact } from '../secret-patterns.mjs';

export const SESSIONS_DIR = path.join('docs', 'arm-eval', 'sessions');

/** Deterministic archive filename for a session row. */
export function filenameFor(session) {
  const ts = new Date(session.created_at).toISOString()
    .replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // yyyymmdd-hhmmss
  const sid8 = String(session.session_id).slice(0, 8);
  return `${ts}Z__${session.experiment_type}__${session.phase || 'unphased'}__${session.task_id}__${sid8}.md`;
}

const redact = (s) => (typeof s === 'string' ? shapeRedact(s).text : s);

/**
 * Render one session's archive markdown from the store's export data.
 * Pure — no I/O; the blinding rule lives here so it's directly testable.
 */
export function buildSessionMarkdown({ session, runs = [], judgments = [], rankings = [] }) {
  const ranked = rankings.length > 0;
  const blinded = session.phase === 'prospective' && !ranked;
  const runById = new Map(runs.map((r) => [r.run_id, r]));

  const head = [
    `# Arm-eval session ${session.session_id}`,
    '',
    '| Field | Value |',
    '|---|---|',
    `| Experiment | ${session.experiment_type} |`,
    `| Phase | ${session.phase || '—'} |`,
    `| Task id | \`${session.task_id}\` |`,
    `| Seed (presentation-order RNG) | ${session.seed ?? '—'} |`,
    `| Config / rubric version | ${session.config_version ?? '—'} / ${session.rubric_version ?? '—'} |`,
    `| Created (UTC) | ${new Date(session.created_at).toISOString()} |`,
    `| Repo | ${session.repo_id ?? '—'} |`,
    `| Archive mode | ${blinded ? 'BLINDED (prospective, human ranking pending — arm identity/models/scores withheld to protect the anchor)' : 'FULL (attribution + judgments)'} |`,
    '',
    '## Task',
    '',
    session.task_text ? redact(session.task_text) : '_task text not recorded (pre-migration session)_',
    '',
  ];

  const body = [];
  if (blinded) {
    // Outputs by presentation label ONLY (label order from pass-1 judgments).
    const labelByRun = new Map();
    for (const j of judgments) if (j.judge_pass === 1) labelByRun.set(j.run_id, `output-${j.presentation_order}`);
    const labeled = runs
      .filter((r) => r.output_ref)
      .map((r) => ({ label: labelByRun.get(r.run_id) || null, text: r.output_ref }))
      .filter((o) => o.label)                       // unjudged runs have no label → withheld
      .sort((a, b) => a.label.localeCompare(b.label));
    body.push('## Outputs (blinded — rank via `arm-eval-adjudicate`)', '');
    if (!labeled.length) body.push('_no judged outputs to display blinded_', '');
    for (const o of labeled) body.push(`### ${o.label}`, '', redact(o.text), '');
  } else {
    body.push('## Arms + outputs', '');
    for (const r of runs) {
      const models = r.resolved_model ? JSON.stringify(r.resolved_model) : '—';
      body.push(`### Arm ${r.arm}`, '', `- Models: \`${models}\``, `- Conformant: ${r.producer_conformant}`, `- Output hash: \`${r.output_hash ?? '—'}\``, '');
      if (r.output_ref) body.push(redact(r.output_ref), '');
    }
    if (judgments.length) {
      body.push('## Judge scores (blinded at judge time; unblinded here post-ranking)', '');
      body.push('| Pass | Label | Arm | Scores |', '|---|---|---|---|');
      for (const j of judgments) {
        const arm = runById.get(j.run_id)?.arm ?? '?';
        body.push(`| ${j.judge_pass} | output-${j.presentation_order} | ${arm} | \`${JSON.stringify(j.scores)}\` |`);
      }
      body.push('');
    }
    if (ranked) {
      body.push('## Human ranking (best → worst)', '');
      for (const rk of rankings) {
        const labels = Array.isArray(rk.ranked_labels) ? rk.ranked_labels.join(' > ') : JSON.stringify(rk.ranked_labels);
        body.push(`- ${labels}${rk.reviewer ? ` — ${rk.reviewer}` : ''} (${new Date(rk.created_at).toISOString()})`);
      }
      body.push('');
    }
  }
  return head.concat(body).join('\n');
}

/**
 * Export one session to the archive. Best-effort by contract — callers on the
 * run path treat a failure as non-fatal (the DB record is canonical).
 * @returns {{written:boolean, file?:string, reason?:string}}
 */
export async function exportSession(sessionId, { repoRoot = process.cwd(), store = null } = {}) {
  const s = store || await import('../store/arm-eval.mjs');
  const data = await s.getSessionExportData(sessionId);
  if (!data.cloud || !data.session) return { written: false, reason: data.cloud ? 'session-not-found' : 'cloud-off' };
  const dir = path.join(repoRoot, SESSIONS_DIR);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, filenameFor(data.session));
  atomicWriteFileSync(file, buildSessionMarkdown(data) + '\n');
  return { written: true, file: path.join(SESSIONS_DIR, filenameFor(data.session)) };
}
