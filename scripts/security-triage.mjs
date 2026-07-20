#!/usr/bin/env node
/**
 * SAST triage CLI — the Phase-3 I/O shell.
 *
 * Plan: docs/plans/sast-triage-routing.md — Phase 3.
 *
 * `--sarif <file>` ingest ONLY (D5): this CLI never executes a scanner. The
 * operator produces the SARIF (`snyk code test --sarif > out.sarif`, Semgrep,
 * CodeQL) and passes the path. That keeps the tool scanner-agnostic, keeps
 * scanner tokens out of our process, and makes the failure model tractable.
 *
 * **This is the only layer that touches the filesystem.** `sarif.mjs` resolves
 * URIs lexically and `triage-router.mjs` is pure; canonicalization (SC1),
 * classification, and the bounded read all live here.
 *
 * v1 calls NO model (D4). There is no branch where a provider can emit
 * "clean", because there is no provider.
 *
 * Deliberately has no `--selfcheck-relocation` handler: this CLI is not part of
 * a synced consumer surface in v1 (audit R1-L1). Add one if consumer sync lands.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';

import {
  ingestSarif,
  SarifIngestError,
  ConfigSchema,
  TriageReportSchema,
  resolveBounds,
} from './lib/security/sarif.mjs';
import { routeFindings } from './lib/security/triage-router.mjs';
import { resolveAndClassify } from './lib/sensitive-paths.mjs';
import { redactSecrets } from './lib/secret-patterns.mjs';

// ---------------------------------------------------------------------------
// D5a — one run-status state machine; exit-code precedence is total.
// ---------------------------------------------------------------------------

export const EXIT_CODES = Object.freeze({
  config_invalid: 6,
  input_unreadable: 4,
  input_malformed: 5,
  unverified: 4,
  needs_review: 3,
  routed_clean: 0,
});

/**
 * Statuses are mutually exclusive and evaluated in a fixed order — the first
 * match wins. Pure, so the precedence table is testable without any I/O: a run
 * that is BOTH config-invalid and malformed must exit 6, not 5.
 *
 * `0` is unreachable from an empty, failed, or unparsed input by construction.
 * `routed_clean` explicitly means "≥1 finding parsed and every one routed to
 * C/D", never "no findings" — a real scan finds *something* to say, and zero
 * results are indistinguishable from a scanner that never ran.
 */
export function resolveRunStatus(flags) {
  const pick = (runStatus) => ({ runStatus, exitCode: EXIT_CODES[runStatus] });
  if (flags.configInvalid) return pick('config_invalid');
  if (flags.inputUnreadable) return pick('input_unreadable');
  if (flags.inputMalformed) return pick('input_malformed');
  if (flags.zeroResults) return pick('unverified');
  if (flags.bucketANonEmpty) return pick('needs_review');
  return pick('routed_clean');
}

// ---------------------------------------------------------------------------
// Path classification (SC1 / INC-001)
// ---------------------------------------------------------------------------

/**
 * Map `resolveAndClassify`'s result onto the router's four-state contract.
 *
 * Order matters and is fail-closed: a path we could not RESOLVE is reported as
 * `unresolved` rather than folded into `sensitive`, because the router treats
 * every non-`ok` state as blocking and the report should say which one it was.
 */
