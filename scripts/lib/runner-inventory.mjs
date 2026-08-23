/**
 * @fileoverview Pure verdict core for self-hosted-runner inventory/health/
 * identity judgements (docs/plans/self-hosted-runner-management.md, Phase 1).
 * No `fs`, no `child_process`, no network, ever — every export here is a
 * function of already-gathered facts, so it is unit-testable with synthetic
 * fixtures and never needs a real runner install or a real org name (the
 * vendor-separation constraint the plan is built around).
 *
 * `scripts/lib/runner-probe.mjs` is the impure sibling that gathers those
 * facts (fs reads, `gh`, service/process probing) and calls into this
 * module — mirroring the existing `runner-fallback.mjs` /
 * `actions-runner-doctor.mjs` split this plan explicitly copies.
 *
 * @module scripts/lib/runner-inventory
 */
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────
// OwnerIdentity codec (D12) — the SOLE producer/comparator of the owner
// tuple. Every call site that needs one (grouping, acknowledgedOwners,
// trustedHosts, the foreign-owner git-remote comparison, remove's identity
// binding) goes through this; nothing else parses a gitHubUrl or git remote.
// ─────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} OwnerIdentity
 * @property {string} host - lowercased; carries `:port` only when non-default
 * @property {'repo'|'org'} ownerKind - path segment count: 1 -> org, 2 -> repo
 * @property {string} ownerSlug - case-folded comparison form
 * @property {string} display - original-case form, human output only
 */

const DEFAULT_PORT_BY_SCHEME = { 'https:': '443', 'ssh:': '22' };

/** SCP-like git remote form: `user@host:owner/repo(.git)?` (no scheme). */
const SCP_LIKE_RE = /^([^@\s/]+)@([^:\s/]+):(.+)$/;

function normaliseHostForCodec(hostname, protocol, port) {
  const h = String(hostname || '').toLowerCase();
  if (!port) return h;
  if (DEFAULT_PORT_BY_SCHEME[protocol] === port) return h;
  return `${h}:${port}`;
}

function segmentsFromPath(pathname) {
  return String(pathname || '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Shared owner-tuple builder for both parse functions below. `enterprises`
 * as the first segment is explicitly rejected (Gemini G2) rather than
 * misread as a two-segment repo owner — an enterprise-scoped runner's
 * `gitHubUrl` is `https://github.com/enterprises/<name>`, structurally
 * indistinguishable from a repo owner unless this is called out by name.
 * Enterprise-level runners are out of scope for v1.
 */
function buildOwnerIdentity(host, segments) {
  if (!host || segments.length < 1 || segments.length > 2) return null;
  if (segments[0].toLowerCase() === 'enterprises') return null;
  const ownerKind = segments.length === 1 ? 'org' : 'repo';
  return {
    host,
    ownerKind,
    ownerSlug: segments.map((s) => s.toLowerCase()).join('/'),
    display: segments.join('/'),
  };
}

/**
 * Parse the `.runner` file's `gitHubUrl` field — always a plain `https://`
 * URL naming either an org (`.../ORG`) or a repo (`.../OWNER/REPO`), never
 * carrying userinfo/query/fragment in a well-formed install. Any of those,
 * or a non-`https:` scheme, is treated as a malformed/tampered value and
 * rejected (`null`) rather than guessed at.
 *
 * @param {unknown} url
 * @returns {OwnerIdentity|null}
 */
export function parseOwnerFromGitHubUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  let u;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.search || u.hash) return null;
  const host = normaliseHostForCodec(u.hostname, u.protocol, u.port);
  const segments = segmentsFromPath(u.pathname);
  return buildOwnerIdentity(host, segments);
}

