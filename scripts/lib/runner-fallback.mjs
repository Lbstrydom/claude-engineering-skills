/**
 * @fileoverview Pure decision logic for the self-hosted-runner fallback
 * doctor (scripts/actions-runner-doctor.mjs). No network here — the CLI does
 * the `gh api` I/O; this function turns already-fetched signals into a
 * verdict + guidance, so it's unit-testable without GitHub.
 *
 * Scope note: this does NOT detect "GitHub-hosted runners disabled" itself —
 * that's an Enterprise-level runner policy with no exposed API field. It
 * assumes the operator already hit the failure (the workflow annotation
 * names it explicitly: "GitHub Actions hosted runners are disabled for this
 * repository") and answers the next question instead: is a self-hosted
 * runner actually viable for THIS identity, on THIS repo, right now — and if
 * not, what's the fallback.
 *
 * @module scripts/lib/runner-fallback
 */

import { ArgvError } from './cli-io.mjs';

/** Where the no-Actions-at-all fallback lives — this repo's own answer to
 * the same problem for its weekly maintenance workflows. */
export const FALLBACK_DOC = 'docs/runbooks/local-maintenance-checks.md';

/**
 * @typedef {object} RunnerFallbackSignals
 * @property {boolean|null} actionsEnabled - GET actions/permissions .enabled, or null if unreadable
 * @property {boolean} canRegisterSelfHosted - whether a registration-token POST succeeded
 * @property {string|null} [registrationError] - gh's error text when the POST failed
 */

/**
 * @typedef {object} RunnerFallbackVerdict
 * @property {'self-hosted-viable'|'actions-disabled'|'no-admin-rights'|'unknown'} verdict
 * @property {string} headline
 * @property {string[]} guidance
 */

/**
 * @param {RunnerFallbackSignals} signals
 * @returns {RunnerFallbackVerdict}
 */
export function assessRunnerFallback(signals) {
  const { actionsEnabled, canRegisterSelfHosted, registrationError = null } = signals;

  // Checked first and dominant: successfully requesting a registration token
  // proves Actions is enabled AND this identity has admin, regardless of
  // whether the separate permissions GET was itself readable.
  if (canRegisterSelfHosted) {
    return {
      verdict: 'self-hosted-viable',
      headline: 'This identity can self-serve a repo-scoped self-hosted runner right now.',
      guidance: [
        'Register it with the token this run just requested, then install it as a persistent service (see the printed steps).',
        'This only covers THIS repo — for org-wide coverage, an org admin needs to grant org-level runner registration separately.',
      ],
    };
  }

  if (actionsEnabled === false) {
    return {
      verdict: 'actions-disabled',
      headline: 'Actions is disabled entirely for this repo — a self-hosted runner cannot help.',
      guidance: [
        'Ask a repo or org admin to enable Actions (repo Settings -> Actions -> General), or',
        `use the local pre-push-hook fallback instead: ${FALLBACK_DOC}.`,
      ],
    };
  }

  if (actionsEnabled === null) {
    return {
      verdict: 'unknown',
      headline: "Could not read this repo's Actions permissions or register a runner — gh call failed or this identity lacks repo access.",
      guidance: [
        'Confirm `gh auth status` is logged into the right host/account for this repo, then re-run.',
        `If this keeps failing, fall back to: ${FALLBACK_DOC}.`,
      ],
    };
  }

  return {
    verdict: 'no-admin-rights',
    headline: 'Actions is enabled, but this identity cannot register a self-hosted runner (needs repo admin).',
    guidance: [
      registrationError ? `gh reported: ${registrationError}` : null,
      'Ask a repo admin to run this same check, grant you admin, or register the runner themselves.',
      `Until then, use the local pre-push-hook fallback: ${FALLBACK_DOC}.`,
    ].filter(Boolean),
  };
}

/**
 * Map Node's `process.platform`/`process.arch` to the tokens used in
 * `actions/runner` release asset filenames (e.g. `actions-runner-win-x64-2.321.0.zip`).
 * Returns null for a combination with no known runner build — callers should
 * degrade gracefully (point at the repo's own Settings page instead of
 * guessing).
 * @param {string} platform - typically `process.platform`
 * @param {string} arch - typically `process.arch`
 * @returns {{os: string, arch: string}|null}
 */
export function runnerAssetTokens(platform, arch) {
  const os = { win32: 'win', linux: 'linux', darwin: 'osx' }[platform];
  const archToken = { x64: 'x64', arm64: 'arm64' }[arch];
  if (!os || !archToken) return null;
  return { os, arch: archToken };
}

// Owner: starts alnum, then up to 38 more alnum/hyphen chars (GitHub's
// 39-char username/org cap). Repo: alnum, `.`, `_`, `-`, 1-100 chars. Not a
// byte-perfect mirror of GitHub's grammar (e.g. it doesn't reject a lone
// `.`/`..` repo name), but it excludes every shell metacharacter, which is
// the property that matters: the resolved slug gets printed verbatim into a
// copy-paste `config --url https://github.com/<slug> ...` recipe
// (actions-runner-doctor.mjs printRecipe) and passed to `gh api
// repos/<slug>/...`.
const REPO_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/**
 * Whether `slug` is shaped like a GitHub `owner/repository` slug safe to
 * both call the API with and print into a shell-command recipe.
 * @param {unknown} slug
 * @returns {boolean}
 */
export function isValidRepoSlug(slug) {
  return typeof slug === 'string' && REPO_SLUG_RE.test(slug);
}

/**
 * Read `--repo`'s value from argv, distinguishing "flag absent" from "flag
 * present but empty/missing". Collapsing that distinction (checking only
 * `if (repoArg)`, which is falsy for both `null` and `''`) let a
 * present-but-empty `--repo ""` — or `--repo` immediately followed by
 * another `--flag` with no value of its own — silently fall through to
 * git-remote resolution instead of being rejected as invalid input (H2,
 * self-hosted-runner-management Cluster B code audit round 1).
 * @param {string[]} argv - typically `process.argv`
 * @returns {{present: boolean, value: string|null}}
 */
export function readRepoArg(argv) {
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') break;
    if (a.startsWith('--repo=')) return { present: true, value: a.slice('--repo='.length) };
    if (a === '--repo') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) return { present: true, value: null };
      return { present: true, value: next };
    }
  }
  return { present: false, value: null };
}

/**
 * Turn a `readRepoArg` result (already confirmed `present`) into a validated
 * slug, or throw. This is the single choke point for a user-supplied
 * `--repo` — it and `isValidRepoSlug` are what keep an unsafe value out of
 * both the `gh api repos/<slug>/...` calls and the printed copy-paste
 * recipe (actions-runner-doctor.mjs printRecipe; M3, same audit round).
 * @param {{present: true, value: string|null}} repoArg
 * @returns {string}
 * @throws {ArgvError} empty/missing value, or a value that isn't a
 *   plausible `owner/repo` slug
 */
export function resolveRepoSlugFromArg(repoArg) {
  const value = repoArg.value === null ? '' : repoArg.value.trim();
  if (!value) {
    throw new ArgvError('--repo requires a value, e.g. --repo owner/name — got none (empty or missing)');
  }
  if (!isValidRepoSlug(value)) {
    throw new ArgvError(`--repo "${value}" is not a valid GitHub owner/repository slug (expected owner/repo, e.g. octocat/hello-world)`);
  }
  return value;
}

export const _internals = {
  assessRunnerFallback, runnerAssetTokens, isValidRepoSlug, readRepoArg, resolveRepoSlugFromArg,
};
