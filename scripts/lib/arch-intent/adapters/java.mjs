/**
 * @fileoverview Java adapter for the architecture-intent framework.
 *
 * Pure-JS Java import analysis — NO JVM required. Parses `import`
 * declarations directly, resolves fully-qualified names against an index
 * built from parsed `package` declarations, and checks each local edge
 * against `domainMap.allowedDeps`.
 *
 * Conforms to the PR-A adapter contract: exports
 * `default async function analyseImports({mapped, domainMap, repoPath})`
 * returning `{violations, _meta, analyzerVersion}`.
 *
 * NOT an ArchUnit code generator — the original PR-B sketch proposed
 * generating ArchUnit test files, but that breaks the synchronous
 * `→ violations` adapter contract (see plan §1 Tension 2). This adapter
 * returns violations like every other adapter.
 *
 * @module scripts/lib/arch-intent/adapters/java
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveFileToDomain, checkDepAllowed, VENDOR_DOMAIN } from '../domain-resolver.mjs';

const VERSION = 'java-1.0.0';

/**
 * Known JDK / common-vendor FQN prefixes. The ONLY way a Java import becomes
 * `proven-external` (plan §2.4 row 2). A miss lands the import in
 * `unresolved` (visible), never a false violation.
 */
export const JAVA_VENDOR_PREFIXES = ['java.', 'javax.', 'jakarta.', 'kotlin.', 'sun.'];

// ── Lexical preprocessing ───────────────────────────────────────────────────

/**
 * Blank out comments and string/char literals, preserving newlines so
 * `line` numbers stay accurate. Handles `//`, `/* *​/`, double-quoted
 * strings, single-quoted char literals, and Java 15+ text blocks (`"""`).
 *
 * @param {string} source
 * @returns {string}
 */
export function stripJavaCommentsAndLiterals(source) {
  const out = [];
  const n = source.length;
  let i = 0;

  while (i < n) {
    const c = source[i];
    const c2 = source[i + 1];

    // Line comment
    if (c === '/' && c2 === '/') {
      while (i < n && source[i] !== '\n') { out.push(' '); i++; }
      continue;
    }
    // Block comment
    if (c === '/' && c2 === '*') {
      out.push('  '); i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out.push(source[i] === '\n' ? '\n' : ' '); i++;
      }
      if (i < n) { out.push('  '); i += 2; }
      continue;
    }
    // Text block """ ... """
    if (c === '"' && c2 === '"' && source[i + 2] === '"') {
      out.push('   '); i += 3;
      while (i < n && !(source[i] === '"' && source[i + 1] === '"' && source[i + 2] === '"')) {
        if (source[i] === '\\') {
          out.push(' ');
          if (i + 1 < n) out.push(source[i + 1] === '\n' ? '\n' : ' ');
          i += 2; continue;
        }
        out.push(source[i] === '\n' ? '\n' : ' '); i++;
      }
      if (i < n) { out.push('   '); i += 3; }
      continue;
    }
    // String / char literal
    if (c === '"' || c === "'") {
      const quote = c;
      out.push(' '); i++;
      while (i < n) {
        const ch = source[i];
        if (ch === '\\') {
          out.push(' ');
          if (i + 1 < n) out.push(source[i + 1] === '\n' ? '\n' : ' ');
          i += 2; continue;
        }
        if (ch === quote) { out.push(' '); i++; break; }
        // Raw newline ends a string/char literal (malformed Java, but stay
        // resilient). Break WITHOUT emitting/consuming it — the outer loop
        // emits it once; emitting here too would duplicate it → line drift.
        if (ch === '\n') { break; }
        out.push(' '); i++;
      }
      continue;
    }

    out.push(c);
    i++;
  }
  return out.join('');
}

// ── Extraction ──────────────────────────────────────────────────────────────

/**
 * Extract the `package` declaration from already-stripped Java source.
 * @param {string} strippedSource
 * @returns {string} package name, or '' for the default package
 */
export function extractPackage(strippedSource) {
  const m = /(^|\n)\s*package\s+([\w.]+)\s*;/.exec(strippedSource);
  return m ? m[2] : '';
}

/**
 * Extract `import` declarations from already-stripped Java source.
 *
 * Handles imports wrapped across physical lines (`import com.foo.\n  Bar;`)
 * — Java treats newlines as whitespace. The match pattern uses `[^;]*?`
 * (a negated character class, terminated by `;`) so it is strictly linear
 * — no nested quantifiers, no ReDoS, even though it runs over
 * attacker-influenceable file content.
 *
 * @param {string} strippedSource
 * @returns {Array<{fqn:string, isWildcard:boolean, isStatic:boolean, line:number}>}
 */
