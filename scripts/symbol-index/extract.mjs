#!/usr/bin/env node
/**
 * @fileoverview Phase B.1 — symbol extractor.
 *
 * Uses **ts-morph** for intra-file symbol extraction (functions, classes,
 * components, hooks) per spike S1; **dependency-cruiser** for the file-to-file
 * import graph + layering rules.
 *
 * Routes every candidate through `sensitive-egress-gate.mjs` BEFORE capturing
 * body text. Sensitive-by-path files are skipped; non-allowlisted-extension
 * files emit no symbol records.
 *
 * Emits:
 *   - One `{type: "symbol", ...}` JSON line per extracted symbol on stdout
 *   - One `{type: "violation", ...}` JSON line per dep-cruiser layering violation
 *   - One `{type: "summary", counts: {...}}` line at end
 *
 * @module scripts/symbol-index/extract
 */

import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Project, ts } from 'ts-morph';
import { cruise } from 'dependency-cruiser';
import { signatureHash } from '../lib/symbol-index.mjs';
import {
  // gateSymbolForEgress no longer needed at call sites — file-level
  // enforcement is hoisted via resolveAndClassify (Gemini-G2 WS-CANON
  // fix). The gate remains the single seam other callers can use.
  isExtensionAllowlisted,
  containsSecrets,
  redactSecrets,
  SECRET_REDACTED,
} from '../lib/sensitive-egress-gate.mjs';
import { shouldSkipForIndexing, formatSkipLog, resolveAndClassify } from '../lib/sensitive-paths.mjs';
import { isThinDelegate } from '../lib/symbol-index/thin-delegate.mjs';
import {
  eligibleFiles,
  assessExtractionCoverage,
  assertExtractionExhaustive,
} from '../lib/symbol-index/graph-coverage.mjs';
import { COVERAGE_DEFAULTS } from '../lib/symbol-index/graph-verdict.mjs';
import { parseFilesManifest } from '../lib/symbol-index/files-manifest.mjs';
import { emit, assertKnownFlags } from '../lib/cli-io.mjs';

/**
 * Every flag this CLI accepts. `assertKnownFlags` rejects anything else.
 *
 * **An entry here is a claim that the parser below does something with it** —
 * the lesson refresh-args.mjs records verbatim. `--since-commit` used to be
 * parsed into `args.sinceCommit` and then read by nothing at all; it is
 * removed rather than listed, because a flag that is accepted and ignored is
 * the exact bug this allowlist exists to prevent. No caller passed it (the
 * only two production callers, refresh-subprocess.mjs and
 * duplication-detector.mjs, spawn this script with `--root`/`--mode`/
 * `--files-from`/`--include-delegates`).
 */
export const KNOWN_FLAGS = Object.freeze([
  '--root', '--files', '--files-from', '--mode', '--include-delegates',
]);

/** `--mode` is validated against this, not accepted free-form. */
const KNOWN_MODES = Object.freeze(['full', 'incremental']);

/**
 * Resolve a flag's value from either the inline (`--flag=value`) or the
 * space-separated (`--flag value`) form.
 *
 * The space-separated form still rejects a value that looks like another flag
 * (round-1 L1, symbol-index-pipeline-reliability-hardening): without it,
 * `extract.mjs --files --mode incremental` silently consumed `--mode` as the
 * files value and left mode at its default. That guard cannot distinguish a
 * missing value from a legitimate path that begins with `--`, so the inline
 * form is the escape hatch for one (`--files-from=--weird-name.txt`), exactly
 * as refresh-args.mjs resolves the same tension.
 *
 * @returns {{value: string, consumedNext: boolean}}
 */
function takeFlagValue(argv, i, flagName, inlineValue) {
  if (inlineValue !== null) {
    if (inlineValue === '') {
      throw new Error(`${flagName} requires a non-empty value (got ${flagName}=)`);
    }
    return { value: inlineValue, consumedNext: false };
  }
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(
      `${flagName} requires a non-empty value (got ${JSON.stringify(value ?? null)}). `
      + `If the value legitimately begins with "--", use the inline form: ${flagName}=<value>.`,
    );
  }
  return { value, consumedNext: true };
}

/**
 * Parse argv into the extraction scope.
 *
 * **Scope is resolved ONCE, after the loop, never by assignment order** (H1/M1,
 * audit-code-manifest round 1). `--files` and `--files-from` both used to write
 * the same `args.files` field as they were encountered, so the documented
 * "--files-from takes precedence" was actually whichever appeared LAST:
 * `extract.mjs --files-from intended.manifest --files stale.js` silently
 * indexed the wrong subset. They now parse into separate fields and supplying
 * both is a hard error — there is no precedence rule left to get wrong, and no
 * production caller passes both.
 *
 * The `files` contract downstream is three-valued and must stay that way:
 * `null` = no restriction (full walk), `[]` = a real zero-file scope,
 * non-empty = that exact list. See `isFullRunFromFiles`/`b021576b`.
 */
