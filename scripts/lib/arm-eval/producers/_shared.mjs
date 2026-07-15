/**
 * @fileoverview Shared helpers for arm-eval producers. Extracted
 * (arch-drift-duplication-cleanup plan) after `hashText` was independently
 * reimplemented identically in `brainstorm.mjs` and `plan.mjs`.
 *
 * @module scripts/lib/arm-eval/producers/_shared
 */

import { createHash } from 'node:crypto';

/** First 16 hex chars of a text's sha256 — a short, stable content fingerprint. */
export function hashText(t) {
  return createHash('sha256').update(t || '').digest('hex').slice(0, 16);
}
