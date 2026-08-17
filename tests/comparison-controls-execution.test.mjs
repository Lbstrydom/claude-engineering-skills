/**
 * @fileoverview Regression cover for auditor-controls-execution-wiring.md
 * (Phases 1-4, complete): the five optional dials on `AuditorControlsSchema`,
 * the append-only `promptTemplateId`/`outputSchemaId` enums + `toolPolicy`
 * literal + `rounds===1` refine, `deriveControlsApplied`'s per-arm evidence
 * rule across all eight covered fields × both execution branches, and
 * `auditorExecuteArm`'s spawn-argv construction.
 *
 * @module tests/comparison-controls-execution
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AuditorControlsSchema, deriveControlsApplied, TIER_C_MAX_OUTPUT_TOKENS,
  AUDITOR_TIER_C_PROMPT_IDS, AUDITOR_TIER_C_SCHEMA_IDS,
} from '../scripts/lib/comparison/controls.mjs';
import { _internals as executorInternals } from '../scripts/lib/model-eval/executors.mjs';
import { buildAuditorPrompt, AuditorExtractionSchema } from '../scripts/lib/model-eval/structured-extractor.mjs';

const { buildAuditorSpawnArgs } = executorInternals;

const VALID_PROMPT_ID = AUDITOR_TIER_C_PROMPT_IDS[AUDITOR_TIER_C_PROMPT_IDS.length - 1];
const VALID_SCHEMA_ID = AUDITOR_TIER_C_SCHEMA_IDS[AUDITOR_TIER_C_SCHEMA_IDS.length - 1];
const REQUIRED_CONTROLS = { promptTemplateId: VALID_PROMPT_ID, outputSchemaId: VALID_SCHEMA_ID, toolPolicy: 'none', rounds: 1 };
const CONTEXT = { tier: 'promotion', thresholdsPath: '/t.json', corpusPath: '/c.json', repoRoots: ['/repo'] };
const ARM = { id: 'CAND', model: 'gpt-5.6' };

describe('AuditorControlsSchema — the five optional dials', () => {
  it('accepts all five omitted', () => {
    assert.equal(AuditorControlsSchema.safeParse(REQUIRED_CONTROLS).success, true);
  });

  it('accepts all five present with valid values', () => {
    const r = AuditorControlsSchema.safeParse({
      ...REQUIRED_CONTROLS, reasoningEffort: 'high', temperature: 0.5, maxOutputTokens: 4000,
      scope: 'diff', passes: ['structure'],
    });
    assert.equal(r.success, true);
  });

  it('refuses maxOutputTokens above TIER_C_MAX_OUTPUT_TOKENS', () => {
    const r = AuditorControlsSchema.safeParse({ ...REQUIRED_CONTROLS, maxOutputTokens: TIER_C_MAX_OUTPUT_TOKENS + 1 });
    assert.equal(r.success, false);
  });

  it('promptTemplateId/outputSchemaId/toolPolicy stay REQUIRED — omitting any one refuses', () => {
    for (const field of ['promptTemplateId', 'outputSchemaId', 'toolPolicy']) {
      const partial = { ...REQUIRED_CONTROLS };
      delete partial[field];
      assert.equal(AuditorControlsSchema.safeParse(partial).success, false, `omitting ${field} must be refused`);
    }
  });

  it('rounds stays required', () => {
    const partial = { ...REQUIRED_CONTROLS };
    delete partial.rounds;
    assert.equal(AuditorControlsSchema.safeParse(partial).success, false);
  });
});

describe('AuditorControlsSchema — Phase 4: append-only enum + literal + refine', () => {
  it('refuses a promptTemplateId/outputSchemaId not in the append-only enum', () => {
    assert.equal(AuditorControlsSchema.safeParse({ ...REQUIRED_CONTROLS, promptTemplateId: 'not-a-real-id' }).success, false);
    assert.equal(AuditorControlsSchema.safeParse({ ...REQUIRED_CONTROLS, outputSchemaId: 'not-a-real-id' }).success, false);
  });

  it('refuses toolPolicy other than the literal "none"', () => {
    assert.equal(AuditorControlsSchema.safeParse({ ...REQUIRED_CONTROLS, toolPolicy: 'structured-output-only' }).success, false);
  });

  it('refuses rounds !== 1 with the stated message', () => {
    const r = AuditorControlsSchema.safeParse({ ...REQUIRED_CONTROLS, rounds: 3 });
    assert.equal(r.success, false);
    assert.match(r.error.issues[0].message, /rounds > 1 is not implemented/);
  });

  it('reproducibility (round-4 M1): an append-only enum with multiple members accepts EVERY member, not just the newest — the mechanism, tested independent of this repo\'s real (currently single-entry) history', () => {
    const HistoricalSchema = z.object({ id: z.enum(['auditor-tier-c-v1-OLDHASH', 'auditor-tier-c-v1-NEWHASH']) }).strict();
    assert.equal(HistoricalSchema.safeParse({ id: 'auditor-tier-c-v1-OLDHASH' }).success, true, 'an old, still-listed entry must remain valid forever');
    assert.equal(HistoricalSchema.safeParse({ id: 'auditor-tier-c-v1-NEWHASH' }).success, true);
    assert.equal(HistoricalSchema.safeParse({ id: 'auditor-tier-c-v1-NEVER-LISTED' }).success, false, 'a genuinely unlisted value stays refused');
  });

  it('versioning canary (M1/M2): the CURRENT enum member\'s hash matches a live recomputation from buildAuditorPrompt/AuditorExtractionSchema — fails the moment either drifts without a deliberate new entry', () => {
    const sha256Hex8 = (input) => crypto.createHash('sha256').update(input).digest('hex').slice(0, 8);
    const livePromptHash = sha256Hex8(JSON.stringify(buildAuditorPrompt({ evidenceHunk: '<CANON>', filePaths: ['<CANON>'] })));
    const liveSchemaHash = sha256Hex8(JSON.stringify(z.toJSONSchema(AuditorExtractionSchema)));
    assert.ok(VALID_PROMPT_ID.endsWith(livePromptHash), `enum's newest promptTemplateId (${VALID_PROMPT_ID}) must end with the live hash (${livePromptHash}) — if this fails, buildAuditorPrompt changed without a new enum entry`);
    assert.ok(VALID_SCHEMA_ID.endsWith(liveSchemaHash), `enum's newest outputSchemaId (${VALID_SCHEMA_ID}) must end with the live hash (${liveSchemaHash}) — if this fails, AuditorExtractionSchema changed without a new enum entry`);
  });

  it('the canary actually CATCHES a real drift — mutating the prompt input changes its hash', () => {
    const sha256Hex8 = (input) => crypto.createHash('sha256').update(input).digest('hex').slice(0, 8);
    const realHash = sha256Hex8(JSON.stringify(buildAuditorPrompt({ evidenceHunk: '<CANON>', filePaths: ['<CANON>'] })));
    const mutatedHash = sha256Hex8(JSON.stringify(buildAuditorPrompt({ evidenceHunk: '<MUTATED-FOR-TEST>', filePaths: ['<CANON>'] })));
    assert.notEqual(realHash, mutatedHash, 'a canary that never fails on a real drift is not a canary');
  });
});

describe('deriveControlsApplied — all eight covered fields, both branches', () => {
  const FULL_CONTROLS = {
    ...REQUIRED_CONTROLS, reasoningEffort: 'high', temperature: 0.5, maxOutputTokens: 4000,
    scope: 'diff', passes: ['structure'],
  };
  const LIVE_HASHES = { promptTemplateId: VALID_PROMPT_ID, outputSchemaId: VALID_SCHEMA_ID };

  it('tier-a-b: scope/passes true, everything else false', () => {
    const applied = deriveControlsApplied(FULL_CONTROLS, { branch: 'tier-a-b' });
    assert.deepEqual(applied, {
      scope: true, passes: true, toolPolicy: false, promptTemplateId: false, outputSchemaId: false,
      reasoningEffort: false, temperature: false, maxOutputTokens: false,
    });
  });

  it('tier-c: scope/passes false; toolPolicy/promptTemplateId/outputSchemaId true when they match; reasoningEffort/temperature/maxOutputTokens follow honoredDials', () => {
    const applied = deriveControlsApplied(FULL_CONTROLS, {
      branch: 'tier-c', honoredDials: { reasoningEffort: true, temperature: false, maxOutputTokens: true }, liveHashes: LIVE_HASHES,
    });
    assert.deepEqual(applied, {
      scope: false, passes: false, toolPolicy: true, promptTemplateId: true, outputSchemaId: true,
      reasoningEffort: true, temperature: false, maxOutputTokens: true,
    });
  });

  it('an omitted field is ABSENT from the result, never true or false', () => {
    const applied = deriveControlsApplied(REQUIRED_CONTROLS, { branch: 'tier-a-b' });
    for (const field of ['scope', 'passes', 'reasoningEffort', 'temperature', 'maxOutputTokens']) {
      assert.equal(field in applied, false, `${field} must be absent, not present-and-false`);
    }
  });

  it('rounds is NEVER in the result — excluded by design (round-5 M1)', () => {
    const applied = deriveControlsApplied({ ...FULL_CONTROLS, rounds: 1 }, { branch: 'tier-c', liveHashes: LIVE_HASHES });
    assert.equal('rounds' in applied, false);
  });

  it('promptTemplateId/outputSchemaId report false on tier-c when the declared value does NOT match the live hash — round-5 H1 (stale-but-valid identity)', () => {
    const applied = deriveControlsApplied(FULL_CONTROLS, {
      branch: 'tier-c', honoredDials: {}, liveHashes: { promptTemplateId: 'DIFFERENT_FROM_DECLARED', outputSchemaId: VALID_SCHEMA_ID },
    });
    assert.equal(applied.promptTemplateId, false);
    assert.equal(applied.outputSchemaId, true);
  });

  it('a field absent from honoredDials on tier-c is conservatively false, never true (fail-safe)', () => {
    const applied = deriveControlsApplied(FULL_CONTROLS, { branch: 'tier-c', honoredDials: {}, liveHashes: LIVE_HASHES });
    assert.equal(applied.reasoningEffort, false);
    assert.equal(applied.temperature, false);
    assert.equal(applied.maxOutputTokens, false);
  });
});

describe('deriveControlsApplied — round-3 H2 multi-arm regression: two arms, two branches, one shared controls object', () => {
  it('the SAME controls object produces genuinely DIFFERENT evidence depending on the resolved branch', () => {
    const controls = { ...REQUIRED_CONTROLS, scope: 'full', reasoningEffort: 'xhigh' };
    const armAApplied = deriveControlsApplied(controls, { branch: 'tier-a-b' }); // e.g. this arm's model resolved to Tier A/B
    const armBApplied = deriveControlsApplied(controls, { branch: 'tier-c', honoredDials: { reasoningEffort: true }, liveHashes: { promptTemplateId: VALID_PROMPT_ID, outputSchemaId: VALID_SCHEMA_ID } }); // this arm's model resolved to Tier C
    assert.equal(armAApplied.scope, true);
    assert.equal(armBApplied.scope, false);
    assert.equal(armAApplied.reasoningEffort, false);
    assert.equal(armBApplied.reasoningEffort, true);
    assert.notDeepEqual(armAApplied, armBApplied, 'one shared controls object, two arms, two genuinely different truthful evidence records — no refusal, no conflict');
  });
});

describe('auditorExecuteArm spawn-argv construction (buildAuditorSpawnArgs)', () => {
  const DRIVER_ATTEMPT = {};

  it('omitting all five optional dials still ALWAYS includes the four required Bucket-2 flags', () => {
    const args = buildAuditorSpawnArgs(ARM, REQUIRED_CONTROLS, CONTEXT, DRIVER_ATTEMPT, '/out.json');
    assert.ok(args.includes('--prompt-template-id'));
    assert.ok(args.includes('--output-schema-id'));
    assert.ok(args.includes('--tool-policy'));
    assert.ok(args.includes('--rounds'));
    for (const flag of ['--scope', '--passes', '--reasoning-effort', '--temperature', '--max-output-tokens']) {
      assert.equal(args.includes(flag), false, `${flag} must be omitted when the corresponding dial is absent`);
    }
  });

  it('a present optional dial adds its flag with the exact value', () => {
    const args = buildAuditorSpawnArgs(ARM, { ...REQUIRED_CONTROLS, scope: 'full', reasoningEffort: 'high' }, CONTEXT, DRIVER_ATTEMPT, '/out.json');
    const scopeIdx = args.indexOf('--scope');
    assert.ok(scopeIdx > -1);
    assert.equal(args[scopeIdx + 1], 'full');
    const effortIdx = args.indexOf('--reasoning-effort');
    assert.ok(effortIdx > -1);
    assert.equal(args[effortIdx + 1], 'high');
  });

  it('the four required flags carry the exact controls values, always', () => {
    const args = buildAuditorSpawnArgs(ARM, { ...REQUIRED_CONTROLS, promptTemplateId: 'auditor-tier-c-v1-abc', outputSchemaId: 'auditor-extraction-v1-def', toolPolicy: 'none', rounds: 1 }, CONTEXT, DRIVER_ATTEMPT, '/out.json');
    assert.equal(args[args.indexOf('--prompt-template-id') + 1], 'auditor-tier-c-v1-abc');
    assert.equal(args[args.indexOf('--output-schema-id') + 1], 'auditor-extraction-v1-def');
    assert.equal(args[args.indexOf('--tool-policy') + 1], 'none');
    assert.equal(args[args.indexOf('--rounds') + 1], '1');
  });
});
