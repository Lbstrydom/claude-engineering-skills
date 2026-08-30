/**
 * @fileoverview Audit-tool version-staleness check.
 *
 * Generates and compares a SHA-256 manifest of CORE_SCRIPTS files so consumer
 * repos can detect when they're running stale audit-tool code vs upstream
 * claude-engineering-skills.
 *
 * Flow:
 *   1. /ship in claude-engineering-skills regenerates scripts/.sync-manifest.json
 *      (via sync-to-repos.mjs at the start of every sync).
 *   2. The manifest is committed + pushed alongside the audit-tool code.
 *   3. Consumer repos' openai-audit.mjs fetches the manifest on startup,
 *      compares hashes to local copies, and warns when files diverge.
 *
 * The manifest excludes itself (recursive hashing) and any per-machine /
 * generated files. Source-repo detection (package.json.name) short-circuits
 * self-checks.
 *
 * @module scripts/lib/sync-manifest
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { execSync } from 'node:child_process';
import { z } from 'zod';
import { atomicWriteFileSync } from './file-io.mjs';

const DEFAULT_UPSTREAM_URL =
  'https://raw.githubusercontent.com/Lbstrydom/claude-engineering-skills/main/scripts/.sync-manifest.json';

export const UPSTREAM_MANIFEST_URL =
  process.env.AUDIT_TOOL_MANIFEST_URL || DEFAULT_UPSTREAM_URL;

export const MANIFEST_RELATIVE_PATH = 'scripts/.sync-manifest.json';

// Cap upstream payload at 2 MiB — the manifest is < 30 KiB in practice;
// anything larger is a misconfigured or hostile endpoint and must not be
// parsed.  Memory-exhaustion defence at the input boundary.
const MAX_UPSTREAM_BYTES = 2 * 1024 * 1024;

// Single source of truth for the upstream fetch deadline.  Callers may
// override per-invocation but the default lives here so the CLI and the
// audit-side inline check agree on policy.
export const DEFAULT_FETCH_TIMEOUT_MS = 5000;

// Zod validates the manifest shape at the external-API boundary
// (raw.githubusercontent.com is untrusted from this module's standpoint —
// the override env var lets it point anywhere).
const HashStringSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const RelPathSchema = z.string().min(1).max(512).refine(
  (p) => {
    if (!p) return false;
    if (p.startsWith('/') || p.startsWith('\\')) return false;
    if (/^[A-Za-z]:[/\\]/.test(p)) return false;             // drive letter
    if (p.split(/[/\\]+/).some((seg) => seg === '..')) return false; // traversal
    return true;
  },
  { message: 'manifest path must be relative and contained' },
);
export const SyncManifestSchema = z.object({
  generatedAt: z.string().min(1),
  repo: z.string().min(1),
  branch: z.string().min(1),
  commitSha: z.string().nullable(),
  // Was any SOURCE file that this bundle ships uncommitted at sync time?
  //
  // `commitSha` is HEAD, but the bytes shipped are read from the WORKING TREE
  // (sync-to-repos.mjs reads them with fs.readFileSync, not `git show`). When
  // the two disagree the consumer holds code that is NEWER than its own stamp,
  // and every distance computed from that sha is wrong in the direction that
  // invites "you're behind, re-sync" — measured 2026-08-01, where a report was
  // stamped 10 commits behind while running code from a commit that did not
  // exist yet, and the fix for it was nearly dismissed as already-shipped.
  //
  // Tri-state on purpose: `true` = known dirty, `false` = known clean, and
  // null/absent = not determined (no git, or a manifest published before this
  // field existed). Absence must read as UNKNOWN, never as clean — the same
  // rule `commitSha: null` already carries.
  sourceDirty: z.boolean().nullable().optional(),
  files: z.record(RelPathSchema, HashStringSchema),
  // Layout signals which on-disk shape this manifest describes:
  //  'legacy'   — files live at canonical `scripts/X` paths in the consumer (pre-isolation)
  //  'isolated' — files live under `scripts/.claude-skills/X` (post-isolation, gitignored)
  // Optional + defaults to 'legacy' for backwards-compat with manifests
  // published before the field was added. Strict subset of strings.
  layout: z.enum(['legacy', 'isolated']).optional().default('legacy'),
});

export function hashFile(absPath) {
  const buf = fs.readFileSync(absPath);
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Hash every file in `files` and emit the manifest payload.  Three
 * defence-in-depth guards live here so the producer can't ship a manifest
 * that the consumer would have to reject:
 *
 *   1. Path normalisation — keys always use forward slashes, regardless of
 *      whether sync-to-repos.mjs ran on Windows or POSIX.  Without this,
 *      Windows-generated manifests with `scripts\foo.mjs` keys are literal
 *      filename chars on Linux and the consumer's `path.join` resolves
 *      them to the wrong location.
 *   2. RelPathSchema — same validator the consumer uses on the fetch path.
 *      Any caller that passes an absolute path, traversal, or drive letter
 *      is loudly rejected at generation time, not silently shipped.
 *   3. Loud rejection of missing/non-file/invalid entries — collected in
 *      `errors` so the caller can refuse to write a partial manifest.
 *      Silently omitting them would publish incomplete contract data.
 *
 * Returns `{ hashes, errors }`.  Callers that must ship a complete
 * manifest (sync-to-repos.mjs) check `errors.length` and abort.
 */
