/**
 * @fileoverview Stale `// @duplicate-justification` pragma sweep — the
 * "Out of Scope (Future)" mitigation for the duplication audit wave
 * (docs/plans/audit-code-duplication-wave.md, Gemini gate round 2's
 * wrongly_dismissed H4 finding). Extracted from `scripts/symbol-index/
 * drift.mjs` into its own pure module (not left inline) so it's directly
 * importable by tests — `drift.mjs` itself is a CLI entry point with an
 * unconditional top-level `main()` call, so importing IT as a module to
 * reach these two functions would trigger that CLI behaviour as a side
 * effect (the same class of issue documented in duplication-detector.mjs's
 * module docblock re: embed.mjs).
 *
 * The pragma is validated only against ACTIVE candidates at write-time
 * (duplication-detector.mjs), so a rename can leave a stale pragma behind
 * with no code path left to catch it. This weekly-cadence sweep is the
 * deliberately cheap, bounded mitigation — a target FILE that no longer
 * exists is the dominant real-world staleness case (rename/delete); full
 * symbol-level re-verification is out of scope for a report that already
 * runs on a low-stakes cadence.
 *
 * `findStalePragmas` now delegates its full-repo sweep to
 * `findRepoPragmas` (`scripts/lib/duplicate-justification-pragma.mjs`,
 * `shared-lib` domain — arch-drift-duplication-cleanup plan) instead of
 * running its own `git grep`. That module is also `arch:refresh`'s
 * (`refresh.mjs`) source for resolving pragma-bearing declarations into
 * the drift-exclusion write path — one full-repo sweep implementation,
 * two consumers. (A prior version of this docblock claimed "only
 * audit-orchestration -> arch-memory is an approved edge" as the reason
 * this module stayed self-contained; that claim was never actually
 * verified against `.audit-loop/domain-map.json` and turned out to be
 * false — Gemini plan-gate G2 caught it. `shared-lib` is the real answer:
 * both `arch-memory` and `audit-orchestration` are already allowed to
 * depend on it.)
 *
 * @module scripts/lib/symbol-index/stale-pragma-sweep
 */

import fs from 'node:fs';
import path from 'node:path';
import { findRepoPragmas } from '../duplicate-justification-pragma.mjs';

/**
 * Sweep the repo for `@duplicate-justification` pragmas, flag any whose
 * `target` file no longer exists. Best-effort — a sweep failure (e.g. `git
 * grep` unavailable) degrades to an empty list via `findRepoPragmas`,
 * never throws.
 *
 * @param {string} repoRoot
 * @param {{strict?: boolean, env?: NodeJS.ProcessEnv}} [opts] - forwarded
 *   verbatim to `findRepoPragmas` (2026-07-23 Gemini final-gate fix — this
 *   function spawns no git subprocess directly, but as a transparent
 *   wrapper around one that does, it needs to forward an `env` override or
 *   a caller exercising it against an isolated test fixture has no path to
 *   supply one; the isolation would be silently lost at this wrapper
 *   boundary even after `findRepoPragmas` itself accepted `opts.env`).
 * @returns {{file: string, line: number, targetFile: string}[]}
 */
export function findStalePragmas(repoRoot, opts = {}) {
  const stale = [];
  for (const { pragmaFile, pragmaLine, targetFile } of findRepoPragmas(repoRoot, opts)) {
    if (!fs.existsSync(path.join(repoRoot, targetFile))) {
      stale.push({ file: pragmaFile, line: pragmaLine, targetFile });
    }
  }
  return stale;
}

/** Renders `[]` as `''` (no noise on the common case) — never gates `arch:drift`'s status/exit code, this is LOW-severity dead documentation, not a safety gap. */
export function renderStalePragmaSection(stale) {
  if (stale.length === 0) return '';
  const rows = stale.map((s) => `| \`${s.file}:${s.line}\` | \`${s.targetFile}\` (no longer exists) |`).join('\n');
  return `\n## Stale suppression pragmas (LOW — dead documentation, not a safety gap)\n\n` +
    `| Pragma location | Target |\n|---|---|\n${rows}\n\n` +
    `These \`// @duplicate-justification\` pragmas reference a target file that no longer exists — ` +
    `almost always a rename. Update the pragma's target or remove it if the duplication no longer applies.\n`;
}