function parseArgs(argv) {
  // Reject unknown flags BEFORE any work. Without this the if/else chain had no
  // `else`, so a misspelled scope flag (`--files-form <manifest>`) was dropped
  // whole and `files` stayed `null` — silently promoting a restricted
  // incremental run to an unrestricted full walk (M2).
  assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'extract' });

  const args = { root: process.cwd(), files: null, mode: 'full', includeDelegates: false };
  let filesInline = null;     // from --files
  let filesFromPath = null;   // from --files-from; read AFTER the loop, not during

  // Repeating one flag was still last-wins after the cross-flag fix (shadow
  // `a9ff15b5`) — `--files-from intended --files-from stale` silently used
  // `stale`. That is the same defect as the two-flag case, one scope narrower,
  // so it gets the same answer: refuse rather than pick. No precedence rule
  // means no precedence rule to get wrong.
  const seen = new Set();
  const claimOnce = (flag) => {
    if (seen.has(flag)) {
      throw new Error(`${flag} was supplied more than once — the effective value would depend on argument order. Pass it exactly once.`);
    }
    seen.add(flag);
  };

  for (let i = 2; i < argv.length; i++) {
    let a = argv[i], inlineValue = null;
    // POSIX `--` terminator: assertKnownFlags stops validating here, so this
    // parser must honour the same boundary or a positional `--files` after it
    // would be matched as a real flag.
    //
    // But this CLI accepts NO positional operands, so everything after `--`
    // would then be neither validated nor consumed — silently discarded, which
    // is the same fail-open shape as the unknown-flag bug above (shadow
    // eec32c6e). Refuse instead: the terminator is honoured (a following
    // `--files` is not treated as a flag) AND nothing is silently dropped.
    if (a === '--') {
      const trailing = argv.slice(i + 1);
      if (trailing.length > 0) {
        throw new Error(
          `extract: no positional operands are accepted, but ${trailing.length} token(s) follow "--" `
          + `(${JSON.stringify(trailing.slice(0, 3))}${trailing.length > 3 ? ', …' : ''}). `
          + 'Pass files via --files or --files-from.',
        );
      }
      break;
    }
    const eq = a.indexOf('=');
    if (eq !== -1) { inlineValue = a.slice(eq + 1); a = a.slice(0, eq); }

    switch (a) {
      case '--root': {
        claimOnce('--root');
        const { value, consumedNext } = takeFlagValue(argv, i, '--root', inlineValue);
        if (consumedNext) i++;
        args.root = value;
        break;
      }
      case '--files': {
        claimOnce('--files');
        // Comma-separated, and comma is legal in a POSIX filename — so this
        // route CANNOT represent every valid path (M4). It is kept as the
        // convenience form for hand invocation; `--files-from` is the lossless
        // one and the only route any production caller uses. An empty record is
        // now an error rather than being dropped by `.filter(Boolean)`, so a
        // malformed list is diagnosed instead of silently shortened.
        const { value, consumedNext } = takeFlagValue(argv, i, '--files', inlineValue);
        if (consumedNext) i++;
        const parts = value.split(',');
        if (parts.some((p) => p === '')) {
          throw new Error(
            `--files contains an empty entry (got ${JSON.stringify(value)}). `
            + 'A path containing a comma cannot be expressed here — use --files-from <manifest>, '
            + 'which is NUL-framed and lossless.',
          );
        }
        filesInline = parts;
        break;
      }
      case '--files-from': {
        claimOnce('--files-from');
        // NUL-delimited manifest of files. Used by refresh.mjs for incremental
        // runs so a large touched-file list never hits the OS argv length limit
        // (Windows ENAMETOOLONG at ~1600+ files).
        //
        // The framing is NUL (git -z style), not newline, and the format lives
        // in ONE module shared with both producers — see files-manifest.mjs for
        // why (topicIds c191e74d781b/395e92881aa4: the retired newline +
        // `.trim()` format was the only lossy hop in an otherwise NUL-clean
        // chain, and it silently dropped files from the extraction scope).
        const { value, consumedNext } = takeFlagValue(argv, i, '--files-from', inlineValue);
        if (consumedNext) i++;
        // Record the PATH only — the read happens after the loop. Doing I/O
        // here made a missing/unreadable manifest surface as a raw ENOENT
        // stack before the both-supplied check had run, so an invocation wrong
        // in two ways reported the less informative of the two.
        filesFromPath = value;
        break;
      }
      case '--mode': {
        claimOnce('--mode');
        const { value, consumedNext } = takeFlagValue(argv, i, '--mode', inlineValue);
        if (consumedNext) i++;
        if (!KNOWN_MODES.includes(value)) {
          throw new Error(`--mode must be one of ${KNOWN_MODES.join('|')} (got ${JSON.stringify(value)})`);
        }
        args.mode = value;
        break;
      }
      case '--include-delegates':
        claimOnce('--include-delegates');
        if (inlineValue !== null) throw new Error(`--include-delegates does not take a value; got --include-delegates=${inlineValue}`);
        args.includeDelegates = true;
        break;
    }
  }

  // Argument-shape validation runs BEFORE any filesystem access, so a usage
  // error is always reported as a usage error.
  if (filesFromPath !== null && filesInline !== null) {
    throw new Error(
      '--files and --files-from are mutually exclusive — supplying both made the effective '
      + 'scope depend on argument order. Pass only one (--files-from is the lossless route).',
    );
  }
  if (filesFromPath === null) {
    args.files = filesInline;
    return args;
  }
  // Wrap the read so a missing/unreadable manifest is a CLI diagnostic naming
  // the flag and path, not a bare Node stack from inside a child process.
  let raw;
  try {
    raw = fs.readFileSync(filesFromPath, 'utf-8');
  } catch (err) {
    throw new Error(`--files-from: cannot read manifest ${filesFromPath} (${err.code || err.message})`, { cause: err });
  }
  args.files = parseFilesManifest(raw, filesFromPath);
  return args;
}


function emitProgress(msg) {
  process.stderr.write(`  [extract] ${msg}\n`);
}

/**
 * The single per-file admission decision: sensitive/generated-noise/drift-
 * exempt path skip, canonical (symlink-resolved) sensitivity + escape check,
 * extension allowlist, and the size cap — in that order, all before any
 * ts-morph read. Fail-closed with NO fallback to the pre-resolution path
 * (D4, resolves round-1 H6): a resolution failure, an escaped symlink, or a
 * canonical-sensitive target is refused outright, never re-tried against the
 * unresolved `abs` path.
 *
 * The extension gate runs on the CANONICAL path (`cls.canonical`), never the
 * raw `rel` — closing the symlink-bypass gap where a lexically-safe name
 * could point at a canonical target of a different (or no) extension. This
 * is the one behavior change from the pre-decomposition code (which checked
 * the extension on `rel`, before canonical resolution even ran).
 *
 * `classify` defaults to the real resolveAndClassify but is injectable —
 * mirrors the `beatFn` pattern Phase 1 established for runWithHeartbeat, so
 * a test can stub canonical-path resolution without a real filesystem
 * symlink fixture (round-2 M1).
 *
 * @param {string} abs - absolute path
 * @param {{repoRoot: string, classify?: typeof resolveAndClassify}} ctx
 * @returns {{admitted: boolean, rel: string, reason?: string, canonicalPath?: string, size?: number, cls?: object, lexicalSkip?: object, error?: Error}}
 */
