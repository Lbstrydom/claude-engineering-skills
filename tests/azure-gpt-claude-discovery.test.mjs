/**
 * @fileoverview Candidate-ladder discovery for the GPT and Claude Azure
 * deployment slots — siblings of `azure-embed-discovery.test.mjs`, sharing the
 * `deployment-ladder.mjs` walk. Covers the typed not-found classification
 * (only a genuine not-found signal advances the ladder — H5), first-verified
 * wins, a terminal unverified stopping the ladder with no replacement, and the
 * two surfaces' differing client-construction shape (GPT: `clientFor` per
 * candidate; Claude: one shared client, `model` varies in the body).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  probeGptDeployment, selectGptDeployment, STATIC_GPT_CANDIDATES,
} from '../scripts/lib/azure/gpt-discovery.mjs';
import {
  probeClaudeDeployment, selectClaudeDeployment, STATIC_CLAUDE_CANDIDATES,
} from '../scripts/lib/azure/claude-discovery.mjs';
import { ProbeOutcome, dedupeOrdered, walkLadder } from '../scripts/lib/azure/deployment-ladder.mjs';

const err = (status, code, message) => Object.assign(new Error(message || code), { status, code });

describe('deployment-ladder — shared walk', () => {
  test('dedupeOrdered trims, drops empties, preserves first-seen order', () => {
    assert.deepEqual(dedupeOrdered([' a ', 'b', 'a', '', null, 'c']), ['a', 'b', 'c']);
  });

  test('walkLadder stops at the first verified', async () => {
    const seen = [];
    const r = await walkLadder({
      ordered: ['x', 'y', 'z'],
      probeOne: async (name) => { seen.push(name); return { name, outcome: name === 'y' ? ProbeOutcome.VERIFIED : ProbeOutcome.UNSUPPORTED }; },
      catalogSource: 'static',
    });
    assert.equal(r.status, 'verified');
    assert.equal(r.selected, 'y');
    assert.deepEqual(seen, ['x', 'y']);
  });

  test('walkLadder stops at a terminal unverified, offers no replacement', async () => {
    const r = await walkLadder({
      ordered: ['x', 'y'],
      probeOne: async (name) => ({ name, outcome: name === 'x' ? ProbeOutcome.UNVERIFIED : ProbeOutcome.VERIFIED }),
      catalogSource: 'static',
    });
    assert.equal(r.status, 'unverified');
    assert.equal(r.selected, null);
  });

  test('walkLadder respects maxProbes and reports truncatedFrom', async () => {
    let calls = 0;
    const r = await walkLadder({
      ordered: ['a', 'b', 'c', 'd'],
      probeOne: async (name) => { calls++; return { name, outcome: ProbeOutcome.UNSUPPORTED }; },
      catalogSource: 'static',
      maxProbes: 2,
    });
    assert.equal(calls, 2);
    assert.equal(r.status, 'none-found');
    assert.equal(r.truncatedFrom, 4);
  });
});

describe('gpt-discovery — probeGptDeployment (Responses API, clientFor required)', () => {
  test('200 → verified', async () => {
    const clientFor = async (name) => ({ responses: { create: async () => ({ id: 'resp_1' }) } });
    const r = await probeGptDeployment('gpt-5.6-terra', clientFor);
    assert.equal(r.outcome, ProbeOutcome.VERIFIED);
  });

  test('deployment-not-found → unsupported (advances)', async () => {
    const clientFor = async () => ({ responses: { create: async () => { throw err(404, 'DeploymentNotFound', 'The API deployment for this resource does not exist'); } } } );
    const r = await probeGptDeployment('nope', clientFor);
    assert.equal(r.outcome, ProbeOutcome.UNSUPPORTED);
  });

  test('a bare 404 with no not-found signal stays terminal (H4/H5)', async () => {
    const clientFor = async () => ({ responses: { create: async () => { throw err(404, 'NotFound', 'Resource not found'); } } });
    const r = await probeGptDeployment('x', clientFor);
    assert.equal(r.outcome, ProbeOutcome.UNVERIFIED);
  });

  test('401 auth → unverified (terminal)', async () => {
    const clientFor = async () => ({ responses: { create: async () => { throw err(401, 'Unauthorized'); } } });
    const r = await probeGptDeployment('x', clientFor);
    assert.equal(r.outcome, ProbeOutcome.UNVERIFIED);
  });

  test('clientFor rejecting a candidate at construction classifies as a probe outcome, not a throw', async () => {
    const clientFor = async () => { throw Object.assign(new Error('boom'), { status: 500 }); };
    const r = await probeGptDeployment('x', clientFor);
    assert.equal(r.outcome, ProbeOutcome.UNVERIFIED);
  });

  test('sends `model: name` in the Responses body (the wire selector for this surface)', async () => {
    let seen = null;
    const clientFor = async (name) => ({ responses: { create: async (args) => { seen = args; return { id: 'ok' }; } } });
    await probeGptDeployment('gpt-5.6-terra', clientFor);
    assert.equal(seen.model, 'gpt-5.6-terra');
  });
});

describe('selectGptDeployment — one client per candidate, static ladder', () => {
  test('configured wins with a single probe', async () => {
    const built = [];
    const clientFor = async (name) => {
      built.push(name);
      return { responses: { create: async ({ model }) => { if (model !== 'team-gpt') throw err(404, 'DeploymentNotFound'); return { id: 'ok' }; } } };
    };
    const r = await selectGptDeployment({ configured: 'team-gpt', clientFor });
    assert.equal(r.status, 'verified');
    assert.equal(r.selected, 'team-gpt');
    assert.deepEqual(built, ['team-gpt'], 'stops at the first verified candidate');
  });

  test('falls through configured + user candidate into STATIC_GPT_CANDIDATES', async () => {
    const target = STATIC_GPT_CANDIDATES[1];
    const clientFor = async (name) => ({
      responses: { create: async ({ model }) => { if (model !== target) throw err(404, 'DeploymentNotFound'); return { id: 'ok' }; } },
    });
    const r = await selectGptDeployment({ configured: 'nope', userCandidates: ['also-nope'], clientFor });
    assert.equal(r.status, 'verified');
    assert.equal(r.selected, target);
    assert.equal(r.catalogSource, 'static');
  });

  test('a terminal unverified stops the ladder — no replacement (H5)', async () => {
    const clientFor = async () => ({ responses: { create: async () => { throw err(429, 'rate_limited'); } } });
    const r = await selectGptDeployment({ configured: 'nope', clientFor });
    assert.equal(r.status, 'unverified');
    assert.equal(r.selected, null);
  });

  test('all candidates unsupported → none-found', async () => {
    const clientFor = async () => ({ responses: { create: async () => { throw err(404, 'DeploymentNotFound'); } } });
    const r = await selectGptDeployment({ configured: 'nope', clientFor, maxProbes: 3 });
    assert.equal(r.status, 'none-found');
    assert.equal(r.selected, null);
  });
});

describe('claude-discovery — probeClaudeDeployment (Messages API, one shared client)', () => {
  test('200 → verified', async () => {
    const client = { messages: { create: async () => ({ id: 'msg_1' }) } };
    const r = await probeClaudeDeployment(client, 'claude-opus-4-8');
    assert.equal(r.outcome, ProbeOutcome.VERIFIED);
  });

  test('model-not-found → unsupported (advances)', async () => {
    const client = { messages: { create: async () => { throw err(404, 'model_not_found', 'model: claude-nope does not exist'); } } };
    const r = await probeClaudeDeployment(client, 'claude-nope');
    assert.equal(r.outcome, ProbeOutcome.UNSUPPORTED);
  });

  test('a bare 400 with no not-found signal stays terminal', async () => {
    const client = { messages: { create: async () => { throw err(400, 'invalid_request_error', 'Bad Request'); } } };
    const r = await probeClaudeDeployment(client, 'x');
    assert.equal(r.outcome, ProbeOutcome.UNVERIFIED);
  });

  test('401 auth → unverified (terminal)', async () => {
    const client = { messages: { create: async () => { throw err(401, 'authentication_error'); } } };
    const r = await probeClaudeDeployment(client, 'x');
    assert.equal(r.outcome, ProbeOutcome.UNVERIFIED);
  });

  test('sends `model: name` in the Messages body — the ONLY thing that varies per candidate', async () => {
    let seen = null;
    const client = { messages: { create: async (args) => { seen = args; return { id: 'ok' }; } } };
    await probeClaudeDeployment(client, 'claude-sonnet-5');
    assert.equal(seen.model, 'claude-sonnet-5');
    assert.equal(seen.messages[0].role, 'user');
  });
});

describe('selectClaudeDeployment — one shared client, static ladder', () => {
  test('configured wins with a single probe, no per-candidate client construction', async () => {
    let calls = 0;
    const client = { messages: { create: async ({ model }) => { calls++; if (model !== 'team-claude') throw err(404, 'model_not_found'); return { id: 'ok' }; } } };
    const r = await selectClaudeDeployment({ configured: 'team-claude', client });
    assert.equal(r.status, 'verified');
    assert.equal(r.selected, 'team-claude');
    assert.equal(calls, 1);
  });

  test('user --candidate is tried before the static pool', async () => {
    const client = { messages: { create: async ({ model }) => { if (model !== 'team-claude-prod') throw err(404, 'model_not_found'); return { id: 'ok' }; } } };
    const r = await selectClaudeDeployment({ configured: 'nope', userCandidates: ['team-claude-prod'], client });
    assert.equal(r.selected, 'team-claude-prod');
  });

  test('falls through into STATIC_CLAUDE_CANDIDATES', async () => {
    const target = STATIC_CLAUDE_CANDIDATES[1];
    const client = { messages: { create: async ({ model }) => { if (model !== target) throw err(404, 'model_not_found'); return { id: 'ok' }; } } };
    const r = await selectClaudeDeployment({ configured: 'nope', client });
    assert.equal(r.selected, target);
    assert.equal(r.catalogSource, 'static');
  });

  test('a terminal unverified stops the ladder — no replacement (H5)', async () => {
    const client = { messages: { create: async () => { throw err(500, 'internal_server_error'); } } };
    const r = await selectClaudeDeployment({ configured: 'nope', client });
    assert.equal(r.status, 'unverified');
    assert.equal(r.selected, null);
  });

  test('all candidates unsupported → none-found', async () => {
    const client = { messages: { create: async () => { throw err(404, 'model_not_found'); } } };
    const r = await selectClaudeDeployment({ configured: 'nope', client, maxProbes: 3 });
    assert.equal(r.status, 'none-found');
  });
});
