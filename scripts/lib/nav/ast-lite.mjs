/**
 * @fileoverview Shared lightweight source-scanning helpers used by both the
 * extractor and the model (resolves audit R1-M11 duplication). Regex-based, not
 * a parser — consistent with the repo's other static passes.
 *
 * @module scripts/lib/nav/ast-lite
 */

const SYMBOL_RE = /(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_$]+)/g;

/** Index top-level symbol declarations with byte offsets. */
export function indexSymbols(content) {
  const re = new RegExp(SYMBOL_RE.source, SYMBOL_RE.flags);
  const out = [];
  let m;
  while ((m = re.exec(content)) !== null) out.push({ name: m[1], index: m.index });
  return out;
}

/** The nearest preceding declaration name for a byte offset (best-effort
 *  enclosing component; we do not track body ranges — documented approximation). */
export function enclosingSymbol(symbols, index) {
  let found = null;
  for (const s of symbols) {
    if (s.index <= index) found = s.name;
    else break;
  }
  return found;
}

/** 1-based line number for a byte offset. */
export function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content[i] === '\n') line++;
  return line;
}