function admitFile(abs, { repoRoot, classify = resolveAndClassify }) {
  const rel = path.relative(repoRoot, abs).replace(/\\/g, '/');

  // Lexical skip covers categories `resolveAndClassify` does not: generatedNoise
  // and driftExempt (it only ever resolves/reports `sensitive`). In incremental
  // mode this is defence-in-depth (refresh.mjs already filtered the diff); in
  // full mode (no --files restriction) this IS the discovery filter — the same
  // skip policy applies to both modes (plan §6 WS3 R3-H3).
  const lexicalSkip = shouldSkipForIndexing(rel, ['sensitive', 'generatedNoise', 'driftExempt']);
  if (lexicalSkip.skip) {
    return { admitted: false, rel, reason: 'lexical-skip', lexicalSkip };
  }

  // WS-CANON (Gemini-G2 fix): canonical-path resolution happens ONCE per
  // file, BEFORE ts-morph reads the file into memory — resolve once, skip
  // the entire file if sensitive / escaped / unresolvable, AND feed ts-morph
  // the canonical path so we read exactly what the gate approved.
  const cls = classify(rel, { repoRoot });
  if (cls.resolutionFailed) {
    return { admitted: false, rel, reason: 'resolution-failed', cls };
  }
  if (cls.escapedRepo) {
    return { admitted: false, rel, reason: 'escaped-repo', cls };
  }
  if (cls.category === 'sensitive') {
    return { admitted: false, rel, reason: 'sensitive', cls };
  }

  // Only reachable with a real, safe, non-sensitive canonical path.
  const canonicalRel = path.relative(repoRoot, cls.canonical).replace(/\\/g, '/');
  if (!isExtensionAllowlisted(canonicalRel)) {
    return { admitted: false, rel, reason: 'extension-not-allowlisted', cls };
  }

  // Size cap — skip generated/bundled monsters before they OOM ts-morph.
  // Use the canonical path so a symlink to a huge real file is still caught.
  let size;
  try {
    size = fs.statSync(cls.canonical).size;
  } catch (err) {
    return { admitted: false, rel, reason: 'stat-error', cls, error: err };
  }
  if (size > MAX_FILE_BYTES) {
    return { admitted: false, rel, reason: 'size-cap', cls, size };
  }

  return { admitted: true, rel, canonicalPath: cls.canonical, cls, size };
}

/**
 * Load + parse one admitted file's SourceFile via ts-morph. Isolated from
 * `admitFile` so a parse failure (exception OR ts-morph's `*IfExists` silent
 * undefined return) is the only thing this step can report.
 *
 * @param {string} canonicalPath
 * @param {import('ts-morph').Project} project
 * @returns {{ok: true, sourceFile: import('ts-morph').SourceFile} | {ok: false, reason: 'parse-error'|'no-source-file', error?: Error}}
 */
function loadAndParseFile(canonicalPath, project) {
  let sf;
  try {
    sf = project.addSourceFileAtPathIfExists(canonicalPath);
  } catch (err) {
    return { ok: false, reason: 'parse-error', error: err };
  }
  if (!sf) {
    // ts-morph's `*IfExists` APIs return undefined instead of throwing on
    // failure — a non-exception failure a try/catch alone can't see
    // (audit M5, 2026-07-24: the exception path was counted, this one
    // wasn't, so a file could fail to load without appearing anywhere in
    // failure accounting).
    return { ok: false, reason: 'no-source-file' };
  }
  return { ok: true, sourceFile: sf };
}

/**
 * Declaration extraction: functions, classes, and function-valued variable
 * declarations. Pure — no redaction, no emission, no stats.
 *
 * @param {import('ts-morph').SourceFile} sourceFile
 * @returns {Array<{symbolName: string, kind: string, startLine: number, endLine: number, signature: string, bodyText: string, isExported: boolean}>}
 */
function classifySymbolsInFile(sourceFile) {
  const candidates = [];

  for (const fn of sourceFile.getFunctions()) {
    candidates.push({
      symbolName: fn.getName() || '(anonymous)',
      kind: 'function',
      startLine: fn.getStartLineNumber(),
      endLine: fn.getEndLineNumber(),
      signature: `function ${fn.getName() || ''}(${fn.getParameters().map(p => p.getText()).join(',')})`,
      bodyText: fn.getBodyText() || '',
      isExported: fn.isExported(),
    });
  }
  for (const cls of sourceFile.getClasses()) {
    candidates.push({
      symbolName: cls.getName() || '(anonymous)',
      kind: 'class',
      startLine: cls.getStartLineNumber(),
      endLine: cls.getEndLineNumber(),
      signature: `class ${cls.getName() || ''}`,
      bodyText: cls.getText() || '',
      isExported: cls.isExported(),
    });
  }
  for (const v of sourceFile.getVariableDeclarations()) {
    const init = v.getInitializer();
    if (!init) continue;
    const initKind = init.getKindName();
    if (initKind === 'ArrowFunction' || initKind === 'FunctionExpression') {
      candidates.push({
        symbolName: v.getName(),
        kind: 'function',
        startLine: v.getStartLineNumber(),
        endLine: v.getEndLineNumber(),
        signature: `const ${v.getName()} = ${initKind}`,
        bodyText: v.getText() || '',
        isExported: v.isExported() || v.getVariableStatement()?.isExported() || false,
      });
    }
  }

  return candidates;
}

