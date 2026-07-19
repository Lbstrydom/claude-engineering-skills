/**
 * SARIF 2.1.0 ingestion for the SAST triage router.
 *
 * Plan: docs/plans/sast-triage-routing.md — Phase 1.
 *
 * **This module is filesystem-free** (§2c layer boundary). It resolves
 * `artifactLocation.uri` + `uriBaseId` to a repo-relative path *lexically*
 * and never calls `realpath`, `stat`, or `readFile`. Canonicalization
 * (SC1 / INC-001) and the bounded source read belong to the Phase-3 CLI
 * adapter; the router (Phase 2) stays pure between them.
 *
 * The contract it emits is `NormalizedFinding`. The contract the router
 * accepts is `RoutableFinding` — the same shape plus the three
 * adapter-supplied fields (`repoRelativePath`, `pathClassification`,
 * `contextWithheld`). Keeping them as two schemas is what stops a
 * filesystem-derived field from being silently assumed present upstream.
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { redactSecrets } from '../secret-patterns.mjs';

// ---------------------------------------------------------------------------
// Bounds (§2c). Ceilings are module constants and are NOT configurable: a
// policy file must not be able to disable the protection it configures, so a
// config value above its ceiling is `config_invalid`, never a clamp.
// ---------------------------------------------------------------------------

export const BOUND_CEILINGS = Object.freeze({
  maxSarifBytes: 128 * 1024 * 1024,
  maxResults: 50_000,
  maxMessageChars: 32_000,
  maxSinkLines: 200,
  maxSourceBytesPerFile: 16 * 1024 * 1024,
});

export const BOUND_DEFAULTS = Object.freeze({
  maxSarifBytes: 32 * 1024 * 1024,
  maxResults: 5_000,
  maxMessageChars: 4_000,
  maxSinkLines: 12,
  maxSourceBytesPerFile: 1 * 1024 * 1024,
});

const boundField = (key) =>
  z.number().int().positive().max(BOUND_CEILINGS[key]).optional();

export const BoundsSchema = z
  .object({
    maxSarifBytes: boundField('maxSarifBytes'),
    maxResults: boundField('maxResults'),
    maxMessageChars: boundField('maxMessageChars'),
    maxSinkLines: boundField('maxSinkLines'),
    maxSourceBytesPerFile: boundField('maxSourceBytesPerFile'),
  })
  .strict();

/**
 * Config contract (§2c). `.strict()` is load-bearing: a typo'd key must be an
 * error, never a silently-disabled predicate.
 */
export const ConfigSchema = z
  .object({
    version: z.literal(1),
    pathScope: z
      .object({ nonReachableGlobs: z.array(z.string()) })
      .strict(),
    sinkMismatch: z
      .object({
        pairs: z.array(
          z.object({ ruleId: z.string(), sinkFunction: z.string() }).strict(),
        ),
      })
      .strict(),
    sanitizerWrapped: z
      .object({ sanitizers: z.array(z.string()) })
      .strict(),
    bounds: BoundsSchema.optional(),
  })
  .strict();

export function resolveBounds(config) {
  return Object.freeze({ ...BOUND_DEFAULTS, ...(config?.bounds || {}) });
}

// ---------------------------------------------------------------------------
// Seam schemas (§2c)
// ---------------------------------------------------------------------------

export const RegionSchema = z
  .object({
    startLine: z.number().int().positive(),
    startColumn: z.number().int().positive().nullable().optional(),
    endLine: z.number().int().positive(),
    endColumn: z.number().int().positive().nullable().optional(),
  })
  .strict();

/**
 * `path` is the lexically-resolved repo-relative path (Phase 1).
 * `repoRelativePath` + `canonicalPath` are adapter-populated (Phase 3) —
 * absent from this module's output by construction.
 */
export const FindingLocationSchema = z
  .object({
    path: z.string().min(1),
    region: RegionSchema.nullable(),
    canonicalPath: z.string().optional(),
    repoRelativePath: z.string().optional(),
    pathClassification: z
      .enum(['ok', 'sensitive', 'unresolved', 'escaped'])
      .optional(),
  })
  .strict();

