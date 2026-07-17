/**
 * @fileoverview Gate-1 availability screen for the DISCOVERY-generator role —
 * the instrument `docs/research/experiment-4-discovery-model-glm-disqualification.md`
 * specifies (and the missing per-generator-latency telemetry it names).
 *
 * The existing model-swap-eval-harness (`model-eval-auditor.mjs` /
 * `model-eval-adjudicator.mjs`) grades QUALITY for the auditor/adjudicator
 * roles. This CLI answers the question that must come FIRST for the
 * discovery role: **can the candidate reliably answer at all**, measured
 * through the REAL production seam (`ossStructuredCall`: same egress gate,
 * same fence-tolerant parsing, same Zod conformance, same production-parity
 * anchor normalization) against a REAL discovery payload (a real commit's
 * files + a real redacted plan, assembled exactly like
 * `tiered-pipeline.mjs` does).
 *
 * Motivation, measured: GLM-5.2 via unpinned OpenRouter succeeded 14/39
 * shadow runs (36%) — but every measurement was confounded by OpenRouter's
 * ~26-host fleet (fp8/fp4/undisclosed quantization; our call sends no
 * `provider` preferences). The pinned arm here is the control that finally
 * separates model-vs-router.
 *
 * Default arms:
 *   glm-unpinned        production reproduction (expect the known failure rate)
 *   glm-pinned-zai-fp8  the decisive control: first-party fp8 route, hard-pinned
 *   deepseek-v3.2       replacement front-runner (multi-provider failover)
 *   qwen3.6-flash       replacement candidate
 *
 * Custom arms (`--arms <file.json>`): an array of
 *   `{ label, model | modelPattern, providerPreferences?, baseUrl?, apiKeyEnv? }`
 * — `baseUrl`/`apiKeyEnv` make an arm ANY OpenAI-compatible endpoint, e.g.
 *   z.ai direct (`https://api.z.ai/api/paas/v4`, `ZAI_API_KEY`) or, when the
 *   corporate profile gains eligible models, Azure OpenAI's unified v1
 *   endpoint (`https://<resource>.openai.azure.com/openai/v1`,
 *   `AZURE_OPENAI_API_KEY`, model = the deployment name). That keeps this
 *   instrument reusable in restricted environments — the Azure-testability
 *   requirement recorded in experiment-4.
 *
 * Usage:
 *   node scripts/model-eval-discovery.mjs --dry-run          # resolve slugs + cost estimate, no spend
 *   node scripts/model-eval-discovery.mjs [--n 30] [--concurrency 3] [--arms file.json] [--out path.json]
 *
 * Measurement policy: maxRetries=0 (per-ATTEMPT stats; production's 1-retry
 * availability is derived as 1-(1-p)^2 for the retryable classes), timeout
 * 120s (production parity with oss-call-policy.json discovery_generation).
 * Exit 0 on completion (a measurement, not a gate); exit 1 on misconfiguration.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';

import { ossStructuredCall } from './lib/oss-structured-output.mjs';
import { createOpenAIClient } from './lib/openai-client.mjs';
import { auditShadowConfig } from './lib/config.mjs';
import { ProducerFindingV2Schema, clampToJsonSchemaLimits } from './lib/schemas.mjs';
import { normalizeModifiedAnchorPaths } from './lib/audit/tiered-pipeline.mjs';
import { readFilesAsContext } from './lib/file-io.mjs';
import { redactSecrets } from './lib/sensitive-egress-gate.mjs';

if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const N = Number.parseInt(flag('--n', '30'), 10);
const CONCURRENCY = Number.parseInt(flag('--concurrency', '3'), 10);
const DRY_RUN = argv.includes('--dry-run');
const ARMS_FILE = flag('--arms');
const OUT = flag('--out', path.join('.audit', `discovery-screen-${Date.now()}.json`));
const TIMEOUT_MS = 120000; // production parity: oss-call-policy.json discovery_generation

// July-2026 $/1M (in, out) for the ESTIMATE only — measured provider_cost_usd
// is what gets reported when the router returns it.
const PRICE_ESTIMATE = {
  'glm-unpinned': [0.45, 3.31], 'glm-pinned-zai-fp8': [1.40, 4.40],
  'deepseek-v3.2': [0.14, 0.28], 'qwen3.6-flash': [0.19, 1.13],
};

const DEFAULT_ARMS = [
  { label: 'glm-unpinned', modelPattern: /^z-ai\/glm-5\.2$/ },
  {
    label: 'glm-pinned-zai-fp8', modelPattern: /^z-ai\/glm-5\.2$/,
    // The decisive control (experiment-4 amendment): first-party route, fp8
    // only, hard-pinned (no fallback to the quantized fleet), and the
    // provider MUST support our response_format rather than ignore it.
    providerPreferences: { order: ['z-ai'], quantizations: ['fp8'], require_parameters: true, allow_fallbacks: false },
  },
  { label: 'deepseek-v3.2', modelPattern: /^deepseek\/deepseek-(chat-)?v3\.2(-[a-z]+)?$/ },
  { label: 'qwen3.6-flash', modelPattern: /^qwen\/qwen-?3\.6-flash$/ },
];

// ── helpers ─────────────────────────────────────────────────────────────────
const pct = (n, d) => (d > 0 ? `${Math.round((100 * n) / d)}%` : '—');
const quantile = (sorted, q) => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);

async function resolveArmModels(arms, baseUrl, apiKey) {
  const needsResolution = arms.some((a) => !a.model && a.modelPattern);
  if (!needsResolution) return arms;
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`GET /models failed: HTTP ${res.status}`);
  const ids = (await res.json()).data.map((m) => m.id);
  return arms.map((a) => {
    if (a.model || !a.modelPattern) return a;
    const pattern = a.modelPattern instanceof RegExp ? a.modelPattern : new RegExp(a.modelPattern);
    const hit = ids.find((id) => pattern.test(id));
    if (!hit) {
      const near = ids.filter((id) => id.includes(a.label.split('-')[0])).slice(0, 5);
      throw new Error(`arm '${a.label}': no model matches ${pattern} on ${baseUrl}. Near misses: ${near.join(', ') || '(none)'}`);
    }
    return { ...a, model: hit };
  });
}

/** The exact discovery payload production assembles (tiered-pipeline.mjs), against a real recent commit. */
function buildPayload() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const files = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'a183c3f'], { encoding: 'utf8' })
    .trim().split('\n').filter((f) => f && fs.existsSync(f));
  const discoveryCode = readFilesAsContext(files, { maxPerFile: 8000, maxTotal: 100000 });
  const discoveryPlan = redactSecrets(fs.readFileSync('docs/plans/shadow-no-legacy-fallback.md', 'utf8'));
  // System prompt: verbatim from tiered-pipeline.mjs's GLM generator (the
  // anchor contract) — a research copy; production's stays authoritative.
  const system = [
    'You are a code-audit finding generator. Produce candidate findings, each with a content-verifiable evidence anchor.',
    '',
    'ANCHOR CONTRACT — a finding is discarded outright if its anchor breaks these:',
    '- `quote` MUST be text copied VERBATIM from the code you were given. Never paraphrase, reformat, or reconstruct it — it is verified by exact content match against the real file/diff.',
    '- `fileStatus: "modified"` (the common case) REQUIRES BOTH `oldFile` AND `newFile`, set to the SAME path — a modified file keeps its path on both sides of the diff.',
    '- `fileStatus: "added"` requires `newFile` (no base-side content exists, so `side` must be "head").',
    '- `fileStatus: "deleted"` requires `oldFile` (`side` must be "base").',
    '- `fileStatus: "renamed"`/`"copied"` require BOTH paths, and they differ.',
    '- `startLine`/`endLine` are 1-indexed and must bracket the quote (`startLine <= endLine`).',
    '- commission findings need `anchor`; omission findings need `triggerAnchor` AND `causalChain`.',
  ].join('\n');
  const userPrompt = `## Plan\n${discoveryPlan}\n\n## Changed Files (code)\n${discoveryCode}`;
  // Production-parity lenient ingestion: clamp + anchor-path normalization
  // before the strict schema — omitting these would re-penalize exactly the
  // quirks production already absorbs.
  const strict = z.object({ findings: z.array(ProducerFindingV2Schema).max(15) });
  const jsonSchema = z.toJSONSchema(strict);
  const schema = z.preprocess((v) => normalizeModifiedAnchorPaths(clampToJsonSchemaLimits(v, jsonSchema)), strict);
  return { system, userPrompt, schema, files, commit, payloadChars: system.length + userPrompt.length };
}

