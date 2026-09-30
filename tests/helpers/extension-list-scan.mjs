/**
 * Finds hand-kept "which files are code" decisions in source text — the shape that
 * let a consumer's C# go unaudited (a dozen independent extension lists that disagreed
 * with each other and with the language-profile registry).
 *
 * This is the SECONDARY guard of the drift contract (tests/extension-list-drift.test.mjs):
 * the primary one is a behavioural matrix over the registered generic decision points.
 * This scanner is the filesystem-side net for a NEW list that no matrix row names.
 *
 * What it detects (and, deliberately, what it does not):
 *   - a bracketed collection naming >= 2 DISTINCT source-language extensions as quoted
 *     literals, dotted or bare (`['.ts', '.py']`, `new Set(['js', 'go'])`), including
 *     multi-line lists with comments and trailing commas;
 *   - a regex alternation naming >= 2 distinct source-language extensions after a dot
 *     (`/\.(?:ts|py)$/`, `\\.(js|go)`), capturing or not;
 *   - a chain of >= 2 `.endsWith('.ext')` / `extname(x) === '.ext'` comparisons in one statement.
 * NOT detected: a single comparison (`endsWith('.mjs')` is a filename check, not a language
 * list), and dynamically assembled lists. The behavioural matrix is the guarantee for
 * registered decision points; this is a net, not a proof.
 */
import { SOURCE_CODE_EXTENSIONS } from '../../scripts/lib/file-taxonomy.mjs';

const BARE = new Set(SOURCE_CODE_EXTENSIONS.map((e) => e.slice(1)));

/** Distinct source-language extensions named as quoted literals within `text`. */
function quotedExts(text) {
  const out = new Set();
  for (const m of text.matchAll(/(['"`])\.?([a-z0-9]{1,6})\1/g)) {
    if (BARE.has(m[2])) out.add(m[2]);
  }
  return out;
}

/** Blank out comments (keeping line numbers): prose names extensions constantly; only CODE decides. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => {
      // A `//` starts a comment only when the text before it has balanced quotes: a `//` inside a string
      // (a URL, a glob) is not one. Quotes INSIDE the comment (`// was ['.cs']`) are exactly why the test is
      // on the text BEFORE the marker.
      for (let i = line.indexOf('//'); i !== -1; i = line.indexOf('//', i + 1)) {
        const before = line.slice(0, i);
        const balanced = ["'", '"', '`'].every((q) => (before.split(q).length - 1) % 2 === 0);
        if (balanced && !/:$/.test(before)) return before;
      }
      return line;
    })
    .join('\n');
}

/**
 * @param {string} rawSource - file text
 * @returns {Array<{line: number, shape: 'collection'|'regex'|'chain', exts: string[], text: string}>}
 */
export function findExtensionLists(rawSource) {
  const source = stripComments(rawSource);
  const hits = [];
  const lineOf = (idx) => source.slice(0, idx).split('\n').length;

  // 1. bracketed collections (nested brackets excluded, so comments / trailing commas still match)
  for (const m of source.matchAll(/\[([^[\]]{1,900})\]/g)) {
    const exts = quotedExts(m[1]);
    if (exts.size >= 2) hits.push({ line: lineOf(m.index), shape: 'collection', exts: [...exts], text: m[0].replace(/\s+/g, ' ').slice(0, 80) });
  }

  // 2. regex alternations: \.(a|b|c) with or without a non-capturing group
  for (const m of source.matchAll(/\\+\.\((?:\?:)?([a-z0-9|]{3,80})\)/g)) {
    const exts = new Set(m[1].split('|').filter((e) => BARE.has(e)));
    if (exts.size >= 2) hits.push({ line: lineOf(m.index), shape: 'regex', exts: [...exts], text: m[0].slice(0, 80) });
  }

  // 3. comparison chains: >= 2 endsWith / extname comparisons against source extensions in one statement
  for (const stmt of source.split(/;\s*\n|\n\s*\n/)) {
    const found = new Set();
    for (const m of stmt.matchAll(/(?:endsWith\(\s*|extname\([^)]*\)\s*===?\s*)(['"`])\.([a-z0-9]{1,6})\1/g)) {
      if (BARE.has(m[2])) found.add(m[2]);
    }
    if (found.size >= 2) {
      const idx = source.indexOf(stmt);
      hits.push({ line: lineOf(idx < 0 ? 0 : idx), shape: 'chain', exts: [...found], text: stmt.trim().replace(/\s+/g, ' ').slice(0, 80) });
    }
  }
  return hits;
}
