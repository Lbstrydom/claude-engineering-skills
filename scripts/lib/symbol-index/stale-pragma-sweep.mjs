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
 * Lives under `scripts/lib/symbol-index/` (arch-memory domain, not
 * `scripts/lib/audit/`) even though the pragma CONVENTION it sweeps for is
 * introduced by the duplication audit wave (audit-orchestration domain) —
 * living in `lib/audit/` would make `drift.mjs` (arch-memory) import FROM
 * audit-orchestration, creating a bidirectional arch-memory <-> audit-
 * orchestration dependency where only audit-orchestration -> arch-memory
 * is an approved edge (caught in this plan's own round-1 code-audit, H6).
 * This module has zero cross-domain imports (only node: builtins) — placing
 * it in the domain of its actual (sole) caller resolves the cycle cleanly
 * rather than adding a new allowedDeps exception.
 *
 * @module scripts/lib/symbol-index/stale-pragma-sweep
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PRAGMA_TARGET_RE = /@duplicate-justification:\s*target=([^\s:]+):/;

/**
 * Grep tracked files for the pragma, flag any whose `target` file no
 * longer exists on disk. Best-effort — a `git grep` failure (e.g. no
 * matches, exit 1) degrades to an empty list, never throws.
 *
 * @param {string} repoRoot
 * @returns {{file: string, line: number, targetFile: string}[]}
 */
export function findStalePragmas(repoRoot) {
  let output;
  try {
    // Pathspec excludes docs AND the tests/ dir. Docs: the pragma is a
    // source-code-comment construct; markdown files legitimately quote its
    // syntax in prose (e.g. this plan/skill's own documentation) with
    // placeholder targets that would otherwise false-positive as "stale"
    // (found live against this repo's own AGENTS.md during implementation —
    // see tests/drift-stale-pragma.test.mjs). tests/: the duplication wave's
    // own test suite (duplication-detector.test.mjs, drift-stale-pragma.test.mjs)
    // deliberately writes synthetic pragmas with fake/nonexistent targets as
    // fixture data to exercise this exact sweep — found live in this repo's
    // own drift report after adding those fixtures.
    output = execFileSync('git', ['grep', '-n', '-F', '@duplicate-justification:', '--', '.', ':(exclude)*.md', ':(exclude)tests/*'], {
      cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // git grep exits 1 with empty stdout when there are zero matches — not an error.
    if (err.status === 1 && !err.stdout) return [];
    process.stderr.write(`arch:drift: stale-pragma sweep skipped (git grep failed: ${err.message})\n`);
    return [];
  }
  const stale = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    const [, file, lineNo, text] = m;
    const targetMatch = PRAGMA_TARGET_RE.exec(text);
    if (!targetMatch) continue;
    const targetFile = targetMatch[1];
    // Placeholder/template text, not a real pragma on a real declaration —
    // e.g. a `recommendation` string that BUILDS the pragma syntax as
    // instructional text (`${topMatch.filePath}` interpolation, found live
    // in this repo's own duplication-report.mjs) or docs prose quoting a
    // `<file>` placeholder. No real file path contains these characters.
    if (/[<>${}]/.test(targetFile)) continue;
    if (!fs.existsSync(path.join(repoRoot, targetFile))) {
      stale.push({ file, line: Number(lineNo), targetFile });
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
