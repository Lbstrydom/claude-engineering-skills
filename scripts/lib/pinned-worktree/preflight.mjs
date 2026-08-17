/**
 * @fileoverview The credential preflight — refuse a spend-bearing run BEFORE
 * the first token, when a declared arm's key is absent.
 *
 * **Why this exists** (plan: `docs/plans/pinned-revision-fixture.md` §2
 * Decision 5). A missing provider credential is not an error. `resolveShadow`
 * (`scripts/gemini-review.mjs`) returns `state:'skipped-no-key'`, the arm
 * records as SKIPPED, and the snapshot is rejected by the completeness check
 * only AFTER the other arms have been paid for. Two snapshots and ~$13 of
 * provider spend were lost on 2026-08-17, and the operator's mitigation was
 * checking ten environment variables by hand.
 *
 * **Pure by construction.** Nothing here reads `process.env`; the environment
 * is a parameter. That is what lets the load-bearing test drive the gate in the
 * direction it MUST fire — a refusal that can only be observed on the machine
 * that happens to lack a key is not a test, and a validator that is inert
 * because of its arguments looks identical to one that works.
 *
 * @module scripts/lib/pinned-worktree/preflight
 */
import { SHADOW_PROVIDER_SPECS } from '../final-review/provider-specs.mjs';
import { transportForModel } from '../bakeoff/arms.mjs';
import { hmacKeyRefFor } from '../campaign/config.mjs';

/**
 * The environment variable names a spec's `hasCredential` can consult —
 * derived from the predicate itself, never re-listed.
 *
 * **Why probing and not a `credentialVars` field.** A second list is a contract
 * with no compiler between two places nothing compares, and its failure mode is
 * exactly the bug this module exists to prevent: the preflight reads green
 * while the arm skips. Probing cannot drift, because the names come from the
 * oracle.
 *
 * **Why TWO probes.** The predicates use both operator shapes and each
 * short-circuits the other way:
 *   - `alibaba` is `env.A && env.B` — an all-falsy probe stops at `A`.
 *   - `openrouter` is `env.A || env.B` — an all-truthy probe stops at `A`.
 * Running both and taking the union records every variable either shape can
 * consult (verified: `alibaba` → 2 names, `openrouter` → 2 names).
 *
 * These names are for the OPERATOR MESSAGE only. The verdict is always
 * `spec.hasCredential(realEnv)` — so even if a future predicate shape defeated
 * the probe and under-reported a name, the refusal itself stays correct.
 *
 * @param {{hasCredential: (env: object) => boolean}} spec
 * @returns {string[]} sorted variable names
 */
export function credentialVarsFor(spec) {
  const names = new Set();
  for (const truthy of [true, false]) {
    const recorder = new Proxy({}, {
      get: (_t, key) => {
        if (typeof key !== 'string') return undefined;
        names.add(key);
        return truthy ? 'probe-value' : undefined;
      },
      has: (_t, key) => {
        if (typeof key === 'string') names.add(key);
        return truthy;
      },
    });
    // A predicate that throws on a probe env still contributes whatever it read
    // before throwing; the verdict never depends on this call.
    try { spec.hasCredential(recorder); } catch { /* names already recorded */ }
  }
  return [...names].sort();
}

/**
 * Everything that must be present before a campaign collection may start.
 *
 * Each requirement carries its own `test(env)` — the single oracle for that
 * row — plus the variable names and a written reason, so a refusal names both
 * WHAT is missing and WHY the run needs it.
 *
 * @param {{campaignConfig: {id: string, arms: Array<{id: string, model: string, mode?: string}>}}} args
 * @returns {Array<{key: string, vars: string[], source: string, why: string, test: (env: object) => boolean}>}
 * @throws {Error} when the campaign declares no arms — see the vacuity note.
 */
