/**
 * @fileoverview Eligibility + readiness rules for the final-reviewer bake-off.
 *
 * The load-bearing cases are the ones that keep the window HONEST, because the
 * failure this guards against is not a crash — it is a window that reads "met"
 * when it isn't. That exact failure happened five times on the tiered-shadow
 * collector before readiness was made mechanical.
 *
 * @module tests/final-review-bakeoff
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findEligibleTranscripts, assessWindow } from '../scripts/final-review-bakeoff.mjs';
import {
  zeroFindingArms, isComplete, summarise, CONTRACT_EPOCH, buildArmArgs, EXPERIMENT_TAG,
  distinctFindingCount, shadowFindingTotal, armCostUsd,
  LEGACY_ARMS, transportForModel, deriveArms, armRequestFingerprint,
  classifyArmCollisions, computeCollectLock, resolveArms,
} from '../scripts/bakeoff-collect.mjs';
import { parseCampaignConfig } from '../scripts/lib/campaign/config.mjs';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import nodeOs from 'node:os';

/** Build an injectable fake FS for the pure enumerator. */
function io(files, existingPlans = []) {
  return {
    readdir: () => Object.keys(files),
    readFile: (p) => files[p.split(/[\\/]/).pop()],
    exists: (p) => existingPlans.includes(p),
  };
}

const codeTranscript = (plan) => JSON.stringify({ mode: 'code', plan, rounds: [{ round: 1 }] });

describe('findEligibleTranscripts', () => {
  it('accepts a code-mode transcript whose plan still exists', () => {
    const { eligible } = findEligibleTranscripts('.audit',
      io({ 'a-transcript.json': codeTranscript('docs/plans/p.md') }, ['docs/plans/p.md']));
    assert.equal(eligible.length, 1);
    assert.equal(eligible[0].plan, 'docs/plans/p.md');
    assert.equal(eligible[0].rounds, 1);
  });

  it('rejects plan-mode transcripts — a different prompt path, not a thin sample', () => {
    const { eligible, rejected } = findEligibleTranscripts('.audit',
      io({ 'p-transcript.json': JSON.stringify({ mode: 'plan', plan: 'docs/plans/p.md' }) }, ['docs/plans/p.md']));
    assert.equal(eligible.length, 0);
    assert.match(rejected[0].why, /mode=plan/);
  });

  it('rejects a transcript whose plan file has since been deleted', () => {
    // Counting an unreplayable transcript inflates readiness against inputs
    // that cannot actually run — the window would "fill" with dead entries.
    const { eligible, rejected } = findEligibleTranscripts('.audit',
      io({ 'a-transcript.json': codeTranscript('docs/plans/gone.md') }, []));
    assert.equal(eligible.length, 0);
    assert.match(rejected[0].why, /plan missing/);
  });

  it('rejects unparseable transcripts instead of throwing', () => {
    const { eligible, rejected } = findEligibleTranscripts('.audit',
      io({ 'bad-transcript.json': '{not json' }));
    assert.equal(eligible.length, 0);
    assert.equal(rejected[0].why, 'unparseable');
  });

  it('ignores non-transcript files in .audit/', () => {
    const { eligible, rejected } = findEligibleTranscripts('.audit',
      io({ 'session-ledger.json': '{}', 'bandit-state.json': '{}' }));
    assert.equal(eligible.length, 0);
    assert.equal(rejected.length, 0, 'unrelated files are not "rejected", they are out of scope');
  });

  it('is deterministic in ordering', () => {
    const files = { 'c-transcript.json': codeTranscript('p.md'), 'a-transcript.json': codeTranscript('p.md'), 'b-transcript.json': codeTranscript('p.md') };
    const names = findEligibleTranscripts('.audit', io(files, ['p.md'])).eligible.map((e) => e.name);
    assert.deepEqual(names, ['a-transcript.json', 'b-transcript.json', 'c-transcript.json']);
  });
});

describe('assessWindow', () => {
  it('is not ready below target', () => {
    const w = assessWindow(new Array(7), 8);
    assert.equal(w.ready, false);
    assert.match(w.verdict, /^COLLECTING — 7\/8/);
  });

  it('is ready at exactly the target', () => {
    const w = assessWindow(new Array(8), 8);
    assert.equal(w.ready, true);
    assert.match(w.verdict, /^READY/);
  });

  it('READY tells the operator to adjudicate in the same sitting', () => {
    // The stopping rule is half the point: a filled window left unadjudicated
    // is exactly how the previous experiment became unreadable.
    assert.match(assessWindow(new Array(10), 8).verdict, /adjudicate in the same sitting/);
  });

  it('an EMPTY corpus is never ready — no vacuous green', () => {
    const w = assessWindow([], 8);
    assert.equal(w.ready, false);
    assert.equal(w.count, 0);
  });
});