function classifyOutcome(r) {
  if (!r.failed && r.conformant) return 'ok';
  const e = String(r.error || '');
  if (r.category === 'timeout' || /\[timeout\]|aborted|timed out/i.test(e)) return 'stall';
  if (/not valid JSON|schema validation failed|Truncated/i.test(e)) return 'nonconformant';
  if (/HTTP (429|5\d\d)|overloaded/i.test(e)) return 'provider_error';
  return 'other_error';
}

function summarizeArm(label, records) {
  const outcomes = records.reduce((a, r) => { a[r.outcome] = (a[r.outcome] || 0) + 1; return a; }, {});
  const okLat = records.filter((r) => r.outcome === 'ok').map((r) => r.latencyMs).sort((a, b) => a - b);
  const ok = outcomes.ok || 0;
  const p = ok / records.length;
  const measuredCost = records.reduce((s, r) => s + (r.providerCostUsd ?? 0), 0);
  return {
    label, model: records[0]?.model ?? null, attempts: records.length,
    availability: p,
    availabilityWith1Retry: 1 - (1 - p) ** 2, // production runs maxRetries=1
    outcomes,
    latencyMsP50: quantile(okLat, 0.5), latencyMsP95: quantile(okLat, 0.95),
    measuredCostUsd: Number(measuredCost.toFixed(4)),
    errors: [...new Set(records.filter((r) => r.outcome !== 'ok').map((r) => String(r.error || '').slice(0, 140)))].slice(0, 6),
  };
}

