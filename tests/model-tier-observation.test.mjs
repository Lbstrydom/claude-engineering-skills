// Cluster A of docs/completed/model-tier-observation.md — the logical-tier
// abstraction (model-resolver) + the observation builder (pure, no I/O, no
// routing). Provider-agnostic; bias-partition key; aggregates-only egress.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATIC_POOL, LOGICAL_TIERS, TIER_MAP,
  tierForModel, sentinelForTier, describeModel,
} from '../scripts/lib/model-resolver.mjs';
import {
  deriveSignals, suggestTier, normalizeTierHint, buildAuthorTierObservation,
} from '../scripts/lib/learning/author-tier-observation.mjs';

describe('model-resolver — logical-tier abstraction (Phase 1)', () => {
  it('tierForModel maps known sentinels + concrete ids to the expected tier', () => {
    assert.equal(tierForModel('latest-opus'), 'frontier');
    assert.equal(tierForModel('latest-sonnet'), 'standard');
    assert.equal(tierForModel('latest-haiku'), 'economy');
    assert.equal(tierForModel('latest-pro'), 'frontier');
    assert.equal(tierForModel('latest-flash-lite'), 'economy');
    assert.equal(tierForModel('latest-gpt'), 'standard');
    assert.equal(tierForModel('latest-gpt-mini'), 'economy');
    assert.equal(tierForModel('claude-opus-4-7'), 'frontier');
    assert.equal(tierForModel('gemini-2.5-flash'), 'standard');
    assert.equal(tierForModel('gpt-5.4-mini'), 'economy');
  });

  it('unknown / non-string ids → "unknown" (never throws)', () => {
    assert.equal(tierForModel('qwen2.5-coder-7b'), 'unknown');
    assert.equal(tierForModel(''), 'unknown');
    assert.equal(tierForModel(null), 'unknown');
  });

  it('GUARDRAIL — no STATIC_POOL family classifies as "unknown"', () => {
    const offenders = [];
    for (const ids of Object.values(STATIC_POOL)) {
      for (const id of ids) if (tierForModel(id) === 'unknown') offenders.push(id);
    }
    assert.deepEqual(offenders, [], `STATIC_POOL ids unclassifiable: ${offenders.join(', ')}`);
  });

  it('sentinelForTier round-trips unique sentinels; OpenAI standard/frontier collapse', () => {
    for (const provider of ['anthropic', 'google']) {
      for (const t of LOGICAL_TIERS) {
        assert.equal(tierForModel(sentinelForTier(t, { provider })), t, `${provider}/${t}`);
      }
    }
    assert.equal(tierForModel(sentinelForTier('economy', { provider: 'openai' })), 'economy');
    // collapse: standard & frontier both → latest-gpt (not a round-trip, by design)
    assert.equal(sentinelForTier('frontier', { provider: 'openai' }),
      sentinelForTier('standard', { provider: 'openai' }));
    assert.equal(sentinelForTier('frontier', { provider: 'openai' }), 'latest-gpt');
    // degrade, not throw
    assert.equal(sentinelForTier('frontier', { provider: 'nope' }), null);
    assert.equal(sentinelForTier('bogus', { provider: 'anthropic' }), null);
  });

  it('describeModel returns the partition key for known ids, null otherwise', () => {
    assert.deepEqual(describeModel('latest-sonnet'),
      { provider: 'anthropic', family: 'claude', tier: 'standard', concreteModel: 'claude-sonnet-4-6' });
    const opus = describeModel('claude-opus-4-7');
    assert.equal(opus.provider, 'anthropic'); assert.equal(opus.tier, 'frontier');
    assert.equal(describeModel('qwen2.5-coder-7b'), null);
    assert.equal(describeModel(''), null);
  });
});

