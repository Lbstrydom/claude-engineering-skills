#!/usr/bin/env node
/**
 * @fileoverview Grok reasoning-effort pre-flight — proves the `reasoning_effort`
 * dial actually moves output before any campaign manifest is allowed to declare
 * a Grok arm.
 *
 * Plan: docs/plans/final-review-scoped-second-reviewer.md §8 "Grok
 * reasoning-effort pre-flight" + Phase 5. Written because "accepted" is not
 * "effective" — Kimi measured 0 findings at `low` vs 3 at `high` on an
 * identical transcript, and Opus's forced `tool_choice` silently zeroed
 * thinking with no error. A single low/high call pair cannot tell a working
 * dial from ordinary run-to-run variance; this script defines and executes a
 * disposition that can.
 *
 * Two subcommands:
 *   node scripts/grok-effort-preflight.mjs --build-fixture <transcript.json> <plan.md>
 *     Builds the FIXTURE (`.audit/grok-preflight-fixture.json`, Category A —
 *     gitignored, contains real repo content) via the SAME assembly the
 *     campaign uses (buildReviewEnvelope({scope:'thin'})), so the pre-flight
 *     measures the envelope it is attesting, not a synthetic stand-in.
 *
 *   node scripts/grok-effort-preflight.mjs --run
 *     Runs 3 trials at `low` + 3 at `high` against the built fixture, computes
 *     the pass/fail/inconclusive disposition, and writes the COMMITTED
 *     artifact (`docs/research/grok-effort-preflight-2026q3.json`) — a record
 *     of what was measured, referenced by the campaign manifest's `preflight`
 *     block (`{artifact, sha256, model, disposition}`).
 *
 * Cost is bounded BEFORE the first request, not discovered after: the fixture
 * is capped at PREFLIGHT_FIXTURE_MAX_CHARS (tighter than the campaign's own
 * 340,000-char ceiling) and every call sends a fixed `max_tokens`, so the
 * worst-case spend is a closed-form computation checked against SPEND_CAP_USD
 * before any network call.
 *
 * Retirement predicate (stated once, honoured on read): delete this script
 * once a Grok arm has completed one full campaign — its only job is deciding
 * whether that arm may exist at all.
 *
 * Usage:
 *   node scripts/grok-effort-preflight.mjs --build-fixture <transcript> <plan>
 *   node scripts/grok-effort-preflight.mjs --run
 *   node scripts/grok-effort-preflight.mjs --selfcheck-relocation
 *
 * @module scripts/grok-effort-preflight
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertKnownFlags, ArgvError, emit } from './lib/cli-io.mjs';
import { atomicWriteFileSync, readFileOrDie } from './lib/file-io.mjs';
import { buildReviewEnvelope } from './lib/final-review/envelope.mjs';
import { redactSecretsWithCount } from './lib/sensitive-egress-gate.mjs';
import { resolveModel, resolveXaiCreds } from './lib/model-resolver.mjs';
import { priceFor } from './lib/model-pricing.mjs';

const KNOWN_FLAGS = Object.freeze(['--build-fixture', '--run', '--selfcheck-relocation', '--help', '-h']);

/** Category A: derived from a chosen real transcript, contains repo content. Never committed. */
export const FIXTURE_PATH = '.audit/grok-preflight-fixture.json';
/**
 * Committed, git-tracked — but NOT a Category B artifact in AGENTS.md's strict
 * sense ("a pure, deterministic function of committed source, freshness-
 * verified in the pre-push check"). This is a point-in-time measurement: six
 * live xAI calls, non-deterministic latencies/token counts, a wall-clock
 * `generatedAt`. Re-running `--run` produces a DIFFERENT, equally valid
 * artifact, not a byte-identical rebuild — there is no regeneration check for
 * it in `npm run check` and there should never be one (cluster audit's H3/M6,
 * round 4). It's committed for the same reason
 * docs/research/final-review-shadow-adjudication-briefing.md is: as
 * reviewed, dated evidence for a decision, not as a build artifact. The
 * `preflight` block in a campaign manifest binds this file's sha256 so a
 * hand-edited or substituted result can't silently pass — that attests "this
 * exact historical measurement, unmodified", never "xAI's current behaviour
 * still matches it". A model swap or a material `buildReviewEnvelope` change
 * invalidates the measurement's relevance; re-run `--run` and update the
 * manifest's `preflight.sha256` by hand when that happens (the same
 * synchronous-not-shadowed discipline the model swap-in eval harness uses —
 * AGENTS.md's Model Swap-In Evaluation Harness section).
 */
export const ARTIFACT_PATH = 'docs/research/grok-effort-preflight-2026q3.json';

