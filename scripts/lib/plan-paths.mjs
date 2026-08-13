/**
 * @fileoverview Plan path extraction — regex + fuzzy keyword discovery of
 * source file paths referenced in plan documents.
 *
 * Split from file-io.mjs (Wave 2, Phase 2) for Single Responsibility.
 * @module scripts/lib/plan-paths
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ALL_EXTENSIONS_PATTERN, toExtensionAlternation } from './language-profiles.mjs';
import { normalizePath } from './file-io.mjs';
import { isSensitiveFile, isAuditInfraFile } from './audit-scope.mjs';
import { listRepoFiles, resolveUniqueSuffix } from './repo-inventory.mjs';

/**
 * Below this many REGEX-resolvable paths, Phase 2 fuzzy keyword discovery
 * fires and fills the scope from plan *words*. Measured 2026-07-19: a plan
 * with 4 resolvable paths pulled in 21 unrelated files matched on words like
 * "findings", and the resulting audit returned 17 findings, 16 of them citing
 * files the change never touched. Named (not inlined) so the `plan-paths`
 * self-check CLI reports the same number the branch below tests.
 */
export const FUZZY_DISCOVERY_THRESHOLD = 5;

/**
 * Extensions a PLAN may reference. Deliberately WIDER than
 * `ALL_SUPPORTED_EXTENSIONS` (which drives code parsing): a plan is prose about
 * a change and legitimately names Rust/Go/Java/Ruby/shell files in repos whose
 * code-analysis profile does not cover them. Kept as an array, never a
 * pre-joined string — the alternation ORDER is a correctness property and
 * belongs to `toExtensionAlternation`, not to whoever edits this list.
 */
export const PLAN_REFERENCE_EXTENSIONS = Object.freeze([
  'js', 'mjs', 'ts', 'tsx', 'jsx', 'sql', 'css', 'html', 'json', 'md',
  'py', 'rs', 'go', 'java', 'rb', 'sh',
]);

// ── Plan Path Extraction ──────────────────────────────────────────────────

/**
 * Extract source file paths from a plan. Purely regex-driven.
 *
 * @param {string} planContent
 * @param {object} [opts]
 * @param {boolean} [opts.allowInfraFiles=false] - Skip the `isAuditInfraFile`
 *   exclusion. That exclusion exists to stop the audit tool from treating its
 *   OWN control-plane files (schemas.mjs, ledger.mjs, openai-audit.mjs, …) as
 *   a feature's subject files during a NORMAL (consumer-code) audit — correct
 *   for that case. A META-plan whose deliverable genuinely IS a change to the
 *   audit tool's own infrastructure needs the opposite: those files must be
 *   readable as the subject. Opt in explicitly (CLI: `--allow-infra-scope`);
 *   default stays false so ordinary audits are unaffected.
 * @returns {{found: string[], missing: string[], allPaths: Set<string>,
 *   regexFoundCount: number, fuzzyAdded: number}}
 *   `regexFoundCount` is the Phase-1 (regex) resolvable count BEFORE fuzzy
 *   discovery, and `fuzzyAdded` how many files Phase 2 added. Both are reported
 *   because `found.length` alone cannot tell you whether you crossed the
 *   fuzzy threshold — fuzzy results are already folded into it, which is
 *   exactly the state the /plan self-check needs to warn about.
 */
/**
 * Union scope-supplied files (from `--files`, or `--scope diff`'s changed-file
 * detection) into the plan-derived subject list.
 *
 * **Why this exists.** `--files`/`--scope diff` were only ever a FILTER: the
 * subject list came from `extractPlanPaths`, and every pass then intersected it
 * with the filter (`found.filter(f => fileFilter.some(...))`). A changed file
 * the plan document never mentions could therefore be passed in `--changed`
 * AND `--files` and still be read by nobody — the intersection silently
 * dropped it. Measured 2026-08-09: `scripts/lib/audit/duplication-detector.mjs`
 * was changed and in-scope for 15 consecutive rounds of its own audit, and
 * appeared in zero rounds' `code_files`; the structure pass only ever confirmed
 * it "exists in the repository inventory". Found by the shadow reviewer, not by
 * the audit — the tool could not see its own blind spot.
 *
 * The degenerate case is worse than the partial one: a plan that references
 * none of the files you changed yields an EMPTY intersection, so every pass
 * runs on nothing and the audit still returns a verdict. That is precisely the
 * "can this return green without having checked anything" shape AGENTS.md's
 * pre-ship doctrine names.
 *
 * Applies the same admission guards as `extractPlanPaths`, so a scope-supplied
 * path can never widen the audit past what a plan-referenced one could reach:
 * infra-file exclusion (unless `allowInfraFiles`), no `node_modules`/URLs, the
 * `PLAN_REFERENCE_EXTENSIONS` allowlist, and it must exist on disk.
 *
 * Pure and order-stable: plan files keep their position, scope-added files are
 * appended in the order given. Returns them separately so callers can report
 * "N from the plan + M from the changed set" honestly rather than conflating
 * the two — the plan-accounting numbers (`missing`, `allPaths`) must keep
 * describing the PLAN.
 *
 * @param {string[]} planFound - `extractPlanPaths(...).found`
 * @param {string[]|null|undefined} scopeFiles - the effective file filter
 * @param {{allowInfraFiles?: boolean}} [opts]
 * @returns {{files: string[], addedFromScope: string[], rejected: string[]}}
 */
