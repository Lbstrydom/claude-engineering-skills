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

  // ── DB-group provenance: three states, not two ───────────────────────────
  //
  // The shared layer contributes NONE of the DB-group keys when a higher layer
  // has already decided the question — and there are TWO ways it can have:
  //
  //  - `higherHasDsn` — a real DSN. Normalised the same way `resolveDbUrl` reads
  //    it back, `(x || '').trim()`, so the guard and the reader agree.
  //  - `dsnExplicitlyEmpty` — a DSN key that is PRESENT and blank. In this
  //    codebase that is not an accident and not an absence: it is the air-gap
  //    signal. `tests/helpers/air-gap.mjs::airGapDbUrl()` sets both DSN keys to
  //    `''` precisely so a suite "must never resolve to a real database", and 20
  //    test files use that idiom. Letting the shared `~/.audit-loop.env` fill an
  //    explicitly-blanked DSN would point those suites — including ones that
  //    `DROP SCHEMA public CASCADE` — at whatever store the developer's machine
  //    happens to name.
  //
  // Both suppress the WHOLE DB group. Suppressing only the DSN was the old
  // incoherence: with an empty DSN the guard said "no higher-layer DSN, so
  // contribute the DB group", handed over a shared `AUDIT_DB_SSL_MODE`, and then
  // declined the DSN itself — half a bundle, from a layer that was supposed to
  // give all of it or none.
  //
  // WHY NOT FLIP THE PRECEDENCE (consumer report, 2026-09-04). The report asked
  // for the opposite: treat empty as absent so the shared file wins. Its
  // motivating case is real — `env: AUDIT_DB_URL: ${{ secrets.AUDIT_DB_URL }}`
  // with a secret that does not exist expands to empty-but-SET, so every
  // `arch:*` script ran cloud-blind and `arch:drift` printed GREEN, score 0, 0
  // duplication pairs for a repo that had measured 14 an hour earlier. But the
  // two requirements are the same literal state and cannot both hold, and the
  // one that loses here would silently re-point destructive test suites at a
  // production database. So the state is preserved and made LOUD instead: the
  // notice below names it and gives the remedy, and the drift report now prints
  // the store it read, which is what makes the CI case self-diagnosing.
  const dsnExplicitlyEmpty = DSN_GROUP_KEYS.some(
    (k) => process.env[k] !== undefined && (process.env[k] || '').trim() === '',
  );
  const higherHasDsn = DSN_GROUP_KEYS.some((k) => (process.env[k] || '').trim() !== '');
  const skipDbGroup = higherHasDsn || dsnExplicitlyEmpty;

  // What the shared layer actually CONTRIBUTED, not merely which NAMES are new.
  // This used to be a before/after diff of `Object.keys(process.env)`, which
  // cannot report a key it filled that was already present — so a notice meant
  // to tell an operator what the shared file did was blind to one of its cases.
  const contributed = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (skipDbGroup && DB_GROUP_KEYS.has(k)) continue;
    if (process.env[k] === undefined) { process.env[k] = v; contributed.push(k); } // override:false
  }

  // THE STATE THAT COST THREE CI DISPATCHES, SAID OUT LOUD. Two conditions keep
  // it from becoming noise, and noise is how a real warning gets ignored:
  // only when the shared file actually had a DSN to offer (otherwise every
  // air-gapped test run pays for a notice about a decision that changed
  // nothing), and only once per process TREE — a child inheriting this env made
  // the same decision for the same reason, so it rides the same sentinel as the
  // `(sets: …)` line below, which is set after both.
  if (
    dsnExplicitlyEmpty && !higherHasDsn
    && process.env._AUDIT_LOOP_SHARED_LOADED !== '1'
    && DSN_GROUP_KEYS.some((k) => (parsed[k] || '').trim() !== '')
  ) {
    process.stderr.write(
      '  [config] a DSN env var is set but EMPTY — reading that as "cloud off", so the DSN in ~/.audit-loop.env '
      + 'is NOT used. To use the shared one, UNSET the variable rather than setting it to "" (a GitHub Actions '
      + '`env:` entry for a missing secret expands to empty-but-set). To disable the shared layer outright: '
      + 'AUDIT_LOOP_DISABLE_SHARED=1.\n',
    );
    // SET the sentinel it just READ. Checking a dedup marker without setting it
    // makes the dedup one-directional: this process suppresses a parent's
    // notice but never suppresses its own in a child. The `(sets: …)` line
    // below sets it too, which HID this — in the common case the shared file
    // also carries non-DB keys, so that branch fires and the marker lands
    // anyway. A shared file holding ONLY DB-group keys contributes nothing,
    // leaves the marker unset, and every child in the tree re-warns.
    process.env._AUDIT_LOOP_SHARED_LOADED = '1';
  }

  if (contributed.length > 0 && process.env._AUDIT_LOOP_SHARED_LOADED !== '1') {
    process.stderr.write(
      `  [config] loaded shared cloud config from ~/.audit-loop.env (sets: ${contributed.sort().join(', ')})\n`,
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
