#!/usr/bin/env node
/**
 * @fileoverview arch:summarise-domains — generate (or reuse cached) Haiku
 * one-line domain summaries for the active snapshot. Used by render-mermaid
 * to embed below each domain heading in docs/architecture-map.md.
 *
 * Cache invariants (any one mismatch → regenerate, plan §2.5):
 *   - composition_hash:        sha256(sorted "<def_id>|<sig_hash>" rows in domain) (Gemini-R2-G2)
 *   - symbol_count:            ±20% delta tolerated
 *   - prompt_template_version: bump on any prompt change
 *   - generated_model:         concrete resolved model ID
 *
 * Library API: `summariseDomains({repoId, refreshId, model})` returns
 * {summaries, errors, stats}. CLI is a thin wrapper.
 *
 * @module scripts/symbol-index/summarise-domains
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import {
  initLearningStore,
  isCloudEnabled,
  getRepoIdByUuid,
  getActiveSnapshot,
  getDomainSummaries,
  upsertDomainSummary,
  listSymbolsForSnapshot,
} from '../learning-store.mjs';
import { resolveRepoIdentity } from '../lib/repo-identity.mjs';
import { resolveModel } from '../lib/model-resolver.mjs';
import { redactSecrets } from '../lib/secret-patterns.mjs';
import { azureConfig } from '../lib/config.mjs';
import { createAnthropicClient } from '../lib/anthropic-client.mjs';
import { azureThrottle } from '../lib/azure-throttle.mjs';

// Bump on ANY prompt change. Forces cache invalidation across all repos.
export const PROMPT_TEMPLATE_VERSION = 1;

const PROMPT_TEMPLATE = (domain, symbols) =>
  `Write a one-or-two-sentence description of what the \`${domain}\` domain in this repo handles. Be concrete; avoid vacuous phrasing like "manages various concerns". Keep under 400 characters.\n\n` +
  `Domain has ${symbols.length} symbols across ${new Set(symbols.map(s => s.filePath)).size} files. Sample symbols:\n` +
  symbols.slice(0, 10).map(s => `- ${s.symbolName}: ${s.purposeSummary || '(no purpose summary)'} (${s.filePath})`).join('\n') +
  `\n\nDescription:`;

// Exported for direct unit testing — tests/domain-summaries.test.mjs.
export function computeCompositionHash(symbols) {
  const rows = symbols
    .map(s => `${s.definitionId || s.id || ''}|${s.signatureHash || ''}`)
    .sort();
  return crypto.createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16);
}

export function symbolCountDeltaOk(prior, current) {
  if (prior <= 0) return false;
  const pct = Math.abs(current - prior) / prior;
  return pct <= 0.20;
}

export function cacheHit(prior, { compositionHash, symbolCount, promptTemplateVersion, generatedModel }) {
  if (!prior) return false;
  if (prior.compositionHash !== compositionHash) return false;
  if (prior.promptTemplateVersion !== promptTemplateVersion) return false;
  if (prior.generatedModel !== generatedModel) return false;
  if (!symbolCountDeltaOk(prior.symbolCount, symbolCount)) return false;
  return true;
}

async function callHaiku(prompt, modelId, timeoutMs = 60000) {
  // Under the Azure work profile, domain summaries run on Sonnet via Foundry
  // (native Anthropic, Bearer); otherwise the public Anthropic API.
  if (!azureConfig.active && !process.env.ANTHROPIC_API_KEY) {
    const e = new Error('No Claude provider (set ANTHROPIC_API_KEY or the Azure work profile)');
    e.code = 'MISSING_KEY';
    throw e;
  }
  const client = azureConfig.active
    ? await createAnthropicClient({ baseURL: azureConfig.claudeBaseUrl })
    : await createAnthropicClient();
  const model = azureConfig.active ? azureConfig.summaryDeployment : modelId;
  const startMs = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await azureThrottle(() => client.messages.create({
      model,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    }, { signal: ctrl.signal }));
    clearTimeout(timer);
    const text = resp?.content?.[0]?.text?.trim() || '';
    return {
      result: { summary: text },
      usage: { inputTokens: resp.usage?.input_tokens ?? 0, outputTokens: resp.usage?.output_tokens ?? 0 },
      latencyMs: Date.now() - startMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

function validateSummary(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'non-string' };
  const trimmed = text.trim();
  if (trimmed.length < 20) return { ok: false, reason: `too-short (${trimmed.length} chars)` };
  if (trimmed.length > 400) return { ok: false, reason: `too-long (${trimmed.length} chars)` };
  return { ok: true, value: trimmed };
}

/**
 * Library API — invoked from render-mermaid.mjs in-process.
 * @returns {Promise<{summaries: Map<string,{summary:string,source:'cache'|'fresh'}>, errors: Array<{domain:string,code:string,message:string}>, stats: {total:number,cacheHits:number,fresh:number,failed:number}}>}
 */