export function computeFileHashes(rootDir, files) {
  const hashes = {};
  const errors = [];
  for (const rel of files) {
    // Normalise FIRST so the self-exclusion check below catches backslashed
    // variants like `scripts\.sync-manifest.json` (Windows-generated input).
    const normalized = rel.replace(/\\/g, '/');
    if (normalized === MANIFEST_RELATIVE_PATH) continue;
    if (!RelPathSchema.safeParse(normalized).success) {
      errors.push({ path: rel, reason: 'invalid-path' });
      continue;
    }
    const abs = path.join(rootDir, normalized);
    if (!fs.existsSync(abs)) {
      errors.push({ path: normalized, reason: 'missing' });
      continue;
    }
    if (!fs.statSync(abs).isFile()) {
      errors.push({ path: normalized, reason: 'not-a-file' });
      continue;
    }
    hashes[normalized] = hashFile(abs);
  }
  return { hashes, errors };
}

/**
 * HEAD sha + branch for `rootDir`, or `{commitSha: null, branch: null}` when git
 * is unavailable / not a checkout (tarball install).
 *
 * Exported because the consumer-manifest writer in `sync-to-repos.mjs` needs the
 * SOURCE repo's HEAD at sync time and **must not** reuse the sha off
 * `writeManifest`'s return value: on the idempotency-skip path that function
 * returns the *existing on-disk* manifest, whose `commitSha` is stale by design
 * (see the comment there). A stale-but-plausible version stamp is worse than
 * none — it is the failure mode `docs/plans/upstream-issue-reports.md` exists to
 * remove.
 */
