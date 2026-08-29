/**
 * @fileoverview Pinned-dependency invariant for co-owned JSON configs the sync
 * merges into consumers.
 *
 * ## The incident
 *
 * This source repo's `.vscode/mcp.json` launches its MCP servers with
 * `npx -y @playwright/mcp@latest` — correct here, and correct for a consumer
 * that has not installed those packages. A consumer (`storyline`, upstream
 * report `5b1a121e`) had deliberately re-pointed both servers at
 * `${workspaceFolder}/node_modules/…` to satisfy its own supply-chain pinning
 * gate. `deepMerge` gives a source LEAF authority at its path and replaces
 * arrays wholesale, so every sync moved that consumer from pinned local paths
 * back to an UNPINNED NETWORK FETCH, silently.
 *
 * That direction is not a matter of the sync's opinion about the file. Moving a
 * repo from pinned to floating fetching is a supply-chain regression whichever
 * side is "right" about the rest of the config, so it is excluded by
 * construction rather than by a per-file exception:
 *
 *   - `guardPinDowngrades` restores the consumer's spec for any server the
 *     merge would have un-pinned, and
 *   - `assertNoPinDowngrade` re-derives the same question from the FINAL
 *     outbound bytes, so a future refactor that routes around the guard fails
 *     the write instead of shipping the regression.
 *
 * Guard + independent post-condition, not guard alone: a check that shares its
 * only implementation with the thing it checks proves nothing.
 *
 * ## Scope, deliberately narrow
 *
 * Only objects under a `servers` / `mcpServers` key, and only the
 * pinned→unpinned DIRECTION. Unpinned→pinned is a consumer improvement and
 * upstream has no business reverting it either, but that never happens on this
 * path (upstream's value is the unpinned one); asserting on a case that cannot
 * arise would be an invariant nobody could ever see fail.
 *
 * @module scripts/lib/sync-pin-guard
 */

/** Keys whose value is a map of server-name → launch spec. */
const SERVER_MAP_KEYS = ['servers', 'mcpServers'];

/** Commands that fetch-and-run rather than execute something already on disk. */
const FETCHER_COMMANDS = new Set([
  'npx', 'npx.cmd', 'bunx', 'bunx.cmd', 'pnpx', 'pnpx.cmd', 'uvx', 'uvx.cmd', 'dlx',
]);

/** `<pkgmgr> <subcommand>` pairs that fetch-and-run. */
const FETCHER_SUBCOMMANDS = new Map([
  ['npm', new Set(['exec', 'x'])],
  ['pnpm', new Set(['dlx', 'exec'])],
  ['yarn', new Set(['dlx'])],
  ['bun', new Set(['x'])],
  ['uv', new Set(['tool', 'run'])],
]);

/** A version specifier that can resolve to different bytes on two days. */
const FLOATING_SPEC = /@(?:latest|next|canary|beta|\*|\^|~|x\b)/i;

/** Tokens that mean "something already on this filesystem". */
function isPathLike(token) {
  const t = String(token);
  return t.includes('node_modules')
    || t.includes('${workspaceFolder}')
    || t.includes('${workspaceRoot}')
    || t.startsWith('./')
    || t.startsWith('../')
    || t.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(t)
    || t.startsWith('.\\')
    || t.startsWith('..\\');
}

/**
 * Classify one launch spec. PURE.
 *
 * `unknown` is a real answer, not a failure: a spec this cannot read must not be
 * called pinned (that would let a downgrade through) nor unpinned (that would
 * hold a consumer's config hostage to a parser gap). Only a
 * pinned→unpinned transition acts, so `unknown` on either side is inert.
 *
 * @param {unknown} spec
 * @returns {'pinned'|'unpinned'|'unknown'}
 */
export function classifyLaunchSpec(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return 'unknown';
  const command = typeof spec.command === 'string' ? spec.command : null;
  const args = Array.isArray(spec.args) ? spec.args.filter((a) => typeof a === 'string') : [];
  if (!command) return 'unknown';

  const base = command.replace(/\\/g, '/').split('/').pop() || command;
  if (FETCHER_COMMANDS.has(base)) return 'unpinned';
  const subs = FETCHER_SUBCOMMANDS.get(base);
  if (subs && args.length && subs.has(args[0])) return 'unpinned';
  if (args.some((a) => FLOATING_SPEC.test(a))) return 'unpinned';

  if (isPathLike(command) || args.some(isPathLike)) return 'pinned';
  return 'unknown';
}

/**
 * Find every server whose spec would move pinned → unpinned. PURE.
 *
 * @param {unknown} existing — the consumer's current parsed config (or null)
 * @param {unknown} outbound — what we are about to write
 * @returns {Array<{key: string, server: string}>}
 */
export function findPinDowngrades(existing, outbound) {
  const hits = [];
  if (existing === null || typeof existing !== 'object') return hits;
  if (outbound === null || typeof outbound !== 'object') return hits;
  for (const key of SERVER_MAP_KEYS) {
    const before = existing[key];
    const after = outbound[key];
    if (!before || typeof before !== 'object' || Array.isArray(before)) continue;
    if (!after || typeof after !== 'object' || Array.isArray(after)) continue;
    for (const server of Object.keys(after)) {
      if (!Object.hasOwn(before, server)) continue;
      if (classifyLaunchSpec(before[server]) === 'pinned'
        && classifyLaunchSpec(after[server]) === 'unpinned') {
        hits.push({ key, server });
      }
    }
  }
  return hits;
}

/**
 * Restore the consumer's spec for every server the merge would have un-pinned.
 * PURE — returns a new value; neither input is mutated.
 *
 * The whole spec object is restored, not just `command`/`args`: a half-restored
 * launcher (our `args`, their `command`) is a third configuration neither side
 * asked for and neither side tested.
 *
 * @param {unknown} existing
 * @param {unknown} outbound
 * @returns {{value: unknown, held: Array<{key: string, server: string}>}}
 */
export function guardPinDowngrades(existing, outbound) {
  const held = findPinDowngrades(existing, outbound);
  if (!held.length) return { value: outbound, held };
  const next = { ...outbound };
  for (const { key, server } of held) {
    next[key] = { ...next[key], [server]: existing[key][server] };
  }
  return { value: next, held };
}

/**
 * Post-condition: prove the bytes we are about to write contain no
 * pinned→unpinned transition. Throws rather than returning, because a caller
 * that forgot to check the return value is exactly the regression this exists
 * to make impossible.
 *
 * @param {{relPath: string, existing: unknown, outbound: unknown}} input
 * @throws {Error} when a downgrade survived the guard
 */
export function assertNoPinDowngrade({ relPath, existing, outbound }) {
  const remaining = findPinDowngrades(existing, outbound);
  if (remaining.length) {
    const names = remaining.map((h) => `${h.key}.${h.server}`).join(', ');
    throw new Error(
      `refusing to write ${relPath}: it would move ${names} from a pinned local path to an `
      + 'unpinned network fetch. That is a supply-chain regression and this sync cannot perform it.',
    );
  }
}
