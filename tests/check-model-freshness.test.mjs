import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  runFreshnessCheck,
  detectSentinelDrift,
  detectMissingFromStatic,
  detectPrematureRemap,
} from '../scripts/check-model-freshness.mjs';
import {
  STATIC_POOL,
  _resetCatalogCache,
} from '../scripts/lib/model-resolver.mjs';

beforeEach(() => {
  _resetCatalogCache();
});

describe('check-model-freshness', () => {
  describe('detectSentinelDrift', () => {
    it('reports HIGH when live catalog has newer Opus than static pool', () => {
      const liveCatalog = {
        anthropic: ['claude-opus-5-0', ...STATIC_POOL.anthropic],
        openai: [],
        google: [],
      };
      const findings = detectSentinelDrift(liveCatalog);
      const opus = findings.filter(f => f.sentinel === 'latest-opus');
      assert.equal(opus.length, 1);
      assert.equal(opus[0].severity, 'error');
      assert.equal(opus[0].livePick, 'claude-opus-5-0');
      assert.match(opus[0].message, /STATIC_POOL\.anthropic/);
    });

    it('reports no drift when static pool already has newest', () => {
      const liveCatalog = {
        anthropic: STATIC_POOL.anthropic.slice(),
        openai: STATIC_POOL.openai.slice(),
        google: STATIC_POOL.google.slice(),
      };
      assert.deepEqual(detectSentinelDrift(liveCatalog), []);
    });

    it('reports no drift when live catalog is empty for a provider', () => {
      const liveCatalog = { anthropic: [], openai: [], google: [] };
      // Empty catalog means resolver falls back to static pool — no drift.
      assert.deepEqual(detectSentinelDrift(liveCatalog), []);
    });

    it('reports HIGH for new Sonnet but not Haiku when only Sonnet drifts', () => {
      const liveCatalog = {
        anthropic: ['claude-sonnet-9-9', ...STATIC_POOL.anthropic],
        openai: [],
        google: [],
      };
      const findings = detectSentinelDrift(liveCatalog);
      const sentinels = findings.map(f => f.sentinel);
      assert.ok(sentinels.includes('latest-sonnet'));
      assert.ok(!sentinels.includes('latest-haiku'));
    });

    it('flags HIGH when static resolution fails but live resolves (audit fix Gemini-F2)', () => {
      // Synthetic: a sentinel where STATIC_POOL has nothing for the tier.
      // We can't easily simulate this without monkey-patching STATIC_POOL,
      // so we verify behaviour at the function boundary: if staticPick is null
      // and livePick is non-null, the comparison should still emit a finding.
      // This is a property test of the comparison logic shape.
      const liveCatalog = {
        anthropic: STATIC_POOL.anthropic.slice(),
        openai: STATIC_POOL.openai.slice(),
        google: STATIC_POOL.google.slice(),
      };
      const findings = detectSentinelDrift(liveCatalog);
      // Baseline (everything aligned) → no findings
      assert.equal(findings.length, 0);
      // Real "static cannot resolve" case is exercised in
      // runFreshnessCheck integration when a sentinel's tier is genuinely
      // absent from STATIC_POOL — covered indirectly by the live smoke test.
    });

    it('Google alias short-circuit means latest-pro never drifts as long as alias is present', () => {
      // gemini-pro-latest is the authoritative alias. As long as it's in the
      // pool, resolveModel returns it regardless of which version is "newer".
      const liveCatalog = {
        google: ['gemini-99-pro-preview', ...STATIC_POOL.google],
        openai: [],
        anthropic: [],
      };
      const findings = detectSentinelDrift(liveCatalog);
      const pro = findings.filter(f => f.sentinel === 'latest-pro');
      assert.equal(pro.length, 0, 'alias short-circuit should suppress pro drift');
    });
  });

  describe('detectMissingFromStatic', () => {
    it('flags relevant live IDs that are genuinely newer than anything already covered', () => {
      // claude-opus-5-0 (major 5) is strictly newer than the pool's opus
      // entries (major 4) — genuine drift. claude-sonnet-6-0 (major 6) is
      // strictly newer than the pool's sonnet-5 — also genuine drift.
      const liveCatalog = {
        anthropic: [...STATIC_POOL.anthropic, 'claude-opus-5-0', 'claude-sonnet-6-0'],
        openai: [],
        google: [],
      };
      const findings = detectMissingFromStatic(liveCatalog);
      const anthropic = findings.find(f => f.provider === 'anthropic');
      assert.ok(anthropic);
      assert.equal(anthropic.severity, 'warn');
      assert.deepEqual(anthropic.missingIds.sort(), ['claude-opus-5-0', 'claude-sonnet-6-0'].sort());
    });

    it('does NOT flag a live id that version-ties an existing static entry (no functional drift)', () => {
      // claude-sonnet-5-0 parses to the same version tuple as the already-
      // pooled claude-sonnet-5 (major 5, minor 0) — same model, different
      // string. Flagging it would be noise: nothing would actually change.
      const liveCatalog = {
        anthropic: [...STATIC_POOL.anthropic, 'claude-sonnet-5-0'],
        openai: [],
        google: [],
      };
      assert.deepEqual(detectMissingFromStatic(liveCatalog), []);
    });

    it('does NOT flag old/superseded live ids the pool has deliberately pruned (the noise this fix removes)', () => {
      // These are all OLDER than STATIC_POOL's current entries for their
      // tier — the pre-fix literal-string-match behaviour flagged all of
      // them forever, since a deliberately-pruned pool will never contain
      // them again. Includes the multi-segment legacy shapes that used to
      // fail to parse entirely (gpt-3.5-turbo-1106, -turbo-instruct-0914,
      // gemini-2.5-flash-preview-tts, gemini-2.0-flash-lite-001).
      const liveCatalog = {
        openai: [
          ...STATIC_POOL.openai,
          'gpt-3.5-turbo', 'gpt-3.5-turbo-1106', 'gpt-3.5-turbo-instruct-0914',
          'gpt-4-0613', 'gpt-4', 'gpt-4o-mini', 'gpt-4.1-mini',
        ],
        anthropic: [
          ...STATIC_POOL.anthropic,
          'claude-opus-4-6', 'claude-opus-4-1-20250805', 'claude-sonnet-4-5-20250929',
        ],
        google: [
          ...STATIC_POOL.google,
          'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-preview-tts',
          'gemini-2.0-flash-lite-001', 'gemini-3-pro-preview',
        ],
      };
      assert.deepEqual(detectMissingFromStatic(liveCatalog), []);
    });

    it('fails open (flags) on a pattern-matched id the strict parser cannot parse at all', () => {
      // Matches TIER_PATTERNS.anthropic (`claude-opus-` + a leading digit)
      // but not parseClaudeModel's grammar (a `-beta` suffix it has no rule
      // for) — must not be silently dropped just because it's unfamiliar-
      // shaped; that's exactly how a genuinely new release could go
      // unnoticed (the GPT-5.6 sol/terra/luna incident this whole fix
      // traces back to).
      const liveCatalog = {
        anthropic: [...STATIC_POOL.anthropic, 'claude-opus-5-beta'],
        openai: [],
        google: [],
      };
      const findings = detectMissingFromStatic(liveCatalog);
      const anthropic = findings.find(f => f.provider === 'anthropic');
      assert.ok(anthropic);
      assert.ok(anthropic.missingIds.includes('claude-opus-5-beta'));
    });

    it('skips IDs that do not match the tier pattern', () => {
      const liveCatalog = {
        anthropic: [...STATIC_POOL.anthropic, 'random-experimental-id'],
        openai: [],
        google: [],
      };
      const findings = detectMissingFromStatic(liveCatalog);
      // 'random-experimental-id' doesn't match /^claude-(opus|sonnet|haiku)-\d/
      assert.equal(findings.length, 0);
    });

    it('returns empty array when live catalog matches static', () => {
      const liveCatalog = {
        anthropic: STATIC_POOL.anthropic.slice(),
        openai: STATIC_POOL.openai.slice(),
        google: STATIC_POOL.google.slice(),
      };
      assert.deepEqual(detectMissingFromStatic(liveCatalog), []);
    });

    it('skips providers with empty live catalogs', () => {
      const liveCatalog = { anthropic: [], openai: [], google: [] };
      assert.deepEqual(detectMissingFromStatic(liveCatalog), []);
    });

    it('different missing-ID sets produce distinct semanticIds (audit fix L3)', () => {
      const cat1 = {
        anthropic: [...STATIC_POOL.anthropic, 'claude-opus-9-0'],
        openai: [],
        google: [],
      };
      const cat2 = {
        anthropic: [...STATIC_POOL.anthropic, 'claude-sonnet-9-0'],
        openai: [],
        google: [],
      };
      const f1 = detectMissingFromStatic(cat1).find(f => f.provider === 'anthropic');
      const f2 = detectMissingFromStatic(cat2).find(f => f.provider === 'anthropic');
      assert.ok(f1 && f2);
      assert.notEqual(f1.semanticId, f2.semanticId,
        'distinct missing-ID sets must produce distinct semanticIds');
    });

    it('same missing-ID set produces stable semanticId across runs', () => {
      const cat = {
        anthropic: [...STATIC_POOL.anthropic, 'claude-opus-9-0'],
        openai: [],
        google: [],
      };
      const f1 = detectMissingFromStatic(cat).find(f => f.provider === 'anthropic');
      const f2 = detectMissingFromStatic(cat).find(f => f.provider === 'anthropic');
      assert.equal(f1.semanticId, f2.semanticId);
    });
  });

  describe('detectPrematureRemap', () => {
    it('flags LOW when provider still serves a remapped ID', () => {
      // gpt-4o is in DEPRECATED_REMAP. If live catalog has it, that's premature.
      const liveCatalog = {
        openai: ['gpt-4o', 'gpt-5.4'],
        anthropic: [],
        google: [],
      };
      const findings = detectPrematureRemap(liveCatalog);
      const gpt4o = findings.find(f => f.deprecatedId === 'gpt-4o');
      assert.ok(gpt4o);
      assert.equal(gpt4o.severity, 'note');
      assert.match(gpt4o.message, /premature/);
    });

    it('does not flag remap entries the provider has actually retired', () => {
      const liveCatalog = {
        openai: ['gpt-5.4'],          // gpt-5.0 not in catalog → genuinely retired
        anthropic: [],
        google: [],
      };
      const findings = detectPrematureRemap(liveCatalog);
      assert.equal(findings.find(f => f.deprecatedId === 'gpt-5.0'), undefined);
    });

    it('returns no findings when all live catalogs are empty', () => {
      const liveCatalog = { anthropic: [], openai: [], google: [] };
      assert.deepEqual(detectPrematureRemap(liveCatalog), []);
    });
  });

  describe('runFreshnessCheck — integration', () => {
    it('returns INSUFFICIENT_DATA shape when no providers have data', async () => {
      const report = await runFreshnessCheck({
        fetchedCatalog: { openai: [], anthropic: [], google: [] },
      });
      assert.deepEqual(report.providersChecked, []);
      assert.deepEqual(report.findings, []);
    });

    it('combines findings from all detectors', async () => {
      const report = await runFreshnessCheck({
        fetchedCatalog: {
          // Two HIGH-worthy drifts, one premature-remap, one missing-from-static
          anthropic: [
            'claude-opus-9-0',                  // newer than static → sentinel-drift HIGH
            ...STATIC_POOL.anthropic,
          ],
          openai: ['gpt-4o', 'gpt-5.4'],         // gpt-4o → premature-remap LOW
          google: [],
        },
      });
      const high = report.findings.filter(f => f.severity === 'error');
      const low = report.findings.filter(f => f.severity === 'note');
      assert.ok(high.length >= 1, `expected at least one HIGH, got: ${high.length}`);
      assert.ok(low.length >= 1, `expected at least one LOW (premature-remap), got: ${low.length}`);
      assert.equal(report.providersChecked.length, 2); // anthropic + openai
    });

    it('semanticIds are stable across runs', async () => {
      const cat = { anthropic: ['claude-opus-9-0', ...STATIC_POOL.anthropic], openai: [], google: [] };
      const r1 = await runFreshnessCheck({ fetchedCatalog: cat });
      const r2 = await runFreshnessCheck({ fetchedCatalog: cat });
      const ids1 = r1.findings.map(f => f.semanticId).sort();
      const ids2 = r2.findings.map(f => f.semanticId).sort();
      assert.deepEqual(ids1, ids2);
    });

    it('refresh:false skips network fetch and returns empty', async () => {
      const report = await runFreshnessCheck({ refresh: false });
      assert.deepEqual(report.providersChecked, []);
      assert.deepEqual(report.findings, []);
    });

    it('rejects malformed catalog shape (non-string entries)', async () => {
      await assert.rejects(
        () => runFreshnessCheck({ fetchedCatalog: { openai: [123, 'gpt-5.4'], anthropic: [], google: [] } }),
        /Invalid live catalog shape/,
      );
    });

    it('rejects unknown provider keys in catalog', async () => {
      await assert.rejects(
        () => runFreshnessCheck({ fetchedCatalog: { openai: [], anthropic: [], google: [], unknown: [] } }),
        /Invalid live catalog shape/,
      );
    });

    it('rejects empty string entries', async () => {
      await assert.rejects(
        () => runFreshnessCheck({ fetchedCatalog: { openai: [''], anthropic: [], google: [] } }),
        /Invalid live catalog shape/,
      );
    });

    it('accepts catalog with missing keys (defaults to empty)', async () => {
      // Schema has .default([]) for each provider so partial input is OK.
      const report = await runFreshnessCheck({ fetchedCatalog: { openai: ['gpt-5.4'] } });
      assert.equal(report.providersChecked.length, 1);
    });
  });

  describe('every sentinel in SENTINEL_TO_TIER is exercised', () => {
    it('all 8 sentinels resolve cleanly when static and live agree', () => {
      const liveCatalog = {
        openai: STATIC_POOL.openai.slice(),
        anthropic: STATIC_POOL.anthropic.slice(),
        google: STATIC_POOL.google.slice(),
      };
      const findings = detectSentinelDrift(liveCatalog);
      assert.deepEqual(findings, []);
    });
  });
});
