/**
 * @fileoverview Run counter for meta-assessment interval tracking.
 *
 * Tracks audit run count in .audit/pipeline-state.json so the
 * meta-assessment system knows when to trigger periodic reviews.
 *
 * @module scripts/lib/llm-auditor
 */
import fs from 'node:fs';
import path from 'node:path';

const PIPELINE_STATE_FILE = '.audit/pipeline-state.json';

/**
 * Increment the run counter in pipeline state.
 * Called after each completed audit to track total runs for meta-assessment.
 * @param {string} [statePath]
 */
export function incrementRunCounter(statePath = path.resolve(PIPELINE_STATE_FILE)) {
  try {
    const dir = path.dirname(statePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let state = {};
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf-8')); } catch { /* first run */ }
    state.runCount = (state.runCount || 0) + 1;
    state.lastRunAt = new Date().toISOString();
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch { /* non-fatal */ }
}