/**
 * Thin-delegate filter + secret redaction + emission — runs strictly after
 * `admitFile`'s decision (a file only reaches here once admission, load, and
 * classification have all already happened), mutating the shared `stats`
 * counters for skippedDelegate/redacted/symbolCount.
 *
 * @param {ReturnType<typeof classifySymbolsInFile>} candidates
 * @param {{rel: string, includeDelegates: boolean, stats: object}} ctx
 */
function redactAndEmit(candidates, { rel, includeDelegates, stats }) {
  for (const c of candidates) {
    // Thin-delegate filter: skip 1-line facades like
    //   const addListener = (...args) => target.method(...args);
    // before they enter the cluster index. See isThinDelegate().
    // --include-delegates flag disables the filter for operators who want
    // the full per-module view in arch:render.
    if (!includeDelegates && isThinDelegate(c.bodyText)) {
      stats.skippedDelegate++;
      continue;
    }
    // WS-CANON (Gemini-G2 fix): path-level enforcement (sensitive,
    // extension, symlink-escape) is done ONCE per file in admitFile — we
    // know this file already passed. This loop only needs the body-secret
    // check to decide whether to redact this specific candidate's body
    // before egress.
    const willRedact = containsSecrets(c.bodyText);
    if (willRedact) stats.redacted++;

    // R1 H3: signature can carry default-arg literals that contain secrets
    // (e.g. `function f(key="AKIA...")`). When the body fired the secret
    // gate, redact the signature too so no field leaks to summarise/embed.
    // Also defensive-check signature even when body looked clean — a parser
    // edge case could put the secret only in the signature.
    const safeSignature = (willRedact || containsSecrets(c.signature))
      ? redactSecrets(c.signature)
      : c.signature;

    const record = {
      type: 'symbol',
      filePath: rel,
      symbolName: c.symbolName,
      kind: c.kind,
      startLine: c.startLine,
      endLine: c.endLine,
      signature: safeSignature,
      bodyText: willRedact ? '' : c.bodyText,
      signatureHash: signatureHash({
        symbolName: c.symbolName,
        // hash always uses the ORIGINAL signature/body so cache identity
        // tracks the real artifact, not the redacted display copy
        signature: c.signature,
        bodyText: c.bodyText,
      }),
      isExported: c.isExported,
      purposeSummary: willRedact ? SECRET_REDACTED : null,
      embedding: null,
      redacted: willRedact,
    };
    emit(record);
    stats.symbolCount++;
  }
}

/**
 * Walk the repo (or a subset of files) and emit symbol records. Sequences
 * the four per-file steps: admitFile -> loadAndParseFile ->
 * classifySymbolsInFile -> redactAndEmit.
 *
 * @param {string[]} filePaths - absolute paths
 * @param {string} repoRoot - absolute path
 * @param {{includeDelegates?: boolean}} [opts] - opts.includeDelegates skips the thin-delegate filter (debug/visibility)
 * @returns {{symbolCount: number, skippedPath: number, skippedExt: number, skippedSize: number, skippedDelegate: number, redacted: number, statFailures: number, parseFailures: number}}
 */
