/**
 * @fileoverview GitHub token-permission probing for `check-setup.mjs`'s
 * "GitHub" section.
 *
 * ## Why this exists
 *
 * Every consumer repo that runs `/ship`, `/audit-code` or `scripts/cross-skill.mjs`
 * eventually hits a `gh` command that fails with a bare `403`, and each one
 * rediscovers by trial and error which token permission was missing. GitHub
 * already answers that question on every REST response — it just isn't printed
 * anywhere a human looks.
 *
 * ## The mechanism
 *
 * GitHub returns an `X-Accepted-Github-Permissions` response header on REST
 * responses **regardless of outcome** — on a `200` as readily as on a `403`.
 * It names the exact permission that endpoint requires. Measured 2026-08-28
 * against `Lbstrydom/claude-engineering-skills` with `gh api -i`:
 *
 * ```
 * repos/{slug}                                200  metadata=read
 * repos/{slug}/contents/                      200  contents=read
 * repos/{slug}/commits/{branch}/check-runs    200  checks=read
 * repos/{slug}/pulls?per_page=1               200  pull_requests=read
 * repos/{slug}/issues?per_page=1              200  issues=read
 * repos/{slug}/actions/runs?per_page=1        200  actions=read
 * repos/{slug}/branches/{branch}/protection   403  administration=read
 * ```
 *
 * So the permission NAMES are never hardcoded here — {@link READ_PROBES} names
 * only endpoints and the human reason each is needed; the permission is read
 * back out of the header. That is deliberate and load-bearing: a hardcoded
 * table is a claim about GitHub's authorization rules that nothing keeps
 * current, and it would drift silently the moment GitHub re-partitions a
 * permission (as it did splitting `administration` out of `repo`). Deriving it
 * from the header means this check reports what GitHub *enforces today*, and a
 * re-partition shows up as a changed permission name in the output rather than
 * as a wrong PASS.
 *
 * ## Read-only, always
 *
 * Every probe is a `GET` against a resource that already exists. There is no
 * re-run / dispatch / create / PUT probe here and there must never be one: a
 * setup doctor that dispatches a workflow to learn it *could* dispatch a
 * workflow has changed the repo it was asked to inspect. Write requirements are
 * expressed as DOCUMENTATION in {@link WRITE_REQUIREMENTS}, printed alongside
 * the probe results and never tested live.
 *
 * ## Never blocking
 *
 * A missing permission is a WARN, never a FAIL. A backend-only consumer that
 * never opens a PR is correctly configured without `pull_requests=read`, and
 * failing them is the same false-alarm class as the Azure/`OPENAI_API_KEY` fix
 * in `check-setup.mjs`. Likewise, no token at all is an INFO: absence of a
 * GitHub token is not a broken setup, it is a setup that does not use GitHub.
 *
 * @module scripts/lib/doctor/github-permissions
 */

import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/** The only host a token from this module is ever sent to. */
export const GITHUB_API_HOST = 'api.github.com';

const USER_AGENT = 'claude-engineering-skills-check-setup';
const DEFAULT_TIMEOUT_MS = 8000;

// ── Probe table ───────────────────────────────────────────────────────────────

/**
 * Read-only endpoints to probe, and WHY each matters. The `permission` is NOT
 * declared here — it comes back in `X-Accepted-Github-Permissions`.
 *
 * `path` is a function of `{slug, branch}` so a probe can name the repo's real
 * default branch rather than assuming `main`.
 *
 * Adding a probe? It must be a `GET` on a resource that exists. If you find
 * yourself wanting to POST to learn whether a POST would work, add a row to
 * {@link WRITE_REQUIREMENTS} instead.
 *
 * @type {ReadonlyArray<{id:string, path:(ctx:{slug:string,branch:string})=>string, reason:string}>}
 */