/**
 * Parse a git remote URL — https, ssh (`ssh://git@host/owner/repo.git`), or
 * the bare SCP-like form (`git@host:owner/repo.git`) — into an OwnerIdentity.
 * `.git` suffix is optional and stripped.
 *
 * Userinfo handling is DELIBERATELY asymmetric across schemes (judgment
 * call — see the implementation report): an `https://` remote rejects any
 * userinfo (a real GitHub https remote never carries one, so its presence
 * indicates tampering/malformed input, same as {@link parseOwnerFromGitHubUrl}).
 * The `ssh://`/SCP-like forms REQUIRE a transport user by convention
 * (`git@host...`) — that is normal git syntax, not a credential — so only an
 * embedded PASSWORD (`user:pass@host`) is rejected there, not the bare user.
 *
 * @param {unknown} url
 * @returns {OwnerIdentity|null}
 */
export function parseOwnerFromGitRemote(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  const raw = url.trim();

  const scp = raw.match(SCP_LIKE_RE);
  if (scp) {
    const [, userinfo, hostRaw, pathRaw] = scp;
    if (userinfo.includes(':')) return null; // embedded password in SCP userinfo
    if (/[?#]/.test(pathRaw)) return null;    // no query/fragment support in this form
    const segments = segmentsFromPath(pathRaw.replace(/\.git$/i, ''));
    return buildOwnerIdentity(hostRaw.toLowerCase(), segments);
  }

  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'ssh:') return null;
  if (u.search || u.hash) return null;
  if (u.protocol === 'https:' && (u.username || u.password)) return null;
  if (u.protocol === 'ssh:' && u.password) return null;
  const host = normaliseHostForCodec(u.hostname, u.protocol, u.port);
  const segments = segmentsFromPath(u.pathname.replace(/\.git$/i, ''));
  return buildOwnerIdentity(host, segments);
}

/**
 * Deterministic grouping/fetch key for an OwnerIdentity — the ONLY place a
 * group key is constructed anywhere (R2 M1).
 * @param {OwnerIdentity} id
 * @returns {string}
 */
export function ownerGroupKey(id) {
  if (!id) throw new TypeError('ownerGroupKey: an OwnerIdentity is required');
  return `${id.host}::${id.ownerKind}::${id.ownerSlug}`;
}

/**
 * Case-insensitive (host + ownerSlug) equality, including `ownerKind`. Two
 * identities of different kinds (an org and a repo) are never equal even if
 * their slugs happen to collide textually.
 * @param {OwnerIdentity|null|undefined} a
 * @param {OwnerIdentity|null|undefined} b
 * @returns {boolean}
 */
export function ownerIdentityEquals(a, b) {
  if (!a || !b) return false;
  return String(a.host).toLowerCase() === String(b.host).toLowerCase()
    && a.ownerKind === b.ownerKind
    && String(a.ownerSlug).toLowerCase() === String(b.ownerSlug).toLowerCase();
}

/**
 * Scope-aware "does this org cover this repo" comparator (Gemini G1). Git
 * remotes are always repo-scoped, so a strict `ownerIdentityEquals` can
 * never match a legitimate org-scoped runner against any repo remote — this
 * compares the org's slug against the OWNER SEGMENT of the repo identity
 * instead. Only meaningful for an org-kind `a` and a repo-kind `b`; anything
 * else returns false rather than guessing.
 * @param {OwnerIdentity|null|undefined} orgIdentity
 * @param {OwnerIdentity|null|undefined} repoIdentity
 * @returns {boolean}
 */
export function ownerCoversRepo(orgIdentity, repoIdentity) {
  if (!orgIdentity || !repoIdentity) return false;
  if (orgIdentity.ownerKind !== 'org' || repoIdentity.ownerKind !== 'repo') return false;
  if (String(orgIdentity.host).toLowerCase() !== String(repoIdentity.host).toLowerCase()) return false;
  const repoOwnerSegment = String(repoIdentity.ownerSlug).split('/')[0];
  return String(orgIdentity.ownerSlug).toLowerCase() === repoOwnerSegment.toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────
// RunnerHostsConfigSchema (M1) — verbatim per plan §3 "Local config schema".
// ─────────────────────────────────────────────────────────────────────────

export const RunnerHostsConfigSchema = z.object({
  // R3 H4 — discriminated, not a bare string: a WSL root cannot be
  // represented by a path string without reintroducing the shape-guessing
  // D5 rejects. Built-in default roots are always the 'local' variant
  // internally (see runner-probe.mjs::defaultInstallRoots).
  extraRoots: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('local'), path: z.string() }),
    z.object({ kind: z.literal('wsl'), distro: z.string(), pathInDistro: z.string() }),
  ])).default([]),
  expectedHostname: z.string().optional(),
  hostnameAliases: z.array(z.string()).default([]),
  agentNameIsHostname: z.boolean().default(false),
  acknowledgedOwners: z.array(z.object({
    host: z.string(),
    ownerKind: z.enum(['repo', 'org']),
    ownerSlug: z.string(),
  })).default([]),
  trustedHosts: z.array(z.string()).default(['github.com']),
  notes: z.string().optional(),
}).strict();

