/**
 * @fileoverview The library files a hook (or any script) needs at runtime, DERIVED from the import graph.
 *
 * Two hook-layout tests copied a hand-kept list of `scripts/lib` siblings into a throwaway tree. The list was a second
 * spelling of the closure: when `file-taxonomy.mjs` gained an import (`bundle-generated-stores.mjs`, upstream 3b84d8bb),
 * the fixture silently lacked the new module and the hook could not load its library, four tests red on CI while main was
 * green. The sync derives its consumer closure from the same graph (`collectImportClosure`, as `sync-to-repos.mjs` does),
 * so a fixture derived here can never be narrower than what a consumer actually receives.
 *
 * @module tests/helpers/lib-closure
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectImportClosure } from '../../scripts/lib/module-graph.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIB_PREFIX = 'scripts/lib/';

function listMjs(relDir, out = []) {
  for (const e of fs.readdirSync(path.join(REPO_ROOT, relDir), { withFileTypes: true })) {
    const rel = `${relDir}/${e.name}`;
    if (e.isDirectory()) listMjs(rel, out);
    else if (e.name.endsWith('.mjs')) out.push(rel);
  }
  return out;
}

/**
 * Every `scripts/lib` file in the transitive import closure of `entry`, relative to `scripts/lib/` (so a fixture can
 * place each one under any tooling root and keep the relative imports intact). Includes the entry itself.
 *
 * Throws on an unresolved import: a closure with a hole would build a fixture that fails for the wrong reason.
 *
 * @param {string} entry repo-relative, e.g. `scripts/lib/sensitive-paths.mjs`
 * @returns {string[]} paths relative to `scripts/lib/`, sorted
 */
export function libClosureOf(entry) {
  const repoFiles = new Set(listMjs('scripts'));
  const { files, unresolved } = collectImportClosure({
    entryPoints: [entry],
    repoFiles,
    readFile: (p) => { try { return fs.readFileSync(path.join(REPO_ROOT, p), 'utf8'); } catch { return null; } },
  });
  const real = unresolved.filter((u) => !/[\s`${}]/.test(u.specifier));
  if (real.length > 0) throw new Error(`lib closure of ${entry} has unresolved import(s): ${JSON.stringify(real)}`);
  const outside = files.filter((f) => !f.startsWith(LIB_PREFIX));
  if (outside.length > 0) throw new Error(`lib closure of ${entry} reaches outside scripts/lib: ${outside.join(', ')}`);
  return files.map((f) => f.slice(LIB_PREFIX.length)).sort();
}

/**
 * Copy `libClosureOf(entry)` from the real tree into `destLibDir`, keeping each file's position relative to `scripts/lib`.
 * @param {string} entry
 * @param {string} destLibDir
 * @returns {string[]} the relative paths copied
 */
export function copyLibClosure(entry, destLibDir) {
  const rels = libClosureOf(entry);
  for (const rel of rels) {
    const dest = path.join(destLibDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'lib', ...rel.split('/')), dest);
  }
  return rels;
}