export const READ_PROBES = Object.freeze([
  {
    id: 'repo',
    path: ({ slug }) => `/repos/${slug}`,
    reason: 'every `gh` command resolves the repo first — without this nothing works',
  },
  {
    id: 'contents',
    path: ({ slug }) => `/repos/${slug}/contents/`,
    reason: '`gh api` file reads; the docs ref-checker resolves links through it',
  },
  {
    id: 'check-runs',
    path: ({ slug, branch }) => `/repos/${slug}/commits/${encodeURIComponent(branch)}/check-runs`,
    reason: '`gh pr checks` — /ship reads CI status after pushing',
  },
  {
    id: 'pulls',
    path: ({ slug }) => `/repos/${slug}/pulls?per_page=1`,
    reason: '`gh pr view|list|checks` — /ship\'s PR flow in consumer repos',
  },
  {
    id: 'issues',
    path: ({ slug }) => `/repos/${slug}/issues?per_page=1`,
    reason: '`cross-skill.mjs upstream issues` — reading filed upstream bug reports',
  },
  {
    id: 'actions',
    path: ({ slug }) => `/repos/${slug}/actions/runs?per_page=1`,
    reason: '`npm run runner:doctor` and workflow-run inspection',
  },
  {
    id: 'branch-protection',
    path: ({ slug, branch }) => `/repos/${slug}/branches/${encodeURIComponent(branch)}/protection`,
    reason: '`npm run ensure-branch-protection` reads current protection before deciding',
  },
]);

/**
 * Write permissions the skills need, as DOCUMENTATION. Never probed — every
 * endpoint that would prove one has a side effect on the repo.
 *
 * Both vocabularies are carried because both token models are in use:
 * `permission` is the fine-grained name, `scope` the classic-OAuth equivalent.
 * A reader on a classic PAT who is shown only `pull_requests=write` cannot act
 * on it — there is no such checkbox on a classic token.
 *
 * @type {ReadonlyArray<{permission:string, scope:string, reason:string}>}
 */
export const WRITE_REQUIREMENTS = Object.freeze([
  { permission: 'contents=write', scope: 'repo', reason: '`git push` over HTTPS when the token is the git credential — /ship' },
  { permission: 'pull_requests=write', scope: 'repo', reason: '`gh pr create` — /ship opening a PR in a consumer repo' },
  { permission: 'issues=write', scope: 'repo', reason: '`cross-skill.mjs upstream report` filing an upstream bug' },
  { permission: 'workflows=write', scope: 'workflow', reason: 'pushing a commit that touches `.github/workflows/**`' },
  { permission: 'administration=write', scope: 'repo', reason: '`npm run ensure-branch-protection` applying a ruleset change' },
  { permission: 'actions=write', scope: 'repo', reason: '`gh run rerun` — re-running a failed workflow' },
]);

// ── Header parsing ────────────────────────────────────────────────────────────

/**
 * Parse an `X-Accepted-Github-Permissions` header value.
 *
 * Observed forms:
 *   `checks=read`                          — one permission
 *   `issues=read,pull_requests=read`       — ALTERNATIVES (either suffices)
 *   `issues=write; pull_requests=write`    — a CONJUNCTION (all required)
 *   `allows_permissionless_access=true`    — not a permission at all
 *
 * Comma separates alternatives; semicolon joins the members of one alternative.
 * The distinction matters for honesty, not for cosmetics: with two alternatives
 * a `403` tells you *neither* was granted, but a `200` tells you only that *at
 * least one* was — never which. The caller must not claim more than that, so
 * the groups are preserved rather than flattened into a permission list.
 *
 * @param {string|undefined|null} headerValue
 * @returns {{groups: string[][], permissionless: boolean, raw: string|null}}
 */
