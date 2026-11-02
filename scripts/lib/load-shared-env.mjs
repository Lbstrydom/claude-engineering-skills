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
let _inherited = null;    // process.env as launched, before any layer (first call only)

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
 * Which keys the shared layer contributes on top of `env` — the ONE statement of
 * that rule, used by the runtime loader below and by `composeEnvLayers`, so a
 * doctor's account of the environment cannot drift from what the runtime does.
 * `override:false`, and the DB group as one bundle (see the provenance comment
 * in `loadSharedEnv`). Reports what it would CONTRIBUTE, not merely which names
 * are new: a before/after key diff cannot report a key it filled.
 *
 * @param {Record<string,string>} parsed - the shared file
 * @param {Record<string,string|undefined>} env - everything of higher precedence
 * @returns {{contributed: string[], dsnExplicitlyEmpty: boolean, higherHasDsn: boolean}}
 */
export function sharedLayerPlan(parsed, env) {
  const dsnExplicitlyEmpty = DSN_GROUP_KEYS.some(
    (k) => env[k] !== undefined && (env[k] || '').trim() === '',
  );
  const higherHasDsn = DSN_GROUP_KEYS.some((k) => (env[k] || '').trim() !== '');
  const skipDbGroup = higherHasDsn || dsnExplicitlyEmpty;
  const contributed = Object.keys(parsed)
    .filter((k) => !(skipDbGroup && DB_GROUP_KEYS.has(k)) && env[k] === undefined);
  return { contributed, dsnExplicitlyEmpty, higherHasDsn };
}

/**
 * The launch environment, as it was before this process applied any layer.
 * Before the loader has run there is nothing to subtract, so it is the live
 * `process.env`. A value a PARENT process loaded out of a `.env` arrives here
 * as inherited; `composeEnvLayers` credits it to the file it equals.
 * @returns {Record<string,string>}
 */
export function inheritedEnv() {
  return { ...(_inherited ?? process.env) };
}

/**
 * The runtime's precedence as a pure function: inherited > `.env` > shared,
 * with the shared contribution decided by `sharedLayerPlan` and switched off by
 * `AUDIT_LOOP_DISABLE_SHARED=1` from either higher layer (the runtime reads it
 * after the `.env` layer is applied).
 *
 * @param {{inherited: Record<string,string|undefined>, local: Record<string,string>, shared: Record<string,string>}} layers
 * @returns {{env: Record<string,string>, sharedContributed: string[]}}
 */
export function composeEnvLayers({ inherited = {}, local = {}, shared = {} }) {
  const env = { ...local };
  for (const [k, v] of Object.entries(inherited)) if (v !== undefined) env[k] = v;
  if (env.AUDIT_LOOP_DISABLE_SHARED === '1') return { env, sharedContributed: [] };
  const { contributed } = sharedLayerPlan(shared, env);
  for (const k of contributed) env[k] = shared[k];
  return { env, sharedContributed: contributed };
}

/**
 * Parse an env file the way the runtime does. Absent is `{}` with no error (the
 * runtime treats it so); unreadable is `{}` WITH the error code, so a doctor can
 * say "this layer could not be read" instead of reporting it as empty.
 * @returns {{parsed: Record<string,string>, error: string|null}}
 */
function parseEnvFile(p) {
  if (!p) return { parsed: {}, error: null };
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (err) {
    return { parsed: {}, error: err?.code === 'ENOENT' ? null : (err?.code || 'read error') };
  }
  try { return { parsed: dotenv.parse(raw), error: null }; } catch { return { parsed: {}, error: 'unparseable' }; }
}

/**
 * The three layers for a repository, READ but never applied — the doctors'
 * view of what the runtime will see in `repoPath`, without touching this
 * process's `process.env` (so several repos can be checked in one process).
 * `.env` is chosen as the runtime chooses it: an inherited `DOTENV_CONFIG_PATH`
 * wins (`loadCwdLayer` honours it), else the same worktree-safe discovery.
 *
 * @param {string} repoPath
 * @param {{inherited?: Record<string,string>, sharedPath?: string, localEnvPath?: string|null}} [opts]
 * @returns {{env: Record<string,string>, layers: {inherited: Record<string,string>, local: Record<string,string>, shared: Record<string,string>}, localEnvPath: string|null, sharedContributed: string[], errors: Array<{layer: 'local'|'shared', path: string, error: string}>}}
 */
export function readEnvLayers(repoPath, opts = {}) {
  const inherited = opts.inherited ?? inheritedEnv();
  const localEnvPath = opts.localEnvPath !== undefined
    ? opts.localEnvPath
    : (inherited.DOTENV_CONFIG_PATH || discoverLocalEnvPath(repoPath, { onNotice() {} }));
  const errors = [];
  const read = (layer, p) => {
    const { parsed, error } = parseEnvFile(p);
    if (error) errors.push({ layer, path: p, error });
    return parsed;
  };
  const local = read('local', localEnvPath);
  // The runtime decides the disable switch BEFORE it touches the shared file; so
  // does this, so a disabled layer is neither read nor reported as a source.
  const sharedOff = (inherited.AUDIT_LOOP_DISABLE_SHARED ?? local.AUDIT_LOOP_DISABLE_SHARED) === '1';
  const layers = { inherited, local, shared: sharedOff ? {} : read('shared', opts.sharedPath ?? sharedEnvPath()) };
  const { env, sharedContributed } = composeEnvLayers(layers);
  return { env, layers, localEnvPath: localEnvPath || null, sharedContributed, errors };
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
  // The launch environment as it was BEFORE any layer was applied — the only
  // moment it is observable. `inheritedEnv()` hands it to the doctors so they
  // can say which layer a value came from (see `composeEnvLayers`).
  _inherited ??= { ...process.env };
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
  const { contributed, dsnExplicitlyEmpty, higherHasDsn } = sharedLayerPlan(parsed, process.env);
  for (const k of contributed) process.env[k] = parsed[k];

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
  _inherited = null;
  delete process.env._AUDIT_LOOP_SHARED_LOADED;
}