export function extractSymbols(filePaths, repoRoot, opts = {}) {
  // statFailures/parseFailures (audit 9cc6f93b, 2026-07-17): both catches
  // below used to swallow the failure with no counter and no result-shape
  // signal — a run could report a clean summary while silently omitting
  // files. Additive only: does NOT change what's read, skipped, or how a
  // sensitive/symlink path is classified (INC-001) — counting only.
  const stats = { symbolCount: 0, skippedPath: 0, skippedExt: 0, skippedSize: 0, skippedDelegate: 0, redacted: 0, statFailures: 0, parseFailures: 0 };
  // Aggregate sensitive-path skips and emit ONE redacted log block at end
  // (plan: docs/plans/sustainability-cleanup-batch.md WS3, Gemini-r2-G3).
  const skippedSensitive = [];
  // skipAddingFilesFromTsConfig + skipFileDependencyResolution prevent ts-morph
  // from auto-loading imported modules (vendored types, monorepo siblings, etc.)
  // which is what ballooned the wine-cellar refresh to 4.3GB heap.
  const project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      // Named constants, not magic numbers (symbol-index-pipeline-reliability-
      // hardening Theme 3, R3): verified against the installed ts-morph's
      // re-exported `ts` at implementation time — target/module/moduleResolution
      // resolve to 99/99/100, the exact values these constants replace.
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
  });

  for (const abs of filePaths) {
    const rel = path.relative(repoRoot, abs).replace(/\\/g, '/');
    // Liveness heartbeat (docs/plans/extract-idle-timeout.md). This
    // synchronous loop is bounded by the parent's IDLE timeout, which resets on
    // any stdout record. A file yields no `symbol` records if it is skipped or
    // contains no extractable declarations, so symbol output alone is NOT a
    // reliable liveness signal — emit a `progress` beat at the TOP of every
    // iteration, BEFORE admission is even decided, so the max silent interval
    // is exactly one file's processing time regardless of outcome. Goes to
    // stdout via `emit` (NOT `emitProgress`, which is stderr and invisible to
    // the parent's timer). refresh.mjs's record filters ignore the `progress`
    // type, so the published snapshot is unchanged.
    // Position is UNCHANGED — before any filesystem work — so the maximum
    // silent interval is <= what it was before this change, for every file.
    // The path is NOT attached here: nothing has classified it yet, and a
    // full (unrestricted) walk enumerates `.env`/`secrets/**` like any
    // other file. The name is attached only after admitFile clears it
    // (docs/plans/refactor-symbol-index.md D1 — INC-001 fail-closed).
    emit({ type: 'progress' });

    const admission = admitFile(abs, { repoRoot });
    if (!admission.admitted) {
      switch (admission.reason) {
        case 'lexical-skip':
          stats.skippedPath++;
          skippedSensitive.push({ path: rel, category: admission.lexicalSkip.category, pattern: admission.lexicalSkip.pattern, action: 'dropped' });
          break;
        case 'resolution-failed':
          stats.skippedPath++;
          skippedSensitive.push({ path: rel, category: 'sensitive', pattern: null, action: 'skip-resolution-failed' });
          break;
        case 'escaped-repo':
          stats.skippedPath++;
          skippedSensitive.push({ path: rel, category: 'sensitive', pattern: null, action: 'skip-symlink-escape' });
          break;
        case 'sensitive':
          stats.skippedPath++;
          skippedSensitive.push({
            path: rel, category: 'sensitive', pattern: null,
            action: admission.cls.lexical === 'sensitive' ? 'dropped' : 'skip-canonical-sensitive',
          });
          break;
        case 'extension-not-allowlisted':
          stats.skippedExt++;
          break;
        case 'stat-error':
          stats.statFailures++;
          emitProgress(`stat-error: ${rel} — ${admission.error.message}`);
          break;
        case 'size-cap':
          stats.skippedSize++;
          emitProgress(`skip-size: ${rel} (${Math.round(admission.size / 1024)}KB > ${MAX_FILE_BYTES / 1024}KB)`);
          break;
      }
      continue;
    }

    // Named beat: admitFile is the single point that has cleared this path
    // against the sensitive-path policy (lexical + canonical + escape +
    // extension + size). Fail-closed BY CONSTRUCTION — the name is
    // attached iff admitted, so a rejection reason added later is silent
    // by default (INC-001: never allow what you could not classify).
    // Also the parse-start marker the parent's wedge diagnostic reads (D3),
    // and the pre-parse liveness tick for EVERY admitted file (D2) — this
    // supersedes the old size-gated large-file tick, which fired only for
    // files over MAX_FILE_BYTES/2.
    emit({ type: 'progress', file: rel });

    const parsed = loadAndParseFile(admission.canonicalPath, project);
    if (!parsed.ok) {
      stats.parseFailures++;
      const detail = parsed.reason === 'parse-error'
        ? parsed.error.message
        : 'addSourceFileAtPathIfExists returned no source file';
      emitProgress(`parse-error: ${rel} — ${detail}`);
      continue;
    }

    const candidates = classifySymbolsInFile(parsed.sourceFile);
    redactAndEmit(candidates, { rel, includeDelegates: opts.includeDelegates, stats });

    // The SUCCESS marker — "admitted, parsed, and classified". Distinct from the
    // `progress` tick at the top of this loop, which is a parse-START liveness
    // signal: it fires BEFORE loadAndParseFile, so a parse failure `continue`s
    // having already emitted it. Consumers that need "files actually reached"
    // must read this, not that — deriving a touched-set from the start marker
    // marks parse-failed files as reached and suppresses their correct
    // copy-forward. Carrying `rel` is safe for the same reason the start
    // marker's is: both are downstream of admitFile (INC-001 fail-closed).
    // See docs/plans/silent-success-cluster.md KD-3.
    emit({ type: 'processed', file: rel });

    // Release SourceFile after we're done with it so the project doesn't
    // accumulate 800+ in-memory ASTs (memory growth was a contributor to
    // the 4.3GB heap in wine-cellar's hung run).
    try { project.removeSourceFile(parsed.sourceFile); } catch { /* ignore */ }
  }

  for (const line of formatSkipLog(skippedSensitive, { logger: 'extract' })) {
    process.stderr.write(`  ${line}\n`);
  }

  return stats;
}

/**
 * Walk the file-to-file graph + emit any layering violations.
 * Violations come from `.dependency-cruiser.cjs` config if present in repo,
 * else default heuristics.
 *
 * Also MEASURES its own blindness (plan §2.1, Phase 2). This is the only place
 * that holds both layers' views of the repo — `enumerateFiles`' whole-repo
 * inventory and the cruise result — so it is the only place the two can be
 * compared without re-deriving one of them and reintroducing the very
 * disagreement being measured.
 *
 * @param {string} repoRoot
 * @param {{eligible?: string[]|null, sampleCap?: number}} [opts]
 *   opts.eligible — the coverage DENOMINATOR (§2.1.1). `null` on an incremental
 *   run: coverage is a full-run measurement, so a partial run emits no coverage
 *   line at all and `refresh.mjs` copies the prior row forward as stale (§2.1.3
 *   row 4) rather than choosing between a fresh partial number and a stale
 *   whole one.
 * @returns {{violationCount: number, importCount?: number, coverage?: object}}
 */
