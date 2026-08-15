#!/usr/bin/env node
/**
 * @fileoverview Model pool freshness gate.
 *
 * Compares `STATIC_POOL` in `lib/model-resolver.mjs` against each provider's
 * live `/models` catalog and surfaces drift. Three classes of finding:
 *
 *   models/sentinel-drift      HIGH    Sentinel resolves to different model
 *                                       with live vs static pool — STATIC_POOL
 *                                       is missing a newer model.
 *   models/missing-from-static MEDIUM  Live catalog has IDs not in STATIC_POOL
 *                                       that match relevant tier patterns.
 *   models/premature-remap     LOW     `DEPRECATED_REMAP` entry maps a model
 *                                       ID that the provider still serves.
 *
 * Eliminates the "quarterly manual chore" of refreshing STATIC_POOL.
 *
 * Exit codes:
 *   0  No findings (or only LOW)
 *   1  HIGH findings (or any finding under --strict)
 *   2  MEDIUM findings (without --strict)
 *   3  INSUFFICIENT_DATA — couldn't reach any provider
 *
 * @module scripts/check-model-freshness
 */

import './lib/load-env.mjs';
import crypto from 'node:crypto';
import { z } from 'zod';

import {
  STATIC_POOL,
  DEPRECATED_REMAP,
  SENTINEL_TO_TIER,
  resolveModel,
  refreshModelCatalog,
  setCatalog,
  getLiveCatalog,
  _resetCatalogCache,
  parseClaudeModel,
  parseGeminiModel,
  parseOpenAIModel,
  compareVersions,
} from './lib/model-resolver.mjs';
import { toSarif } from './lib/claudemd/sarif-formatter.mjs';

const FILE = 'scripts/lib/model-resolver.mjs';

// ── Catalog input schema ────────────────────────────────────────────────────
// Validates live catalog input at the boundary so type/shape regressions
// (e.g. a fetcher accidentally returning objects instead of strings) fail
// fast with a clear error instead of corrupting downstream comparisons.

const CatalogSchema = z.object({
  openai: z.array(z.string().min(1)).default([]),
  anthropic: z.array(z.string().min(1)).default([]),
  google: z.array(z.string().min(1)).default([]),
}).strict();

// Tier patterns that count as "modern enough to surface". Filters out
// truly ancient or experimental IDs so the report stays signal-dense.
const TIER_PATTERNS = {
  openai:    /^(gpt|o)-?\d/i,
  anthropic: /^claude-(opus|sonnet|haiku)-\d/i,
  google:    /^gemini-(\d|pro|flash)/i,
};

// Per-provider id parser, for the domination check below.
const PARSE_FN = {
  openai: parseOpenAIModel,
  anthropic: parseClaudeModel,
  google: parseGeminiModel,
};

/**
 * The functional selection bucket a parsed id competes in — mirrors exactly
 * what pickNewestOpenAI/pickNewestClaude/pickNewestGemini group together
 * when a sentinel actually resolves, so "missing" tracks the same buckets
 * real resolution uses (not an ad-hoc grouping that could disagree with it).
 * OpenAI has only two REAL selection groups regardless of SKU name (`latest-
 * gpt` pulls from every non-lite variant together, `latest-gpt-mini` from
 * every lite variant) — see pickNewestOpenAI's `variant === null` filter.
 */
function bucketKeyFor(provider, parsed) {
  if (provider === 'anthropic' || provider === 'google') return parsed.tier;
  if (provider === 'openai') return parsed.isLite ? 'lite' : 'nonlite';
  return null;
}

// ── Drift detection ─────────────────────────────────────────────────────────

/**
 * Compute sentinel-drift findings: for each sentinel, compare what
 * `resolveModel()` returns against static pool only vs static ∪ live.
 * If they differ, the static pool is missing a newer model.
 *
 * Cache state guarantee: this function mutates the resolver's session cache
 * via `setCatalog`/`_resetCatalogCache` to simulate static-only and
 * live-aware resolutions. A try/finally ensures the cache is reset to empty
 * after each sentinel so a thrown exception cannot leak a populated cache
 * to subsequent calls in the same process.
 *
 * Errors during resolution are logged (not silently swallowed) so resolver
 * regressions surface as visible warnings rather than as missing findings.
 *
 * @param {Object} liveCatalog - { openai: string[], anthropic: string[], google: string[] }
 * @returns {Array<Finding>}
 */