export async function summariseDomains({ repoId, refreshId, model }) {
  const summaries = new Map();
  const errors = [];
  const stats = { total: 0, cacheHits: 0, fresh: 0, failed: 0 };
  const concreteModel = resolveModel(model || 'latest-haiku');
  const cache = await getDomainSummaries(repoId);

  // Page through all symbols in the snapshot grouped by domain
  const allSymbols = [];
  let offset = 0;
  while (true) {
    const page = await listSymbolsForSnapshot({ refreshId, limit: 500, offset });
    if (!page || page.length === 0) break;
    allSymbols.push(...page);
    if (page.length < 500) break;
    offset += 500;
  }
  const grouped = new Map();
  for (const s of allSymbols) {
    const d = s.domainTag || '_other';
    if (!grouped.has(d)) grouped.set(d, []);
    grouped.get(d).push(s);
  }
  stats.total = grouped.size;

  for (const [domain, symbols] of grouped) {
    const compositionHash = computeCompositionHash(symbols);
    const symbolCount = symbols.length;
    const prior = cache.get(domain);
    if (cacheHit(prior, { compositionHash, symbolCount, promptTemplateVersion: PROMPT_TEMPLATE_VERSION, generatedModel: concreteModel })) {
      summaries.set(domain, { summary: prior.summary, source: 'cache' });
      stats.cacheHits++;
      continue;
    }
    // Fresh call — best-effort; per-domain failures don't block others.
    // Audit-code R1-H5: scrub the assembled prompt through redactSecrets
    // before egress. Symbol metadata (name + purpose + path) is normally
    // safe but redaction is defense-in-depth — same gate the brainstorm
    // helper applies before any external API call.
    try {
      const rawPrompt = PROMPT_TEMPLATE(domain, symbols);
      const redaction = redactSecrets(rawPrompt);
      if (redaction.redacted.length > 0) {
        process.stderr.write(`  [summarise-domains] ⚠ Redacted ${redaction.redacted.length} secret pattern(s) from ${domain} prompt before sending: ${redaction.redacted.join(', ')}\n`);
      }
      const { result } = await callHaiku(redaction.text, concreteModel);
      const v = validateSummary(result.summary);
      if (!v.ok) {
        errors.push({ domain, code: 'malformed', message: v.reason });
        stats.failed++;
        continue;
      }
      await upsertDomainSummary({
        repoId, domainTag: domain,
        summary: v.value,
        compositionHash, symbolCount,
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
        generatedModel: concreteModel,
      });
      summaries.set(domain, { summary: v.value, source: 'fresh' });
      stats.fresh++;
    } catch (err) {
      errors.push({ domain, code: err.code || 'EXCEPTION', message: err.message });
      stats.failed++;
    }
  }
  return { summaries, errors, stats };
}

// CLI thin wrapper
async function main() {
  await initLearningStore();
  if (!await isCloudEnabled()) {
    process.stderr.write('arch:summarise-domains: cloud disabled — skipping\n');
    process.exit(0);
  }
  const identity = resolveRepoIdentity(process.cwd());
  const repo = await getRepoIdByUuid(identity.repoUuid);
  if (!repo) {
    process.stderr.write(`arch:summarise-domains: repo not found in store — run \`npm run arch:refresh\` first\n`);
    process.exit(2);
  }
  const snap = await getActiveSnapshot(repo.id);
  if (!snap?.refreshId) {
    process.stderr.write('arch:summarise-domains: no active snapshot for repo\n');
    process.exit(2);
  }
  const { summaries, errors, stats } = await summariseDomains({
    repoId: repo.id, refreshId: snap.refreshId,
  });
  process.stderr.write(`arch:summarise-domains: total=${stats.total} cached=${stats.cacheHits} fresh=${stats.fresh} failed=${stats.failed}\n`);
  for (const e of errors) {
    process.stderr.write(`  [error] ${e.domain}: ${e.code} ${e.message}\n`);
  }
  // Total-output contract: emit summaries to stdout as JSON
  process.stdout.write(JSON.stringify({
    ok: stats.fresh + stats.cacheHits > 0,
    stats,
    summaries: Object.fromEntries(Array.from(summaries.entries()).map(([d, v]) => [d, v.summary])),
    errors,
  }, null, 2) + '\n');
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  main().catch(err => {
    process.stderr.write(`arch:summarise-domains: fatal: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}