export function parseAcceptedPermissions(headerValue) {
  const raw = typeof headerValue === 'string' && headerValue.trim() ? headerValue.trim() : null;
  if (!raw) return { groups: [], permissionless: false, raw: null };

  let permissionless = false;
  const groups = [];
  for (const alternative of raw.split(',')) {
    const members = [];
    for (const part of alternative.split(';')) {
      const token = part.trim();
      if (!token) continue;
      // `allows_permissionless_access=true` is a marker, not a permission —
      // /user carries it. Recording it as a permission would report a
      // "GRANTED allows_permissionless_access=true" line that means nothing.
      if (/^allows_permissionless_access\s*=/i.test(token)) { permissionless = true; continue; }
      members.push(token.replace(/\s*=\s*/, '='));
    }
    if (members.length) groups.push(members);
  }
  return { groups, permissionless, raw };
}

/**
 * Parse `X-Accepted-Oauth-Scopes` — the CLASSIC-token analogue of the header
 * above. Measured 2026-08-28: a `gho_` OAuth token gets **no**
 * `X-Accepted-Github-Permissions` header at all, on any endpoint; GitHub
 * answers the same question for classic credentials with
 * `X-Accepted-Oauth-Scopes: repo` (required) and `X-Oauth-Scopes: gist,
 * read:org, repo, workflow` (granted).
 *
 * Supporting both is not scope creep — it is the same "derive it from what
 * GitHub tells you" rule applied to the other credential model. Reading only
 * the fine-grained header would make this check silently measure NOTHING for
 * every consumer on a classic PAT or a `gh auth login` OAuth token, which is
 * most of them.
 *
 * An empty value is meaningful and distinct from an absent one: it means the
 * endpoint needs no scope at all.
 *
 * @param {string|undefined|null} headerValue
 * @returns {{groups: string[][], raw: string|null}}
 */
export function parseAcceptedOauthScopes(headerValue) {
  if (typeof headerValue !== 'string') return { groups: [], raw: null };
  const raw = headerValue.trim();
  const groups = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => [s]);
  return { groups, raw };
}

/**
 * Pick whichever access model this response actually described, so the caller
 * never has to know which kind of token it is holding.
 *
 * @param {Record<string,string|string[]|undefined>} headers
 * @returns {{model:'fine-grained'|'oauth'|'none', groups:string[][], permissionless:boolean, raw:string|null}}
 */
export function parseRequiredAccess(headers = {}) {
  const fine = parseAcceptedPermissions(headers['x-accepted-github-permissions']);
  if (fine.raw !== null) return { model: 'fine-grained', ...fine };

  const oauth = parseAcceptedOauthScopes(headers['x-accepted-oauth-scopes']);
  if (oauth.raw !== null) return { model: 'oauth', groups: oauth.groups, permissionless: false, raw: oauth.raw };

  return { model: 'none', groups: [], permissionless: false, raw: null };
}

/**
 * Render one parsed group set back to a stable display string.
 * `[["issues=read"],["pull_requests=read"]]` → `issues=read OR pull_requests=read`.
 * An empty set means the endpoint required nothing.
 */
export function formatPermissionGroups(groups) {
  if (!groups.length) return '(no permission required)';
  return groups.map((g) => g.join(' + ')).join(' OR ');
}

// ── Status classification ─────────────────────────────────────────────────────

/**
 * Map an HTTP status to a permission verdict.
 *
 * `404` is deliberately `unknown`, not `missing`: GitHub answers `404` rather
 * than `403` when a fine-grained token cannot see a resource AT ALL, and it
 * also answers `404` when the resource genuinely does not exist (an empty repo
 * has no `contents/`, a repo with no protection rule has no `.../protection`).
 * Those two are indistinguishable from the status alone, and calling the
 * ambiguous case MISSING would send an operator to fix a permission that was
 * never the problem.
 *
 * Any other 4xx (e.g. the `422` a bad branch name produces) means the request
 * got PAST authorization and failed validation — the permission is granted.
 *
 * @param {number} status
 * @returns {'granted'|'missing'|'unknown'|'unauthorized'|'error'}
 */
export function classifyProbeStatus(status) {
  if (status >= 200 && status < 300) return 'granted';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'missing';
  if (status === 404) return 'unknown';
  if (status >= 400 && status < 500) return 'granted';
  return 'error';
}