export function classifyLocationPath(rawPath, repoRoot, deps = {}) {
  const classify = deps.resolveAndClassify || resolveAndClassify;
  const res = classify(rawPath, { repoRoot, ...(deps.fs ? { fs: deps.fs } : {}) });

  let pathClassification = 'ok';
  if (res.resolutionFailed) pathClassification = 'unresolved';
  else if (res.escapedRepo) pathClassification = 'escaped';
  else if (res.category === 'sensitive') pathClassification = 'sensitive';

  const canonicalPath = res.canonical || path.resolve(repoRoot, rawPath);

  // Record the identity of the object we CLASSIFIED, so the eventual read can
  // prove it is opening the same one. `O_NOFOLLOW` refuses a symlink at the
  // final component but says nothing about a path swapped for a different
  // regular file, so on its own the classification and the read are two
  // separate claims about two possibly-different objects. Comparing dev+ino
  // does not close the race — nothing short of a handle held across both can —
  // but it turns an undetected swap into a refused read.
  //
  // Read with `{bigint: true}`. A Windows inode is routinely larger than
  // `Number.MAX_SAFE_INTEGER` (observed: 26177172837460940), so as a float it
  // silently loses precision and two DIFFERENT inodes can compare equal — an
  // identity check that cannot tell objects apart is worse than none, because
  // it reads as enforced. BigInt compares exactly.
  let identity = null;
  if (pathClassification === 'ok') {
    try {
      const statSync = deps.statSync || fs.statSync;
      const s = statSync(canonicalPath, { bigint: true });
      identity = { dev: s.dev, ino: s.ino };
    } catch {
      identity = null; // unreadable now; the read will withhold anyway
    }
  }
  // The router's glob matcher anchors with `^` against a REPO-RELATIVE path,
  // but resolveAndClassify returns an ABSOLUTE realpath (Gemini G3). Without
  // this conversion `tests/**` silently matches nothing and `path-scope`
  // becomes a no-op — a predicate that reads as configured and does nothing.
  const repoRelativePath = path
    .relative(repoRoot, canonicalPath)
    .split(path.sep)
    .join('/');

  return { pathClassification, canonicalPath, repoRelativePath, identity };
}

// ---------------------------------------------------------------------------
// Bounded source read (§2c) — an algorithm, not an assertion.
// ---------------------------------------------------------------------------

/**
 * Read lines 1..`maxLine` of a file without allocating the whole thing.
 *
 * A `readFile` followed by a length check has ALREADY allocated the file,
 * which defeats the bound. So: stat first, refuse before opening if oversized,
 * then a streaming line scan that aborts once the last needed line is passed.
 */
