/**
 * `upsertPlan`'s failure contract (plan
 * `docs/plans/audit-store-write-durability.md`, decision 6 / Phase 5).
 *
 * **The defect.** `upsertPlan` returned `null` for five different things:
 * missing input, cloud off, an out-of-repo path, an unresolved repoId, and a
 * caught DB failure. All three callers read that one value as "no plan". So a
 * store outage and a deliberately plan-less audit produced the same value, and
 * the audit went on to record `plan_id: null` — which reads as intent, not as
 * loss. That is shape B of this plan's unifying defect: *failure wearing
 * success's clothes*.
 *
 * The assertion that carries the weight is the one this file is named for: a DB
 * FAILURE and an ABSENT ROW must not be the same value. Everything else here
 * exists to stop that one being satisfied vacuously — a function that returned
 * `{ok:false}` for literally everything would pass a test that only checked the
 * failure case.
 */
// MUST precede the dynamic import below, and must be an assignment rather than
// a `delete`: config resolves at import time and the shared `~/.audit-loop.env`
// re-populates AUDIT_DB_URL, so deleting it inside a test leaves cloud ENABLED.
// The first draft of this file did exactly that and its "cloud-off" case
// reached the live store and came back `write-failed` — a test that proved the
// opposite of its name. Same convention as tests/plan-audit-cloud.test.mjs.
process.env.AUDIT_DB_URL = '';

const { upsertPlan } = await import('../scripts/lib/store/plans-ship.mjs');

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

describe('the four variants are distinguishable', () => {
  const REPO_ID = '11111111-1111-1111-1111-111111111111';

  test('cloud-off is its own reason, not a null', async () => {
    const r = await upsertPlan(REPO_ID, { path: 'docs/plans/example.md', skill: 'plan' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'cloud-off');
    assert.equal(typeof r.message, 'string');
  });

  test('missing input is invalid-input, and is NOT cloud-off', async () => {
    const r = await upsertPlan(REPO_ID, { path: 'docs/plans/x.md' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid-input');
    // The point of the whole change: two causes, two values.
    assert.notEqual(r.reason, 'cloud-off');
  });

  test('an out-of-repo path is refused BEFORE the cloud check', async () => {
    // Ordering is the claim: with the store OFF this still returns the path
    // reason rather than `cloud-off`, which proves validation runs first — and
    // that a bad path is reported as a caller bug on every configuration.
    const outside = path.join(REPO, '..', 'not-in-this-repo.md');
    const r = await upsertPlan(REPO_ID, { path: outside, skill: 'plan' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid-input');
    assert.notEqual(r.reason, 'cloud-off');
    assert.match(r.message, /outside the repo/i);
  });

  test('an unresolved repoId is invalid-input, not a silent skip', () => {
    // Asserted on source: the guard sits AFTER the cloud check (correctly — with
    // the store off there is no write to scope), so it is unreachable in this
    // DB-free suite. Guarded at all because a NULL repo_id is DISTINCT from
    // every other NULL on the (repo_id, path) unique index, so it would INSERT a
    // duplicate plan row on every call instead of updating.
    const src = fs.readFileSync(path.join(REPO, 'scripts/lib/store/plans-ship.mjs'), 'utf-8');
    assert.match(src, /if \(!repoId\) \{[\s\S]{0,600}?reason: 'invalid-input'/,
      'a null repoId must be reported, not written through');
  });
});

describe('a DB failure and an absent row are not the same value', () => {
  // This is the contract test the plan names. It is asserted on SOURCE rather
  // than by standing up a failing pool, because the distinction lives in the
  // return statements and a live DSN is forbidden here (INC-002).
  const SRC = fs.readFileSync(path.join(REPO, 'scripts/lib/store/plans-ship.mjs'), 'utf-8');
  const body = SRC.slice(SRC.indexOf('export async function upsertPlan'), SRC.indexOf('export async function getPlanIdByPath'));

  test('the catch returns write-failed, carrying the error', () => {
    assert.match(body, /catch \(err\) \{[\s\S]{0,300}?reason: 'write-failed'[\s\S]{0,120}?error: err/,
      'a caught DB failure must be reason:write-failed and must carry the error object');
  });

  test('no path in upsertPlan returns a bare null any more', () => {
    // The regression that would restore the defect: any `return null`. Five of
    // them are what made an outage indistinguishable from an ad-hoc run.
    assert.ok(!/\n\s*return null;/.test(body),
      'upsertPlan must not return a bare null — that value is what conflated five causes');
  });

  test('an upsert that returned no row is a FAILURE, not an ok with a null id', () => {
    // Postgres reports success for a statement that affected nothing. Returning
    // {ok:true, planId:null} would hand back the exact ambiguity this removes.
    // Keyed on the branch's own message rather than a windowed match to
    // `reason: 'write-failed'`: the catch block below carries that same reason,
    // so a window wide enough to clear the comment is also wide enough to match
    // the WRONG return if this branch were deleted — passing on the strength of
    // the code it was meant to notice missing.
    const noRow = body.slice(body.indexOf('if (!planId) {'));
    assert.ok(body.includes('if (!planId) {'), 'the no-row branch must exist');
    const decl = noRow.slice(0, noRow.indexOf('\n    }'));
    assert.match(decl, /reason: 'write-failed'/,
      'a missing RETURNING row must not be reported as a successful write');
    assert.match(decl, /did not verify/);
  });

  test('success carries the id under a discriminant', () => {
    assert.match(body, /return \{ ok: true, planId \}/);
  });
});

describe('all three callers were migrated together', () => {
  // §4: "The upsertPlan change and its three callers are one atomic unit. A
  // return-shape change landing without its callers is the regression this plan
  // would otherwise introduce." A caller still reading the result as an id
  // would now treat the RESULT OBJECT as truthy — always — and write a plan_id
  // of `[object Object]`. That failure is silent at the type level, so it is
  // pinned here.
  const callers = {
    'scripts/cross-skill.mjs': /const res = await upsertPlan\(/,
    'scripts/lib/audit/legacy-production-audit.mjs': /const planRes = await upsertPlan\(/,
    'scripts/lib/audit/plan-audit-cloud.mjs': /const planRes = await upsertPlan\(/,
  };

  for (const [file, pattern] of Object.entries(callers)) {
    test(`${file} reads the discriminated result`, () => {
      const src = fs.readFileSync(path.join(REPO, file), 'utf-8');
      assert.match(src, pattern, `${file} still assigns upsertPlan's return as if it were an id`);
      // …and none of them assigns it straight to a plan id.
      assert.ok(!/planId = await upsertPlan\(/.test(src),
        `${file} assigns upsertPlan's result directly to planId — the result object is always truthy, so this writes a bogus id`);
    });
  }

  test('every upsertPlan call site in the repo is accounted for', () => {
    // Derived, not listed (the same reason the durability oracle is): a FOURTH
    // caller added later would otherwise be invisible to this suite while
    // silently reading the old shape.
    const found = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.mjs')) continue;
        const src = fs.readFileSync(p, 'utf-8');
        // Call sites only — skip the definition and bare re-export barrels.
        if (/(?<!function )\bupsertPlan\(/.test(src) && !p.endsWith('plans-ship.mjs')) {
          found.push(path.relative(REPO, p).replace(/\\/g, '/'));
        }
      }
    };
    walk(path.join(REPO, 'scripts'));
    assert.deepEqual(
      found.sort(), Object.keys(callers).sort(),
      'the set of upsertPlan callers changed. A new caller must read the discriminated result '
      + '({ok, reason}) — reading it as an id yields an always-truthy object.',
    );
  });
});
