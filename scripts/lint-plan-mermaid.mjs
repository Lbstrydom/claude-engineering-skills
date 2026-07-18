#!/usr/bin/env node
/**
 * @fileoverview Lint Mermaid blocks inside `docs/plans/*.md` for the
 * specific class of bug that GitHub renders leniently but VS Code preview
 * (and stricter Mermaid renderers) reject — the most common gotcha is
 * referencing a `subgraph` ID as an edge endpoint, which Mermaid `graph`
 * syntax doesn't support. That bug was caught in
 * `docs/plans/liveness-and-canonical-paths.md` after the diagram looked
 * fine on GitHub but flashed-then-failed in VS Code preview.
 *
 * Scope (deliberately narrow — this is a lint, not a renderer):
 *   1. Subgraph IDs must NOT appear as edge endpoints (the load-bearing rule).
 *   2. Node IDs referenced in edges must be declared somewhere in the block
 *      (catches typos like `R1` vs `RI`).
 *
 * Out of scope (use `mmdc` if you want full validation):
 *   - Sequence / class / ER / state diagram syntax (only `graph` / `flowchart`).
 *   - Style declarations.
 *   - Subgraph nesting.
 *
 * Exit codes:
 *   0 — clean (or no Mermaid blocks found).
 *   1 — one or more issues. JSON report on stdout when `--format json`.
 *
 * @module scripts/lint-plan-mermaid
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertRepoRoot } from './lib/assert-repo-root.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const DEFAULT_GLOB_DIRS = [path.join(REPO_ROOT, 'docs', 'plans')];

// ── Block extraction ───────────────────────────────────────────────────────

/**
 * Extract ` ```mermaid` fenced blocks from a markdown source.
 * Returns each block with its 1-based starting line in the file.
 */
export function extractMermaidBlocks(markdown) {
  const lines = markdown.split('\n');
  const blocks = [];
  let inBlock = false;
  let startLine = 0;
  let buf = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!inBlock && trimmed.startsWith('```mermaid')) {
      inBlock = true;
      startLine = i + 1; // line number of the opening fence (1-based)
      buf = [];
      continue;
    }
    if (inBlock && trimmed === '```') {
      blocks.push({ startLine, body: buf.join('\n') });
      inBlock = false;
      continue;
    }
    if (inBlock) buf.push(lines[i]);
  }
  return blocks;
}

// ── Block analysis (graph / flowchart only) ────────────────────────────────

/**
 * Parse a Mermaid `graph` / `flowchart` block to extract:
 *   - declared node IDs (anywhere they appear with `[...]` / `(...)` / `{...}` brackets)
 *   - declared subgraph IDs (`subgraph <ID>` or `subgraph <ID>["..."]`)
 *   - edge endpoints (the LHS + RHS of every `-->`, `---`, `-.->`, `-.-`,
 *     `==>`, `--text-->` style edge)
 *
 * Returns `null` if the block isn't a `graph` / `flowchart` diagram (we
 * don't lint other diagram types).
 */
