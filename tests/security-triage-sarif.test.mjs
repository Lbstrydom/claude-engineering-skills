/**
 * Phase 1 — SARIF ingestion.
 * Plan: docs/plans/sast-triage-routing.md §9.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ingestSarif,
  SarifIngestError,
  resolveArtifactUri,
  resolveSinkPhysicalLocation,
  ConfigSchema,
  BoundsSchema,
  BOUND_CEILINGS,
  BOUND_DEFAULTS,
  resolveBounds,
} from '../scripts/lib/security/sarif.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.join(HERE, 'fixtures', 'security-triage', 'corpus.sarif');

/** `assert.throws` returns undefined, so capture the error to inspect it. */
function caught(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
}

function sarif(results, runExtra = {}) {
  return {
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'TestTool' } }, results, ...runExtra }],
  };
}

function result(overrides = {}) {
  return {
    ruleId: 'javascript/DOMXSS',
    level: 'warning',
    message: { text: 'flows into innerHTML' },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: 'src/a.js', uriBaseId: '%SRCROOT%' },
          region: { startLine: 10, endLine: 10, startColumn: 1, endColumn: 20 },
        },
      },
    ],
    ...overrides,
  };
}

describe('ingestSarif — document validation', () => {
  test('rejects a non-2.1.0 version as input_malformed', () => {
    const err = caught(() => ingestSarif({ version: '2.0.0', runs: [] }));
    assert.ok(err instanceof SarifIngestError);
    assert.equal(err.runStatus, 'input_malformed');
  });

  test('rejects a non-object root and a missing runs array', () => {
    for (const doc of [null, [], 'x', { version: '2.1.0' }]) {
      const err = caught(() => ingestSarif(doc));
      assert.ok(err instanceof SarifIngestError, String(doc));
      assert.equal(err.runStatus, 'input_malformed');
    }
  });

  test('a valid SARIF with zero results ingests zero findings (the CLI, not the parser, owns `unverified`)', () => {
    const { findings } = ingestSarif(sarif([]));
    assert.deepEqual(findings, []);
  });

  test('all runs are ingested and toolName is retained per finding', () => {
    const doc = {
      version: '2.1.0',
      runs: [
        { tool: { driver: { name: 'Snyk' } }, results: [result()] },
        { tool: { driver: { name: 'Semgrep' } }, results: [result()] },
      ],
    };
    const { findings } = ingestSarif(doc);
    assert.equal(findings.length, 2);
    assert.deepEqual(findings.map((f) => f.toolName), ['Snyk', 'Semgrep']);
  });
});

describe('ingestSarif — bounds', () => {
  // §9 item 9. Refusing is the only option consistent with BOTH the
  // every-finding-appears-once contract and the bound meaning anything.
  test('maxResults exceeded REFUSES the run — no partial prefix', () => {
    const doc = sarif([result(), result(), result()]);
    const err = caught(() => ingestSarif(doc, { bounds: { ...BOUND_DEFAULTS, maxResults: 2 } }));
    assert.ok(err instanceof SarifIngestError);
    assert.equal(err.runStatus, 'unverified');
    assert.match(err.message, /run refused/);
  });

  test('maxResults counts across ALL runs, not per run', () => {
    const doc = {
      version: '2.1.0',
      runs: [
        { tool: { driver: { name: 'A' } }, results: [result(), result()] },
        { tool: { driver: { name: 'B' } }, results: [result(), result()] },
      ],
    };
    assert.throws(
      () => ingestSarif(doc, { bounds: { ...BOUND_DEFAULTS, maxResults: 3 } }),
      SarifIngestError,
    );
  });

  test('maxMessageChars truncates for render and flags it', () => {
    const doc = sarif([result({ message: { text: 'x'.repeat(50) } })]);
    const { findings } = ingestSarif(doc, {
      bounds: { ...BOUND_DEFAULTS, maxMessageChars: 10 },
    });
    assert.equal(findings[0].message.length, 10);
    assert.equal(findings[0].messageTruncated, true);
  });

  test('a bound above its hard ceiling is a config error, never a clamp', () => {
    const over = BOUND_CEILINGS.maxResults + 1;
    assert.equal(BoundsSchema.safeParse({ maxResults: over }).success, false);
    assert.equal(BoundsSchema.safeParse({ maxResults: BOUND_CEILINGS.maxResults }).success, true);
  });

  test('resolveBounds layers config over defaults without mutating them', () => {
    const b = resolveBounds({ bounds: { maxSinkLines: 5 } });
    assert.equal(b.maxSinkLines, 5);
    assert.equal(b.maxResults, BOUND_DEFAULTS.maxResults);
    assert.equal(BOUND_DEFAULTS.maxSinkLines, 12);
  });
});

