/**
 * @fileoverview Audit scope filtering — sensitive file detection, audit-infrastructure
 * exclusion, and context assembly with safety guards.
 *
 * Split from file-io.mjs (Wave 2, Phase 2) for Single Responsibility.
 * @module scripts/lib/audit-scope
 */

import fs from 'node:fs';
import path from 'node:path';
import { classifyPath } from './sensitive-paths.mjs';
import { scanEgressPayload, redactSecrets } from './sensitive-egress-gate.mjs';
// normalizePath not used directly here but re-exported via file-io.mjs barrel

// ── Sensitive File Filtering ────────────────────────────────────────────────
//
// The canonical predicate lives in `scripts/lib/sensitive-paths.mjs`. This
// module delegates so audit-context construction, debt capture, plan-path
// discovery, and sanitiser share ONE source of truth (plan: docs/plans/
// sustainability-cleanup-batch.md WS3, R1-H4).

export function isSensitiveFile(relPath) {
  return classifyPath(relPath) === 'sensitive';
}

// ── Audit Infrastructure Exclusion ────────────────────────────────────────
// These are the audit-loop's own scripts, synced to consumer repos via
// sync-to-repos.mjs. They must NEVER appear in the audit scope — including
// them causes Gemini/Claude Opus to flag issues in the tool itself rather
// than in the project being audited.

export const AUDIT_INFRA_BASENAMES = new Set([
  'openai-audit.mjs', 'gemini-review.mjs', 'bandit.mjs', 'learning-store.mjs',
  'phase7-check.mjs', 'shared.mjs', 'check-sync.mjs', 'check-setup.mjs',
  'refine-prompts.mjs', 'evolve-prompts.mjs', 'meta-assess.mjs',
  'debt-auto-capture.mjs', 'debt-backfill.mjs', 'debt-budget-check.mjs',
  'debt-pr-comment.mjs', 'debt-resolve.mjs', 'debt-review.mjs',
  'write-plan-outcomes.mjs', 'write-ledger-r1.mjs', 'sync-to-repos.mjs',
  'audit-loop.mjs',
  // lib/ modules
  'file-io.mjs', 'audit-scope.mjs', 'diff-annotation.mjs', 'plan-paths.mjs',
  'schemas.mjs', 'ledger.mjs', 'code-analysis.mjs', 'context.mjs',
  'findings.mjs', 'findings-format.mjs', 'findings-tracker.mjs',
  'findings-outcomes.mjs', 'outcome-sync.mjs',
  'config.mjs', 'llm-auditor.mjs', 'llm-wrappers.mjs',
  'language-profiles.mjs', 'rng.mjs', 'robustness.mjs', 'sanitizer.mjs',
  'secret-patterns.mjs', 'suppression-policy.mjs', 'backfill-parser.mjs',
  'owner-resolver.mjs', 'rule-metadata.mjs', 'file-store.mjs',
  'prompt-registry.mjs', 'prompt-seeds.mjs', 'linter.mjs',
  'plan-fp-tracker.mjs', 'predictive-strategy.mjs',
  'debt-capture.mjs', 'debt-events.mjs', 'debt-git-history.mjs',
  'debt-ledger.mjs', 'debt-memory.mjs', 'debt-review-helpers.mjs',
]);

/**
 * Returns true if the path points to an audit-loop infrastructure file.
 * These files are synced to consumer repos but should never be in audit scope.
 * @param {string} relPath - Relative file path
 * @returns {boolean}
 */
export function isAuditInfraFile(relPath) {
  const norm = relPath.replaceAll('\\', '/');
  const basename = path.basename(norm);
  if (!AUDIT_INFRA_BASENAMES.has(basename)) return false;
  // Must be DIRECTLY under top-level `scripts/` or `scripts/lib/`. The comment
  // has said this since the function was written; the code only checked
  // `startsWith('scripts/')`, so any file anywhere under scripts/ sharing a
  // basename was classified as audit infrastructure and silently excluded from
  // every audit. Measured 2026-08-13: 9 tracked files were misclassified this
  // way — `scripts/lib/persona-test/schemas.mjs`, `scripts/lib/requirements/ledger.mjs`
  // and siblings, which are unrelated modules that merely share a basename with
  // the audit's own `scripts/lib/schemas.mjs` / `ledger.mjs`. They were
  // unauditable by accident, which is a coverage hole rather than a safeguard.
  const parts = norm.split('/');
  const directlyUnderScripts = parts.length === 2 && parts[0] === 'scripts';
  const directlyUnderScriptsLib = parts.length === 3 && parts[0] === 'scripts' && parts[1] === 'lib';
  return directlyUnderScripts || directlyUnderScriptsLib;
}

