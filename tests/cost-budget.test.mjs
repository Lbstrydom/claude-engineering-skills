/**
 * Tier-1 tests for Phase 4 cost-budget tracking (tiered-recall pipeline,
 * Cluster B). Plan: docs/plans/tiered-recall-audit-pipeline.md.
 * Covers: buildUsageEvent (reusing model-pricing.mjs, never re-deriving
 * cost), buildReviewEffortEvent, and computeCostReport's severity-weighted
 * accepted-HIGH-equivalent metric + zero-accepted-HIGH edge case
 * (round-2 finding #7).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildUsageEvent, tryBuildUsageEvent, UsageEventSchema } from '../scripts/lib/audit/usage-event.mjs';
import { buildReviewEffortEvent } from '../scripts/lib/audit/review-effort-event.mjs';
import { computeCostReport, recordUsageEvent, loadUsageEvents } from '../scripts/lib/audit/cost-budget.mjs';
import { EUR_PER_USD, priceFor } from '../scripts/lib/model-pricing.mjs';

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cost-budget-test-')), name);
}

// Use a model that's guaranteed to be priced so cost math is deterministic.
const PRICED_MODEL = 'gpt-5.5';

describe('buildUsageEvent', () => {
  it('computes cost from tokens via model-pricing.mjs when no self-reported cost is given', () => {
    const px = priceFor(PRICED_MODEL);
    if (!px) return; // skip gracefully if the static pool doesn't know this id in test env
    const event = buildUsageEvent({
      provider: 'openai', modelSentinel: 'latest-gpt', resolvedModel: PRICED_MODEL,
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 }, wallClockMs: 500,
    }, '2026-01-01T00:00:00.000Z');
    assert.equal(event.usageReliability, 'estimated');
    assert.ok(event.costAmountUsd > 0);
    assert.equal(event.fxRateUsed, EUR_PER_USD);
    assert.equal(Math.round(event.costAmountEurAtRecordedFx * 100), Math.round(event.costAmountUsd * EUR_PER_USD * 100));
  });

  it('uses self-reported cost (CLI backend) and marks usageReliability exact', () => {
    const event = buildUsageEvent({
      provider: 'anthropic', modelSentinel: 'latest-sonnet', resolvedModel: 'claude-sonnet-5',
      usage: { input_tokens: 100, output_tokens: 200 }, selfReportedCostUsd: 0.05,
    }, '2026-01-01T00:00:00.000Z');
    assert.equal(event.usageReliability, 'exact');
    assert.equal(event.costAmountUsd, 0.05);
  });

  it('marks usageReliability unavailable for an unpriced/unknown model, cost 0 (never null-crashing)', () => {
    const event = buildUsageEvent({
      provider: 'oss', modelSentinel: 'some-unknown-model', resolvedModel: 'totally-unknown-model-id-xyz',
      usage: { input_tokens: 10, output_tokens: 10 },
    }, '2026-01-01T00:00:00.000Z');
    assert.equal(event.usageReliability, 'unavailable');
    assert.equal(event.costAmountUsd, 0);
  });

  it('the fxRateUsed field is snapshotted at build time (round-3 finding #G2) — validates against the schema', () => {
    const event = buildUsageEvent({
      provider: 'gemini', modelSentinel: 'latest-pro', resolvedModel: 'gemini-pro-latest',
      usage: { input_tokens: 5, output_tokens: 5 }, selfReportedCostUsd: 0.001,
    }, '2026-01-01T00:00:00.000Z');
    assert.ok(UsageEventSchema.safeParse(event).success);
    assert.equal(typeof event.fxRateUsed, 'number');
  });
});

// tryBuildUsageEvent — the fail-open wrapper the tiered pipeline captures with.
// Usage/cost is ADVISORY telemetry; a malformed provider usage object (or a
// missing required field) must NEVER throw up through an audit stage and abort
// the run. It degrades to a dropped event (null), never a crash.
describe('tryBuildUsageEvent (fail-open capture wrapper)', () => {
  it('returns a valid event for well-formed input (same as buildUsageEvent)', () => {
    const event = tryBuildUsageEvent({
      provider: 'oss', modelSentinel: 'z-ai/glm-5.2', resolvedModel: 'z-ai/glm-5.2',
      usage: { input_tokens: 1000, output_tokens: 500 },
    }, '2026-01-01T00:00:00.000Z');
    assert.ok(event);
    assert.ok(UsageEventSchema.safeParse(event).success);
  });

  it('returns null (never throws) when the provider is not in the enum', () => {
    assert.doesNotThrow(() => {
      const ev = tryBuildUsageEvent({
        provider: 'not-a-real-provider', modelSentinel: 'x', resolvedModel: 'x',
        usage: { input_tokens: 1, output_tokens: 1 },
      }, '2026-01-01T00:00:00.000Z');
      assert.equal(ev, null);
    });
  });

  it('returns null (never throws) for a null/garbage raw payload', () => {
    assert.equal(tryBuildUsageEvent(null, '2026-01-01T00:00:00.000Z'), null);
    assert.equal(tryBuildUsageEvent(42, '2026-01-01T00:00:00.000Z'), null);
  });

  it('an unpriced model still yields an event (unavailable), not null — that is a KEPT signal, not a capture failure', () => {
    const ev = tryBuildUsageEvent({
      provider: 'gemini', modelSentinel: 'x', resolvedModel: 'unknown-model-xyz',
      usage: { input_tokens: 10, output_tokens: 10 },
    }, '2026-01-01T00:00:00.000Z');
    assert.ok(ev, 'unpriced ≠ capture failure — the event is kept so unavailableCostEventCount can count it');
    assert.equal(ev.usageReliability, 'unavailable');
  });
});

// Shape-contract lock for the tiered pipeline's per-stage capture (2026-07-22).
// The three stages hand recordUsage() three DIFFERENT provider usage shapes;
// all must price via the same costFromUsage path (which reads input_tokens/
// output_tokens). If a provider changes its usage shape, this fails loudly
// rather than silently pricing to 0 and re-introducing the "tiered is free" bug.
describe('tiered per-stage capture — the real provider usage shapes all price', () => {
  const build = (provider, resolvedModel, usage, extra = {}) =>
    tryBuildUsageEvent({ provider, modelSentinel: resolvedModel, resolvedModel, usage, ...extra }, '2026-01-01T00:00:00.000Z');

  it('OSS-normalized (discovery GLM / Stage-1 GLM) prices, and provider_cost_usd is used verbatim when passed as selfReportedCostUsd', () => {
    // ossStructuredCall's normaliseUsage shape.
    const usage = { input_tokens: 12000, cached_tokens: 0, output_tokens: 3000, reasoning_tokens: 0, latency_ms: 900, usageMissing: false, provider_cost_usd: 0.0123 };
    const estimated = build('oss', 'z-ai/glm-5.2', usage);
    assert.ok(estimated.costAmountUsd > 0, 'token-priced OSS usage must be > 0');
    const exact = build('oss', 'z-ai/glm-5.2', usage, { selfReportedCostUsd: usage.provider_cost_usd });
    assert.equal(exact.costAmountUsd, 0.0123, "OpenRouter's own cost is used verbatim");
    assert.equal(exact.usageReliability, 'exact');
  });

  it('Anthropic SDK shape (discovery Sonnet) prices', () => {
    const usage = { input_tokens: 8000, output_tokens: 2000 }; // resp.usage
    const ev = build('anthropic', 'claude-sonnet-5', usage);
    assert.ok(ev.costAmountUsd > 0);
    assert.equal(ev.usageReliability, 'estimated');
  });

  it('Gemini shape with thinking_tokens (Stage 2) prices off input/output', () => {
    const usage = { input_tokens: 5000, output_tokens: 1500, thinking_tokens: 400 }; // --out _usage
    const ev = build('gemini', 'gemini-3-pro-preview', usage);
    assert.ok(ev.costAmountUsd > 0);
  });

  it('a whole run priced across all three shapes yields a real, non-zero costUsd (the metric the stopping rule reads)', () => {
    const events = [
      build('oss', 'z-ai/glm-5.2', { input_tokens: 12000, output_tokens: 3000 }),
      build('anthropic', 'claude-sonnet-5', { input_tokens: 8000, output_tokens: 2000 }),
      build('gemini', 'gemini-3-pro-preview', { input_tokens: 5000, output_tokens: 1500 }),
    ];
    const report = computeCostReport({ usageEvents: events, reviewEffortEvents: [], acceptedFindings: [] });
    assert.ok(report.costUsd > 0, 'a real multi-stage run must produce a real cost, not 0');
    assert.equal(report.unavailableCostEventCount, 0, 'all three families are priced');
  });
});

describe('buildReviewEffortEvent', () => {
  it('builds a valid event from caller-supplied minutesSpent', () => {
    const event = buildReviewEffortEvent({
      envelopeId: 'env-1', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:05:00Z', minutesSpent: 5,
    });
    assert.equal(event.minutesSpent, 5);
    assert.equal(event.reviewerId, null);
  });
  it('throws when raw is not an object (audit fix M4)', () => {
    assert.throws(() => buildReviewEffortEvent(null));
    assert.throws(() => buildReviewEffortEvent('x'));
  });
  it('rejects endedAt before startedAt (audit fix M4/L3)', () => {
    assert.throws(() => buildReviewEffortEvent({
      envelopeId: 'env-1', startedAt: '2026-01-01T00:05:00Z', endedAt: '2026-01-01T00:00:00Z', minutesSpent: 5,
    }));
  });
  it('rejects non-finite or absurdly large minutesSpent', () => {
    assert.throws(() => buildReviewEffortEvent({
      envelopeId: 'env-1', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:05:00Z', minutesSpent: Infinity,
    }));
    assert.throws(() => buildReviewEffortEvent({
      envelopeId: 'env-1', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:05:00Z', minutesSpent: 999999,
    }));
  });
  it('rejects minutesSpent that exceeds the startedAt..endedAt interval (audit fix M5/M9)', () => {
    assert.throws(() => buildReviewEffortEvent({
      envelopeId: 'env-1', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z', minutesSpent: 300,
    }));
  });
  it('allows minutesSpent less than the interval (breaks/interruptions are legitimate)', () => {
    const event = buildReviewEffortEvent({
      envelopeId: 'env-1', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T02:00:00Z', minutesSpent: 20,
    });
    assert.equal(event.minutesSpent, 20);
  });
  it('allows minutesSpent within the 1-minute rounding tolerance', () => {
    const event = buildReviewEffortEvent({
      envelopeId: 'env-1', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:05:00Z', minutesSpent: 5.9,
    });
    assert.equal(event.minutesSpent, 5.9);
  });
});

describe('cost-budget persistence (AppendOnlyStore reuse — audit fixes H5/H6/H8/M4/M8/M9)', () => {
  it('records and reloads a valid UsageEvent', () => {
    const file = tmpFile('usage.jsonl');
    const event = buildUsageEvent({
      provider: 'anthropic', modelSentinel: 'latest-sonnet', resolvedModel: 'claude-sonnet-5',
      usage: { input_tokens: 10, output_tokens: 10 }, selfReportedCostUsd: 0.01,
    }, '2026-01-01T00:00:00.000Z');
    recordUsageEvent(file, event);
    const loaded = loadUsageEvents(file);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].costAmountUsd, 0.01);
  });
  it('a missing file loads as an empty array, not an error', () => {
    assert.deepEqual(loadUsageEvents(tmpFile('never-written.jsonl')), []);
  });
  it('a schema-invalid event is quarantined, not persisted (audit fix H5/H8 — corrupt data never silently accepted)', () => {
    const file = tmpFile('usage.jsonl');
    recordUsageEvent(file, { provider: 'not-a-real-provider', totally: 'invalid' });
    assert.deepEqual(loadUsageEvents(file), []);
  });
});

describe('computeCostReport', () => {
  it('sums cost + operator minutes across events', () => {
    const usageEvents = [
      { costAmountUsd: 1, costAmountEurAtRecordedFx: 0.9 },
      { costAmountUsd: 2, costAmountEurAtRecordedFx: 1.8 },
    ];
    const reviewEffortEvents = [{ minutesSpent: 3 }, { minutesSpent: 7 }];
    const report = computeCostReport({ usageEvents, reviewEffortEvents, acceptedFindings: [{ severity: 'HIGH' }] });
    assert.equal(report.costUsd, 3);
    assert.equal(report.costEurAsRecorded, 2.7);
    assert.equal(report.operatorMinutes, 10);
  });

  it('acceptedHighEquivalentCount uses the SAME SEV_WEIGHTS ratios as model_ab_finding_scores (round-2 finding #7)', () => {
    // HIGH=8, MEDIUM=3, LOW=1 in DECISION_CONSTANTS.SEV_WEIGHTS -> HIGH counts
    // as 1.0 equivalent, MEDIUM as 3/8, LOW as 1/8.
    const report = computeCostReport({
      usageEvents: [{ costAmountUsd: 8 }],
      acceptedFindings: [{ severity: 'HIGH' }, { severity: 'MEDIUM' }, { severity: 'LOW' }],
    });
    assert.equal(report.acceptedHighEquivalentCount, 1 + 3 / 8 + 1 / 8);
  });

  it('zero-accepted-HIGH edge case returns nulls + a reason, never divides by zero (AGENTS.md success-path rule)', () => {
    const report = computeCostReport({ usageEvents: [{ costAmountUsd: 5 }], acceptedFindings: [] });
    assert.equal(report.acceptedHighEquivalentCount, 0);
    assert.equal(report.costUsdPerAcceptedHigh, null);
    assert.equal(report.operatorMinutesPerAcceptedHigh, null);
    assert.equal(report.reason, 'no-accepted-highs');
  });

  it('handles fully empty inputs without throwing', () => {
    assert.doesNotThrow(() => computeCostReport({}));
  });
  it('unavailable-priced events are excluded from costUsd and counted separately, never summed as $0 (audit fix H7/M12)', () => {
    const usageEvents = [
      { costAmountUsd: 5, costAmountEurAtRecordedFx: 4.5, usageReliability: 'estimated' },
      { costAmountUsd: 0, costAmountEurAtRecordedFx: 0, usageReliability: 'unavailable' },
    ];
    const report = computeCostReport({ usageEvents, acceptedFindings: [{ severity: 'HIGH' }] });
    assert.equal(report.costUsd, 5); // the unavailable event's 0 does NOT get summed in as confirmed cost
    assert.equal(report.unavailableCostEventCount, 1);
  });
});