export function detectSentinelDrift(liveCatalog) {
  const findings = [];
  for (const sentinel of Object.keys(SENTINEL_TO_TIER)) {
    const tier = SENTINEL_TO_TIER[sentinel];
    let staticPick = null;
    let livePick = null;
    try {
      // Static-only resolution. Don't `continue` on failure — a static
      // failure with a successful live resolution is itself a finding
      // (STATIC_POOL is missing the sentinel's tier entirely). Let
      // `staticPick` stay null and proceed with live resolution.
      _resetCatalogCache();
      try {
        staticPick = resolveModel(sentinel, { silent: true });
      } catch (err) {
        process.stderr.write(`[freshness] resolve failed for sentinel "${sentinel}" (static): ${err.message}\n`);
      }
      // Live-aware resolution.
      _resetCatalogCache();
      if (liveCatalog[tier.provider] && liveCatalog[tier.provider].length > 0) {
        setCatalog(tier.provider, liveCatalog[tier.provider]);
      }
      try {
        livePick = resolveModel(sentinel, { silent: true });
      } catch (err) {
        process.stderr.write(`[freshness] resolve failed for sentinel "${sentinel}" (live): ${err.message}\n`);
      }
    } finally {
      // Always clear the cache — never leak state to callers that rely on
      // an empty cache (e.g. config.mjs at module load in another script).
      _resetCatalogCache();
    }

    // Three drift cases:
    //   1. both resolve, values differ           → static is stale
    //   2. static fails, live resolves           → STATIC_POOL missing the tier entirely
    //   3. both fail OR live fails               → no actionable drift signal
    if (livePick !== null && staticPick !== livePick) {
      const message = staticPick === null
        ? `Sentinel "${sentinel}" cannot resolve against STATIC_POOL but resolves to "${livePick}" ` +
          `against the live ${tier.provider} catalog. STATIC_POOL.${tier.provider} appears to be ` +
          `missing the entire tier — add "${livePick}" so offline resolution works.`
        : `Sentinel "${sentinel}" resolves to "${staticPick}" against STATIC_POOL but ` +
          `"${livePick}" against the live ${tier.provider} catalog. ` +
          `Add "${livePick}" to STATIC_POOL.${tier.provider} so offline resolution stays current.`;
      findings.push({
        ruleId: 'models/sentinel-drift',
        severity: 'error',
        file: FILE,
        line: null,
        message,
        semanticId: hashId(sentinel, 'sentinel-drift'),
        provider: tier.provider,
        sentinel,
        staticPick,
        livePick,
      });
    }
  }
  return findings;
}

/**
 * For each provider: report live IDs that represent genuine, un-covered
 * version progress over STATIC_POOL — i.e. IDs a sentinel could actually
 * resolve to that nothing already in the pool dominates.
 *
 * Deliberately NOT "any live id not literally a string in STATIC_POOL"
 * (the pre-2026-07-14 behaviour) — that flagged every retired/ancient model
 * (`gpt-3.5-turbo-1106`, `gemini-2.0-flash-lite-001`, dated Claude
 * snapshots older than what's already pooled) as "missing" forever, since
 * STATIC_POOL is deliberately pruned to current-generation-plus-one and
 * will never contain them. That's permanent, unscientific noise: the same
 * live catalog produces the same false "drift" every single run regardless
 * of whether anything real changed. Reusing `compareVersions` (the SAME
 * comparison `pickNewest*` uses to actually pick a sentinel's model) means
 * a live id is flagged only when it would functionally change a real
 * resolution — genuine drift, not pool-pruning noise.
 */