// ── Context Assembly ──────────────────────────────────────────────────────

/** Max file size to read into memory (2MB). Larger files are skipped entirely. */
export const MAX_FILE_SIZE = 2 * 1024 * 1024;

/**
 * Safely read a file with all boundary checks: sensitive filter, symlink-aware
 * containment, size guard, and error recovery.
 * Returns { content, absPath } on success, null on skip (with reason).
 * @param {string} relPath - Relative file path
 * @param {string} cwdBoundary - Resolved CWD for containment check
 * @returns {{ content: string, absPath: string } | null}
 */
export function safeReadFile(relPath, cwdBoundary) {
  if (isSensitiveFile(relPath)) return null;
  const absPath = path.resolve(relPath);
  let realPath;
  try { realPath = fs.realpathSync(absPath); } catch { return null; }
  const rel = path.relative(cwdBoundary, realPath);
  if (rel.startsWith('..' + path.sep) || rel.startsWith('../') || rel === '..' || path.isAbsolute(rel)) return null;
  try {
    // stat and read the REALPATH — the path whose containment was just verified.
    // Using `absPath` here reopened the symlink, so a link swapped between the
    // realpathSync above and these calls resolved somewhere else entirely and the
    // containment check governed a different file than the one read (TOCTOU).
    // `absPath` is still returned as the caller-facing identity: it is the path
    // the audit was asked about, and callers use it for display and dedup.
    const stat = fs.statSync(realPath);
    if (!stat.isFile() || stat.size > MAX_FILE_SIZE) return null;
    return { content: fs.readFileSync(realPath, 'utf-8'), absPath };
  } catch {
    return null;
  }
}

/**
 * Read file contents as markdown code blocks, with safety guards:
 * - Sensitive file exclusion (full-path matching)
 * - Path containment (rejects ../ escapes)
 * - Per-file error recovery (race conditions, permissions)
 * - Size guard (skip files > 2MB)
 * - Content-level secret redaction (default ON — see `redact` below)
 * @param {string[]} filePaths
 * @param {object} opts
 * @param {number} [opts.maxPerFile=10000]
 * @param {number} [opts.maxTotal=120000]
 * @param {boolean} [opts.redact=true] - Redact secret-shaped content (via
 *   `sensitive-egress-gate.mjs::redactSecrets`, the fail-closed wrapper)
 *   before truncation. Path-level filtering (`isSensitiveFile`) only ever
 *   caught known-sensitive FILES; this catches a secret-shaped string
 *   *inside* an otherwise-ordinary file (a CI workflow's test-container
 *   password, a `.env.example` placeholder, etc.) — see
 *   docs/plans/discovery-portfolio-secret-redaction.md. Defaults to `true`
 *   (safe by default); `buildRedactedAuditContext` (below) is the one
 *   caller with a documented reason to opt out.
 * @returns {string}
 */
/**
 * Characters a single redaction may remove before it counts as a SPAN COLLAPSE
 * rather than a token mask. Masking the longest single-token pattern costs well
 * under this; only a multi-line span (`pem-private-key`) exceeds it, and only a
 * span can hide code from a reviewer.
 */
const SPAN_COLLAPSE_CHARS = 200;

