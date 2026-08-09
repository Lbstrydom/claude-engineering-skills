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
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

import { ossStructuredCall } from './lib/oss-structured-output.mjs';
import { createOpenAIClient } from './lib/openai-client.mjs';
import { auditShadowConfig } from './lib/config.mjs';
import { makeProducerFindingV3Schema, clampToJsonSchemaLimits } from './lib/schemas.mjs';
import { renderDiffPathTable, prepareCandidates } from './lib/audit/diff-path-map.mjs';
import { resolveEligibleDiffPathMap } from './lib/audit/discovery-diff-scope.mjs';
import { readFilesAsContext } from './lib/file-io.mjs';
import { redactSecrets } from './lib/sensitive-egress-gate.mjs';
import { boundMalformedDetails } from './lib/audit/malformed-details.mjs';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';

// Every flag this CLI accepts. `--n`, `--concurrency`, `--arms` and `--out` take
// a value; `--dry-run` and `--selfcheck-relocation` are booleans.
const KNOWN_FLAGS = [
  '--n',
  '--concurrency',
  '--arms',
  '--out',
  '--dry-run',
  '--selfcheck-relocation',
];

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

const FIXTURE_REV = 'a183c3f';

/** The exact discovery payload production assembles (tiered-pipeline.mjs), against a real recent commit. */
function buildPayload() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  // Egress: `readFilesAsContext` (audit-scope.mjs) is the guarantee for the
  // CODE bodies — it skips sensitive paths AND redacts each body by default
  // (`redact = true`), redacting BEFORE truncating so a cut cannot leave an
  // un-matchable secret fragment. This is the same helper the production audit
  // uses, which is what "production parity" means here.
  //
  // The plan below needs its OWN `redactSecrets` precisely because it does not
  // go through that helper — a bare `readFileSync` carries no such guarantee.
  // The asymmetry is deliberate, not an oversight; it read as one to
  // /audit-code (R1-H1, 2026-07-19), so it is pinned by
  // tests/model-eval-discovery-egress.test.mjs rather than left to be
  // re-litigated.
  const discoveryPlan = redactSecrets(fs.readFileSync('docs/plans/shadow-no-legacy-fallback.md', 'utf8'));

  // ONE integration, not two (evidence-anchor-path-contract §7h): this screen
  // routes through the SAME map builder, producer schema, enum, and
  // `prepareCandidates` as the tiered pipeline. There is deliberately no second,
  // non-hydrated path — a research fork of the contract would make this
  // instrument measure a contract production doesn't use.
  const diffText = execFileSync('git', ['show', '--no-color', '--format=', FIXTURE_REV], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // THE documented egress authority, not a second lexical filter (adjudicated
  // finding D5). `diff-path-map.mjs`'s own docblock names
  // `resolveEligibleDiffPathMap` as what runs "before any id can reach a tool
  // schema"; this script was calling `buildDiffPathMap` and then filtering with
  // `shouldSkipForIndexing`, which classifies a path STRING and cannot see a
  // symlink — the INC-001 bypass class, on a path that ships to a third-party
  // provider. The authority applies the lexical check AND, for anything that
  // exists on disk, `resolveAndClassify` against the realpath.
  const { map, skipped } = resolveEligibleDiffPathMap(diffText, { repoRoot: process.cwd() });
  if (map.kind !== 'ready') {
    throw new Error(`diff-path map for ${FIXTURE_REV} is '${map.kind}' (${map.reason}) — the screen cannot build a producer enum without one`);
  }
  if (map.entries.length === 0) throw new Error(`every file in ${FIXTURE_REV} was filtered as sensitive — no id set to cite`);
  if (skipped.length > 0) {
    // COUNT ONLY, never the paths — the repo's skip-logging rule (`formatSkipLog`:
    // sensitive entries aggregate, basenames and full paths are never emitted).
    // Printing what was withheld to prove the filter worked would be the
    // disclosure the filter exists to prevent.
    process.stderr.write(`  [discovery] ${skipped.length} path(s) withheld by the egress gate\n`);
  }

  // D5b — the CONTENT path, derived from the SAME authorised set rather than a
  // second `git diff-tree` plus a second filter. `readFilesAsContext` screens
  // with `isSensitiveFile` (lexical) and `safeReadFile`'s cwd-boundary realpath
  // check, which blocks an OUT-of-repo symlink but not an in-repo one pointing
  // at a lexically-sensitive file. Deriving the list from `map.entries` makes
  // the enum and the bodies provably the same set; the two-filter version could
  // not guarantee that, and fixing only the enum would have been "fixed 1 of 2".
  const files = [...new Set(map.entries.flatMap((e) => [e.newPath, e.oldPath]))]
    .filter((f) => f && fs.existsSync(f));
  const discoveryCode = readFilesAsContext(files, { maxPerFile: 8000, maxTotal: 100000 });

  // System prompt: same shape as tiered-pipeline.mjs's GLM generator (the
  // anchor contract + diff-path table) — a research copy; production's stays
  // authoritative.
  const system = [
    'You are a code-audit finding generator. Produce candidate findings, each with a content-verifiable evidence anchor.',
    '',
    'ANCHOR CONTRACT — a finding is discarded outright if its anchor breaks these:',
    '- `diffPathId` MUST be an `id` copied EXACTLY from the DIFF-PATH TABLE below. It is the ONLY way to name a file. Never write a path there, and never invent an id.',
    '- Do NOT report paths or file status — we derive those from the id ourselves.',
    '- `quote` MUST be text copied VERBATIM from the code you were given. Never paraphrase, reformat, or reconstruct it — it is verified by exact content match against the real file/diff.',
    '- `side` is "head" for current/added code and "base" for removed code. An `added` file has no base side; a `deleted` file has no head side.',
    '- `startLine`/`endLine` are 1-indexed and must bracket the quote (`startLine <= endLine`).',
    '- commission findings need `anchor`; omission findings need `triggerAnchor` AND `causalChain`.',
    '',
    'DIFF-PATH TABLE — the only files you may cite:',
    renderDiffPathTable(map.entries),
  ].join('\n');
  const userPrompt = `## Plan\n${discoveryPlan}\n\n## Changed Files (code)\n${discoveryCode}`;

  // Production-parity lenient ingestion: the clamp absorbs the maxLength/maxItems
  // violations OSS routers don't enforce. The anchor-path normalizer that used to
  // compose here is RETIRED — paths are derived from the map now, so there is
  // nothing left to repair (omitting the clamp would still re-penalize a quirk
  // production absorbs).
  const producerFindingSchema = makeProducerFindingV3Schema(map.entries.map((e) => e.id));
  const strict = z.object({ findings: z.array(producerFindingSchema).max(15) });
  const jsonSchema = z.toJSONSchema(strict);
  const schema = z.preprocess((v) => clampToJsonSchemaLimits(v, jsonSchema), strict);
  return { system, userPrompt, schema, map, producerFindingSchema, files, commit, payloadChars: system.length + userPrompt.length };
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
    // The producer-boundary column (§7h). Distinct from `availability`: an arm
    // can be 100% available and still emit anchors our contract can't hydrate.
    preparedReady: records.reduce((s, r) => s + (r.preparedReady ?? 0), 0),
    preparedMalformed: records.reduce((s, r) => s + (r.preparedMalformed ?? 0), 0),
    preparedMalformedReasons: [...new Set(records.flatMap((r) => r.preparedMalformedReasons ?? []))],
    // The model's own evidence failures (diff-disproved side claims), kept in a
    // separate column from `preparedMalformed` (our contract) — never blended.
    preparedContradicted: records.reduce((s, r) => s + (r.preparedContradicted ?? 0), 0),
    measuredCostUsd: Number(measuredCost.toFixed(4)),
    errors: [...new Set(records.filter((r) => r.outcome !== 'ok').map((r) => String(r.error || '').slice(0, 140)))].slice(0, 6),
  };
}