export function detectMissingFromStatic(liveCatalog) {
  const findings = [];
  for (const provider of ['openai', 'anthropic', 'google']) {
    const live = liveCatalog[provider] || [];
    if (live.length === 0) continue;
    const pattern = TIER_PATTERNS[provider];
    const parseFn = PARSE_FN[provider];

    // Best (newest) STATIC_POOL entry per selection bucket.
    const staticBest = new Map();
    for (const id of STATIC_POOL[provider]) {
      const p = parseFn(id);
      if (!p) continue;
      const key = bucketKeyFor(provider, p);
      const cur = staticBest.get(key);
      if (!cur || compareVersions(p, cur) < 0) staticBest.set(key, p);
    }

    const missing = live.filter(id => {
      if (!pattern.test(id)) return false;
      const p = parseFn(id);
      // Pattern-matched but unparseable by the strict per-provider parser:
      // we can't determine its age, so fail OPEN and flag it rather than
      // silently dropping it — a genuinely novel naming shape (like GPT-5.6's
      // sol/terra/luna before the parser learned it) must still surface for
      // a human to notice, not vanish into "looks unfamiliar, ignore it."
      // Widening the parser for known legacy shapes (done 2026-07-14) is
      // the real fix; this is the backstop for shapes nobody's seen yet.
      if (!p) return true;
      const key = bucketKeyFor(provider, p);
      const best = staticBest.get(key);
      // No static entry for this bucket at all → genuinely uncovered tier.
      // Otherwise only "missing" if strictly newer than what's already
      // covered — same age or older than an existing (possibly
      // intentionally-pruned) entry isn't missing, it's just old.
      return !best || compareVersions(p, best) < 0;
    });
    if (missing.length === 0) continue;
    // semanticId hashes the provider AND the sorted missing-ID set so that
    // each distinct drift event has a stable, distinct identity. Without
    // the missing-IDs in the hash, different drift sets for the same
    // provider would collide on a single finding ID and dedup incorrectly.
    const missingKey = `missing-from-static:${[...missing].sort().join(',')}`;
    findings.push({
      ruleId: 'models/missing-from-static',
      severity: 'warn',
      file: FILE,
      line: null,
      message: `${provider} live catalog has ${missing.length} relevant IDs not in STATIC_POOL: ` +
               `${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', ...' : ''}. ` +
               `Consider adding for offline resolution.`,
      semanticId: hashId(provider, missingKey),
      provider,
      missingIds: missing,
    });
  }
  return findings;
}

/**
 * Report DEPRECATED_REMAP entries that map IDs the provider still serves.
 * Such entries are premature — they remap a working model to a sentinel.
 */