export function extractImports(strippedSource) {
  const refs = [];
  // `import` may be preceded by line-start, `;` (end of the package decl or
  // a previous import — `package x; import y;` and `import a; import b;` are
  // both legal on one physical line), or whitespace after either. A
  // ZERO-WIDTH lookbehind is used so the terminating `;` of one import is
  // not consumed — otherwise the next adjacent import's `;` prefix would be
  // eaten and the import missed. `[^;]*?` is negated-class + non-greedy →
  // strictly linear, no ReDoS.
  const re = /(?<=^|\n|;)\s*import\s+([^;]*?);/g;
  let m;
  while ((m = re.exec(strippedSource)) !== null) {
    let body = m[1].trim();
    let isStatic = false;
    if (/^static\b/.test(body)) {
      isStatic = true;
      body = body.replace(/^static\b/, '').trim();
    }
    let isWildcard = false;
    if (body.endsWith('*')) {
      isWildcard = true;
      body = body.slice(0, -1).replace(/\.\s*$/, '').trim();
    }
    const fqn = body.replace(/\s+/g, '');
    if (!fqn || !/^[\w.]+$/.test(fqn)) continue;
    // Line = position of the `import` keyword itself (m[1] + leading \s* may
    // include newlines before it).
    const kwIndex = m.index + m[0].indexOf('import');
    const line = strippedSource.slice(0, kwIndex).split('\n').length;
    refs.push({ fqn, isWildcard, isStatic, line });
  }
  return refs;
}

// ── Resolution index ────────────────────────────────────────────────────────

/**
 * Build the Java resolution index from parsed package declarations.
 *
 * @param {Map<string,string>} mapped
 * @param {string} repoPath
 * @returns {{fqnToFiles: Map<string,string[]>, packageToFiles: Map<string,string[]>,
 *   fileToSourceRoot: Map<string,string>, fileToPackage: Map<string,string>}}
 */