export function readFilesAsContextDetailed(filePaths, { maxPerFile = 10000, maxTotal = 120000, redact = true } = {}) {
  let total = '';
  let omitted = 0;
  let sensitive = 0;
  /** Files where redaction collapsed a SPAN (not just masked a token). */
  const shortened = [];

  /**
   * What this render DROPPED. Every field is measured here, at the only place
   * that can see it: a caller holding the returned string cannot distinguish a
   * complete render from one that head-cut the very code it was asked about.
   * @see readFilesAsContext (the string-only wrapper, unchanged bytes)
   */
  const stats = {
    requested: filePaths.length,
    maxPerFile,
    maxTotal,
    /** Rendered untruncated — the file, whole. */
    full: [],
    /** Rendered but HEAD-CUT at maxPerFile: `{path, charsOnDisk, charsRendered}`. */
    headTruncated: [],
    /** Never rendered: the maxTotal budget was already spent. */
    budgetOmitted: [],
    /** Never rendered: missing, over MAX_FILE_SIZE, unreadable, or outside the repo. */
    unreadable: [],
    /** Never rendered: path-level sensitive classification. */
    sensitiveExcluded: [],
    /** Rendered, but redaction collapsed a span: `{path, charsLost}`. */
    redactionShortened: shortened,
    charsRendered: 0,
    charsOnDisk: 0,
  };

  const cwdBoundary = path.resolve('.');

  for (const relPath of filePaths) {
    if (isSensitiveFile(relPath)) { sensitive++; stats.sensitiveExcluded.push(relPath); continue; }

    const result = safeReadFile(relPath, cwdBoundary);
    if (!result) { omitted++; stats.unreadable.push(relPath); continue; }
    // Redact BEFORE truncating: truncation can otherwise cut a secret's
    // match mid-way, leaving an un-matchable (and un-redacted) partial
    // fragment in the retained prefix.
    const raw = redact ? redactSecrets(result.content) : result.content;

    // Redaction can COLLAPSE a span, not just mask a token — a multi-line match
    // (`pem-private-key`) replaces everything it covers with one placeholder. So
    // the text under review can be structurally different from the file on disk,
    // and nothing said so. Observed 2026-07-19: a test file lost ~80 lines this
    // way and three reviewers confidently reported it as syntactically broken —
    // correctly, for the input they were given.
    //
    // CHARACTER delta, not line delta. `redactSecrets` is deliberately
    // line-count-preserving (secret-patterns.mjs: it re-appends the newlines a
    // span contained, so diff-hunk line mapping stays aligned), so a line-count
    // check can never fire — it would be dead code that reads as a working
    // guard. Characters are what actually disappear.
    //
    // The threshold separates the two shapes: masking a token costs tens of
    // characters (`ghp_…` → `[REDACTED:github-pat]`), while collapsing a span
    // costs hundreds or thousands. Only the latter can hide code, so only the
    // latter is worth interrupting a reviewer over.
    const charsLost = redact ? result.content.length - raw.length : 0;
    if (charsLost > SPAN_COLLAPSE_CHARS) shortened.push({ path: relPath, charsLost });

    const ext = relPath.split('.').pop();
    const lang = { sql: 'sql', css: 'css', html: 'html', md: 'markdown', json: 'json', py: 'python', rs: 'rust', go: 'go', java: 'java', rb: 'ruby', sh: 'bash' }[ext] ?? 'js';
    const headCut = raw.length > maxPerFile;
    const content = headCut
      ? raw.slice(0, maxPerFile) + `\n... [TRUNCATED — ${raw.length} chars total]`
      : raw;
    const redactionNote = charsLost > SPAN_COLLAPSE_CHARS
      ? `> ⚠ REDACTION REMOVED CONTENT FROM THIS FILE: ${charsLost} characters were removed by secret-redaction `
        + 'before review. The text above is NOT byte-identical to the file on disk — a multi-line '
        + 'secret match collapses everything it spans into one placeholder. Do NOT report syntax '
        + 'errors, unbalanced delimiters, or missing code in this file; verify against disk first.\n'
      : '';
    const block = `### ${relPath}\n\`\`\`${lang}\n${content}\n\`\`\`\n${redactionNote}`;

    if (total.length + block.length > maxTotal) { omitted++; stats.budgetOmitted.push(relPath); continue; }
    total += block;
    stats.charsOnDisk += result.content.length;
    if (headCut) stats.headTruncated.push({ path: relPath, charsOnDisk: result.content.length, charsRendered: maxPerFile });
    else stats.full.push(relPath);
  }

  if (omitted > 0) total += `\n... [${omitted} file(s) omitted — context budget reached]\n`;
  if (sensitive > 0) total += `\n... [${sensitive} sensitive file(s) excluded (.env, secrets, keys)]\n`;
  if (shortened.length > 0) {
    // Operator-facing as well as model-facing: the inline note reaches the model,
    // this reaches the human watching the run — the one who can check disk.
    const detail = shortened.map((s) => `${s.path} (-${s.charsLost} chars)`).join(', ');
    process.stderr.write(`  [audit-scope] WARNING: redaction shortened ${shortened.length} file(s) sent for review: ${detail}\n`);
    total += `\n... [${shortened.length} file(s) SHORTENED by secret-redaction before review: ${detail}]\n`;
  }
  stats.charsRendered = total.length;
  return { context: total, stats };
}