export function parseGraphBlock(body) {
  const lines = body.split('\n');
  // First non-empty, non-comment line should declare the diagram type.
  let header = null;
  for (const l of lines) {
    const t = l.trim();
    if (!t || t.startsWith('%%')) continue;
    header = t;
    break;
  }
  if (!header) return null;
  if (!/^(graph|flowchart)\b/i.test(header)) return null;

  const nodes = new Set();
  const subgraphs = new Set();
  const edges = []; // { lhs, rhs, lineNo }

  // Strip block-level %% comments line by line.
  const cleanedLines = lines.map(l => {
    const idx = l.indexOf('%%');
    return idx === -1 ? l : l.slice(0, idx);
  });

  // Subgraph IDs.
  const SUBGRAPH_RE = /^\s*subgraph\s+([A-Za-z_][\w-]*)/;
  // Node-with-bracket declarations — also covers IDs declared in edges with
  // a label like `R1[scripts/...] --> SP[scripts/...]`.
  const NODE_DECL_RE = /([A-Za-z_][\w-]*)\s*[\[(\{]/g;
  // Edge: capture LHS and RHS bare IDs (anything not bracketed). Mermaid
  // edges have many shapes; we match the LHS_ID -- edge -- RHS_ID pattern
  // and tolerate text labels.
  const EDGE_RE = /([A-Za-z_][\w-]*)\s*(?:-{2,3}|-\.+-?|={2,3})(?:>?\|[^|]*\|)?\s*>?\s*([A-Za-z_][\w-]*)/g;

  cleanedLines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const sg = line.match(SUBGRAPH_RE);
    if (sg) subgraphs.add(sg[1]);
    let m;
    NODE_DECL_RE.lastIndex = 0;
    while ((m = NODE_DECL_RE.exec(line)) !== null) {
      const id = m[1];
      // Skip Mermaid keywords that could look like node IDs.
      if (id === 'subgraph' || id === 'end' || id === 'graph' || id === 'flowchart') continue;
      nodes.add(id);
    }
    EDGE_RE.lastIndex = 0;
    while ((m = EDGE_RE.exec(line)) !== null) {
      edges.push({ lhs: m[1], rhs: m[2], lineNo });
    }
  });

  return { kind: header.split(/\s+/)[0].toLowerCase(), nodes, subgraphs, edges };
}

// ── Rules ──────────────────────────────────────────────────────────────────

/**
 * R1 — subgraph IDs must not appear as edge endpoints.
 * Returns an array of issue objects.
 */
export function ruleSubgraphAsEdgeEndpoint(parsed, fileLineOffset) {
  const issues = [];
  for (const edge of parsed.edges) {
    for (const side of ['lhs', 'rhs']) {
      const id = edge[side];
      if (parsed.subgraphs.has(id)) {
        issues.push({
          rule: 'subgraph-as-edge-endpoint',
          severity: 'ERROR',
          message: `'${id}' is a subgraph ID; Mermaid graph syntax doesn't allow subgraph IDs as edge endpoints. Anchor the edge to a node *inside* the subgraph instead.`,
          // 1-based line number in the source file.
          lineNo: fileLineOffset + edge.lineNo,
        });
      }
    }
  }
  return issues;
}

/**
 * R2 — node label content with `<br/>`, em-dashes (`—`), or other non-ASCII
 * symbols MUST be wrapped in double quotes. Empirically the bracketed-but-
 * unquoted form `ID[label with <br/>]` parses correctly in current Mermaid
 * but is rejected by older bundled versions (older VS Code preview, some
 * CI renderers, embedded Markdown renderers). The quoted form `ID["..."]`
 * is universally portable.
 *
 * Detects bracket pairs `[...]`, `(...)`, `{...}` (Mermaid node-shape
 * brackets) whose contents start WITHOUT a `"` and contain any of:
 *   - `<br` (line break)
 *   - any non-ASCII codepoint (em-dash, em-space, etc.)
 *
 * Scans the raw block body (not the parsed AST) so it can flag the exact
 * bracket location.
 */
export function ruleUnquotedSpecialCharsInLabel(blockBody, fileLineOffset) {
  const issues = [];
  // Match opening bracket + first non-bracket char to check for quote.
  // `[...]`, `(...)`, `{...}` are the three Mermaid node-shape syntaxes.
  //
  // Subgraph TITLES are scanned too, deliberately. An older comment here
  // claimed they were "already handled by the `subgraph SG["..."]` form being
  // valid + common" — but that IS the portable form this rule asks for, so an
  // unquoted `subgraph SG [Phase 1 — build]` is a genuine finding, not noise.
  // (Suppressing them was tried and reverted: skipping the whole line left 117
  // subgraph declarations permanently unscanned to silence 3 real warnings.)
  const lines = blockBody.split('\n');
  // Patterns we consider risky if found inside an UNQUOTED bracket label.
  const RISKY_CONTENT = /<br|[^\x00-\x7F]/;
  // Match a bracket label: <ID><[|(|{> ... <]|)|}> on a single line,
  // capturing the content (lazy) so labels with mixed brackets stay sane.
  // Subgraph declarations (`subgraph X["..."]`) are EXCLUDED — those are
  // already quoted-friendly and we don't want to double-flag.
  const BRACKET_RE = /(?<!subgraph\s+\S{1,80}\s*)([A-Za-z_][\w-]*)\s*([\[(\{])([^\]\)\}\n]+)([\])\}])/g;
  lines.forEach((line, idx) => {
    // Strip %% comments.
    const commentAt = line.indexOf('%%');
    const cleaned = commentAt === -1 ? line : line.slice(0, commentAt);
    let m;
    BRACKET_RE.lastIndex = 0;
    while ((m = BRACKET_RE.exec(cleaned)) !== null) {
      const [, id, open, content] = m;
      if (id === 'subgraph') continue;            // skip subgraph declarations
      if (content.startsWith('"')) continue;      // already quoted
      // Cylinder `ID[("...")]`: the regex's content stops at the first `)`, so a
      // CORRECTLY-quoted cylinder reads as content `("...` — starting with `(`,
      // not `"`. Look past a leading `(` before deciding it's unquoted.
      if (open === '[' && content.startsWith('("')) continue;
      if (!RISKY_CONTENT.test(content)) continue; // ASCII-only, safe unquoted
      issues.push({
        rule: 'unquoted-special-chars-in-label',
        severity: 'WARN',
        message: `Node '${id}' has an unquoted label containing <br/> or non-ASCII chars. Wrap in double quotes (\`${id}["..."]\`) for portability across Mermaid versions / VS Code preview / CI renderers.`,
        lineNo: fileLineOffset + idx + 1,
      });
    }
  });
  return issues;
}

