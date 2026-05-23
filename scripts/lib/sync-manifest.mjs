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
  files: z.record(RelPathSchema, HashStringSchema),
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

function getGitMeta(rootDir) {
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
      if (hashesEqual(existingHashes, newHashes)) {
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
