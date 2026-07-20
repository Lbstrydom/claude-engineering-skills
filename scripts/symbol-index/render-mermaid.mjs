#!/usr/bin/env node
/**
 * @fileoverview Phase E — architecture-map.md renderer.
 *
 * Reads symbol_index + symbol_file_imports + domain_summaries for the
 * active snapshot via direct learning-store imports (this script is part
 * of the symbol-index pipeline, not a downstream skill). Composes the
 * rendered map via lib/arch-render.mjs and atomically writes to
 * docs/architecture-map.md (or --out path).
 *
 * Cloud-off: writes a stub file noting the cloud is disabled.
 *
 * @module scripts/symbol-index/render-mermaid
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { atomicWriteFileSync } from '../lib/file-io.mjs';
import { detectRepoStack } from '../lib/repo-stack.mjs';
import { assertKnownFlags, ArgvError } from '../lib/cli-io.mjs';
import {
  initLearningStore,
  isCloudEnabled,
  getRepoIdByUuid,
  getActiveSnapshot,
  listSymbolsForSnapshot,
  listLayeringViolationsForSnapshot,
  computeDriftScore,
  getImportersForFiles,
  listFileImportsForSnapshot,
  getGraphCoverage,
} from '../learning-store.mjs';
import { resolveRepoIdentity } from '../lib/repo-identity.mjs';
import { renderArchitectureMap } from '../lib/arch-render.mjs';
import { symbolIndexConfig } from '../lib/config.mjs';
import { assertRepoRoot } from '../lib/assert-repo-root.mjs';
import { loadDomainRules, loadCoverageConfig } from '../lib/symbol-index/domain-tagger.mjs';
import { graphVerdict } from '../lib/symbol-index/graph-verdict.mjs';
import {
  assessAttributionCoverage, assertAttributionExhaustive,
} from '../lib/symbol-index/graph-coverage.mjs';
import {
  OBSERVED_FILE,
  OBSERVED_VERSION,
  ObservedDepsSchema,
  computeDomainMapDigest,
  computeObservedDomainDepsWithCoverage,
} from '../lib/observed-deps.mjs';

/** Every flag this CLI accepts. `assertKnownFlags` rejects anything else. */
export const KNOWN_FLAGS = Object.freeze(['--out']);

function parseArgs(argv) {
  // Same sweep as refresh.mjs / prune.mjs / remove-legacy-synced.mjs: an
  // ignored flag lets an operator believe they asked for something the CLI
  // never did. `arch:render --dry-run` used to render for real, silently.
  assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'arch:render' });
  const args = { out: 'docs/architecture-map.md' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out') {
      const value = argv[++i];
      // Validate arity here — assertKnownFlags deliberately checks names only.
      // Without this, `--out` with no value put `undefined` into path.resolve
      // and surfaced as an implementation error instead of a CLI diagnostic.
      if (!value || value.startsWith('--')) {
        throw new ArgvError('arch:render: --out requires a file path (e.g. --out docs/architecture-map.md)');
      }
      args.out = value;
    }
  }
  return args;
}

function commitSha() {
  try { return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().slice(0, 12); }
  catch { return null; }
}

function classify(score, threshold) {
  if (score <= threshold * 0.5) return 'GREEN';
  if (score <= threshold) return 'AMBER';
  return 'RED';
}

/**
 * R3-H1/H2: remove any lingering observed-deps file. Called from every
 * early-exit path so the dashboard never reads a stale envelope when
 * arch:render couldn't produce a fresh one (cloud-off, no repo, no
 * active snapshot). Idempotent + silent when no file present.
 */