/**
 * Tighter than the campaign's own THIN_ENVELOPE_MAX_CHARS (340,000) —
 * deliberately, because this fixture is sent SIX times and the whole point of
 * bounding it is a small, provable spend. 200,000 chars keeps the derived
 * worst-case comfortably inside SPEND_CAP_USD even at the pessimistic
 * chars/token ratio used in the derivation below.
 */
export const PREFLIGHT_FIXTURE_MAX_CHARS = 200_000;

/** Bounds a single reply — completion tokens include reasoning tokens on this provider. */
export const MAX_OUTPUT_TOKENS = 16_000;

export const TRIALS_PER_EFFORT = 3;

/**
 * $8, not the $5 an earlier draft used. Derivation (plan §8): worst case is 6
 * calls x 200,000 chars at a PESSIMISTIC 1.5 chars/token (worse than any ratio
 * yet observed) x the tier-2 xAI input rate ($4.00/1M) = ~$5.44 input, plus
 * 6 x MAX_OUTPUT_TOKENS x the tier-2 output rate ($12.00/1M) = ~$1.15 output —
 * true worst case ~$6.59, which exceeds $5. $8 is the smallest round number
 * clearing that bound with headroom; the realistic cost (tier-1 rates, the
 * measured ~2.2 chars/token) is closer to $1-2.
 */
export const SPEND_CAP_USD = 8;

/**
 * The tier-2 (highest) rate for the pre-flight's own model, read from the
 * SAME table `costFromUsage`/`costForBudget` use — never a second copy of the
 * numbers. `inputTokens: Number.MAX_SAFE_INTEGER` forces tier selection to the
 * highest (most expensive) tier, which is what a WORST-CASE bound must use.
 * An earlier version hardcoded 4.00/12.00 as default params, duplicating
 * scripts/lib/config.mjs's modelPricing entry — if that rate card ever
 * changes, the two would silently drift (the cluster audit's M3).
 */
function worstCaseXaiRate() {
  const px = priceFor(resolveModel('latest-grok'), { inputTokens: Number.MAX_SAFE_INTEGER });
  if (!px) throw new Error('[grok-preflight] no price entry for the resolved xAI model — cannot compute a spend bound.');
  return { input: px.input, output: px.output };
}

/**
 * Compute the worst-case spend bound BEFORE any request, from the ACTUAL
 * fixture size — not an assumption. Both halves are bounded: input from the
 * fixture's char count at a pessimistic chars/token ratio, output from the
 * fixed max_tokens ceiling (which bounds completion INCLUSIVE of reasoning
 * tokens on this provider — an earlier draft bounded input only and called
 * that a pre-call cap, which it was not).
 *
 * HONEST LIMIT (cluster audit's M2, same caveat lib/final-review/envelope.mjs
 * states for its own char-based ceiling): `pessimisticCharsPerToken` is an
 * OPERATIONALLY VALIDATED assumption, not a mathematical guarantee — no
 * finite ratio can bound every possible tokenizer on every possible input
 * (a pathological unicode-dense string could in principle tokenize denser
 * than assumed). What grounds this specific value: xAI's REAL measured ratio
 * on this repo's own content was 4.14 chars/token (docs/research/
 * grok-effort-preflight-2026q3.json, 2026-08-14) — nearly 3x more efficient
 * than the 1.5 assumed here, so the margin is wide for realistic text. The
 * residual risk is bounded, not eliminated, by SPEND_CAP_USD's own headroom
 * (derived to exceed the true worst case at these rates by ~$1.40) — an
 * extreme, unrealistic ratio could still exceed it, and this function does
 * not claim otherwise.
 *
 * @param {number} fixtureChars
 * @param {{tier2Input?: number, tier2Output?: number, pessimisticCharsPerToken?: number}} [rates]
 *   Overridable for tests; default to the LIVE pricing table, not a literal.
 */
export function computeWorstCaseSpendUsd(fixtureChars, rates = {}) {
  const live = worstCaseXaiRate();
  const {
    tier2Input = live.input, tier2Output = live.output, pessimisticCharsPerToken = 1.5,
  } = rates;
  const trials = TRIALS_PER_EFFORT * 2; // low + high
  const worstCaseInputTokens = fixtureChars / pessimisticCharsPerToken;
  const inputUsd = (trials * worstCaseInputTokens * tier2Input) / 1_000_000;
  const outputUsd = (trials * MAX_OUTPUT_TOKENS * tier2Output) / 1_000_000;
  return { totalUsd: inputUsd + outputUsd, inputUsd, outputUsd };
}

