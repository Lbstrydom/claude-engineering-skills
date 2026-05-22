/**
 * @fileoverview Per-domain Haiku cache (domain_summaries table).
 *
 * Owns 2 exports: upsertDomainSummary, getDomainSummaries.
 *
 * Plan: docs/plans/sustainability-cleanup-batch.md (WS1).
 *
 * @module scripts/lib/store/arch/domain-summaries
 */

import { many, upsert } from '../../db/query.mjs';
import { isCloudEnabled } from '../repo.mjs';

export async function upsertDomainSummary({ repoId, domainTag, summary, compositionHash, symbolCount, promptTemplateVersion, generatedModel }) {
  if (!await isCloudEnabled()) return;
  try {
    await upsert('domain_summaries', [{
      repo_id: repoId,
      domain_tag: domainTag,
      summary,
      composition_hash: compositionHash,
      symbol_count: symbolCount,
      prompt_template_version: promptTemplateVersion,
      generated_model: generatedModel,
      generated_at: new Date().toISOString(),
    }], { onConflict: ['repo_id', 'domain_tag'], update: 'all' });
  } catch (err) {
    throw new Error(`upsertDomainSummary failed: ${err.message}`);
  }
}

export async function getDomainSummaries(repoId) {
  const out = new Map();
  if (!repoId || !await isCloudEnabled()) return out;
  try {
    const rows = await many(
      `SELECT domain_tag, summary, composition_hash, symbol_count,
              prompt_template_version, generated_model
         FROM domain_summaries WHERE repo_id = $1`,
      [repoId]
    );
    for (const r of rows) {
      out.set(r.domain_tag, {
        summary: r.summary,
        compositionHash: r.composition_hash,
        symbolCount: r.symbol_count,
        promptTemplateVersion: r.prompt_template_version,
        generatedModel: r.generated_model,
      });
    }
  } catch (err) {
    throw new Error(`getDomainSummaries failed: ${err.message}`);
  }
  return out;
}
