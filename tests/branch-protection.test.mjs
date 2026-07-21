import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOriginRepo, hasStatusCheckRatchet, strengthenRuleset } from '../scripts/lib/branch-protection.mjs';

test('parseOriginRepo handles https, ssh, and .git suffix', () => {
  assert.deepEqual(parseOriginRepo('https://github.com/Lbstrydom/wine-cellar-app.git'),
    { owner: 'Lbstrydom', name: 'wine-cellar-app', slug: 'Lbstrydom/wine-cellar-app' });
  assert.deepEqual(parseOriginRepo('git@github.com:Lbstrydom/ai-organiser.git'),
    { owner: 'Lbstrydom', name: 'ai-organiser', slug: 'Lbstrydom/ai-organiser' });
  assert.deepEqual(parseOriginRepo('https://github.com/Lbstrydom/wine-cellar-app'),
    { owner: 'Lbstrydom', name: 'wine-cellar-app', slug: 'Lbstrydom/wine-cellar-app' });
  assert.deepEqual(parseOriginRepo('ssh://git@github.com/Lbstrydom/wine-cellar-app.git'),
    { owner: 'Lbstrydom', name: 'wine-cellar-app', slug: 'Lbstrydom/wine-cellar-app' });
});

test('parseOriginRepo returns null for non-GitHub / junk input', () => {
  assert.equal(parseOriginRepo('https://gitlab.com/foo/bar'), null);
  assert.equal(parseOriginRepo(''), null);
  assert.equal(parseOriginRepo(null), null);
  assert.equal(parseOriginRepo(undefined), null);
});

test('hasStatusCheckRatchet detects the required_status_checks rule', () => {
  assert.equal(hasStatusCheckRatchet({ rules: [{ type: 'pull_request' }, { type: 'required_status_checks' }] }), true);
  assert.equal(hasStatusCheckRatchet({ rules: [{ type: 'pull_request' }, { type: 'deletion' }] }), false);
  assert.equal(hasStatusCheckRatchet({}), false);
  assert.equal(hasStatusCheckRatchet(null), false);
});

test('strengthenRuleset flips strict=false → true and reports changed', () => {
  const ruleset = {
    name: 'main protection', target: 'branch', enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } },
    bypass_actors: [],
    rules: [
      { type: 'pull_request', parameters: {} },
      { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'Unit Tests' }] } },
    ],
  };
  const { changed, body } = strengthenRuleset(ruleset);
  assert.equal(changed, true);
  const rsc = body.rules.find((r) => r.type === 'required_status_checks');
  assert.equal(rsc.parameters.strict_required_status_checks_policy, true);
  // preserves the other parameters + rules
  assert.deepEqual(rsc.parameters.required_status_checks, [{ context: 'Unit Tests' }]);
  assert.ok(body.rules.some((r) => r.type === 'pull_request'));
  // PUT body carries only the mutable fields
  assert.deepEqual(Object.keys(body).sort(), ['bypass_actors', 'conditions', 'enforcement', 'name', 'rules', 'target']);
});

test('strengthenRuleset is idempotent when already strict (changed=false)', () => {
  const ruleset = {
    name: 'main protection', target: 'branch', enforcement: 'active', conditions: {}, bypass_actors: [],
    rules: [{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [] } }],
  };
  assert.equal(strengthenRuleset(ruleset).changed, false);
});

test('strengthenRuleset does not fabricate a ratchet when none exists (changed=false)', () => {
  const ruleset = {
    name: 'basic', target: 'branch', enforcement: 'active', conditions: {}, bypass_actors: [],
    rules: [{ type: 'pull_request', parameters: {} }, { type: 'deletion' }],
  };
  const { changed, body } = strengthenRuleset(ruleset);
  assert.equal(changed, false);
  // rules pass through untouched — no invented required_status_checks rule
  assert.equal(body.rules.some((r) => r.type === 'required_status_checks'), false);
});
