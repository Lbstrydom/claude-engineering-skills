/**
 * @fileoverview D2a's dependency contract, enforced mechanically (D2b).
 *
 * A resolved local-module GRAPH check, not a string search (post-gate fix,
 * M2 — plan: comparison-tooling-consolidation.md): builds the edge set from
 * every `import`/`export … from` statement AND every literal
 * `import('./literal/path.mjs')` dynamic import via a real AST (Babel,
 * `scripts/lib/ast.mjs` — the same parser the nav/lint waves use), resolves
 * every specifier to a repo-relative path, and asserts each edge against
 * `scripts/lib/bakeoff/module-contract.mjs` — the ONE machine-readable
 * source (never re-typed here). Also asserts the resolved subgraph
 * (`bakeoff/**` + the three `campaign/*.mjs` modules) is ACYCLIC, and that a
 * non-literal dynamic import inside a restricted module is itself a failure
 * unless paired with a `// module-contract:exempt reason=<why>` pragma.
 *
 * Known limitation (round-4 finding M14), deliberately not closed here:
 * `mustNotImport` is checked on every DIRECT local edge a governed file
 * declares — it does not follow a governed file's edge into an UNGOVERNED
 * intermediary and check what THAT module imports. A governed file could in
 * principle reach a forbidden governed sibling one hop indirectly (import an
 * ungoverned shared-lib module that itself re-exports the forbidden symbol)
 * without tripping this check. Verified empirically (2026-08-16): none of
 * the ungoverned modules the 9 governed files actually import today
 * (cli-io.mjs, model-resolver.mjs, model-pricing.mjs, campaign/config.mjs,
 * comparison/fingerprint.mjs, finding-match.mjs, vcs.mjs, comparison/paths.mjs,
 * comparison/spend.mjs, store/campaign.mjs) re-exports anything from
 * bakeoff/** or campaign/{adjudicate,cited-source,promote}.mjs — no live
 * bypass exists. Full transitive closure over the whole repo's import graph
 * is a materially bigger checker than the direct-edge contract D2a actually
 * specifies; add it if a real intermediary re-export is ever introduced,
 * rather than building it against a hypothetical one now.
 *
 * @module tests/bakeoff-module-contract
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseSource, walk } from '../scripts/lib/ast.mjs';
import { MODULE_CONTRACT } from '../scripts/lib/bakeoff/module-contract.mjs';

const REPO_ROOT = process.cwd();

/** Read + parse one contract-governed file, relative to the repo root. */
function loadFile(relPath) {
  const abs = path.join(REPO_ROOT, relPath);
  const content = fs.readFileSync(abs, 'utf-8');
  const { ast, error } = parseSource(content);
  if (!ast) throw new Error(`${relPath}: failed to parse — ${error}`);
  return { content, ast };
}

/** Resolve an import specifier (relative to `fromFile`) to a repo-relative
 *  path, normalised to forward slashes with no `./` prefix or extension games. */
function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null; // a bare package specifier — not a local edge
  const fromDir = path.dirname(fromFile);
  let resolved = path.join(fromDir, specifier).replace(/\\/g, '/');
  if (!resolved.endsWith('.mjs') && !resolved.endsWith('.js')) resolved += '.mjs';
  return resolved;
}

/**
 * Every local edge this file declares: `{to, kind, line}[]`. `kind` is
 * `'static'` (import/export…from) or `'dynamic-literal'`/`'dynamic-computed'`.
 * A `dynamic-computed` import with no matching exemption pragma is itself a
 * contract violation, asserted separately below.
 */