describe('zeroFindingArms (bakeoff-collect)', () => {
  const armEntry = (over) => ({ shadowState: 'ran', buckets: { shadowOnly: 0 }, ...over });

  it('an arm with findings is never listed — this is about ZEROES only', () => {
    const e = { arms: { opus: armEntry({ buckets: { shadowOnly: 4 }, shadowVerdict: 'APPROVE' }), kimi: armEntry({ shadowVerdict: 'APPROVE' }) } };
    assert.deepEqual(zeroFindingArms(e).map((z) => z.arm), ['kimi']);
  });

  it('zero findings WITH a verdict reads as reviewed — a lenient model, not a broken arm', () => {
    const e = { arms: { opus: armEntry({ buckets: { shadowOnly: 1 } }), kimi: armEntry({ shadowVerdict: 'APPROVE' }) } };
    assert.deepEqual(zeroFindingArms(e), [{ arm: 'kimi', verdict: 'APPROVE', evidence: 'reviewed' }]);
  });

  it('zero findings with a RECORDED-but-empty verdict reads as no-verdict — suspect the arm', () => {
    const e = { arms: { kimi: armEntry({ shadowVerdict: null }) } };
    assert.deepEqual(zeroFindingArms(e), [{ arm: 'kimi', verdict: null, evidence: 'no-verdict' }]);
  });

  it('an ABSENT shadowVerdict key is `unrecorded`, NOT `no-verdict`', () => {
    // The campaign's own first three snapshots predate the field. Collapsing
    // absent into null would report them as broken arms and invite a re-run of
    // three snapshots that were fine.
    const e = { arms: { kimi: armEntry({}) } };
    assert.deepEqual(zeroFindingArms(e), [{ arm: 'kimi', verdict: undefined, evidence: 'unrecorded' }]);
  });

  it('an arm that did not RUN is not a zero-finding arm at all', () => {
    const e = { arms: { kimi: { shadowState: 'skipped-no-key', buckets: null } } };
    assert.deepEqual(zeroFindingArms(e), []);
  });
});

describe('contract epoch + solo arm (bakeoff-collect isComplete)', () => {
  const ran = (over) => ({ shadowState: 'ran', buckets: { shadowOnly: 1 }, primaryVerdict: 'CONCERNS', ...over });
  const full = (over = {}) => ({
    contractEpoch: CONTRACT_EPOCH,
    arms: { opus: ran(), kimi: ran(), 'solo-opus': { primaryVerdict: 'APPROVE' }, ...over },
  });

  it('a fully-populated current-epoch snapshot counts', () => {
    assert.equal(isComplete(full()), true);
  });

  it('an UNSTAMPED entry never counts, however complete it looks', () => {
    // The e1 rows are exactly this shape. Counting them would compare arms that
    // ran at three different reasoning depths and call it a model result.
    const e = full();
    delete e.contractEpoch;
    assert.equal(isComplete(e), false);
  });

  it('a STALE epoch never counts — and is not silently upgraded', () => {
    assert.equal(isComplete({ ...full(), contractEpoch: 'e1-unmatched' }), false);
  });

  it('the solo arm is judged on its primary verdict, not on shadowState', () => {
    // It runs Opus as primary with no shadow; requiring shadowState==='ran'
    // would make every snapshot permanently incomplete.
    assert.equal(isComplete(full({ 'solo-opus': { primaryVerdict: 'REJECT', shadowState: null } })), true);
    assert.equal(isComplete(full({ 'solo-opus': { primaryVerdict: null } })), false);
  });

  it('an arm that ERRORED fails the snapshot even under the right epoch', () => {
    assert.equal(isComplete(full({ kimi: { error: 'exit 1' } })), false);
  });

  it('a missing arm fails the snapshot — absence is never treated as a pass', () => {
    const e = full();
    delete e.arms.kimi;
    assert.equal(isComplete(e), false);
  });

  it('the solo arm is excluded from zero-finding reporting (it has no shadow bucket)', () => {
    const z = zeroFindingArms(full({ opus: ran({ buckets: { shadowOnly: 0 }, shadowVerdict: 'APPROVE' }) }));
    assert.deepEqual(z.map((x) => x.arm), ['opus']);
  });
});