export function buildJavaResolutionIndex(mapped, repoPath) {
  const fqnToFiles = new Map();
  const packageToFiles = new Map();
  const fileToSourceRoot = new Map();
  const fileToPackage = new Map();

  const unreadable = [];
  for (const file of mapped.keys()) {
    if (path.extname(file).toLowerCase() !== '.java') continue;
    const norm = file.replaceAll('\\', '/');
    // package-info.java / module-info.java are JDK metadata files, not
    // importable classes — never index them as `package.ClassName`.
    const baseName = path.basename(norm);
    if (baseName === 'package-info.java' || baseName === 'module-info.java') continue;
    let pkg = '';
    try {
      const src = fs.readFileSync(path.join(repoPath, norm), 'utf-8');
      pkg = extractPackage(stripJavaCommentsAndLiterals(src));
    } catch {
      // Unreadable — do NOT fabricate a default-package entry (that would
      // produce a wrong FQN and could mis-resolve another file's import).
      // Skip it; surface the omission via _meta.unreadableFiles.
      unreadable.push(norm);
      continue;
    }

    const className = path.basename(norm).replace(/\.java$/i, '');
    const fqn = pkg ? `${pkg}.${className}` : className;

    if (!fqnToFiles.has(fqn)) fqnToFiles.set(fqn, []);
    fqnToFiles.get(fqn).push(norm);

    if (!packageToFiles.has(pkg)) packageToFiles.set(pkg, []);
    packageToFiles.get(pkg).push(norm);

    fileToPackage.set(norm, pkg);

    // Source root = file dir with the package-dir suffix removed.
    const dir = path.dirname(norm);
    const pkgAsDir = pkg.replaceAll('.', '/');
    let sourceRoot;
    if (pkg && (dir === pkgAsDir || dir.endsWith('/' + pkgAsDir))) {
      sourceRoot = dir.slice(0, dir.length - pkgAsDir.length).replace(/\/+$/, '');
    } else {
      sourceRoot = pkg ? '' : dir; // unconventional layout / default package
    }
    fileToSourceRoot.set(norm, sourceRoot);
  }

  // Deterministic ordering.
  for (const arr of fqnToFiles.values()) arr.sort((a, b) => a.localeCompare(b));
  for (const arr of packageToFiles.values()) arr.sort((a, b) => a.localeCompare(b));

  return {
    fqnToFiles, packageToFiles, fileToSourceRoot, fileToPackage,
    unreadableFiles: unreadable.sort((a, b) => a.localeCompare(b)),
  };
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Progressive FQN resolution: try the FQN, strip trailing segments on miss.
 * Self-correcting — the index holds only real `package.ClassName` keys.
 *
 * @param {string} fqn
 * @param {string} fromFile
 * @param {object} index
 * @returns {{state:string, targetFiles:string[], ambiguous?:boolean}}
 */
function progressiveResolve(fqn, fromFile, index) {
  let candidate = fqn;
  while (candidate.includes('.')) {
    const hit = index.fqnToFiles.get(candidate);
    if (hit && hit.length > 0) {
      if (hit.length === 1) return { state: 'resolved-local', targetFiles: hit };
      // >1 — prefer the importing file's source root.
      const fromRoot = index.fileToSourceRoot.get(fromFile);
      const sameRoot = hit.filter(f => index.fileToSourceRoot.get(f) === fromRoot);
      if (sameRoot.length === 1) return { state: 'resolved-local', targetFiles: sameRoot };
      return { state: 'resolved-local', targetFiles: hit, ambiguous: true };
    }
    candidate = candidate.slice(0, candidate.lastIndexOf('.'));
  }
  // Exhausted — vendor prefix or unresolved.
  if (JAVA_VENDOR_PREFIXES.some(p => fqn.startsWith(p))) {
    return { state: 'proven-external', targetFiles: [] };
  }
  return { state: 'unresolved', targetFiles: [] };
}

/**
 * Resolve one import ref. Four cases on (isStatic, isWildcard) — plan §2.2.3.
 *
 * @param {object} ref - an extractImports entry
 * @param {string} fromFile
 * @param {object} index
 * @returns {{state:string, targetFiles:string[], ambiguous?:boolean}}
 */
export function resolveJavaImport(ref, fromFile, index) {
  const { fqn, isStatic, isWildcard } = ref;

  // Case 3 — non-static wildcard. Two JLS forms (7.5.2):
  //   (a) package wildcard `import com.foo.*;`         → com.foo is a package
  //   (b) type-import-on-demand `import com.foo.Outer.*;` → com.foo.Outer is a class
  if (isWildcard && !isStatic) {
    const files = index.packageToFiles.get(fqn);
    if (files && files.length > 0) {
      // (a) package wildcard — prefer the importing file's own source set
      // (a package can exist in both src/main and src/test). Fall back to all.
      const fromRoot = index.fileToSourceRoot.get(fromFile);
      const sameRoot = files.filter(f => index.fileToSourceRoot.get(f) === fromRoot);
      const targetFiles = sameRoot.length > 0 ? sameRoot : files;
      return { state: 'resolved-local', targetFiles, wildcard: true };
    }
    // (b) not a known package — try type-import-on-demand: the FQN may be a
    // class whose nested types are being imported. Resolve it as a class.
    const asType = progressiveResolve(fqn, fromFile, index);
    if (asType.state === 'resolved-local') return { ...asType, wildcard: true };
    if (JAVA_VENDOR_PREFIXES.some(p => fqn.startsWith(p))) {
      return { state: 'proven-external', targetFiles: [] };
    }
    return { state: 'unresolved', targetFiles: [] };
  }

  // Case 4 — static wildcard: `import static com.foo.Bar.*;` — Bar is a class.
  if (isWildcard && isStatic) {
    return progressiveResolve(fqn, fromFile, index);
  }

  // Case 2 — static member import: strip the trailing member, then resolve.
  if (isStatic && !isWildcard) {
    const stripped = fqn.includes('.') ? fqn.slice(0, fqn.lastIndexOf('.')) : fqn;
    return progressiveResolve(stripped, fromFile, index);
  }

  // Case 1 — plain import (incl. nested types via progressive stripping).
  return progressiveResolve(fqn, fromFile, index);
}

// ── Adapter entry point ─────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {Map<string,string>} opts.mapped
 * @param {object} opts.domainMap
 * @param {string} opts.repoPath
 * @returns {Promise<{violations:Array, _meta:object, analyzerVersion:string}>}
 */
export default async function analyseImports({ mapped, domainMap, repoPath }) {
  const meta = {
    edgeCount: 0,
    localEdges: 0,
    wildcardEdges: 0,
    vendorEdges: 0,
    staticImports: 0,
    unresolvedEdges: [],
    ambiguousEdges: [],
    packagesSpanningDomains: [],
    unreadableFiles: [],
    sourceRoots: [],
    allFiles: [],
  };

  const javaFiles = [...mapped.keys()]
    .filter(f => path.extname(f).toLowerCase() === '.java')
    .map(f => f.replaceAll('\\', '/'))
    .sort((a, b) => a.localeCompare(b));

  if (javaFiles.length === 0) {
    return { violations: [], _meta: meta, analyzerVersion: VERSION };
  }

  const index = buildJavaResolutionIndex(mapped, repoPath);
  meta.allFiles = javaFiles;
  meta.unreadableFiles = index.unreadableFiles;
  meta.sourceRoots = [...new Set(index.fileToSourceRoot.values())].sort((a, b) => a.localeCompare(b));

  // Compute packages spanning >1 domain (H3 soundness signal).
  for (const [pkg, files] of index.packageToFiles) {
    const domains = new Set();
    for (const f of files) {
      const d = mapped.get(f) ?? resolveFileToDomain(f, domainMap.rules);
      if (d) domains.add(d);
    }
    if (domains.size > 1) {
      meta.packagesSpanningDomains.push({
        package: pkg || '(default)',
        domains: [...domains].sort((a, b) => a.localeCompare(b)),
        files: [...files].sort((a, b) => a.localeCompare(b)),
      });
    }
  }
  meta.packagesSpanningDomains.sort((a, b) => a.package.localeCompare(b.package));

  const violations = [];
  const seenViolation = new Set();

  for (const fromFile of javaFiles) {
    let source;
    try { source = fs.readFileSync(path.join(repoPath, fromFile), 'utf-8'); }
    catch { continue; }

    const stripped = stripJavaCommentsAndLiterals(source);
    const refs = extractImports(stripped);
    const fromDomain = mapped.get(fromFile) ?? resolveFileToDomain(fromFile, domainMap.rules);
    if (!fromDomain) continue;

    for (const ref of refs) {
      meta.edgeCount++;
      if (ref.isStatic) meta.staticImports++;

      const res = resolveJavaImport(ref, fromFile, index);

      if (res.state === 'proven-external') { meta.vendorEdges++; continue; }
      if (res.state === 'unresolved') {
        meta.unresolvedEdges.push({ from: fromFile, fqn: ref.fqn, line: ref.line });
        continue;
      }
      if (res.ambiguous) {
        meta.ambiguousEdges.push({ from: fromFile, fqn: ref.fqn, candidates: res.targetFiles });
      }
      if (res.wildcard) meta.wildcardEdges++;

      // resolved-local. For wildcards, collapse to one edge per target DOMAIN.
      const toFileMarker = ref.isWildcard && !ref.isStatic ? `${ref.fqn}.*` : null;
      const domainsSeen = new Set();

      for (const tFile of res.targetFiles) {
        if (tFile === fromFile) continue;
        const toDomain = mapped.get(tFile) ?? resolveFileToDomain(tFile, domainMap.rules);
        if (!toDomain) continue;

        if (toFileMarker) {
          // Wildcard: one edge per distinct target domain.
          if (domainsSeen.has(toDomain)) continue;
          domainsSeen.add(toDomain);
          if (!checkDepAllowed(fromDomain, toDomain, domainMap.allowedDeps)) {
            const key = `${fromFile} ${toFileMarker} ${toDomain}`;
            if (!seenViolation.has(key)) {
              seenViolation.add(key);
              violations.push({
                fromFile, toFile: toFileMarker, fromDomain, toDomain,
                ruleViolated: 'not-in-allowedDeps',
              });
            }
          }
        } else {
          meta.localEdges++;
          if (!checkDepAllowed(fromDomain, toDomain, domainMap.allowedDeps)) {
            const key = `${fromFile} ${tFile}`;
            if (!seenViolation.has(key)) {
              seenViolation.add(key);
              violations.push({
                fromFile, toFile: tFile, fromDomain, toDomain,
                ruleViolated: 'not-in-allowedDeps',
              });
            }
          }
        }
      }
    }
  }

  violations.sort((a, b) =>
    a.fromFile.localeCompare(b.fromFile) || a.toFile.localeCompare(b.toFile));

  return { violations, _meta: meta, analyzerVersion: VERSION };
}

export const _internals = {
  stripJavaCommentsAndLiterals, extractImports, extractPackage,
  buildJavaResolutionIndex, resolveJavaImport, progressiveResolve,
  JAVA_VENDOR_PREFIXES,
};