async function extractGraphAndViolations(repoRoot, opts = {}) {
  const { eligible = null, sampleCap = COVERAGE_DEFAULTS.sampleCap } = opts;
  const measure = Array.isArray(eligible);
  // R1 audit Gemini-G1: don't hardcode ['scripts', 'src'] — many repos use
  // lib/, app/, components/, pages/, api/, etc. Auto-detect any top-level
  // source-looking directory, then fall back to repo root if nothing matches.
  // dep-cruiser respects the exclude pattern below to skip junk.
  const localConfig = path.join(repoRoot, '.dependency-cruiser.cjs');
  const cruiseOpts = {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|\\.git|\\.audit-loop|dist|build|coverage|out|\\.next|\\.nuxt|\\.cache)(/|$)' },
  };
  if (fs.existsSync(localConfig)) {
    // pathToFileURL, not a bare path: `await import('C:\repo\.dependency-
    // cruiser.cjs')` throws ERR_UNSUPPORTED_ESM_URL_SCHEME on Windows, and a
    // hand-built `file://${p}` is malformed there too (backslashes). This repo
    // has no local config so the branch never fired here — but a CONSUMER with
    // one would have died before the cruise, and this ships to adopter repos we
    // never see. Found by following a final-gate LOW about the sibling spike.
    //
    // Wrapped because this sits OUTSIDE the cruise try/catch: an unreadable or
    // malformed local config used to kill extract outright, taking the symbol
    // index with it. Degrade to the default ruleset instead (#16) — a missing
    // layering ruleset costs violations, not the whole index.
    try {
      cruiseOpts.ruleSet = (await import(pathToFileURL(localConfig).href)).default;
    } catch (err) {
      emitProgress(`WARNING: could not load .dependency-cruiser.cjs (${err.message}); `
        + `continuing with default rules — layering violations will not be reported`);
    }
  }

  // Common JS/TS source-dir conventions, plus a fallback to the repo root
  // (dep-cruiser will then walk everything not excluded above).
  //
  // KNOWN LIMITATION — this allowlist is a silent-blindness generator. The
  // `targets.length === 0` fallback below only fires when a repo matches
  // NOTHING here, so a repo using a dir name absent from this list gets a
  // SMALLER import graph. That is exactly how `tests/` went unseen: only
  // `scripts/` matched, so the largest domain in this repo (380 files)
  // produced zero observed edges for months while being fully symbol-indexed
  // by enumerateFiles(), which walks the whole repo. Two layers of one
  // pipeline disagreeing about what the repo contains.
  //
  // It is no longer SILENT (2026-07-18, plan §2.1.1): the coverage measurement
  // below holds the cruise result against the whole-repo eligible universe, so
  // an unlisted layout now surfaces as a number and a `degraded` verdict. The
  // allowlist deliberately still selects targets unchanged — measuring the
  // blindness is this plan's scope; removing it is unified discovery, which
  // stays out of scope precisely because it cannot fix a resolution defect:
  // docs/plans/observed-graph-discovery-unification.md §3.1
  const COMMON_SOURCE_DIRS = [
    'scripts', 'src', 'lib', 'app', 'apps', 'packages',
    'components', 'pages', 'server', 'api', 'routes',
    'frontend', 'backend', 'client',
    'tests',
  ];
  let targets = COMMON_SOURCE_DIRS
    .map(d => path.join(repoRoot, d))
    .filter(p => fs.existsSync(p));
  if (targets.length === 0) targets = [repoRoot];

  let result;
  const startedAt = Date.now();
  try {
    result = await cruise(targets, cruiseOpts);
  } catch (err) {
    emitProgress(`dep-cruiser failed: ${err.message}`);
    // A failed cruise used to be indistinguishable from a repo with no
    // imports — same `{violationCount: 0}`, `importCount` undefined. Now it
    // says so: `outcome: 'failed'` carries null counts (NOT zero; zero is a
    // measurement, null is the absence of one) and the verdict oracle maps it
    // to `unverified` / `extraction_failed` at precedence row 1.
    if (measure) {
      const coverage = assessExtractionCoverage({
        outcome: 'failed', elapsedMs: Date.now() - startedAt,
      });
      emitCoverage(coverage);
      emitProgress('coverage: unverified (extraction_failed)');
      return { violationCount: 0, coverage };
    }
    return { violationCount: 0 };
  }
  const elapsedMs = Date.now() - startedAt;

  const violations = (result.output?.summary?.violations || []);
  for (const v of violations) {
    emit({
      type: 'violation',
      ruleName: v.rule?.name || 'unknown',
      fromPath: path.relative(repoRoot, v.from || '').replace(/\\/g, '/'),
      toPath: path.relative(repoRoot, v.to || '').replace(/\\/g, '/'),
      severity: v.rule?.severity || 'warn',
      comment: v.rule?.comment || null,
    });
  }

  // Plan §2.6 — emit file-level import edges for "Where used" rendering
  // and /explain caller-domain analysis. Filter out external deps via
  // cruiser-emitted metadata (Gemini-R1-G3, Gemini-R2-G1).
  const modules = result.output?.modules || [];
  let importCount = 0;
  // Every dependency the cruise offered lands in exactly ONE bucket. Each of
  // these three drops is individually defensible and none was ever counted —
  // that silence is the defect (plan §2.1.2). `cruisedEdges` is the total the
  // exhaustivity assertion holds them to.
  const edges = { external: 0, selfEdge: 0, escaping: 0, persisted: 0 };
  let cruisedEdges = 0;
  for (const m of modules) {
    if (!m.source) continue;
    const importer = path.relative(repoRoot, m.source).replace(/\\/g, '/');
    for (const d of (m.dependencies || [])) {
      cruisedEdges++;
      if (!isInternalEdge(d)) { edges.external++; continue; }
      const imported = path.relative(repoRoot, d.resolved).replace(/\\/g, '/');
      // Skip self-edges and edges that escape the repo (..)
      if (imported === importer) { edges.selfEdge++; continue; }
      if (imported.startsWith('..')) { edges.escaping++; continue; }
      emit({ type: 'import', importer, imported });
      edges.persisted++;
      importCount++;
    }
  }

  if (!measure) return { violationCount: violations.length, importCount };

  const coverage = assessExtractionCoverage({
    outcome: 'ok',
    eligible,
    cruisedSources: modules.map(m => m.source).filter(Boolean),
    repoRoot,
    // dep-cruiser emits `source` relative to ITS process CWD, which is not
    // necessarily repoRoot. Resolving against repoRoot is correct only when
    // the two coincide — the assumption normalizeRepoPath exists to remove.
    cruisedBase: process.cwd(),
    elapsedMs,
    edges,
    sampleCap,
  });

  const exhaustive = assertExtractionExhaustive(coverage, cruisedEdges);
  if (!exhaustive.ok) {
    // Loud, but never fatal (#16): a bucket that stops adding up is a NEW
    // silent loss site, which is worth shouting about — and is still better
    // information than a failed refresh.
    emitProgress(`WARNING: edge buckets do not account for every cruised edge `
      + `(counted ${exhaustive.actual}, cruise offered ${exhaustive.expected}). `
      + `A filter was likely added without a bucket — see plan §2.1.2.`);
  }

  emitCoverage(coverage);
  const pct = coverage.ratio == null ? 'n/a' : `${(coverage.ratio * 100).toFixed(1)}%`;
  emitProgress(`coverage: ${coverage.cruised}/${coverage.eligible} eligible source files `
    + `cruised (${pct}) in ${elapsedMs}ms — edges: ${edges.persisted} persisted, `
    + `${edges.external} external, ${edges.selfEdge} self, ${edges.escaping} escaping`);

  return { violationCount: violations.length, importCount, coverage };
}

