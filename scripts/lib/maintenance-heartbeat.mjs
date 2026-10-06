/**
 * @fileoverview The weekly-maintenance heartbeat: how it is read and when it is overdue.
 * Extracted from `scripts/maintenance-checks.mjs` (a CLI with import side effects, so
 * nothing else could import its reader) so the dashboard Home chip and the CLI interpret
 * the one file the same way.
 *
 * @module scripts/lib/maintenance-heartbeat
 */
import fs from 'node:fs';

export const HEARTBEAT_FILE = 'last-maintenance.json';
export const DEFAULT_INTERVAL_DAYS = 7;

/**
 * Read the heartbeat. A shape-valid-but-incomplete file, or a future timestamp (which
 * would suppress opportunistic work indefinitely), is "never run" (null).
 * @param {string} heartbeatPath
 * @param {{now?: number}} [opts] - epoch ms, injectable
 */
export function loadHeartbeat(heartbeatPath, { now = Date.now() } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(heartbeatPath, 'utf-8'));
    if (!parsed || typeof parsed.lastRunAt !== 'string' || !Array.isArray(parsed.results)) return null;
    const last = Date.parse(parsed.lastRunAt);
    if (Number.isNaN(last) || last > now) return null;
    return parsed;
  } catch { return null; }
}

export function isOverdue(heartbeat, intervalDays = DEFAULT_INTERVAL_DAYS,{ now = Date.now() } = {}) {
  if (!heartbeat || !heartbeat.lastRunAt) return true;
  const last = Date.parse(heartbeat.lastRunAt);
  if (Number.isNaN(last)) return true;
  return (now - last) > intervalDays * 24 * 60 * 60 * 1000;
}
