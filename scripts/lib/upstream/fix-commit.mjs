/**
 * @fileoverview Resolving `upstream fix --commit` from a CONSUMER repo (proposal 5bc2). Split out of `commands.mjs` to keep that
 * file under the size ratchet; `commands.mjs` re-exports `resolveFixCommit`.
 *
 * @module scripts/lib/upstream/fix-commit
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** `owner/name` - the only shape a manifest repo may take before it is put in a URL or an API path. */
const REPO_SLUG_RE = /^[\w.-]+\/[\w.-]+$/;
const HEX_COMMIT_RE = /^[0-9a-f]{8,40}$/i;

/** The upstream repo slug the consumer's synced manifest names, or null. Never throws. */
function manifestUpstreamRepo(repoRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts', '.sync-manifest.json'), 'utf-8'));
    return typeof raw?.repo === 'string' && REPO_SLUG_RE.test(raw.repo) ? raw.repo : null;
  } catch { return null; }
}

/**
 * Resolve a `--commit` to a FULL oid that is a commit object in THIS repository (proposal 5bc2).
 *
 * The invariant is kept exactly: a stored commit resolves locally (requirement REQ-correctness-2f2c1d39), because it is the basis for
 * every later ancestry check. What changes is where a consumer finds the commit: the fix lives in the UPSTREAM repo, which the
 * consumer has never fetched, so a local rev-parse alone made every consumer-side close impossible. When the local lookup fails and the
 * synced manifest names the upstream repo, the commit is (1) resolved to a full oid on the remote, (2) fetched into this repo's object
 * database - objects and FETCH_HEAD only; no --depth (a depth fetch writes .git/shallow) and no --filter (it adds promisor config) -
 * and (3) re-resolved LOCALLY. Any step failing returns the usual BAD_INPUT naming the step; nothing is stored.
 *
 * @param {{repoRoot: string, commit: string,
 *   resolveUpstreamCommit?: (repo: string, sha: string) => {ok: boolean, oid?: string, error?: string},
 *   fetchObject?: (args: {repoRoot: string, repo: string, oid: string}) => {ok: boolean, error?: string}}} args
 * @returns {{ok: true, oid: string, fetched: boolean} | {ok: false, error: string}}
 */
export function resolveFixCommit({ repoRoot, commit, resolveUpstreamCommit = defaultResolveUpstreamCommit, fetchObject = defaultFetchObject }) {
  const local = (rev) => {
    const r = git(['rev-parse', '--verify', `${rev}^{commit}`], repoRoot);
    return r.status === 0 ? String(r.stdout).trim() : null;
  };
  const here = local(commit);
  if (here) return { ok: true, oid: here, fetched: false };
  const unresolved = `--commit "${commit}" does not resolve in this repo`;
  if (!HEX_COMMIT_RE.test(commit)) return { ok: false, error: unresolved };
  const repo = manifestUpstreamRepo(repoRoot);
  if (!repo) return { ok: false, error: `${unresolved}, and no synced manifest names an upstream repo to look it up in` };
  const remote = resolveUpstreamCommit(repo, commit);
  if (!remote?.ok || !/^[0-9a-f]{40}$/.test(String(remote.oid))) {
    return { ok: false, error: `${unresolved}; looking it up in ${repo} failed: ${remote?.error ?? 'no 40-hex commit id came back'}` };
  }
  const fetched = fetchObject({ repoRoot, repo, oid: remote.oid });
  if (!fetched?.ok) return { ok: false, error: `${unresolved}; fetching ${remote.oid.slice(0, 8)} from ${repo} failed: ${fetched?.error ?? 'unknown error'}` };
  const after = local(remote.oid);
  if (after !== remote.oid) return { ok: false, error: `${unresolved}; it was fetched from ${repo} but still does not resolve to a commit locally` };
  return { ok: true, oid: after, fetched: true };
}

function defaultResolveUpstreamCommit(repo, sha) {
  const r = spawnSync('gh', ['api', `repos/${repo}/commits/${sha}`, '--jq', '.sha'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30_000 });
  if (r.error || r.status !== 0) return { ok: false, error: (r.error?.message ?? String(r.stderr).trim()) || `gh exited ${r.status}` };
  return { ok: true, oid: String(r.stdout).trim() };
}

const NL = String.fromCharCode(10);

function defaultFetchObject({ repoRoot, repo, oid }) {
  const r = git(['fetch', '--no-tags', `https://github.com/${repo}.git`, oid], repoRoot);
  return r.status === 0 ? { ok: true } : { ok: false, error: String(r.stderr).trim().split(NL).slice(-2).join(' ') || `git fetch exited ${r.status}` };
}