// ── Token sources ─────────────────────────────────────────────────────────────

/** Non-reversible short fingerprint, for comparing two tokens without printing either. */
export function tokenFingerprint(token) {
  return createHash('sha256').update(String(token)).digest('hex').slice(0, 8);
}

/**
 * Name a token's KIND from its documented prefix. Never returns any part of the
 * secret itself — `github_pat_11BP2FL…` reports as `fine-grained PAT`, nothing
 * more. Used so the "your sources disagree" warning can be specific without
 * ever putting a credential on a terminal or in `--json` output.
 */
export function tokenKind(token) {
  const t = String(token || '');
  if (t.startsWith('github_pat_')) return 'fine-grained PAT';
  if (t.startsWith('ghp_')) return 'classic PAT';
  if (t.startsWith('gho_')) return 'OAuth token';
  if (t.startsWith('ghu_')) return 'GitHub App user token';
  if (t.startsWith('ghs_')) return 'GitHub App installation token';
  if (t.startsWith('ghr_')) return 'refresh token';
  return 'unrecognised token format';
}

/**
 * Ask `gh` for the token it would itself use. Returns `{token}` or
 * `{token: null, reason}` — never throws, because "gh is not installed" and
 * "gh is not logged in" are both ordinary, non-failing states here.
 *
 * `GH_TOKEN`/`GITHUB_TOKEN` are SCRUBBED from the child environment, because
 * `gh auth token` echoes them back when either is set. Inheriting them would
 * make the keyring report whatever the environment already said — the two
 * sources would agree by construction and the comparison this whole check
 * exists for could never fire. Scrubbing makes `gh` answer the question
 * actually being asked: what is in your keyring, independently of my shell?
 */
export function readGhKeyringToken({ exec = execFileSync, env = process.env } = {}) {
  const childEnv = { ...env };
  delete childEnv.GH_TOKEN;
  delete childEnv.GITHUB_TOKEN;
  try {
    const out = exec('gh', ['auth', 'token'], {
      encoding: 'utf-8',
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    const token = String(out || '').trim();
    return token ? { token } : { token: null, reason: '`gh auth token` returned nothing' };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { token: null, reason: 'the `gh` CLI is not installed' };
    const stderr = String(err?.stderr || '').trim();
    return { token: null, reason: stderr.split('\n')[0] || err?.message || 'gh auth token failed' };
  }
}

/**
 * Enumerate every place a GitHub token could be coming from, in the precedence
 * order this check uses, and say which one WINS.
 *
 * This is the half of the check that a consumer repo actually lost time to: the
 * repo's `.env` held one token, `gh`'s keyring held a different one with
 * different permissions, and because nothing ever compared them the operator
 * spent hours debugging permissions on the token that was not being used. So
 * every source is listed even after a winner is found, and the caller compares
 * their identities.
 *
 * Precedence deliberately mirrors `gh`'s own (`GH_TOKEN` > `GITHUB_TOKEN` >
 * keyring) with the repo `.env` slotted in below the real shell exports —
 * matching how `lib/load-env.mjs` layers a repo `.env` under genuine externals.
 *
 * `processEnv` values that are byte-identical to the `.env` file's are
 * attributed to the FILE, not to a shell export: `check-setup.mjs` imports
 * `lib/load-env.mjs`, so a `.env` value is already in `process.env` by the time
 * this runs and crediting the shell would be wrong. When the two differ, the
 * shell genuinely won and is reported as such.
 *
 * @param {object} opts
 * @param {Record<string,string|undefined>} opts.processEnv
 * @param {Record<string,string>} opts.fileEnv    parsed contents of the repo `.env`
 * @param {string|null} opts.envFilePath          where that `.env` was found (for display)
 * @param {{token:string|null, reason?:string}} opts.gh   result of {@link readGhKeyringToken}
 * @returns {{sources: Array<{id:string,label:string,token:string}>, winner: object|null, ghReason: string|null}}
 */
export function resolveTokenSources({ processEnv = {}, fileEnv = {}, envFilePath = null, gh = { token: null } }) {
  const sources = [];
  const seen = new Set();

  const push = (id, label, token) => {
    if (!token) return;
    const key = `${id}:${tokenFingerprint(token)}`;
    if (seen.has(key)) return;
    seen.add(key);
    sources.push({ id, label, token });
  };

  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const shellValue = (processEnv[name] || '').trim();
    const fileValue = (fileEnv[name] || '').trim();
    if (shellValue && shellValue !== fileValue) push(`env:${name}`, `${name} (shell export)`, shellValue);
  }
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const fileValue = (fileEnv[name] || '').trim();
    if (fileValue) push(`dotenv:${name}`, `${name} (${envFilePath || '.env'})`, fileValue);
  }
  if (gh.token) push('gh:keyring', '`gh` keyring (gh auth token)', gh.token.trim());

  return {
    sources,
    winner: sources[0] || null,
    ghReason: gh.token ? null : (gh.reason || null),
  };
}