describe('counting rules shared by the two Opus samples', () => {
  it('distinctFindingCount dedups by _hash, so a primary is counted the shadow’s way', () => {
    // The shadow is deduped before bucketing; the primary is written raw.
    // Comparing the two un-normalised reports a dedup difference as model variance.
    assert.equal(distinctFindingCount([{ _hash: 'a' }, { _hash: 'b' }, { _hash: 'a' }]), 2);
  });

  it('an UNHASHED finding is never collapsed away', () => {
    // Same rule as dedupByHash's semanticId fallback: silent data loss here
    // would understate a reviewer's output and read as agreement.
    assert.equal(distinctFindingCount([{}, {}, {}]), 3);
  });

  it('absent / non-array findings are 0, not a throw', () => {
    for (const v of [null, undefined, 'nope']) assert.equal(distinctFindingCount(v), 0);
  });

  it('shadowFindingTotal is both + shadowOnly — the shadow’s whole deduped set', () => {
    assert.equal(shadowFindingTotal({ buckets: { both: 2, shadowOnly: 5, primaryOnly: 9 } }), 7);
  });

  it('a shadow that did not run is null, NEVER 0', () => {
    // 0 would mean "reviewed and found nothing"; null means "no measurement".
    // Collapsing them is the anti-green failure this campaign already hit.
    for (const v of [{ buckets: null }, {}, null, undefined, { buckets: { both: 1 } }]) {
      assert.equal(shadowFindingTotal(v), null);
    }
  });
});

describe('armCostUsd — spend is measured, never partially guessed', () => {
  const opusCall = { _model: 'claude-opus-5', _usage: { input_tokens: 1_000_000, output_tokens: 0 } };

  it('sums the primary and shadow calls an arm makes', () => {
    const both = armCostUsd({
      ...opusCall,
      _shadow: { model: 'claude-opus-5', usage: { input_tokens: 1_000_000, output_tokens: 0 } },
    });
    const one = armCostUsd(opusCall);
    assert.equal(both.usd, one.usd * 2);
  });

  it('prices cached tokens rather than reading a cache hit as free', () => {
    const hit = armCostUsd({ _model: 'claude-opus-5', _usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 } });
    assert.ok(hit.usd > 0);
  });

  it('an UNPRICED call yields null for the arm, not a partial sum', () => {
    // A partial sum is worse than none: it reads as a complete figure, and the
    // arm silently looks cheaper than every arm it is compared against.
    const r = armCostUsd({ ...opusCall, _shadow: { model: 'not-a-real-model-xyz', usage: { input_tokens: 1000, output_tokens: 1 } } });
    assert.equal(r.usd, null);
    assert.deepEqual(r.unpricedModels, ['not-a-real-model-xyz']);
  });

  it('an arm with no usage at all is null, never 0', () => {
    assert.equal(armCostUsd({}).usd, null);
    assert.equal(armCostUsd({ _model: 'claude-opus-5' }).usd, null, 'a model with no usage is not a free call');
  });

  it('a PARTIALLY-metered arm is null, not a confident subtotal (audit R1 H2)', () => {
    // The discriminating case the two tests above miss: the primary call is
    // fully metered, so `calls` is non-empty and a total gets computed — while
    // the shadow call, which really happened, was dropped by the old
    // `c.model && c.usage` filter before pricing. The arm then published the
    // primary's cost as if it were the whole spend.
    for (const [label, shadow] of [
      ['no usage key', { model: 'claude-opus-5' }],
      ['empty usage', { model: 'claude-opus-5', usage: {} }],
      ['one-sided usage', { model: 'claude-opus-5', usage: { input_tokens: 1000 } }],
    ]) {
      const r = armCostUsd({ ...opusCall, _shadow: shadow });
      assert.equal(r.usd, null, `${label}: an unmeterable shadow call must void the arm total`);
      assert.deepEqual(r.unpricedModels, ['claude-opus-5'], `${label}: the unmeterable call is named`);
    }
    // a fully-metered shadow is still summed normally
    assert.ok(armCostUsd({ ...opusCall, _shadow: { model: 'claude-opus-5', usage: { input_tokens: 1000, output_tokens: 1 } } }).usd > 0);
  });
});