export async function readBoundedLines(absPath, maxLine, maxBytes, deps = {}, expectIdentity = null) {
  const openFn = deps.open || fsp.open;
  const createReadStream = deps.createReadStream || fs.createReadStream;

  // Open FIRST, then `fstat` the handle. A `stat`-then-open sequence checks one
  // filesystem object and reads another: the path can be swapped or the file
  // grown in between, and the stream is not constrained by the size that was
  // observed. Binding the size and type checks to the opened HANDLE removes
  // that window instead of narrowing it.
  //
  // `O_NOFOLLOW` additionally refuses a symlink at the final component, so a
  // link swapped in after `resolveAndClassify` classified the path cannot
  // redirect the read. It is absent on some platforms (notably Windows), where
  // this degrades to the handle-bound checks alone — the residual risk is
  // recorded rather than papered over.
  const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
  let fh;
  try {
    fh = await openFn(absPath, fs.constants.O_RDONLY | O_NOFOLLOW);
  } catch {
    return { lines: null, withheld: 'unreadable' };
  }

  let st;
  try {
    st = deps.fstat ? await deps.fstat(fh, absPath) : await fh.stat();
  } catch {
    await fh.close().catch(() => {});
    return { lines: null, withheld: 'unreadable' };
  }
  // Only ever read a regular file — a path swapped for a FIFO, device, or
  // directory would otherwise be streamed, and a FIFO would block forever.
  if (typeof st.isFile === 'function' && !st.isFile()) {
    await fh.close().catch(() => {});
    return { lines: null, withheld: 'unreadable' };
  }
  if (st.size > maxBytes) {
    await fh.close().catch(() => {});
    return { lines: null, withheld: 'too-large' };
  }
  // Prove the object we OPENED is the object that was CLASSIFIED. Without
  // this, classification and read are two claims about two possibly-different
  // files: `O_NOFOLLOW` stops a symlink at the final component, but a path
  // swapped for a different regular file passes it silently. A mismatch is
  // refused rather than read — the swap becomes visible instead of effective.
  if (expectIdentity && expectIdentity.ino != null) {
    let actual = null;
    try {
      // BigInt, matching how the expectation was recorded — see
      // classifyLocationPath on why float inodes cannot be compared safely.
      actual = deps.bigintFstat
        ? await deps.bigintFstat(fh, absPath)
        : await fh.stat({ bigint: true });
    } catch {
      actual = null;
    }
    const same =
      actual != null &&
      String(actual.dev) === String(expectIdentity.dev) &&
      String(actual.ino) === String(expectIdentity.ino);
    if (!same) {
      await fh.close().catch(() => {});
      return { lines: null, withheld: 'unreadable' };
    }
  }

  return new Promise((resolve) => {
    const lines = [];
    let seen = 0;
    let stream;
    try {
      // `end` bounds the read BY CONSTRUCTION, which is what actually holds
      // for a single enormous line: a stream emits no `line` event until it
      // sees a newline, so a byte counter alone never gets a chance to run.
      //
      // Node treats `end` as INCLUSIVE, so this reads at most maxBytes+1 bytes
      // — deliberately one over, so a file of EXACTLY maxBytes still reads
      // cleanly while maxBytes+1 is detectable as over-bound below.
      stream = createReadStream(null, {
        fd: fh.fd,
        encoding: 'utf8',
        start: 0,
        end: maxBytes,
        autoClose: false,
      });
    } catch {
      fh.close().catch(() => {});
      resolve({ lines: null, withheld: 'unreadable' });
      return;
    }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      rl.close();
      stream.destroy();
      fh.close().catch(() => {});
      resolve(value);
    };
    // `if (done) return` and the defensive copy are both load-bearing.
    // `resolve()` hands back a REFERENCE, and readline keeps emitting buffered
    // lines after `close()` within the same tick — so without these the caller
    // received an array that kept growing to the whole file. The bound would
    // have read as enforced while enforcing nothing, which is precisely the
    // green-that-checked-nothing shape this plan is built to avoid.
    // Count the bytes the STREAM actually delivered. Reconstructing them from
    // decoded lines (`byteLength(line) + 1`) invents a trailing LF for every
    // line and mis-measures CRLF input, so a file legitimately at the bound
    // was rejected for bytes it never contained. Attached immediately after
    // `createInterface`, synchronously, so no chunk is missed.
    stream.on('data', (chunk) => {
      seen += typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.length;
    });

    rl.on('line', (line) => {
      if (done) return;
      lines.push(line);
      if (lines.length >= maxLine) finish({ lines: lines.slice(), withheld: null });
    });
    // Reaching the range cap means the file had MORE to give than the bound
    // allows, so the window may be truncated. Reporting `too-large` rather
    // than handing back a silently short window keeps the predicates from
    // analysing source they only partly saw.
    rl.on('close', () =>
      finish(
        seen > maxBytes
          ? { lines: null, withheld: 'too-large' }
          : { lines: lines.slice(), withheld: null },
      ),
    );
    stream.on('error', () => finish({ lines: null, withheld: 'unreadable' }));
  });
}

const fileCommitCache = new Map();

/**
 * When a file was last committed, for the §2d-iii coherence check.
 *
 * An untracked or unknown file yields null, which means "cannot compare" and
 * therefore never marks evidence stale — the check may refuse to demote, but it
 * must never invent staleness it cannot demonstrate.
 */
