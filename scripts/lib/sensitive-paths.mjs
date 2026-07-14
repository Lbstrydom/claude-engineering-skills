/**
 * @fileoverview Canonical sensitive-path classifier — two categories
 * (sensitive / generatedNoise) replacing the inline pattern lists that
 * previously lived in `quickfix-patterns.mjs`, `audit-scope.mjs`,
 * `sensitive-egress-gate.mjs`, and `extract.mjs`.
 *
 * Plan: docs/plans/sustainability-cleanup-batch.md WS3.
 *
 * Design notes:
 *  - Path normalisation runs first (`\` → `/`, lower-case). Windows
 *    absolute paths like `C:\repo\.env` are matched the same as POSIX
 *    `/Users/.../repo/.env`.
 *  - `classifyPath` returns the matched category or null; this is the
 *    only public predicate. Higher-level helpers (`shouldSkipForIndexing`,
 *    `filterDiffFiles`) compose on top.
 *  - `filterDiffFiles` is **state-aware** (plan §6 WS3 step 3) — a
 *    modified file that becomes sensitive is rewritten as deleted so the
 *    indexer can tombstone prior content; a delete is preserved so the
 *    tombstone signal survives the filter.
 *  - `formatSkipLog` is the ONLY sanctioned log route for sensitive
 *    skips. Default aggregates; debug mode (`SENSITIVE_PATHS_DEBUG=1`)
 *    emits `[redacted:<sha256-hex8>].<ext>` — never basenames, never
 *    full paths.
 *
 * # Coverage trade-offs vs. pre-WS3 inline lists
 *
 * The migration to a canonical predicate INTENTIONALLY tightens
 * lexical recall in exchange for higher precision. Documented losses:
 *
 *  - `app/secret-keys/main.yaml`-style variant secret/credential DIRECTORY
 *    names (not just the exact `secrets`/`credentials` segment) are matched
 *    via a `(secrets?|credentials?)[\w-]*\/` directory-segment rule — fixed
 *    2026-07-14 (Gemini consolidated-gate H4: the duplication-wave's own
 *    egress gate depends on this classifier, so the gap was in-scope per
 *    "impact not authorship"). `src/secret-helper.ts` (a FILE, not a
 *    directory) is still NOT a false positive — the rule only matches when
 *    the extended name is followed by `/`.
 *
 *  - `myenv.env`-style files (basename `foo.env`) — DELIBERATELY
 *    EXPANDED into the sensitive set (legacy quickfix-patterns let
 *    these through). Strict-superset of legacy egress denylist.
 *
 *  - `private/foo.txt`, `*.cer`, `*.der`, `*.gpg`, `*.asc`,
 *    `id_rsa.pub`, `id_ed25519.pub`, bare-name `secret`/`credentials`,
 *    `password.txt`, `token.json` — DELIBERATELY EXPANDED (previously
 *    only matched by egress-gate; now all consumers see them).
 *
 *  - `tokens?.<code-ext>` (tokens.mjs, tokens.ts, tokens.css, …) —
 *    DELIBERATELY CARVED OUT (2026-07-12): design-token modules are a
 *    standard frontend pattern (e.g. lib/visual/tokens.mjs) and were being
 *    misclassified as credential files, which excluded them from the symbol
 *    index and blocked diffs mentioning them at the egress gates. The
 *    `tokens/` directory, bare `token(s)`, and data-file forms
 *    (`tokens.json`, `tokens.yaml`, …) stay sensitive; a code file that
 *    embeds a real token literal is still caught by the CONTENT scanner
 *    (`containsSecrets`) at egress.
 *
 * Every legacy `quickfix-patterns.mjs::SENSITIVE_PATH_PATTERNS` regex
 * has a covering fixture in `tests/sensitive-paths.test.mjs` (superset
 * gate). The gate is the safety net — if you add a legacy pattern that
 * the new set doesn't cover, the test breaks.
 *
 * @module scripts/lib/sensitive-paths
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {'sensitive' | 'generatedNoise' | 'driftExempt'} SkipCategory
 */

/**
 * @typedef {object} SkipEntry
 * @property {string} path - normalised path that matched
 * @property {SkipCategory} category
 * @property {RegExp} pattern - the regex that matched
 * @property {'dropped' | 'rewritten-delete' | 'rewritten-add' | 'preserved-as-tombstone'} [action]
 */