describe('summarise surfaces every arm (bakeoff-collect)', () => {
  const ran = (shadowOnly, primaryFindings) => ({
    shadowState: 'ran', shadowVerdict: 'CONCERNS', buckets: { shadowOnly }, primaryVerdict: 'CONCERNS', primaryFindings,
  });
  const snap = (id, opusUnique, kimiUnique, p1, p2, solo) => ({
    snapshotId: id, contractEpoch: CONTRACT_EPOCH,
    arms: { opus: ran(opusUnique, p1), kimi: ran(kimiUnique, p2), 'solo-opus': { primaryVerdict: 'CONCERNS', primaryFindings: solo } },
  });

  it('the solo arm contributes its PRIMARY findings, never a shadow bucket it does not have', () => {
    const s = summarise([snap('a', 7, 1, 2, 4, 7)], 12);
    assert.equal(s.totals.soloFindings, 7);
    assert.equal(s.totals.opusUnique, 7);
    assert.equal(s.totals.kimiUnique, 1);
  });

  it('primary self-divergence is the per-snapshot |P1 - P2| spread', () => {
    // Same primary model, same transcript, two runs. This is §0.4's
    // "is a 2nd reviewer just a reroll?" question, and it is free to collect.
    const s = summarise([snap('a', 7, 1, 2, 4, 7), snap('b', 3, 2, 5, 5, 3)], 12);
    assert.deepEqual(s.totals.primaryDivergence, [2, 0]);
  });

  it('Opus self-divergence pairs the shadow sample against the solo sample', () => {
    // Both arms issue a byte-identical request, so the spread is Opus's own
    // variance — the number that decides whether solo-opus buys a role
    // comparison or a reroll.
    const e = {
      snapshotId: 'a', contractEpoch: CONTRACT_EPOCH,
      arms: {
        opus: { ...ran(5, 2), buckets: { both: 0, shadowOnly: 5 } },
        kimi: ran(1, 2),
        'solo-opus': { primaryVerdict: 'CONCERNS', primaryFindings: 4, primaryDistinct: 4 },
      },
    };
    assert.deepEqual(summarise([e], 12).totals.opusDivergence, [1]);
    assert.equal(summarise([e], 12).totals.opusDivergenceUnpaired, 0);
  });

  it('a missing Opus sample is UNPAIRED, never scored as zero divergence', () => {
    // Zero would assert Opus agreed with itself perfectly — the strongest claim
    // available, from the one state that cannot support any claim. Entries
    // predating `primaryDistinct` land here, which is why it is counted and
    // printed rather than silently dropped.
    const e = {
      snapshotId: 'a', contractEpoch: CONTRACT_EPOCH,
      arms: {
        opus: { ...ran(5, 2), buckets: { both: 0, shadowOnly: 5 } },
        kimi: ran(1, 2),
        'solo-opus': { primaryVerdict: 'CONCERNS', primaryFindings: 4 }, // no primaryDistinct
      },
    };
    const s = summarise([e], 12);
    assert.deepEqual(s.totals.opusDivergence, []);
    assert.equal(s.totals.opusDivergenceUnpaired, 1);
  });

  it('arms sharing a request fingerprint are reported as a REROLL, not two configurations', () => {
    // The finding this instrument exists for: `opus` and `solo-opus` issue a
    // byte-identical Anthropic request, so a gap between them is sampling noise
    // plus a bucketing convention. Establishing that once took reading the
    // shadow orchestration and cross-checking token counts across five files.
    const e = {
      snapshotId: 'a', contractEpoch: CONTRACT_EPOCH,
      arms: {
        opus: { ...ran(5, 2), requestFingerprints: ['geminiFP', 'opusFP'] },
        kimi: { ...ran(1, 2), requestFingerprints: ['geminiFP', 'kimiFP'] },
        'solo-opus': { primaryVerdict: 'CONCERNS', primaryFindings: 4, requestFingerprints: ['opusFP'] },
      },
    };
    const pairs = summarise([e], 12).totals.rerollPairs;
    assert.ok(pairs.includes('opus=solo-opus'), 'the identical Opus request must be surfaced');
    assert.ok(pairs.includes('opus=kimi'), 'both arms also run the same Gemini primary');
  });

  it('MISSING fingerprints read as unknown, never as "these arms differ"', () => {
    // Entries predating the field must not silently certify that every arm is
    // distinct — the strongest reading available from no evidence at all.
    const e = {
      snapshotId: 'a', contractEpoch: CONTRACT_EPOCH,
      arms: { opus: ran(5, 2), kimi: ran(1, 2), 'solo-opus': { primaryVerdict: 'CONCERNS', primaryFindings: 4 } },
    };
    assert.deepEqual(summarise([e], 12).totals.rerollPairs, []);
  });

  it('an arm with an unpriced call makes that ARM null, and flags the snapshot', () => {
    const e = {
      snapshotId: 'a', contractEpoch: CONTRACT_EPOCH,
      arms: {
        opus: { ...ran(5, 2), costUsd: 2.5 },
        kimi: { ...ran(1, 2), costUsd: null },
        'solo-opus': { primaryVerdict: 'CONCERNS', primaryFindings: 4, costUsd: 2.3 },
      },
    };
    const t = summarise([e], 12).totals;
    assert.equal(t.costByArm.opus, 2.5);
    assert.equal(t.costByArm.kimi, null, 'an unpriced arm shows null, not the sum of its priced snapshots');
    assert.equal(t.costUncostedSnapshots, 1);
  });

  it('an INCOMPLETE snapshot contributes to no total — not even a partial one', () => {
    const bad = snap('c', 9, 9, 9, 9, 9);
    delete bad.contractEpoch; // stale-epoch row
    const s = summarise([bad], 12);
    assert.equal(s.complete, 0);
    assert.equal(s.totals.opusUnique, 0);
    assert.equal(s.totals.soloFindings, 0);
    assert.deepEqual(s.totals.primaryDivergence, []);
  });
});

