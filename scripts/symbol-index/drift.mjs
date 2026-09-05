#!/usr/bin/env node
/**
 * @fileoverview Phase D — drift sweep CLI.
 *
 * Calls the `drift_score` Postgres RPC for the repo's active snapshot,
 * evaluates against thresholds (env-tunable), renders a Markdown report
 * and (optionally) writes it via --out for the GH Action sticky-issue body.
 *
 * Mirrors `scripts/memory-health.mjs` exit-code semantics:
 *   0 — green (or insufficient data)
 *   1 — trigger fired (drift score > threshold)
 *   2 — infra error (RPC failure, no Supabase, etc.)
 *
 * @module scripts/symbol-index/drift
 */

import '../lib/load-env.mjs';
import { findStalePragmas, renderStalePragmaSection } from '../lib/symbol-index/stale-pragma-sweep.mjs';
import { findRepoPragmas, resolvePragmasToDefinitions } from '../lib/duplicate-justification-pragma.mjs';
import {
  initLearningStore,
  isCloudEnabled,
  getRepoIdByUuid,
  getActiveSnapshot,
  computeDriftScore,
  getTopDuplicateClusters,
  listSymbolsForSnapshot,
  countSymbolsForSnapshot,
  getActiveStoreDescriptor,
} from '../learning-store.mjs';
import { resolveRepoIdentity } from '../lib/repo-identity.mjs';
import { symbolIndexConfig } from '../lib/config.mjs';
import { renderDriftIssue } from '../lib/arch-render.mjs';
import { assertRepoRoot } from '../lib/assert-repo-root.mjs';
import { atomicWriteFileSync } from '../lib/file-io.mjs';
import { assertKnownFlags, ArgvError } from '../lib/cli-io.mjs';

/**
 * Every flag this CLI accepts. Enforced rather than documented: `arch:drift`'s
 * exit code is read by CI as `0 green / 1 drift / 2 cannot verify`, and the
 * green branch auto-CLOSES the sticky drift issue — so an ignored `--jsno`
 * running the command with unintended defaults is a wrong verdict acted on,
 * not a cosmetic slip. Its sibling `duplicates.mjs` grew the same guard in the
 * same change (audit R2 H2); leaving one of two sibling CLIs strict is the
 * inconsistency the finding names.
 */
const KNOWN_FLAGS = ['--out', '--json', '--selfcheck-relocation'];

function parseArgs(argv) {
  assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'arch:drift' });
  const args = { out: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out') {
      // round-1 M2: reject a missing/flag-looking value rather than
      // silently consuming the NEXT flag as the path (`--out --json` used
      // to set out="--json" and leave args.json false) — same idiom as
      // refresh-args.mjs's `--since-commit` guard.
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        // ArgvError, not a bare Error (audit R4 M1): main() maps ArgvError to a
        // one-line usage diagnostic, and everything else to the fatal handler's
        // stack trace. Both already exit 2, so this is not a correctness fix —
        // it is the difference between telling an operator what they typed
        // wrong and showing them a stack.
        throw new ArgvError(`arch:drift: --out requires a non-empty path value (got ${JSON.stringify(value ?? null)})`);
      }
      args.out = value;
      i++;
    }
    else if (argv[i] === '--json') args.json = true;
  }
  return args;
}

function atomicWrite(file, content) {
  atomicWriteFileSync(file, content);
}

/**
 * Closed status set (docs/plans/symbol-index-pipeline-reliability-hardening.md
 * Theme 2), mirroring `GRAPH_STATUS`'s "unknown is NOT a synonym for
 * verified/green" doctrine — a missing/non-finite score must never read as
 * GREEN via silent coercion.
 */
const DRIFT_STATUS = Object.freeze({ GREEN: 'GREEN', AMBER: 'AMBER', RED: 'RED', UNKNOWN: 'UNKNOWN' });

// Single source for the pragma-reconciliation candidate-pool cap
// (docs/plans/refactor-symbol-index.md D4/Phase 3). The query `limit` and
// the `capped` comparison below MUST use the same number, or a partial pool
// gets reconciled as if it were complete — resurrecting exactly the false
// "unresolved pragma" warnings the `capped` skip-check exists to prevent
// (see the Gemini final-gate note at the `capped` branch below). Not
// configurable — no current requirement asks for a different value.
const PRAGMA_CANDIDATE_POOL_CAP = 10000;