export const SINK_RESOLUTIONS = Object.freeze(['codeflow', 'single', 'unresolved']);

/**
 * `sinkResolution` and `sinkLocation` are two views of ONE fact, so they are
 * checked against each other rather than independently. Without this, a
 * finding could claim `sinkResolution: 'codeflow'` while carrying
 * `sinkLocation: null` — and the source-reading predicates would decline while
 * the router's `sink-unresolved` guard never fired, leaving a
 * location-dependent decision made with no location.
 */
export function assertSinkConsistency(finding, ctx) {
  const claimsUnresolved = finding.sinkResolution === 'unresolved';
  const hasNoSink = finding.sinkLocation === null || finding.sinkLocation === undefined;
  if (claimsUnresolved !== hasNoSink) {
    ctx.addIssue({
      code: 'custom',
      path: ['sinkResolution'],
      message:
        `sinkResolution=${finding.sinkResolution} disagrees with sinkLocation=` +
        `${hasNoSink ? 'null' : 'present'}; the two must agree`,
    });
  }
}

/** Extendable base — the refined export below is not `.extend()`-able. */
export const NormalizedFindingShape = z
  .object({
    findingId: z.string().min(1),
    occurrenceIndex: z.number().int().nonnegative(),
    ruleId: z.string(),
    toolName: z.string(),
    // Nullable (audit R2-H2): a locationless or unresolvable-URI result keeps
    // `rawLocation` and still gets ingested + routed to `A`. Requiring a path
    // here while promising to route locationless results was a contradiction.
    location: FindingLocationSchema.nullable(),
    sinkLocation: FindingLocationSchema.nullable(),
    sinkResolution: z.enum(['codeflow', 'single', 'unresolved']),
    rawLocation: z.string(),
    message: z.string(),
    messageTruncated: z.boolean(),
    level: z.string(),
    sourceContext: z.string().nullable().optional(),
    contextWithheld: z
      .enum(['sensitive', 'too-large', 'unreadable'])
      .nullable()
      .optional(),
    diagnostics: z.array(z.string()),
  })
  .strict();

export const NormalizedFindingSchema =
  NormalizedFindingShape.superRefine(assertSinkConsistency);

export const BUCKETS = Object.freeze(['A', 'C', 'D']);

/**
 * A location after the Phase-3 adapter has canonicalized it. Lives here rather
 * than in the router so every seam schema stays in one module (§2c) and the
 * report schema below can reference the routed shape without a cycle.
 */
export const RoutableLocationSchema = FindingLocationSchema.extend({
  canonicalPath: z.string(),
  repoRelativePath: z.string(),
  pathClassification: z.enum(['ok', 'sensitive', 'unresolved', 'escaped']),
});

export const PredicateMatchSchema = z
  .object({
    predicate: z.string(),
    matched: z.boolean(),
    reason: z.string(),
    bucket: z.enum(['A', 'C', 'D']).optional(),
  })
  .strict();

/**
 * The report's core payload, typed.
 *
 * This was `z.array(z.any())`, which meant the ONE schema whose job is to stop
 * render and logic diverging validated nothing about the findings it carried —
 * a versioned contract that could not detect its own breach.
 */
export const RoutedFindingSchema = NormalizedFindingShape.extend({
  location: RoutableLocationSchema.nullable(),
  sinkLocation: RoutableLocationSchema.nullable(),
  bucket: z.enum(['A', 'C', 'D']),
  matches: z.array(PredicateMatchSchema),
}).superRefine(assertSinkConsistency);

export const TriageReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    runStatus: z.enum([
      'config_invalid',
      'input_unreadable',
      'input_malformed',
      'unverified',
      'needs_review',
      'routed_clean',
    ]),
    exitCode: z.number().int().nonnegative(),
    counts: z
      .object({
        A: z.number().int().nonnegative(),
        C: z.number().int().nonnegative(),
        D: z.number().int().nonnegative(),
      })
      .strict(),
    findings: z.array(RoutedFindingSchema),
    unusedPredicates: z.array(z.string()),
    diagnostics: z.array(z.string()),
  })
  .strict();

