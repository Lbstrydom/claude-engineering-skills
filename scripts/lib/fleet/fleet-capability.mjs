/**
 * @fileoverview What a repo's OWN fleet CLI accepts (docs/plans/fleet-handover-winddown.md §2.5).
 *
 * A consumer's synced fleet can be older than this one: ai-organiser's predated `touch --unwait`, so the recipe receive
 * printed was refused there. The honest oracle is the target's own flag table (`VERBS` in the `argv.mjs` its CLI loads,
 * the very table `assertKnownFlags` refuses against), asked by importing it in a child process, never a version guess or
 * a hand-kept "added in bundle X" list.
 *
 * Three answers, kept apart: `true` / `false` mean the table LOADED and does / does not list the verb (and flag); a verb
 * absent from a loaded table is `false`, since the table IS the refusal list. `'unknown'` means it could not be read
 * (missing file, failed import, no `VERBS` export, timeout).
 *
 * @module scripts/lib/fleet/fleet-capability
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CAPABILITY_TIMEOUT_MS = 10_000;

// Runs in the child: argv[1] = argv.mjs URL, argv[2] = verb. Prints {listed, flags} or exits non-zero.
const PROBE = [
  'const m = await import(process.argv[1]);',
  'if (!m.VERBS || typeof m.VERBS !== "object") process.exit(3);',
  'const v = m.VERBS[process.argv[2]];',
  'process.stdout.write(JSON.stringify({ listed: Boolean(v), flags: v ? [...(v.bool ?? []), ...(v.value ?? []), ...(v.repeat ?? [])] : [] }));',
].join('\n');

/**
 * The argv table a repo's CLI loads, derived from the CLI invocation `fleetCliFor` returns (`node scripts/fleet.mjs` or
 * `node scripts/.claude-skills/fleet.mjs`): the script's own directory, then `lib/fleet/argv.mjs`.
 */
export function argvModuleFor(repo, cli) {
  const script = String(cli).trim().split(/\s+/)[1];
  if (!script) return null;
  return path.join(path.resolve(repo, path.dirname(script)), 'lib', 'fleet', 'argv.mjs');
}

const cache = new Map();

/**
 * Does the fleet CLI at `cli` in `repo` accept `verb` (and `flag`, when given)?
 * Memoised per (table, verb); `spawn` is injectable for tests.
 * @returns {true | false | 'unknown'}
 */
export function fleetSupports(repo, cli, verb, flag = null, { spawn = spawnSync } = {}) {
  const file = argvModuleFor(repo, cli);
  if (!file) return 'unknown';
  const key = `${file}\0${verb}`;
  let probed = cache.get(key);
  if (!probed) {
    const r = spawn(process.execPath, ['--input-type=module', '-e', PROBE, pathToFileURL(file).href, verb], { encoding: 'utf8', timeout: CAPABILITY_TIMEOUT_MS, windowsHide: true });
    try { probed = r.status === 0 ? JSON.parse(r.stdout) : { unknown: true }; } catch { probed = { unknown: true }; }
    // A verdict from an injected runner is not remembered: tests would otherwise leak answers into each other.
    if (spawn === spawnSync) cache.set(key, probed);
  }
  if (probed.unknown) return 'unknown';
  if (!probed.listed) return false;
  return flag === null ? true : probed.flags.includes(flag);
}

/** Test seam: forget every remembered answer. */
export const _resetCapabilityCache = () => cache.clear();