describe('author-tier-observation — signals + heuristic (Phase 2)', () => {
  it('deriveSignals: floorTouch on sensitive + migration paths', () => {
    assert.equal(deriveSignals({ changedFiles: ['src/auth/session.ts'] }).floorTouch, true);
    assert.equal(deriveSignals({ changedFiles: ['supabase/migrations/2026_x.sql'] }).floorTouch, true);
    assert.equal(deriveSignals({ changedFiles: ['src/widget.ts'] }).floorTouch, false);
  });

  it('deriveSignals: mechanicalOnly only when EVERY path is docs/config/test', () => {
    assert.equal(deriveSignals({ changedFiles: ['README.md', 'docs/x.md'] }).mechanicalOnly, true);
    assert.equal(deriveSignals({ changedFiles: ['a.test.mjs', 'config.json'] }).mechanicalOnly, true);
    assert.equal(deriveSignals({ changedFiles: ['README.md', 'src/real.ts'] }).mechanicalOnly, false);
    assert.equal(deriveSignals({ changedFiles: [] }).mechanicalOnly, false);
  });

  it('deriveSignals: buckets + crossDomain + aggregates-only (no raw paths leak)', () => {
    assert.equal(deriveSignals({ diffLines: 5 }).diffBucket, 'xs');
    assert.equal(deriveSignals({ diffLines: 300 }).diffBucket, 'l');
    assert.equal(deriveSignals({ domains: ['a', 'b'] }).crossDomain, true);
    const sig = deriveSignals({ changedFiles: ['secrets/.env'], domains: ['x'] });
    assert.ok(!JSON.stringify(sig).includes('.env'), 'raw path must not appear in signals');
    assert.equal(sig.fileCount, 1);
  });

  it('suggestTier precedence: floor → frontier; size/cross → frontier; mechanical → economy; else standard', () => {
    assert.equal(suggestTier({ floorTouch: true, fileCount: 1 }), 'frontier');
    assert.equal(suggestTier({ fileCount: 6 }), 'frontier');
    assert.equal(suggestTier({ crossDomain: true, fileCount: 2 }), 'frontier');
    assert.equal(suggestTier({ diffBucket: 'l', fileCount: 1 }), 'frontier');
    assert.equal(suggestTier({ mechanicalOnly: true, fileCount: 2 }), 'economy');
    assert.equal(suggestTier({ fileCount: 3 }), 'standard');
  });

  it('normalizeTierHint: logical passthrough; model id; sentinel; garbage→unknown', () => {
    assert.equal(normalizeTierHint('economy'), 'economy');
    assert.equal(normalizeTierHint('claude-opus-4-7'), 'frontier');
    assert.equal(normalizeTierHint('latest-sonnet'), 'standard');
    assert.equal(normalizeTierHint('qwen-7b'), 'unknown');
    assert.equal(normalizeTierHint(null), 'unknown');
  });
});

describe('author-tier-observation — buildAuthorTierObservation (Phase 2)', () => {
  const baseSig = deriveSignals({ changedFiles: ['src/x.ts'], domains: ['core'], diffLines: 30 });

  it('produces the recordDecision input shape (audit-bound key, choice, outcome)', () => {
    const o = buildAuthorTierObservation({ runId: 'run-1', round: 2, signals: baseSig, converged: true });
    assert.equal(o.decisionType, 'author_tier');
    assert.equal(o.auditRunId, 'run-1');   // → decision_key run-1:author_tier:r2:s0
    assert.equal(o.round, 2);
    assert.equal(o.sequence, 0);
    assert.ok(o.choice.suggestedTier && o.choice.declaredTier);
    assert.deepEqual(o.outcome, { converged: true });
    assert.equal(o.context.round, 2);
  });

  it('partition key: concrete-model hint populates it; logical / absent → null', () => {
    const concrete = buildAuthorTierObservation({ runId: 'r', round: 1, signals: baseSig, converged: true, authorTierHint: 'claude-sonnet-4-6' });
    assert.equal(concrete.context.authorProvider, 'anthropic');
    assert.equal(concrete.context.authorFamily, 'claude');
    assert.equal(concrete.context.authorModel, 'claude-sonnet-4-6');
    assert.equal(concrete.choice.declaredTier, 'standard');
    assert.equal(concrete.context.declaredTierSource, 'provided');

    const logical = buildAuthorTierObservation({ runId: 'r', round: 1, signals: baseSig, converged: true, authorTierHint: 'standard' });
    assert.equal(logical.context.authorModel, null, 'logical-tier hint has no concrete model');
    assert.equal(logical.choice.declaredTier, 'standard');

    const none = buildAuthorTierObservation({ runId: 'r', round: 1, signals: baseSig, converged: true });
    assert.equal(none.context.authorModel, null);
    assert.equal(none.choice.declaredTier, 'unknown');
    assert.equal(none.context.declaredTierSource, 'unknown');
  });

  it('egress: a sensitive path never appears raw in the built envelope', () => {
    const sig = deriveSignals({ changedFiles: ['secrets/.env', 'src/auth/x.ts'] });
    const o = buildAuthorTierObservation({ runId: 'r', round: 3, signals: sig, converged: false });
    assert.ok(!JSON.stringify(o).includes('.env'), 'no raw path in telemetry envelope');
    assert.equal(o.context.floorTouch, true); // but the signal is captured
  });
});

