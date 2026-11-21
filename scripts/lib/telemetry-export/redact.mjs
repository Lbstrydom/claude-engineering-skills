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
import { SOURCE_CODE_EXTENSIONS } from '../file-taxonomy.mjs';

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
  // IPv6: `::`-compressed forms (fe80::1, ::1, 2001:db8::8a2e:370:7334) and the full 8-group form. A clock time
  // (10:00:00) or an ISO timestamp has neither a `::` nor 8 groups, so it cannot match.
  { category: 'ipv6-address', re: /(?<![\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?|::(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})(?![\w:])/i },
  { category: 'ipv4-address', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/ },
  { category: 'url', re: /\b[a-z][a-z0-9+.-]*:\/\//i },
  { category: 'windows-path', re: /\b[A-Za-z]:[\\/]/ },
  { category: 'home-path', re: /(?:^|[\s"'`([<,=:])(?:\/home\/|\/Users\/|~\/)/ },
  { category: 'dsn-userinfo', re: /\b[^\s/@:]+:[^\s/@]+@[^\s/@]+/ },
  { category: 'email', re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
]);

const SOURCE_EXTENSIONS = new Set(SOURCE_CODE_EXTENSIONS.map((e) => e.slice(1).toLowerCase()));

/**
 * Prose mode only: does this hostname-shaped match read as a source FILE in a path
 * rather than a host? It must be the final segment of a path (a single `/` directly before it, none after) AND end in a source-code extension from the repo's own taxonomy. A bare
 * `foo.mjs` is ambiguous with a host and stays refused.
 */
function isPathedSourceFile(text, start, end) {
  // Immediately preceded by `/` (it is the FINAL segment of a path) and not followed by `/` (so it is not a
  // host in `db.corp.py/internal` or a directory in `db.internal.mjs/health`).
  if (text[start - 1] !== '/' || text[end] === '/') return false;
  // `//db.corp.py:5432` / `//db.internal.mjs` is a scheme-relative authority, not a path. A trailing `:<digits>` after a
  // single-slash path is a file:line citation and stays exempt; a bare `db.internal.mjs:5432` never reaches here (no `/`).
  if (text[start - 2] === '/') return false;
  // Three or more labels followed by `:<digits>` is a host:port (`bastion/db.corp.py:5432`); a two-label name with a
  // line number (`lib/foo.mjs:12`) is a citation and stays exempt.
  if (text.slice(start, end).split('.').length >= 3 && /^:\d/.test(text.slice(end, end + 2))) return false;
  const last = text.slice(start, end).split('.').pop().toLowerCase();
  return SOURCE_EXTENSIONS.has(last);
}

function hostnameHit(text, prose) {
  if (!prose) return SHAPES[0].re.test(text);
  const re = new RegExp(SHAPES[0].re.source, 'gi');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!isPathedSourceFile(text, m.index, m.index + m[0].length)) return true;
  }
  return false;
}

function scanText(text, strings, prose) {
  const hits = new Set();
  const secrets = scanForSecrets(text);
  if (secrets.matched) hits.add('secret');
  for (const { category, re } of SHAPES) {
    if (category === 'hostname' ? hostnameHit(text, prose) : re.test(text)) hits.add(category);
  }
  // Any string that classifies as a sensitive PATH (`.env`, `~/.ssh`, key files ...) by the repo's own oracle.
  for (const s of strings) {
    if (classifyPath(s) === 'sensitive') { hits.add('sensitive-path'); break; }
  }
  return [...hits].sort();
}

/**
 * Screen free text for the shapes an organisation detail takes. The same oracle the
 * exporter uses (SHAPES + scanForSecrets + classifyPath), over prose instead of a
 * document. A SCREENING AID for known shapes, never proof that prose is free of
 * confidential meaning. Categories only, never the matched text.
 *
 * Path classification looks only at tokens that are path-shaped (contain `/`, `\`
 * or `.`): `classifyPath` treats the bare word "token" as sensitive, which would
 * refuse ordinary prose.
 *
 * @param {string} text
 * @param {{prose?: boolean}} [opts] `prose:true` exempts a pathed source file such as `lib/foo.mjs`
 * @returns {{clean: boolean, categories: string[]}}
 */
export function scanForLeaks(text, { prose = false } = {}) {
  const str = String(text ?? '');
  const tokens = str.split(/\s+/)
    .map((t) => t.replace(/^[("'`<\[]+|[)"'`>\],;:!?]+$/g, '').replace(/\.+$/, ''))
    .filter((t) => /[/\\.]/.test(t));
  const categories = scanText(str, tokens, prose);
  return { clean: categories.length === 0, categories };
}

/**
 * Throw unless the serialised document is clean.
 *
 * @param {object} doc a schema-valid export
 * @returns {void}
 * @throws {ExportRefusedError}
 */
export function assertExportClean(doc) {
  const text = JSON.stringify(doc);
  const strings = [];
  (function walk(v) {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { strings.push(k); walk(x); }
  })(doc);
  const hits = scanText(text, strings, false);
  if (hits.length > 0) throw new ExportRefusedError(hits);
}
