/**
 * @fileoverview Guards the anthropic-client backend-routing migration.
 *
 * Two invariants the 2026-06-29 migration established (see AGENTS.md
 * "Anthropic Backend Routing"):
 *
 *   1. No bare `new Anthropic()` outside the factory. Every Claude call site
 *      must go through `createAnthropicClient()` so `CLAUDE_BACKEND` routing
 *      (sdk token meter vs cli Agent SDK credit) applies uniformly. A new
 *      direct construction would silently bypass the cli backend's billing.
 *   2. `isClaudeAvailable()` reports the cli backend as available WITHOUT an
 *      ANTHROPIC_API_KEY — the cli backend authenticates via the `claude`
 *      binary, so a raw env check would wrongly skip a usable backend.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isClaudeAvailable } from '../scripts/lib/anthropic-client.mjs';
import { collectMjs } from './helpers/fixtures.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');

// The factory itself legitimately constructs the raw SDK client.
const FACTORY_REL = path.join('lib', 'anthropic-client.mjs');
const NEW_ANTHROPIC_RE = /new\s+Anthropic\s*\(/;

describe('anthropic-client migration guard', () => {
  it('has no bare `new Anthropic()` outside the factory', () => {
    const offenders = [];
    for (const file of collectMjs(SCRIPTS_DIR)) {
      const rel = path.relative(SCRIPTS_DIR, file);
      if (rel === FACTORY_REL) continue;
      const content = fs.readFileSync(file, 'utf-8');
      if (NEW_ANTHROPIC_RE.test(content)) offenders.push(rel);
    }
    assert.deepEqual(
      offenders,
      [],
      `Use createAnthropicClient() instead of new Anthropic() in: ${offenders.join(', ')}`,
    );
  });

  describe('isClaudeAvailable()', () => {
    let saved;
    beforeEach(() => {
      saved = {
        CLAUDE_BACKEND: process.env.CLAUDE_BACKEND,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      };
    });
    afterEach(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    it('cli backend is available without an API key', () => {
      process.env.CLAUDE_BACKEND = 'cli';
      delete process.env.ANTHROPIC_API_KEY;
      assert.equal(isClaudeAvailable(), true);
    });

    it('sdk backend without a key is NOT available', () => {
      process.env.CLAUDE_BACKEND = 'sdk';
      delete process.env.ANTHROPIC_API_KEY;
      assert.equal(isClaudeAvailable(), false);
    });

    it('sdk backend with a key is available', () => {
      process.env.CLAUDE_BACKEND = 'sdk';
      process.env.ANTHROPIC_API_KEY = 'sk-test-xxx';
      assert.equal(isClaudeAvailable(), true);
    });

    it('default (unset) backend behaves as sdk', () => {
      delete process.env.CLAUDE_BACKEND;
      delete process.env.ANTHROPIC_API_KEY;
      assert.equal(isClaudeAvailable(), false);
    });
  });
});