/**
 * Egress-sensitive paths that MUST NEVER leak to logs, embeddings,
 * LLM prompts, or audit-loop egress.
 *
 * Strict superset of legacy patterns from `quickfix-patterns.mjs` +
 * `sensitive-egress-gate.mjs` (plan Gemini-G1 + Gemini-r2-G2 + Gemini-r4-G1).
 */
export const SENSITIVE_PATTERNS = Object.freeze([
  /(^|\/)\.env(\..+)?$/,                                       // .env, .env.production
  /(^|\/)\.env\.local$/,                                       // explicit override (redundant but explicit)
  /(^|\/)[^/]+\.env$/,                                         // foo.env style
  /(^|\/)secrets?(\..+)?$/,                                    // secret, secrets, secrets.json
  /(^|\/)credentials?(\..+)?$/,                                // credential, credentials, credentials.yaml
  /\.(pem|key|crt|cer|der|p12|pfx|gpg|asc)$/i,                 // cert/key bundles
  /(^|\/)(secrets?|credentials?)[\w-]*\//,                     // sensitive dirs incl. variants (secret-keys/, credential-store/) — Gemini H4
  /(^|\/)(private|\.aws|\.ssh)\//,                              // other sensitive directories
  /(^|\/)id_rsa.*$/,                                           // ssh keys + id_rsa.pub/.bak
  /(^|\/)id_ed25519.*$/,                                       // ed25519 ssh keys
  /(^|\/)password(?:[/.]|$)/i,                                 // password.txt + password/ dir; avoids `password-strength/`
  // token.json + tokens/ dir; avoids `tokenizer/`, `detokenize`, AND code/style
  // modules (tokens.mjs, tokens.css — design-token files, not credentials).
  // Auth tokens live in data files (json/yaml/txt/…); a code file that embeds
  // a real token literal is still caught by the content scanner at egress.
  /(^|\/)tokens?(?:\/|$|\.(?!([^/]*\.)?(?:m?[jt]sx?|c[jt]s|css|scss|less|sass|styl|vue|svelte)$))/i,
]);

/**
 * Non-sensitive but high-volume autogenerated files that hurt the symbol
 * index without adding signal. NOT secret — paths log in full.
 */
export const GENERATED_NOISE_PATTERNS = Object.freeze([
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)bun\.lockb$/,
  /\.min\.js$/,
  /\.map$/,
]);

/**
 * Known-intentional duplication/reference-mirror sources that carry zero
 * architectural signal for the symbol index — not security-sensitive (paths
 * log in full, same as `generatedNoise`) and NOT wired into `classifyPath`
 * (the general-purpose egress/security classifier used by ~15 call sites);
 * this category is deliberately scoped to `shouldSkipForIndexing` only, so
 * adding an exemption here can never change egress-gate/redaction behaviour.
 *
 * `docs/plans/security/files/**` is a verbatim text mirror of a corporate
 * security kit kept for reference (see AGENTS.md "Secret pre-write gate")
 * — indexing it as live source produces duplicate-symbol noise against the
 * real modules it mirrors.
 */
export const DRIFT_EXEMPT_PATTERNS = Object.freeze([
  /(^|\/)docs\/plans\/security\/files\//,
]);

/**
 * Normalise a path to a canonical comparable form: forward slashes,
 * drive letter stripped, lower-cased, leading `./` removed.
 *
 * @param {string} input
 * @returns {string}
 */
