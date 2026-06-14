/**
 * @fileoverview Shared learning-stats accessor. The aggregation logic that
 * `cross-skill.mjs cmdLearningStats` (the `learning-stats` CLI subcommand)
 * wraps — extracted so non-CLI callers (the dashboard telemetry collector)
 * can reuse it in-process instead of spawning the CLI and parsing stdout
 * (docs/plans/local-dashboard.md M2 / Gemini).
 *
 * @module scripts/lib/learning/stats
 */
import {
  initLearningStore,
  isCloudEnabled,
  getRepoIdByName,
  readPendingTriageFindings,
  readNoBrainerRecommendations,
  readStaleClusters,
} from '../../learning-store.mjs';

/**
 * Fetch aggregated learning-decision counts for a repo.
 *
 * A pure accessor — identity comes ONLY from explicit `opts`, never from
 * ambient `process.env` (callers that want the `LEARNING_REPO_NAME`
 * fallback must read it and pass it in). Returns a structured object —
 * never throws for the expected "cloud off" / "unknown repo" cases (they
 * come back as a `missing-optional` status). Genuine query faults propagate.
 *
 * @param {{repoId?: string|null, repoName?: string|null}} [opts]
 * @returns {Promise<{cloud: boolean, repoId: string|null, repoName: string|null,
 *   stats: {pendingTriageCount: number, noBrainerCount: number, staleClusterCount: number}|null,
 *   status: {status: string, detail: string}}>}
 */
export async function getLearningStats(opts = {}) {
  const repoName = opts.repoName || null;
  await initLearningStore();

  if (!await isCloudEnabled()) {
    return {
      cloud: false, repoId: null, repoName, stats: null,
      status: { status: 'missing-optional', detail: 'learning cloud store not configured' },
    };
  }

  let repoId = opts.repoId || null;
  if (!repoId && repoName) repoId = await getRepoIdByName(repoName);
  if (!repoId) {
    return {
      cloud: true, repoId: null, repoName, stats: null,
      status: { status: 'missing-optional', detail: 'repo not found in learning store' },
    };
  }

  const [triage, noBrainer, stale] = await Promise.all([
    readPendingTriageFindings({ repoId, limit: 1000 }),
    readNoBrainerRecommendations({ repoId, limit: 1000 }),
    readStaleClusters({ repoId, limit: 1000 }),
  ]);

  return {
    cloud: true, repoId, repoName,
    stats: {
      pendingTriageCount: triage.length,
      noBrainerCount: noBrainer.length,
      staleClusterCount: stale.length,
    },
    status: { status: 'ok', detail: '' },
  };
}
