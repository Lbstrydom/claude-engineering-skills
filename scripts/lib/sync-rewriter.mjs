/**
 * @fileoverview Ownership-aware command-invocation rewriter.
 *
 * Rewrites `node scripts/X.mjs` invocations to point at the consumer-side
 * tooling layout — but ONLY for commands referencing files this bundle owns.
 * Consumer-owned commands (e.g. `node scripts/automated-tests.js` in
 * ai-organiser) stay untouched.
 *
 * Three properties co-equal:
 *   1. Idempotent — rewriter(rewriter(content)) === rewriter(content)
 *   2. Surface-aware — text vs JSON dispatch via rewriteCommandSurface
 *   3. Ownership-aware — `ownedSourceTails` set gates which paths get touched
 *
 * Plan §2 KD #4. Pure functions; no I/O.
 *
 * @module scripts/lib/sync-rewriter
 */

import { sourceRelToDestRel, LAYOUT_CONSTANTS } from './sync-path-map.mjs';

// Single source of truth for the `node scripts/<path>` command pattern.
// Exported so the verifier (gate3) reuses this exact regex — eliminates
// parser drift between rewrite and detect surfaces (R1 M1 fix).
//
// Tail is captured up to the first whitespace OR string/shell delimiter.
// The excluded set covers:
//   - whitespace (terminates an invocation)
//   - `` ` `` (markdown code-fence boundary)
//   - `"` and `'` (string-literal terminators in shell or embedded code; R3 H2 fix)
//   - `)` and `,` (function-call boundaries)
//   - `;` `&` `|` (shell separators)
// Without these, a trailing string-literal quote or markdown backtick
// would get glued onto the tail and the rewriter would emit a broken
// invocation like `scripts/.claude-skills/X.mjs"`.
export const COMMAND_REGEX = /\bnode\s+scripts\/([^\s`"'),;&|]+)/g;

/**
 * Tokenising rewriter for plain-text files (.md, .sh, prompt files, source).
 *
 * Algorithm per plan §2 KD #4:
 *   1. Scan for `\bnode\s+scripts/(\S+)`
 *   2. Extract tail (everything after `scripts/`)
 *   3. If tail starts with `.claude-skills/` → no-op (already migrated)
 *   4. Else if tail is NOT in ownedSourceTails → no-op (consumer-owned)
 *   5. Else compute destRel = sourceRelToDestRel('scripts/' + tail).
 *      If destRel === 'scripts/' + tail → no-op (explicit-exception).
 *      Otherwise emit `node ${destRel}`.
 *
 * @param {string} content
 * @param {{ownedSourceTails: Set<string>}} config
 * @returns {string}
 */
export function rewriteTextCommandInvocations(content, config) {
  const ownedSourceTails = config?.ownedSourceTails;
  if (!(ownedSourceTails instanceof Set)) {
    throw new TypeError('rewriteTextCommandInvocations: config.ownedSourceTails must be a Set');
  }
  if (typeof content !== 'string') {
    throw new TypeError('rewriteTextCommandInvocations: content must be a string');
  }
  return content.replace(COMMAND_REGEX, (match, tail) => {
    if (tail.startsWith('.claude-skills/')) return match;
    if (!ownedSourceTails.has(tail)) return match;
    const sourceRel = `scripts/${tail}`;
    const destRel = sourceRelToDestRel(sourceRel);
    if (destRel === sourceRel) return match;
    return `node ${destRel}`;
  });
}

/**
 * Recursive JSON rewriter — visits every string value, applies the text
 * rewriter to each, returns a new tree.  Used for .claude/settings.json
 * (AFTER deepMerge) and .vscode/mcp.json.
 *
 * @param {unknown} value
 * @param {{ownedSourceTails: Set<string>}} config
 * @returns {unknown}
 */
export function rewriteJsonCommandInvocations(value, config) {
  if (typeof value === 'string') {
    return rewriteTextCommandInvocations(value, config);
  }
  if (Array.isArray(value)) {
    return value.map((v) => rewriteJsonCommandInvocations(v, config));
  }
  if (value && typeof value === 'object') {
    // R2 H4 fix: Object.create(null) + Object.defineProperty for own-property
    // assignment. A plain `{}` followed by `out[k] = ...` would treat a JSON
    // key named `__proto__` as the prototype setter, losing data and creating
    // a prototype-pollution hazard during rewrites.
    const out = Object.create(null);
    for (const [k, v] of Object.entries(value)) {
      Object.defineProperty(out, k, {
        value: rewriteJsonCommandInvocations(v, config),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

const TEXT_EXTENSIONS = new Set(['.md', '.sh', '.mjs', '.js']);
const JSON_EXTENSIONS = new Set(['.json']);

function extOf(relPath) {
  const idx = relPath.lastIndexOf('.');
  if (idx === -1) return '';
  return relPath.slice(idx).toLowerCase();
}

/**
 * Per-extension dispatch facade.  Single entry point for the sync loop.
 *
 * @param {{relPath: string, content: string|Buffer, config: {ownedSourceTails: Set<string>}}} args
 * @returns {{rewritten: string|Buffer, changed: boolean, hits: number}}
 */
export function rewriteCommandSurface({ relPath, content, config }) {
  if (typeof relPath !== 'string') {
    throw new TypeError('rewriteCommandSurface: relPath must be a string');
  }

  const ext = extOf(relPath);
  const isBuffer = Buffer.isBuffer(content);
  const text = isBuffer ? content.toString('utf-8') : content;

  if (typeof text !== 'string') {
    return { rewritten: content, changed: false, hits: 0 };
  }

  let rewritten;
  let hits = 0;
  if (TEXT_EXTENSIONS.has(ext)) {
    // Count matches before rewrite so we can report hits.
    const matches = text.match(COMMAND_REGEX);
    hits = matches ? matches.length : 0;
    rewritten = rewriteTextCommandInvocations(text, config);
  } else if (JSON_EXTENSIONS.has(ext)) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Malformed JSON — passthrough (the sync loop will error elsewhere).
      return { rewritten: content, changed: false, hits: 0 };
    }
    const matches = text.match(COMMAND_REGEX);
    hits = matches ? matches.length : 0;
    // R2 M2 fix: skip JSON re-serialisation when there are no command
    // invocations to rewrite. Re-serialising would normalise whitespace
    // and reorder keys unnecessarily, causing diff churn on files we
    // didn't actually need to touch.
    if (hits === 0) {
      return { rewritten: content, changed: false, hits: 0 };
    }
    const rewrittenTree = rewriteJsonCommandInvocations(parsed, config);
    rewritten = JSON.stringify(rewrittenTree, null, 2);
    // Preserve trailing newline if original had one.
    if (text.endsWith('\n') && !rewritten.endsWith('\n')) rewritten += '\n';
  } else {
    return { rewritten: content, changed: false, hits: 0 };
  }

  const changed = rewritten !== text;
  if (isBuffer) {
    return { rewritten: Buffer.from(rewritten, 'utf-8'), changed, hits };
  }
  return { rewritten, changed, hits };
}

/**
 * Build the ownedSourceTails Set from a list of source-relative paths.
 * Used by both the sync (source-side) and the verifier (consumer-side).
 *
 * @param {Iterable<string>} sourcePaths
 * @returns {Set<string>}
 */
export function buildOwnedSourceTails(sourcePaths) {
  const out = new Set();
  for (const p of sourcePaths) {
    const norm = String(p).replace(/\\/g, '/');
    if (norm.startsWith('scripts/') && !norm.startsWith(`${LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR}/`)) {
      out.add(norm.slice('scripts/'.length));
    }
  }
  return out;
}

/**
 * Consumer-side variant: derive ownedSourceTails from the consumer's
 * sync-manifest, mapping each destination key back to its source path.
 *
 * @param {{files: Record<string, string>, layout?: string}} manifest
 * @returns {Set<string>}
 */
export function buildOwnedSourceTailsFromConsumerManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || !manifest.files) {
    throw new TypeError('buildOwnedSourceTailsFromConsumerManifest: invalid manifest');
  }
  const out = new Set();
  const isolatedPrefix = `${LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR}/`;
  const isLegacy = !manifest.layout || manifest.layout === 'legacy';
  for (const destRel of Object.keys(manifest.files)) {
    const norm = destRel.replace(/\\/g, '/');
    if (norm.startsWith(isolatedPrefix)) {
      out.add(norm.slice(isolatedPrefix.length));
    } else if (isLegacy && norm.startsWith('scripts/')) {
      out.add(norm.slice('scripts/'.length));
    }
  }
  return out;
}

export const _internals = { COMMAND_REGEX, extOf, TEXT_EXTENSIONS, JSON_EXTENSIONS };