function cleanupStaleObservedDeps(repoRoot) {
  const observedPath = path.join(repoRoot, OBSERVED_FILE);
  try {
    if (fs.existsSync(observedPath)) {
      fs.unlinkSync(observedPath);
      process.stderr.write(`arch:render: cleared stale ${OBSERVED_FILE} (render aborted before observed-deps step)\n`);
    }
    return true;
  } catch (err) {
    process.stderr.write(`arch:render: failed to clear ${OBSERVED_FILE} — ${err.message}\n`);
    // Logging the failure and returning was survivable when this file held
    // only `deps`. It is not now: the envelope carries a COVERAGE VERDICT, so
    // a surviving stale file can report `verified` for a render that failed
    // before measuring anything — green without having checked, which is the
    // exact class this feature exists to end (round-1 Cluster B audit, HIGH).
    //
    // If the file cannot be removed, NEUTRALISE it: overwrite with content the
    // reader rejects. `readObservedEnvelope` classifies a schema failure as
    // `schema-invalid` → observedAvailable:false → manual-only + a warning,
    // which is precisely the fail-safe deletion was there to achieve. Writing
    // a well-formed envelope instead would require fabricating a refreshId and
    // a digest — inventing provenance to express "we have none".
    try {
      fs.writeFileSync(observedPath,
        JSON.stringify({
          __invalidated: true,
          reason: 'arch:render aborted before the observed-deps step and could not remove this file',
          invalidatedAt: new Date().toISOString(),
        }, null, 2) + '\n');
      process.stderr.write(`arch:render: could not delete ${OBSERVED_FILE}; invalidated it in place instead\n`);
      return true;
    } catch (err2) {
      process.stderr.write(
        `arch:render: FATAL — ${OBSERVED_FILE} is stale, undeletable AND unwritable (${err2.message}). `
        + `Downstream readers would consume a stale coverage verdict; refusing to exit 0.\n`
      );
      return false;
    }
  }
}

/**
 * Cleanup, or die trying.
 *
 * Every caller's exit-0 is conditional on the stale envelope being gone or
 * neutralised. Exiting 0 with a readable stale coverage verdict on disk is
 * worse than failing the command: the dashboard and the gate would both
 * consume it as current. §2.1.6 reserves non-zero for a genuine tool error,
 * and "cannot invalidate a stale artifact" is exactly that — it is not a
 * coverage verdict, so it does not violate the never-abort-the-chain rule
 * (which exists so a DEGRADED graph still renders, not so an unwritable disk
 * passes silently).
 */
function cleanupOrFail(repoRoot) {
  if (!cleanupStaleObservedDeps(repoRoot)) process.exit(1);
}

/**
 * Gemini-R3-M3 (split-brain prevention): when an early-exit aborts the
 * render before we can produce a fresh `architecture-map.md`, replace any
 * prior markdown with a stub so the architecture-map artifact and the
 * (deleted) observed-deps file are CONSISTENTLY unavailable rather than
 * presenting half-stale state to the dashboard.
 */
function writeAbortStub(outPath, identityName, reason, hint) {
  const stub = [
    '<!-- audit-loop:architectural-map -->',
    `# Architecture Map — ${identityName}`,
    '',
    `- Generated: ${new Date().toISOString()}   commit: ${commitSha() || 'unknown'}   refresh_id: none`,
    `- Status: ${reason}`,
    '',
    hint,
    '',
  ].join('\n');
  // Gemini-R4-G2: do NOT swallow the write failure. If the stub can't be
  // persisted (disk full, permissions, etc.), the main() top-level .catch()
  // exits with code 1 instead of pretending the abort was "graceful". The
  // dashboard then sees the non-zero exit and the operator gets the real
  // error rather than a silently stale architecture-map.
  atomicWriteFileSync(outPath, stub);
}