/**
 * Build the fixture from a real transcript + plan, through the SAME assembly
 * the campaign uses. Truncation at PREFLIGHT_FIXTURE_MAX_CHARS is via the
 * envelope's own budget (buildReviewEnvelope with scope:'thin'), never a raw
 * string slice — a sliced envelope could cut mid-block and stop being valid
 * input to what it is meant to represent.
 */
export function buildFixture({ transcriptPath, planPath, maxChars = PREFLIGHT_FIXTURE_MAX_CHARS, outPath = FIXTURE_PATH }) {
  const transcriptContent = readFileOrDie(transcriptPath);
  const planContent = readFileOrDie(planPath);
  let transcript;
  try { transcript = JSON.parse(transcriptContent); } catch { transcript = { raw: transcriptContent }; }

  const { userPrompt: assembled, accounting } = buildReviewEnvelope({
    scope: 'thin',
    projectContext: '(pre-flight fixture — project context omitted; not needed to measure the reasoning-effort dial)',
    planContent,
    repoContextBlock: '',
    scopeBlock: '',
    transcript,
    debtBlock: '',
    codePaths: [],
    renderCode: () => '',
    maxChars,
  });

  // KD-8's defence-in-depth secret scan, applied here for the SAME reason
  // gemini-review.mjs applies it to every assembled envelope: this repo's
  // content is about to leave the machine, to a THIRD PARTY that never saw
  // this codebase before this plan. Missing this was flagged by the cluster's
  // own audit (H4/H6) — `buildReviewEnvelope`'s output was written to the
  // fixture and sent to xAI unredacted, six times per pre-flight run.
  const scanned = redactSecretsWithCount(assembled);
  const userPrompt = scanned.text;

  const fixture = {
    generatedAt: new Date().toISOString(),
    sourceTranscript: path.relative(process.cwd(), transcriptPath),
    sourcePlan: path.relative(process.cwd(), planPath),
    envelopeAccounting: accounting,
    redactions: scanned.redacted,
    userPrompt,
  };
  fixture.sha256 = crypto.createHash('sha256').update(userPrompt).digest('hex');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  atomicWriteFileSync(outPath, JSON.stringify(fixture, null, 2));
  return fixture;
}

/** No connection may hang a trial forever — the pre-flight is a bounded, six-call measurement, not a long-running client. */
export const CALL_TIMEOUT_MS = 120_000;