describe('cloud run wiring (bakeoff-collect buildArmArgs)', () => {
  const arm = { id: 'kimi', args: ['--provider', 'openrouter'] };
  const ctx = { transcript: 't.json', plan: 'p.md', mode: 'code', out: 'o.json' };

  it('threads --run-id so the final-review cloud write is armed', () => {
    // `runShadowAndPersist` bails at `if (!runId) return`, so omitting this
    // makes the ENTIRE persist a silent no-op — snapshots 2-3 of this campaign
    // reached the store with final_review_shadow_model NULL and zero findings
    // for exactly this reason, leaving nothing to adjudicate.
    const args = buildArmArgs(arm, { ...ctx, runId: 'run-abc' });
    const i = args.indexOf('--run-id');
    assert.notEqual(i, -1, '--run-id absent — the cloud write would be a no-op');
    assert.equal(args[i + 1], 'run-abc');
  });

  it('OMITS --run-id when registration failed, never passing a blank', () => {
    // A trailing `--run-id` with no value (or an empty string) is consumed as
    // the flag's VALUE by the argv parser and writes nowhere — the same silence
    // as omitting it, but harder to see.
    for (const runId of [null, undefined, '']) {
      const args = buildArmArgs(arm, { ...ctx, runId });
      assert.equal(args.includes('--run-id'), false, `blank run-id leaked for ${JSON.stringify(runId)}`);
    }
  });

  it('keeps the arm\u2019s own provider flags intact alongside the run id', () => {
    const args = buildArmArgs(arm, { ...ctx, runId: 'r1' });
    assert.ok(args.includes('--provider') && args.includes('openrouter'));
    assert.equal(args[args.indexOf('--mode') + 1], 'code');
  });

  it('tags every minted run as an experiment, so per-run rates can exclude it', () => {
    // The campaign quotes "~1.1 accepted HIGH/MED per RUN" — a rate whose
    // denominator is COUNT(*) over audit_runs. Replays are not audits; an
    // untagged replay deflates the rate it is being compared against.
    assert.equal(EXPERIMENT_TAG, 'final-review-bakeoff');
  });
});

// ── Phase 2: arms derived from the campaign config ────────────────────────
// docs/plans/model-comparison-campaigns.md §7b Phase 2, D4.

const REAL_CAMPAIGN = JSON.parse(nodeFs.readFileSync('.campaigns/final-review-2026q3.json', 'utf-8'));
const campaign = () => parseCampaignConfig(JSON.parse(JSON.stringify(REAL_CAMPAIGN))).config;
const tmpDir = (tag) => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), tag));