describe('ConfigSchema', () => {
  const valid = {
    version: 1,
    pathScope: { nonReachableGlobs: ['tests/**'] },
    sinkMismatch: { pairs: [{ ruleId: 'javascript/reDOS', sinkFunction: 'match' }] },
    sanitizerWrapped: { sanitizers: ['esc'] },
  };

  test('accepts a minimal valid config', () => {
    assert.equal(ConfigSchema.safeParse(valid).success, true);
  });

  // `.strict()` is load-bearing: a typo'd key must never silently disable a
  // predicate — that is the "reads as configured when it isn't" failure mode.
  test('rejects an unknown key rather than ignoring it', () => {
    const r = ConfigSchema.safeParse({ ...valid, pathScopes: {} });
    assert.equal(r.success, false);
  });

  test('rejects an unknown key nested inside a predicate section', () => {
    const r = ConfigSchema.safeParse({
      ...valid,
      pathScope: { nonReachableGlobs: [], extra: 1 },
    });
    assert.equal(r.success, false);
  });

  test('an empty sanitizers array is valid and simply never matches', () => {
    const r = ConfigSchema.safeParse({ ...valid, sanitizerWrapped: { sanitizers: [] } });
    assert.equal(r.success, true);
  });
});

describe('resolveArtifactUri', () => {
  const run = {};

  test('resolves a plain repo-relative uri', () => {
    const d = [];
    assert.equal(resolveArtifactUri({ uri: 'src/a.js' }, run, d), 'src/a.js');
  });

  // Measured: the real corpus uses %SRCROOT% with `originalUriBaseIds` ABSENT.
  // Treating it as unresolvable would route 100% of a Snyk run to `A`.
  test('treats an undeclared %SRCROOT% as repoRoot and says so in a diagnostic', () => {
    const d = [];
    assert.equal(resolveArtifactUri({ uri: 'src/a.js', uriBaseId: '%SRCROOT%' }, run, d), 'src/a.js');
    assert.deepEqual(d, ['uribase-repo-root-sentinel:%SRCROOT%']);
  });

  test('prefers a DECLARED originalUriBaseIds entry over the sentinel set', () => {
    const d = [];
    const r = { originalUriBaseIds: { '%SRCROOT%': { uri: 'packages/app/' } } };
    assert.equal(resolveArtifactUri({ uri: 'src/a.js', uriBaseId: '%SRCROOT%' }, r, d), 'packages/app/src/a.js');
  });

  // §9 item 6 — never a guessed path; SC1 depends on this resolving honestly.
  test('an UNKNOWN uriBaseId is unresolvable, with a diagnostic', () => {
    const d = [];
    assert.equal(resolveArtifactUri({ uri: 'a.js', uriBaseId: '%HOME%' }, run, d), null);
    assert.deepEqual(d, ['uribase-unknown:%HOME%']);
  });

  test('a non-file scheme is unresolvable', () => {
    const d = [];
    assert.equal(resolveArtifactUri({ uri: 'https://x/a.js' }, run, d), null);
    assert.match(d[0], /uri-unsupported-scheme:https/);
  });

  test('an absolute path is unresolvable, never joined blindly', () => {
    for (const uri of ['/etc/passwd', 'C:/Windows/x.js', 'file:///etc/passwd']) {
      const d = [];
      assert.equal(resolveArtifactUri({ uri }, run, d), null, uri);
    }
  });

  /**
   * H2 — the fail-open. Stripping the `file://` prefix by string replacement
   * turns the URI's AUTHORITY into a leading path segment, so a REMOTE host
   * becomes the innocuous-looking relative path `evil-host/share/x.js` and is
   * then treated as a repo artifact. SARIF is untrusted input that names the
   * paths we make security decisions about — this is the input SC1 exists to
   * distrust.
   */
  test('a file:// URI with a remote authority is unresolvable, not flattened into a repo path', () => {
    for (const uri of [
      'file://evil-host/share/x.js',
      'file://192.168.1.5/share/x.js',
      'file://attacker.example.com/a/b.js',
    ]) {
      const d = [];
      const got = resolveArtifactUri({ uri }, run, d);
      assert.equal(got, null, `${uri} must not resolve (got ${got})`);
      assert.ok(d.includes('uri-remote-authority'), `${uri}: ${JSON.stringify(d)}`);
    }
  });

  test('a localhost file:// authority is still absolute, hence unresolvable here', () => {
    const d = [];
    assert.equal(resolveArtifactUri({ uri: 'file://localhost/etc/passwd' }, run, d), null);
    assert.ok(d.includes('uri-absolute'));
  });

  // L1 — the escape test is on the `..` SEGMENT, not the `..` PREFIX. A file
  // whose name merely begins with two dots is a legitimate repo path.
  test('a filename beginning with two dots is not mistaken for traversal', () => {
    const d = [];
    assert.equal(resolveArtifactUri({ uri: '..reports/tests/x.js' }, run, d), '..reports/tests/x.js');
    assert.deepEqual(d, []);
  });

  test('a traversal that escapes the frame is unresolvable, not normalised into a guess', () => {
    const d = [];
    assert.equal(resolveArtifactUri({ uri: '../../etc/passwd' }, run, d), null);
    assert.deepEqual(d, ['uri-escapes-root']);
  });

  test('interior traversal that stays inside the frame collapses honestly', () => {
    const d = [];
    assert.equal(resolveArtifactUri({ uri: 'src/x/../a.js' }, run, d), 'src/a.js');
  });

  test('a missing or empty uri is unresolvable', () => {
    for (const al of [{}, { uri: '' }, null]) {
      const d = [];
      assert.equal(resolveArtifactUri(al, run, d), null);
    }
  });
});

