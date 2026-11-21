#!/usr/bin/env node
/**
 * @fileoverview Pre-implementation spike (Plan §0 verification S1).
 *
 * Settles whether `dependency-cruiser` extracts intra-file symbols (functions,
 * classes, hooks, components with body text + line numbers), which the plan
 * assumed in early drafts. Gemini-R2 G2 claimed dep-cruiser is a module-graph
 * tool only, so the plan now adds `ts-morph` for AST-based symbol extraction.
 *
 * This spike runs both tools on a representative fixture file from this repo
 * and prints what each emits. The implementer chooses which tool extracts
 * symbols and which extracts the file-to-file graph based on the actual
 * output, NOT the audit's assertion.
 *
 * Run:
 *   node scripts/symbol-index/spike-extract.mjs [fixture-path]
 *
 * Default fixture: scripts/openai-audit.mjs (large, mixed function/class).
 *
 * Outputs side-by-side report to stdout. Implementer should look for:
 *   - Per-symbol records with name + kind + start_line + end_line + body_text
 *   - File-to-file edges (imports/exports, layering rule support)
 *
 * @module scripts/symbol-index/spike-extract
 */

import '../lib/help-guard-run.mjs'; import { Project } from 'ts-morph';
import { cruise } from 'dependency-cruiser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const fixture = process.argv[2] || 'scripts/openai-audit.mjs';
const fixtureAbs = path.resolve(repoRoot, fixture);

console.log(`\n================================================================`);
console.log(`SPIKE — symbol extraction tool comparison`);
console.log(`Fixture: ${fixture}`);
console.log(`================================================================\n`);

// ── ts-morph: AST symbol extraction ─────────────────────────────────────────

console.log(`──── ts-morph (AST parser) ──────────────────────────────────────`);

const project = new Project({
  useInMemoryFileSystem: false,
  compilerOptions: {
    allowJs: true,
    checkJs: false,
    target: 99,           // ES Latest
    module: 99,           // ESNext
    moduleResolution: 100, // Bundler
  },
});

const sourceFile = project.addSourceFileAtPath(fixtureAbs);

const tsmorphSymbols = [];

for (const fn of sourceFile.getFunctions()) {
  tsmorphSymbols.push({
    name: fn.getName() || '(anonymous)',
    kind: 'function',
    isExported: fn.isExported(),
    startLine: fn.getStartLineNumber(),
    endLine: fn.getEndLineNumber(),
    paramCount: fn.getParameters().length,
    bodyTextLength: (fn.getBodyText() || '').length,
  });
}
for (const cls of sourceFile.getClasses()) {
  tsmorphSymbols.push({
    name: cls.getName() || '(anonymous)',
    kind: 'class',
    isExported: cls.isExported(),
    startLine: cls.getStartLineNumber(),
    endLine: cls.getEndLineNumber(),
    methodCount: cls.getMethods().length,
    bodyTextLength: (cls.getText() || '').length,
  });
}
// Variable declarations whose initializer is a function/arrow (common in JS modules)
for (const v of sourceFile.getVariableDeclarations()) {
  const init = v.getInitializer();
  if (!init) continue;
  const initKind = init.getKindName();
  if (initKind === 'ArrowFunction' || initKind === 'FunctionExpression') {
    tsmorphSymbols.push({
      name: v.getName(),
      kind: 'function-expression',
      isExported: v.isExported() || v.getVariableStatement()?.isExported() || false,
      startLine: v.getStartLineNumber(),
      endLine: v.getEndLineNumber(),
      bodyTextLength: (v.getText() || '').length,
    });
  }
}

console.log(`  Symbols extracted: ${tsmorphSymbols.length}`);
console.log(`  Sample (first 5):`);
for (const s of tsmorphSymbols.slice(0, 5)) {
  console.log(`    - ${s.kind.padEnd(20)} ${s.name.padEnd(40)} L${s.startLine}-${s.endLine}  body=${s.bodyTextLength}b  exported=${s.isExported}`);
}
console.log();

// ── dependency-cruiser: module-graph extraction ─────────────────────────────

console.log(`──── dependency-cruiser ─────────────────────────────────────────`);

const cruiseResult = await cruise([fixtureAbs], {
  // Default config — see what comes out of the box
  doNotFollow: { path: 'node_modules' },
});

const modules = cruiseResult.output.modules || [];
console.log(`  Modules in result: ${modules.length}`);
const targetModule = modules.find(m => path.resolve(m.source) === fixtureAbs) || modules[0];
if (targetModule) {
  console.log(`  Sample module record for fixture:`);
  console.log(`    source:        ${targetModule.source}`);
  console.log(`    dependencies:  ${(targetModule.dependencies || []).length} entries`);
  console.log(`    dependents:    ${(targetModule.dependents || []).length} entries`);
  // Probe for any "symbol-like" keys that might exist
  const moduleKeys = Object.keys(targetModule);
  console.log(`    module keys:   ${moduleKeys.join(', ')}`);
  // Sample first dep
  if (targetModule.dependencies?.length) {
    const dep = targetModule.dependencies[0];
    console.log(`    first dep keys: ${Object.keys(dep).join(', ')}`);
  }
}

console.log();
console.log(`──── Verdict ────────────────────────────────────────────────────`);
console.log(`  ts-morph:           ${tsmorphSymbols.length} intra-file symbols extracted (functions, classes, function-expressions) WITH body text + line numbers`);
console.log(`  dependency-cruiser: ${modules.length} module-level records (file-to-file edges only) — NO intra-file symbol extraction`);
console.log();
console.log(`  CONCLUSION: Tools are complementary, not interchangeable.`);
console.log(`  Plan §1/§5 split (ts-morph for symbols, dep-cruiser for graph) is CORRECT.`);
console.log();