/**
 * Emit the extraction-layer coverage record for `refresh.mjs` to persist
 * (plan §2.1.7). Extract owns ONLY the extraction layer — the verdict,
 * `measuredAt`, and the `refreshId` it is keyed on all belong to the parent
 * process, which is the one that knows the snapshot identity. Emitting a
 * verdict here would create a second oracle.
 *
 * `schemaVersion` ships from day one so a future shape change is a version
 * bump rather than a guess at the reader.
 */
function emitCoverage(extraction) {
  emit({ type: 'coverage', schemaVersion: 1, extraction });
}

/**
 * Determine whether a dep-cruiser dependency edge points at an internal
 * file (worth persisting) versus an external dep (node_modules, Node
 * builtin) we should skip.
 *
 * Plan v6 §2.6 — uses dep-cruiser's `coreModule` flag and
 * `dependencyTypes` array as primary signals (Gemini-R2-G1: string
 * matching alone misses `fs/promises`, `util/types`, `stream/web` —
 * core modules with slashes). String checks are defence-in-depth.
 *
 * Exported for unit testing.
 */
export function isInternalEdge(dep) {
  if (!dep || typeof dep.resolved !== 'string') return false;
  // Authoritative dep-cruiser metadata
  if (dep.coreModule === true) return false;
  const types = dep.dependencyTypes || [];
  if (types.includes('core')) return false;
  if (types.includes('npm')) return false;
  if (types.includes('npm-dev')) return false;
  if (types.includes('npm-optional')) return false;
  if (types.includes('npm-peer')) return false;
  if (types.includes('npm-bundled')) return false;
  // Defence-in-depth string checks
  const r = dep.resolved;
  if (r.includes('node_modules/') || r.includes('node_modules\\')) return false;
  if (r.startsWith('node:')) return false;
  return true;
}

/**
 * @param {string} repoRoot
 * @param {string[]|null} restrictFiles
 * @returns {string[]} absolute file paths
 */
// Directory names skipped during enumeration. Found live: wine-cellar-app
// hung in ts-morph for 30+ min when walking `dist/` (bundled minified JS).
// Build outputs, caches, and generated artifacts are noise for symbol
// extraction and would also fire the dep-cruiser exclude regex anyway.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.audit-loop',
  'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.cache', '.parcel-cache', '.turbo', '.svelte-kit',
  '.vite', '.vercel', '.netlify', '.serverless',
  'public/build', // common Remix/RR pattern; real bundled output
  // .claude is Claude Code's per-repo state. Worktrees inside (.claude/worktrees/*)
  // duplicate the full source tree N times — found live: wine-cellar had 5
  // worktrees inflating its file count from ~1500 to 7635, OOM'ing ts-morph.
  '.claude',
]);

// Files larger than this are skipped entirely. Found live: wine-cellar-app
// hung in ts-morph at 4.3GB heap, almost certainly parsing a generated /
// bundled file of multiple MB. Real source files (functions, components)
// rarely exceed 100KB; 500KB is a generous cap that preserves all real code.
const MAX_FILE_BYTES = 500 * 1024;

// Exported for MEASUREMENT ONLY (2026-07-18) — `scripts/spikes/observed-graph-
// discovery-spike.mjs` must measure the REAL symbol-layer enumerator, because
// the whole question it answers is whether this walker's inventory can be fed
// to dep-cruiser. Measuring a re-implementation would reproduce the exact
// layers-disagree bug the spike exists to investigate. Exporting a pure,
// side-effect-free walker is not an implementation of
// docs/plans/observed-graph-discovery-unification.md design (e) — that plan
// remains blocked on the measurements this export enables.
/**
 * Pure gate for the coverage-measurement "was this a full run" decision
 * (b021576b). `null` means no restriction was ever passed (--files/
 * --files-from absent) — the only genuine full-run case. `[]` means a
 * restriction WAS passed and resolved to zero files (e.g. an incremental
 * diff touching only docs/config) — a real, valid, ZERO-file incremental
 * run, not a full one; measuring it as full would compute the coverage
 * ratio against the wrong denominator (plan §2.1.3 row 4).
 *
 * @param {string[]|null} files - `args.files` as parsed by parseArgs
 * @returns {boolean}
 */
export function isFullRunFromFiles(files) {
  return files === null;
}

/**
 * Choose the file list the coverage DENOMINATOR is computed from.
 *
 * PURE (the walk is injected) because this one decision is the whole fix, and
 * it is invisible from the outside: both branches return a plausible array, so
 * a wrong choice yields a real-looking ratio rather than an error.
 *
 * `restrictFiles` scopes SYMBOL EXTRACTION. Coverage asks a different question
 * — "of the repo's eligible files, how many did the cruiser reach" — and the
 * cruiser walks the whole tree on every run. Measuring a whole-repo numerator
 * against a changed-files denominator would be nonsense, which is why coverage
 * used to be suppressed on incremental runs entirely. Suppression was the safe
 * call; it also meant the gate read `unknown` for 13 days at a time. Walking
 * the universe independently is the honest one.
 *
 * @param {string} repoRoot
 * @param {string[]|null} restrictFiles - null = full run
 * @param {string[]} extractionFiles - the already-enumerated extraction scope
 * @param {(root: string, restrict: string[]|null) => string[]} enumerate
 * @returns {string[]} the coverage universe
 */
export function coverageUniverse(repoRoot, restrictFiles, extractionFiles, enumerate) {
  // A full run already enumerated the whole repo — walking twice would be
  // identical work for an identical answer.
  if (isFullRunFromFiles(restrictFiles)) return extractionFiles;
  return enumerate(repoRoot, null);
}