// ── Per-file lint ──────────────────────────────────────────────────────────

export function lintFile(filePath) {
  const md = fs.readFileSync(filePath, 'utf-8');
  const blocks = extractMermaidBlocks(md);
  const allIssues = [];
  for (const block of blocks) {
    const parsed = parseGraphBlock(block.body);
    // R2 applies to diagram types with node-shape brackets (graph, flowchart,
    // classDiagram, …) but NOT to stateDiagram, whose `A --> B: text`
    // transition labels are prose after a colon — parenthesised prose there is
    // not a bracket label and produced permanent false WARNs.
    //
    // Discriminate by DIAGRAM TYPE, never per-line. An earlier attempt skipped
    // any line matching `/-->.*:/` with a bare left-hand side, which silenced
    // ordinary flowchart labels that merely CONTAIN a colon — a URL, a
    // timestamp, `Step 1:` — e.g. `A --> B[Phase 2: rebuild — index]` went from
    // WARN to silent, with 54 such lines in the corpus. A lint that goes blind
    // is strictly worse than one that is noisy; this scopes the exemption to the
    // construct that actually warrants it.
    const isStateDiagram = /^\s*stateDiagram(-v2)?\b/m.test(block.body);
    const r2 = isStateDiagram ? [] : ruleUnquotedSpecialCharsInLabel(block.body, block.startLine);
    for (const i of r2) i.file = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
    allIssues.push(...r2);
    if (!parsed) continue; // not a graph block; only R2 applies
    const r1 = ruleSubgraphAsEdgeEndpoint(parsed, block.startLine);
    for (const i of r1) i.file = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
    allIssues.push(...r1);
  }
  return { file: filePath, blockCount: blocks.length, issues: allIssues };
}

// ── Directory walk ─────────────────────────────────────────────────────────

function walkMd(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMd(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

// ── CLI ────────────────────────────────────────────────────────────────────

function main() {
  assertRepoRoot(import.meta.url);
  const argv = process.argv.slice(2);
  const format = argv.includes('--format') ? argv[argv.indexOf('--format') + 1] : 'human';
  const targets = argv.filter(a => !a.startsWith('--') && a !== format);

  const files = [];
  if (targets.length > 0) {
    for (const t of targets) {
      const abs = path.isAbsolute(t) ? t : path.resolve(REPO_ROOT, t);
      if (fs.statSync(abs).isDirectory()) files.push(...walkMd(abs));
      else files.push(abs);
    }
  } else {
    for (const d of DEFAULT_GLOB_DIRS) files.push(...walkMd(d));
  }

  const results = files.map(lintFile);
  const errorCount = results.reduce(
    (n, r) => n + r.issues.filter(i => i.severity === 'ERROR').length, 0);
  const warnCount = results.reduce(
    (n, r) => n + r.issues.filter(i => i.severity === 'WARN').length, 0);
  const totalIssues = errorCount + warnCount;

  if (format === 'json') {
    process.stdout.write(JSON.stringify({
      ok: errorCount === 0,
      filesScanned: results.length,
      blocksScanned: results.reduce((n, r) => n + r.blockCount, 0),
      errorCount,
      warnCount,
      totalIssues,
      results,
    }, null, 2) + '\n');
  } else {
    if (totalIssues === 0) {
      const blocks = results.reduce((n, r) => n + r.blockCount, 0);
      process.stdout.write(`plans:lint — ${results.length} file(s), ${blocks} mermaid block(s), 0 issues.\n`);
    } else {
      for (const r of results) {
        if (r.issues.length === 0) continue;
        process.stdout.write(`\n${path.relative(REPO_ROOT, r.file).replace(/\\/g, '/')}:\n`);
        for (const i of r.issues) {
          process.stdout.write(`  ${i.severity} L${i.lineNo} [${i.rule}] ${i.message}\n`);
        }
      }
      process.stdout.write(
        `\n${errorCount} error(s), ${warnCount} warning(s) across ` +
        `${results.filter(r => r.issues.length > 0).length} file(s).\n`
      );
    }
  }
  // Exit non-zero only on ERROR; WARN is advisory (don't block pre-push
  // for portability nits — operators may have a reason to leave them).
  process.exit(errorCount === 0 ? 0 : 1);
}

// Test seam — `_internals` mirrors the project convention.
export const _internals = Object.freeze({
  extractMermaidBlocks,
  parseGraphBlock,
  ruleSubgraphAsEdgeEndpoint,
  ruleUnquotedSpecialCharsInLabel,
  lintFile,
});

const invokedAsScript = (() => {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href; }
  catch { return false; }
})();
if (invokedAsScript) main();