describe('deriveArms — the refactor must change no request', () => {
  it('the derived arms are BYTE-IDENTICAL to the hardcoded table they replace', () => {
    // This is the whole safety argument for Phase 2. `ARMS` was a frozen table
    // whose env/args decide what is actually sent, so deriving it from a config
    // is only safe if the wire shape is unchanged — and "unchanged" has to mean
    // key-for-key, not "looks equivalent".
    const derived = deriveArms(campaign());
    assert.equal(derived.length, LEGACY_ARMS.length);
    for (const [i, legacy] of LEGACY_ARMS.entries()) {
      const got = derived[i];
      assert.equal(got.id, legacy.id, `arm ${i} id`);
      assert.deepEqual(got.env, legacy.env, `arm ${legacy.id} env must match key-for-key`);
      assert.deepEqual(got.args ?? undefined, legacy.args ?? undefined, `arm ${legacy.id} args`);
      assert.equal(got.solo ?? undefined, legacy.solo ?? undefined, `arm ${legacy.id} solo`);
      // env key ORDER too: the spawn env is how a reader diffs two runs, and a
      // reordered object reads as a change.
      assert.equal(JSON.stringify(got.env), JSON.stringify(legacy.env), `arm ${legacy.id} env key order`);
    }
  });

  it('preserves DECLARATION order — the two Opus arms stay adjacent', () => {
    // Order is not cosmetic: adjacency keeps the second identical Opus prompt
    // inside the 5-minute cache TTL. Sorting for tidiness would change no
    // request and no result, only whether that send is billed at 1.0x or 0.1x.
    assert.deepEqual(deriveArms(campaign()).map((a) => a.id), ['opus', 'solo-opus', 'kimi']);
    const reordered = campaign();
    reordered.arms = [reordered.arms[2], reordered.arms[0], reordered.arms[1]];
    assert.deepEqual(deriveArms(reordered).map((a) => a.id), ['kimi', 'opus', 'solo-opus'], 'config order is the run order, verbatim');
  });

  it('a primary arm runs with NO shadow, blanked explicitly rather than omitted', () => {
    const solo = deriveArms(campaign()).find((a) => a.id === 'solo-opus');
    assert.equal(solo.solo, true);
    assert.deepEqual(solo.args, ['--provider', 'claude-opus']);
    assert.equal(solo.env.FINAL_REVIEW_SHADOW, '', 'an arm must be a function of the config, never of the ambient environment');
    assert.ok('FINAL_REVIEW_SHADOW' in solo.env, 'blanked, not absent — an absent var inherits whatever the operator exported');
  });

  it('marks declared replicates so model-level metrics can exclude them', () => {
    assert.deepEqual(deriveArms(campaign()).filter((a) => a.replicate).map((a) => a.id), ['solo-opus']);
  });
});

describe('transportForModel — the HOW the config deliberately does not express', () => {
  it('classifies each family onto its wire shape', () => {
    assert.equal(transportForModel('claude-opus').route, 'anthropic');
    assert.equal(transportForModel('claude-opus').promptCache, '1', 'cache multipliers are an Anthropic-only feature');
    assert.equal(transportForModel('moonshotai/kimi-k2-thinking').route, 'openrouter');
    assert.equal(transportForModel('moonshotai/kimi-k2-thinking').shadowModel, 'moonshotai/kimi-k2-thinking');
    assert.equal(transportForModel('gemini-pro-latest').route, 'gemini');
  });

  it('a concrete Claude model rides in SHADOW_MODEL; the bare family token does not', () => {
    assert.equal(transportForModel('claude-opus').shadowModel, null, 'omitted so the derived arm stays byte-identical');
    assert.equal(transportForModel('claude-opus-5').shadowModel, 'claude-opus-5');
  });

  it('REFUSES an unknown family instead of guessing a token', () => {
    // A fabricated FINAL_REVIEW_SHADOW value does not fail here — it fails
    // inside a spawned reviewer, after the arm is counted as attempted.
    for (const bad of ['llama-3', 'mistral-large', '', null]) {
      assert.throws(() => transportForModel(bad), /no transport for model|must be a non-empty string/);
    }
  });
});

