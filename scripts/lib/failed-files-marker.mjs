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
