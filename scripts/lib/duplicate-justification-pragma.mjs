/**
 * @fileoverview Single source of truth for the `@duplicate-justification`
 * pragma — the regex, AND a full-repo discovery sweep. Lives here
 * (`scripts/lib/`, `shared-lib` domain) rather than in either of its two
 * consumers' own domains (arch-drift-duplication-cleanup plan, Gemini
 * plan-gate G2): `stale-pragma-sweep.mjs` (`arch-memory`) and
 * `duplication-detector.mjs` (`audit-orchestration`) both need it, and
 * direct verification of `.audit-loop/domain-map.json` showed NEITHER
 * `arch-memory -> audit-orchestration` NOR the reverse is a declared
 * `allowedDeps` edge — a prior draft of this fix relocated the regex INTO
 * one of those two domains and had the other import from it, which just
 * moved the undeclared edge rather than removing it. `shared-lib` is the
 * only placement both consumers are already allowed to depend on.
 *
 * `findRepoPragmas` extends `stale-pragma-sweep.mjs`'s pre-existing
 * `git grep` sweep pattern (full-repo, not diff-scoped) to capture the
 * FULL pragma — target file, target symbol, reason — plus the pragma's
 * own line number, so a caller can resolve which declaration it sits
 * above (the drift-exclusion write path in `refresh.mjs` needs this;
 * `findStalePragmas` only ever needed the target file).
 *
 * @module scripts/lib/duplicate-justification-pragma
 */

import { execFileSync } from 'node:child_process';

/**
 * Language-agnostic suppression pragma. Matches any of this repo's real
 * comment syntaxes (`//`, `#`, `/* *​/`, `<!-- -->`) followed by the tag —
 * Gemini round-3 G2 (original audit-code-duplication-wave plan): this repo
 * is explicitly multi-language (tests/arch-intent-adapter-{java,postgres,
 * python}.test.mjs), so a hardcoded `//` match would force a syntax error
 * in non-JS files.
 *
 * `^\s*` anchor (67f8f414/fbd71c9a): without it, pragma-shaped text
 * appearing mid-line — inside a string literal, a template literal, or
 * prose describing the pragma syntax rather than using it — still matched,
 * since the comment-marker alternation could be satisfied anywhere in the
 * line, not just at its start. Every real pragma in this repo already
 * starts the marker at column 0 or after only leading whitespace
 * (`git grep` verified), so `^\s*` costs no real coverage while closing the
 * false-positive class. This is a start-of-line-text anchor only — it
 * intentionally does NOT require the comment marker to be a `//`
 * specifically or forbid other leading characters within the marker
 * alternation itself.
 *
 * TODO(sast-sandbox-backlog-hardening.md item 6, Gemini final-review M1):
 * the target-file capture `([^\s:]+)` still cannot represent a colon in the
 * TARGET path (`target=<file>:<symbol>` uses `:` as its own delimiter) — a
 * separate, harder gap than the git-grep OUTPUT-line colon-safety item 6
 * fixed (that one had a NUL delimiter available via `git grep -z`; this
 * one's delimiter is the pragma's own human-authored `:`, so closing it
 * needs a syntax change — e.g. requiring the target be quoted — not just a
 * parser change). No known real target path contains a colon today; revisit
 * if one ever does.
 */