export function getGitMeta(rootDir) {
  const exec = (cmd) => {
    try {
      return execSync(cmd, { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
  return {
    commitSha: exec('git rev-parse HEAD'),
    branch: exec('git rev-parse --abbrev-ref HEAD'),
  };
}

/**
 * Repo-relative POSIX paths that differ from HEAD in `rootDir` — modified,
 * staged, or untracked.
 *
 * Scoped intersection is the caller's job (`buildConsumerManifest` receives
 * only its own bundle's verdict), because a whole-repo dirty flag would be
 * useless here: this checkout is shared by concurrent sessions and is almost
 * never clean, so every report would degrade to `unknown` and the freshness
 * signal would be destroyed rather than made honest.
 *
 * Untracked (`??`) counts. A brand-new lib module that has been synced but not
 * yet committed is precisely the case that produced the 2026-08-01 incident.
 *
 * @param {string} rootDir
 * @returns {Set<string>|null} null when git is unavailable — "not determined",
 *   which callers must not collapse to "clean"
 */
export function listDirtyPaths(rootDir) {
  let out;
  try {
    // -z: NUL-delimited, so paths with spaces/quotes/non-ASCII need no
    // unquoting. Without it git renders such names in a quoted C-string form
    // and the set would silently miss exactly the files most likely to be
    // mis-parsed.
    out = execSync('git status --porcelain -z --untracked-files=all', {
      cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  const set = new Set();
  const entries = out.split('\0');
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (!e || e.length < 4) continue;
    const xy = e.slice(0, 2);
    set.add(e.slice(3));
    // A rename/copy entry is followed by its ORIGIN path as a separate NUL
    // field. Consume it so it is not parsed as a status line in its own right
    // (its first two chars are path text, which would corrupt the next entry).
    if (xy.includes('R') || xy.includes('C')) {
      i += 1;
      if (entries[i]) set.add(entries[i]);
    }
  }
  return set;
}

/**
 * Resolve the git repo root from any working directory.  Falls back to
 * `cwd` when not in a git checkout (e.g. tarball install).  Used so CLI
 * invocation from a subdirectory still finds the correct manifest +
 * local files instead of hashing the wrong tree.
 */
export function findRepoRoot(startDir = process.cwd()) {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd: startDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return path.resolve(startDir);
  }
}

/**
 * Build the manifest payload.  Throws when any input file is missing,
 * invalid, or not a regular file — refuses to ship a partial manifest
 * because consumers compare against it as a complete contract.  Pass
 * `{ strict: false }` to downgrade to a warning + omit (only for ad-hoc
 * tooling, never for /ship).
 */
export function generateManifest(rootDir, files, opts = {}) {
  const meta = getGitMeta(rootDir);
  const { hashes, errors } = computeFileHashes(rootDir, files);
  const strict = opts.strict !== false;
  if (errors.length) {
    const lines = errors.map((e) => `  [manifest] ${e.reason}: ${e.path}`).join('\n');
    if (strict) {
      throw new Error(`Refusing to generate manifest with ${errors.length} bad input(s):\n${lines}`);
    }
    process.stderr.write(`${lines}\n`);
  }
  return {
    generatedAt: new Date().toISOString(),
    repo: opts.repo || 'Lbstrydom/claude-engineering-skills',
    branch: opts.branch || meta.branch || 'main',
    commitSha: opts.commitSha || meta.commitSha || null,
    files: hashes,
    layout: opts.layout || 'legacy',
  };
}

/**
 * Build the CONSUMER-side manifest record.
 *
 * Extracted from `sync-to-repos.mjs`'s inline literal so the field-ownership
 * contract is testable: an audit found the original hand-built object could not
 * be exercised by any test, so the `commitSha: null` regression it replaced had
 * no guard at all.
 *
 * Field ownership is the whole point and is NOT symmetric:
 *   - `generatedAt`, `files`, `layout` describe the CONSUMER — when this sync
 *     ran, what landed on its disk (destination paths, post-rewrite hashes),
 *     in which shape.
 *   - `repo`, `branch`, `commitSha` describe the SOURCE it came from. That is
 *     the pair a consumer needs to answer "which upstream commit is my bundle
 *     from?", which is what makes an upstream bug report triageable.
 *
 * `sourceGitMeta` MUST come from `getGitMeta()` at sync time, never off
 * `writeManifest`'s return value — see that function's note.
 *
 * @param {{generatedAt: string, repo?: string, sourceGitMeta: {commitSha: string|null, branch: string|null}, files: Record<string,string>}} args
 * @returns {{generatedAt: string, repo: string, branch: string, commitSha: string|null, files: Record<string,string>, layout: 'isolated'}}
 */
/**
 * Manifest entries whose file is NOT on disk — the sync's own post-condition.
 *
 * ## The gap this closes
 *
 * The sync reports what it DID (`+2 new · ~10 updated · Errors: 0`) and never
 * checks what IS. Those are different claims, and a consumer's own git
 * operations move the two apart between runs: `.audit-loop/migrations/**` is a
 * TRACKED destination in at least one consumer, so a freshly-synced `.sql`
 * arrives there UNTRACKED, and anything that removes untracked files takes it
 * with no signal on either side.
 *
 * Measured 2026-08-30: `storyline` ended two consecutive pushes without
 * `20260830160000_upstream_issue_annotation_event.sql`, while its manifest
 * claimed it. That consumer had the JS half of a feature and not the schema
 * half, so `upstream annotate` there would have failed with a `23514` check
 * violation — and every source-side signal said `Targets: 3/3 reached`. The
 * only thing that noticed was `sync-isolation-verify` run BY HAND from inside
 * the consumer, which no source-side workflow invokes.
 *
 * ## Why this direction specifically
 *
 * The opposite drift — a file on disk that the manifest has lost — is already
 * handled, and handled well: `classifyOwnership` re-adopts it by content
 * (`sync-ownership.mjs`), because a tracked manifest can be rolled back by a
 * merge while the files it describes survive. Nothing was ever checking the
 * mirror image. That is shape (3) of the four AGENTS.md names — *a check
 * verifying one direction only* — in the one place where the missing direction
 * is the one that silently under-delivers.
 *
 * ## Why it REPORTS rather than re-writing
 *
 * A missing entry self-heals on the next sync already: an absent destination
 * has no `dstHash`, so the write loop classifies it `new` and writes it. Adding
 * a repair here would duplicate that path, and would do it in the one place
 * where the file might be absent because the consumer *deleted it on purpose* —
 * the same reason GC advises rather than acting on an orphaned TRACKED path.
 * What was missing is not delivery, it is NOTICING: `Errors: 0` must stop being
 * printable over an incomplete tree. A gap that persists across runs then says
 * so every run, which is exactly the signal an operator needs to find whatever
 * is removing the file.
 *
 * PURE — `exists` is injected, so the post-condition is testable without a
 * consumer tree.
 *
 * @param {Record<string, string>} fileMap the consumer manifest's `files`
 * @param {{exists: (relPath: string) => boolean}} io
 * @returns {string[]} relative paths the manifest claims but disk lacks, sorted
 */
export function findUndeliveredEntries(fileMap, { exists }) {
  const out = [];
  for (const rel of Object.keys(fileMap ?? {})) {
    if (!exists(rel)) out.push(rel);
  }
  return out.sort();
}

export function buildConsumerManifest({ generatedAt, repo, sourceGitMeta, files, sourceDirty = null }) {
  return {
    generatedAt,
    repo: repo || 'Lbstrydom/claude-engineering-skills',
    branch: sourceGitMeta?.branch || 'main',
    // Null stays legal (tarball install / no git) and means "unknown" — which
    // downstream triage must never read as "current".
    commitSha: sourceGitMeta?.commitSha ?? null,
    // Qualifies commitSha rather than replacing it: the sha is still the best
    // available base for prior-fix ancestry, but with this set it is a LOWER
    // BOUND on what shipped, not an identity. See the schema note above.
    sourceDirty: typeof sourceDirty === 'boolean' ? sourceDirty : null,
    files,
    layout: 'isolated',
  };
}

export function writeManifest(rootDir, files, opts = {}) {
  const manifest = generateManifest(rootDir, files, opts);
  const manifestPath = path.join(rootDir, MANIFEST_RELATIVE_PATH);

  // Idempotency: if the file content hashes are unchanged from the
  // on-disk manifest, skip the write. Without this, every sync run
  // creates a new `generatedAt` timestamp (and possibly a new
  // commitSha) — leaving scripts/.sync-manifest.json in a permanent
  // `M` state after every push, even when no managed file changed.
  // We compare ONLY the hashes (the load-bearing contract); the
  // metadata fields are ignored.
  if (fs.existsSync(manifestPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const existingHashes = existing.files || {};
      const newHashes = manifest.files || {};
      const existingLayout = existing.layout || 'legacy';
      const newLayout = manifest.layout || 'legacy';
      // Idempotency: skip rewrite only when BOTH the file map AND layout
      // are identical. A layout transition (legacy→isolated) is a real
      // semantic change even if no individual file hash moved, so we
      // must rewrite the manifest to publish the new layout signal.
      if (existingLayout === newLayout && hashesEqual(existingHashes, newHashes)) {
        return { manifest: existing, path: manifestPath, skipped: true };
      }
    } catch { /* corrupt / unparseable existing — fall through to overwrite */ }
  }

  atomicWriteFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { manifest, path: manifestPath, skipped: false };
}

function hashesEqual(a, b) {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
    if (a[ak[i]] !== b[bk[i]]) return false;
  }
  return true;
}

/**
 * Compare a fetched upstream manifest to local files.  Caller MUST pass an
 * already-validated `upstreamManifest` (use SyncManifestSchema or
 * fetchUpstreamManifest which validates internally).  Each rel-path is
 * re-checked for containment before joining — defence in depth against a
 * downstream caller that bypasses validation.
 */
export function compareToUpstream(localRoot, upstreamManifest) {
  const stale = [];
  const missing = [];
  const rejected = [];
  for (const [rel, upstreamHash] of Object.entries(upstreamManifest.files || {})) {
    if (!RelPathSchema.safeParse(rel).success) {
      rejected.push(rel);
      continue;
    }
    const abs = path.join(localRoot, rel);
    // Final containment guard — defence in depth even after RelPathSchema.
    const normalizedRoot = path.resolve(localRoot) + path.sep;
    if (!path.resolve(abs).startsWith(normalizedRoot)) {
      rejected.push(rel);
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      missing.push(rel);
      continue;
    }
    // Reject manifest entries that point at directories or non-regular files.
    // RelPathSchema can't catch this — only the live filesystem can.  Skip
    // hashing entirely instead of letting fs.readFileSync throw EISDIR.
    if (!stat.isFile()) {
      rejected.push(rel);
      continue;
    }
    const localHash = hashFile(abs);
    if (localHash !== upstreamHash) {
      stale.push(rel);
    }
  }
  return {
    stale,
    missing,
    rejected,
    current: stale.length === 0 && missing.length === 0 && rejected.length === 0,
    upstreamCommit: upstreamManifest.commitSha || null,
    upstreamGeneratedAt: upstreamManifest.generatedAt || null,
  };
}

/**
 * Fetch + validate the upstream manifest.  Enforces:
 *   - end-to-end deadline (Promise.race wrapping the HTTP request)
 *   - max response size before JSON.parse (memory-exhaustion defence)
 *   - Zod validation at the boundary
 *
 * On any failure (network, timeout, bad shape, oversized response) the
 * returned promise rejects — callers up the stack swallow this for the
 * non-blocking startup warning, or surface it as exit 2 for the CLI.
 */
export function fetchUpstreamManifest(url = UPSTREAM_MANIFEST_URL, { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = {}) {
  // `req` is declared in the outer scope so the deadline timer can destroy
  // the live request when it fires.  Without this, the wrapper promise would
  // reject but the underlying socket would keep streaming until completion —
  // leaking connections on every stale fetch.
  let req;
  let timer;

  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (req && !req.destroyed) {
        req.destroy(new Error(`Deadline exceeded after ${timeoutMs}ms fetching ${url}`));
      }
      reject(new Error(`Deadline exceeded after ${timeoutMs}ms fetching ${url}`));
    }, timeoutMs);
    timer.unref?.();
  });

  const request = new Promise((resolve, reject) => {
    try {
      // agent: false disables connection pooling so the underlying socket
      // closes immediately after the response ends.  Without this, Node 19+
      // keep-alive holds the socket in the agent pool for ~5s, which keeps
      // the event loop alive and hangs the CLI after process.exitCode is set.
      req = https.get(url, { agent: false, headers: { 'User-Agent': 'audit-tool-version-check' } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
          return;
        }
        let bytes = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_UPSTREAM_BYTES) {
            res.destroy(new Error(`Upstream payload exceeds ${MAX_UPSTREAM_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          if (bytes > MAX_UPSTREAM_BYTES) return; // already rejected via destroy
          try {
            const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(SyncManifestSchema.parse(raw));
          } catch (err) {
            reject(new Error(`Invalid upstream manifest: ${err.message}`));
          }
        });
      });
      req.on('error', reject);
      // Socket-level inactivity backstop in addition to the end-to-end deadline.
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Socket timeout after ${timeoutMs}ms`));
      });
    } catch (err) {
      reject(err);
    }
  });

  return Promise.race([request, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function isSourceRepo(rootDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    return pkg.name === 'claude-engineering-skills';
  } catch {
    return false;
  }
}

/**
 * Detect that a consumer's ownership record moved BACKWARDS since we last
 * wrote it.
 *
 * The consumer manifest is a TRACKED file while the files it owns are
 * gitignored, so a merge, reset or branch checkout reverts the record while
 * its files stay on disk. Every file synced since then reads as an unowned
 * collision and aborts the whole target — the consumer silently stops
 * receiving updates, with nothing reported at the moment of damage. The
 * watermark is gitignored and therefore does NOT move with the manifest,
 * which is what makes the comparison meaningful.
 *
 * Pure so the comparison is testable without a consumer checkout; the caller
 * owns reading both files. Returns `null` when there is nothing to say —
 * including when either input is missing, since "no watermark yet" is the
 * normal first-sync state and must never read as a regression.
 *
 * @param {{generatedAt?: string, fileCount?: number}|null} watermark
 * @param {{generatedAt?: string, files?: Record<string, string>}|null} priorManifest
 * @returns {{shrankBy: number, wentBackwards: boolean, priorCount: number,
 *            recordedCount: number, priorAt: string, recordedAt: string}|null}
 */
export function detectOwnershipRegression(watermark, priorManifest) {
  if (!watermark || !priorManifest) return null;
  const priorCount = Object.keys(priorManifest.files || {}).length;
  const recordedCount = Number(watermark.fileCount);
  // A non-numeric watermark count is corrupt, not evidence of shrinkage.
  const shrankBy = Number.isFinite(recordedCount) ? recordedCount - priorCount : 0;
  // Compare as instants, not strings: a manifest written under a different UTC
  // offset would mis-order lexicographically and fabricate a regression.
  const priorAt = Date.parse(priorManifest.generatedAt ?? '');
  const markAt = Date.parse(watermark.generatedAt ?? '');
  const wentBackwards = Number.isFinite(priorAt) && Number.isFinite(markAt) && priorAt < markAt;
  if (shrankBy <= 0 && !wentBackwards) return null;
  return {
    shrankBy: Math.max(0, shrankBy),
    wentBackwards,
    priorCount,
    recordedCount,
    priorAt: priorManifest.generatedAt ?? '(none)',
    recordedAt: watermark.generatedAt ?? '(none)',
  };
}
