/**
 * @fileoverview Turn a run's raw unified diff into the bounded, filtered,
 * redacted, content-addressed artefact persisted in `audit_run_diffs`
 * (docs/plans/own-model-telemetry-slice-1.md, gap 1).
 *
 * PURE: no I/O. The result is a discriminated `status` so a NULL `diff_ref` on
 * the run row is never ambiguous (refused vs filtered away vs too big vs not a
 * diff run at all). A store write failure is deliberately NOT a status here: the
 * database is what failed, so that outcome is `durableWrite`'s `lost`/`spilled`.
 *
 * Order matters and is fail-closed:
 *   1. drop sections the one path oracle (sensitive-paths.mjs) classifies
 *      `sensitive` or `generatedNoise` — a secrets file's hunks never reach redaction;
 *   2. redact every remaining section (secret-patterns.mjs);
 *   3. REFUSE the whole diff if the secret-pattern scan still matches
 *      after redaction (we store nothing rather than a
 *      diff we cannot vouch for);
 *   4. bound to `maxBytes` of UTF-8 at a section boundary. A first section that
 *      alone exceeds the cap is `oversize-section`: never a partial hunk.
 *
 * @module scripts/lib/audit/diff-capture
 */
import crypto from 'node:crypto';
import { classifyPath } from '../sensitive-paths.mjs';
import { redactSecrets, scanForSecrets } from '../secret-patterns.mjs';
import { parseAllDiffSections } from './evidence-triage.mjs';

export const DEFAULT_MAX_DIFF_BYTES = 256 * 1024;

/**
 * @typedef {{status: 'captured', ref: string, text: string, bytes: number,
 *            truncated: boolean, redactions: number}
 *          | {status: 'refused-secret'|'empty-after-filter'|'oversize-section'|'not-applicable',
 *            redactions: number}} DiffArtifact
 */

/**
 * @param {string|null|undefined} diffText
 * @param {{maxBytes?: number}} [opts]
 * @returns {DiffArtifact}
 */
export function prepareDiffArtifact(diffText, { maxBytes = DEFAULT_MAX_DIFF_BYTES } = {}) {
  if (typeof diffText !== 'string' || diffText.trim() === '') {
    return { status: 'not-applicable', redactions: 0 };
  }
  const sections = parseAllDiffSections(diffText);
  if (sections.length === 0) return { status: 'not-applicable', redactions: 0 };

  let redactions = 0;
  const kept = [];
  for (const s of sections) {
    // Fail closed on a path we could not decode: it cannot be classified.
    if (s.pathDecodeFailed) continue;
    const paths = [s.oldPath, s.newPath].filter(Boolean);
    if (paths.some((p) => classifyPath(p) !== null)) continue;
    const r = redactSecrets(s.section);
    redactions += r.redacted.length;
    kept.push(r.text);
  }
  if (kept.length === 0) return { status: 'empty-after-filter', redactions };

  const joined = kept.join('');
  if (scanForSecrets(joined).matched) {
    return { status: 'refused-secret', redactions };
  }

  let used = 0;
  const out = [];
  for (const part of kept) {
    const size = Buffer.byteLength(part, 'utf8');
    if (used + size > maxBytes) break;
    out.push(part);
    used += size;
  }
  if (out.length === 0) return { status: 'oversize-section', redactions };

  const text = out.join('');
  return {
    status: 'captured',
    ref: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    text,
    bytes: used,
    truncated: out.length < kept.length,
    redactions,
  };
}