export const PRAGMA_RE = /^\s*(?:\/\/|#|\/\*|<!--)\s*@duplicate-justification:\s*target=([^\s:]+):([^\s]+)\s+reason=(.+?)(?:\*\/|-->)?\s*$/;

/**
 * Full-repo `git grep` sweep for `@duplicate-justification` pragmas,
 * capturing target file/symbol/reason AND the pragma's own line number.
 * Same exclusions as `findStalePragmas` (`*.md`, `tests/*`) and the same
 * best-effort degrade-to-empty-array on `git grep` failure.
 *
 * @param {string} repoRoot
 * @param {{strict?: boolean, env?: NodeJS.ProcessEnv}} [opts] - `strict: true`
 *   (round-2 H8 fix) THROWS on a real `git` failure (unavailable binary,
 *   corrupted repo/worktree, etc.) instead of degrading to `[]`. Default
 *   `false` preserves the original best-effort-report behavior
 *   (`findStalePragmas`' use case: a missed sweep just means an incomplete
 *   LOW-severity report table, never a safety gap). `refresh.mjs`'s WRITE
 *   path passes `strict: true` — there, "sweep failed" and "genuinely zero
 *   pragmas" are NOT interchangeable: `recordDuplicateJustifications` always
 *   does a full reset-then-reapply (round-1 H1), so silently treating a
 *   failed sweep as "zero pragmas" would un-flag every already-justified
 *   row on a transient `git` hiccup, wiping real data for no reason.
 *   `env`, when supplied, REPLACES the inherited `process.env` for this
 *   subprocess (2026-07-23 audit — a genuine call site the original
 *   sweep-focused audit missed, since it lives outside `tests/`).
 * @returns {{pragmaFile: string, pragmaLine: number, targetFile: string, targetSymbol: string, reason: string}[]}
 */
export function findRepoPragmas(repoRoot, { strict = false, env } = {}) {
  let output;
  try {
    // --untracked (round-2 M7 fix, empirically verified): plain `git grep`
    // only searches TRACKED files, but repo-inventory.mjs's listRepoFiles
    // (what arch:refresh actually extracts symbols from) explicitly
    // includes untracked files via `git ls-files --others --exclude-standard`
    // — without this flag, a pragma in a brand-new, not-yet-`git add`ed
    // file would be silently invisible to this sweep even though the
    // symbol it justifies IS indexed. `--exclude-standard` semantics
    // (respecting .gitignore) are inherited automatically.
    //
    // -z (round-1 audit H2/H4, sast-sandbox-backlog-hardening.md item 6):
    // NUL-delimits the filename/line/content fields instead of `:`, which is
    // BOTH a real character in POSIX filenames AND — as item 6's own first
    // colon-safety attempt missed, caught by a later audit round — can
    // reappear inside the pragma's own free-text `reason=` content (e.g.
    // "reason=see line:99:for details"), which a greedy-backtracking text
    // regex can mistake for the real filename/line delimiter. `-z` also
    // empirically disables git's default `core.quotePath` C-style escaping
    // of non-ASCII filenames (verified directly: raw UTF-8 bytes, not
    // `"caf\303\251.mjs"`). NUL cannot appear in a POSIX filename or in
    // ordinary source-line content, so splitting on it is unambiguous by
    // construction — no heuristic needed at all.
    output = execFileSync('git', ['grep', '--untracked', '-z', '-n', '-F', '@duplicate-justification:', '--', '.', ':(exclude)*.md', ':(exclude)tests/*'], {
      cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}),
    });
  } catch (err) {
    if (err.status === 1 && !err.stdout) return []; // genuine zero-match — safe either way
    if (strict) {
      const e = new Error(`[duplicate-justification-pragma] findRepoPragmas failed (git grep): ${err.message}`);
      e.code = 'PRAGMA_SWEEP_FAILED';
      throw e;
    }
    process.stderr.write(`[duplicate-justification-pragma] findRepoPragmas skipped (git grep failed: ${err.message})\n`);
    return [];
  }
  const pragmas = [];
  // Records stay `\n`-terminated even under `-z` (only the FIELD separators
  // become NUL) — split on /\r?\n/, NOT '\n', for the same CRLF-checkout
  // reason as before (a consumer repo without eol=lf checks files out CRLF,
  // so a record's trailing byte before the newline can be \r).
  for (const record of output.split(/\r?\n/)) {
    const pragma = parseGitGrepPragmaRecord(record);
    if (pragma) pragmas.push(pragma);
  }
  return pragmas;
}

/**
 * Parse one `git grep -z -n` output record into a pragma, or `null` if it
 * doesn't contain a `@duplicate-justification` pragma. Factored out of
 * `findRepoPragmas` (item 6 — sast-sandbox-backlog-hardening.md) so the
 * pure parsing grammar is unit-testable without spawning git or touching a
 * real filesystem — notably including POSIX filenames containing colons or
 * non-ASCII characters, which this repo's own development platform
 * (Windows/NTFS) cannot construct as an actual fixture file.
 *
 * Handles BOTH observed "-z -n" record shapes (round-2 audit H1/H2 raised
 * this as a cross-version git behavior question): filename, NUL, line
 * number, NUL, content (two NUL separators total -- empirically confirmed
 * via direct byte inspection against git 2.54 on this platform, reading the
 * raw child-process output as a JSON string and observing two literal NUL
 * escapes), and the more conservative filename, NUL, line number, colon,
 * content (one NUL total, matching git's own general --null documentation:
 * "output NUL instead of the character that normally follows a file name")
 * in case another git version/platform this repo syncs to behaves the
 * documented-conservative way. Either shape parses unambiguously: the line
 * field is always a pure run of digits immediately after the first NUL, so
 * the boundary right after those digits -- NUL in the two-separator shape,
 * or a colon in the one-separator shape -- is found by anchoring on where
 * the digit run ends, not by scanning for a colon anywhere in the record.
 *
 * @param {string} record
 * @returns {{pragmaFile: string, pragmaLine: number, targetFile: string, targetSymbol: string, reason: string}|null}
 */
export function parseGitGrepPragmaRecord(record) {
  if (!record) return null;
  const firstNul = record.indexOf('\0');
  if (firstNul === -1) return null;
  const pragmaFile = record.slice(0, firstNul);
  const afterFile = record.slice(firstNul + 1);
  // The line field is always pure digits (git's own -n output). Whichever
  // separator immediately follows those digits — NUL (two-NUL shape) or ':'
  // (one-NUL shape) — is the real field boundary; a colon appearing LATER,
  // inside the content, is never mistaken for it because this match is
  // anchored at the digit run's own end via \d+, not found by scanning.
  const lineMatch = afterFile.match(/^(\d+)[\0:]/);
  if (!lineMatch) return null;
  const lineField = lineMatch[1];
  const text = afterFile.slice(lineMatch[0].length);
  const match = PRAGMA_RE.exec(text);
  if (!match) return null;
  const [, targetFile, targetSymbol, reason] = match;
  // Same placeholder/template guard as findStalePragmas — a docs-prose or
  // instructional-string interpolation, not a real pragma on a real
  // declaration. No real file path contains these characters.
  if (/[<>${}]/.test(targetFile)) return null;
  return { pragmaFile, pragmaLine: Number(lineField), targetFile, targetSymbol, reason: reason.trim() };
}