export function enumerateFiles(repoRoot, restrictFiles) {
  // b021576b (origin/main) / Theme 3 (this branch) — the same fix landed
  // independently on both sides: `null`/`undefined` means "no restriction,
  // full walk"; `[]` means "a valid incremental scope of ZERO files" (e.g.
  // a diff touching only docs/config) — these are opposite intents. The old
  // `restrictFiles && restrictFiles.length > 0` check conflated them,
  // silently falling back to a full repo walk whenever the resolved scope
  // was legitimately empty. `!= null` (not `!==`) also covers `undefined`
  // defensively, though `args.files` is always explicitly `null` in practice.
  if (restrictFiles != null) {
    return restrictFiles.map(f => path.isAbsolute(f) ? f : path.join(repoRoot, f));
  }
  // Default: walk repo for source files. Keep the walk small + fast.
  const out = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(full);
    }
  }
  walk(repoRoot);
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const repoRoot = path.resolve(args.root);
  const files = enumerateFiles(repoRoot, args.files);
  if (args.includeDelegates) {
    emitProgress('WARNING: --include-delegates is a debug/visibility flag. The resulting index includes thin-facade duplicates and should not be used as a baseline snapshot — re-run without the flag for normal operations.');
  }
  emitProgress(`scanning ${files.length} files (mode=${args.mode})`);
  const stats = extractSymbols(files, repoRoot, { includeDelegates: args.includeDelegates });
  // ── Coverage denominator: its OWN whole-repo walk, not `files` ────────────
  //
  // `files` answers "which files am I re-extracting symbols for" — restricted
  // on an incremental run. Coverage asks a DIFFERENT question: "of the repo's
  // eligible files, how many did the cruiser reach". One variable was serving
  // both, and that conflation is why coverage was suppressed on every
  // incremental run and the gate read `unknown` for 13 days straight
  // (measured 2026-08-09: last real measurement 2026-07-27).
  //
  // The suppression was the RIGHT call for the code as it stood — measuring a
  // whole-repo numerator against a changed-files denominator would have
  // produced a real-looking ratio from the wrong universe. But the numerator
  // was never the problem: `extractGraphAndViolations` cruises `targets` (the
  // source dirs) on EVERY run, incremental included. Only the denominator was
  // missing, so the fix is to compute it independently rather than to
  // withhold the measurement.
  //
  // Cost: one unrestricted walk + a statSync per file, against a
  // dependency-cruise of the same tree that has already run. The walk is the
  // cheap half of a measurement that was being thrown away.
  const universeFiles = coverageUniverse(repoRoot, args.files, files, enumerateFiles);
  // §2.1.1's third clause: a file this pipeline refuses to read must not count
  // against the denominator. An unreadable file is excluded for the same
  // reason — it is not a coverage failure, and failing closed here would
  // understate coverage on precisely the repos with generated monsters.
  //
  // A file whose size cannot be read is excluded too — but note the direction:
  // excluding SHRINKS the denominator and RAISES the reported ratio. That is
  // the optimistic direction, so it must never be silent (final-gate M6). It
  // is counted and warned about; a repo where this fires often is a repo whose
  // coverage number deserves suspicion.
  let statFailures = 0;
  const isTooLarge = (abs) => {
    try {
      return fs.statSync(abs).size > MAX_FILE_BYTES;
    } catch {
      statFailures++;
      return true;
    }
  };
  // Always measurable now: the denominator is the repo's eligible universe on
  // both run modes, so the ratio is commensurable with the whole-repo cruise
  // regardless of how many files were re-extracted.
  const eligible = eligibleFiles(universeFiles, { repoRoot, isTooLarge });
  if (statFailures > 0) {
    emitProgress(`WARNING: ${statFailures} file(s) excluded from the coverage `
      + `denominator because their size could not be read — the reported ratio `
      + `is optimistic by that much.`);
  }
  const graphStats = await extractGraphAndViolations(repoRoot, { eligible });
  // `coverage` travels on its own `{type:'coverage'}` line, not inside
  // `counts` — that field is a flat scalar bag and consumers treat it as one.
  const { coverage: _coverage, ...graphCounts } = graphStats;
  emit({ type: 'summary', counts: { ...stats, ...graphCounts } });
  emitProgress(`done — symbols=${stats.symbolCount} violations=${graphStats.violationCount} skipped-path=${stats.skippedPath} skipped-ext=${stats.skippedExt} skipped-size=${stats.skippedSize} skipped-delegate=${stats.skippedDelegate} redacted=${stats.redacted} stat-failures=${stats.statFailures} parse-failures=${stats.parseFailures}`);
}

// Test seam (symbol-index-pipeline-reliability-hardening Theme 3) — mirrors
// the `_internals` pattern already used by drift.mjs / anthropic-client.mjs /
// file-io.mjs / shared.mjs. `admitFile`'s four `classify`-stubbable reason
// values (resolution-failed, escaped-repo, sensitive, extension-not-
// allowlisted) are independently testable via `classify` injection with no
// real filesystem symlink fixture; `MAX_FILE_BYTES` lets a size-cap test
// assert the boundary without hand-computing the constant twice.
export const _internals = {
  admitFile, loadAndParseFile, classifySymbolsInFile, redactAndEmit, MAX_FILE_BYTES, parseArgs,
};

// CLI-only entry guard (2026-07-18). `main()` used to run unconditionally at
// module scope, so ANY `import` of this file kicked off a full symbol
// extraction — minutes of work, plus JSON-lines spraying onto the importer's
// stdout. That made the module effectively un-importable, which is very likely
// why `enumerateFiles` had no export and no direct test despite being a pure,
// obviously-testable walker. Found while writing
// `scripts/spikes/observed-graph-discovery-spike.mjs`, which needs the real
// enumerator. Same idiom as gemini-review.mjs / cache-hitrate-check.mjs;
// `node scripts/symbol-index/extract.mjs ...` behaves exactly as before.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    process.stderr.write(`extract: fatal: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}
