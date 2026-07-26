/**
 * @fileoverview Orchestration-side resolver that turns git refs into a
 * fully-resolved DiffScope record for the orphan-introduced detector.
 *
 * Owns:
 *   - git CLI invocations (all use `-z` for null-byte termination — Gemini-R4/M1).
 *   - AST-based pre-edge extraction from base-revision preimage files
 *     (dependency-cruiser on a temp tree — parity with the HEAD adapter).
 *   - Entry-point set computation (package.json + scripts + tsconfig
 *     reverse-resolution — Gemini-R3/M1).
 *
 * The detector ([orphan-introduced.mjs]) is pure and consumes the result.
 *
 * @module scripts/lib/audit/diff-scope-resolver
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cruise } from 'dependency-cruiser';

const SOURCE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
]);

function stripLeadingDotSlash(s) {
  return typeof s === 'string' && s.startsWith('./') ? s.slice(2) : s;
}

/**
 * Top-level entry-point file lister. Adds source files DIRECTLY in `rel`
 * (no recursion into subdirectories).
 *
 * **Gemini-final-gate wrongly-dismissed-H1-R3 fix**: recursive walks of
 * `scripts/` blanket-exempted scripts/lib/** (the shared-lib code the
 * orphan detector is supposed to audit). Phase 1 intent is to exempt
 * only the top-level entry scripts in scripts/* and bin/*, not their
 * library subtrees.
 *
 * **Gemini-final-gate wrongly-dismissed-H3 fix**: previously swallowed
 * fs errors silently; now logs to stderr so operators can correlate
 * empty entry-point sets with the underlying readdir failure.
 *
 * @param {string} repoPath
 * @param {string} rel - directory to list, relative to repoPath
 * @param {Set<string>} out - accumulator
 */
function walkEntryPointDir(repoPath, rel, out) {
  const abs = path.join(repoPath, rel);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (err) {
    process.stderr.write(`  [orphan] entry-point discovery failed for ${rel}: ${err.message}\n`);
    return;
  }
  for (const e of entries) {
    if (!e.isFile()) continue; // intentionally NON-recursive (Gemini fix)
    if (!SOURCE_EXTENSIONS.has(path.extname(e.name).toLowerCase())) continue;
    out.add(`${rel}/${e.name}`);
  }
}

/**
 * Recursively collect every source-extension file under `rel` into `out`
 * (repo-relative, forward-slash paths). Unlike walkEntryPointDir this DOES
 * recurse — it feeds hasSelfUsageDocblock below, which is precise enough
 * (self-referential match only) that recursing into scripts/lib/** can't
 * over-exempt library files the way relaxing walkEntryPointDir's depth-1
 * scope would (the thing the Gemini-R3/H1 fix documented above guards
 * against).
 *
 * @param {string} repoPath
 * @param {string} rel
 * @param {Set<string>} out
 */
function walkSourceFilesRecursive(repoPath, rel, out) {
  const abs = path.join(repoPath, rel);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (err) {
    // Mirrors walkEntryPointDir's precedent above: best-effort discovery for an
    // ADDITIONAL exemption signal on top of the depth-1 walk, so a read failure
    // degrades the result rather than the whole entry-point set — but silently,
    // as this used to, made an unreadable subtree indistinguishable from an
    // empty one (audit-code round-1 finding). Log so it's diagnosable.
    process.stderr.write(`  [orphan] nested entry-point scan failed for ${rel}: ${err.message}\n`);
    return;
  }
  for (const e of entries) {
    const childRel = `${rel}/${e.name}`;
    if (e.isDirectory()) { walkSourceFilesRecursive(repoPath, childRel, out); continue; }
    if (!e.isFile()) continue;
    if (!SOURCE_EXTENSIONS.has(path.extname(e.name).toLowerCase())) continue;
    out.add(childRel);
  }
}

