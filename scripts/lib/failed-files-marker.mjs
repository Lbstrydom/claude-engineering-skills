/**
 * @fileoverview The one line `run-tests.mjs` prints on a failing run, naming the failing test files, and that the CI
 * flake classifier (`ci-flake-rerun.mjs`) parses back out of a GitHub Actions log. Dependency-free on purpose: the test
 * runner imports it and must not load the classifier's dependencies to print one line.
 *
 * Grammar: `run-tests/v1 failed-files: <JSON array of repo-relative test files>` or `run-tests/v1 failed-files: unknown`.
 * Bump the version if the payload changes.
 *
 * @module scripts/lib/failed-files-marker
 */
export const FAILED_FILES_MARKER = 'run-tests/v1 failed-files:';

/**
 * Parse the payload after the marker: the ONE reader of this grammar (the CI flake classifier and ship-train's
 * thinness metric both call it). `unknown` → `{kind:'unknown'}`; a JSON array of non-empty strings (the empty array
 * included) → `{kind:'files', files}`; anything else → `{kind:'malformed', raw}` with the first 80 characters.
 * @param {string} payload the text after `FAILED_FILES_MARKER`, untrimmed is fine
 * @returns {{kind: 'files', files: string[]}|{kind: 'unknown'}|{kind: 'malformed', raw: string}}
 */
export function parseFailedFilesPayload(payload) {
  const p = String(payload ?? '').trim();
  if (p === 'unknown') return { kind: 'unknown' };
  try {
    const v = JSON.parse(p);
    if (Array.isArray(v) && v.every((f) => typeof f === 'string' && f)) return { kind: 'files', files: v };
  } catch { /* malformed below */ }
  return { kind: 'malformed', raw: p.slice(0, 80) };
}