// ---------------------------------------------------------------------------
// URI resolution (§2c). A guess here would silently defeat the INC-001
// mitigation, so every unresolvable form yields `null` + a diagnostic and the
// finding routes to `A` — never an invented path.
// ---------------------------------------------------------------------------

/**
 * SARIF's conventional "the repository root" base ids.
 *
 * These are NOT a guess: `%SRCROOT%` is the base id Snyk Code and CodeQL both
 * emit, and neither declares it in `originalUriBaseIds` (measured: the real
 * 240-result corpus uses `%SRCROOT%` with `originalUriBaseIds` absent). Treating
 * an undeclared `%SRCROOT%` as unresolvable would route 100% of a Snyk run to
 * `A` and make the tool inert against its motivating producer.
 *
 * The set is deliberately closed and a module constant — anything outside it
 * that is undeclared stays unresolvable. Resolution via this path is recorded
 * as a per-finding diagnostic so the assumption is visible in the report rather
 * than implicit in the code.
 */
export const REPO_ROOT_URI_BASE_IDS = Object.freeze(new Set(['%SRCROOT%']));

function normaliseSlashes(p) {
  return String(p).replace(/\\/g, '/');
}

/** Lexically resolve an `artifactLocation` to a repo-relative path, or null. */
export function resolveArtifactUri(artifactLocation, run, diagnostics) {
  const uri = artifactLocation?.uri;
  if (typeof uri !== 'string' || uri.length === 0) {
    diagnostics.push('uri-missing');
    return null;
  }

  let candidate = uri;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(uri);
  if (scheme) {
    if (scheme[1].toLowerCase() !== 'file') {
      diagnostics.push(`uri-unsupported-scheme:${scheme[1]}`);
      return null;
    }
    // Parse rather than string-strip the `file://` prefix. Stripping it turns
    // the URI's AUTHORITY into a leading path segment — `file://evil-host/x.js`
    // becomes the innocuous-looking RELATIVE path `evil-host/x.js`, which then
    // passes every check below and is treated as a repo artifact. That is a
    // fail-open on the exact input SC1 exists to distrust.
    let parsed;
    try {
      parsed = new URL(uri);
    } catch {
      diagnostics.push('uri-unparseable');
      return null;
    }
    if (parsed.host && parsed.host.toLowerCase() !== 'localhost') {
      diagnostics.push('uri-remote-authority');
      return null;
    }
    try {
      candidate = decodeURIComponent(parsed.pathname);
    } catch {
      diagnostics.push('uri-undecodable');
      return null;
    }
    candidate = candidate.replace(/^\/([a-zA-Z]:)/, '$1'); // /C:/x -> C:/x
    // A `file:` pathname is always absolute, and Phase 1 has no repoRoot to
    // prove containment against — so it is unresolvable here BY CONSTRUCTION
    // rather than guessed at. Routing to `A` is the honest outcome.
    if (path.isAbsolute(candidate) || /^[a-zA-Z]:/.test(candidate)) {
      diagnostics.push('uri-absolute');
      return null;
    }
  }

  const baseId = artifactLocation?.uriBaseId;
  let prefix = '';
  if (typeof baseId === 'string' && baseId.length > 0) {
    const declared = run?.originalUriBaseIds?.[baseId];
    if (declared) {
      const declaredUri = declared.uri;
      if (typeof declaredUri !== 'string') {
        diagnostics.push(`uribase-undeclared-uri:${baseId}`);
        return null;
      }
      // A declared base that is itself absolute (`file:///…`) anchors outside
      // any lexical repo-relative frame; Phase 3 owns containment for it.
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(declaredUri)) {
        diagnostics.push(`uribase-absolute:${baseId}`);
        return null;
      }
      prefix = normaliseSlashes(declaredUri).replace(/\/+$/, '');
    } else if (REPO_ROOT_URI_BASE_IDS.has(baseId)) {
      diagnostics.push(`uribase-repo-root-sentinel:${baseId}`);
    } else {
      diagnostics.push(`uribase-unknown:${baseId}`);
      return null;
    }
  }

  const joined = normaliseSlashes(prefix ? `${prefix}/${candidate}` : candidate);
  if (path.isAbsolute(joined) || /^[a-zA-Z]:/.test(joined)) {
    diagnostics.push('uri-absolute');
    return null;
  }

  // Lexical containment: `..` that escapes the frame is never resolved to a
  // guess. `path.posix.normalize` collapses interior `..` honestly.
  //
  // The test is on the `..` SEGMENT, not the `..` prefix: `startsWith('..')`
  // also rejects legitimate names like `..reports/x.js`, sending a real
  // finding to `A` for a filename that merely begins with two dots.
  const normalised = path.posix.normalize(joined);
  if (normalised === '..' || normalised.startsWith('../') || normalised === '.') {
    diagnostics.push('uri-escapes-root');
    return null;
  }
  return normalised.replace(/^\.\//, '');
}