/**
 * String-only wrapper. Byte-identical to the detailed variant by construction
 * (one implementation, one render) — every historical caller keeps its bytes.
 */
export function readFilesAsContext(filePaths, opts = {}) {
  return readFilesAsContextDetailed(filePaths, opts).context;
}

/**
 * Fold two sequential renders into one stats record, for callers that render in
 * tiers (changed files first, ambient context second) against a shared budget.
 * `null` operands pass through, so an unmeasured render never silently becomes
 * a measured-and-clean one.
 */
export function mergeCodeRenderStats(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return {
    requested: a.requested + b.requested,
    maxPerFile: Math.max(a.maxPerFile, b.maxPerFile),
    maxTotal: a.maxTotal,
    full: [...a.full, ...b.full],
    headTruncated: [...a.headTruncated, ...b.headTruncated],
    budgetOmitted: [...a.budgetOmitted, ...b.budgetOmitted],
    unreadable: [...a.unreadable, ...b.unreadable],
    sensitiveExcluded: [...a.sensitiveExcluded, ...b.sensitiveExcluded],
    redactionShortened: [...a.redactionShortened, ...b.redactionShortened],
    charsRendered: a.charsRendered + b.charsRendered,
    charsOnDisk: a.charsOnDisk + b.charsOnDisk,
  };
}

// ── Egress-scoped context producer (model-A/B/C harness — decision 11) ──────
//
// THE single upstream step that produces the context the generation shadow
// consumes. Sensitive FILES are already excluded by readFilesAsContext
// (isSensitiveFile), so no arm ever re-reads a raw path — the shadow's
// signature takes this output, never file paths, making egress bypass
// structurally impossible. A final secret-pattern SCAN over the assembled text
// (an in-allowlist file may still hardcode a key) reports whether the context
// is egress-safe.
//
// NOTE despite the name: this does NOT redact an in-file secret-shaped match —
// it only FLAGS it (egressSafe:false, egressPatterns:[...]). The caller/adapter
// must refuse to send via assertEgressSafe rather than auto-scrub-and-send (see
// sensitive-egress-gate.mjs: "refuse rather than silently scrub-and-send to a
// new provider"). File-level exclusion happens ONCE here and the same object
// is shared by baseline + all arms — that's the "redact-once" in decision 11.
//
// `redact: false` is explicit and deliberate (docs/plans/discovery-portfolio-secret-redaction.md):
// `readFilesAsContext` now defaults to `redact: true` for every OTHER caller,
// but this function's whole contract is scanning genuinely unredacted content
// to correctly flag it for the model-A/B/C fairness harness (decision 11) —
// applying the new default here would silently break that contract.
//
// @param {string[]} filePaths
// @param {object} [opts] - forwarded to readFilesAsContext (maxPerFile, maxTotal)
// @returns {{ context: string, fileCount: number, egressSafe: boolean, egressPatterns: string[] }}
export function buildRedactedAuditContext(filePaths, opts = {}) {
  const context = readFilesAsContext(filePaths || [], { ...opts, redact: false });
  const { safe, patterns } = scanEgressPayload(context);
  return { context, fileCount: (filePaths || []).length, egressSafe: safe, egressPatterns: patterns };
}

// ── File Classification ─────────────────────────────────────────────────────

/**
 * Classify files as backend, frontend, or shared.
 * @param {string[]} filePaths
 * @returns {{backend: string[], frontend: string[], shared: string[]}}
 */