export function requiredCredentials({ campaignConfig }) {
  const arms = campaignConfig?.arms;
  if (!Array.isArray(arms) || arms.length === 0) {
    // A campaign with no arms must never read as "all credentials present".
    // A gate that can return green having checked nothing is the failure mode
    // AGENTS.md's success-path audit rule names: ask of every green-emitting
    // branch whether it can be reached without having checked anything.
    throw new Error(
      `pinned-worktree preflight: campaign ${JSON.stringify(campaignConfig?.id ?? null)} declares no arms — `
      + 'refusing rather than reporting an empty check as a pass.',
    );
  }

  const reqs = [];
  const seen = new Set();
  const add = (r) => { if (!seen.has(r.key)) { seen.add(r.key); reqs.push(r); } };

  // ── Baseline: the store, and the repo's one universally-required key ──────
  add({
    key: 'store:AUDIT_DB_URL',
    vars: ['AUDIT_DB_URL'],
    source: 'campaign store',
    why: 'a collected snapshot is promoted into the campaign spine; with the store off the spend produces no durable evidence',
    test: (env) => Boolean(env.AUDIT_DB_URL),
  });
  add({
    key: 'base:OPENAI_API_KEY',
    vars: ['OPENAI_API_KEY'],
    source: 'repo baseline',
    why: 'the one required variable for this bundle (AGENTS.md §Environment Variables)',
    test: (env) => Boolean(env.OPENAI_API_KEY),
  });

  // ── Per-arm provider credentials, via the two existing oracles ───────────
  for (const arm of arms) {
    // `transportForModel` REFUSES an unknown model family rather than guessing
    // a token — let that throw here, where it is free, rather than inside a
    // spawned reviewer after the arm is counted as attempted.
    const transport = transportForModel(arm.model);
    const spec = SHADOW_PROVIDER_SPECS[transport.shadowToken];
    if (!spec) {
      throw new Error(
        `pinned-worktree preflight: arm ${JSON.stringify(arm.id)} resolves transport token `
        + `${JSON.stringify(transport.shadowToken)}, which has no SHADOW_PROVIDER_SPECS entry. `
        + 'Refusing rather than treating an unrecognised provider as needing no credential.',
      );
    }
    add({
      key: `arm:${spec.canonical}`,
      vars: credentialVarsFor(spec),
      source: `arm ${arm.id} (${arm.model})`,
      why: `without it resolveShadow returns 'skipped-no-key', the arm records as SKIPPED, and the snapshot is rejected after the other arms have billed`,
      test: (env) => spec.hasCredential(env),
    });

    // A `shadow` arm runs a PRIMARY review alongside the shadow; a `primary`
    // arm passes `--provider` and runs solo (bakeoff/arms.mjs deriveArmEnv).
    // The primary reviewer's precedence falls back to Opus when GEMINI_API_KEY
    // is absent rather than failing — so this is not a crash risk, it is a
    // COMPARABILITY risk: the cohort would silently measure a different primary
    // than the campaign declared.
    if (arm.mode !== 'primary') {
      add({
        key: 'primary:gemini',
        vars: credentialVarsFor(SHADOW_PROVIDER_SPECS.gemini),
        source: 'primary reviewer (shadow arms)',
        why: 'shadow arms run a primary review alongside the shadow; absent, the primary silently falls back to another provider and the cohort measures a primary the campaign never declared',
        test: (env) => SHADOW_PROVIDER_SPECS.gemini.hasCredential(env),
      });
    }
  }

  // ── The campaign's worksheet HMAC key ────────────────────────────────────
  // Checked at COLLECT time although it gates ADJUDICATION, deliberately: an
  // absent key is a hard refusal (`requireCampaignHmacKey`) and is never
  // regenerated, so discovering it after collecting is discovering it after
  // paying. The whole point of this preflight is no surprises after spend.
  const hmacVar = hmacKeyRefFor(campaignConfig.id);
  add({
    key: `campaign:${hmacVar}`,
    vars: [hmacVar],
    source: 'campaign worksheet identity',
    why: 'adjudication refuses without it and a regenerated key would orphan every human disposition already recorded',
    test: (env) => Boolean(env[hmacVar]),
  });

  return reqs;
}

/**
 * Apply the requirements to a concrete environment.
 *
 * Reports variable NAMES only — never a value. `hasCredential` returns a
 * boolean and the secret must not reach a log line, matching `azure:routes`.
 *
 * @param {ReturnType<typeof requiredCredentials>} requirements
 * @param {object} env
 * @returns {{ok: boolean, checked: number, missing: Array<{key: string, vars: string[], source: string, why: string}>, present: string[]}}
 */
export function checkCredentials(requirements, env) {
  if (!Array.isArray(requirements) || requirements.length === 0) {
    throw new Error('pinned-worktree preflight: no requirements to check — refusing to report an empty check as a pass.');
  }
  const missing = [];
  const present = [];
  for (const r of requirements) {
    if (r.test(env)) present.push(r.key);
    else missing.push({ key: r.key, vars: r.vars, source: r.source, why: r.why });
  }
  return { ok: missing.length === 0, checked: requirements.length, missing, present };
}

/**
 * Human-readable refusal, one line per missing requirement.
 *
 * @param {ReturnType<typeof checkCredentials>} result
 * @returns {string}
 */
export function formatMissing(result) {
  return result.missing
    .map((m) => `  ${m.vars.join(' + ')}\n      needed by: ${m.source}\n      why: ${m.why}`)
    .join('\n');
}
