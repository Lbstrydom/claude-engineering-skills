import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyResponsesSupport } from '../scripts/lib/openai-responses-capability.mjs';

describe('classifyResponsesSupport — fatal by default (AGENTS.md: never retry 404)', () => {
  it('a generic 404 is fatal, NOT a Responses-unsupported signal', () => {
    assert.equal(classifyResponsesSupport({ status: 404, message: 'Resource not found' }), 'fatal');
  });

  it('a deployment-not-found 404 is fatal (config error, not route-unsupported)', () => {
    assert.equal(
      classifyResponsesSupport({ status: 404, message: 'The API deployment for this resource does not exist' }),
      'fatal',
    );
  });

  it('auth/quota errors are fatal', () => {
    assert.equal(classifyResponsesSupport({ status: 401, message: 'invalid api key' }), 'fatal');
    assert.equal(classifyResponsesSupport({ status: 429, message: 'rate limited' }), 'fatal');
  });

  it('null / non-object is fatal', () => {
    assert.equal(classifyResponsesSupport(null), 'fatal');
    assert.equal(classifyResponsesSupport('boom'), 'fatal');
  });
});

describe('classifyResponsesSupport — unsupported only on a positive signal', () => {
  it('404 that mentions the responses route is unsupported', () => {
    assert.equal(
      classifyResponsesSupport({ status: 404, message: 'The responses endpoint is not available on this deployment' }),
      'unsupported',
    );
  });

  it('explicit unsupported-operation for responses', () => {
    assert.equal(
      classifyResponsesSupport({ status: 400, error: { code: 'unsupported', message: 'operation responses not supported' } }),
      'unsupported',
    );
  });

  it('"not supported" without mentioning responses stays fatal', () => {
    assert.equal(classifyResponsesSupport({ status: 400, message: 'temperature not supported' }), 'fatal');
  });
});