export function classifyFiles(filePaths) {
  const backend = [];
  const frontend = [];
  const shared = [];

  const fePatterns = [/^public\//, /\/css\//, /\/html\//, /\.css$/, /\.html$/, /\/components\//];
  const sharedPatterns = [/\/config\//, /\/schemas\//, /\/types\//, /\/shared\//, /\.json$/];

  for (const p of filePaths) {
    if (fePatterns.some(rx => rx.test(p))) {
      frontend.push(p);
    } else if (sharedPatterns.some(rx => rx.test(p))) {
      shared.push(p);
    } else {
      backend.push(p);
    }
  }

  return { backend, frontend, shared };
}

/**
 * A1 guard — "audit your success paths" applied to the auditor ITSELF. Returns a
 * refusal message when a code audit would read ZERO implementation (subject) files,
 * else null. A scoped audit whose scope matched none of the plan's files — or a plan
 * whose referenced paths don't exist on disk — would otherwise run all passes over an
 * empty "All Implementation Files" block and emit a CONFIDENT-but-HOLLOW verdict
 * (worse than no auditor: it looks authoritative). `full` scope reads the repo broadly
 * and is exempt. `shared` files are context, not the subject, so they don't count.
 *
 * @param {object} a
 * @param {string|null} a.scopeMode - 'diff' | 'plan' | 'full' | null
 * @param {number} a.subjectFileCount - count of backend+frontend(+routes/services) files that will be read
 * @param {boolean} a.hasFileFilter - whether a --changed/diff scope is active
 * @param {number} [a.foundCount] - plan-referenced files that exist on disk
 * @param {number} [a.referencedCount] - total paths referenced by the plan
 * @returns {string|null} refusal message, or null when the audit may proceed
 */
export function auditSubjectFileGuard({ scopeMode, subjectFileCount, hasFileFilter, foundCount = 0, referencedCount = 0 }) {
  if (scopeMode === 'full' || subjectFileCount > 0) return null;
  // The remediation hint names `--files`, NOT `--changed`. Until 2026-08-13 it
  // said "Pass `--changed <files>` explicitly", which is the flag that CANNOT
  // fix a scope problem: `--changed` is the R2+ impact set (reopen detection),
  // and the audited file set is `--files` (or, absent it, the git recompute).
  // This message is read at the exact moment an operator is repairing scope, so
  // sending them to the inert flag was the highest-leverage instance of the
  // wrong-flag defect. See docs/plans/cycle-cluster-audit-scope.md KD-1b.
  const hint = hasFileFilter
    ? `the scope matched none of the plan's ${foundCount} referenced file(s) on disk. Pass \`--files <list>\` (the allowlist — it overrides --scope), or \`--scope=plan|full\`.`
    : `the plan referenced no implementation files that exist on disk (0 of ${referencedCount} resolved). Check the plan's file paths, or pass \`--files <list>\`.`;
  return `audit aborted — 0 implementation files reached the prompt; refusing to emit a verdict over code that was never read. ${hint}`;
}

/**
 * Resolve which files a code audit will actually read, and say WHERE that
 * decision came from.
 *
 * Extracted from `openai-audit.mjs`'s `main()` (2026-08-13) because the branch
 * it encodes is the load-bearing premise of `/cycle`'s per-cluster audit and was
 * previously untestable inline. The premise: **an explicit `--files` allowlist
 * wins, and suppresses the working-tree recompute entirely.** Without it, a
 * per-cluster audit on a tree shared with a concurrent session silently widens
 * to that session's files — measured 2026-08-13 at 52 files against 11 declared.
 *
 * Pure: no fs, no git, no process, no cwd. The caller runs the git block when
 * told to.
 *
 * @param {object} a
 * @param {string[]|null} a.fileFilter — explicit `--files` allowlist, or null
 * @param {string|null} a.scopeMode — 'diff' | 'plan' | 'full' | null
 * @param {string[]} [a.excludePatterns] — `--exclude-paths` / `.auditignore` globs
 * @param {(files: string[], patterns: string[]) => string[]} [a.applyExclusions]
 *   — injected so this module needs no glob dependency; omit to skip exclusions
 * @returns {{files: string[]|null, source: 'allowlist'|'diff-recompute'|'none'}}
 */
export function resolveEffectiveScope({ fileFilter, scopeMode, excludePatterns = [], applyExclusions } = {}) {
  if (Array.isArray(fileFilter) && fileFilter.length > 0) {
    // De-duplicate, preserving first-seen order — a caller repeating a path must
    // not inflate the count the admission comparison is made against.
    const deduped = [...new Set(fileFilter)];
    const files = (excludePatterns.length > 0 && typeof applyExclusions === 'function')
      ? applyExclusions(deduped, excludePatterns)
      : deduped;
    // An allowlist emptied by exclusions stays `allowlist` with `files: []`.
    // Degrading it to a working-tree recompute here would resurrect the exact
    // widening this function exists to prevent; the empty result is caught
    // downstream by auditSubjectFileGuard, which refuses a zero-subject run.
    return { files, source: 'allowlist' };
  }
  if (scopeMode === 'diff') return { files: null, source: 'diff-recompute' };
  return { files: null, source: 'none' };
}
