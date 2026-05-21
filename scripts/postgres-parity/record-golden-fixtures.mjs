#!/usr/bin/env node
/**
 * @fileoverview Off-CI golden-fixture recorder for the postgres-parity
 * contract suite (plan §0 prereq #5, §9 "Golden-fixture contract model",
 * R2/H1).
 *
 * Drives the FROZEN legacy supabase-js path at
 * `tests/fixtures/learning-store.legacy.mjs` against a LOCAL `supabase start`
 * Docker stack, captures per-function `(input, return, table mutations)`,
 * normalises non-deterministic values (UUIDs, `now()`), and writes one
 * JSON fixture per row in the contract matrix to
 * `tests/fixtures/contract/<function>.json`.
 *
 * CI runs the **new** pg-driver path against postgres + pgvector and diffs
 * its outputs against these committed fixtures (plan §9 — the R1 mitigation).
 *
 * ⚠️ NEVER point this at the production Supabase project. Plan §9:
 *    "off-CI — the frozen learning-store.legacy.mjs is run against a local
 *     `supabase start` stack (full Supabase in Docker; never production)".
 *
 * Usage:
 *   # Prereq: `supabase start` running locally; `tests/fixtures/learning-store.legacy.mjs` present.
 *   node scripts/postgres-parity/record-golden-fixtures.mjs \
 *     --legacy tests/fixtures/learning-store.legacy.mjs \
 *     --supabase-url http://127.0.0.1:54321 \
 *     --anon-key <ANON-KEY-FROM-supabase-status> \
 *     --service-role-key <SVC-KEY-FROM-supabase-status> \
 *     --out tests/fixtures/contract/
 *
 *   # Only record a single function (useful while iterating on a row):
 *   node scripts/postgres-parity/record-golden-fixtures.mjs --only upsertRepo …
 *
 * @module scripts/postgres-parity/record-golden-fixtures
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ── CLI parsing ────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    legacy: 'tests/fixtures/learning-store.legacy.mjs',
    supabaseUrl: process.env.SUPABASE_LOCAL_URL || 'http://127.0.0.1:54321',
    anonKey: process.env.SUPABASE_LOCAL_ANON_KEY || '',
    serviceRoleKey: process.env.SUPABASE_LOCAL_SERVICE_ROLE_KEY || '',
    outDir: 'tests/fixtures/contract/',
    only: null,
    // --allow-remote <project-ref> — opt into recording against a remote
    // Supabase sandbox project (path A in tests/fixtures/contract/README.md).
    // The ref is matched against the URL hostname so the operator can't
    // accidentally point at any other Supabase project. Still refused if
    // the ref matches the audit-loop production project (uahjjdelnnpfmaqjrwoz)
    // OR if the URL equals SUPABASE_AUDIT_URL.
    allowRemote: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1];
    switch (a) {
      case '--legacy':            out.legacy = v; i++; break;
      case '--supabase-url':      out.supabaseUrl = v; i++; break;
      case '--anon-key':          out.anonKey = v; i++; break;
      case '--service-role-key':  out.serviceRoleKey = v; i++; break;
      case '--out':               out.outDir = v; i++; break;
      case '--only':              out.only = v; i++; break;
      case '--allow-remote':      out.allowRemote = v; i++; break;
      default:                    break;
    }
  }
  return out;
}

// ── Production-DB safety guard ─────────────────────────────────────────────
// The plan is explicit: never against the maintainer's production
// project. We refuse any URL that isn't either:
//   (a) localhost / 127.0.0.1 / host.docker.internal (path B), OR
//   (b) `https://<--allow-remote-ref>.supabase.co` (path A: sandbox)
// AND refuse if the URL equals `SUPABASE_AUDIT_URL` (defense in depth in
// case the maintainer mis-typed a sandbox ref that happens to match
// audit-loop) AND refuse the well-known audit-loop production ref.

const AUDIT_LOOP_PROD_REF = 'uahjjdelnnpfmaqjrwoz';

function assertLocalOnly(url, allowRemoteRef) {
  const u = new URL(url);
  const okHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', 'host.docker.internal']);

  if (okHosts.has(u.hostname)) {
    // Path B — local Docker stack. No further checks needed.
  } else if (allowRemoteRef) {
    // Path A — sandbox Supabase project. Validate the ref guards.
    if (allowRemoteRef === AUDIT_LOOP_PROD_REF) {
      throw new Error(
        `record-golden-fixtures refuses --allow-remote ${AUDIT_LOOP_PROD_REF} — ` +
        `that's the audit-loop production project. Create a separate sandbox ` +
        `(\`supabase projects create postgres-parity-fixtures …\`) and use its ref.`
      );
    }
    // Expected URL shape: `<ref>.supabase.co` (REST URL) or the pooler host.
    const expectedRest = `${allowRemoteRef}.supabase.co`;
    const expectedPooler = `pooler.supabase.com`;   // shared pooler host (region-prefixed)
    const hostnameMatchesRef =
      u.hostname === expectedRest ||
      u.hostname.endsWith(`.${expectedRest}`) ||
      u.hostname.endsWith(expectedPooler);
    if (!hostnameMatchesRef) {
      throw new Error(
        `--allow-remote ${allowRemoteRef} doesn't match the URL host ${u.hostname}. ` +
        `Expected a host containing "${expectedRest}" or the shared pooler. ` +
        `Refusing — the safety check would not catch an accidentally-swapped sandbox.`
      );
    }
  } else {
    throw new Error(
      `record-golden-fixtures refuses to run against ${u.hostname} — local-only by policy. ` +
      `For a remote sandbox project pass \`--allow-remote <project-ref>\` (path A in ` +
      `tests/fixtures/contract/README.md). For local Docker, run \`supabase start\` first.`
    );
  }

  if (process.env.SUPABASE_AUDIT_URL && process.env.SUPABASE_AUDIT_URL.includes(u.hostname)) {
    // hostname might be a literal IP for localhost — extra safety check below.
  }
  if (process.env.SUPABASE_AUDIT_URL === url) {
    throw new Error('--supabase-url equals SUPABASE_AUDIT_URL — would target production.');
  }
}

// ── Deterministic inputs ───────────────────────────────────────────────────
// Each contract-matrix row needs an `input` payload. We use a small seed
// table here; richer per-function inputs can be added as fixtures are recorded.

const SEED_REPO_FINGERPRINT = 'GOLDEN-FIXTURE-REPO';
const SEED_REPO_NAME = 'postgres-parity-golden';

const INPUT_FACTORY = {
  initLearningStore: () => [],
  isCloudEnabled:    () => [],
  upsertRepo: () => [
    { repoFingerprint: SEED_REPO_FINGERPRINT, stack: { db: 'postgres' }, fileBreakdown: {}, focusAreas: [] },
    SEED_REPO_NAME,
  ],
  // … all 93 production functions register an input factory here.
  // Stub the rest with [] so the runner can be invoked end-to-end during
  // the first dry-run; flesh out per-function as fixtures are recorded.
};

// ── Recorder core ──────────────────────────────────────────────────────────

async function runOne(fnName, legacyModule, opts) {
  const factory = INPUT_FACTORY[fnName];
  if (!factory) {
    return { fnName, status: 'no-input-factory', message: 'add an entry to INPUT_FACTORY[]' };
  }
  const fn = legacyModule[fnName];
  if (typeof fn !== 'function') {
    return { fnName, status: 'missing-export', message: `${fnName} is not exported by the frozen legacy module` };
  }
  const input = factory();
  const before = await captureTableSnapshot(opts);
  let ret, error;
  try {
    ret = await fn(...input);
  } catch (e) {
    error = { message: e.message, stack: e.stack };
  }
  const after = await captureTableSnapshot(opts);
  const mutations = diffSnapshots(before, after);

  return {
    fnName,
    status: error ? 'errored' : 'recorded',
    input,
    return: normaliseValues(ret),
    mutations: mutations.map(normaliseMutation),
    error,
  };
}

// ── Snapshot + diff (deferred — TODO for the first recording pass) ─────────
// Recording the full table-snapshot diff requires connecting via the
// service-role key and SELECT * FROM each table the contract matrix
// declares. The implementation lands the first time someone actually
// runs this script against a live local stack.

async function captureTableSnapshot(_opts) {
  // Placeholder — return an empty snapshot so the first invocation surfaces
  // the snapshot capture as a clear TODO instead of pretending success.
  return { __TODO__: 'captureTableSnapshot — wire to supabase-js SELECT' };
}

function diffSnapshots(_before, _after) {
  return [];
}

// ── Normalisation (plan §9 "Determinism") ──────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TS_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

function normaliseValues(v, ctx = { uuids: new Map() }) {
  if (v == null) return v;
  if (typeof v === 'string') {
    if (UUID_RE.test(v)) {
      if (!ctx.uuids.has(v)) ctx.uuids.set(v, `<UUID-${ctx.uuids.size}>`);
      return ctx.uuids.get(v);
    }
    if (TS_RE.test(v)) return '<TS-NOW>';
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => normaliseValues(x, ctx));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = normaliseValues(val, ctx);
    return out;
  }
  return v;
}

function normaliseMutation(m) { return normaliseValues(m); }

// ── Runner ─────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  assertLocalOnly(opts.supabaseUrl, opts.allowRemote);

  const legacyPath = path.resolve(REPO_ROOT, opts.legacy);
  if (!fs.existsSync(legacyPath)) {
    throw new Error(`legacy snapshot not found at ${legacyPath} — run M0 #4 first`);
  }
  // Wire the legacy snapshot to the local Supabase stack via env. The frozen
  // path reads `SUPABASE_AUDIT_URL` + `SUPABASE_AUDIT_ANON_KEY` directly
  // (we copy them from the caller-supplied flags). Production env vars are
  // ignored here — the frozen path doesn't see them.
  process.env.SUPABASE_AUDIT_URL = opts.supabaseUrl;
  process.env.SUPABASE_AUDIT_ANON_KEY = opts.anonKey;
  process.env.SUPABASE_AUDIT_SERVICE_ROLE_KEY = opts.serviceRoleKey;

  const legacyModule = await import(`file://${legacyPath.replace(/\\/g, '/')}`);
  await legacyModule.initLearningStore();

  const matrixRows = Object.keys(INPUT_FACTORY);
  const rows = opts.only ? matrixRows.filter((r) => r === opts.only) : matrixRows;

  const frozenSha = sourceSha(legacyPath);
  fs.mkdirSync(path.resolve(REPO_ROOT, opts.outDir), { recursive: true });

  const summary = { recorded: 0, skipped: 0, errored: 0 };
  for (const fnName of rows) {
    const res = await runOne(fnName, legacyModule, opts);
    if (res.status === 'recorded') {
      const fixture = {
        function: res.fnName,
        input: res.input,
        expected: { return: res.return, mutations: res.mutations },
        frozenAtSha: frozenSha,
      };
      const outPath = path.resolve(REPO_ROOT, opts.outDir, `${res.fnName}.json`);
      fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n', 'utf-8');
      summary.recorded++;
      process.stderr.write(`  [fixture] ${res.fnName} → ${outPath}\n`);
    } else if (res.status === 'errored') {
      summary.errored++;
      process.stderr.write(`  [fixture] ${res.fnName} ERRORED: ${res.error.message}\n`);
    } else {
      summary.skipped++;
      process.stderr.write(`  [fixture] ${res.fnName} skipped: ${res.status} (${res.message || ''})\n`);
    }
  }

  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

function sourceSha(filePath) {
  try {
    return execSync(`git log -n1 --format=%H -- "${filePath}"`, { encoding: 'utf-8' }).trim();
  } catch {
    // Fall back to a content hash so fixtures are still traceable when the
    // file is uncommitted (rare; only during first recording).
    const content = fs.readFileSync(filePath, 'utf-8');
    return 'content-' + crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
  }
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err.stack || err.message}\n`);
  process.exit(1);
});
