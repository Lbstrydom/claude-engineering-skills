/**
 * @fileoverview Field report 2026-09-26 (Streamlit consumer, /persona-test pair
 * mode) — the deterministic halves of four fixes, pure / in-process:
 *
 *  A. `Ready for users` is capped when the stateful-mission lifecycle is not
 *     verified — in code (capPersonaVerdict), not only in SKILL.md prose.
 *  B. `link-persona-pair` exists (SKILL.md Step P7 named it for months).
 *  D. The SKILL.md Phase 6 / Step P7 payloads match the request schemas they
 *     are parsed by — the SKILL sent `browserDriver`/`browserStatus` against a
 *     required `browserTool`, so every documented call failed validation.
 *
 * The prose↔code check compares the KEY SETS of the payload in the SKILL.md
 * fence with the EMITTED JSON schema (`z.toJSONSchema`), in both directions,
 * per AGENTS.md "Contracts across the prose↔code seam".
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { z } from 'zod';
import { dispatch } from '../scripts/lib/cross-skill/dispatch.mjs';
import { argv } from './helpers/cross-skill-argv.mjs';
import {
  RecordPersonaSessionRequestSchema, LinkPersonaPairRequestSchema,
} from '../scripts/lib/cross-skill/commands/persona.mjs';
import {
  capPersonaVerdict, readyForUsersBlockers, LIFECYCLE_STEPS, LifecycleSchema, LIFECYCLE_UNVERIFIED_LABEL,
  SEVERITY_COUNTS_UNREPORTED,
} from '../scripts/lib/persona-test/verdict-eligibility.mjs';
import { derivePairOverlapRate } from '../scripts/lib/persona-test/pair-overlap.mjs';

const SKILL = fs.readFileSync('skills/persona-test/SKILL.md', 'utf8');

const verified = { status: 'verified', unchecked: [] };
const WORK_RECORD = { terminalReason: 'goal-reached', authState: 'n/a-no-auth-encountered', originPolicyResult: 'same-origin-only' };
const clean = { verdict: 'Ready for users', p0Count: 0, p1Count: 0, lifecycle: verified, ...WORK_RECORD };

describe('capPersonaVerdict — the Ready-for-users predicate in code', () => {
  it('a verified lifecycle with no blockers keeps Ready for users', () => {
    assert.deepEqual(capPersonaVerdict(clean), { verdict: 'Ready for users', capped: false, blockers: [], label: null });
  });
  it('not-applicable lifecycle is eligible too (a read-only mission)', () => {
    assert.equal(capPersonaVerdict({ ...clean, lifecycle: { status: 'not-applicable', unchecked: [] } }).capped, false);
  });
  it('THE FIELD CASE: goal reached, 0 P0/P1, lifecycle partial → Needs work, labelled lifecycle-unverified', () => {
    const r = capPersonaVerdict({ ...clean, lifecycle: { status: 'partial', unchecked: ['post-boundary-state', 'retained-history'] } });
    assert.equal(r.verdict, 'Needs work');
    assert.equal(r.capped, true);
    assert.equal(r.label, LIFECYCLE_UNVERIFIED_LABEL);
    assert.match(r.blockers[0], /post-boundary-state, retained-history/);
  });
  it('a MISSING lifecycle is unreported, not verified — capped', () => {
    const { lifecycle, ...noLc } = clean;
    void lifecycle;
    const r = capPersonaVerdict(noLc);
    assert.equal(r.verdict, 'Needs work');
    assert.deepEqual(r.blockers, ['lifecycle=unreported']);
    assert.equal(r.label, null, 'the label claims the goal was reached with state unverified — absent data does not establish that');
  });
  it('names EVERY failing conjunct, and caps on declared P0/P1 too', () => {
    const r = capPersonaVerdict({ ...clean, p1Count: 2, authState: 'auth-wall-untested', terminalReason: 'step-budget-exhausted' });
    assert.deepEqual(r.blockers, ['p0p1=2', 'terminalReason=step-budget-exhausted', 'authState=auth-wall-untested']);
    assert.equal(r.label, null);
  });
  it('never raises a verdict — Needs work / Blocked pass through untouched', () => {
    assert.equal(capPersonaVerdict({ verdict: 'Blocked' }).verdict, 'Blocked');
    assert.equal(capPersonaVerdict({ verdict: 'Needs work', lifecycle: verified }).capped, false);
  });
  it('readyForUsersBlockers is empty exactly when eligible', () => {
    assert.deepEqual(readyForUsersBlockers(clean), []);
  });
});

// Audit H13/H29 — the predicate fails CLOSED on input it cannot read.
describe('readyForUsersBlockers — omitted is not zero, malformed is not verified', () => {
  it('measured 0 P0/P1 passes (the control the next two cases are measured against)', () => {
    assert.deepEqual(readyForUsersBlockers({ ...clean, p0Count: 0, p1Count: 0 }), []);
  });
  it('OMITTED p0Count/p1Count is a blocker, distinct from a measured 0', () => {
    const { p0Count, p1Count, ...noCounts } = clean;
    void p0Count; void p1Count;
    assert.deepEqual(readyForUsersBlockers(noCounts), [SEVERITY_COUNTS_UNREPORTED]);
    const { p1Count: _p1, ...noP1 } = clean;
    void _p1;
    assert.deepEqual(readyForUsersBlockers(noP1), [SEVERITY_COUNTS_UNREPORTED], 'one missing count is enough');
    const r = capPersonaVerdict(noCounts);
    assert.equal(r.verdict, 'Needs work');
    assert.equal(r.label, null, 'unreported counts do not establish "goal reached, lifecycle unverified"');
  });
  it('a non-numeric count is unreported, never coerced to 0', () => {
    for (const bad of ['0', null, NaN, -1, 1.5, 'lots']) {
      assert.deepEqual(readyForUsersBlockers({ ...clean, p0Count: bad }), [SEVERITY_COUNTS_UNREPORTED], `p0Count=${String(bad)}`);
    }
  });
  it('a measured positive count reports the count, not "unreported"', () => {
    assert.deepEqual(readyForUsersBlockers({ ...clean, p0Count: 1, p1Count: 2 }), ['p0p1=3']);
  });
  it('a MALFORMED lifecycle is a blocker — the pre-fix unreported-status / empty-unchecked case', () => {
    for (const lc of [{}, { status: 'done', unchecked: [] }, { unchecked: [] },
      { status: 'partial', unchecked: [] }, { status: 'verified', unchecked: ['command-outcome'] },
      { status: 'partial', unchecked: ['vibes'] }, 'verified', []]) {
      const r = capPersonaVerdict({ ...clean, lifecycle: lc });
      assert.deepEqual(r.blockers, ['lifecycle=invalid'], JSON.stringify(lc));
      assert.equal(r.verdict, 'Needs work');
      assert.equal(r.label, null, 'an unreadable lifecycle does not establish the lifecycle-unverified label');
    }
  });
});

describe('LifecycleSchema — partial must name what it skipped', () => {
  it('partial with no unchecked steps is refused', () => {
    assert.equal(LifecycleSchema.safeParse({ status: 'partial', unchecked: [] }).success, false);
  });
  it('verified carrying unchecked steps is refused', () => {
    assert.equal(LifecycleSchema.safeParse({ status: 'verified', unchecked: ['command-outcome'] }).success, false);
  });
  it('an unknown step id is refused', () => {
    assert.equal(LifecycleSchema.safeParse({ status: 'partial', unchecked: ['vibes'] }).success, false);
  });
  it('every checklist step id is documented in SKILL.md, in the checklist table', () => {
    for (const step of LIFECYCLE_STEPS) {
      assert.ok(SKILL.includes(`| \`${step}\` |`), `SKILL.md checklist is missing step id ${step}`);
    }
  });
});

// ── dispatch-level ─────────────────────────────────────────────────────────

function stubDeps(overrides = {}) {
  return {
    initLearningStore: async () => true,
    isCloudEnabled: async () => true,
    isPersonaCloudEnabled: async () => true,
    resolveRepoForStoreResult: async () => ({ kind: 'resolved', repoRowId: 'repo-1', repoUuid: 'uuid-1', name: 'o/r' }),
    getRepoIdByName: async () => 'repo-1',
    getRepoIdByUuid: async () => ({ id: 'repo-1', name: 'o/r' }),
    listRepoIds: async () => ['repo-1'],
    ...overrides,
  };
}

describe('record-persona-session — the stored verdict is the capped one', () => {
  const base = { persona: 'p', url: 'https://x.test', browserTool: 'playwright (ok)', verdict: 'Ready for users', findings: [], p0Count: 0, p1Count: 0, ...WORK_RECORD };

  it('a partial lifecycle reaches the store as Needs work and the envelope says so', async () => {
    let stored = null;
    const deps = stubDeps({
      recordPersonaSession: async (s) => { stored = s; return { ok: true, cloud: true, sessionId: 'row-1', existed: false, statsUpdated: false, statsReason: 'no-persona-id' }; },
    });
    const payload = JSON.stringify({ ...base, lifecycle: { status: 'partial', unchecked: ['retained-history'] } });
    const r = await dispatch(argv('record-persona-session', '--json', payload), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.envelope));
    assert.equal(stored.verdict, 'Needs work');
    assert.equal(r.envelope.verdictCap.claimed, 'Ready for users');
    assert.equal(r.envelope.verdictCap.stored, 'Needs work');
    assert.equal(r.envelope.verdictCap.label, LIFECYCLE_UNVERIFIED_LABEL);
    assert.equal(r.envelope.statsReason, 'no-persona-id', 'statsUpdated:false must carry its reason through the envelope');
  });

  it('a verified lifecycle stores Ready for users with no verdictCap', async () => {
    let stored = null;
    const deps = stubDeps({
      recordPersonaSession: async (s) => { stored = s; return { ok: true, cloud: true, sessionId: 'row-1', existed: false, statsUpdated: true, statsReason: null }; },
    });
    const payload = JSON.stringify({ ...base, lifecycle: verified, terminalReason: 'goal-reached' });
    const r = await dispatch(argv('record-persona-session', '--json', payload), { deps, cloudGate: 'ready' });
    assert.equal(stored.verdict, 'Ready for users');
    assert.equal('verdictCap' in r.envelope, false);
  });

  it('a MALFORMED lifecycle is refused at the boundary — never stored as Ready for users (H13/H29)', async () => {
    let stored = null;
    const deps = stubDeps({
      recordPersonaSession: async (s) => { stored = s; return { ok: true, cloud: true, sessionId: 'row-1', existed: false, statsUpdated: true, statsReason: null }; },
    });
    const payload = JSON.stringify({ ...base, lifecycle: { status: 'done' }, terminalReason: 'goal-reached' });
    const r = await dispatch(argv('record-persona-session', '--json', payload), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 2, JSON.stringify(r.envelope));
    assert.equal(r.envelope.error.code, 'BAD_INPUT');
    assert.equal(stored, null);
  });

  it('OMITTED counts still write the session — capped with the unreported blocker (H13/H29)', async () => {
    let stored = null;
    const deps = stubDeps({
      recordPersonaSession: async (s) => { stored = s; return { ok: true, cloud: true, sessionId: 'row-1', existed: false, statsUpdated: true, statsReason: null }; },
    });
    const { p0Count, p1Count, ...noCounts } = base;
    void p0Count; void p1Count;
    const payload = JSON.stringify({ ...noCounts, lifecycle: verified, terminalReason: 'goal-reached' });
    const r = await dispatch(argv('record-persona-session', '--json', payload), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.envelope));
    assert.equal(stored.verdict, 'Needs work');
    assert.deepEqual(r.envelope.verdictCap.blockers, [SEVERITY_COUNTS_UNREPORTED]);
  });
});

describe('link-persona-pair', () => {
  const A = 'a4969127-d5d0-47bb-8b2e-0acb0ed71546';
  const B = 'b4969127-d5d0-47bb-8b2e-0acb0ed71546';
  const payload = (over = {}) => JSON.stringify({ sessionA: A, sessionB: B, consensusCount: 1, aOnlyCount: 5, bOnlyCount: 6, ...over });

  it('writes through the store with the resolved repo scope and returns the pair id', async () => {
    let call = null;
    const deps = stubDeps({
      recordPersonaPairLink: async (p, opts) => { call = { p, opts }; return { ok: true, cloud: true, pairId: 'pair-1', overlapRate: 0.0833 }; },
    });
    const r = await dispatch(argv('link-persona-pair', '--json', payload()), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.envelope));
    assert.deepEqual(r.envelope, { ok: true, cloud: true, pairId: 'pair-1', overlapRate: 0.0833 });
    assert.equal(call.p.sessionA, A);
    assert.equal(call.opts.repoId, 'repo-1');
  });

  for (const [reason, code] of [['session-not-found', 'PARENT_NOT_FOUND'], ['cross-repo-pair', 'PARENT_NOT_OWNED'], ['session-not-owned', 'PARENT_NOT_OWNED'], ['write-failed', 'WRITE_FAILED']]) {
    it(`a ${reason} refusal exits 1 as ${code}`, async () => {
      const deps = stubDeps({
        recordPersonaPairLink: async () => ({ ok: false, cloud: true, pairId: null, overlapRate: 0.0833, reason, message: reason }),
      });
      const r = await dispatch(argv('link-persona-pair', '--json', payload()), { deps, cloudGate: 'ready' });
      assert.equal(r.exitCode, 1);
      assert.equal(r.envelope.error.code, code);
    });
  }

  it('refuses the same session twice before touching the store', async () => {
    const deps = stubDeps({ recordPersonaPairLink: async () => { throw new Error('must not be called'); } });
    const r = await dispatch(argv('link-persona-pair', '--json', payload({ sessionB: A })), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 2);
    assert.equal(r.envelope.error.code, 'BAD_INPUT');
  });

  it('accepts a caller rate that matches the counts to the printed precision', async () => {
    const deps = stubDeps({ recordPersonaPairLink: async () => ({ ok: true, cloud: true, pairId: 'p', overlapRate: 0.0833 }) });
    const r = await dispatch(argv('link-persona-pair', '--json', payload({ overlapRate: 0.08 })), { deps, cloudGate: 'ready' });
    assert.equal(r.exitCode, 0, JSON.stringify(r.envelope));
  });

  it('derivePairOverlapRate is consensus / total, 0 for an empty pair', () => {
    assert.equal(derivePairOverlapRate({ consensusCount: 1, aOnlyCount: 5, bOnlyCount: 6 }), 0.0833);
    assert.equal(derivePairOverlapRate({ consensusCount: 0, aOnlyCount: 0, bOnlyCount: 0 }), 0);
  });
});

// ── prose ↔ code ───────────────────────────────────────────────────────────

/** Top-level keys of the first `<command> --json '{…}'` fence in SKILL.md. */
function proseKeys(command) {
  const start = SKILL.indexOf(`cross-skill.mjs ${command} --json '{`);
  assert.ok(start >= 0, `SKILL.md has no ${command} --json payload`);
  const open = SKILL.indexOf('{', start);
  let depth = 0; let i = open; const keys = [];
  for (; i < SKILL.length; i += 1) {
    const ch = SKILL[i];
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') { depth -= 1; if (depth === 0) break; }
    else if (ch === '"' && depth === 1) {
      const m = /^"(\w+)"\s*:/.exec(SKILL.slice(i));
      if (m) { keys.push(m[1]); i += m[0].length - 1; continue; }
      const end = SKILL.indexOf('"', i + 1);
      i = end;
    }
  }
  return keys;
}

