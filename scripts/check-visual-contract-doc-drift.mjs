#!/usr/bin/env node
/**
 * @fileoverview Drift gate between the visual-audit contract doc's own
 * annotated example and the real `VisualContractSchema` it claims to
 * describe (aged-out-acceptance-remainder.md §4, `e3da8d42`).
 *
 * `skills/visual-audit/references/contract-and-bootstrap.md` hand-reproduces
 * `scripts/lib/visual/schema.mjs` as a commented JSONC example — a doc a
 * human reads, not something the schema generates. `VisualContractSchema` is
 * `.strict()`, so a field documented but not implemented (or vice versa)
 * produces a contract that fails only at runtime.
 *
 * **The obvious fix (deduplicate the doc away) is the wrong one** — the doc
 * is an ANNOTATED example: each field carries an inline comment saying what
 * it is FOR, which `z.toJSONSchema(...)` does not encode and a generator
 * would destroy. This gate keeps the doc, and asks instead of the EMITTED
 * schema (never the Zod source — a `.strict()`/`.refine()`/`.default()` call
 * is source, not contract) whether the doc's key set and the schema's key
 * set agree, in both directions.
 *
 * **Deliberate scope boundary**: `themes[].apply` is a discriminated union
 * on `mode` (class/attribute/localStorage/media); the doc's one example
 * shows only `class`, and documents every mode's own fields separately in
 * prose (the "Theme-apply protocol" section) rather than repeating a
 * four-variant union inside one JSON example. Comparing `apply`'s own
 * children here would either force the example to grow four modes it does
 * not need, or produce a permanent, expected false positive — neither is
 * this gate's job. `apply` is checked as a KEY (present on both sides); its
 * variants are not.
 *
 * Usage:
 *   node scripts/check-visual-contract-doc-drift.mjs           # gate (exit 1 on drift)
 *   node scripts/check-visual-contract-doc-drift.mjs --json    # machine-readable
 *
 * Exit codes: 0 clean, 1 drift found, 2 invocation/read/parse error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { assertKnownFlags, emit, ArgvError } from './lib/cli-io.mjs';
import { VisualContractSchema } from './lib/visual/schema.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC_PATH = path.join(REPO_ROOT, 'skills/visual-audit/references/contract-and-bootstrap.md');
const KNOWN_FLAGS = ['--json', '--help', '-h', '--selfcheck-relocation'];

// Prefixes whose CHILDREN are compared as a nested key set. `themes[].apply`
// is deliberately absent — see the file's own docstring above.
const ARRAY_FIELDS = ['surfaces', 'tokenSources', 'themes'];
const NESTED_OBJECT_FIELDS = ['tolerances', 'propertyPolicy'];

const isMain = import.meta.url === `file://${process.argv[1]}`
  || import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`;

if (isMain) {
  try {
    assertKnownFlags(process.argv.slice(2), KNOWN_FLAGS, { cli: 'check-visual-contract-doc-drift', from: 0 });
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); process.exit(2); }
    throw err;
  }
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
}

/**
 * Strip `//` line comments from a JSONC snippet, respecting string
 * boundaries (a `//` inside a `"..."` string is not a comment). No block
 * comments — the doc's example uses none, and this gate should fail loudly
 * on a shape it does not understand rather than silently mishandling it.
 * @param {string} jsonc
 * @returns {string} plain JSON
 */