export function lastCommitTime(absPath, deps = {}) {
  if (fileCommitCache.has(absPath)) return fileCommitCache.get(absPath);
  let when = null;
  try {
    const exec = deps.execFileSync || execFileSync;
    const out = exec('git', ['log', '-1', '--format=%cI', '--', absPath], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (out) {
      const t = new Date(out);
      if (!Number.isNaN(t.getTime())) when = t;
    }
  } catch { /* untracked, or not a git repo */ }
  fileCommitCache.set(absPath, when);
  return when;
}

/**
 * Enrich ingested findings with everything the pure router needs.
 *
 * Findings are grouped by SINK file before any read (audit R3-M2), so 108
 * findings in one file cost one classification + one bounded scan, not 108 —
 * and the scan still stops at the last line any finding in that file needs.
 */
export async function enrichFindings(findings, { repoRoot, bounds, scanTime = null, deps = {} }) {
  const routable = [];

  // `identity` is adapter-internal plumbing for the read gate. It is kept OUT
  // of the location objects deliberately: the router has no use for it, the
  // strict routable schema rejects it, and dev/ino in a report that gets
  // pasted into issues and chat is host detail nobody asked for.
  const identityByPath = new Map();

  for (const f of findings) {
    const enriched = { ...f };
    for (const key of ['location', 'sinkLocation']) {
      if (!f[key]) continue;
      const { identity, ...locFields } = classifyLocationPath(f[key].path, repoRoot, deps);
      enriched[key] = { ...f[key], ...locFields };
      if (identity) identityByPath.set(locFields.repoRelativePath, identity);
    }
    // §2d-iii: mark the finding when EITHER of its files was committed after
    // the scan. Both, not just the sink: the primary location's line numbers
    // are what the report shows a human, and a shifted one sends them to the
    // wrong place. `scanTime === null` means the SARIF carried no provenance —
    // that is "cannot check", so nothing is marked and the report says so.
    if (scanTime) {
      for (const key of ['location', 'sinkLocation']) {
        const loc = enriched[key];
        if (!loc?.canonicalPath) continue;
        const committed = lastCommitTime(loc.canonicalPath, deps);
        if (committed && committed > scanTime) { enriched.evidenceStale = true; break; }
      }
    }
    routable.push(enriched);
  }

  // Group by sink file — only sinks are ever read.
  const byFile = new Map();
  for (const f of routable) {
    const sink = f.sinkLocation;
    // SC2 gate 1: a sensitive, unresolvable, or escaped target is NEVER
    // opened. Asserting the classifier was *called* is not the same as
    // asserting the file was not read, so the read is gated here, at the
    // only place a read can happen.
    if (!sink || sink.pathClassification !== 'ok' || !sink.region) continue;
    const entry = byFile.get(sink.repoRelativePath) || {
      canonicalPath: sink.canonicalPath,
      identity: identityByPath.get(sink.repoRelativePath) ?? null,
      maxLine: 0,
      findings: [],
    };
    entry.maxLine = Math.max(entry.maxLine, sink.region.endLine + bounds.maxSinkLines);
    entry.findings.push(f);
    byFile.set(sink.repoRelativePath, entry);
  }

  const sourceByPath = new Map();
  for (const [relPath, entry] of byFile) {
    const { lines, withheld } = await readBoundedLines(
      entry.canonicalPath,
      entry.maxLine,
      bounds.maxSourceBytesPerFile,
      deps,
      entry.identity,
    );
    if (lines) sourceByPath.set(relPath, lines);
    for (const f of entry.findings) {
      if (withheld) {
        f.contextWithheld = withheld;
        continue;
      }
      // Redact IMMEDIATELY after the read, before the finding reaches the
      // router — the boundary where the field first exists (SC2). The report
      // gets pasted into issues, PRs, and chat.
      const region = f.sinkLocation.region;
      const start = Math.max(0, region.startLine - 1);
      // Clamped to maxSinkLines, not just to the region. The region is
      // attacker-influenced input (it comes from the SARIF), so an oversized
      // one would otherwise put an unbounded excerpt into a report that gets
      // pasted into issues, PRs, and chat — a configured bound that the
      // reporting path quietly ignored.
      const end = Math.min(lines.length, region.endLine, start + bounds.maxSinkLines);
      f.sourceContext = redactSecrets(lines.slice(start, end).join('\n')).text;
    }
  }

  for (const f of routable) {
    if (f.sinkLocation && f.sinkLocation.pathClassification !== 'ok') {
      f.contextWithheld = 'sensitive';
    }
  }

  return { routable, sourceByPath };
}

// ---------------------------------------------------------------------------
// Config + input
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG_BASENAME = '.security-triage.json';

/**
 * There is no implicit default policy. A silently-defaulted security policy is
 * exactly the kind of thing that reads as configured when it isn't, so an
 * absent config file is `config_invalid`, not a fallback.
 */
export function loadConfig(configPath, deps = {}) {
  const readFileSync = deps.readFileSync || fs.readFileSync;
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    return { ok: false, error: `config not found or unreadable: ${configPath}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `config is not valid JSON: ${err.message}` };
  }
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: `config failed validation: ${result.error.message}` };
  }
  return { ok: true, config: result.data };
}

export function resolveRepoRoot(explicit, deps = {}) {
  // The root is REALPATH'd, because `classifyLocationPath` derives
  // `repoRelativePath` as `path.relative(repoRoot, canonicalPath)` and
  // `canonicalPath` is always canonical. Comparing a non-canonical root
  // against a canonical target silently produces `../…` — which reads as an
  // escaped repo, fails closed, and would route every finding to `A`. It bites
  // wherever the root reaches the process through a symlink: macOS `/tmp` →
  // `/private/tmp`, Windows 8.3 short paths, a symlinked checkout.
  const realpathSync = deps.realpathSync || fs.realpathSync;
  const canonicalise = (p) => {
    try {
      return realpathSync(path.resolve(p));
    } catch {
      return path.resolve(p);
    }
  };

  if (explicit) return { ok: true, repoRoot: canonicalise(explicit) };
  const exec = deps.execFileSync || execFileSync;
  try {
    const out = exec('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    return { ok: true, repoRoot: canonicalise(out.trim()) };
  } catch {
    // Every security decision downstream is relative to this root, so guessing
    // cwd would silently relocate the whole policy.
    return { ok: false, error: 'not a git repository — pass --repo-root <path>' };
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export function renderReport(report) {
  const L = [];
  L.push('');
  L.push('═══════════════════════════════════════');
  L.push(`  SAST triage — ${report.runStatus} (exit ${report.exitCode})`);
  L.push(`  A unexplained: ${report.counts.A}   C likely-mitigated: ${report.counts.C}   D out-of-reach: ${report.counts.D}`);
  L.push('═══════════════════════════════════════');

  // Provenance line always prints. A run that could not check coherence must
  // say so — "no stale evidence" and "could not look" are different claims.
  const prov = report.scanProvenance;
  if (prov) {
    L.push('');
    if (prov.source === 'unavailable') {
      L.push('  ⚠ SARIF carries no scan time — source-coherence UNCHECKED.');
      L.push('    A scan taken against a different tree resolves sinks to code that has moved,');
      L.push('    and it fails toward demotion. This is not a clean bill of health.');
    } else if (prov.staleFindings > 0) {
      L.push(`  ⚠ ${prov.staleFindings} finding(s) reference a file committed AFTER the scan (${prov.scanTime}).`);
      L.push('    Their evidence predates the code, so each is held in A rather than demoted on it.');
      L.push('    Re-scan against the current tree to triage them.');
    } else {
      L.push(`  Scan-source coherence OK — no referenced file postdates the scan (${prov.scanTime}).`);
    }
  }

  if (report.counts.A > 0) {
    L.push('');
    L.push(`Bucket A — no predicate matched. REVIEW FIRST (${report.counts.A}):`);
    for (const f of report.findings.filter((x) => x.bucket === 'A').slice(0, 20)) {
      const where = f.location ? `${f.location.repoRelativePath}:${f.location.region?.startLine ?? '?'}` : '<no location>';
      const why = f.matches.find((m) => m.predicate === 'sensitivity-guard')?.reason;
      L.push(`  • [${f.ruleId}] ${where}${why ? `  (${why})` : ''}`);
    }
    if (report.counts.A > 20) L.push(`  … and ${report.counts.A - 20} more`);
  }

  if (report.counts.C > 0) {
    L.push('');
    L.push(`Bucket C — a heuristic predicate matched. SPOT-CHECK, do not trust (${report.counts.C}).`);
  }

  if (report.unusedPredicates.length > 0) {
    L.push('');
    // Never printed as good news. Zero matches means EITHER no such findings
    // exist OR the predicate is broken — the field incident in D3a2 produced
    // exactly the second while reading as the first.
    L.push('Predicates that matched NOTHING — ambiguous, not clean:');
    for (const p of report.unusedPredicates) {
      L.push(`  • ${p} — either no such findings exist, or this predicate is broken. Both read identically here.`);
    }
  }

  if (report.diagnostics.length > 0) {
    L.push('');
    L.push(`Diagnostics (${report.diagnostics.length}): ${report.diagnostics.slice(0, 5).join('; ')}`);
  }
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

export async function runTriage(argv, deps = {}) {
  const sarifPath = argValue(argv, '--sarif');
  const configArg = argValue(argv, '--config');
  const repoRootArg = argValue(argv, '--repo-root');

  const emptyCounts = { A: 0, C: 0, D: 0 };
  const fail = (flags, diagnostics) => {
    const { runStatus, exitCode } = resolveRunStatus(flags);
    return {
      schemaVersion: 1,
      runStatus,
      exitCode,
      counts: emptyCounts,
      findings: [],
      unusedPredicates: [],
      diagnostics,
    };
  };

  const rootRes = resolveRepoRoot(repoRootArg, deps);
  if (!rootRes.ok) return fail({ configInvalid: true }, [rootRes.error]);
  const repoRoot = rootRes.repoRoot;

  // Config is evaluated FIRST — precedence is total (D5a).
  const configPath = configArg
    ? path.resolve(configArg)
    : path.join(repoRoot, DEFAULT_CONFIG_BASENAME);
  const cfg = loadConfig(configPath, deps);
  if (!cfg.ok) return fail({ configInvalid: true }, [cfg.error]);
  const bounds = resolveBounds(cfg.config);

  if (!sarifPath) return fail({ inputUnreadable: true }, ['--sarif <file> is required']);

  const statSync = deps.statSync || fs.statSync;
  const readFileSync = deps.readFileSync || fs.readFileSync;
  let st;
  try {
    st = statSync(sarifPath);
  } catch {
    return fail({ inputUnreadable: true }, [`SARIF not found or unreadable: ${sarifPath}`]);
  }
  // Checked by `stat` BEFORE the read, so an oversized file is never allocated.
  if (st.size > bounds.maxSarifBytes) {
    return fail({ inputUnreadable: true }, [
      `SARIF is ${st.size} bytes, above maxSarifBytes=${bounds.maxSarifBytes}`,
    ]);
  }

  let doc;
  try {
    doc = JSON.parse(readFileSync(sarifPath, 'utf8'));
  } catch (err) {
    return fail({ inputMalformed: true }, [`SARIF is not valid JSON: ${err.message}`]);
  }

  let ingested;
  try {
    ingested = ingestSarif(doc, { bounds });
  } catch (err) {
    if (err instanceof SarifIngestError) {
      const flags =
        err.triageStatus === 'unverified'
          ? { zeroResults: true }
          : { inputMalformed: true };
      return fail(flags, [err.message]);
    }
    throw err;
  }

  if (ingested.findings.length === 0) {
    return fail({ zeroResults: true }, [
      'SARIF parsed but carries zero results — indistinguishable from a scanner that did not run',
      ...ingested.diagnostics,
    ]);
  }

  const { routable, sourceByPath } = await enrichFindings(ingested.findings, {
    repoRoot,
    bounds,
    scanTime: ingested.provenance?.scanTime ?? null,
    deps,
  });

  const routed = routeFindings(routable, cfg.config, {
    bounds,
    getSource: (k) => sourceByPath.get(k) ?? null,
  });

  const { runStatus, exitCode } = resolveRunStatus({
    bucketANonEmpty: routed.counts.A > 0,
  });

  const staleCount = routed.findings.filter((f) => f.evidenceStale === true).length;
  return {
    schemaVersion: 1,
    runStatus,
    exitCode,
    scanProvenance: {
      scanTime: ingested.provenance?.scanTime?.toISOString() ?? null,
      source: ingested.provenance?.source ?? 'unavailable',
      staleFindings: staleCount,
    },
    counts: routed.counts,
    findings: routed.findings,
    unusedPredicates: routed.unusedPredicates,
    diagnostics: [...ingested.diagnostics, ...routed.diagnostics],
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const report = await runTriage(argv);

  // The renderer consumes ONLY this object, so render and logic cannot
  // diverge. Validating it here means a shape breach is loud, not cosmetic.
  const parsed = TriageReportSchema.safeParse(report);
  if (!parsed.success) {
    process.stderr.write(`[security-triage] report failed its own schema: ${parsed.error.message}\n`);
    process.exit(1);
  }

  const outPath = argValue(argv, '--out');
  if (outPath) {
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(
      `${report.runStatus}: A=${report.counts.A} C=${report.counts.C} D=${report.counts.D} → ${outPath}\n`,
    );
  } else if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderReport(report));
  }
  process.exit(report.exitCode);
}

const isMain = (() => {
  const argv1 = process.argv[1]?.replace(/\\/g, '/');
  if (!argv1) return false;
  return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
})();

if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[security-triage] ${err.stack || err.message}\n`);
    process.exit(1);
  });
}