function emitted(schema) {
  const js = z.toJSONSchema(schema, { io: 'input' });
  return { props: Object.keys(js.properties ?? {}), required: js.required ?? [] };
}

describe('prose↔code: the SKILL.md payloads match the schemas that parse them', () => {
  for (const [command, schema] of [['record-persona-session', RecordPersonaSessionRequestSchema], ['link-persona-pair', LinkPersonaPairRequestSchema]]) {
    it(`${command}: every documented key exists in the schema, and every required key is documented`, () => {
      const keys = proseKeys(command);
      const { props, required } = emitted(schema);
      assert.ok(keys.length > 3, `parsed too few keys from the ${command} fence (${keys.join(',')}) — instrument broken`);
      const unknown = keys.filter((k) => !props.includes(k));
      assert.deepEqual(unknown, [], `SKILL.md sends keys the schema silently strips: ${unknown.join(', ')}`);
      const undocumented = required.filter((k) => !keys.includes(k));
      assert.deepEqual(undocumented, [], `schema requires keys SKILL.md never sends: ${undocumented.join(', ')}`);
    });
  }

  it('NEGATIVE CONTROL: the pre-fix payload (browserDriver/browserStatus) fails the same comparison', () => {
    const { props, required } = emitted(RecordPersonaSessionRequestSchema);
    const preFix = ['persona', 'url', 'focus', 'browserDriver', 'browserStatus', 'stepsTaken', 'verdict'];
    assert.ok(preFix.some((k) => !props.includes(k)), 'browserDriver must be unknown to the schema');
    assert.ok(required.some((k) => !preFix.includes(k)), 'browserTool must be required and absent from the old payload');
    assert.equal(RecordPersonaSessionRequestSchema.safeParse({
      persona: 'p', url: 'https://x.test', browserDriver: 'playwright', browserStatus: 'ok', verdict: 'Needs work',
    }).success, false);
  });
});

// R2 M7: the three work-record conjuncts are required for Ready for users.
describe('work-record fields are required, not optional-and-passing', () => {
  for (const k of ['terminalReason', 'authState', 'originPolicyResult']) {
    it(`an omitted ${k} caps Ready for users`, () => {
      const s = { ...clean };
      delete s[k];
      const r = capPersonaVerdict(s);
      assert.equal(r.capped, true);
      assert.ok(readyForUsersBlockers(s).includes(`${k}=unreported`));
    });
  }
  it('control: all three present and passing keeps Ready for users', () => {
    assert.equal(capPersonaVerdict(clean).capped, false);
  });
});