describe('resolveSinkPhysicalLocation — D3a0', () => {
  const step = (uri, line) => ({
    location: {
      physicalLocation: {
        artifactLocation: { uri, uriBaseId: '%SRCROOT%' },
        region: { startLine: line, endLine: line },
      },
    },
  });

  test('rule 1: the terminal code-flow step wins over the primary location', () => {
    const r = result({
      codeFlows: [{ threadFlows: [{ locations: [step('src/a.js', 1), step('src/sink.js', 99)] }] }],
    });
    const { physicalLocation, mode } = resolveSinkPhysicalLocation(r);
    assert.equal(mode, 'codeflow');
    assert.equal(physicalLocation.artifactLocation.uri, 'src/sink.js');
  });

  // A sink in a DIFFERENT file is normal — 17.5% of the real corpus. An
  // earlier draft rejected it, which would have forced them all to `A`.
  test('a cross-file sink is supported, not rejected', () => {
    const r = result({
      codeFlows: [{ threadFlows: [{ locations: [step('src/source.js', 1), step('lib/other.js', 5)] }] }],
    });
    assert.equal(resolveSinkPhysicalLocation(r).mode, 'codeflow');
  });

  test('agreeing terminals across MULTIPLE codeFlows resolve (producer-agnostic insurance)', () => {
    const r = result({
      codeFlows: [
        { threadFlows: [{ locations: [step('src/a.js', 1), step('src/sink.js', 9)] }] },
        { threadFlows: [{ locations: [step('src/b.js', 2), step('src/sink.js', 9)] }] },
      ],
    });
    assert.equal(resolveSinkPhysicalLocation(r).mode, 'codeflow');
  });

  test('DISAGREEING terminals are unresolved — the honest default', () => {
    const r = result({
      codeFlows: [
        { threadFlows: [{ locations: [step('src/sink1.js', 9)] }] },
        { threadFlows: [{ locations: [step('src/sink2.js', 4)] }] },
      ],
    });
    const { physicalLocation, mode } = resolveSinkPhysicalLocation(r);
    assert.equal(mode, 'unresolved');
    assert.equal(physicalLocation, null);
  });

  test('rule 2: with no codeFlows, exactly one location is the sink', () => {
    assert.equal(resolveSinkPhysicalLocation(result()).mode, 'single');
  });

  test('rule 3: no codeFlows and several locations is unresolved', () => {
    const r = result({ locations: [result().locations[0], result().locations[0]] });
    assert.equal(resolveSinkPhysicalLocation(r).mode, 'unresolved');
  });

  test('rule 3: no locations at all is unresolved', () => {
    assert.equal(resolveSinkPhysicalLocation(result({ locations: [] })).mode, 'unresolved');
  });
});