export function normalisePath(input) {
  return String(input || '')
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:\//, '')
    .toLowerCase()
    .replace(/^\.\//, '');
}

/**
 * Classify a path into one of the two skip categories, or null when no
 * pattern matches. Path normalisation runs first.
 *
 * @param {string} input
 * @returns {SkipCategory | null}
 */
export function classifyPath(input) {
  const p = normalisePath(input);
  if (!p) return null;
  for (const re of SENSITIVE_PATTERNS) if (re.test(p)) return 'sensitive';
  for (const re of GENERATED_NOISE_PATTERNS) if (re.test(p)) return 'generatedNoise';
  return null;
}

/**
 * Find the first matching regex from `patterns` for `p` (already normalised).
 * @returns {RegExp | null}
 */
function matchingPattern(p, patterns) {
  for (const re of patterns) if (re.test(p)) return re;
  return null;
}

/**
 * Resolve `p` through `fs.realpathSync` and classify BOTH the lexical
 * path AND the canonical (resolved) target. Catches symlink-bypass
 * attacks where the visible name is innocent (e.g. `repo/notes.txt`)
 * but the realpath target points into a sensitive location
 * (`~/.ssh/id_rsa`, `secrets/`, …) — the lexical classifier alone would
 * miss this.
 *
 * Fail-closed semantics:
 *   - Broken symlink, missing file, EACCES → `{category: 'sensitive',
 *     resolutionFailed: true}`. We cannot read what we cannot resolve.
 *   - Canonical path resolves OUTSIDE `repoRoot` → `{category:
 *     'sensitive', escapedRepo: true}`. A symlink leaving the repo is
 *     always treated as sensitive regardless of its visible name.
 *
 * Success semantics:
 *   - Lexical classification first (cheap regex; no FS touch). If the
 *     visible path is already sensitive, return that without resolving
 *     — saves a syscall in the common case.
 *   - Otherwise realpath, contain to repo, classify the canonical path.
 *     The returned `canonical` is the path the caller should READ from
 *     (so a TOCTOU window between gate and open is minimised; callers
 *     should re-fstat after open for full defence-in-depth).
 *
 * Plan: docs/plans/liveness-and-canonical-paths.md WS-CANON #6.
 *
 * @param {string} p — repo-relative or absolute path
 * @param {{repoRoot: string, fs?: typeof import('node:fs')}} opts
 *        `fs` is injectable for tests; defaults to node:fs.
 * @returns {{
 *   category: SkipCategory | null,
 *   lexical: SkipCategory | null,
 *   canonical: string | null,
 *   escapedRepo: boolean,
 *   resolutionFailed: boolean,
 * }}
 */
export function resolveAndClassify(p, opts) {
  if (!opts || typeof opts.repoRoot !== 'string') {
    throw new TypeError('resolveAndClassify: opts.repoRoot is required');
  }
  // `opts.fs` injectable for tests so unit tests can drive realpath
  // behaviour without filesystem fixtures. Defaults to node:fs.
  const fsMod = opts.fs || fs;
  const repoRoot = path.resolve(opts.repoRoot);

  const lexical = classifyPath(p);

  // Cheap path: lexical match → no FS touch needed.
  if (lexical === 'sensitive') {
    return {
      category: 'sensitive',
      lexical,
      canonical: null,
      escapedRepo: false,
      resolutionFailed: false,
    };
  }

  // Resolve to absolute, then realpath. We resolve from the repo root
  // if `p` is relative so a callsite that passes `'src/foo.ts'` doesn't
  // depend on process.cwd().
  const abs = path.isAbsolute(p) ? p : path.resolve(repoRoot, p);
  let canonical;
  try {
    canonical = fsMod.realpathSync(abs);
  } catch {
    // ENOENT (broken symlink / missing file), EACCES, ELOOP (cycle) →
    // fail-closed. We CANNOT read what we cannot resolve.
    return {
      category: 'sensitive',
      lexical,
      canonical: null,
      escapedRepo: false,
      resolutionFailed: true,
    };
  }

  // Containment: any escape outside the repo is sensitive.
  // path.relative returns '..' or '../…' when the target is outside.
  const rel = path.relative(repoRoot, canonical);
  const escapedRepo = rel.startsWith('..') || path.isAbsolute(rel);
  if (escapedRepo) {
    return {
      category: 'sensitive',
      lexical,
      canonical,
      escapedRepo: true,
      resolutionFailed: false,
    };
  }

  // Re-classify the canonical (resolved) path. If a symlink-followed
  // target lives in `secrets/`, it's sensitive even though the visible
  // name was `notes.txt`.
  const canonicalCategory = classifyPath(rel);
  return {
    category: canonicalCategory ?? lexical,
    lexical,
    canonical,
    escapedRepo: false,
    resolutionFailed: false,
  };
}


/**
 * THE canonical predicate for "should we skip this path at indexing-discovery
 * time?". Used by `refresh.mjs` (both full + incremental discovery paths) and
 * `extract.mjs` (defence-in-depth). The category list lets call sites opt into
 * `['sensitive']` (LLM egress gate) or `['sensitive', 'generatedNoise']`
 * (symbol indexer's full skip set).
 *
 * @param {string} input
 * @param {SkipCategory[]} categories
 * @returns {{skip: boolean, category?: SkipCategory, pattern?: RegExp}}
 */
export function shouldSkipForIndexing(input, categories) {
  if (!Array.isArray(categories) || categories.length === 0) return { skip: false };
  const p = normalisePath(input);
  if (!p) return { skip: false };
  if (categories.includes('sensitive')) {
    const re = matchingPattern(p, SENSITIVE_PATTERNS);
    if (re) return { skip: true, category: 'sensitive', pattern: re };
  }
  if (categories.includes('generatedNoise')) {
    const re = matchingPattern(p, GENERATED_NOISE_PATTERNS);
    if (re) return { skip: true, category: 'generatedNoise', pattern: re };
  }
  if (categories.includes('driftExempt')) {
    const re = matchingPattern(p, DRIFT_EXEMPT_PATTERNS);
    if (re) return { skip: true, category: 'driftExempt', pattern: re };
  }
  return { skip: false };
}

/** Build an empty `DiffShape`-compatible structure. */
function emptyDiff() {
  return { added: [], modified: [], deleted: [], untracked: [], renamed: [] };
}

/**
 * State-aware filter for the categorised diff shape produced by
 * `vcs.gitDiffWithWorkingTree`. Preserves tombstone signal so the
 * downstream indexer can correctly clean up rows for paths that have
 * become sensitive (plan §6 WS3 step 3 + Gemini-r3-G3).
 *
 * The 12-case state matrix is asserted in `tests/sensitive-paths.test.mjs`.
 *
 * @param {import('./vcs.mjs').DiffShape} diff
 * @param {SkipCategory[]} categories
 * @returns {{diff: import('./vcs.mjs').DiffShape, skipped: SkipEntry[]}}
 */
export function filterDiffFiles(diff, categories) {
  const out = emptyDiff();
  const skipped = [];

  if (!diff || typeof diff !== 'object') return { diff: out, skipped };

  for (const p of (diff.added || [])) {
    const r = shouldSkipForIndexing(p, categories);
    if (r.skip) {
      skipped.push({ path: normalisePath(p), category: r.category, pattern: r.pattern, action: 'dropped' });
    } else {
      out.added.push(p);
    }
  }

  for (const p of (diff.modified || [])) {
    const r = shouldSkipForIndexing(p, categories);
    if (r.skip) {
      // File is sensitive NOW; indexer must tombstone whatever was indexed previously.
      out.deleted.push(p);
      skipped.push({ path: normalisePath(p), category: r.category, pattern: r.pattern, action: 'rewritten-delete' });
    } else {
      out.modified.push(p);
    }
  }

  for (const p of (diff.deleted || [])) {
    const r = shouldSkipForIndexing(p, categories);
    // CRITICAL: always preserve the deletion so the indexer cleans up the prior row.
    out.deleted.push(p);
    if (r.skip) {
      skipped.push({ path: normalisePath(p), category: r.category, pattern: r.pattern, action: 'preserved-as-tombstone' });
    }
  }

  for (const p of (diff.untracked || [])) {
    const r = shouldSkipForIndexing(p, categories);
    if (r.skip) {
      skipped.push({ path: normalisePath(p), category: r.category, pattern: r.pattern, action: 'dropped' });
    } else {
      out.untracked.push(p);
    }
  }

  for (const ren of (diff.renamed || [])) {
    if (!ren || typeof ren !== 'object') continue;
    const fromR = shouldSkipForIndexing(ren.from, categories);
    const toR = shouldSkipForIndexing(ren.to, categories);
    if (fromR.skip && toR.skip) {
      skipped.push({ path: normalisePath(ren.from), category: fromR.category, pattern: fromR.pattern, action: 'dropped' });
      skipped.push({ path: normalisePath(ren.to), category: toR.category, pattern: toR.pattern, action: 'dropped' });
    } else if (fromR.skip && !toR.skip) {
      // from was never indexed (sensitive); to is newly visible.
      out.added.push(ren.to);
      skipped.push({ path: normalisePath(ren.from), category: fromR.category, pattern: fromR.pattern, action: 'rewritten-add' });
    } else if (!fromR.skip && toR.skip) {
      // from must be tombstoned; to is sensitive and skipped.
      out.deleted.push(ren.from);
      skipped.push({ path: normalisePath(ren.to), category: toR.category, pattern: toR.pattern, action: 'rewritten-delete' });
    } else {
      out.renamed.push(ren);
    }
  }

  return { diff: out, skipped };
}

/**
 * Deterministic stub-friendly hash for redacted logging. Returns the first
 * 8 hex chars of sha256(path).
 *
 * @param {string} input
 * @returns {string}
 */
function defaultHash(input) {
  return crypto.createHash('sha256').update(String(input || ''), 'utf-8').digest('hex').slice(0, 8);
}

let _warnedDebug = false;

/**
 * Render the canonical skip log lines for a batch of skipped entries.
 *
 * Default behaviour (no debug env):
 *  - `sensitive` skips → ONE aggregated line: `[<logger>] sensitive-skip: <count> files (category=sensitive, patterns=[...])`. Raw paths never appear.
 *  - `generatedNoise` skips → per-path line: `[<logger>] noise-skip: <path> (matched <pattern>)`.
 *  - `driftExempt` skips → per-path line: `[<logger>] drift-exempt-skip: <path> (matched <pattern>)`.
 *
 * Debug mode (`SENSITIVE_PATHS_DEBUG=1`, set process-wide):
 *  - Sensitive skips become per-file `[<logger>] sensitive-skip: [redacted:<hash8>].<ext> (matched <pattern>)`. Hash is stable per path so two log lines for the same file correlate without leaking it.
 *  - A loud one-time banner warns the operator that even basenames are masked.
 *
 * @param {SkipEntry[]} skipped
 * @param {{debug?: boolean, logger?: string, hashFn?: (s: string) => string, env?: NodeJS.ProcessEnv}} [opts]
 * @returns {string[]}
 */
export function formatSkipLog(skipped, opts = {}) {
  const env = opts.env || process.env;
  const debug = opts.debug !== undefined ? !!opts.debug : env.SENSITIVE_PATHS_DEBUG === '1';
  const logger = opts.logger || 'sensitive-paths';
  const hashFn = opts.hashFn || defaultHash;

  if (!Array.isArray(skipped) || skipped.length === 0) return [];

  const lines = [];
  const sensitive = skipped.filter(s => s.category === 'sensitive');
  const noise = skipped.filter(s => s.category === 'generatedNoise');
  const driftExempt = skipped.filter(s => s.category === 'driftExempt');

  if (debug && sensitive.length > 0 && !_warnedDebug) {
    lines.push(`[${logger}] WARNING: SENSITIVE_PATHS_DEBUG enabled; sensitive skips log redacted hashes only — basenames are NOT shown. To inspect a specific path, grep the working tree directly.`);
    _warnedDebug = true;
  }

  if (sensitive.length > 0) {
    if (debug) {
      for (const s of sensitive) {
        const ext = path.extname(s.path) || '';
        const h = hashFn(s.path);
        const action = s.action ? ` action=${s.action}` : '';
        lines.push(`[${logger}] sensitive-skip: [redacted:${h}]${ext} (matched ${s.pattern})${action}`);
      }
    } else {
      const patterns = Array.from(new Set(sensitive.map(s => String(s.pattern))));
      lines.push(`[${logger}] sensitive-skip: ${sensitive.length} files (category=sensitive, patterns=[${patterns.join(', ')}])`);
    }
  }

  for (const n of noise) {
    const action = n.action ? ` action=${n.action}` : '';
    lines.push(`[${logger}] noise-skip: ${n.path} (matched ${n.pattern})${action}`);
  }

  for (const d of driftExempt) {
    const action = d.action ? ` action=${d.action}` : '';
    lines.push(`[${logger}] drift-exempt-skip: ${d.path} (matched ${d.pattern})${action}`);
  }

  return lines;
}

/** @internal — test hook so `_warnedDebug` can be reset between cases. */
export function _resetDebugBanner() {
  _warnedDebug = false;
}