function extractEdges(relPath) {
  const { content, ast } = loadFile(relPath);
  const edges = [];
  const exemptLines = new Set();
  // `// module-contract:exempt reason=<why>` on the line BEFORE a dynamic
  // import pragma-exempts that one call, same convention as
  // `@duplicate-justification`.
  content.split('\n').forEach((line, i) => {
    if (/\/\/\s*module-contract:exempt\s+reason=/.test(line)) exemptLines.add(i + 2); // pragma is line i+1 (1-indexed); exempts the NEXT line
  });

  walk(ast, (node) => {
    if ((node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source?.value) {
      const to = resolveSpecifier(relPath, node.source.value);
      if (to) edges.push({ to, kind: 'static', line: node.loc?.start?.line ?? 0 });
      return;
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'Import') {
      const arg = node.arguments?.[0];
      const line = node.loc?.start?.line ?? 0;
      if (arg?.type === 'StringLiteral') {
        const to = resolveSpecifier(relPath, arg.value);
        if (to) edges.push({ to, kind: 'dynamic-literal', line });
      } else {
        edges.push({ to: null, kind: 'dynamic-computed', line, exempt: exemptLines.has(line) });
      }
    }
  });
  return edges;
}

const GOVERNED_FILES = Object.keys(MODULE_CONTRACT);

describe('bakeoff/campaign module contract (D2a, enforced by D2b)', () => {
  it('MODULE_CONTRACT declares all 6 bakeoff modules + all 3 new campaign modules — the exact D2a row count', () => {
    const bakeoff = GOVERNED_FILES.filter((f) => f.includes('/bakeoff/'));
    const campaign = GOVERNED_FILES.filter((f) => f.includes('/campaign/'));
    assert.equal(bakeoff.length, 6, 'scope.mjs, arms.mjs, log.mjs, spawn.mjs, summary.mjs, progress.mjs');
    assert.equal(campaign.length, 3, 'cited-source.mjs, adjudicate.mjs, promote.mjs');
  });

  it('every governed file exists and parses', () => {
    for (const f of GOVERNED_FILES) {
      assert.ok(fs.existsSync(path.join(REPO_ROOT, f)), `${f} does not exist`);
      assert.doesNotThrow(() => loadFile(f), `${f} failed to parse`);
    }
  });

  for (const file of GOVERNED_FILES) {
    it(`${file}: every local edge is on the D2a allow-list, no dynamic-computed import without an exemption`, () => {
      const contract = MODULE_CONTRACT[file];
      const edges = extractEdges(file);
      const localGoverned = new Set(GOVERNED_FILES);

      for (const e of edges) {
        if (e.kind === 'dynamic-computed') {
          assert.ok(e.exempt, `${file}:${e.line} — non-literal dynamic import with no `
            + '`// module-contract:exempt reason=<why>` pragma. A computed import path is exactly how a '
            + 'forbidden edge hides from a static graph check.');
          continue;
        }
        if (e.to === null) continue; // a bare package specifier — not a local edge
        const isEntryPoint = /^scripts\/[^/]+\.mjs$/.test(e.to);
        if (isEntryPoint) {
          assert.fail(`${file}:${e.line} — imports entry point "${e.to}" directly. `
            + 'No lib module under bakeoff/**/campaign/** may import a scripts/*.mjs CLI entry point.');
        }
        // `mustNotImport` is checked for EVERY local edge, governed or not
        // (round-4 finding M8 — the OLD `continue` above skipped this check
        // entirely for any edge leaving the 9-file governed set, which is
        // exactly how a forbidden edge could hide: nothing stopped
        // `bakeoff/spawn.mjs` from importing some OTHER shared-lib module
        // that itself re-exported `bakeoff/summary.mjs`, since the direct
        // edge to that intermediary was never checked).
        const forbidden = (contract.mustNotImport || []).some((p) => matchesPattern(e.to, p));
        assert.ok(!forbidden, `${file}:${e.line} — imports "${e.to}", which matches a mustNotImport rule for ${file}`);
        // `mayImport` is only REQUIRED for governed-to-governed edges — it is
        // the load-bearing boundary D2a exists to enforce (preventing a
        // cycle among the 9 bakeoff/campaign modules); a general shared-lib
        // import (`../vcs.mjs`, `../cli-io.mjs`, …) is outside that boundary
        // by construction and not re-enumerated here, matching the D2a
        // table's own selective documentation style.
        if (localGoverned.has(e.to)) {
          const allowed = (contract.mayImport || []).some((p) => e.to === p || e.to.startsWith(p));
          assert.ok(allowed, `${file}:${e.line} — imports "${e.to}", a governed module not on ${file}'s mayImport allow-list`);
        }
      }
    });
  }

  it('the governed subgraph (bakeoff/** + campaign/adjudicate|cited-source|promote) is ACYCLIC', () => {
    const graph = new Map(GOVERNED_FILES.map((f) => [f, []]));
    for (const f of GOVERNED_FILES) {
      for (const e of extractEdges(f)) {
        if (e.to && graph.has(e.to)) graph.get(f).push(e.to);
      }
    }
    const WHITE = 0; const GRAY = 1; const BLACK = 2;
    const color = new Map(GOVERNED_FILES.map((f) => [f, WHITE]));
    const stack = [];
    let cycle = null;
    function dfs(node) {
      color.set(node, GRAY);
      stack.push(node);
      for (const next of graph.get(node)) {
        if (color.get(next) === GRAY) {
          cycle = [...stack.slice(stack.indexOf(next)), next];
          return true;
        }
        if (color.get(next) === WHITE && dfs(next)) return true;
      }
      stack.pop();
      color.set(node, BLACK);
      return false;
    }
    for (const f of GOVERNED_FILES) {
      if (color.get(f) === WHITE && dfs(f)) break;
    }
    assert.equal(cycle, null, cycle ? `cycle detected: ${cycle.join(' -> ')}` : undefined);
  });
});

/** Pattern matcher for `mustNotImport` entries — exact, prefix (trailing `/`),
 *  or a single-`*`-per-segment glob (`scripts/*.mjs`). */
function matchesPattern(candidate, pattern) {
  if (pattern === '*') return true;
  if (pattern.endsWith('/')) return candidate.startsWith(pattern);
  if (pattern.includes('*')) {
    const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
    return re.test(candidate);
  }
  return candidate === pattern;
}