// ── main ────────────────────────────────────────────────────────────────────

// ── Bounded malformed-anchor diagnostics (WS-E2) ────────────────────────────
//
// Extracted to scripts/lib/audit/malformed-details.mjs so the tiered pipeline
// can produce the SAME breakdown for `_stageBreakdown.discoveryMalformedReasons`
// without importing this CLI. One bounding policy, not two free to drift — the
// field's whole contract is that identical input yields identical records.

async function main() {
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'model-eval-discovery' });
  } catch (err) {
    if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

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
        // §7h: the SAME hydrator production uses. Reported per attempt so the
        // screen measures the real producer boundary, not a research variant —
        // `preparedMalformed > 0` on a conformant response means the id/side
        // contract failed even though the JSON Schema passed, which is precisely
        // the class the enum exists to close.
        const prepared = Array.isArray(r.result?.findings)
          ? prepareCandidates(r.result.findings, payload.map, { producerSchema: payload.producerFindingSchema })
          : [];
        const rec = {
          arm: arm.label, model: arm.model, i,
          outcome: null, latencyMs: r.latencyMs, conformant: r.conformant,
          error: r.error, category: r.category ?? null,
          providerCostUsd: r.usage?.provider_cost_usd ?? null,
          findings: r.result?.findings?.length ?? null,
          preparedReady: prepared.filter((p) => p.kind === 'ready').length,
          preparedMalformed: prepared.filter((p) => p.kind === 'malformed').length,
          preparedMalformedReasons: [...new Set(prepared.filter((p) => p.kind === 'malformed').map((p) => p.reasonCode))],
          // The DISCRIMINATING half. `reasonCode` alone says "malformed"; it
          // cannot say WHICH shape, so the sub-case could never be confirmed
          // from stored data and the tiered-recall blocker stayed a guess.
          // `prepareCandidates` already returns `reasonDetail` and `rawIndex`
          // (the identity tying a malformed result back to its raw finding) —
          // they were simply dropped here. Bounded: model-produced text is
          // untrusted and this is persisted and rendered.
          preparedMalformedDetails: boundMalformedDetails(
            prepared.filter((p) => p.kind === 'malformed'),
            r.result?.findings ?? [],
          ),
          // Distinct from malformed (union-gate finding, 2026-07-17): a
          // `contradicted` candidate is the MODEL's evidence failure (the diff
          // disproved its side claim), NOT our contract failing to parse it.
          // Dropping it from the telemetry blended the two owners — the exact
          // misattribution this plan exists to fix, in the eval column.
          preparedContradicted: prepared.filter((p) => p.kind === 'contradicted').length,
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
}

// Entry-point guard (2026-07-17 incident): this module previously executed its
// whole body at top level — importing it "to check it loads" launched a REAL
// paid multi-arm eval run (killed within seconds; the same import-runs-main
// class as the 2026-07-13 tiered-shadow-report incident, same fix). Same
// pathToFileURL form as tiered-shadow-report.mjs — Windows drive-letter
// robustness. Import-safety is regression-locked by
// tests/model-eval-discovery-import-safety.test.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}


// Exported plainly: a pure, side-effect-free helper with nothing to gate. The
// earlier __testExports wrapper sat directly above an unconditional export of
// the same symbol, so it asserted a restriction it did not impose.
export { boundMalformedDetails };   // re-exported: canonical home is lib/audit/malformed-details.mjs