export function stripJsoncComments(jsonc) {
  let out = '';
  let inString = false;
  for (let i = 0; i < jsonc.length; i++) {
    const ch = jsonc[i];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += jsonc[++i] ?? ''; continue; } // copy the escaped char verbatim, unexamined
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && jsonc[i + 1] === '/') {
      while (i < jsonc.length && jsonc[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Extract the doc's own `## Schema (v1)` ```jsonc example as a parsed object.
 * Refuses (throws) rather than silently reading an empty/wrong block if the
 * doc is ever restructured — a gate that goes quiet on its own input drift is
 * the exact failure class this gate exists to prevent one level up.
 * @param {string} markdown
 * @returns {object}
 */
export function extractDocExample(markdown) {
  const headingIdx = markdown.indexOf('## Schema (v1)');
  if (headingIdx === -1) throw new Error('no "## Schema (v1)" heading found in the doc');
  const afterHeading = markdown.slice(headingIdx);
  const fenceMatch = afterHeading.match(/```jsonc\n([\s\S]*?)\n```/);
  if (!fenceMatch) throw new Error('no ```jsonc fence found under "## Schema (v1)"');
  return JSON.parse(stripJsoncComments(fenceMatch[1]));
}

/**
 * Flatten a parsed doc example (or a `z.toJSONSchema()` `properties` object,
 * via the sibling extractor below) into the SAME key-path vocabulary, so the
 * two sides are comparable set members rather than differently-shaped trees.
 * @param {object} example - the doc's parsed JSONC object
 * @returns {Set<string>}
 */
export function docKeyPaths(example) {
  const paths = new Set();
  for (const key of Object.keys(example)) {
    paths.add(key);
    if (ARRAY_FIELDS.includes(key) && Array.isArray(example[key]) && example[key][0]) {
      for (const childKey of Object.keys(example[key][0])) {
        if (key === 'themes' && childKey === 'apply') continue; // scope boundary — see file docstring
        paths.add(`${key}[].${childKey}`);
      }
    } else if (NESTED_OBJECT_FIELDS.includes(key) && example[key] && typeof example[key] === 'object') {
      for (const childKey of Object.keys(example[key])) paths.add(`${key}.${childKey}`);
    }
  }
  return paths;
}

/**
 * Same key-path vocabulary as `docKeyPaths`, read off `z.toJSONSchema(...)`'s
 * `properties` tree instead of the Zod source — a `.strict()`/`.default()`/
 * `.refine()` call is source, not contract; the emitted schema is what a
 * consumer actually receives (AGENTS.md, "Contracts across the prose↔code
 * seam").
 * @param {object} jsonSchema - `z.toJSONSchema(VisualContractSchema)`
 * @returns {Set<string>}
 */
export function schemaKeyPaths(jsonSchema) {
  const paths = new Set();
  for (const key of Object.keys(jsonSchema.properties)) {
    paths.add(key);
    const field = jsonSchema.properties[key];
    if (ARRAY_FIELDS.includes(key) && field.items?.properties) {
      for (const childKey of Object.keys(field.items.properties)) {
        if (key === 'themes' && childKey === 'apply') continue; // scope boundary — see file docstring
        paths.add(`${key}[].${childKey}`);
      }
    } else if (NESTED_OBJECT_FIELDS.includes(key) && field.properties) {
      for (const childKey of Object.keys(field.properties)) paths.add(`${key}.${childKey}`);
    }
  }
  return paths;
}

/**
 * Compare the doc's example against the live schema. Pure — both inputs are
 * already-parsed objects, so this is unit-testable without touching disk.
 * @param {object} docExample
 * @param {object} jsonSchema
 * @returns {{ok: boolean, docOnly: string[], schemaOnly: string[]}}
 */
export function diffContractDoc(docExample, jsonSchema) {
  const doc = docKeyPaths(docExample);
  const schema = schemaKeyPaths(jsonSchema);
  const docOnly = [...doc].filter((k) => !schema.has(k)).sort();
  const schemaOnly = [...schema].filter((k) => !doc.has(k)).sort();
  return { ok: docOnly.length === 0 && schemaOnly.length === 0, docOnly, schemaOnly };
}

function main() {
  const jsonOut = process.argv.includes('--json');
  let markdown;
  try {
    markdown = fs.readFileSync(DOC_PATH, 'utf-8');
  } catch (err) {
    if (jsonOut) emit({ ok: false, error: { code: 'READ_FAILED', message: err.message } });
    else process.stderr.write(`check-visual-contract-doc-drift: cannot read ${DOC_PATH}: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }

  let docExample;
  try {
    docExample = extractDocExample(markdown);
  } catch (err) {
    if (jsonOut) emit({ ok: false, error: { code: 'DOC_EXTRACT_FAILED', message: err.message } });
    else process.stderr.write(`check-visual-contract-doc-drift: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }

  const jsonSchema = z.toJSONSchema(VisualContractSchema);
  const result = diffContractDoc(docExample, jsonSchema);

  if (jsonOut) {
    emit({ ok: result.ok, docOnly: result.docOnly, schemaOnly: result.schemaOnly });
    return;
  }

  if (result.ok) {
    process.stdout.write('check-visual-contract-doc-drift: clean — the doc example and the emitted schema agree\n');
    return;
  }

  process.stderr.write('check-visual-contract-doc-drift: drift found\n');
  if (result.docOnly.length) {
    process.stderr.write(`  doc-only (documented, not in the schema — likely a typo or a removed field):\n`);
    for (const k of result.docOnly) process.stderr.write(`    ${k}\n`);
  }
  if (result.schemaOnly.length) {
    process.stderr.write(`  schema-only (a real field the doc never shows):\n`);
    for (const k of result.schemaOnly) process.stderr.write(`    ${k}\n`);
  }
  process.exitCode = 1;
}

if (isMain) main();
