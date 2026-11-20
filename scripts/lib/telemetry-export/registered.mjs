/**
 * @fileoverview Wire the pure reader to this machine: the registered consumers that declared a
 * `telemetry` block, and the drop directory named by `TELEMETRY_DROP_DIR`.
 *
 * CES-only (it reads the gitignored consumer registry); never part of the consumer bundle.
 * Returns `null` when no consumer is expected to export — then nothing is rendered and nothing
 * changes for anyone who has not opted in.
 *
 * @module scripts/lib/telemetry-export/registered
 */
import { expectedExporters } from '../consumer-repos.mjs';
import { scanDrop } from './reader.mjs';

/**
 * @param {object} [p]
 * @param {Date} [p.now]
 * @param {string|null} [p.dropDir]
 * @param {Array<{alias: string, cadence: string}>} [p.expected]  override (tests)
 * @returns {ReturnType<typeof scanDrop>|null}
 */
export function scanRegistered({ now = new Date(), dropDir = process.env.TELEMETRY_DROP_DIR || null, expected = expectedExporters() } = {}) {
  if (expected.length === 0) return null;
  return scanDrop({ dropDir, expected, now });
}