describe('D4 — rerolls are classified before spend, never discovered after', () => {
  it('detects that opus and solo-opus send an IDENTICAL request', () => {
    const fps = classifyArmCollisions(campaign()).fingerprints;
    assert.equal(fps.opus, fps['solo-opus'], 'shadow-vs-primary is not a difference in the REQUEST');
    assert.notEqual(fps.opus, fps.kimi);
  });

  it('permits the collision BECAUSE solo-opus is a declared replicate', () => {
    assert.equal(classifyArmCollisions(campaign()).ok, true);
  });

  it('REFUSES an undeclared duplicate — a reroll masquerading as a comparison', () => {
    const cfg = campaign();
    delete cfg.arms.find((a) => a.id === 'solo-opus').type;
    const r = classifyArmCollisions(cfg);
    assert.equal(r.ok, false);
    assert.match(r.message, /IDENTICAL request/);
    assert.match(r.message, /solo-opus/);
    assert.match(r.message, /Refusing before spend/);
  });

  it('the fingerprint keys on the request, not on ids or mode', () => {
    const cfg = campaign();
    const before = armRequestFingerprint(cfg.arms[0], cfg.controls);
    assert.equal(armRequestFingerprint({ ...cfg.arms[0], id: 'renamed', mode: 'primary' }, cfg.controls), before,
      'renaming an arm or flipping its mode does not change what is sent');
    assert.notEqual(armRequestFingerprint(cfg.arms[0], { ...cfg.controls, reasoningEffort: 'low' }), before,
      'a control dial DOES change what is sent');
  });
});

describe('collect-time lock', () => {
  it('changes when resolved reality changes, and is honest about what it can see', () => {
    const cfg = campaign();
    const arms = deriveArms(cfg);
    const base = computeCollectLock(cfg, 'cfgdigest00000000', arms);
    assert.match(base.lockDigest, /^[0-9a-f]{16}$/);
    // The stated limitation is carried in the record, not buried in a comment:
    // this lock sees a DECLARED template change, not an undeclared edit to the
    // template body (assembled inside gemini-review — Cluster B's).
    assert.equal(base.promptTemplateSource, 'declared-id');

    const swapped = { ...cfg, adjudicator: { ...cfg.adjudicator, model: 'latest-sonnet' } };
    assert.notEqual(computeCollectLock(swapped, 'cfgdigest00000000', arms).lockDigest, base.lockDigest);
    assert.notEqual(computeCollectLock(cfg, 'DIFFERENT0000000', arms).lockDigest, base.lockDigest);
    const effort = { ...cfg, controls: { ...cfg.controls, reasoningEffort: 'low' } };
    assert.notEqual(computeCollectLock(effort, 'cfgdigest00000000', arms).lockDigest, base.lockDigest);
  });
});

describe('resolveArms — selection is a refusal, never a silent fallback', () => {
  it('derives from the committed campaign when one exists', () => {
    const r = resolveArms({});
    assert.equal(r.source, 'campaign:final-review-2026q3');
    assert.equal(r.arms.length, 3);
    assert.ok(r.lock.lockDigest);
  });

  it('falls back to the legacy table only when NO campaign exists', () => {
    const r = resolveArms({ dir: tmpDir('no-campaigns-') });
    assert.equal(r.source, 'legacy-table');
    assert.deepEqual(r.arms, LEGACY_ARMS, 'a repo that never adopted campaigns collects exactly as before');
    assert.equal(r.config, null);
  });

  it('THROWS on ambiguity rather than falling back or picking one', () => {
    // Falling back to the legacy table here would run a DIFFERENT comparison
    // than either declared campaign, silently.
    const dir = tmpDir('two-campaigns-');
    const a = campaign(); a.id = 'alpha';
    const b = campaign(); b.id = 'beta';
    nodeFs.writeFileSync(nodePath.join(dir, 'a.json'), JSON.stringify(a));
    nodeFs.writeFileSync(nodePath.join(dir, 'b.json'), JSON.stringify(b));
    assert.throws(() => resolveArms({ dir }), /pass --campaign/);
    assert.equal(resolveArms({ dir, campaignId: 'beta' }).source, 'campaign:beta');
  });

  it('an undeclared collision refuses at RESOLVE time — before any arm is spawned', () => {
    const dir = tmpDir('collide-campaign-');
    const cfg = campaign();
    // A SECOND kimi arm, undeclared. Note what this does not do: stripping
    // `type` from solo-opus instead would trip the incumbent-ambiguity rule
    // first (two non-replicate arms would then carry the incumbent model), so
    // the config would be refused by the schema and D4 would never run — a
    // refusal either way, but not a test of this rule.
    cfg.arms.push({ id: 'kimi-again', model: 'moonshotai/kimi-k2-thinking', mode: 'shadow' });
    nodeFs.writeFileSync(nodePath.join(dir, 'c.json'), JSON.stringify(cfg));
    assert.throws(() => resolveArms({ dir }), /D4/);
  });
});