describe('Cluster-A audit fixes (regression)', () => {
  it('gemini-2.5-flash-lite classifies as economy (alternation-order fix)', () => {
    assert.equal(tierForModel('gemini-2.5-flash-lite'), 'economy');
    assert.equal(describeModel('gemini-2.5-flash-lite').tier, 'economy');
  });

  it('OpenAI variant shapes the strict parser missed still describe (coarse fallback)', () => {
    for (const id of ['gpt-4o-mini', 'gpt-5.5-pro']) {
      const d = describeModel(id);
      assert.equal(d.provider, 'openai', id);
      assert.equal(d.concreteModel, id);
    }
    assert.equal(describeModel('gpt-4o-mini').tier, 'economy');
    assert.equal(describeModel('gpt-5.5-pro').tier, 'standard');
  });

  it('deriveSignals drops non-slug "domains" (egress — no path leaks via domainTags)', () => {
    const sig = deriveSignals({ domains: ['core', 'secrets/.env', 'a/b/c.ts', 'ok-tag'] });
    assert.deepEqual(sig.domainTags, ['core', 'ok-tag']);
  });

  it('buildAuthorTierObservation rejects a non-string/empty runId + bad round (guards)', () => {
    const sig = deriveSignals({ changedFiles: ['src/x.ts'] });
    for (const bad of [undefined, null, {}, '', '   ']) {
      assert.throws(() => buildAuthorTierObservation({ runId: bad, round: 1, signals: sig, converged: true }),
        /runId must be a non-empty string/, `runId=${JSON.stringify(bad)}`);
    }
    for (const bad of [0, -1, 1.5, undefined]) {
      assert.throws(() => buildAuthorTierObservation({ runId: 'r', round: bad, signals: sig, converged: true }),
        /round must be a positive integer/, `round=${JSON.stringify(bad)}`);
    }
  });

  it('TIER_MAP nested provider maps are deep-frozen', () => {
    assert.ok(Object.isFrozen(TIER_MAP.openai));
    assert.throws(() => { 'use strict'; TIER_MAP.openai.frontier = 'x'; });
  });
});

describe('Cluster-A R2 audit fixes (regression)', () => {
  it('the omni family parses via the strict OpenAI parser, not only the coarse fallback', () => {
    // gpt-4o → standard; gpt-4o-mini → economy. Both were STATIC-shaped ids the
    // digit-only regex rejected (Model Parsing Regression finding).
    assert.equal(describeModel('gpt-4o').tier, 'standard');
    assert.equal(describeModel('gpt-4o-mini').tier, 'economy');
    assert.equal(tierForModel('gpt-4o-mini'), 'economy');
  });

  it('floorTouch does NOT fire on docs/test paths that merely mention security', () => {
    // Over-match half of "Incorrect Signal Classification": a doc/test ABOUT auth
    // is mechanical, not a security SOURCE floor.
    assert.equal(deriveSignals({ changedFiles: ['docs/auth.md'] }).floorTouch, false);
    assert.equal(deriveSignals({ changedFiles: ['src/auth.test.js'] }).floorTouch, false);
    // and the corrected classification routes a mechanical-only auth doc to economy
    assert.equal(suggestTier(deriveSignals({ changedFiles: ['docs/auth.md'] })), 'economy');
  });

  it('floorTouch fires on snake_case / numeric-suffix security SOURCE names', () => {
    // Under-match half: boundaries now include `_` and digits.
    assert.equal(deriveSignals({ changedFiles: ['src/user_auth.ts'] }).floorTouch, true);
    assert.equal(deriveSignals({ changedFiles: ['src/oauth2.ts'] }).floorTouch, true);
  });
});

