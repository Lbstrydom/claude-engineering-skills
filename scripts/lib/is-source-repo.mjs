/**
 * @fileoverview Is this invocation running IN the source repo
 * (claude-engineering-skills) rather than a consumer that synced this file?
 *
 * Extracted into its own zero-side-effect module (round-6 code-audit
 * Sustainability M5) — it originally lived in `maintenance-checks.mjs`,
 * which pulls in `./lib/config.mjs` (env loading) and other CLI-scheduler
 * machinery at import time; a caller that only wants the source-repo
 * predicate should not have to evaluate all of that. Mirrors the
 * `package.json.name === "claude-engineering-skills"` gate `/audit-code`
 * Step 6.5/6.5b already uses for other source-repo-only steps — this is the
 * first place that check needed to become reusable code rather than prose.
 *
 * @module scripts/lib/is-source-repo
 */

import fs from 'node:fs';
import path from 'node:path';
import { findRepoRootFromScript } from './assert-repo-root.mjs';

/**
 * Read failure (missing/corrupt package.json, or the repo root can't be
 * determined) fails closed to `false`: a `sourceRepoOnly` check must never
 * accidentally run somewhere it can't be meaningful, but a normal
 * source-repo checkout always has a readable package.json, so this can't
 * mask a real local problem in practice.
 * @returns {boolean}
 */
export function isSourceRepo() {
  try {
    const repoRoot = findRepoRootFromScript(import.meta.url);
    if (!repoRoot) return false;
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
    return pkg.name === 'claude-engineering-skills';
  } catch {
    return false;
  }
}