async function main() {
  assertRepoRoot(import.meta.url);
  const args = parseArgs(process.argv);
  const outPath = path.resolve(args.out);
  const repoRoot = process.cwd();
  await initLearningStore();

  const identity = resolveRepoIdentity(repoRoot);

  if (!await isCloudEnabled()) {
    // Gemini-R2-M3-stub: clear stale observed-deps BEFORE writing the
    // stub. If the stub write throws, the stale envelope is already gone —
    // the dashboard can't accidentally consume both the old observed file
    // AND the new cloud-disabled stub.
    cleanupOrFail(repoRoot);
    writeAbortStub(outPath, identity.name, 'cloud-disabled — run `npm run arch:refresh` to populate',
      'Architectural memory cloud store is not configured for this repo.\n' +
      'Set `AUDIT_DB_URL` (Supabase Dashboard → Connect → Session pooler)\n' +
      'in `.env`, then `npm run arch:refresh`. The legacy\n' +
      '`SUPABASE_AUDIT_*` triplet was sunset in postgres-parity M4.');
    process.stderr.write(`arch:render: cloud disabled — wrote stub to ${outPath}\n`);
    process.exit(0);
  }

  const repo = await getRepoIdByUuid(identity.repoUuid);
  if (!repo) {
    cleanupOrFail(repoRoot);
    writeAbortStub(outPath, identity.name, 'repo-not-registered',
      'Repo not found in architectural-memory store. Run `npm run arch:refresh` first.');
    process.stderr.write(`arch:render: repo not found in store — wrote stub, run \`npm run arch:refresh\` first\n`);
    process.exit(0);
  }
  const snap = await getActiveSnapshot(repo.id);
  if (!snap?.refreshId) {
    cleanupOrFail(repoRoot);
    writeAbortStub(outPath, identity.name, 'no-active-snapshot',
      'Repo is registered but has no active snapshot. Run `npm run arch:refresh` first.');
    process.stderr.write(`arch:render: no active snapshot — wrote stub, run \`npm run arch:refresh\` first\n`);
    process.exit(0);
  }

  // Page through all symbols. Default cap raised from 5000 → 50000 (was
  // silently truncating wine-cellar at 5377). Configurable via env var
  // for huge monorepos; loud warning to stderr if the cap is hit so the
  // user knows the rendered map is incomplete.
  const cap = symbolIndexConfig.renderMaxSymbols;
  const allSymbols = [];
  let offset = 0;
  let truncatedAtCap = false;
  while (allSymbols.length < cap) {
    const remaining = cap - allSymbols.length;
    const pageLimit = Math.min(500, remaining);
    const page = await listSymbolsForSnapshot({ refreshId: snap.refreshId, limit: pageLimit, offset });
    if (!page || page.length === 0) break;
    allSymbols.push(...page);
    if (page.length < pageLimit) break;
    offset += pageLimit;
  }
  // Probe whether more rows exist beyond our cap so we can warn.
  if (allSymbols.length === cap) {
    const probe = await listSymbolsForSnapshot({ refreshId: snap.refreshId, limit: 1, offset: cap });
    if (probe && probe.length > 0) {
      truncatedAtCap = true;
      process.stderr.write(`arch:render: WARN — symbol cap of ${cap} hit; some symbols not rendered. Raise ARCH_RENDER_MAX_SYMBOLS env var to include more.\n`);
    }
  }

  const violations = await listLayeringViolationsForSnapshot(snap.refreshId);
  // R1 H8/M8: do NOT silently substitute score=0 on RPC failure — that gives
  // a false GREEN signal in a rendered surface humans trust. Surface the
  // failure as a distinct status so the document tells the truth.
  let drift = { score: 0 };
  let driftStatus;
  const threshold = symbolIndexConfig.driftThreshold;
  try {
    drift = await computeDriftScore({
      repoId: repo.id, refreshId: snap.refreshId,
      simDup: symbolIndexConfig.driftSimDup,
      simName: symbolIndexConfig.driftSimName,
    });
    driftStatus = classify(Number(drift.score) || 0, threshold);
  } catch (err) {
    process.stderr.write(`arch:render: drift_score RPC failed: ${err.message}\n`);
    driftStatus = 'INSUFFICIENT_DATA';
  }
  const status = driftStatus;

  // Plan v6 §2.5 — generate (or reuse cached) per-domain summaries
  // before render. Best-effort — if Haiku/Anthropic key is missing
  // OR Supabase write fails, render proceeds with empty summaries.
  let domainSummaries = new Map();
  try {
    const { summariseDomains } = await import('./summarise-domains.mjs');
    const r = await summariseDomains({ repoId: repo.id, refreshId: snap.refreshId });
    for (const [d, v] of r.summaries) domainSummaries.set(d, v.summary);
    process.stderr.write(`arch:render: domain summaries — total=${r.stats.total} cached=${r.stats.cacheHits} fresh=${r.stats.fresh} failed=${r.stats.failed}\n`);
  } catch (err) {
    process.stderr.write(`arch:render: domain summaries skipped — ${err.message}\n`);
  }

  // Plan v6 §2.6 — fetch file-level importers for "Where used" column.
  // Best-effort — if symbol_file_imports is empty (pre-feature snapshot)
  // the map is empty; renderer falls back to "(unknown)" markers via
  // importGraphPopulated flag.
  //
  // Audit-Gemini-G3: initialize to null (NOT new Map()). On RPC failure
  // the renderer must OMIT the column entirely, not render every symbol
  // as "(internal)" which would silently lie about all importer data.
  let importerMap = null;
  try {
    const allFilePaths = Array.from(new Set(allSymbols.map(s => s.filePath)));
    importerMap = await getImportersForFiles({
      refreshId: snap.refreshId, paths: allFilePaths,
    });
  } catch (err) {
    importerMap = null;  // explicit — fail-safe to omit column
    process.stderr.write(`arch:render: importers fetch failed — ${err.message}; column omitted to avoid false-leaf labels\n`);
  }

  // Which non-JS/TS stacks does this repo actually carry? `stackKinds` (not
  // `stack`) is the right field: a repo with a package.json AND .java sources
  // reports stack='js-ts' — it clears the gate and its Java half is dropped
  // just as silently as a mixed repo's Python half, which the coarser `stack`
  // enum cannot express. Cheap + pure (markers + a bounded git ls-files).
  //
  // Scoped to stacks that define a SYMBOL namespace someone could duplicate.
  // `postgres` is deliberately excluded: the banner exists so an absent symbol
  // is not misread as nonexistent, and migration DDL is not a symbol space
  // arch-memory reasons about — including it would fire on every repo with a
  // supabase/migrations dir (this one), and a banner that always fires is one
  // nobody reads.
  // Best-effort, like the domain-summary and importer steps above: this is an
  // advisory banner input, and a stack-detection failure must not abort a
  // render that would otherwise succeed. It also sits in the window BETWEEN
  // the early-return cleanups and the observed-deps step's own try/catch — a
  // throw here would reach the top-level fatal handler, which does NOT clear a
  // prior observed-deps envelope, so an unguarded call would let a banner
  // lookup strand a stale coverage verdict on disk. Degrade to "no banner".
  let unindexedStackKinds = [];
  try {
    const SYMBOL_BEARING_STACKS = new Set(['python', 'java']);
    unindexedStackKinds = detectRepoStack(repoRoot).stackKinds
      .filter(k => SYMBOL_BEARING_STACKS.has(k));
  } catch (err) {
    process.stderr.write(`arch:render: stack detection failed — ${err.message}; partial-coverage banner omitted\n`);
  }

  const { markdown, bytesWritten } = renderArchitectureMap({
    repoName: identity.name,
    generatedAt: new Date().toISOString(),
    commitSha: commitSha(),
    refreshId: snap.refreshId,
    drift: drift.score,
    threshold,
    status,
    symbols: allSymbols,
    violations,
    dupSymbolIds: new Set(),
    renderedSymbolCap: truncatedAtCap ? cap : null,
    domainSummaries,
    importerMap,
    importGraphPopulated: snap.importGraphPopulated === true,
    unindexedStackKinds,
  });

  atomicWriteFileSync(outPath, markdown);
  process.stderr.write(`arch:render: wrote ${outPath} (${bytesWritten} bytes, ${allSymbols.length} symbols, ${violations.length} violations)\n`);

  // Plan: docs/plans/observed-domain-deps.md §6 — write the observed-deps
  // envelope from the DB import graph. Best-effort; thrown errors here must
  // not abort the markdown render that already succeeded above.
  const observedPath = path.join(repoRoot, OBSERVED_FILE);
  try {
    // R1-M7: distinguish "snapshot's import graph is populated but empty"
    // (write a valid empty envelope) from "snapshot has no import graph at
    // all" (delete any stale prior file). A populated graph with zero
    // cross-domain edges IS current data — the dashboard should consume it,
    // not fall back to manual-only via 'absent'.
    if (snap.importGraphPopulated === true) {
      const edges = await listFileImportsForSnapshot(snap.refreshId);
      const rules = loadDomainRules(repoRoot);
      const coverageConfig = loadCoverageConfig(repoRoot);
      // The attribution layer is measured HERE because this is where domain
      // rules meet persisted edges — those buckets cannot exist upstream.
      // The extraction layer travels from the DB because its buckets
      // (external/selfEdge/escaping) are dropped before the DB write and are
      // not recomputable downstream (§2.1.2).
      const { deps, buckets, untaggedSamples } = computeObservedDomainDepsWithCoverage(
        edges, rules, { sampleCap: coverageConfig.sampleCap },
      );
      const attribution = assessAttributionCoverage({
        buckets, sampleCap: coverageConfig.sampleCap, untaggedSamples,
      });
      const exhaustive = assertAttributionExhaustive(attribution, edges.length);
      if (!exhaustive.ok) {
        process.stderr.write(`arch:render: WARNING attribution buckets do not account for `
          + `every persisted edge (counted ${exhaustive.actual}, persisted ${exhaustive.expected}) `
          + `— a drop site was added without a bucket\n`);
      }

      // Extraction coverage was measured by a DIFFERENT process (extract.mjs,
      // via refresh.mjs). A missing row means we do not know — which maps to
      // `unknown`/`not_measured`, never to `verified`. Absence is not evidence
      // of cleanliness.
      const persisted = await getGraphCoverage(snap.refreshId);
      const extraction = persisted?.extraction ?? null;
      const stale = persisted?.stale === true;
      const verdict = graphVerdict({ extraction, attribution, stale, config: coverageConfig });

      const envelope = {
        version: OBSERVED_VERSION,
        refreshId: snap.refreshId,
        domainMapDigest: computeDomainMapDigest(rules),
        generatedAt: new Date().toISOString(),
        deps,
        coverage: {
          schemaVersion: 1,
          verdict,
          // Provenance stays with the run that MEASURED it, which is not this
          // refresh when the row was copied forward.
          measuredAt: persisted?.measuredAt ?? new Date().toISOString(),
          refreshId: persisted?.refreshId ?? snap.refreshId,
          stale,
          extraction,
          attribution,
        },
      };
      // R4-M2: validate at write time too. If computeObservedDomainDeps ever
      // produces a malformed shape, fail loudly before persisting; the reader
      // already validates so producer/consumer share the same schema.
      ObservedDepsSchema.parse(envelope);
      // R2-M4: ensure parent dir exists. `.audit-loop/` is committed in
      // source-repo, but a fresh-cloned consumer could theoretically lack it.
      fs.mkdirSync(path.dirname(observedPath), { recursive: true });
      atomicWriteFileSync(observedPath, JSON.stringify(envelope, null, 2) + '\n');
      const edgeCount = Object.values(deps).reduce((n, l) => n + l.length, 0);
      // This line used to report ONLY what survived — `N domains, M edges` —
      // which is the false-authority surface this whole feature exists to end.
      // It now leads with the verdict and names what was dropped.
      const dropped = attribution.edges;
      const untagged = dropped.untaggedFrom + dropped.untaggedTo + dropped.untaggedBoth;
      process.stderr.write(
        `arch:render: wrote ${OBSERVED_FILE} — coverage ${verdict.status.toUpperCase()}`
        + `${verdict.reason ? ` (${verdict.reason})` : ''}`
        + `${stale ? ' [copied forward]' : ''}\n`
      );
      process.stderr.write(
        `arch:render:   surviving: ${Object.keys(deps).length} domains, ${edgeCount} edges`
        + ` · dropped: ${untagged} untagged, ${dropped.sameDomain} same-domain`
        + `${dropped.malformed ? `, ${dropped.malformed} malformed` : ''}`
        + `${extraction ? ` · extraction ${extraction.cruised}/${extraction.eligible}` : ' · extraction NOT MEASURED'}\n`
      );
    } else if (fs.existsSync(observedPath)) {
      fs.unlinkSync(observedPath);
      process.stderr.write(`arch:render: removed stale ${OBSERVED_FILE} (snapshot import graph not populated)\n`);
    } else {
      process.stderr.write(`arch:render: skipped ${OBSERVED_FILE} — snapshot import graph not populated\n`);
    }
  } catch (err) {
    // Gemini-G2: an RPC / write failure here must NOT leave a stale envelope
    // on disk that the dashboard would consume as current. Best-effort
    // cleanup of any prior file so the reader falls back to manual-only.
    process.stderr.write(`arch:render: observed deps failed — ${err.message}; clearing any stale envelope\n`);
    cleanupOrFail(repoRoot);
  }
}

main().catch(err => {
  // A usage mistake is not an operational failure: exit 2 with the message
  // alone (a stack trace buries the one line the operator needs to read).
  // Same contract as prune.mjs / refresh.mjs — 2 = bad input, 1 = tool error.
  if (err?.code === 'ARGV_ERROR') {
    // No prefix added here: both argv-error sources already lead with
    // "arch:render:", and prefixing again yields "arch:render: arch:render:".
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`arch:render: fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
