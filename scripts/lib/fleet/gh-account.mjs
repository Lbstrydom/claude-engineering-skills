/**
 * @fileoverview Each repo's own gh account (docs/plans/fleet-handover-winddown.md §2.10, proposal 3ca0).
 *
 * Prepare's PR probe asks `gh` as whichever account happens to be signed in. A repo that only another signed-in account can read
 * (storyline needs `louis-strydom_wartsila`) then printed its PR state UNMEASURED. The repo declares the account NAME in its own
 * `.fleet.json` (`ghAccount`); `gh` already holds that account's credential, so nothing secret is stored: the token is read with
 * `gh auth token --user <name>` and handed to the probe's child process in that child's environment only.
 *
 * Every variable gh reads a credential from is set together (`GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`,
 * `GITHUB_ENTERPRISE_TOKEN`), so an inherited credential for ANY host cannot override the declared identity. The token is never
 * printed, written to a manifest, put in argv, or passed to any other process. A repo without `ghAccount` behaves exactly as before.
 * An account that cannot be read FAILS CLOSED: the probe runs with a token that cannot authenticate, so the repo's PR state is
 * UNMEASURED naming the account, never read as another identity's answer.
 *
 * @module scripts/lib/fleet/gh-account
 */
import { spawnSync } from 'node:child_process';

export const GH_AUTH_TIMEOUT_MS = 10_000;

/** What every credential variable is set to when the declared account's token cannot be read: it authenticates as nobody. */
export const UNAVAILABLE_TOKEN = 'fleet-declared-gh-account-unavailable';

/** Every variable gh takes a credential from; they are overridden (or, for the lookup, removed) together. */
export const GH_TOKEN_VARS = Object.freeze(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']);

const cache = new Map();

/**
 * The token for a signed-in gh account, or the reason it cannot be read. Memoised per (account, host, config dir) for the process.
 * The lookup runs in `env` MINUS every credential variable: with one set, `gh auth token` would answer with the ambient credential
 * whatever `--user` says. Host and config selection (`GH_HOST`, `GH_CONFIG_DIR`) are kept, so the lookup reads the store the probe will.
 * @returns {{ok: true, token: string} | {ok: false, reason: string}}
 */
export function ghAccountToken(account, { spawn = spawnSync, ghBin = 'gh', env = process.env } = {}) {
  const key = `${account}\0${env.GH_HOST ?? ''}\0${env.GH_CONFIG_DIR ?? ''}`;
  if (spawn === spawnSync && cache.has(key)) return cache.get(key);
  const lookupEnv = { ...env };
  for (const v of GH_TOKEN_VARS) delete lookupEnv[v];
  const r = spawn(ghBin, ['auth', 'token', '--user', account], { encoding: 'utf8', timeout: GH_AUTH_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: lookupEnv });
  const token = String(r.stdout ?? '').trim();
  const out = r.error ? { ok: false, reason: r.error.code === 'ENOENT' ? 'gh not installed' : `gh could not run (${r.error.code ?? r.error.message})` }
    : r.status !== 0 || !token ? { ok: false, reason: `gh has no signed-in account ${account} (run gh auth login as ${account})` }
      : { ok: true, token };
  if (spawn === spawnSync) cache.set(key, out);
  return out;
}

/**
 * The environment a repo's PR probe runs in. No `ghAccount` declared: `env` itself, untouched. Declared: `env` plus that account's
 * token in every credential variable; if it cannot be read, a token that authenticates as nobody, with `error` carrying the reason.
 * @param {{ghAccount?: string|null}|null|undefined} config
 * @returns {{env: NodeJS.ProcessEnv, account: string|null, error?: string}}
 */
export function ghEnvFor(config, env, deps = {}) {
  const account = config?.ghAccount ?? null;
  if (!account) return { env, account: null };
  const t = ghAccountToken(account, { ...deps, env });
  const value = t.ok ? t.token : UNAVAILABLE_TOKEN;
  const set = Object.fromEntries(GH_TOKEN_VARS.map((v) => [v, value]));
  return t.ok ? { env: { ...env, ...set }, account } : { env: { ...env, ...set }, account, error: t.reason };
}

/** Test seam: forget remembered tokens. */
export const _resetGhAccountCache = () => cache.clear();
