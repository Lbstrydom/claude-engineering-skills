/**
 * @fileoverview The one parser for `sync-to-repos.mjs`'s command line.
 *
 * Why this exists (debt 7798d3cef2ea, 2e26f79ebd92; plan
 * docs/plans/sync-to-repos-debt-cluster.md §2 A): the CLI read its flags with
 * `process.argv.includes` / `indexOf(flag) + 1`, which disagreed with
 * `assertKnownFlags` (validates NAMES only, accepts `--flag=value`, stops at
 * `--`). Three consequences, all on a command that WRITES INTO OTHER REPOS:
 *   - `--target` with no value, an empty value, or a flag-shaped value read as
 *     "absent" and synced EVERY registered consumer;
 *   - `--target=wine` passed validation and was then not found by `indexOf`,
 *     also syncing every consumer;
 *   - `--dry-run=true` passed validation and `includes('--dry-run')` was false,
 *     so it ran a REAL sync.
 * Here a flag that is present WITHOUT a usable value is an error, never an
 * absent flag.
 *
 * Input contract: the CALLER passes argv WITHOUT the node and script paths —
 * the region `assertKnownFlags` reads (`from = 2`) — so neither is ever a
 * positional.
 *
 * (Worded to avoid the literal spelling of a process-argv read: `check-cli-flags`
 * classifies a file by RAW source, and this pure library has no argv of its own.) `--` ends flags; the command takes no
 * positionals, so any token after it is an error rather than silently discarded.
 *
 * @module scripts/lib/sync-argv
 */

/** Presence-only flags. `--flag=<anything>` is an error. */
export const BOOLEAN_FLAGS = Object.freeze([
  '--dry-run', '--no-prompt', '--adopt-orphans', '--overwrite-diverged',
  '--allow-rollback', '--allow-stale-base', '--quiet-legacy-check',
]);

/** Flags that take exactly one value. */
export const VALUE_FLAGS = Object.freeze(['--target', '--target-path']);

/** Every flag this CLI reads — the list handed to `assertKnownFlags`. */
export const KNOWN_FLAGS = Object.freeze([...BOOLEAN_FLAGS, ...VALUE_FLAGS]);

const FLAG_KEY = Object.freeze({
  '--dry-run': 'dryRun',
  '--no-prompt': 'noPrompt',
  '--adopt-orphans': 'adoptOrphans',
  '--overwrite-diverged': 'overwriteDiverged',
  '--allow-rollback': 'allowRollback',
  '--allow-stale-base': 'allowStaleBase',
  '--quiet-legacy-check': 'quietLegacyCheck',
});

/**
 * Parse the sync CLI's arguments. PURE; never throws.
 *
 * @param {readonly string[]} args  argv without the node and script paths
 * @returns {{
 *   flags: {dryRun: boolean, noPrompt: boolean, adoptOrphans: boolean,
 *           overwriteDiverged: boolean, allowRollback: boolean,
 *           allowStaleBase: boolean, quietLegacyCheck: boolean},
 *   target: string|null, targetPath: string|null, errors: string[]
 * }}
 */
export function parseSyncArgv(args) {
  const flags = Object.fromEntries(Object.values(FLAG_KEY).map((k) => [k, false]));
  const values = { '--target': null, '--target-path': null };
  const errors = [];
  const list = Array.isArray(args) ? args : [];

  for (let i = 0; i < list.length; i++) {
    const tok = list[i];
    if (tok === '--') {
      // POSIX: `--` ends flags. This command takes NO positionals, so anything after it can only be a
      // mistake, and silently discarding `-- --dry-run` would turn a safety flag into a REAL sync of
      // every consumer (code-audit R1 H11/H18/H19).
      if (i + 1 < list.length) errors.push(`unexpected argument(s) after "--": ${list.slice(i + 1).map((t) => JSON.stringify(t)).join(' ')} — this command takes flags only`);
      break;
    }
    if (typeof tok !== 'string' || !tok.startsWith('--')) {
      errors.push(`unexpected argument ${JSON.stringify(tok)} — this command takes flags only`);
      continue;
    }
    const eq = tok.indexOf('=');
    const name = eq === -1 ? tok : tok.slice(0, eq);
    const inline = eq === -1 ? undefined : tok.slice(eq + 1);

    if (Object.hasOwn(FLAG_KEY, name)) {
      if (inline !== undefined) {
        errors.push(`${name} takes no value (got ${JSON.stringify(tok)}) — it is a switch; an ignored "=${inline}" would silently change what runs`);
      } else flags[FLAG_KEY[name]] = true;
      continue;
    }
    if (VALUE_FLAGS.includes(name)) {
      let value = inline;
      if (inline === undefined) {
        const next = list[i + 1];
        if (typeof next === 'string' && next !== '' && !next.startsWith('--')) { value = next; i++; }
      }
      if (value === undefined || value === '' || value.startsWith('--')) {
        errors.push(`${name} requires a value`);
      } else if (values[name] !== null) {
        errors.push(`${name} given more than once — which one wins is ambiguous on a command that writes into other repos`);
      } else values[name] = value;
      continue;
    }
    // An unknown flag is `assertKnownFlags`'s to name; the parser ignores it
    // rather than guess, so there is one voice for "unknown flag".
  }

  if (values['--target'] !== null && values['--target-path'] !== null) {
    errors.push('--target and --target-path are mutually exclusive');
  }
  return { flags, target: values['--target'], targetPath: values['--target-path'], errors };
}

/**
 * The one decision "which consumers does this run touch?". PURE.
 *
 * A parse error never reaches here (the caller aborts first), but the guard is
 * kept so a future caller cannot fall through to "all".
 *
 * @param {{target: string|null, targetPath: string|null, errors: string[]}} parsed
 * @param {ReadonlyArray<{name: string, alias: string}>} repos
 * @returns {{mode: 'all'|'registered'|'path', repos: Array<object>}|{error: string}}
 */
export function selectTargets(parsed, repos) {
  if (parsed.errors.length) return { error: parsed.errors.join('; ') };
  if (parsed.targetPath !== null) return { mode: 'path', repos: [] };
  if (parsed.target === null) return { mode: 'all', repos: [...repos] };
  const picked = repos.filter((r) => r.name === parsed.target || r.alias === parsed.target);
  if (picked.length === 0) return { error: `Unknown target: "${parsed.target}"` };
  return { mode: 'registered', repos: picked };
}