/**
 * Detect a self-referential CLI usage docblock — a file whose own header
 * documents itself as `node <its-own-repo-relative-path>` (the convention
 * used across scripts/*.mjs, e.g. "Usage:\n *   node scripts/foo.mjs").
 * Precise by construction: a library helper is never invoked as `node
 * scripts/lib/helper.mjs`, so this can't accidentally exempt scripts/lib/**
 * the way widening walkEntryPointDir's depth-1 scope would.
 *
 * Bounded to the first 4KB (docblocks live at the top of the file) so this
 * stays cheap even scanned across the whole scripts/ tree.
 *
 * @param {string} repoPath
 * @param {string} relPath - repo-relative, forward-slash path
 * @returns {boolean}
 */
function hasSelfUsageDocblock(repoPath, relPath) {
  let head;
  try {
    const fd = fs.openSync(path.join(repoPath, relPath), 'r');
    try {
      const buf = Buffer.alloc(4096);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.toString('utf-8', 0, bytesRead);
    } finally { fs.closeSync(fd); }
  } catch { return false; }
  const escaped = relPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\bnode\\s+${escaped}(\\s|$)`, 'm').test(head);
}

/**
 * Run `git args...` synchronously, returning stdout as a Buffer
 * (caller decides how to parse — null-separated output needs Buffer, not string).
 *
 * @param {string} repoPath
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env] - when supplied, REPLACES the inherited
 *   `process.env` for this subprocess. Omitted (the default) → identical to
 *   today's full-ambient-inherit behaviour.
 * @returns {Buffer|null} null on non-zero exit
 */
function gitBuf(repoPath, args, env) {
  try {
    // Gemini final-review catch (2026-07-24): no maxBuffer override meant
    // Node's 1MB default, which a bulk listing (e.g. `ls-tree -r --name-only`)
    // can exceed on a repo with tens of thousands of files — execFileSync
    // would throw ENOBUFS, and the catch below silently degrades to null.
    // Matches the 64MB bound already used at the other bulk git call sites
    // (known-defect-corpus.mjs, vcs.mjs gitShowFileAtRevision).
    return execFileSync('git', args, { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...(env ? { env } : {}) });
  } catch (err) {
    // audit-code R2/H3 — never silent. The caller decides what to do with null
    // (some failures are expected, like missing HEAD~1 on shallow clones), but
    // we ALWAYS leave a stderr breadcrumb so operators can correlate empty
    // results with the underlying git failure.
    const cmd = `git ${args.join(' ')}`;
    process.stderr.write(`  [orphan] git failed: ${cmd} → ${err.message.split('\n')[0]}\n`);
    return null;
  }
}

/**
 * Parse `git diff --name-status -z A..B` output into ChangedFile records.
 *
 * Format note (Gemini-R5/M1):
 *   Each record is a status byte + tab + path(s) + NUL.
 *   A / M / D / T / U statuses have ONE path token.
 *   R<score> / C<score> statuses have TWO path tokens (old NUL new NUL).
 *   The parser MUST peek at the status code prefix and consume the matching
 *   number of NUL-separated path tokens before advancing.
 *
 * @param {Buffer|null} buf
 * @returns {Array<{status: 'A'|'C'|'M'|'D'|'R', baseCallerPath: string|null, headCallerPath: string|null}>}
 */
function parseNameStatusZ(buf) {
  // Returns { records, partial } so callers can downgrade state when an
  // unknown status aborts the parse mid-stream (Gemini-final-R2 fix).
  if (!buf || buf.length === 0) return { records: [], partial: false };
  const out = [];
  // In `git diff --name-status -z` output, EACH field (status, path1, path2)
  // is its own NUL-separated token. So a record is:
  //   - A / M / D / T: 2 tokens — status, path
  //   - R<score> / C<score>: 3 tokens — status, oldPath, newPath
  // The parser must peek at the status letter and consume the matching number
  // of tokens (Gemini-R5/M1 — variable-width records).
  const parts = buf.toString('utf-8').split('\0').filter(p => p.length > 0);
  let i = 0;
  while (i < parts.length) {
    const rawStatus = parts[i];
    const statusLetter = rawStatus[0]; // strip score suffix on R/C
    if (statusLetter === 'R' || statusLetter === 'C') {
      const oldPath = parts[i + 1] || '';
      const newPath = parts[i + 2] || '';
      out.push({
        status: statusLetter,
        baseCallerPath: statusLetter === 'C' ? null : oldPath, // copy has no preimage at new path
        headCallerPath: newPath,
      });
      i += 3;
    } else if (statusLetter === 'A' || statusLetter === 'M' || statusLetter === 'D' || statusLetter === 'T') {
      const filePath = parts[i + 1] || '';
      out.push({
        status: statusLetter === 'T' ? 'M' : statusLetter, // type-change behaves like modify for our purposes
        baseCallerPath: statusLetter === 'A' ? null : filePath,
        headCallerPath: statusLetter === 'D' ? null : filePath,
      });
      i += 2;
    } else {
      // U / X / unknown status — audit-code R2/M4: do NOT advance by 1 only.
      // An unknown status whose record actually contains multiple tokens
      // would leave path tokens stranded in the stream, mis-aligning every
      // subsequent record. Safe behaviour: abort the parse entirely with a
      // loud stderr warning. Callers see the partial-or-empty result and
      // the audit run continues with degraded but not corrupted state.
      process.stderr.write(`  [orphan] ABORT --name-status parse: unknown git status '${statusLetter}' encountered at token ${i}; remainder of diff ignored to avoid record-arity drift\n`);
      return { records: out, partial: true };
    }
  }
  return { records: out, partial: false };
}

/**
 * Parse `git ls-tree -r -z --name-only <ref>` output to a Set of paths.
 *
 * @param {Buffer|null} buf
 * @returns {Set<string>}
 */
function parseLsTreeZ(buf) {
  if (!buf || buf.length === 0) return new Set();
  return new Set(buf.toString('utf-8').split('\0').filter(Boolean));
}

/**
 * Materialise the FULL base-ref tree via `git worktree add --detach` so
 * dependency-cruiser can resolve imports against real target files.
 *
 * Earlier approach (materialise only M/D/R callers) caused dep-cruiser to
 * mark every import as `couldNotResolve` because the imported targets
 * weren't on disk in the temp tree. A worktree gives the full base state
 * for ~100-300ms.
 *
 * @param {string} repoPath
 * @param {string} baseRef
 * @param {Array<{status: string, baseCallerPath: string|null}>} changedFiles
 * @returns {{tempRoot: string, materialisedPaths: string[]}|null}
 */
/**
 * Self-healing sweep for orphaned preimage worktrees. The normal path removes
 * its worktree in a `finally`, but a hard kill mid-cruise (SIGTERM on an audit
 * timeout, SIGKILL) leaves the `orphan-preimage-*` worktree behind LOCKED and
 * registered — and because it contains a full repo copy (AGENTS.md/CLAUDE.md),
 * a stale one poisons any sibling-scan that looks for repo sentinels in the
 * temp dir (it blocked pushes via tests/shared-cloud-config.test.mjs once).
 * Signal handlers can't help against SIGKILL, so the robust fix is this sweep
 * on the NEXT run: remove any preimage dir older than `maxAgeMs` (default 1h —
 * far beyond a live materialise-cruise-cleanup cycle, which is seconds), then
 * `git worktree prune` to drop dangling metadata. Also called by
 * `npm run audit:clean`.
 *
 * @param {{repoPath: string, tmpDir?: string, maxAgeMs?: number, env?: NodeJS.ProcessEnv}} args
 *   `env`, when supplied, REPLACES the inherited `process.env` for every
 *   `git worktree` subprocess this sweep spawns — the highest-severity call
 *   site in the 2026-07-23 GIT_DIR-leak audit: without it, a leaked
 *   `GIT_DIR` during a test exercising this function against a throwaway
 *   fixture `repoPath` makes `git worktree remove --force`/`prune`/`unlock`
 *   operate on whatever `GIT_DIR` actually points to — potentially a REAL
 *   repo's worktree registry, not just the fixture. Omitted (the default)
 *   → identical to today's production behaviour (this function's real
 *   production callers, e.g. `npm run audit:clean`, always operate on the
 *   genuine `repoPath` and want ambient inherit).
 * @returns {{swept: string[], kept: number}}
 */
// ce44f372/e5f71156/82e60a82: before falling back to raw recursive deletion,
// verify the candidate directory actually looks like a git worktree —
// refuse a symlinked candidate outright (never follow it), and require a
// nested `.git` REGULAR file (never a symlink — lstatSync does not follow
// one, unlike statSync) whose content starts with `gitdir:`. This is a
// bounded, precedent-matching improvement (mirrors audit-clean.mjs's
// symlink guard), not a full ownership-manifest system — see the plan's
// Theme 6 note for the residual gap this does NOT close (a forged
// non-symlink `.git` file with plausible content still passes; closing
// that needs the deferred ownership-manifest redesign).
function looksLikeOwnedWorktree(p) {
  try {
    if (fs.lstatSync(p).isSymbolicLink()) return false;
  } catch { return false; }
  const gitMarker = path.join(p, '.git');
  let markerStat;
  try {
    markerStat = fs.lstatSync(gitMarker);
  } catch { return false; }
  if (!markerStat.isFile()) return false; // symlink or missing — refuse
  let content;
  try {
    content = fs.readFileSync(gitMarker, 'utf-8');
  } catch { return false; }
  return content.startsWith('gitdir:');
}

export function sweepStaleOrphanPreimages({ repoPath, tmpDir = os.tmpdir(), maxAgeMs = 60 * 60 * 1000, env }) {
  const gitOpts = env ? { env } : {};
  const swept = [];
  let kept = 0;
  let entries = [];
  let readdirFailed = false;
  try { entries = fs.readdirSync(tmpDir); } catch { readdirFailed = true; return { swept, kept, readdirFailed }; }
  for (const name of entries) {
    if (!name.startsWith('orphan-preimage-')) continue;
    const p = path.join(tmpDir, name);
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) { kept++; continue; } // never follow/delete a symlinked candidate
    if (!st.isDirectory()) continue;
    if (Date.now() - st.mtimeMs < maxAgeMs) { kept++; continue; } // possibly live — leave it
    try {
      execFileSync('git', ['worktree', 'remove', '--force', p], { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'], ...gitOpts });
    } catch {
      if (!looksLikeOwnedWorktree(p)) { kept++; continue; } // refuse the unverified fallback delete, leave for next sweep
      try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { continue; } // still held → skip, next sweep retries
    }
    swept.push(p);
  }

  // Second pass — reconcile DANGLING registrations whose backing dir has
  // already vanished (e.g. Windows temp cleanup deletes the dir, but the git
  // worktree registration + its "initializing" lock survive). The filesystem
  // scan above can't see these (no dir to stat), and a bare `git worktree
  // prune` skips them because they are LOCKED — so they accumulate (8 were
  // cleaned by hand on 2026-07-21). Enumerate registrations, and for any
  // `orphan-preimage-*` whose dir is gone, unlock it (harmless if not locked)
  // so the prune below drops it. No age gate here: a registration with no
  // backing dir cannot be a live cruise (a live one holds its dir open).
  let porcelain = '';
  try {
    porcelain = execFileSync('git', ['worktree', 'list', '--porcelain'],
      { cwd: repoPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], ...gitOpts });
  } catch { /* not a git repo / git missing — nothing to reconcile */ }
  for (const block of porcelain.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const m = block.match(/^worktree (.+)$/m);
    if (!m) continue;
    const wtPath = m[1].trim();
    if (!path.basename(wtPath).startsWith('orphan-preimage-')) continue;
    if (fs.existsSync(wtPath)) continue; // dir present → handled by the age-gated scan above
    try { execFileSync('git', ['worktree', 'unlock', wtPath], { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'], ...gitOpts }); } catch { /* not locked / already gone */ }
    swept.push(wtPath);
  }

  if (swept.length > 0) {
    try { execFileSync('git', ['worktree', 'prune'], { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'], ...gitOpts }); } catch { /* best-effort */ }
    process.stderr.write(`  [orphan] swept ${swept.length} stale preimage worktree(s) from a previously killed run\n`);
  }
  return { swept, kept, readdirFailed };
}

function materialisePreimages(repoPath, baseRef, changedFiles, env) {
  const gitOpts = env ? { env } : {};
  const eligible = changedFiles.filter(f =>
    ['M', 'D', 'R'].includes(f.status)
    && f.baseCallerPath
    && SOURCE_EXTENSIONS.has(path.extname(f.baseCallerPath).toLowerCase())
  );
  if (eligible.length === 0) return null;

  // Heal any casualties of a previously hard-killed run before creating a new
  // worktree (the `finally` below can't run through SIGKILL).
  try {
    const sweepResult = sweepStaleOrphanPreimages({ repoPath, env });
    // 82e60a82: a readdir failure previously returned silently, so the sweep
    // looked identical to "checked, found zero orphans" — surface it so an
    // operator can tell "nothing to sweep" from "couldn't even look".
    if (sweepResult?.readdirFailed) {
      process.stderr.write('  [orphan] WARNING: could not list the temp directory to sweep stale preimage worktrees — skipped, not confirmed clean\n');
    }
  } catch { /* never block the audit */ }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-preimage-'));
  // Worktree expects the target directory NOT to exist or to be empty.
  // mkdtempSync creates it; remove and let git recreate it.
  try { fs.rmdirSync(tempRoot); } catch { /* fall through */ }

  try {
    execFileSync('git', ['worktree', 'add', '--detach', '--quiet', tempRoot, baseRef], {
      cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'], ...gitOpts,
    });
  } catch (err) {
    process.stderr.write(`  [orphan] worktree add failed: ${err.message}\n`);
    cleanupTempRoot(repoPath, tempRoot, env);
    return null;
  }

  // Verify our eligible files actually exist at baseRef. Some may not (e.g. a
  // brand-new file in a rename — its baseCallerPath might not have existed).
  const materialisedPaths = eligible
    .filter(f => fs.existsSync(path.join(tempRoot, f.baseCallerPath)))
    .map(f => f.baseCallerPath);

  if (materialisedPaths.length === 0) {
    cleanupTempRoot(repoPath, tempRoot, env);
    return null;
  }

  return { tempRoot, materialisedPaths };
}

function cleanupTempRoot(repoPath, tempRoot, env) {
  // Remove via git so it cleans up worktree metadata too.
  try {
    execFileSync('git', ['worktree', 'remove', '--force', tempRoot], {
      cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}),
    });
  } catch {
    // Fallback: best-effort fs rm in case the worktree never registered.
    try { fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
  }
}

/**
 * Use dependency-cruiser to extract dependency lists from preimage files.
 * Includes type-only edges (Gemini-R3/H1 — type imports keep files alive).
 * Returns Map<baseCallerPath, string[]> of resolved target paths
 * (repo-relative against the ORIGINAL repo, not the temp tree).
 *
 * @param {string} tempRoot
 * @param {string[]} materialisedPaths - repo-relative paths that were materialised
 * @returns {Promise<Object<string, string[]>>}
 */
async function cruiseTempRoot(tempRoot, materialisedPaths) {
  // dep-cruiser emits paths relative to the node process's CWD at the moment
  // of the cruise() call. Capture it once explicitly here so subsequent
  // path translation has no hidden ambient dependency on `process.cwd()`
  // mid-flight (audit-code R1/M12 — explicit cwd capture).
  const cruiseCwd = process.cwd();
  const targets = materialisedPaths.map(p => path.join(tempRoot, p));
  const out = {};

  const opts = {
    doNotFollow: { path: 'node_modules' },
    exclude: 'node_modules',
    tsConfig: { fileName: path.join(tempRoot, 'tsconfig.json') },
  };

  let result;
  try {
    result = await cruise(targets, opts);
  } catch (err) {
    if (/tsconfig/i.test(err.message)) {
      delete opts.tsConfig;
      try { result = await cruise(targets, opts); } catch { return out; }
    } else {
      return out;
    }
  }

  // Convert dep-cruiser's cwd-relative paths to temp-tree-relative via the
  // captured cruiseCwd. If something arrives absolute, use it as-is.
  function toTempRelative(rel) {
    if (!rel) return null;
    const abs = path.isAbsolute(rel) ? rel : path.resolve(cruiseCwd, rel);
    const tempRel = path.relative(tempRoot, abs).replaceAll('\\', '/');
    if (tempRel.startsWith('..')) return null;
    return tempRel;
  }

  for (const mod of (result.output?.modules ?? [])) {
    const baseCallerPath = toTempRelative(mod.source);
    if (!baseCallerPath) continue;
    if (!materialisedPaths.includes(baseCallerPath)) continue; // sub-modules pulled in by resolution

    const targetsFor = [];
    for (const dep of (mod.dependencies ?? [])) {
      // Include type-only edges (Gemini-R3/H1) — they keep files alive for orphan analysis.
      if (dep.couldNotResolve) continue;
      if (dep.dynamic) continue;
      // vendor-npm / node-builtin: skip (not local files).
      if (dep.dependencyTypes?.some(t => t === 'npm' || t === 'npm-dev' || t === 'npm-peer'
                                       || t === 'npm-optional' || t === 'npm-no-pkg'
                                       || t === 'core' || t === 'node-internal' || t === 'node_internal')) {
        continue;
      }
      if (!dep.resolved) continue;
      const rel = toTempRelative(dep.resolved);
      if (!rel) continue;
      targetsFor.push(rel);
    }
    out[baseCallerPath] = [...new Set(targetsFor)].sort((a, b) => a.localeCompare(b));
  }

  return out;
}

/**
 * Compute the set of entry-point repo-relative paths. Combines:
 *   - package.json `main` / `bin` (string or object) / `exports` strings
 *   - scripts/* and bin/* directories
 *   - reverse-resolved source paths via tsconfig `rootDir` / `outDir`
 *
 * Gemini-R3/M1: package.json typically points at compiled outputs (dist/).
 * We add BOTH the literal output path AND a heuristic source-equivalent so
 * the exemption fires regardless of which form appears in the import graph.
 *
 * @param {string} repoPath
 * @returns {Set<string>}
 */
export function computeEntryPoints(repoPath) {
  const out = new Set();
  const pkgJsonPath = path.join(repoPath, 'package.json');
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')); }
  catch { pkg = null; }

  // tsconfig rootDir / outDir for reverse resolution
  let rootDir = null;
  let outDir = null;
  try {
    const tsconfigText = fs.readFileSync(path.join(repoPath, 'tsconfig.json'), 'utf-8');
    // Crude strip of trailing-comma + comment forms tsc tolerates
    const cleaned = tsconfigText.replaceAll(/\/\/.*$/gm, '').replaceAll(/\/\*[\s\S]*?\*\//g, '');
    const tsconfig = JSON.parse(cleaned);
    rootDir = tsconfig.compilerOptions?.rootDir || null;
    outDir = tsconfig.compilerOptions?.outDir || null;
  } catch { /* tolerate absent / malformed tsconfig */ }

  function tryAddSourceEquivalent(norm) {
    if (!outDir || !rootDir) return;
    const outDirNorm = stripLeadingDotSlash(outDir);
    if (!norm.startsWith(outDirNorm)) return;
    let stripped = norm.slice(outDirNorm.length);
    if (stripped.startsWith('/')) stripped = stripped.slice(1);
    const sourceBase = path.posix.join(stripLeadingDotSlash(rootDir), stripped);
    for (const ext of ['.ts', '.tsx', '.mjs', '.js']) {
      const candidate = sourceBase.replace(/\.[mc]?[jt]sx?$/, '') + ext;
      if (fs.existsSync(path.join(repoPath, candidate))) {
        out.add(candidate);
        break;
      }
    }
  }
  function addWithSourceFallback(p) {
    if (!p || typeof p !== 'string') return;
    const norm = stripLeadingDotSlash(p);
    if (norm.startsWith('/')) return; // skip absolute / unhelpful
    out.add(norm);
    tryAddSourceEquivalent(norm);
  }

  if (pkg) {
    addWithSourceFallback(pkg.main);
    addWithSourceFallback(pkg.module);
    addWithSourceFallback(pkg.types);
    if (typeof pkg.bin === 'string') {
      addWithSourceFallback(pkg.bin);
    } else if (pkg.bin && typeof pkg.bin === 'object') {
      for (const v of Object.values(pkg.bin)) addWithSourceFallback(v);
    }
    if (pkg.exports) {
      const visit = (node) => {
        if (typeof node === 'string') addWithSourceFallback(node);
        else if (Array.isArray(node)) node.forEach(visit);
        else if (node && typeof node === 'object') Object.values(node).forEach(visit);
      };
      visit(pkg.exports);
    }
  }

  // scripts/* and bin/* — every file at depth ≥ 1 under these directories
  for (const dir of ['scripts', 'bin']) {
    const full = path.join(repoPath, dir);
    if (!fs.existsSync(full)) continue;
    walkEntryPointDir(repoPath, dir, out);
  }

  // Nested CLI scripts (e.g. scripts/spikes/foo.mjs) that document themselves
  // with a `node <own-path>` usage docblock — the depth-1 walk above
  // deliberately doesn't recurse (Gemini-R3/H1), so a script one directory
  // deeper than scripts/*.mjs is invisible to it even when it's a genuine
  // CLI entry point, not a library file.
  const nestedCandidates = new Set();
  for (const dir of ['scripts', 'bin']) {
    if (!fs.existsSync(path.join(repoPath, dir))) continue;
    walkSourceFilesRecursive(repoPath, dir, nestedCandidates);
  }
  for (const rel of nestedCandidates) {
    if (out.has(rel)) continue; // already an entry point via the depth-1 walk
    if (hasSelfUsageDocblock(repoPath, rel)) out.add(rel);
  }

  return out;
}

/**
 * Resolve a fully-fledged DiffScope from explicit refs OR by inspecting the
 * working tree when refs are not provided.
 *
 * Failure modes return a non-null scope with state ∈ {'SKIPPED_NO_BASELINE',
 * 'SKIPPED_PATCH_ONLY_MODE'} and empty `changedFiles`. The detector never
 * sees these states — orchestration short-circuits.
 *
 * @param {object} args
 * @param {string} args.repoPath
 * @param {string} [args.baseRef]
 * @param {string} [args.headRef]
 * @param {string} [args.diffPatch] - when provided without refs → SKIPPED_PATCH_ONLY_MODE
 * @param {NodeJS.ProcessEnv} [args.env] - when supplied, REPLACES the
 *   inherited `process.env` for every git subprocess this resolver spawns
 *   (including the preimage worktree materialisation, the highest-severity
 *   call chain in the 2026-07-23 GIT_DIR-leak audit). Omitted (the default)
 *   → identical to today's full-ambient-inherit production behaviour.
 * @returns {Promise<import('../schemas.mjs').DiffScopeSchema>}
 */
export async function resolveDiffScope({ repoPath, baseRef, headRef, diffPatch, env }) {
  // Patch-only mode (R2/M1): phase 1 does not support pre-edge extraction from a patch alone.
  if (diffPatch && (!baseRef || !headRef)) {
    return {
      baseRef: null, headRef: null, changedFiles: [],
      preEdgesByBaseCaller: {}, targetExistedAtBase: [], entryPoints: [],
      state: 'SKIPPED_PATCH_ONLY_MODE',
    };
  }

  // Resolve base/head refs to commit SHAs (or working-tree sentinels).
  const resolvedBase = baseRef || 'HEAD';
  const resolvedHead = headRef || null; // null = working tree
  const refOk = gitBuf(repoPath, ['rev-parse', '--verify', resolvedBase], env);
  if (!refOk) {
    process.stderr.write(`  [orphan] SKIPPED_NO_BASELINE — cannot resolve ${resolvedBase} (shallow clone? initial commit? run \`git fetch --deepen=1\`)\n`);
    return {
      baseRef: resolvedBase, headRef: resolvedHead, changedFiles: [],
      preEdgesByBaseCaller: {}, targetExistedAtBase: [], entryPoints: [],
      state: 'SKIPPED_NO_BASELINE',
    };
  }

  // Build changedFiles via git diff (with -z, Gemini-R4/M1).
  // When headRef is null, compare base vs working tree (tracked + untracked + uncommitted).
  // Gemini-final-R2 fix: track partial-parse so downstream state is downgraded.
  let changedFiles;
  let parsePartial = false;
  if (resolvedHead) {
    const buf = gitBuf(repoPath, ['diff', '--name-status', '-z', `${resolvedBase}..${resolvedHead}`], env);
    const parsed = parseNameStatusZ(buf);
    changedFiles = parsed.records;
    parsePartial = parsed.partial;
  } else {
    // Working-tree mode (Gemini-R3/H3): union tracked-modifications + untracked.
    const trackedBuf = gitBuf(repoPath, ['diff', '--name-status', '-z', 'HEAD'], env);
    const trackedParsed = parseNameStatusZ(trackedBuf);
    parsePartial = trackedParsed.partial;
    const untrackedBuf = gitBuf(repoPath, ['ls-files', '--others', '--exclude-standard', '-z'], env);
    const untracked = untrackedBuf
      ? untrackedBuf.toString('utf-8').split('\0').filter(Boolean).map(p => ({
          status: 'A', baseCallerPath: null, headCallerPath: p,
        }))
      : [];
    // De-dup: untracked never overlaps with tracked (tracked excludes new files by definition).
    changedFiles = [...trackedParsed.records, ...untracked];
  }

  // Pre-filter binary / non-source files (Gemini-R2/H1).
  changedFiles = changedFiles.filter(f => {
    const sample = f.baseCallerPath || f.headCallerPath;
    if (!sample) return false;
    return SOURCE_EXTENSIONS.has(path.extname(sample).toLowerCase());
  });

  // Build targetExistedAtBase from a single `git ls-tree` (Gemini-R2/M1 — avoid N+1 spawns).
  const cmp = (a, b) => a.localeCompare(b);
  const baseManifestBuf = gitBuf(repoPath, ['ls-tree', '-r', '-z', '--name-only', resolvedBase], env);
  const targetExistedAtBase = Array.from(parseLsTreeZ(baseManifestBuf)).sort(cmp);

  // Pre-edge extraction (AST via dep-cruiser on a temp materialisation).
  // audit-code R1/M12: chdir to repoPath for the cruise call so dep-cruiser's
  // cwd-relative output is interpretable consistently regardless of where the
  // audit-orchestrator was invoked from. Restored in `finally` even on throw.
  // Safe here because the orphan pass runs serially in Wave 1.5b (no parallel
  // cruise calls). Tested across in-repo and out-of-repo cwds.
  let preEdgesByBaseCaller = {};
  const materialised = materialisePreimages(repoPath, resolvedBase, changedFiles, env);
  if (materialised) {
    const savedCwd = process.cwd();
    let cwdChanged = false;
    try {
      if (path.resolve(savedCwd) !== path.resolve(repoPath)) {
        process.chdir(repoPath);
        cwdChanged = true;
      }
      preEdgesByBaseCaller = await cruiseTempRoot(materialised.tempRoot, materialised.materialisedPaths);
    } finally {
      if (cwdChanged) {
        try { process.chdir(savedCwd); } catch { /* best-effort restore */ }
      }
      cleanupTempRoot(repoPath, materialised.tempRoot, env);
    }
  }

  // Entry-point set (orchestration responsibility — R2/M3).
  const entryPoints = Array.from(computeEntryPoints(repoPath)).sort(cmp);

  // Gemini-final-R2 fix: if the diff parser hit an unknown status mid-stream
  // and aborted (`parsePartial=true`), downgrade state to ANALYZED_PARTIAL so
  // orchestration + telemetry surface the degraded analysis to operators.
  // Otherwise hand off ANALYZED_CLEAN so the detector decides the final state.
  return {
    baseRef: resolvedBase,
    headRef: resolvedHead,
    changedFiles,
    preEdgesByBaseCaller,
    targetExistedAtBase,
    entryPoints,
    state: parsePartial ? 'ANALYZED_PARTIAL' : 'ANALYZED_CLEAN',
  };
}