async function callXai({ userPrompt, effort, apiKey, timeoutMs = CALL_TIMEOUT_MS }) {
  const body = JSON.stringify({
    model: resolveModel('latest-grok'),
    messages: [
      { role: 'system', content: 'You are a code reviewer. Read the material and reply with a one-sentence assessment.' },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: MAX_OUTPUT_TOKENS,
    reasoning_effort: effort,
  });
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // The timer is cleared ONCE, after the body is fully read — not after
  // fetch() alone resolves. fetch() resolving only means HEADERS arrived; a
  // server that sends headers and then stalls the body would hang res.json()
  // indefinitely with no deadline if the timer were cleared earlier (the
  // cluster audit's M2). The SAME AbortController covers both: aborting after
  // fetch() has already resolved still cancels an in-flight body read on the
  // same request, so one controller and one timer bound the whole call.
  let res;
  let json;
  try {
    res = await fetch(`${resolveXaiCreds().baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    // A malformed-but-COMPLETE body is a parse failure (json:null, reported
    // below as HTTP <status>). An ABORTED body read is a timeout, not a parse
    // failure — re-thrown so the outer catch reports it as one, rather than
    // being swallowed here and losing that distinction.
    try { json = await res.json(); } catch (parseErr) {
      if (parseErr.name === 'AbortError') throw parseErr;
      json = null;
    }
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    return {
      effort, httpStatus: null, ok: false,
      error: timedOut ? `timed out after ${timeoutMs}ms` : err.message,
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - started;
  if (!res.ok || !json) {
    return { effort, httpStatus: res.status, ok: false, error: json?.error?.message || `HTTP ${res.status}`, latencyMs };
  }
  const usage = json.usage || {};
  return {
    effort,
    httpStatus: res.status,
    ok: true,
    latencyMs,
    promptTokens: usage.prompt_tokens ?? null,
    completionTokens: usage.completion_tokens ?? null,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
  };
}

/**
 * The disposition rule (plan §8), applied to already-collected trials — pure,
 * so it is testable without a network call.
 *
 * PASS: min(high reasoning tokens) > max(low reasoning tokens) — the
 * distributions do not overlap. Chosen over a mean-difference test because
 * n=3 makes a mean fragile; non-overlap is the honest claim 3 samples support.
 *
 * INCONCLUSIVE folds into FAIL for manifest purposes (any non-200, missing
 * usage field, or spend abort) — stated as its own value here so the caller
 * can log WHY, but a campaign only ever checks disposition === 'pass'.
 */
export function computeDisposition(trials) {
  if (trials.length !== TRIALS_PER_EFFORT * 2) {
    return { disposition: 'inconclusive', reason: `expected ${TRIALS_PER_EFFORT * 2} trials, got ${trials.length}` };
  }
  const failed = trials.filter((t) => !t.ok || !Number.isFinite(t.reasoningTokens));
  if (failed.length > 0) {
    return { disposition: 'inconclusive', reason: `${failed.length} trial(s) failed or reported no reasoning_tokens — treated as fail for manifest purposes` };
  }
  // Reject any label outside the two expected, and require the EXACT 3/3
  // split — not just the aggregate count checked above. Without this, a
  // labelling bug (every trial tagged 'low') passes the length check, leaves
  // `high` empty, and Math.min(...[]) silently returns Infinity — a PASS
  // built on garbage evidence, exactly the "accepted but inert" failure class
  // this whole script exists to catch, just one layer further in.
  const unexpectedLabels = trials.filter((t) => t.effort !== 'low' && t.effort !== 'high');
  if (unexpectedLabels.length > 0) {
    return { disposition: 'inconclusive', reason: `unexpected effort label(s): ${unexpectedLabels.map((t) => t.effort).join(', ')}` };
  }
  const low = trials.filter((t) => t.effort === 'low').map((t) => t.reasoningTokens);
  const high = trials.filter((t) => t.effort === 'high').map((t) => t.reasoningTokens);
  if (low.length !== TRIALS_PER_EFFORT || high.length !== TRIALS_PER_EFFORT) {
    return { disposition: 'inconclusive', reason: `expected ${TRIALS_PER_EFFORT} trials per effort level, got low=${low.length} high=${high.length}` };
  }
  const minHigh = Math.min(...high);
  const maxLow = Math.max(...low);
  if (minHigh > maxLow) {
    return { disposition: 'pass', reason: `min(high)=${minHigh} > max(low)=${maxLow} — distributions do not overlap` };
  }
  return { disposition: 'fail', reason: `min(high)=${minHigh} <= max(low)=${maxLow} — the dial is inert or unproven; drop the Grok arm` };
}

async function run() {
  if (!fs.existsSync(FIXTURE_PATH)) {
    throw new ArgvError(`[grok-preflight] no fixture at ${FIXTURE_PATH} — run --build-fixture <transcript.json> <plan.md> first.`);
  }
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));
  const apiKey = resolveXaiCreds().apiKey;
  if (!apiKey) throw new ArgvError('[grok-preflight] XAI_API_KEY is not set.');

  // Second, independent redaction pass — the cluster audit's H3. buildFixture
  // already redacts before writing, but `run()` reads the fixture back from
  // DISK: between build and run, the file is untrusted input as far as this
  // function is concerned (hand-edited, restored from an older run, or
  // written by anything other than buildFixture). The enforcement boundary
  // belongs at the actual egress point (immediately before the network call),
  // matching where gemini-review.mjs applies its own KD-8 scan — not solely at
  // an earlier build step whose output could be read from disk unchecked.
  // Idempotent on already-redacted text: redacted markers contain no secret
  // patterns, so a second pass finds nothing new to redact.
  const rescan = redactSecretsWithCount(fixture.userPrompt);
  if (rescan.redacted > 0) {
    process.stderr.write(`  [grok-preflight] WARNING: ${rescan.redacted} secret-shaped match(es) found in the on-disk fixture at send time — redacting before any call. Rebuild the fixture with --build-fixture to get a clean one.\n`);
  }
  fixture.userPrompt = rescan.text;

  const bound = computeWorstCaseSpendUsd(fixture.userPrompt.length);
  process.stderr.write(`  [grok-preflight] fixture: ${fixture.userPrompt.length} chars (sha256 ${fixture.sha256.slice(0, 12)}…)\n`);
  process.stderr.write(`  [grok-preflight] worst-case spend bound: $${bound.totalUsd.toFixed(2)} (cap $${SPEND_CAP_USD})\n`);
  if (bound.totalUsd > SPEND_CAP_USD) {
    throw new ArgvError(`[grok-preflight] REFUSING to start — worst-case bound $${bound.totalUsd.toFixed(2)} exceeds the $${SPEND_CAP_USD} cap. Shrink the fixture or raise SPEND_CAP_USD deliberately.`);
  }

  const plan = [
    ...Array.from({ length: TRIALS_PER_EFFORT }, () => 'low'),
    ...Array.from({ length: TRIALS_PER_EFFORT }, () => 'high'),
  ];
  const trials = [];
  for (const effort of plan) {
    process.stderr.write(`  [grok-preflight] trial ${trials.length + 1}/${plan.length} (${effort})...\n`);
    // eslint-disable-next-line no-await-in-loop -- sequential by design: this is a bounded, auditable measurement, not a throughput test.
    const r = await callXai({ userPrompt: fixture.userPrompt, effort, apiKey });
    trials.push(r);
    process.stderr.write(`    ${r.ok ? `reasoning_tokens=${r.reasoningTokens}` : `FAILED: ${r.error}`}\n`);
  }

  const { disposition, reason } = computeDisposition(trials);
  process.stderr.write(`  [grok-preflight] disposition: ${disposition} — ${reason}\n`);

  const artifact = {
    // Static, never derived from the run — see ARTIFACT_PATH's docstring.
    // Read this before treating the file's presence/sha256 as proof the
    // measurement still holds.
    provenance: 'Point-in-time measurement from live xAI calls; NOT '
      + 'byte-reproducible from committed source (generatedAt/latencyMs/'
      + 'token counts vary per run). A manifest sha256 binding attests this '
      + 'exact historical result is unmodified, not that current provider '
      + 'behaviour still matches it. See ARTIFACT_PATH docstring in '
      + 'scripts/grok-effort-preflight.mjs.',
    generatedAt: new Date().toISOString(),
    model: resolveModel('latest-grok'),
    fixture: {
      path: FIXTURE_PATH,
      sha256: fixture.sha256,
      chars: fixture.userPrompt.length,
      sourceTranscript: fixture.sourceTranscript,
      sourcePlan: fixture.sourcePlan,
    },
    // Redacted evidence: token counts and timing only, never the fixture text
    // or the model's reply — this artifact is committed to git.
    trials: trials.map(({ effort, httpStatus, ok, latencyMs, promptTokens, completionTokens, reasoningTokens, error }) =>
      ({ effort, httpStatus, ok, latencyMs, promptTokens, completionTokens, reasoningTokens, error: error ?? null })),
    spendBoundUsd: bound.totalUsd,
    disposition,
    reason,
  };
  fs.mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
  fs.writeFileSync(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`);
  const artifactSha256 = crypto.createHash('sha256').update(fs.readFileSync(ARTIFACT_PATH)).digest('hex');

  emit({
    ok: disposition === 'pass',
    disposition,
    reason,
    artifact: ARTIFACT_PATH,
    sha256: artifactSha256,
    model: artifact.model,
    spendBoundUsd: bound.totalUsd,
  });
  process.stderr.write(`  [grok-preflight] artifact written: ${ARTIFACT_PATH} (sha256 ${artifactSha256})\n`);
  if (disposition !== 'pass') {
    process.stderr.write('  [grok-preflight] NOT PASS — do not add a grok arm to any campaign manifest referencing this artifact.\n');
  }
}

async function main() {
  const argv = process.argv.slice(2);
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'grok-effort-preflight' });

  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${[
      'Usage:',
      '  node scripts/grok-effort-preflight.mjs --build-fixture <transcript.json> <plan.md>',
      '  node scripts/grok-effort-preflight.mjs --run',
    ].join('\n')}\n`);
    return;
  }

  const buildIdx = argv.indexOf('--build-fixture');
  if (buildIdx !== -1) {
    const transcriptPath = argv[buildIdx + 1];
    const planPath = argv[buildIdx + 2];
    if (!transcriptPath || !planPath) {
      throw new ArgvError('[grok-preflight] --build-fixture requires <transcript.json> <plan.md>');
    }
    const fixture = buildFixture({ transcriptPath, planPath });
    emit({ ok: true, fixture: FIXTURE_PATH, sha256: fixture.sha256, chars: fixture.userPrompt.length });
    return;
  }

  if (argv.includes('--run')) {
    await run();
    return;
  }

  throw new ArgvError('[grok-preflight] no action given — pass --build-fixture or --run (see --help).');
}

const invokedDirectly = (() => {
  try {
    const a = (process.argv[1] || '').replace(/\\/g, '/').toLowerCase();
    return a.endsWith('/grok-effort-preflight.mjs');
  } catch { return false; }
})();

if (invokedDirectly) {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  main().catch((err) => {
    if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') { process.stderr.write(`${err.message}\n`); process.exit(2); }
    process.stderr.write(`Error: ${err.message}\n`); process.exit(1);
  });
}
