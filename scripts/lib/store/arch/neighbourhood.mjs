/**
 * @fileoverview Neighbourhood / drift / duplicate-cluster RPC adapters.
 *
 * Owns 3 exports: callNeighbourhoodRpc, computeDriftScore, getTopDuplicateClusters.
 *
 * These are thin wrappers over server-side RPCs in scripts/lib/db/rpc.mjs.
 * Kept here (rather than in db/rpc.mjs) because they apply audit-loop
 * specific shape transformations + error-tagging (`code: 'RPC_ERROR'`)
 * that the generic RPC layer shouldn't know about.
 *
 * Plan: docs/plans/sustainability-cleanup-batch.md (WS1).
 *
 * @module scripts/lib/store/arch/neighbourhood
 */

import {
  driftScore as rpcDriftScore,
  topDuplicateClusters as rpcTopDuplicateClusters,
  symbolNeighbourhood as rpcSymbolNeighbourhood,
} from '../../db/rpc.mjs';
import { isCloudEnabled } from '../repo.mjs';

export async function callNeighbourhoodRpc({ repoId, refreshId, targetPaths, intentEmbedding, kindFilter, k }) {
  if (!await isCloudEnabled()) return [];
  try {
    const rows = await rpcSymbolNeighbourhood({
      repoId, refreshId, targetPaths, intentEmbedding, kindFilter, k,
    });
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    const e = new Error(`symbol_neighbourhood RPC failed: ${err.message}`);
    e.code = 'RPC_ERROR';
    throw e;
  }
}

export async function computeDriftScore({ repoId, refreshId, simDup, simName }) {
  if (!await isCloudEnabled()) return null;
  try {
    return await rpcDriftScore({ repoId, refreshId, simDup, simName });
  } catch (err) {
    const e = new Error(`drift_score RPC failed: ${err.message}`);
    e.code = 'RPC_ERROR';
    throw e;
  }
}

export async function getTopDuplicateClusters({ repoId, refreshId, limit = 20 }) {
  if (!await isCloudEnabled()) return [];
  try {
    const rows = await rpcTopDuplicateClusters({ repoId, refreshId, limit });
    return rows.map((r) => ({
      signatureHash: r.signature_hash,
      kind: r.kind,
      fileCount: r.file_count,
      symbolNames: r.symbol_names,
      filePaths: r.file_paths,
      examplePurpose: r.example_purpose,
    }));
  } catch (err) {
    const e = new Error(`top_duplicate_clusters RPC failed: ${err.message}`);
    e.code = 'RPC_ERROR';
    throw e;
  }
}