// ─────────────────────────────────────────────────────────────────────────
// parseRunnerConfig — validates a `.runner` JSON shape into a RunnerInstall
// (minus `supervision`, which only `probeSupervision` in runner-probe.mjs
// can fill in) or the `error` variant. Never destructures optimistically.
// ─────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} RunnerInstallError
 * @property {string|null} root
 * @property {{code:'NOT_CONFIGURED'|'UNREADABLE'|'MALFORMED', detail:string}} error
 */

function reduceServerUrlToHost(serverUrl) {
  if (typeof serverUrl !== 'string' || !serverUrl.trim()) return null;
  try {
    return new URL(serverUrl.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * @param {unknown} rawContent - the raw text content of a `.runner` file
 * @param {{root?: string|null, configuredAt?: string|null}} [context] -
 *   facts the (impure) caller already gathered from the filesystem;
 *   echoed through untouched.
 * @returns {object|RunnerInstallError} a partial RunnerInstall (see
 *   module docstring / plan §3) with `supervision: null`, or the error
 *   variant on any unrecognised shape.
 */
export function parseRunnerConfig(rawContent, context = {}) {
  const { root = null, configuredAt = null } = context;

  if (typeof rawContent !== 'string') {
    return { root, error: { code: 'MALFORMED', detail: 'no .runner content supplied' } };
  }

  // The real actions/runner installer writes `.runner` as UTF-8 WITH a BOM
  // on Windows (verified against a live install) — JSON.parse has no BOM
  // tolerance, so every genuine Windows install failed to parse until this
  // strip. Only the BOM codepoint itself; never a wider trim that could mask
  // other leading-whitespace corruption.
  const content = rawContent.charCodeAt(0) === 0xFEFF ? rawContent.slice(1) : rawContent;

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return { root, error: { code: 'MALFORMED', detail: `not valid JSON: ${err.message}` } };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { root, error: { code: 'MALFORMED', detail: 'not a JSON object' } };
  }

  const { agentId, agentName, gitHubUrl, workFolder, serverUrl } = parsed;
  if (!Number.isInteger(agentId) || typeof agentName !== 'string' || !agentName
    || typeof gitHubUrl !== 'string' || !gitHubUrl) {
    return {
      root,
      error: { code: 'MALFORMED', detail: 'missing or wrongly-typed required field (agentId, agentName, gitHubUrl)' },
    };
  }

  const owner = parseOwnerFromGitHubUrl(gitHubUrl);
  if (!owner) {
    return {
      root,
      error: { code: 'MALFORMED', detail: `gitHubUrl is not a recognisable owner/repo URL: ${JSON.stringify(gitHubUrl).slice(0, 120)}` },
    };
  }

  return {
    root,
    owner,
    groupKey: ownerGroupKey(owner),
    agentId,
    agentName,
    workFolder: typeof workFolder === 'string' ? workFolder : null,
    // D8 — reduced to host only; the rest of serverUrl is an opaque
    // capability-bearing path segment that must never reach stdout/logs.
    serverHost: reduceServerUrlToHost(serverUrl),
    supervision: null,
    configuredAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// assessRunnerHealth — GitHub is the only health oracle (D3/D4).
// ─────────────────────────────────────────────────────────────────────────

/**
 * @param {{status:string, row?:object}|null|undefined} remoteResult - a
 *   `RemoteResult` from `runner-probe.mjs::fetchRemoteRunner`
 * @returns {'online-idle'|'online-busy'|'wedged'|'offline'|'not-registered'|'unknown'}
 */
export function assessRunnerHealth(remoteResult) {
  if (!remoteResult || typeof remoteResult !== 'object') return 'unknown';
  const { status } = remoteResult;
  if (status === 'available') {
    const row = remoteResult.row || {};
    if (row.status === 'online') return row.busy ? 'online-busy' : 'online-idle';
    if (row.status === 'offline') return row.busy ? 'wedged' : 'offline';
    return 'unknown'; // an unrecognised row shape — never claim healthy on a guess
  }
  if (status === 'not-registered') return 'not-registered';
  // unavailable | forbidden | malformed-response | untrusted-host | anything
  // else unrecognised — D4: never rendered as healthy.
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────
// assessRunnerIdentity — the closed, advisory finding set (never gates).
// ─────────────────────────────────────────────────────────────────────────

/**
 * The closed finding-id catalog. A new honesty check is one row here plus
 * one test (§6 Sustainability Notes) — mirrors `quickfix-patterns.mjs`'s
 * `{name, severity}` shape.
 */
export const RUNNER_IDENTITY_FINDINGS = Object.freeze([
  { id: 'host-name-mismatch', severity: 'medium' },
  { id: 'supervision-mismatch', severity: 'high' },
  { id: 'foreign-owner', severity: 'high' },
  { id: 'undeclared-install', severity: 'low' },
]);

const FINDING_SEVERITY = Object.fromEntries(RUNNER_IDENTITY_FINDINGS.map((f) => [f.id, f.severity]));

/** Any `[a-z0-9]` run of >=2 labels joined by `-`/`.`, case-folded (R2 M3). */
const HOST_CANDIDATE_TOKEN_RE = /[a-z0-9]+(?:[-.][a-z0-9]+)+/g;

function candidateHostTokens(agentName) {
  const folded = String(agentName || '').toLowerCase();
  const matches = folded.match(HOST_CANDIDATE_TOKEN_RE);
  return matches ? Array.from(new Set(matches)) : [];
}

function allowedHostnameForms({ hostname, expectedHostname, hostnameAliases }) {
  const forms = new Set();
  const foldedHost = String(hostname || '').toLowerCase();
  if (foldedHost) {
    forms.add(foldedHost);
    const firstLabel = foldedHost.split('.')[0];
    if (firstLabel) forms.add(firstLabel);
  }
  if (expectedHostname) forms.add(String(expectedHostname).toLowerCase());
  for (const alias of (hostnameAliases || [])) forms.add(String(alias).toLowerCase());
  return forms;
}

/**
 * host-name-mismatch fires when a candidate token in `agentName` matches
 * NEITHER this machine's own hostname (full or first-label form) NOR any
 * declared alias — i.e. the token asserts some other, undeclared host.
 */
function hostNameMismatchFires(agentName, ctx) {
  const tokens = candidateHostTokens(agentName);
  if (tokens.length === 0) return false;
  const allowed = allowedHostnameForms(ctx);
  return tokens.some((t) => !allowed.has(t));
}

function supervisionMismatchFires(supervision) {
  if (!supervision) return false;
  if (supervision.serviceState === 'not-registered') return true;
  if (supervision.serviceState === 'registered'
    && Array.isArray(supervision.unsupervisedForegroundPids)
    && supervision.unsupervisedForegroundPids.length > 0) {
    return true;
  }
  return false;
}

function foreignOwnerFires(install, { config, currentRepoOwners }) {
  if (!currentRepoOwners || currentRepoOwners.status !== 'available') return false;
  const owners = currentRepoOwners.owners || [];
  const matches = owners.some((repoOwner) => (
    install.owner.ownerKind === 'repo'
      ? ownerIdentityEquals(install.owner, repoOwner)
      : ownerCoversRepo(install.owner, repoOwner)
  ));
  if (matches) return false;
  const acknowledged = ((config && config.acknowledgedOwners) || []).some((a) => ownerIdentityEquals(
    install.owner,
    { host: a.host, ownerKind: a.ownerKind, ownerSlug: a.ownerSlug },
  ));
  return !acknowledged;
}

/**
 * `install.source` is attached by `runner-probe.mjs::discoverInstalls`
 * (mirroring the `candidates[].source` tag it already computes) — 'built-in'
 * means the tool found it via its own guessed default location, never
 * something the operator declared via `extraRoots`.
 */
function undeclaredInstallFires(install) {
  return install.source === 'built-in';
}

/**
 * @param {object} install - a RunnerInstall (must carry `.owner`, `.agentName`,
 *   `.supervision`, and — when produced by discovery — `.source`)
 * @param {{hostname?: string|null, config?: object, currentRepoOwners?: object|null}} [context]
 * @returns {Array<{id:string, severity:string, detail:string, remedy:string|null}>}
 */
export function assessRunnerIdentity(install, context = {}) {
  const { hostname = null, config = {}, currentRepoOwners = null } = context;
  const cfg = config || {};
  const findings = [];

  if (cfg.agentNameIsHostname === true && hostNameMismatchFires(install.agentName, {
    hostname, expectedHostname: cfg.expectedHostname, hostnameAliases: cfg.hostnameAliases,
  })) {
    findings.push({
      id: 'host-name-mismatch',
      severity: FINDING_SEVERITY['host-name-mismatch'],
      detail: `agentName "${install.agentName}" contains a host-shaped token that does not match this machine (${hostname || 'unknown'}) or any declared alias.`,
      remedy: 'If this runner is intentionally named after a different machine, ignore this. Otherwise add the correct name to expectedHostname/hostnameAliases in runner-hosts.local.json, or rename the runner.',
    });
  }

  if (supervisionMismatchFires(install.supervision)) {
    const svc = install.supervision || {};
    findings.push({
      id: 'supervision-mismatch',
      severity: FINDING_SEVERITY['supervision-mismatch'],
      detail: svc.serviceState === 'not-registered'
        ? `a service (${svc.declaredServiceName || 'unknown'}) is declared in .service but is not registered with the OS.`
        : `serviceState is 'registered', but ${(svc.unsupervisedForegroundPids || []).length} Runner.Listener process(es) are running outside that service's supervision.`,
      remedy: svc.serviceState === 'not-registered'
        ? 'Reinstall the service (svc install / svc start), or remove the stale .service declaration if this runner is no longer supervised.'
        : 'Stop the unsupervised Runner.Listener process(es) and let the registered service manage the runner, or investigate why a second listener is running.',
    });
  }

  if (foreignOwnerFires(install, { config: cfg, currentRepoOwners })) {
    findings.push({
      id: 'foreign-owner',
      severity: FINDING_SEVERITY['foreign-owner'],
      detail: `this runner is registered to ${install.owner.display} (${install.owner.ownerKind}), which does not match this repo's configured git remote(s).`,
      remedy: 'If this is an intentionally shared/corporate runner, add it to acknowledgedOwners in runner-hosts.local.json to silence this.',
    });
  }

  if (undeclaredInstallFires(install)) {
    findings.push({
      id: 'undeclared-install',
      severity: FINDING_SEVERITY['undeclared-install'],
      detail: `install root ${install.root} was found at a built-in default location, not one declared in extraRoots.`,
      remedy: null,
    });
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────
// summariseInventory — the command-result envelope (§3), rollup precedence,
// absent-vs-error distinction. Internally invokes assessRunnerHealth /
// assessRunnerIdentity per install so the caller only has to gather raw
// facts (RunnerInstall + attached `remoteStatus`), never re-merge verdicts.
// ─────────────────────────────────────────────────────────────────────────

const HEALTHY_VERDICTS = new Set(['online-idle', 'online-busy']);
const UNHEALTHY_VERDICTS = new Set(['wedged', 'offline', 'not-registered']);

/**
 * @param {{
 *   installs?: Array<object & {remoteStatus: object}>,
 *   candidates?: Array<{root:string, source:string, state:'absent'|'discovered'|'error', error:object|null}>,
 *   notProbed?: {wsl:boolean, reason:string|null},
 *   identityContext?: {hostname?:string|null, config?:object, currentRepoOwners?:object|null},
 * }} [input]
 */
export function summariseInventory(input = {}) {
  const {
    installs = [],
    candidates = [],
    notProbed = { wsl: false, reason: null },
    identityContext = {},
  } = input;

  const enriched = installs.map((inst) => ({
    ...inst,
    healthVerdict: assessRunnerHealth(inst.remoteStatus),
    identityFindings: assessRunnerIdentity(inst, identityContext),
  }));

  let healthy = 0;
  let unhealthy = 0;
  let unknownHealth = 0;
  let advisoryFindings = 0;
  for (const inst of enriched) {
    if (HEALTHY_VERDICTS.has(inst.healthVerdict)) healthy += 1;
    else if (UNHEALTHY_VERDICTS.has(inst.healthVerdict)) unhealthy += 1;
    else unknownHealth += 1; // 'unknown'
    advisoryFindings += inst.identityFindings.length;
  }

  // R3 H3 — only a present-but-broken candidate counts; an absent default
  // root is the ordinary case and contributes nothing here.
  const installErrors = candidates.filter((c) => c.state === 'error').length;

  let rollup;
  if (installErrors > 0) rollup = 'partial-error';
  else if (unhealthy > 0) rollup = 'unhealthy';
  else if (unknownHealth > 0) rollup = 'unknown';
  else if (advisoryFindings > 0) rollup = 'advisory';
  else rollup = 'clean';

  return {
    ok: true,
    schemaVersion: 1,
    installs: enriched,
    candidates,
    notProbed,
    rollup,
    summary: {
      totalInstalls: enriched.length,
      healthy,
      unhealthy,
      unknownHealth,
      advisoryFindings,
      installErrors,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// quoteForShell (R3 M1) — structured removal-instruction quoting.
// ─────────────────────────────────────────────────────────────────────────

/**
 * @param {unknown} value
 * @param {'posix'|'windows'} dialect
 * @returns {string}
 */
export function quoteForShell(value, dialect) {
  const s = String(value ?? '');
  if (dialect === 'posix') {
    // Single-quote wrap; an embedded `'` becomes `'\''` (close, escaped
    // literal quote, reopen) — the standard POSIX-shell-safe idiom.
    return `'${s.replace(/'/g, "'\\''")}'`;
  }
  if (dialect === 'windows') {
    // Double-quote wrap; an embedded `"` is doubled — cmd.exe/PowerShell-safe
    // for a single token.
    return `"${s.replace(/"/g, '""')}"`;
  }
  throw new TypeError(`quoteForShell: unknown dialect ${JSON.stringify(dialect)} (expected 'posix' or 'windows')`);
}

/** Test-only: internal helpers, mirroring runner-fallback.mjs's `_internals` pattern. */
export const _internals = {
  buildOwnerIdentity,
  normaliseHostForCodec,
  segmentsFromPath,
  reduceServerUrlToHost,
  candidateHostTokens,
  allowedHostnameForms,
  hostNameMismatchFires,
  supervisionMismatchFires,
  foreignOwnerFires,
  undeclaredInstallFires,
};