export function mergeScopeFiles(planFound, scopeFiles, { allowInfraFiles = false } = {}) {
  const base = Array.isArray(planFound) ? planFound : [];
  if (!Array.isArray(scopeFiles) || scopeFiles.length === 0) {
    return { files: [...base], addedFromScope: [], rejected: [] };
  }
  const allowedExt = new Set(PLAN_REFERENCE_EXTENSIONS);
  const already = new Set(base.map(p => normalizePath(p)));
  const addedFromScope = [];
  const rejected = [];
  const seen = new Set();

  for (const raw of scopeFiles) {
    if (typeof raw !== 'string' || raw === '') continue;
    const p = raw.replace(/^\.\//, '');
    const key = normalizePath(p);
    if (already.has(key) || seen.has(key)) continue;
    seen.add(key);
    if (p.startsWith('http') || p.startsWith('node_modules')) { rejected.push(p); continue; }
    if (!allowInfraFiles && isAuditInfraFile(p)) { rejected.push(p); continue; }
    const ext = p.includes('.') ? p.slice(p.lastIndexOf('.') + 1).toLowerCase() : '';
    if (!allowedExt.has(ext)) { rejected.push(p); continue; }
    if (!fs.existsSync(path.resolve(p))) { rejected.push(p); continue; }
    addedFromScope.push(p);
  }
  return { files: [...base, ...addedFromScope], addedFromScope, rejected };
}

export function extractPlanPaths(planContent, { allowInfraFiles = false, repoFiles = null } = {}) {
  const paths = new Set();
  let match;
  const infraExcluded = (p) => !allowInfraFiles && isAuditInfraFile(p);

  // ── Cited-path resolution (single oracle — see `resolveUniqueSuffix`) ──
  // A plan writes paths as PROSE, routinely relative to a subtree it named a
  // heading ago: `zone/zoneChat.js` for `src/services/zone/zoneChat.js`. A bare
  // `fs.existsSync` calls that missing, which (a) hides an existing file from
  // the audited set entirely and (b) announces it to the model as
  // `**Missing:** …`. Ambiguity and true absence stay missing — resolving them
  // would trade a false "missing" for a false "found", manufacturing coverage.
  //
  // The inventory is built LAZILY: a plan whose paths all resolve literally
  // (this repo's own, mostly) never pays for the `git ls-files` call.
  let _inventory = repoFiles;
  const inventory = () => {
    if (_inventory === null) _inventory = listRepoFiles({ baseDir: process.cwd() }).files;
    return _inventory;
  };
  /** @returns {string|null} the real repo path, or null if unresolvable. */
  const resolveCited = (p) => {
    if (fs.existsSync(path.resolve(p))) return p;
    const hit = resolveUniqueSuffix(p, inventory());
    if (hit.status !== 'exact' && hit.status !== 'suffix') return null;
    // Re-apply the infra guard to the RESOLVED path. The extraction-time check
    // saw the cited string, and `isAuditInfraFile` keys on a `scripts/` prefix
    // the citation may not carry — so without this, resolving `lib/schemas.mjs`
    // to `scripts/lib/schemas.mjs` would be a way around the guard.
    if (infraExcluded(hit.resolved)) return null;
    return hit.resolved;
  };

  // Longest-first via the shared builder — a hand-written `js|…|json` order
  // matches `config.json` as `config.js` (see toExtensionAlternation).
  const EXT = toExtensionAlternation(PLAN_REFERENCE_EXTENSIONS);

  // Phase 1: Exact path regex extraction (backtick paths, inline paths, heading filenames)
  const genericPathRegex = new RegExp(`(?:^|\\s|\\\`|\\()((?:\\.?[\\w.-]+\\/)+[\\w.-]+\\.(?:${EXT}))`, 'gm');
  while ((match = genericPathRegex.exec(planContent)) !== null) {
    const p = match[1].replace(/^\.\//, '');
    if (!p.startsWith('http') && !p.startsWith('node_modules') && !infraExcluded(p)) paths.add(p);
  }

  const btRegex = new RegExp(`\\\`((?:\\.?[\\w.-]+\\/)+[\\w.-]+\\.(?:${EXT}))\\\``, 'gm');
  while ((match = btRegex.exec(planContent)) !== null) {
    const p = match[1].replace(/^\.\//, '');
    if (!p.startsWith('http') && !p.startsWith('node_modules') && !infraExcluded(p)) paths.add(p);
  }

  const fnRegex = new RegExp(`####\\s+\`([\\w./-]+\\.(?:${ALL_EXTENSIONS_PATTERN}))\``, 'gm');
  while ((match = fnRegex.exec(planContent)) !== null) {
    const captured = match[1];
    if (captured.includes('/')) {
      const normalized = captured.replace(/^\.\//, '');
      if (!normalized.startsWith('http') && !normalized.startsWith('node_modules') && !infraExcluded(normalized)) paths.add(normalized);
      continue;
    }
    const filename = captured;
    if ([...paths].some(p => p.endsWith('/' + filename) || p === filename)) continue;
    const searchDirs = [
      'src/config', 'src/routes', 'src/services', 'src/schemas',
      'scripts', 'lib', 'utils', '.claude/skills', '.github/skills'
    ];
    for (const dir of searchDirs) {
      const candidate = `${dir}/${filename}`;
      if (fs.existsSync(path.resolve(candidate)) && !infraExcluded(candidate)) { paths.add(candidate); break; }
    }
  }

  // Phase 2: Fuzzy keyword discovery — only when Phase 1 found very few files.
  // Counted through the SAME resolver as the final split: a suffix-resolvable
  // path is resolvable, and counting it as unresolved used to depress this
  // number below FUZZY_DISCOVERY_THRESHOLD and fire keyword discovery — which
  // measurably pulls in unrelated files (see that constant's note).
  const regexFoundCount = [...paths].filter(p => resolveCited(p) !== null).length;
  let fuzzyAdded = 0;
  if (regexFoundCount < FUZZY_DISCOVERY_THRESHOLD) {
    const keywords = _extractPlanKeywords(planContent);
    if (keywords.length > 0) {
      const repoFiles = _scanRepoFiles({ allowInfraFiles });
      const beforeCount = paths.size;
      for (const file of repoFiles) {
        const basename = path.basename(file).toLowerCase().replace(/\.[^.]+$/, '').replaceAll(/[._-]/g, '');
        if (basename.length < 3) continue;
        for (const kw of keywords) {
          if (kw.length >= 6 && basename.includes(kw) && kw.length >= basename.length * 0.5) {
            paths.add(file);
            break;
          }
        }
      }
      const added = paths.size - beforeCount;
      fuzzyAdded = added;
      if (added > 0) {
        process.stderr.write(`  [plan-paths] Fuzzy discovery: +${added} files from ${keywords.length} plan keywords\n`);
      }
    }
  }

  const resolved = new Map();
  for (const p of paths) {
    const abs = path.resolve(p);
    if (!resolved.has(abs)) resolved.set(abs, p);
  }

  const found = [];
  const missing = [];
  const suffixResolved = [];
  const allPaths = new Set();
  // Dedup on the REAL path: a plan that writes both `config/grapeColourMap.js`
  // and `src/config/grapeColourMap.js` names one file, and counting it twice
  // inflates `files_planned` with a phantom.
  const seenReal = new Set();
  for (const p of [...resolved.values()].sort((a, b) => a.localeCompare(b))) {
    const real = resolveCited(p);
    if (real === null) {
      missing.push(p);
      allPaths.add(p);
      continue;
    }
    if (real !== p) suffixResolved.push({ cited: p, resolved: real });
    allPaths.add(real);
    if (seenReal.has(real)) continue;
    seenReal.add(real);
    found.push(real);
  }
  return { found, missing, allPaths, regexFoundCount, fuzzyAdded, suffixResolved };
}

// ── Internal Helpers ──────────────────────────────────────────────────────

function _extractPlanKeywords(planContent) {
  const keywords = new Set();

  const pascalRegex = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g;
  let m;
  while ((m = pascalRegex.exec(planContent)) !== null) {
    keywords.add(m[1].toLowerCase());
    const parts = m[1].replaceAll(/([A-Z])/g, ' $1').trim().split(/\s+/);
    for (const part of parts) {
      if (part.length >= 4) keywords.add(part.toLowerCase());
    }
  }

  const btIdentRegex = /`([A-Za-z][\w]+)`/g;
  while ((m = btIdentRegex.exec(planContent)) !== null) {
    const ident = m[1];
    if (ident.includes('/') || /\.\w{1,4}$/.test(ident)) continue;
    if (ident.length >= 4) keywords.add(ident.toLowerCase());
  }

  const headingRegex = /^#{2,4}\s+(.+)$/gm;
  while ((m = headingRegex.exec(planContent)) !== null) {
    const words = m[1].replaceAll(/[^a-zA-Z\s]/g, '').split(/\s+/);
    for (const w of words) {
      if (w.length >= 4) keywords.add(w.toLowerCase());
    }
  }

  const noise = new Set([
    'this', 'that', 'with', 'from', 'will', 'should', 'must', 'have', 'been',
    'when', 'where', 'what', 'which', 'each', 'every', 'some', 'many', 'more',
    'than', 'then', 'into', 'also', 'only', 'over', 'such', 'both', 'after',
    'before', 'other', 'about', 'between', 'through', 'during', 'without',
    'within', 'along', 'following', 'across', 'behind', 'beyond', 'plus',
    'implementation', 'overview', 'summary', 'approach', 'architecture',
    'design', 'pattern', 'context', 'example', 'notes', 'details',
    'step', 'phase', 'plan', 'task', 'issue', 'error', 'status',
    'true', 'false', 'null', 'undefined', 'string', 'number', 'boolean',
    'function', 'class', 'const', 'export', 'import', 'async', 'await',
    'return', 'default', 'interface', 'type'
  ]);
  return [...keywords].filter(kw => !noise.has(kw) && kw.length >= 3);
}

function _scanRepoFiles({ allowInfraFiles = false } = {}) {
  const EXT_SET = new Set(['.js', '.mjs', '.ts', '.tsx', '.jsx', '.sql', '.css', '.html', '.json', '.py', '.rs', '.go', '.java', '.rb', '.sh', '.vue', '.svelte']);
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.tox', 'coverage', '.nyc_output', 'vendor', '.venv', 'venv', '.claude', '.github', 'docs']);
  const results = [];

  function walk(dir, depth) {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (EXT_SET.has(ext) && !isSensitiveFile(entry.name)) {
          const rel = path.relative(process.cwd(), full).replaceAll(/\\/g, '/');
          if (allowInfraFiles || !isAuditInfraFile(rel)) results.push(rel);
        }
      }
    }
  }

  walk(process.cwd(), 0);
  return results;
}

// ── CLI: the /plan Gate-1 self-check ──────────────────────────────────────
//
// Exists as a real CLI (not a `node -e "import('./scripts/lib/…')"` snippet in
// SKILL.md) because that snippet form is invisible to the consumer sync's
// command rewriter — it only rewrites `node scripts/<path>` — so the pasted
// self-check died with ERR_MODULE_NOT_FOUND in every consumer repo, where the
// module lives under `scripts/.claude-skills/lib/`. Reported 2026-08-08. The
// check that guards against the fuzzy-discovery trap must not itself be the
// thing that is broken.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const planFile = process.argv[2];
  if (!planFile) {
    process.stderr.write('Usage: node scripts/lib/plan-paths.mjs <plan-file.md>\n');
    process.exit(1);
  }
  let content;
  try {
    content = fs.readFileSync(path.resolve(planFile), 'utf-8');
  } catch (err) {
    process.stderr.write(`Error: cannot read ${planFile} — ${err.message}\n`);
    process.exit(1);
  }
  // allowInfraFiles mirrors what a meta-plan audit would see; it only widens
  // what counts as resolvable, so it never hides a threshold problem.
  const r = extractPlanPaths(content, { allowInfraFiles: true });
  process.stdout.write(
    `plan-paths: ${planFile}\n`
    + `  regex-resolvable : ${r.regexFoundCount}   (fuzzy fires below ${FUZZY_DISCOVERY_THRESHOLD})\n`
    + `  fuzzy added      : ${r.fuzzyAdded}\n`
    + `  found (total)    : ${r.found.length}\n`
    + `  missing          : ${r.missing.length}\n`,
  );
  if (r.missing.length > 0) {
    process.stdout.write(`  unresolved       : ${r.missing.slice(0, 10).join(', ')}${r.missing.length > 10 ? ', …' : ''}\n`);
  }
  if (r.regexFoundCount < FUZZY_DISCOVERY_THRESHOLD) {
    process.stdout.write(
      `\n  WARNING: only ${r.regexFoundCount} path(s) resolved by regex, so fuzzy keyword\n`
      + '  discovery ran and filled the scope from plan WORDS. Check that every path is\n'
      + '  written repo-relative (scripts/foo.mjs, never foo.mjs) — a bare basename is\n'
      + '  invisible to the extractor. A small plan may legitimately sit under the\n'
      + '  threshold: the point is to KNOW it, never to invent paths to clear it.\n',
    );
  }
  // Report-only: a low count can be correct. Exit 0 so this can be pasted into
  // any flow without becoming a gate it was never designed to be.
  process.exit(0);
}