describe('ingestSarif — finding shape', () => {
  // §9 item 7 (audit R2-H2).
  test('a locationless result survives ingestion with location null and rawLocation kept', () => {
    const { findings } = ingestSarif(sarif([result({ locations: [] })]));
    assert.equal(findings.length, 1);
    assert.equal(findings[0].location, null);
    assert.equal(findings[0].sinkLocation, null);
    assert.equal(findings[0].sinkResolution, 'unresolved');
    assert.equal(findings[0].rawLocation, '[]');
  });

  test('an unresolvable URI keeps the finding, nulls the location, and records a diagnostic', () => {
    const { findings } = ingestSarif(
      sarif([result({ locations: [{ physicalLocation: { artifactLocation: { uri: 'https://x/a.js' } } }] })]),
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].location, null);
    assert.ok(findings[0].diagnostics.some((d) => d.startsWith('uri-unsupported-scheme')));
  });

  // §9 item 8 (audit R2-M3): identity is per OCCURRENCE, so duplicate
  // preservation and per-occurrence routing can both be verified.
  test('byte-identical duplicate results stay distinct via occurrenceIndex', () => {
    const { findings } = ingestSarif(sarif([result(), result()]));
    assert.deepEqual(findings.map((f) => f.occurrenceIndex), [0, 1]);
    assert.notEqual(findings[0].findingId, findings[1].findingId);
  });

  test('occurrenceIndex counts in document order per content hash, independently per hash', () => {
    const other = result({ ruleId: 'javascript/Sqli' });
    const { findings } = ingestSarif(sarif([result(), other, result()]));
    assert.deepEqual(
      findings.map((f) => [f.ruleId, f.occurrenceIndex]),
      [['javascript/DOMXSS', 0], ['javascript/Sqli', 0], ['javascript/DOMXSS', 1]],
    );
  });

  // SC2: the renderer consumes only this object, so an unredacted message
  // would carry a secret straight to stdout, a saved report, or a chat paste.
  test('message and rawLocation are redacted at the boundary where they first exist', () => {
    const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const { findings } = ingestSarif(
      sarif([result({ message: { text: `token ${secret} found` } })]),
    );
    assert.ok(!findings[0].message.includes(secret), 'secret must not survive in message');
  });

  test('a region without endLine falls back to startLine rather than dropping the region', () => {
    const r = result({
      locations: [{ physicalLocation: { artifactLocation: { uri: 'src/a.js' }, region: { startLine: 7 } } }],
    });
    const { findings } = ingestSarif(sarif([r]));
    assert.deepEqual(findings[0].location.region, {
      startLine: 7, startColumn: null, endLine: 7, endColumn: null,
    });
  });
});

describe('ingestSarif — the real 240-result corpus', () => {
  // Explicit generous timeout: this test's cost scales with machine load, not
  // logic — the profile that produces rotating flakes under parallel runners.
  const opts = { timeout: 30_000 };

  // Parsed and ingested ONCE for the whole suite. Re-reading a 908 KB fixture
  // per test is load this file contributes to every OTHER suite running in
  // parallel, which is the same flake mechanism the timeout above guards
  // against — worth not causing as well as not suffering.
  let findings;
  const corpus = () => {
    if (!findings) findings = ingestSarif(JSON.parse(fs.readFileSync(CORPUS, 'utf8'))).findings;
    return findings;
  };

  test('ingests every result exactly once', opts, () => {
    assert.equal(corpus().length, 240);
    assert.equal(new Set(corpus().map((f) => f.findingId)).size, 240);
  });

  // These three re-derive §2b's measurements through the shipped code path
  // rather than the ad-hoc script that produced them. Same input, different
  // derivation: this pins the IMPLEMENTATION to the measured design, and a
  // producer change that moves any of them should fail here loudly.
  test('reproduces the §2b measurements: 42 cross-file sinks, 95 producer test signals', opts, () => {
    const findings = corpus();

    const crossFile = findings.filter(
      (f) => f.location && f.sinkLocation && f.location.path !== f.sinkLocation.path,
    );
    assert.equal(crossFile.length, 42, 'cross-file sinks (§2b: 17.5% of 240)');

    const producerTest = findings.filter((f) => /\/test$/.test(f.ruleId));
    assert.equal(producerTest.length, 95, 'producer /test signals (§2b: 39.6%)');
    assert.ok(producerTest.every((f) => f.level === 'note'), 'all 95 are note level');
  });

  test('every corpus finding resolves its sink via a code flow, and none is locationless', opts, () => {
    const findings = corpus();
    assert.ok(findings.every((f) => f.sinkResolution === 'codeflow'));
    assert.ok(findings.every((f) => f.location !== null));
  });
});