// ---------------------------------------------------------------------------
// Sink resolution (D3a0)
// ---------------------------------------------------------------------------

function regionOf(physicalLocation) {
  const r = physicalLocation?.region;
  if (!r || typeof r.startLine !== 'number') return null;
  return {
    startLine: r.startLine,
    startColumn: typeof r.startColumn === 'number' ? r.startColumn : null,
    endLine: typeof r.endLine === 'number' ? r.endLine : r.startLine,
    endColumn: typeof r.endColumn === 'number' ? r.endColumn : null,
  };
}

/**
 * Which SARIF location is the claimed sink (D3a0).
 *
 * 1. Terminal `physicalLocation` of EVERY threadFlow across EVERY codeFlow.
 *    All agreeing on one `(uri, startLine)` → that is the sink. A sink in a
 *    different file from the primary location is normal (measured: 17.5% of
 *    the real corpus) and fully supported.
 * 2. Else exactly one `result.locations` entry → that entry.
 * 3. Else → unresolved. Both source-reading predicates then return no match
 *    and the finding routes to `A`. A predicate that cannot identify the sink
 *    must not pretend to have evaluated it.
 */
export function resolveSinkPhysicalLocation(result) {
  const terminals = [];
  for (const codeFlow of result?.codeFlows || []) {
    for (const threadFlow of codeFlow?.threadFlows || []) {
      const steps = threadFlow?.locations || [];
      if (steps.length === 0) continue;
      const pl = steps[steps.length - 1]?.location?.physicalLocation;
      if (pl) terminals.push(pl);
    }
  }

  if (terminals.length > 0) {
    const keys = new Set(
      terminals.map(
        (t) => `${t.artifactLocation?.uri ?? ''}::${t.region?.startLine ?? ''}`,
      ),
    );
    if (keys.size === 1) return { physicalLocation: terminals[0], mode: 'codeflow' };
    return { physicalLocation: null, mode: 'unresolved' };
  }

  const locations = result?.locations || [];
  if (locations.length === 1 && locations[0]?.physicalLocation) {
    return { physicalLocation: locations[0].physicalLocation, mode: 'single' };
  }
  return { physicalLocation: null, mode: 'unresolved' };
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

function contentHash(ruleId, rawLocation, message) {
  return crypto
    .createHash('sha256')
    .update(`${ruleId} ${rawLocation} ${message}`)
    .digest('hex')
    .slice(0, 16);
}

export class SarifIngestError extends Error {
  constructor(runStatus, message) {
    super(message);
    this.name = 'SarifIngestError';
    this.runStatus = runStatus;
  }
}

/**
 * Parse + normalize a SARIF 2.1.0 document.
 *
 * Filesystem-free. Throws `SarifIngestError` with a `runStatus` the CLI maps
 * to an exit code; never returns a partial result (see `maxResults`).
 *
 * @param {unknown} doc parsed JSON (the caller owns reading + the byte bound)
 * @param {{bounds?: object}} [opts]
 * @returns {{findings: object[], diagnostics: string[]}}
 */
export function ingestSarif(doc, opts = {}) {
  const bounds = opts.bounds || BOUND_DEFAULTS;
  const diagnostics = [];

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new SarifIngestError('input_malformed', 'SARIF root is not an object');
  }
  if (doc.version !== '2.1.0') {
    throw new SarifIngestError(
      'input_malformed',
      `unsupported SARIF version: ${JSON.stringify(doc.version)} (expected "2.1.0")`,
    );
  }
  if (!Array.isArray(doc.runs)) {
    throw new SarifIngestError('input_malformed', 'SARIF `runs` is not an array');
  }

  // Count before ingesting: exceeding `maxResults` REFUSES the run (audit
  // R2-M1). Partial ingestion would break the every-finding-appears-once
  // contract; routing all of them would make the bound meaningless.
  let total = 0;
  for (const run of doc.runs) {
    if (run && Array.isArray(run.results)) total += run.results.length;
  }
  if (total > bounds.maxResults) {
    throw new SarifIngestError(
      'unverified',
      `SARIF carries ${total} results, above maxResults=${bounds.maxResults} — run refused`,
    );
  }

  const findings = [];
  const occurrences = new Map();

  for (const run of doc.runs) {
    if (!run || typeof run !== 'object') {
      diagnostics.push('run-skipped-malformed');
      continue;
    }
    const toolName = run.tool?.driver?.name ?? 'unknown';
    const results = Array.isArray(run.results) ? run.results : [];

    for (const result of results) {
      const perFinding = [];

      const rawMessage =
        typeof result?.message?.text === 'string' ? result.message.text : '';
      // Redact at the boundary where the field first exists (SC2): a
      // hardcoded-secret rule routinely quotes the matched literal in
      // `message.text`, and the renderer consumes only this object.
      // `redactSecrets` returns `{text, redacted[]}` — the count is recorded
      // as a diagnostic so a redaction is observable rather than silent.
      const redactedMessage = redactSecrets(rawMessage);
      let message = redactedMessage.text;
      if (redactedMessage.redacted.length > 0) {
        perFinding.push(`message-redacted:${redactedMessage.redacted.length}`);
      }
      let messageTruncated = false;
      if (message.length > bounds.maxMessageChars) {
        message = message.slice(0, bounds.maxMessageChars);
        messageTruncated = true;
      }

      const redactedRaw = redactSecrets(JSON.stringify(result?.locations ?? null));
      const rawLocation = redactedRaw.text;
      if (redactedRaw.redacted.length > 0) {
        perFinding.push(`rawlocation-redacted:${redactedRaw.redacted.length}`);
      }

      const primaryPl = result?.locations?.[0]?.physicalLocation ?? null;
      const primaryPath = primaryPl
        ? resolveArtifactUri(primaryPl.artifactLocation, run, perFinding)
        : (perFinding.push('location-absent'), null);

      const sink = resolveSinkPhysicalLocation(result);
      let sinkPath = null;
      if (sink.physicalLocation) {
        sinkPath = resolveArtifactUri(
          sink.physicalLocation.artifactLocation,
          run,
          perFinding,
        );
      }
      // A sink whose URI will not resolve is not a sink we can evaluate.
      const sinkResolution = sink.physicalLocation && sinkPath
        ? sink.mode
        : 'unresolved';
      if (sinkResolution === 'unresolved') perFinding.push('sink-unresolved');

      const ruleId = typeof result?.ruleId === 'string' ? result.ruleId : '';
      const hash = contentHash(ruleId, rawLocation, message);
      const occurrenceIndex = occurrences.get(hash) ?? 0;
      occurrences.set(hash, occurrenceIndex + 1);

      findings.push({
        findingId: `${hash}:${occurrenceIndex}`,
        occurrenceIndex,
        ruleId,
        toolName,
        location: primaryPath
          ? { path: primaryPath, region: regionOf(primaryPl) }
          : null,
        sinkLocation:
          sinkResolution === 'unresolved' || !sinkPath
            ? null
            : { path: sinkPath, region: regionOf(sink.physicalLocation) },
        sinkResolution,
        rawLocation,
        message,
        messageTruncated,
        level: typeof result?.level === 'string' ? result.level : 'none',
        diagnostics: perFinding,
      });
    }
  }

  return { findings, diagnostics };
}

export const _internals = Object.freeze({ contentHash, regionOf, normaliseSlashes });
