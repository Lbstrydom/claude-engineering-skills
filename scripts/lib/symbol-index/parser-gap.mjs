/**
 * @fileoverview The parser-gap diagnosis, as a pure function.
 *
 * A coverage ratio says THAT files are missing from the graph; this says WHY
 * and what to do about it. Before it, a consumer whose 522 TypeScript files
 * were unreadable saw only a 22% ratio and `Layering violations: 0`, and the
 * cause was diagnosable only from outside the tool. Moved out of
 * `extract.mjs` (whose size is ratcheted) when the Python parser stage made
 * the remedy depend on the extension (docs/plans/python-arch-memory-indexing.md §2.4).
 *
 * @module scripts/lib/symbol-index/parser-gap
 */

/**
 * The remedy for an unparseable extension. Keyed by the PARSER that would read
 * it, not hand-listed per extension beyond the two stages that exist.
 * @param {string} ext - `.ext`
 * @returns {string}
 */
export function remedyFor(ext) {
  if (ext === '.py') {
    return 'install Python >= 3.9 on PATH, or set ARCH_INDEX_PYTHON to an interpreter';
  }
  if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts') {
    return 'install `typescript` where dependency-cruiser can resolve it (under pnpm\'s strict '
      + 'layout that means hoisting it, e.g. a root devDependency or `public-hoist-pattern[]=typescript` in .npmrc)';
  }
  return 'install the transpiler dependency-cruiser needs for it';
}

/**
 * Warning lines for a coverage record's `parser` block. Empty when there is
 * nothing to say.
 *
 * NB: the phrasing deliberately avoids the literal `from "<word>"` shape —
 * `module-graph.mjs`'s regex import scanner reads that as a bare package
 * specifier, which makes the string look like an undeclared dependency to
 * `tests/install-deps-contract.test.mjs`.
 *
 * @param {{known: boolean, unparseable: number|null, byExtension: Record<string, number>}|null|undefined} parser
 * @returns {string[]}
 */
export function describeParserGap(parser) {
  if (!parser) return [];
  if (!parser.known) {
    return ['WARNING: could not ask the parsers which extensions they can read — '
      + 'the coverage ratio below cannot distinguish "not reached" and "unreadable".'];
  }
  if (!parser.unparseable) return [];
  const entries = Object.entries(parser.byExtension || {}).sort((a, b) => b[1] - a[1]);
  const breakdown = entries.map(([ext, n]) => `${ext} (${n})`).join(', ');
  const remedies = [...new Set(entries.map(([ext]) => `${ext}: ${remedyFor(ext)}`))].join('; ');
  return [`WARNING: ${parser.unparseable} eligible file(s) have no parser available in this install — `
    + `${breakdown}. Their symbols and imports are absent from the index, so a result covering them is `
    + `UNMEASURED, not clean. Remedy — ${remedies}.`];
}
