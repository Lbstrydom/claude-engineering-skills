/**
 * @fileoverview Single source of truth for environment-variable layering.
 *
 * Extracted from config.mjs's former module-load side-effect so the SAME
 * loader can be called BOTH at config.mjs load (unchanged behaviour for
 * everything that imports config) AND at the one place that actually reads the
 * DSN — `db/client.mjs::resolveDbUrl()`. Putting it at the reader guarantees a
 * cloud-capable CLI sees the shared DSN regardless of which entrypoint ran,
 * instead of depending on something having imported config.mjs first (the
 * "shared-env loaded only as an incidental import side-effect" bug class).
 *
 * Two ordered layers (precedence: shell env > cwd/git-root `.env` > shared):
 *   1. cwd/git-root `.env` (dotenv default `override:false` → shell wins).
 *   2. per-user shared `~/.audit-loop.env` (`override:false` → cwd/shell win),
 *      gated by `AUDIT_LOOP_DISABLE_SHARED=1`.
 *
 * DB config is treated as ONE logical bundle keyed by DSN provenance: if a
 * higher-precedence layer supplied a DSN (either spelling), the shared layer
 * contributes NONE of the DB-group keys — so a cwd-local DSN can never be
 * paired with a shared/cloud SSL mode (the cross-key precedence hole). The read
 * is non-throwing: a malformed/unreadable shared file degrades to "no shared
 * layer", never crashes the DB-resolution chokepoint.
 *
 * @module scripts/lib/load-shared-env
 */

import fs from 'node:fs';
import dotenv from 'dotenv';
import {
  discoverLocalEnvPath, sharedEnvPath,
  DB_GROUP_KEYS as DB_GROUP_KEY_LIST, DSN_GROUP_KEYS,
} from './shared-cloud-config.mjs';

// The DB group = every var db/client.mjs consumes (single source of truth in
// shared-cloud-config.mjs). Treated as one bundle so SSL/pool can't attach to a
// different layer's DSN. `DSN_GROUP_KEYS` is the URL subset resolveDbUrl reads.
const DB_GROUP_KEYS = new Set(DB_GROUP_KEY_LIST);

let _cwdLoaded = false;   // cwd layer: one read per process
let _loaded = false;      // shared layer: latched after first attempt (G2)
let _readWarned = false;  // warn-once on an unreadable/malformed shared file

function loadCwdLayer() {
  if (_cwdLoaded) return;
  _cwdLoaded = true;
  // Mirror config.mjs's discoverDotenv: resolve + pin DOTENV_CONFIG_PATH once,
  // then load it. dotenv's default is override:false → shell env wins.
  if (!process.env.DOTENV_CONFIG_PATH) {
    const found = discoverLocalEnvPath();
    if (found) process.env.DOTENV_CONFIG_PATH = found;
  }
  dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env', quiet: true });
}

/**
 * Read + parse the shared file WITHOUT throwing — this runs on the
 * DB-resolution chokepoint, so a bad file must degrade gracefully. No
 * `existsSync` (avoids the TOCTOU anti-pattern + halves FS I/O): read directly,
 * treat ENOENT as absent.
 *
 * @param {string} p
 * @returns {{ status: 'loaded'|'absent'|'error', parsed: Record<string,string> }}
 */
function readSharedFile(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { status: 'absent', parsed: {} };
    if (!_readWarned) {
      _readWarned = true;
      // Never echo the value/path body — just the error class.
      process.stderr.write(
        `  [config] shared cloud config unreadable (${err?.code || 'read error'}) — skipping shared layer\n`,
      );
    }
    return { status: 'error', parsed: {} };
  }
  try {
    return { status: 'loaded', parsed: dotenv.parse(raw) };
  } catch {
    if (!_readWarned) {
      _readWarned = true;
      process.stderr.write('  [config] shared cloud config unparseable — skipping shared layer\n');
    }
    return { status: 'error', parsed: {} };
  }
}

/**
 * Load env layers idempotently. Safe to call from any entrypoint, any number
 * of times. `getPool()` calls it on first init (then the pool is cached), so
 * steady-state cost is zero.
 *
 * @param {{ includeCwd?: boolean, force?: boolean }} [opts]
 *   `includeCwd` (default true) loads the cwd/git-root `.env` layer first.
 *   The DB-URL reader (`resolveDbUrl`) passes `false`: every real CLI entrypoint
 *   already loads cwd `.env` (via `import 'dotenv/config'` or config.mjs) before
 *   `getPool` runs, and the bug being fixed was ONLY the missing shared layer —
 *   so the reader just adds the shared layer (with the DB-group guard reading
 *   whatever the entrypoint already put in `process.env`). Re-loading cwd `.env`
 *   at the reader would also wrongly pull a repo's `.env` into in-process unit
 *   tests. config.mjs calls with the default `true` to preserve its full
 *   module-load layering.
 *   `force` re-runs the shared layer (tests).
 */
export function loadSharedEnv(opts = {}) {
  if (opts.includeCwd !== false) loadCwdLayer();

  // Hermeticity escape hatch — checked before the latch (cheap, no FS) so it
  // never sets `_loaded`.
  if (process.env.AUDIT_LOOP_DISABLE_SHARED === '1') return;

  if (_loaded && !opts.force) return;

  const { status, parsed } = readSharedFile(sharedEnvPath());
  // Latch unconditionally after the first shared-layer attempt (loaded /
  // absent / error) — exactly one shared-file FS interaction per process, no
  // redundant reads on local-only runs, and no contradiction with
  // "same-process reload is out of scope".
  _loaded = true;
  if (status !== 'loaded') return;

  // DB-group provenance guard: a higher layer's DSN means the shared layer
  // contributes none of the DB-group keys.
  // Normalize the DSN-presence check the SAME way resolveDbUrl does — `(x ||
  // '').trim()` — so an empty/whitespace DSN (a deliberate "disable cloud"
  // override) counts as ABSENT, not as a higher-layer DSN. Raw truthiness would
  // disagree with the reader on the empty-string case.
  const higherHasDsn = DSN_GROUP_KEYS.some((k) => (process.env[k] || '').trim() !== '');
  const before = new Set(Object.keys(process.env));
  for (const [k, v] of Object.entries(parsed)) {
    if (higherHasDsn && DB_GROUP_KEYS.has(k)) continue;
    if (process.env[k] === undefined) process.env[k] = v; // override:false semantics
  }

  const added = Object.keys(process.env).filter((k) => !before.has(k));
  if (added.length > 0 && process.env._AUDIT_LOOP_SHARED_LOADED !== '1') {
    process.stderr.write(
      `  [config] loaded shared cloud config from ~/.audit-loop.env (sets: ${added.join(', ')})\n`,
    );
    // Sentinel propagates to spawned subprocesses (env inherits) so children
    // don't re-log the same notice.
    process.env._AUDIT_LOOP_SHARED_LOADED = '1';
  }
}

/** For tests — reset both latches + the dedupe sentinel. */
export function _resetSharedEnvForTest() {
  _cwdLoaded = false;
  _loaded = false;
  _readWarned = false;
  delete process.env._AUDIT_LOOP_SHARED_LOADED;
}
