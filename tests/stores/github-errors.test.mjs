import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGitHubError } from '../../scripts/lib/stores/github/github-errors.mjs';

describe('normalizeGitHubError', () => {
  it('maps 401 to misconfiguration', () => {
    const err = new Error('Bad credentials');
    err.status = 401;
    const result = normalizeGitHubError(err, 'init');
    assert.equal(result.reason, 'misconfiguration');
    assert.equal(result.retryable, false);
  });

  it('maps 403 rate-limit to transient', () => {
    const err = new Error('API rate limit exceeded');
    err.status = 403;
    const result = normalizeGitHubError(err);
    assert.equal(result.reason, 'transient');
    assert.equal(result.bufferToOutbox, true);
  });

  it('maps 403 scope error to misconfiguration', () => {
    const err = new Error('Resource not accessible by integration');
    err.status = 403;
    const result = normalizeGitHubError(err);
    assert.equal(result.reason, 'misconfiguration');
  });

  it('maps 404 branch-check to misconfiguration', () => {
    const err = new Error('Not Found');
    err.status = 404;
    const result = normalizeGitHubError(err, 'branch-check');
    assert.equal(result.reason, 'misconfiguration');
    assert.ok(result.operatorHint.includes('setup-github-store'));
  });

  it('maps 404 file-read to not-found', () => {
    const err = new Error('Not Found');
    err.status = 404;
    const result = normalizeGitHubError(err, 'file-read');
    assert.equal(result.reason, 'not-found');
  });

  it('maps 409/422 to transient (conflict)', () => {
    const err = new Error('Update is not a fast forward');
    err.status = 422;
    const result = normalizeGitHubError(err);
    assert.equal(result.reason, 'transient');
    assert.equal(result.retryable, true);
  });

  it('maps 500+ to transient', () => {
    const err = new Error('Internal Server Error');
    err.status = 502;
    const result = normalizeGitHubError(err);
    assert.equal(result.reason, 'transient');
    assert.equal(result.bufferToOutbox, true);
  });

  it('maps network errors to transient', () => {
    const err = new Error('connect ECONNREFUSED');
    const result = normalizeGitHubError(err);
    assert.equal(result.reason, 'transient');
  });

  it('maps unknown errors', () => {
    const err = new Error('something weird');
    err.status = 418;
    const result = normalizeGitHubError(err);
    assert.equal(result.reason, 'unknown');
  });
});
