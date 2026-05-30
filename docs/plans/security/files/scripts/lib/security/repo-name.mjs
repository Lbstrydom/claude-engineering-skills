/**
 * @fileoverview Single source of truth for the security domain's repo name.
 *
 * The security_incidents index keys rows by `repo_id`, resolved from this name
 * (see scripts/lib/store/security.mjs::resolveSecurityRepoId). The WRITERS
 * (scripts/security-memory/refresh-incidents.mjs), the QUERY path
 * (scripts/cross-skill.mjs get-incident-neighbourhood), and the dashboard
 * READER (scripts/lib/dashboard/collect-telemetry.mjs) MUST all derive the
 * same name or they read/write different rows. This helper is that shared
 * derivation — git-remote-based, with a stable cwd-basename fallback.
 *
 * @module scripts/lib/security/repo-name
 */
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Derive the security-domain repo name from the git origin remote.
 * Falls back to the basename of `root` when there is no git origin
 * (shallow CI clone, tarball checkout). All call sites pass the same `root`
 * (process.cwd()), so the fallback is identical across writer and reader.
 *
 * @param {string} [root=process.cwd()]
 * @returns {string}
 */
export function securityRepoName(root = process.cwd()) {
  // Explicit override for CI / shallow clones / tarball checkouts where git
  // `origin` is absent or ambiguous (R1 finding 2026-05-30, GPT-sustained LOW).
  // Set the SAME value across writer + reader so they key the same repo_id.
  const override = (process.env.SECURITY_REPO_NAME || '').trim();
  if (override) return override;
  try {
    const remote = execSync('git remote get-url origin', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const m = remote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (m) return m[1].replace('/', '_');
  } catch { /* not a git repo / no origin — fall through */ }
  return path.basename(root);
}