export function detectPrematureRemap(liveCatalog) {
  const findings = [];
  const allLive = new Set([
    ...(liveCatalog.openai || []),
    ...(liveCatalog.anthropic || []),
    ...(liveCatalog.google || []),
  ]);
  if (allLive.size === 0) return findings;
  for (const [deprecatedId, sentinel] of Object.entries(DEPRECATED_REMAP)) {
    if (allLive.has(deprecatedId)) {
      findings.push({
        ruleId: 'models/premature-remap',
        severity: 'note',
        file: FILE,
        line: null,
        message: `DEPRECATED_REMAP["${deprecatedId}"] → "${sentinel}" is premature: ` +
                 `the provider still serves "${deprecatedId}". ` +
                 `Either remove the remap entry, or document why this model is being retired ahead of the provider.`,
        semanticId: hashId(deprecatedId, 'premature-remap'),
        deprecatedId,
        sentinel,
      });
    }
  }
  return findings;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function hashId(key, rule) {
  return crypto.createHash('sha256').update(`${rule}|${key}`).digest('hex').slice(0, 16);
}

// ── Main check entry ────────────────────────────────────────────────────────

/**
 * Run all freshness checks. Exposed for testing. Tests inject `fetchedCatalog`
 * to mock the live API.
 *
 * @param {{fetchedCatalog?: Object, refresh?: boolean}} [opts]
 * @returns {Promise<{findings: Array, providersChecked: string[]}>}
 */
export async function runFreshnessCheck(opts = {}) {
  let rawCatalog = opts.fetchedCatalog;

  if (!rawCatalog) {
    if (opts.refresh === false) {
      rawCatalog = { openai: [], anthropic: [], google: [] };
    } else {
      const counts = await refreshModelCatalog();
      rawCatalog = {
        openai: counts.openai > 0 ? getLiveCatalog('openai') : [],
        anthropic: counts.anthropic > 0 ? getLiveCatalog('anthropic') : [],
        google: counts.google > 0 ? getLiveCatalog('google') : [],
      };
    }
  }

  // Validate at the boundary — guards against fetcher regressions returning
  // non-string entries, missing provider keys, or extra fields.
  const parsed = CatalogSchema.safeParse(rawCatalog);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid live catalog shape:\n${issues}`);
  }
  const liveCatalog = parsed.data;

  const providersChecked = ['openai', 'anthropic', 'google']
    .filter(p => liveCatalog[p] && liveCatalog[p].length > 0);

  const findings = [];

  if (providersChecked.length > 0) {
    findings.push(...detectSentinelDrift(liveCatalog));
    findings.push(...detectMissingFromStatic(liveCatalog));
    findings.push(...detectPrematureRemap(liveCatalog));
  }

  return { findings, providersChecked, liveCatalog };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { format: 'text', strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format') args.format = argv[++i];
    else if (a === '--strict') args.strict = true;
    else if (a === '--help' || a === '-h') { showHelp(); process.exit(0); }
    else { process.stderr.write(`Unknown arg: ${a}\n`); process.exit(2); }
  }
  if (!['text', 'json', 'sarif'].includes(args.format)) {
    process.stderr.write(`Invalid --format: ${args.format} (expected text|json|sarif)\n`);
    process.exit(2);
  }
  return args;
}

function showHelp() {
  process.stdout.write(`Usage: node scripts/check-model-freshness.mjs [options]

Detects drift between STATIC_POOL in scripts/lib/model-resolver.mjs and
each provider's live /models catalog. Eliminates the manual quarterly
"refresh STATIC_POOL" chore.

Options:
  --format <fmt>   text (default) | json | sarif
  --strict         Exit non-zero on MEDIUM findings too
  -h, --help       Show this help

Exit codes:
  0  No findings (or LOW only)
  1  HIGH findings (or any finding under --strict)
  2  MEDIUM findings only
  3  INSUFFICIENT_DATA — no provider reachable

Env:
  OPENAI_API_KEY      Required to fetch OpenAI live catalog
  ANTHROPIC_API_KEY   Required to fetch Anthropic live catalog
  GEMINI_API_KEY      Required to fetch Google live catalog

Missing keys cause that provider to be skipped, not the whole check.
If ALL providers are skipped, exit code is 3 (INSUFFICIENT_DATA).
`);
}

function emitOutput(report, format) {
  const { findings, providersChecked } = report;
  if (format === 'json') {
    process.stdout.write(JSON.stringify({ findings, providersChecked }, null, 2) + '\n');
    return;
  }
  if (format === 'sarif') {
    process.stdout.write(JSON.stringify(toSarif({ findings }), null, 2) + '\n');
    return;
  }
  if (providersChecked.length === 0) {
    process.stdout.write('INSUFFICIENT_DATA — no provider reachable (set API keys).\n');
    return;
  }
  if (findings.length === 0) {
    process.stdout.write(`OK  No model-pool drift detected (checked: ${providersChecked.join(', ')}).\n`);
    return;
  }
  const high = findings.filter(f => f.severity === 'error');
  const med = findings.filter(f => f.severity === 'warn');
  const low = findings.filter(f => f.severity === 'note');
  process.stdout.write('Model freshness report\n');
  process.stdout.write('======================\n');
  process.stdout.write(`Providers: ${providersChecked.join(', ')}\n`);
  process.stdout.write(`HIGH: ${high.length}  MEDIUM: ${med.length}  LOW: ${low.length}\n\n`);
  for (const f of findings) {
    const sev = f.severity === 'error' ? 'HIGH' : f.severity === 'warn' ? 'MEDIUM' : 'LOW';
    process.stdout.write(`[${sev}] ${f.ruleId}\n`);
    process.stdout.write(`  ${f.message}\n\n`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await runFreshnessCheck();
  emitOutput(report, args.format);

  if (report.providersChecked.length === 0) process.exit(3);
  const high = report.findings.filter(f => f.severity === 'error').length;
  const med = report.findings.filter(f => f.severity === 'warn').length;
  if (high > 0) process.exit(1);
  if (med > 0) process.exit(args.strict ? 1 : 2);
  process.exit(0);
}

const invokedDirectly = (() => {
  try {
    const metaPath = new URL(import.meta.url).pathname.toLowerCase();
    const argvPath = process.argv[1] ? new URL(`file://${process.argv[1].replaceAll(/\\/g, '/')}`).pathname.toLowerCase() : '';
    return metaPath.endsWith('/check-model-freshness.mjs') && argvPath.endsWith('/check-model-freshness.mjs');
  } catch { return false; }
})();

if (invokedDirectly) {
  main().catch(err => {
    process.stderr.write(`Error: ${err.message}\n${err.stack}\n`);
    process.exit(99);
  });
}