/**
 * Pure predicate for the pragma-reconciliation cap decision — the ONE thing
 * `main()` calls to decide `capped`, so a test exercises this exact
 * comparison rather than re-deriving an arithmetic tautology of its own
 * (round-1 code-audit M2/M3 on Phase 3: an earlier test asserted `CAP > CAP`
 * directly, which passes regardless of whether this function's operator or
 * cap value ever changes). `totalCount` is the TRUE total from
 * `countSymbolsForSnapshot` (an unbounded COUNT), never the length of the
 * `limit`-bounded candidate array — comparing the bounded array's length
 * here would make `capped` unreachable (it can never exceed its own limit).
 *
 * Deliberately NOT parameterised on `cap` (final-gate shadow finding
 * `28bb874a`): an earlier draft accepted an optional `cap` argument so a
 * test could prove genuine parametricity, but that created a SECOND place a
 * cap value could come from — a caller could pass a different cap here
 * without touching the query's `limit:` argument, silently reopening the
 * exact one-sided-edit risk D4 exists to close. Both this comparison and the
 * query limit now reference the SAME identifier, not merely the same value.
 * @param {number} totalCount
 * @returns {boolean}
 */
function isPragmaPoolCapped(totalCount) {
  // An UNKNOWN total is capped. The count query is best-effort, so `null`
  // reaches here whenever it failed — and `null > CAP` is `false` in JavaScript
  // (null coerces to 0), which would run reconciliation over a possibly-
  // truncated pool and emit exactly the false "unresolved pragma" warnings the
  // cap exists to prevent. Fail closed on anything that is not a real number.
  //
  // This guard used to sit at the CALL SITE as `totalCount === null || …`,
  // which behaved correctly but put the `capped` decision in two places — the
  // very thing this function's docstring says it exists to prevent, and the
  // shape the Gemini gate flagged (it read the predicate alone and concluded
  // the tool failed open). One function decides; the call site just asks.
  if (typeof totalCount !== 'number' || !Number.isFinite(totalCount)) return true;
  return totalCount > PRAGMA_CANDIDATE_POOL_CAP;
}

function classify(driftScore, threshold) {
  if (driftScore <= threshold * 0.5) return DRIFT_STATUS.GREEN;
  if (driftScore <= threshold) return DRIFT_STATUS.AMBER;
  return DRIFT_STATUS.RED;
}

// R1 audit M2: drift.mjs delegates rendering to lib/arch-render.mjs's
// renderDriftIssue() so all three human surfaces (architecture-map.md,
// drift sticky issue, neighbourhood callout) share one renderer. Local
// renderMarkdown() removed.
function renderMarkdownViaShared(drift, threshold, status, identity, clusters, commitSha, symbolCount, store) {
  const { markdown } = renderDriftIssue({
    drift,
    threshold,
    status,
    // The two facts that make the verdict falsifiable: how big the corpus was,
    // and which store it came from. Both may be null, and renderDriftIssue
    // renders null as `unknown` rather than as 0 or as a missing line — see the
    // 2026-09-04 consumer incident written up there.
    symbolCount,
    store,
    generatedAt: drift.generated_at,
    // The SNAPSHOT's commit, read from its `refresh_runs` row — never the
    // refresh UUID (passing that mislabeled a UUID as a git commit, round-1
    // H5) and never the local HEAD, which can have moved since the snapshot
    // was taken. `null` still renders `unknown`, which now means "the snapshot
    // carries no commit" rather than "nobody looked" (consumer report,
    // 2026-09-04).
    commitSha,
    refreshId: drift.refresh_id,
    repoName: identity.name,
    clusters,
    violations: [], // listed elsewhere; map references it
  });
  return markdown + '\n';
}