describe('Cluster-A R3 audit fixes (regression)', () => {
  it('sentinelForTier degrades to null for null/garbage options — never throws (R3-H)', () => {
    assert.equal(sentinelForTier('frontier', null), null);
    assert.equal(sentinelForTier('frontier'), null);          // undefined opts → no provider
    assert.equal(sentinelForTier('frontier', 'nonsense'), null);
    assert.equal(sentinelForTier('economy', { provider: 'anthropic' }), 'latest-haiku');
  });

  it('tierForModel + describeModel apply DEPRECATED_REMAP so a stale id matches its sentinel (R3-M)', () => {
    // gpt-5.2 → latest-gpt (standard); claude-opus-3 → latest-opus (frontier).
    assert.equal(tierForModel('gpt-5.2'), tierForModel('latest-gpt'));
    assert.equal(tierForModel('gpt-5.2'), 'standard');
    assert.equal(tierForModel('claude-opus-3'), 'frontier');
    const d = describeModel('claude-opus-3');
    assert.equal(d.provider, 'anthropic');
    assert.equal(d.tier, 'frontier');
    // partition key resolves to the live opus, NOT the stale id (no data split)
    assert.notEqual(d.concreteModel, 'claude-opus-3');
  });

  it('SECURITY_PATH_RE matches hyphen/dot-separated security SOURCE names (R3-M)', () => {
    for (const f of ['src/user-auth.ts', 'src/jwt-auth.js', 'src/payment-authz.ts', 'src/user.auth.ts']) {
      assert.equal(deriveSignals({ changedFiles: [f] }).floorTouch, true, f);
    }
  });

  it('DOMAIN_SLUG_RE is lowercase-only — UPPER_SNAKE env/secret names never enter telemetry (R3-egress)', () => {
    const sig = deriveSignals({ domains: ['OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'wine-shop', 'pairing_lab'] });
    assert.deepEqual(sig.domainTags, ['wine-shop', 'pairing_lab']);
  });
});

describe('Cluster-A R4 audit fixes (regression)', () => {
  it('security CONFIG floors, docs/tests about auth do NOT (R4 doc/test-vs-config split)', () => {
    // config that is security-relevant → frontier floor
    assert.equal(deriveSignals({ changedFiles: ['config/auth.yaml'] }).floorTouch, true);
    assert.equal(deriveSignals({ changedFiles: ['oauth.json'] }).floorTouch, true);
    // docs/tests merely ABOUT auth → not a floor
    assert.equal(deriveSignals({ changedFiles: ['docs/auth.md'] }).floorTouch, false);
    assert.equal(deriveSignals({ changedFiles: ['src/auth.test.js'] }).floorTouch, false);
    // non-security config stays unflagged
    assert.equal(deriveSignals({ changedFiles: ['config/app.json'] }).floorTouch, false);
  });

  it('buildAuthorTierObservation rejects a non-object signals param (R4 boundary)', () => {
    for (const bad of [null, undefined, 'x', 42]) {
      assert.throws(() => buildAuthorTierObservation({ runId: 'r', round: 1, signals: bad, converged: true }),
        /signals must be an object/, `signals=${JSON.stringify(bad)}`);
    }
  });
});

describe('Cluster-A consolidated-gate fix (Gemini): camelCase/PascalCase security paths', () => {
  it('floors camelCase / PascalCase JS/TS security SOURCE names', () => {
    for (const f of ['src/useAuth.ts', 'src/LoginForm.tsx', 'src/authGuard.ts',
                     'src/getAuthToken.ts', 'lib/OAuthClient.ts', 'src/SessionStore.ts']) {
      assert.equal(deriveSignals({ changedFiles: [f] }).floorTouch, true, f);
    }
  });

  it('floors full-word security morphology (authentication/authorization/…)', () => {
    for (const f of ['src/authentication.ts', 'src/authorization.ts', 'src/authorize.ts',
                     'src/unauthorized.ts', 'src/useAuthentication.ts', 'src/AuthorizationGuard.ts']) {
      assert.equal(deriveSignals({ changedFiles: [f] }).floorTouch, true, f);
    }
  });

  it('does NOT over-match longer words that merely start with a security prefix', () => {
    // keyword followed by a lowercase letter = part of a longer word → no floor
    for (const f of ['src/author.ts', 'src/authority.ts', 'src/Authorship.ts', 'src/cryptography.ts']) {
      assert.equal(deriveSignals({ changedFiles: [f] }).floorTouch, false, f);
    }
  });
});
