/**
 * @fileoverview `finalReviewModelSpec` / `finalReviewTimeoutMs` — the single
 * reader for the final reviewer's model and timeout, and the canonical/alias
 * precedence it owns.
 *
 * THE DEFECT THIS CLOSES (measured 2026-09-07). The setting had TWO defaults.
 * `config.mjs` moved to `latest-flash` when the gate switched tiers; a second
 * copy in `gemini-review.mjs` still read `process.env.GEMINI_REVIEW_MODEL ||
 * 'latest-pro'` and re-resolved it after the live-catalog refresh — so every
 * run started on flash, then silently reassigned MODEL back to pro and printed
 * it as an "upgraded Gemini reviewer" notice. The switch was undone at runtime
 * by its own upgrade path, and nothing failed.
 *
 * The rename is the smaller half. `FINAL_REVIEW_MODEL` is canonical because the
 * role is provider-agnostic in behaviour (FINAL_REVIEW_PROVIDER, selectProvider,
 * an Opus fallback, a grok shadow arm) while its env vars were named after one
 * vendor; `GEMINI_REVIEW_MODEL` remains a working alias so nothing must be
 * renamed to keep running.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_FINAL_REVIEW_TIMEOUT_MS, finalReviewModelSpec, finalReviewTimeoutMs } from '../scripts/lib/final-review-config.mjs';
import { _resetAliasWarnings } from '../scripts/lib/env-alias.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('finalReviewModelSpec — canonical/alias precedence', () => {
  it('returns the committed default when neither var is set', () => {
    // latest-pro: the best available Gemini, resolved at runtime (owner decision 2026-10-10;
    // experiment-6 §9). A sentinel, never a concrete id.
    assert.equal(finalReviewModelSpec({}), 'latest-pro');
  });

  it('honours the canonical name', () => {
    assert.equal(finalReviewModelSpec({ FINAL_REVIEW_MODEL: 'latest-opus' }), 'latest-opus');
  });

  it('honours the deprecated alias', () => {
    _resetAliasWarnings();
    assert.equal(finalReviewModelSpec({ GEMINI_REVIEW_MODEL: 'latest-pro' }), 'latest-pro');
  });

  it('canonical WINS when both are set', () => {
    _resetAliasWarnings();
    assert.equal(
      finalReviewModelSpec({ FINAL_REVIEW_MODEL: 'latest-opus', GEMINI_REVIEW_MODEL: 'latest-pro' }),
      'latest-opus',
    );
  });

  it('treats an EMPTY canonical as absent and falls through to the alias', () => {
    // A GitHub Actions `env:` entry for a missing secret expands to
    // empty-but-set. Without this, an empty canonical would win as '' and the
    // alias a consumer actually set would be ignored.
    _resetAliasWarnings();
    assert.equal(
      finalReviewModelSpec({ FINAL_REVIEW_MODEL: '', GEMINI_REVIEW_MODEL: 'latest-pro' }),
      'latest-pro',
    );
  });

  it('warns EXACTLY once per process, and only when the alias contributed', () => {
    _resetAliasWarnings();
    const lines = [];
    const write = (m) => lines.push(m);
    // Canonical set: the alias did not contribute, so no notice. A warning that
    // fires when the alias was set but unused trains people to ignore it.
    finalReviewModelSpec({ FINAL_REVIEW_MODEL: 'latest-opus', GEMINI_REVIEW_MODEL: 'latest-pro' }, { write });
    assert.equal(lines.length, 0, 'must not warn when the canonical won');
    // Alias alone contributes: exactly one notice, however many reads (audit R1-M2: the writer
    // used to be unconnected, so this test could not fail).
    finalReviewModelSpec({ GEMINI_REVIEW_MODEL: 'latest-pro' }, { write });
    finalReviewModelSpec({ GEMINI_REVIEW_MODEL: 'latest-pro' }, { write });
    assert.equal(lines.length, 1, 'one notice per process when the alias contributed');
    assert.match(lines[0], /GEMINI_REVIEW_MODEL/);
  });

  it('a timeout is a positive whole number of ms within the cap, else the default (R1-H1/M1)', () => {
    for (const bad of ['-1', '0', '1.5', '1e5', 'abc', ' ', String(MAX_FINAL_REVIEW_TIMEOUT_MS + 1)]) {
      assert.equal(finalReviewTimeoutMs({ FINAL_REVIEW_TIMEOUT_MS: bad }), 270000, JSON.stringify(bad));
    }
    assert.equal(finalReviewTimeoutMs({ FINAL_REVIEW_TIMEOUT_MS: '300000' }), 300000);
    assert.equal(finalReviewTimeoutMs({ FINAL_REVIEW_TIMEOUT_MS: String(MAX_FINAL_REVIEW_TIMEOUT_MS) }), MAX_FINAL_REVIEW_TIMEOUT_MS);
  });
});

describe('finalReviewTimeoutMs', () => {
  it('defaults to the coupled 270s value', () => {
    // Coupled to FINAL_REVIEW_HARD_DEADLINE_MS: the watchdog floor is
    // 2*timeout + 60000, so 270s is the most the 600s default admits.
    assert.equal(finalReviewTimeoutMs({}), 270000);
  });

  it('reads canonical, then alias', () => {
    _resetAliasWarnings();
    assert.equal(finalReviewTimeoutMs({ FINAL_REVIEW_TIMEOUT_MS: '90000' }), 90000);
    assert.equal(finalReviewTimeoutMs({ GEMINI_REVIEW_TIMEOUT_MS: '80000' }), 80000);
  });

  it('falls back to the default on a non-numeric value rather than NaN', () => {
    assert.equal(finalReviewTimeoutMs({ FINAL_REVIEW_TIMEOUT_MS: 'soon' }), 270000);
  });
});

describe('one default, one reader (the regression this closes)', () => {
  it('gemini-review.mjs no longer carries its own default for the model', () => {
    // A source assertion, deliberately: the defect was two spellings of one
    // default in two files, and nothing that could compare them. Importing the
    // module cannot detect a second literal; reading it can.
    const src = fs.readFileSync(path.join(repoRoot, 'scripts', 'gemini-review.mjs'), 'utf8');
    const offenders = src
      .split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => /process\.env\.(GEMINI_REVIEW_MODEL|FINAL_REVIEW_MODEL)\s*\|\|/.test(line));
    assert.deepEqual(
      offenders, [],
      'gemini-review.mjs must resolve the model through finalReviewModelSpec(), not a local default',
    );
  });

  it('config.mjs resolves the model through the shared spec, not a raw env read', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'scripts', 'lib', 'config.mjs'), 'utf8');
    assert.match(src, /model: resolveModel\(finalReviewModelSpec\(\)\)/);
  });
});