/**
 * Decide the exit code for the two "the store did not give us anything to
 * compare against" states.
 *
 * These MUST NOT be 0. The callers (.github/workflows/architectural-drift.yml
 * here and in every consumer) map this process's exit code as
 * `0 = green, 1 = drift triggered, 2 = infra error`, and the green branch
 * auto-CLOSES the sticky drift issue. Returning 0 here therefore made
 * "I could not check" indistinguishable from "I checked and it is clean" —
 * and actively closed drift issues while blind.
 *
 * Observed live 2026-08-08 (run 31224329241): an invalid AUDIT_DB_URL made the
 * connection fail, `getRepoIdByUuid` returned null, this path exited 0, and the
 * workflow reported success having audited nothing. Same failure class as the
 * sandbox-honesty rule in AGENTS.md — a check that skips on a missing input
 * passes having read nothing.
 *
 * Note both states are ALSO reached when the DB is simply unreachable: the
 * store swallows the connection error and yields null, so the message names
 * both causes rather than asserting the repo is unindexed.
 *
 * @param {{repo: unknown, snap: {refreshId?: string} | null | undefined}} state
 * @returns {{code: 0 | 2, message: string} | null} null when the state is fine
 */
function resolveStoreGateExit({ repo, snap }) {
  if (!repo) {
    return {
      code: 2,
      message:
        'arch:drift: repo not found in store — the database is unreachable, or this repo '
        + 'has never been indexed. Check AUDIT_DB_URL, then run `npm run arch:refresh`. '
        + 'Exiting 2 (cannot verify) rather than 0, which would read as a clean sweep.\n',
    };
  }
  if (!snap?.refreshId) {
    return {
      code: 2,
      message:
        'arch:drift: no active snapshot for repo — nothing to compare against. '
        + 'Run `npm run arch:refresh`. Exiting 2 (cannot verify) rather than 0, '
        + 'which would read as a clean sweep.\n',
    };
  }
  return null;
}

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  assertRepoRoot(import.meta.url);
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    // Exit 2 ("cannot verify"), never 1 ("drift triggered") — a usage error is
    // not a drift verdict, and CI's green branch must not see either.
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); process.exit(2); }
    throw err;
  }
  await initLearningStore();
  // Deliberately still 0: cloud-disabled is an explicit local opt-out (no
  // AUDIT_DB_URL configured at all), not a failed verification. Both CI paths
  // gate on the DSN before reaching this, so it cannot produce a CI false green.
  if (!await isCloudEnabled()) {
    process.stderr.write('arch:drift: cloud disabled — skipping\n');
    process.exit(0);
  }
  const identity = resolveRepoIdentity(process.cwd());
  const repo = await getRepoIdByUuid(identity.repoUuid);
  const snap = repo ? await getActiveSnapshot(repo.id) : null;
  const gate = resolveStoreGateExit({ repo, snap });
  if (gate) {
    process.stderr.write(gate.message);
    process.exit(gate.code);
  }
  let drift;
  try {
    drift = await computeDriftScore({
      repoId: repo.id,
      refreshId: snap.refreshId,
      simDup: symbolIndexConfig.driftSimDup,
      simName: symbolIndexConfig.driftSimName,
    });
  } catch (err) {
    process.stderr.write(`arch:drift: RPC failed: ${err.message}\n`);
    process.exit(2);
  }
  // Corpus size, hoisted OUT of the pragma block below. It was already computed
  // there — but only when the repo happened to contain `@duplicate-justification`
  // pragmas, and only to decide a candidate-pool cap, so the number that says
  // whether the score means anything was conditional on an unrelated feature.
  // Best-effort: a failure here degrades the report to `unknown`, never aborts
  // it, and never silently becomes 0 (which reads as an empty snapshot).
  let symbolCount = null;
  try {
    symbolCount = await countSymbolsForSnapshot({ repoId: repo.id, refreshId: snap.refreshId });
  } catch (err) {
    process.stderr.write(`arch:drift: symbol count failed (report will say unknown): ${err.message}\n`);
  }
  // Read the DSN back through the same resolver the pool used, so the report
  // names the store the query actually went to rather than a re-derivation.
  const store = getActiveStoreDescriptor();

  const threshold = symbolIndexConfig.driftThreshold;
  // Deliberately stricter than the old `Number(x) || 0` (round-1 H8):
  // drift.score is a genuine JS number here (traced end-to-end through the
  // drift_score RPC's jsonb_build_object serialization and pg's JSONB
  // auto-parse, round-2 H3 rebuttal) — a non-finite value is a real
  // data-integrity anomaly worth surfacing as UNKNOWN, never silently
  // coerced to 0 (which reads as GREEN). `status = classify(...)` is
  // computed as a plain value, never an early `return` — this line sits
  // inside main() itself, and an early return here would skip the
  // markdown render + stdout emission entirely (round-3 H1's real bug).
  const status = Number.isFinite(drift.score) ? classify(drift.score, threshold) : DRIFT_STATUS.UNKNOWN;

  // Surface the top duplicate clusters for the issue body. Best-effort —
  // if the RPC fails (e.g. older Supabase without the migration applied),
  // render still proceeds with empty clusters.
  let rawClusters = [];
  try {
    rawClusters = await getTopDuplicateClusters({
      repoId: repo.id, refreshId: snap.refreshId, limit: 20,
    });
  } catch (err) {
    process.stderr.write(`arch:drift: top_duplicate_clusters failed (continuing without): ${err.message}\n`);
  }

  // Adapt to the shape renderDriftIssue expects: {label, similarity,
  // members:[{symbolName, filePath, purposeSummary}]}. similarity is 1.0
  // because these are EXACT signature_hash matches.
  const clusters = rawClusters.map(c => ({
    label: `${c.symbolNames.join(' / ')} (${c.kind})`,
    similarity: 1.0,
    firstSeen: null,
    members: c.filePaths.map((fp, i) => ({
      symbolName: c.symbolNames[Math.min(i, c.symbolNames.length - 1)],
      filePath: fp,
      purposeSummary: c.examplePurpose,
    })),
  }));

  const stalePragmas = findStalePragmas(process.cwd());

  // Report-time reconciliation of ambiguous/unresolved @duplicate-
  // justification pragmas (round-2 M1) — the WRITE path (refresh.mjs) is
  // the safety-critical one (an ambiguous/unresolved pragma is simply not
  // excluded, never mis-attached), this is advisory surfacing so an author
  // gets feedback. Best-effort — a query failure degrades to skipping this
  // section, never blocks the report.
  let excludedNote = '';
  let ambiguousUnresolvedSection = '';
  const excludedCount = Number(drift.duplication_excluded_count) || 0;
  if (excludedCount > 0) {
    excludedNote = `\n_Excludes ${excludedCount} \`@duplicate-justification\`-marked declaration(s) this refresh._\n`;
  }
  try {
    const repoPragmas = findRepoPragmas(process.cwd());
    if (repoPragmas.length > 0) {
      // listSymbolsForSnapshot already returns camelCase (definitionId,
      // filePath, startLine, symbolName, kind) — round-3 M1 fix: an
      // earlier draft read snake_case here, so every candidate silently
      // had undefined fields and this whole reconciliation was a no-op.
      // `totalCount` is the corpus size hoisted above — ONE count query per run,
      // and the same number the report prints, so the two can never disagree.
      // A null (the count query failed) is fail-CLOSED here: `null > CAP` is
      // false, which would run reconciliation over a possibly-truncated pool and
      // emit exactly the false "unresolved pragma" warnings the cap exists to
      // prevent, so an unknown total skips reconciliation rather than guessing.
      const totalCount = symbolCount;
      const symbols = await listSymbolsForSnapshot({ repoId: repo.id, refreshId: snap.refreshId, limit: PRAGMA_CANDIDATE_POOL_CAP });
      const capped = isPragmaPoolCapped(totalCount);
      if (capped) {
        process.stderr.write(`arch:drift: showing ${PRAGMA_CANDIDATE_POOL_CAP} of ${totalCount ?? 'an unknown number of'} symbols in this cluster analysis (capped)\n`);
      }
      // Gemini final-gate finding (round 1): this candidate pool feeds
      // pragma reconciliation below, NOT the rendered drift score/cluster
      // body — a cap here risks false "unresolved pragma" warnings for
      // symbols outside the capped pool, so skip the reconciliation
      // entirely rather than report a misleading partial result.
      if (capped) {
        ambiguousUnresolvedSection = `\n## Unresolved suppression pragmas — skipped (LOW — capped snapshot)\n\n` +
          (totalCount === null
            ? `This snapshot's symbol count could not be read, so reconciliation could not establish that the ${PRAGMA_CANDIDATE_POOL_CAP}-row candidate pool is complete; it was skipped rather than risk false "unresolved" warnings for symbols outside the pool.\n`
            : `This snapshot has ${totalCount} symbols, over the ${PRAGMA_CANDIDATE_POOL_CAP}-row candidate-pool cap; pragma reconciliation was skipped rather than risk false "unresolved" warnings for symbols outside the capped pool.\n`);
      } else {
        const candidates = symbols.map((s) => ({
          filePath: s.filePath, symbolName: s.symbolName, kind: s.kind,
          startLine: s.startLine, definitionId: s.definitionId,
        }));
        const { ambiguous, unresolved } = resolvePragmasToDefinitions(repoPragmas, candidates);
        if (ambiguous.length > 0 || unresolved.length > 0) {
          const rows = [
            ...ambiguous.map((a) => `| \`${a.pragmaFile}:${a.pragmaLine}\` | ambiguous — declaration already claimed by another pragma |`),
            ...unresolved.map((u) => `| \`${u.pragmaFile}:${u.pragmaLine}\` | unresolved — no declaration found within the resolution window |`),
          ].join('\n');
          ambiguousUnresolvedSection = `\n## Unresolved suppression pragmas (LOW — not excluded, not a safety gap)\n\n` +
            `| Pragma location | Issue |\n|---|---|\n${rows}\n\n` +
            `These \`// @duplicate-justification\` pragmas could not be resolved to a single declaration this refresh — they do NOT exclude anything from the drift score. Check placement (the pragma must sit immediately above the declaration it justifies) and that at most one pragma targets each declaration.\n`;
        }
      }
    }
  } catch (err) {
    process.stderr.write(`arch:drift: pragma reconciliation skipped: ${err.message}\n`);
  }

  const md = renderMarkdownViaShared(drift, threshold, status, identity, clusters, snap.commitSha ?? null, symbolCount, store) + excludedNote + renderStalePragmaSection(stalePragmas) + ambiguousUnresolvedSection;

  // `symbolCount`/`store` ride in the JSON envelope for the same reason they
  // ride in the markdown: a policy gate reading this cannot otherwise tell a
  // clean repo from a near-empty snapshot in the wrong database. `store` is the
  // publishable descriptor (fingerprint + db name), never a hostname.
  if (args.json) process.stdout.write(JSON.stringify({ drift, threshold, status, stalePragmas, symbolCount, store }, null, 2) + '\n');
  else process.stdout.write(md);

  // round-1 M1: an unwritable --out path (bad dir, full disk, permissions)
  // must not read the same as an ordinary RED/AMBER/GREEN result — the
  // report was already generated correctly (stdout above already has it);
  // only its on-disk persistence failed. Caught here (not left to the
  // top-level main().catch) so that distinction is visible in the message,
  // not collapsed into a generic fatal.
  let outWriteFailed = false;
  if (args.out) {
    try {
      atomicWrite(args.out, md);
    } catch (err) {
      outWriteFailed = true;
      process.stderr.write(`arch:drift: report generated but writing --out file ${args.out} failed: ${err.message}\n`);
    }
  }

  process.stderr.write(`arch:drift: status=${status} score=${drift.score}/${threshold}\n`);
  // `process.exitCode` (not `process.exit()`) — avoids truncating the
  // stdout write above before the event loop flushes it on a piped stdout
  // (D3). Exit-code contract: UNKNOWN behaves exactly like GREEN/AMBER (0)
  // — it is reported, never gating; only RED is non-zero. A failed --out
  // write is an infra-level failure (mirrors the RPC-failure exit(2)
  // convention above) and takes precedence over the status-driven code.
  process.exitCode = outWriteFailed ? 2 : (status === DRIFT_STATUS.RED ? 1 : 0);
}

export const _internals = { atomicWrite, parseArgs, PRAGMA_CANDIDATE_POOL_CAP, isPragmaPoolCapped, resolveStoreGateExit };

const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
  } catch { return false; }
})();

if (isMain) {
  main().catch(err => {
    process.stderr.write(`arch:drift: fatal: ${err.stack || err.message}\n`);
    process.exit(2);
  });
}