// ── Declared token source (`GH_TOKEN_SOURCE_EXPECTED`) ────────────────────────

/** The env var a repo sets to declare which token source SHOULD win there. */
export const EXPECTED_SOURCE_VAR = 'GH_TOKEN_SOURCE_EXPECTED';

/** Accepted values, in the vocabulary a human would use for the three places a token lives. */
export const TOKEN_SOURCE_KINDS = Object.freeze(['shell', 'dotenv', 'keyring']);

/**
 * Reduce a source id (`env:GH_TOKEN`, `dotenv:GITHUB_TOKEN`, `gh:keyring`) to
 * its kind. WHICH variable carried the token is not what the declaration is
 * about — a repo that means "my .env owns this" should not have to re-declare
 * when it renames `GH_TOKEN` to `GITHUB_TOKEN`.
 */
export function tokenSourceKind(id) {
  if (typeof id !== 'string') return null;
  if (id.startsWith('env:')) return 'shell';
  if (id.startsWith('dotenv:')) return 'dotenv';
  if (id === 'gh:keyring') return 'keyring';
  return null;
}

/**
 * Adjudicate a repo's declared token source against the one that actually won.
 *
 * This is deliberately a FALSIFIABLE DECLARATION, not a mute. A plain
 * suppression flag would silence the multi-source warning in the one situation
 * it is most needed — the day the intended token stops winning — and a repo
 * that had opted out would never hear about it again. So:
 *
 *   - declared and holding    → the disagreement is expected; downgrade to INFO
 *   - declared and VIOLATED   → a STRONGER warning than the generic one, because
 *                               the repo stated an intent that is not being met
 *   - declared but unreadable → warn about the declaration itself; never treat
 *                               an unrecognised value as "opted out", or a typo
 *                               would suppress the warning by accident
 *
 * The `match` case is also reported on the "Token source" line, so a marker
 * that is live looks different from one that was silently ignored (a typo in
 * the variable NAME is otherwise indistinguishable from a working opt-out).
 *
 * @param {string|undefined|null} declared  raw `GH_TOKEN_SOURCE_EXPECTED` value
 * @param {string|null} winnerId            the winning source's id
 * @returns {{state:'unset'|'invalid'|'match'|'mismatch', declared:string|null, actual:string|null}}
 */
