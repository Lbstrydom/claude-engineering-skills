/**
 * @fileoverview The ONE protected-set model. The snapshot, the classification and the registered-only authorization check
 * all read this: registry entries + the base import closure of each registered gate entry point + the subprocess helpers
 * a closure module spawns (recursively, with their own closures).
 *
 * A module imported by a gate is code the verdict depends on; so is a script a gate SPAWNS, which no import graph sees.
 * Subprocess helpers are found as string literals (`scripts/x.mjs`, or `join(..., 'scripts', 'x.mjs')`) in a closure
 * module that mentions a process-spawning call. Computed paths are not followed - the residual, named in the doc.
 *
 * @module scripts/lib/gate-provenance/protected-set
 */
import { collectImportClosure } from '../module-graph.mjs';

// ANY way of reaching child_process: a static import (named, aliased, namespace or default), require, or a dynamic import.
const CHILD_PROCESS = /(?:from|require\s*[(]|import\s*[(])[^'"`]{0,20}['"](?:node:)?child_process['"]/;
const SCRIPT_LITERAL = /['"`]((?:\.\/)?scripts\/[A-Za-z0-9_./-]+\.mjs)['"`]/g;
const JOIN_LITERAL = /['"`]scripts['"`]\s*,\s*['"`]([A-Za-z0-9_./-]+\.mjs)['"`]/g;

/** Existing repo scripts named by a module that imports child_process (any binding). */
export function subprocessScripts(content, repoFiles) {
  if (typeof content !== 'string' || !CHILD_PROCESS.test(content)) return [];
  const out = new Set();
  for (const m of content.matchAll(SCRIPT_LITERAL)) out.add(m[1].replace(/^\.\//, ''));
  for (const m of content.matchAll(JOIN_LITERAL)) out.add(`scripts/${m[1]}`);
  return [...out].filter((p) => repoFiles.has(p));
}

/**
 * Closure of `entryPoints` over imports AND spawned helper scripts, to a fixpoint.
 * @returns {{files: string[], helpers: string[], unresolved: object[]}}
 */
export function protectedClosure({ entryPoints, repoFiles, readFile }) {
  const set = repoFiles instanceof Set ? repoFiles : new Set(repoFiles);
  const roots = new Set(entryPoints);
  const helpers = new Set();
  let closure;
  for (;;) {
    closure = collectImportClosure({ entryPoints: [...roots], repoFiles: set, readFile });
    let grew = false;
    for (const f of closure.files) {
      for (const h of subprocessScripts(readFile(f), set)) {
        if (!roots.has(h) && !closure.files.includes(h)) { roots.add(h); helpers.add(h); grew = true; }
      }
    }
    if (!grew) break;
  }
  return { files: closure.files, helpers: [...helpers].sort(), unresolved: closure.unresolved };
}
