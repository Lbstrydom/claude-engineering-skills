/**
 * @fileoverview The last line of defence before an export leaves a machine: refuse
 * to emit a document whose serialised bytes carry anything that looks like an
 * organisation detail.
 *
 * LAYERS (docs/plans/private-store-telemetry-path.md §2.2). Layer 1 — the strict,
 * no-free-text schema — is the GUARANTEE: a value outside its enum or format never
 * validates. This module is layer 2, defence in depth, and it is deliberately
 * FAIL-CLOSED rather than a scrubber:
 *
 *   - It scans the SERIALISED document (keys and values both), so it sees what a
 *     recipient would, not what a builder intended.
 *   - On any hit it THROWS `ExportRefusedError` naming the CATEGORY of the hit and
 *     never the matched text — an error that echoes the leaked value would re-leak
 *     it into a log. A schema-valid document that trips this is a bug in the schema
 *     or the builder, and silently "cleaning" it would hide exactly that bug.
 *   - A scrub recognises SHAPES, not meaning: it can say a string looks like a token
 *     or a path, never that it is free of a repo name. That is why it is not the proof.
 *
 * Reuses the repo's single oracles: `scanForSecrets` (secret-patterns.mjs) and
 * `classifyPath` (sensitive-paths.mjs). No fifth implementation.
 *
 * @module scripts/lib/telemetry-export/redact
 */
import { scanForSecrets } from '../secret-patterns.mjs';
import { classifyPath } from '../sensitive-paths.mjs';

export class ExportRefusedError extends Error {
  /** @param {string[]} categories hit categories — never the matched text */
  constructor(categories) {
    super(`export refused: the serialised document matched ${categories.join(', ')}`);
    this.name = 'ExportRefusedError';
    this.categories = categories;
  }
}

// Shapes that must not appear anywhere in an export. Each is a category name + a regex.
const SHAPES = Object.freeze([
  // A fully-qualified host name: label(s) + a purely alphabetic TLD. Timestamps (`.123Z`), versions
  // and hex digests cannot match: a TLD of letters only, 2+ long, bounded by a non-word char.
  { category: 'hostname', re: /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}\b/i },
  { category: 'ipv4-address', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/ },
  { category: 'url', re: /\b[a-z][a-z0-9+.-]*:\/\//i },
  { category: 'windows-path', re: /\b[A-Za-z]:[\\/]/ },
  { category: 'home-path', re: /(?:^|[\s"'])(?:\/home\/|\/Users\/|~\/)/ },
  { category: 'dsn-userinfo', re: /\b[^\s/@:]+:[^\s/@]+@[^\s/@]+/ },
  { category: 'email', re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
]);

/**
 * Throw unless the serialised document is clean.
 *
 * @param {object} doc a schema-valid export
 * @returns {void}
 * @throws {ExportRefusedError}
 */
export function assertExportClean(doc) {
  const text = JSON.stringify(doc);
  const hits = new Set();

  const secrets = scanForSecrets(text);
  if (secrets.matched) hits.add('secret');

  for (const { category, re } of SHAPES) if (re.test(text)) hits.add(category);

  // Any string that classifies as a sensitive PATH (`.env`, `~/.ssh`, key files …) by the repo's own oracle.
  const strings = [];
  (function walk(v) {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { strings.push(k); walk(x); }
  })(doc);
  for (const s of strings) {
    if (classifyPath(s) === 'sensitive') { hits.add('sensitive-path'); break; }
  }

  if (hits.size > 0) throw new ExportRefusedError([...hits].sort());
}