/** How many lines a pragma may sit above the declaration it justifies before
 * being treated as unresolvable rather than mis-attached — matches
 * `findPragmaAbove`'s own documented "up to 3 lines above" convention
 * (`scripts/lib/audit/duplication-detector.mjs`), plus slack for a
 * multi-line JSDoc block between the pragma and its declaration. */
export const PRAGMA_RESOLUTION_MAX_GAP_LINES = 5;

/**
 * Resolve each full-repo pragma (from `findRepoPragmas`) to the
 * `definition_id` of the declaration it sits immediately above — the
 * pragma-BEARING declaration, not the named `target` (arch-drift-
 * duplication-cleanup, round-1 H2: a `symbol_index` row belongs to exactly
 * one cluster by construction, so excluding the annotated row is
 * unambiguous; `target`/`reason` persist as audit-trail fields only).
 *
 * Algorithm (round-2 H2, concrete): for each pragma, among `candidates` in
 * the SAME file, pick the one with the smallest `startLine` strictly
 * greater than `pragmaLine` — the very next declaration, no scanning
 * range — rejecting the match if the gap exceeds
 * `PRAGMA_RESOLUTION_MAX_GAP_LINES`.
 *
 * Ambiguity guard (round-2 M1, tightened round-5 M5): at most one pragma
 * per declaration is the documented convention. If multiple distinct
 * pragma lines resolve to the SAME `definitionId`, NONE of them is
 * trusted — all go to `ambiguous`, none to `resolved` — rather than the
 * earlier draft's "last one wins" compromise, which silently EXCLUDED a
 * declaration from the drift score based on an unreliable signal (a
 * violated authoring convention). This matches the plan's own stated
 * principle: fail toward MORE findings shown, never fewer, on ambiguity.
 *
 * @param {{pragmaFile: string, pragmaLine: number, targetFile: string, targetSymbol: string, reason: string}[]} pragmas
 * @param {{filePath: string, symbolName: string, kind: string, startLine: number, definitionId: string}[]} candidates
 *   Every candidate declaration in THIS refresh with a resolvable `definitionId`.
 *   `filePath` must already be in the same repo-relative, forward-slash-
 *   normalised form `findRepoPragmas`' `pragmaFile` uses (both derive from
 *   the same `path.relative(repoRoot, abs).replace(/\\/g, '/')` convention
 *   used elsewhere in the extraction pipeline — no second normaliser here).
 * @returns {{
 *   resolved: {definitionId: string, reason: string, target: string, source: string}[],
 *   ambiguous: {pragmaFile: string, pragmaLine: number, definitionId: string}[],
 *   unresolved: {pragmaFile: string, pragmaLine: number}[],
 * }}
 */
export function resolvePragmasToDefinitions(pragmas, candidates) {
  const byFile = new Map();
  for (const c of candidates) {
    if (!c.definitionId) continue;
    if (!byFile.has(c.filePath)) byFile.set(c.filePath, []);
    byFile.get(c.filePath).push(c);
  }

  const byDefinitionId = new Map(); // definitionId -> [{pragma, definitionId}]
  const unresolved = [];

  for (const pragma of pragmas) {
    const inFile = byFile.get(pragma.pragmaFile) || [];
    let best = null;
    for (const c of inFile) {
      const gap = c.startLine - pragma.pragmaLine;
      if (gap <= 0 || gap > PRAGMA_RESOLUTION_MAX_GAP_LINES) continue;
      if (!best || c.startLine < best.startLine) best = c;
    }
    if (!best) { unresolved.push({ pragmaFile: pragma.pragmaFile, pragmaLine: pragma.pragmaLine }); continue; }
    if (!byDefinitionId.has(best.definitionId)) byDefinitionId.set(best.definitionId, []);
    byDefinitionId.get(best.definitionId).push({ pragma, definitionId: best.definitionId });
  }

  const resolved = [];
  const ambiguous = [];
  for (const [definitionId, entries] of byDefinitionId) {
    if (entries.length === 1) {
      const only = entries[0];
      resolved.push({
        definitionId,
        reason: only.pragma.reason,
        target: `${only.pragma.targetFile}:${only.pragma.targetSymbol}`,
        source: `${only.pragma.pragmaFile}:${only.pragma.pragmaLine}`,
      });
      continue;
    }
    // round-5 M5 fix: a genuinely ambiguous declaration (>1 pragma) trusts
    // NEITHER — every entry is reported as ambiguous, none is applied.
    for (const e of entries) {
      ambiguous.push({ pragmaFile: e.pragma.pragmaFile, pragmaLine: e.pragma.pragmaLine, definitionId });
    }
  }

  return { resolved, ambiguous, unresolved };
}
