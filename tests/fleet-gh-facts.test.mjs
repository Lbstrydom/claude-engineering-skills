/**
 * @fileoverview /fleet — PR checks are fetched APART from the PR list, so a token
 * that cannot read `statusCheckRollup` (HTTP 403) degrades only that column.
 * Plan: docs/plans/fleet-storyline-feedback.md §2.1.
 *
 * Uses the shared fake `gh`, which 403s ONLY the call that requests
 * `statusCheckRollup` — the failure shape storyline measured.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  listPullRequests, PR_LIST_FIELDS, PR_CHECK_FIELDS, attachChecks, classifyChecksFailure,
} from '../scripts/lib/fleet/gh-facts.mjs';
import { renderStatus, incompleteSources } from '../scripts/lib/fleet/render.mjs';
import { installFakeGh, prRow, scrubbedEnv, tmpRoot, cleanupFleetRoots } from './helpers/fleet-repo.mjs';

after(cleanupFleetRoots);

const OID = 'a'.repeat(40);
function setup(rows, extra = {}) {
  const root = tmpRoot('fleet-ghf-');
  const gh = installFakeGh(root);
  gh.setState({ list: rows, view: {}, ...extra });
  const env = scrubbedEnv(gh.env, { prependPath: [gh.bin] });
  return { gh, run: () => listPullRequests(os.tmpdir(), { env }) };
}
const row = (n, rollup = []) => ({ ...prRow({ number: n, branch: `b${n}`, headOid: OID, baseOid: OID }), statusCheckRollup: rollup });

describe('checks are a separate, optional column', () => {
  it('a 403 on statusCheckRollup keeps the PR list and degrades only checks', () => {
    const { gh, run } = setup([row(1), row(2)], { checksFail: 'HTTP 403: Resource not accessible by personal access token' });
    const r = run();
    assert.equal(r.queried, true, 'the PR list must survive');
    assert.deepEqual(r.prs.map((p) => p.number), [1, 2]);
    assert.equal(r.fields.checks.queried, false);
    assert.match(r.fields.checks.reason, /403/);
    for (const p of r.prs) assert.deepEqual(p.checks, { state: 'unknown', total: null });
    const calls = gh.calls().filter((c) => c[0] === 'pr' && c[1] === 'list');
    assert.equal(calls.length, 2, 'core call + one checks call');
    assert.ok(!calls[0][calls[0].indexOf('--json') + 1].includes('statusCheckRollup'), 'the core call never asks for the rollup');
  });

  it('unknown never renders as a pass, and the source is named', () => {
    const { run } = setup([row(1)], { checksFail: 'HTTP 403: Resource not accessible' });
    const prs = run();
    const item = { id: 'b1', display: 'working', branch: 'b1', intent: null, ahead: 1, behind: 0, worktree: null, waitingOn: [], overlaps: [], duplicates: [], findings: [], notes: [], pr: prs.prs[0] };
    const status = {
      registry: { complete: true, invalid: [] }, base: { name: 'main', freshness: null }, observedAt: 't', hold: null,
      sources: { worktrees: { queried: true }, branches: { queried: true }, prs },
      items: [item], landingOrder: [], cycles: [], trains: [],
    };
    const text = renderStatus(status);
    assert.match(text, /PR #1 checks:unknown/);
    assert.doesNotMatch(text, /checks:(success|none)/);
    assert.match(text, /PR checks: not queried \(checks not readable with this token \(403\)\)/);
    assert.ok(incompleteSources(status).includes('PR checks'));
  });

  it('both calls succeed: states are exactly what the rollup says', () => {
    const { run } = setup([row(1, []), row(2, [{ status: 'COMPLETED', conclusion: 'SUCCESS' }]), row(3, [{ status: 'COMPLETED', conclusion: 'FAILURE' }])]);
    const r = run();
    assert.deepEqual(r.fields.checks, { queried: true, missing: 0 });
    assert.deepEqual(r.prs.map((p) => p.checks.state), ['none', 'success', 'failure']);
  });

  it('a PR absent from the checks listing is unknown, never none', () => {
    const { run } = setup([row(1, []), row(2, [])], { checksOmit: [2] });
    const r = run();
    assert.deepEqual(r.prs.map((p) => p.checks.state), ['none', 'unknown']);
    assert.equal(r.fields.checks.missing, 1);
    assert.match(r.fields.checks.reason, /1 PR without usable checks/);
  });

  it('a non-403 failure of the checks call keeps its own reason and the list intact', () => {
    const { run } = setup([row(1)], { checksFail: 'dial tcp: connection refused' });
    const r = run();
    assert.equal(r.queried, true);
    assert.equal(r.fields.checks.reason, 'gh offline');
    assert.equal(r.prs[0].checks.state, 'unknown');
  });

  it('a malformed checks row leaves its PR unknown (not none, not a throw)', () => {
    const prs = [{ number: 1, checks: { state: 'unknown', total: null } }, { number: 2, checks: { state: 'unknown', total: null } }];
    const f = attachChecks(prs, JSON.stringify([{ number: 1, statusCheckRollup: [null] }, { number: 2, statusCheckRollup: [] }]));
    assert.deepEqual(prs.map((p) => p.checks.state), ['unknown', 'none']);
    assert.match(f.reason, /1 malformed/);
    assert.equal(attachChecks(prs, 'not json').queried, false);
  });

  it('checks from a different head revision are never attached (force-push between the two calls)', () => {
    const prs = [{ number: 1, headOid: 'a'.repeat(40), checks: { state: 'unknown', total: null } }, { number: 2, headOid: 'b'.repeat(40), checks: { state: 'unknown', total: null } }];
    const f = attachChecks(prs, JSON.stringify([
      { number: 1, headRefOid: 'c'.repeat(40), statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] },
      { number: 2, headRefOid: 'b'.repeat(40), statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] },
    ]));
    assert.deepEqual(prs.map((p) => p.checks.state), ['unknown', 'success']);
    assert.match(f.reason, /1 head moved between queries/);
  });

  it('the 403 rule is scoped to the checks call', () => {
    assert.match(classifyChecksFailure('HTTP 403: Resource not accessible'), /403/);
    assert.equal(classifyChecksFailure('gh auth login'), 'gh not authenticated');
  });

  it('every field of both calls is a real gh field (recorded list)', () => {
    const fixture = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures/fleet/gh-pr-view-fields.json'), 'utf-8'));
    for (const f of [...PR_LIST_FIELDS, ...PR_CHECK_FIELDS]) assert.ok(fixture.list.includes(f), f);
    assert.ok(!PR_LIST_FIELDS.includes('statusCheckRollup'));
  });
});
