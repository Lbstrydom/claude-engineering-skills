/**
 * @fileoverview The VCS change record + policy exclusions the file-coverage ledger needs, built where `--scope diff` is
 * computed. Kept out of `openai-audit.mjs` (over the size limit; it may not grow) — this is the seam between "every file git
 * says changed" and "the files the audit will read".
 *
 * A file dropped as audit infrastructure, by `--exclude-paths` / `.auditignore`, or because its type is not one anyone audits
 * is still a CHANGED file. The ledger has to be able to say so, so the record is taken from the UNFILTERED set, and the two
 * refusal lists are returned alongside the filtered candidates.
 *
 * @module scripts/lib/audit/change-record
 */

import { execFileSync } from 'node:child_process';
import { isAuditInfraFile } from '../audit-scope.mjs';
import { parseNameStatusZ } from './file-coverage.mjs';

/**
 * @param {object} input
 * @param {string[]} input.diffChanged `git diff --name-only <base>` output, split
 * @param {string[]} input.untrackedFiles `git ls-files --others --exclude-standard`, split
 * @param {string} input.baseSha the resolved, validated base
 * @param {boolean} input.allowInfraScope
 * @param {string[]} input.excludePatterns
 * @param {(files: string[], patterns: string[]) => string[]} input.applyExclusions
 * @param {typeof execFileSync} [input.run] injectable for tests
 * @returns {{changed: Array<{path: string, changeKind: string, renamedFrom: string|null}>,
 *   excluded: {infra: string[], user: string[]}, candidates: string[], nameStatusError: string|null}}
 */
export function buildChangeRecord({ diffChanged, untrackedFiles, baseSha, allowInfraScope, excludePatterns, applyExclusions, run = execFileSync }) {
  const everyChanged = [...new Set([...diffChanged, ...untrackedFiles])];

  // Change KIND comes from git, never from filesystem presence. If the call fails (or its output is malformed) the SET is
  // unchanged but the kinds are UNKNOWN: they fall back to `modified` and the failure is returned + named on stderr, so a
  // deleted file mistaken for a modified one is a reported degradation, not a quiet one.
  let nameStatus = [];
  let nameStatusError = null;
  try {
    nameStatus = parseNameStatusZ(run('git', ['diff', '--name-status', '-z', baseSha], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }));
  } catch (err) {
    nameStatusError = err?.message || String(err);
    process.stderr.write(`  [coverage] change kinds unavailable (${nameStatusError}) — tracked files are recorded as \`modified\`\n`);
  }
  const byPath = new Map(nameStatus.map((r) => [r.path, r]));
  const untracked = new Set(untrackedFiles);
  const changed = everyChanged.map((p) => byPath.get(p) ?? { path: p, changeKind: untracked.has(p) ? 'untracked' : 'modified', renamedFrom: null });

  const infra = allowInfraScope ? [] : everyChanged.filter((f) => isAuditInfraFile(f));
  let candidates = everyChanged.filter((f) => allowInfraScope || !isAuditInfraFile(f));
  let user = [];
  if (excludePatterns.length > 0) {
    const kept = new Set(applyExclusions(candidates, excludePatterns));
    user = candidates.filter((f) => !kept.has(f));
    candidates = candidates.filter((f) => kept.has(f));
  }
  return { changed, excluded: { infra, user }, candidates, nameStatusError };
}