export function evaluateExpectedSource(declared, winnerId) {
  const value = typeof declared === 'string' ? declared.trim().toLowerCase() : '';
  if (!value) return { state: 'unset', declared: null, actual: tokenSourceKind(winnerId) };
  if (!TOKEN_SOURCE_KINDS.includes(value)) {
    return { state: 'invalid', declared: value, actual: tokenSourceKind(winnerId) };
  }
  const actual = tokenSourceKind(winnerId);
  return { state: actual === value ? 'match' : 'mismatch', declared: value, actual };
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

/**
 * One `GET` to api.github.com, returning status + headers. The body is
 * discarded except for the small set of fields {@link probeGitHubPermissions}
 * needs (`default_branch`, `login`), so a large listing response never lands in
 * memory or in a report.
 *
 * `agent: false` is not incidental: the default global agent keeps the socket
 * alive and a one-shot CLI then hangs after its work is done with nothing left
 * to do but wait for a keep-alive timeout.
 *
 * The host is pinned to {@link GITHUB_API_HOST}. A token must not be sendable
 * to an arbitrary host by passing a different path, so the caller supplies a
 * path only.
 */
export async function githubGet(pathname, token, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: GITHUB_API_HOST,
        path: pathname,
        method: 'GET',
        agent: false,
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${token}`,
          'User-Agent': USER_AGENT,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        // Cap the retained body: these are metadata probes, and a `pulls`
        // listing on a busy repo is megabytes we have no use for.
        res.setEncoding('utf-8');
        res.on('data', (chunk) => { if (body.length < 64_000) body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on('timeout', () => { req.destroy(new Error(`timed out after ${timeoutMs}ms`)); });
    req.on('error', (err) => resolve({ status: 0, headers: {}, body: '', error: err.message }));
    req.end();
  });
}

function parseJsonBody(body) {
  try { return JSON.parse(body); } catch { return null; }
}

// ── Probing ───────────────────────────────────────────────────────────────────

/**
 * Identify a token: who it authenticates as, and (for classic tokens) what
 * OAuth scopes it carries. Used to compare two token SOURCES without ever
 * comparing or printing the secrets themselves.
 *
 * @returns {{ok:boolean, login:string|null, scopes:string|null, status:number, error?:string}}
 */
export async function identifyToken(token, { get = githubGet } = {}) {
  const res = await get('/user', token);
  if (res.error) return { ok: false, login: null, scopes: null, status: 0, error: res.error };
  const json = res.status >= 200 && res.status < 300 ? parseJsonBody(res.body) : null;
  return {
    ok: res.status >= 200 && res.status < 300,
    login: json?.login ?? null,
    scopes: typeof res.headers['x-oauth-scopes'] === 'string' ? res.headers['x-oauth-scopes'] : null,
    status: res.status,
  };
}

/**
 * Run the read-only probe table and derive each endpoint's required permission
 * from its response header.
 *
 * @param {object} opts
 * @param {string} opts.slug     `owner/repo`
 * @param {string} opts.branch   default branch name
 * @param {string} opts.token
 * @param {typeof githubGet} [opts.get]  injectable transport (tests)
 * @returns {Promise<Array<{id, reason, status, verdict, permissions, permissionless, headerPresent, error}>>}
 */
export async function probeGitHubPermissions({ slug, branch, token, get = githubGet, probes = READ_PROBES }) {
  return Promise.all(probes.map(async (probe) => {
    const res = await get(probe.path({ slug, branch }), token);
    if (res.error) {
      return {
        id: probe.id, reason: probe.reason, status: 0, verdict: 'error', model: 'none',
        permissions: [], permissionless: false, headerPresent: false, error: res.error,
      };
    }
    const parsed = parseRequiredAccess(res.headers);
    return {
      id: probe.id,
      reason: probe.reason,
      status: res.status,
      verdict: classifyProbeStatus(res.status),
      model: parsed.model,
      permissions: parsed.groups,
      permissionless: parsed.permissionless,
      headerPresent: parsed.raw !== null,
      error: null,
    };
  }));
}

/**
 * Resolve the repo's default branch from the `repo` probe's own response, so
 * the branch-scoped probes address a ref that exists. Falls back to `main`
 * rather than failing: a wrong branch yields `422`, which
 * {@link classifyProbeStatus} already reads as "authorization passed".
 */
export async function resolveDefaultBranch({ slug, token, get = githubGet, fallback = 'main' }) {
  const res = await get(`/repos/${slug}`, token);
  if (res.error || res.status < 200 || res.status >= 300) return fallback;
  return parseJsonBody(res.body)?.default_branch || fallback;
}