// ── main ────────────────────────────────────────────────────────────────────
const baseUrl = auditShadowConfig.openrouterBaseUrl;
const apiKey = auditShadowConfig.openrouterApiKey;
if (!apiKey) { console.error('OPENROUTER_API_KEY is not set'); process.exit(1); }

let arms = ARMS_FILE ? JSON.parse(fs.readFileSync(ARMS_FILE, 'utf8')) : DEFAULT_ARMS;
arms = await resolveArmModels(arms, baseUrl, apiKey);

const payload = buildPayload();
const estTokensIn = Math.round(payload.payloadChars / 4);
console.error(`payload: ${payload.files.length} files from a183c3f + redacted plan = ${payload.payloadChars} chars (~${estTokensIn} tok in/call)`);
let estTotal = 0;
for (const a of arms) {
  const [pi, po] = PRICE_ESTIMATE[a.label] ?? [0.5, 2];
  const est = N * ((estTokensIn * pi) / 1e6 + (3000 * po) / 1e6);
  estTotal += est;
  console.error(`  arm ${a.label.padEnd(20)} model=${a.model}  ~$${est.toFixed(2)} for n=${N}${a.providerPreferences ? '  [pinned]' : ''}`);
}
console.error(`  estimated total: ~$${estTotal.toFixed(2)} (excl. provider-side variation)`);
if (DRY_RUN) { console.error('dry-run: no calls made.'); process.exit(0); }

const perArmRecords = new Map(arms.map((a) => [a.label, []]));
async function runArm(arm) {
  const client = await createOpenAIClient({
    oss: {
      baseURL: arm.baseUrl || baseUrl,
      apiKey: arm.apiKeyEnv ? (process.env[arm.apiKeyEnv] || '').trim() : apiKey,
    },
  });
  const records = perArmRecords.get(arm.label);
  let next = 0;
  const worker = async () => {
    while (next < N) {
      const i = next++;
      const r = await ossStructuredCall(client, {
        model: arm.model,
        system: payload.system, userPrompt: payload.userPrompt,
        schema: payload.schema, schemaName: 'discovery_screen',
        passName: `screen-${arm.label}`, timeoutMs: TIMEOUT_MS, maxRetries: 0,
        providerPreferences: arm.providerPreferences ?? null,
      });
      const rec = {
        arm: arm.label, model: arm.model, i,
        outcome: null, latencyMs: r.latencyMs, conformant: r.conformant,
        error: r.error, category: r.category ?? null,
        providerCostUsd: r.usage?.provider_cost_usd ?? null,
        findings: r.result?.findings?.length ?? null,
      };
      rec.outcome = classifyOutcome(r);
      records.push(rec);
      process.stderr.write(`  [${arm.label}] ${i + 1}/${N} ${rec.outcome} (${Math.round(r.latencyMs / 1000)}s)\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, N) }, worker));
}

const started = Date.now();
await Promise.all(arms.map(runArm)); // arms in parallel, bounded per-arm concurrency
const summary = {
  ranAt: new Date().toISOString(), commit: payload.commit, n: N, timeoutMs: TIMEOUT_MS,
  payload: { files: payload.files, chars: payload.payloadChars },
  arms: arms.map((a) => summarizeArm(a.label, perArmRecords.get(a.label))),
  elapsedSec: Math.round((Date.now() - started) / 1000),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ summary, records: [...perArmRecords.values()].flat() }, null, 2));

console.log(JSON.stringify(summary, null, 2));
console.error(`\nraw records → ${OUT}`);
