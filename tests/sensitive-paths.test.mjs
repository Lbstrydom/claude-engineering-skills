/**
 * @fileoverview sensitive-paths.mjs canonical-classifier tests.
 * Plan: docs/plans/sustainability-cleanup-batch.md WS3.
 *
 * Coverage:
 *  - Per-pattern positive + negative fixtures
 *  - classifyPath three-way return (sensitive | generatedNoise | null)
 *  - filterDiffFiles 12-case state-aware matrix (incl. tombstone preservation)
 *  - filterDiffFiles idempotency property
 *  - formatSkipLog default aggregates / debug hash-only / generatedNoise paths in full
 *  - Superset gate vs legacy quickfix + sensitive-egress-gate denylists
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPath,
  shouldSkipForIndexing,
  filterDiffFiles,
  formatSkipLog,
  normalisePath,
  SENSITIVE_PATTERNS,
  GENERATED_NOISE_PATTERNS,
  DRIFT_EXEMPT_PATTERNS,
  _resetDebugBanner,
} from '../scripts/lib/sensitive-paths.mjs';

// Historical snapshot of the legacy `SENSITIVE_PATH_PATTERNS` array that
// lived in `scripts/lib/quickfix-patterns.mjs` BEFORE the WS3 migration to
// the canonical predicate. Frozen here so the superset gate continues to
// catch a regression where the new patterns silently stop covering a case
// the legacy ones used to catch. DO NOT change unless you are also
// updating `SENSITIVE_PATTERNS` to remain a strict superset.
const LEGACY_QUICKFIX_PATTERNS = Object.freeze([
  /(^|\/)\.env(\..+)?$/,
  /(^|\/)\.env\.local$/,
  /(^|\/)secrets?\.(json|yaml|yml|txt|env)$/,
  /(^|\/)credentials?\..+$/,
  /\.(pem|key|crt|p12|pfx)$/,
  /(^|\/)(secrets|credentials|\.aws|\.ssh)\//,
]);

describe('normalisePath', () => {
  it('lowercases + forward-slashes + strips drive', () => {
    assert.equal(normalisePath('C:\\GIT\\Foo\\.env'), 'git/foo/.env');
    assert.equal(normalisePath('./src/foo.ts'), 'src/foo.ts');
    assert.equal(normalisePath('Src/Foo.TS'), 'src/foo.ts');
  });
  it('returns empty string for falsy input', () => {
    assert.equal(normalisePath(null), '');
    assert.equal(normalisePath(undefined), '');
    assert.equal(normalisePath(''), '');
  });
});

describe('classifyPath — sensitive positives', () => {
  const cases = [
    '.env', '.env.local', '.env.production',
    'app/.env', 'secrets/api-key.json',
    'config/secrets.yaml', 'credentials.json',
    'app/credentials.yaml', 'config/credential',
    'foo.env', 'bar.local.env',
    'secrets/api.pem', 'tls/server.crt', 'tls/server.key',
    'gpg/private.gpg', 'gpg/key.asc',
    'cert.cer', 'cert.der', 'cert.p12', 'cert.pfx',
    '.aws/credentials', '.ssh/known_hosts',
    'private/foo.txt',
    'home/.ssh/id_rsa', 'home/.ssh/id_rsa.pub', 'home/.ssh/id_rsa.bak',
    'home/.ssh/id_ed25519', 'home/.ssh/id_ed25519.pub',
    'password.txt', 'token.json',
    'config/tokens/api.json',
    'tokens.yaml', 'auth/tokens', 'service/token.txt',
    'app/secret-keys/main.yaml', 'app/credential-store/db.yaml', // Gemini H4 — variant secret/credential dirs
  ];
  for (const p of cases) {
    it(`classifies ${p} as sensitive`, () => {
      assert.equal(classifyPath(p), 'sensitive', `failed for ${p}`);
    });
  }
});

// 2026-08-24 final-review-scoped-2026q3 adjudicated finding: the credential/
// secret regexes admitted no leading dot, so the REAL GitHub Actions runner
// registration files (tests/fixtures/runner/synthetic-install/.credentials,
// .credentials_rsaparams) classified as null — a fail-open on this module's
// documented fail-closed contract. The class is "dot-prefixed
// credential-shaped basename", not these two literal names.
describe('classifyPath — dot-prefixed credential/secret basenames (fail-open regression)', () => {
  const positives = [
    '.credentials',
    '.credentials_rsaparams',
    '.secrets',
    'tests/fixtures/runner/synthetic-install/.credentials',
    'tests/fixtures/runner/synthetic-install/.credentials_rsaparams',
  ];
  for (const p of positives) {
    it(`classifies ${p} as sensitive`, () => {
      assert.equal(classifyPath(p), 'sensitive', `failed for ${p}`);
    });
  }

  // Boundary: a longer word that merely starts with "credentials" must not
  // false-positive just because it happens to follow a dot.
  const negatives = [
    '.credentialsomething',
  ];
  for (const p of negatives) {
    it(`does NOT classify ${p} as sensitive`, () => {
      assert.notEqual(classifyPath(p), 'sensitive', `${p} unexpectedly classified as sensitive`);
    });
  }
});

describe('classifyPath — sensitive negatives', () => {
  const cases = [
    'src/env-config.ts',    // contains "env" but isn't .env
    'src/keystore.ts',       // contains "key" but no .key extension
    'src/credential-helper.ts',  // contains "credential" but isn't `credentials*`
    'src/secrets-manager.ts',     // not bare `secrets*`
    'src/private-helper.ts',      // not under `private/`
    'src/tokenizer/utils.js',      // `tokens?` followed by `i`, not `[/.]`
    'src/password-strength/check.mjs', // `password` followed by `-`
    'lib/detokenize.mjs',          // no `^` or `/` before `token`
    'lib/visual/tokens.mjs',       // design-token CODE module — carved out 2026-07-12
    'src/design/tokens.ts',        // design-token code module
    'styles/tokens.css',           // design-token stylesheet
    'theme/tokens.scss',           // design-token stylesheet
    'lib/visual/tokens.d.ts',      // declaration file for a tokens module
    'src/foo.ts', 'README.md', 'package.json',
    'docs/security-strategy.md',
  ];
  for (const p of cases) {
    it(`does NOT classify ${p} as sensitive`, () => {
      const c = classifyPath(p);
      // Sensitive must NOT match for these.
      assert.notEqual(c, 'sensitive', `${p} unexpectedly classified as sensitive`);
    });
  }
});

describe('classifyPath — generatedNoise positives', () => {
  const cases = [
    'package-lock.json',
    'app/package-lock.json',
    'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
    'dist/bundle.min.js', 'dist/bundle.js.map',
  ];
  for (const p of cases) {
    it(`classifies ${p} as generatedNoise`, () => {
      assert.equal(classifyPath(p), 'generatedNoise', `failed for ${p}`);
    });
  }
});

describe('classifyPath — non-matches', () => {
  it('returns null for benign paths', () => {
    for (const p of ['src/foo.ts', 'README.md', 'scripts/build.mjs', 'tests/foo.test.mjs']) {
      assert.equal(classifyPath(p), null, `${p} should not match`);
    }
  });
  it('returns null for empty/null input', () => {
    assert.equal(classifyPath(''), null);
    assert.equal(classifyPath(null), null);
    assert.equal(classifyPath(undefined), null);
  });
});

describe('shouldSkipForIndexing', () => {
  it('respects category opt-in: sensitive only', () => {
    assert.equal(shouldSkipForIndexing('.env', ['sensitive']).skip, true);
    assert.equal(shouldSkipForIndexing('package-lock.json', ['sensitive']).skip, false);
  });
  it('respects category opt-in: both', () => {
    assert.equal(shouldSkipForIndexing('.env', ['sensitive', 'generatedNoise']).skip, true);
    assert.equal(shouldSkipForIndexing('package-lock.json', ['sensitive', 'generatedNoise']).skip, true);
  });
  it('returns {skip:false} when categories array is empty or missing', () => {
    assert.equal(shouldSkipForIndexing('.env', []).skip, false);
    assert.equal(shouldSkipForIndexing('.env', null).skip, false);
    assert.equal(shouldSkipForIndexing('.env').skip, false);
  });
  it('carries category + pattern on hit', () => {
    const r = shouldSkipForIndexing('.env.local', ['sensitive']);
    assert.equal(r.skip, true);
    assert.equal(r.category, 'sensitive');
    assert.ok(r.pattern instanceof RegExp);
  });

  it('driftExempt category skips docs/plans/security/files paths only when opted in', () => {
    const p = 'docs/plans/security/files/scripts/lib/store/security.mjs';
    assert.equal(shouldSkipForIndexing(p, ['sensitive', 'generatedNoise']).skip, false);
    const r = shouldSkipForIndexing(p, ['sensitive', 'generatedNoise', 'driftExempt']);
    assert.equal(r.skip, true);
    assert.equal(r.category, 'driftExempt');
    assert.ok(r.pattern instanceof RegExp);
  });

  it('driftExempt does not affect classifyPath (scoped to shouldSkipForIndexing only)', () => {
    // Deliberate design choice: driftExempt is NOT wired into the general-purpose
    // classifyPath used by ~15 egress/security call sites — only the indexing-skip
    // predicate opts into it, so adding an exemption can never change egress behaviour.
    assert.equal(classifyPath('docs/plans/security/files/scripts/lib/store/security.mjs'), null);
  });

  it('DRIFT_EXEMPT_PATTERNS does not match unrelated docs/plans paths', () => {
    assert.equal(shouldSkipForIndexing('docs/plans/audit-code-duplication-wave.md', ['driftExempt']).skip, false);
  });
});

describe('filterDiffFiles — 12-case state matrix', () => {
  const cats = ['sensitive', 'generatedNoise'];
  const empty = { added: [], modified: [], deleted: [], untracked: [], renamed: [] };

  it('added + matches filter → dropped', () => {
    const r = filterDiffFiles({ ...empty, added: ['.env.local'] }, cats);
    assert.deepEqual(r.diff.added, []);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].action, 'dropped');
  });
  it('added + no match → preserved', () => {
    const r = filterDiffFiles({ ...empty, added: ['src/foo.ts'] }, cats);
    assert.deepEqual(r.diff.added, ['src/foo.ts']);
    assert.equal(r.skipped.length, 0);
  });
  it('modified + matches filter → rewritten-delete', () => {
    const r = filterDiffFiles({ ...empty, modified: ['.env.local'] }, cats);
    assert.deepEqual(r.diff.modified, []);
    assert.deepEqual(r.diff.deleted, ['.env.local']);
    assert.equal(r.skipped[0].action, 'rewritten-delete');
  });
  it('modified + no match → preserved', () => {
    const r = filterDiffFiles({ ...empty, modified: ['src/foo.ts'] }, cats);
    assert.deepEqual(r.diff.modified, ['src/foo.ts']);
    assert.equal(r.skipped.length, 0);
  });
  it('deleted + matches filter → preserved-as-tombstone (CRITICAL)', () => {
    const r = filterDiffFiles({ ...empty, deleted: ['.env'] }, cats);
    assert.deepEqual(r.diff.deleted, ['.env'], 'tombstone must survive the filter');
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].action, 'preserved-as-tombstone');
  });
  it('deleted + no match → preserved', () => {
    const r = filterDiffFiles({ ...empty, deleted: ['src/foo.ts'] }, cats);
    assert.deepEqual(r.diff.deleted, ['src/foo.ts']);
    assert.equal(r.skipped.length, 0);
  });
  it('untracked + matches filter → dropped', () => {
    const r = filterDiffFiles({ ...empty, untracked: ['.env.local'] }, cats);
    assert.deepEqual(r.diff.untracked, []);
    assert.equal(r.skipped[0].action, 'dropped');
  });
  it('untracked + no match → preserved', () => {
    const r = filterDiffFiles({ ...empty, untracked: ['notes.txt'] }, cats);
    assert.deepEqual(r.diff.untracked, ['notes.txt']);
    assert.equal(r.skipped.length, 0);
  });

  it('renamed: from yes, to yes → dropped', () => {
    const r = filterDiffFiles({ ...empty, renamed: [{ from: '.env.prod', to: '.env.staging' }] }, cats);
    assert.deepEqual(r.diff.renamed, []);
    assert.deepEqual(r.diff.added, []);
    assert.deepEqual(r.diff.deleted, []);
  });
  it('renamed: from yes, to no → rewritten-add (to)', () => {
    const r = filterDiffFiles({ ...empty, renamed: [{ from: '.env.local', to: 'src/foo.ts' }] }, cats);
    assert.deepEqual(r.diff.renamed, []);
    assert.deepEqual(r.diff.added, ['src/foo.ts']);
    assert.ok(r.skipped.some(s => s.action === 'rewritten-add'));
  });
  it('renamed: from no, to yes → rewritten-delete (from) + tombstone', () => {
    const r = filterDiffFiles({ ...empty, renamed: [{ from: 'src/foo.ts', to: '.env.local' }] }, cats);
    assert.deepEqual(r.diff.renamed, []);
    assert.deepEqual(r.diff.deleted, ['src/foo.ts'], 'tombstone signal must survive');
    assert.ok(r.skipped.some(s => s.action === 'rewritten-delete'));
  });
  it('renamed: from no, to no → preserved', () => {
    const r = filterDiffFiles({ ...empty, renamed: [{ from: 'src/a.ts', to: 'src/b.ts' }] }, cats);
    assert.deepEqual(r.diff.renamed, [{ from: 'src/a.ts', to: 'src/b.ts' }]);
    assert.equal(r.skipped.length, 0);
  });
});

describe('filterDiffFiles — idempotency property', () => {
  it('feeding the output back through filterDiffFiles is a no-op', () => {
    const cats = ['sensitive', 'generatedNoise'];
    const start = {
      added: ['.env.local', 'src/foo.ts', 'src/bar.ts'],
      modified: ['.env', 'src/keep.ts'],
      deleted: ['.env.prod', 'src/gone.ts'],
      untracked: ['package-lock.json', 'notes.txt'],
      renamed: [
        { from: '.env.foo', to: 'src/new.ts' },
        { from: 'src/old.ts', to: '.env.bar' },
        { from: 'src/a.ts', to: 'src/b.ts' },
      ],
    };
    const r1 = filterDiffFiles(start, cats);
    const r2 = filterDiffFiles(r1.diff, cats);
    // Diff state must be a fixed point — the rewriter introduces no new
    // re-classifiable entries. (`deleted` matches re-log as `preserved-as-
    // tombstone` on every pass; that's expected and visibility-positive.)
    assert.deepEqual(r2.diff, r1.diff, 'second pass must produce identical diff');
    for (const s of r2.skipped) {
      assert.equal(s.action, 'preserved-as-tombstone',
        'second-pass skip entries must only be tombstone re-logs');
    }
  });
});

describe('filterDiffFiles — empty + degenerate input', () => {
  it('handles undefined/null diff', () => {
    const r = filterDiffFiles(null, ['sensitive']);
    assert.deepEqual(r.diff, { added: [], modified: [], deleted: [], untracked: [], renamed: [] });
    assert.equal(r.skipped.length, 0);
  });
  it('returns empty DiffShape when every entry filters', () => {
    const r = filterDiffFiles({
      added: ['.env'], modified: [], deleted: [], untracked: [], renamed: [],
    }, ['sensitive']);
    assert.deepEqual(r.diff, { added: [], modified: [], deleted: [], untracked: [], renamed: [] });
  });
});

describe('formatSkipLog — default aggregates sensitive', () => {
  it('emits one aggregated line for sensitive; raw paths never leak', () => {
    _resetDebugBanner();
    const lines = formatSkipLog([
      { path: 'srv/secrets/api-key-prod-2026-q2.pem', category: 'sensitive', pattern: /\.pem$/i, action: 'dropped' },
      { path: '.env.local', category: 'sensitive', pattern: /(^|\/)\.env\.local$/, action: 'dropped' },
    ], { env: {} });
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('sensitive-skip: 2 files'));
    // Critical: NO raw path, NO basename, NO substring of the secrets path.
    for (const tok of ['api-key', 'prod', '2026', 'q2.pem', '.env.local', 'srv/secrets']) {
      assert.ok(!lines[0].includes(tok), `default log must not leak ${tok}; got: ${lines[0]}`);
    }
  });
});

describe('formatSkipLog — debug emits hash + ext only', () => {
  it('redacts basename, exposes only stable hash + extension', () => {
    _resetDebugBanner();
    const stubHash = (s) => 'a4f2c901';
    const lines = formatSkipLog([
      { path: 'srv/secrets/api-key-prod-2026-q2.pem', category: 'sensitive', pattern: /\.pem$/i, action: 'dropped' },
    ], { debug: true, hashFn: stubHash, logger: 'refresh' });
    // Expect: banner line + one per-file line
    assert.equal(lines.length, 2);
    assert.ok(lines[0].includes('WARNING: SENSITIVE_PATHS_DEBUG'));
    assert.ok(lines[1].includes('[redacted:a4f2c901].pem'));
    for (const tok of ['api-key', 'prod', '2026', 'q2', 'srv/secrets']) {
      assert.ok(!lines[1].includes(tok), `debug log must not leak ${tok}; got: ${lines[1]}`);
    }
  });
  it('hash is stable across calls for the same path', () => {
    _resetDebugBanner();
    const a = formatSkipLog(
      [{ path: 'srv/secrets/api.pem', category: 'sensitive', pattern: /\.pem$/i }],
      { debug: true }
    )[1];
    _resetDebugBanner();
    const b = formatSkipLog(
      [{ path: 'srv/secrets/api.pem', category: 'sensitive', pattern: /\.pem$/i }],
      { debug: true }
    )[1];
    assert.equal(a, b, 'hash must be stable for same path');
  });
});

describe('formatSkipLog — generatedNoise never aggregated', () => {
  it('emits per-path noise-skip lines in full (not secret)', () => {
    _resetDebugBanner();
    const lines = formatSkipLog([
      { path: 'package-lock.json', category: 'generatedNoise', pattern: /(^|\/)package-lock\.json$/, action: 'dropped' },
      { path: 'dist/bundle.min.js', category: 'generatedNoise', pattern: /\.min\.js$/, action: 'dropped' },
    ], { env: {} });
    assert.equal(lines.length, 2);
    assert.ok(lines[0].includes('package-lock.json'));
    assert.ok(lines[1].includes('bundle.min.js'));
  });
});

describe('formatSkipLog — driftExempt never aggregated', () => {
  it('emits per-path drift-exempt-skip lines in full (not secret)', () => {
    _resetDebugBanner();
    const lines = formatSkipLog([
      { path: 'docs/plans/security/files/scripts/lib/store/security.mjs', category: 'driftExempt', pattern: /(^|\/)docs\/plans\/security\/files\//, action: 'dropped' },
    ], { env: {} });
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith('[sensitive-paths] drift-exempt-skip:'));
    assert.ok(lines[0].includes('docs/plans/security/files/scripts/lib/store/security.mjs'));
  });
});

describe('formatSkipLog — mixed input', () => {
  it('aggregates sensitive AND emits noise per-path', () => {
    _resetDebugBanner();
    const lines = formatSkipLog([
      { path: '.env', category: 'sensitive', pattern: /(^|\/)\.env/, action: 'dropped' },
      { path: 'package-lock.json', category: 'generatedNoise', pattern: /(^|\/)package-lock\.json$/, action: 'dropped' },
    ], { env: {} });
    assert.equal(lines.length, 2);
    assert.ok(lines[0].includes('sensitive-skip: 1 files'));
    assert.ok(lines[1].includes('package-lock.json'));
  });
});

describe('Superset gate — legacy patterns covered', () => {
  // Each legacy regex pattern from quickfix-patterns.mjs MUST be covered by
  // a positive-case path that classifyPath classifies as either category.
  const legacyQuickfixCoverage = [
    { fixture: '.env', expected: 'sensitive' },
    { fixture: '.env.local', expected: 'sensitive' },
    { fixture: '.env.production', expected: 'sensitive' },
    { fixture: 'secrets.json', expected: 'sensitive' },
    { fixture: 'secrets.yaml', expected: 'sensitive' },
    { fixture: 'secret.txt', expected: 'sensitive' },
    { fixture: 'credentials.json', expected: 'sensitive' },
    { fixture: 'credential.yaml', expected: 'sensitive' },
    { fixture: 'tls/server.pem', expected: 'sensitive' },
    { fixture: 'tls/server.key', expected: 'sensitive' },
    { fixture: 'tls/server.crt', expected: 'sensitive' },
    { fixture: 'archive/key.p12', expected: 'sensitive' },
    { fixture: 'archive/key.pfx', expected: 'sensitive' },
    { fixture: 'secrets/foo.txt', expected: 'sensitive' },
    { fixture: 'credentials/foo.json', expected: 'sensitive' },
    { fixture: '.aws/credentials', expected: 'sensitive' },
    { fixture: '.ssh/id_rsa', expected: 'sensitive' },
  ];

  for (const { fixture, expected } of legacyQuickfixCoverage) {
    it(`legacy quickfix pattern: ${fixture} → ${expected}`, () => {
      assert.equal(classifyPath(fixture), expected);
    });
  }

  // Patterns added by sensitive-egress-gate (formerly DEFAULT_PATH_DENYLIST).
  const legacyEgressCoverage = [
    { fixture: 'tls/cert.cer', expected: 'sensitive' },
    { fixture: 'tls/cert.der', expected: 'sensitive' },
    { fixture: 'gpg/file.gpg', expected: 'sensitive' },
    { fixture: 'gpg/file.asc', expected: 'sensitive' },
    { fixture: '.ssh/id_rsa.pub', expected: 'sensitive' },
    { fixture: 'private/foo.txt', expected: 'sensitive' },
    { fixture: 'package-lock.json', expected: 'generatedNoise' },
    { fixture: 'yarn.lock', expected: 'generatedNoise' },
    { fixture: 'pnpm-lock.yaml', expected: 'generatedNoise' },
    { fixture: 'bun.lockb', expected: 'generatedNoise' },
  ];
  for (const { fixture, expected } of legacyEgressCoverage) {
    it(`legacy egress-gate pattern: ${fixture} → ${expected}`, () => {
      assert.equal(classifyPath(fixture), expected);
    });
  }

  // Every legacy quickfix regex must have at least one fixture that the new
  // classifier flags as non-null (sensitive OR generatedNoise). This is the
  // R1-H4 + Gemini-G1 superset gate.
  it('every legacy quickfix regex has a covering fixture in the new set', () => {
    const allFixtures = [...legacyQuickfixCoverage, ...legacyEgressCoverage];
    for (const legacy of LEGACY_QUICKFIX_PATTERNS) {
      const hit = allFixtures.find(f => legacy.test(normalisePath(f.fixture)));
      assert.ok(hit, `no covering fixture for legacy quickfix pattern ${legacy}`);
      assert.ok(classifyPath(hit.fixture) !== null,
        `fixture ${hit.fixture} (matching legacy ${legacy}) must classify under new set`);
    }
  });
});

describe('Patterns are frozen', () => {
  it('SENSITIVE_PATTERNS is immutable', () => {
    assert.throws(() => SENSITIVE_PATTERNS.push(/x/));
  });
  it('GENERATED_NOISE_PATTERNS is immutable', () => {
    assert.throws(() => GENERATED_NOISE_PATTERNS.push(/x/));
  });
});

// ── Gaps found by mutation testing (2026-08-10) ─────────────────────────────
//
// `npm run mutation -- --target sensitive-paths` scored 67.5% with 120
// survivors, and the dominant class was ANCHOR REMOVAL on the sensitive-path
// regexes: dropping `$` from `/\.env(\..+)?$/`, dropping `^` from `/(^|\/)…/`,
// making an optional group required.
//
// Every one of those mutants makes a pattern match MORE, which is the
// fail-closed direction and therefore not a leak. But it is not harmless, and
// it is not asserted: over-classification silently EXCLUDES real source files
// from every audit, index and diff that consults this module. Silent coverage
// loss is this repo's core concern, so the negative side of the boundary
// deserves the same rigour as the positive side.
//
// These are near-miss names — close enough to a sensitive pattern that a
// widened regex swallows them, ordinary enough that they must be auditable.

describe('classifyPath — near-miss names must NOT be classified sensitive', () => {
  const MUST_BE_CLEAN = [
    ['docs/envelope.md', 'contains "env" but is not a dotfile'],
    ['scripts/lib/.envelope.md', 'starts with .env but continues into a word'],
    ['docs/environment-setup.md', 'the word "environment", not a .env file'],
    ['scripts/lib/keyboard.mjs', 'contains "key" but the extension is .mjs'],
    ['docs/secrets-policy.md', 'names secrets but is prose, not a secrets file'],
    ['tests/fixtures/pem-parser.test.mjs', 'mentions pem; the extension is .mjs'],
    ['src/certificates.ts', 'a module ABOUT certs is not a cert'],
  ];

  for (const [p, why] of MUST_BE_CLEAN) {
    it(`${p} is auditable — ${why}`, () => {
      assert.notEqual(
        classifyPath(p), 'sensitive',
        `over-classifying ${p} silently removes it from every audit, index and diff `
        + 'that consults this module — a coverage loss nobody sees',
      );
    });
  }

  // Vacuous-pass guard: the genuinely sensitive forms must still classify, or
  // the assertions above would pass against a module that classifies nothing.
  const MUST_BE_SENSITIVE = [
    '.env',
    '.env.production',
    '.env.local',
    'config/.env',
    'foo.env',
    'secrets.json',
    'certs/server.pem',
    'keys/id_rsa.key',
  ];

  for (const p of MUST_BE_SENSITIVE) {
    it(`${p} is still classified sensitive (vacuous-pass guard)`, () => {
      assert.equal(classifyPath(p), 'sensitive', `${p} must never reach a third-party LLM`);
    });
  }
});

describe('classifyPath — anchors are load-bearing, in both directions', () => {
  it('a sensitive basename nested in a path still matches (the ^|/ alternation)', () => {
    assert.equal(classifyPath('deep/nested/dir/.env'), 'sensitive');
    assert.equal(classifyPath('a/b/c/secrets.json'), 'sensitive');
  });

  it('a sensitive NAME embedded mid-segment does not match', () => {
    // Without the `(^|\/)` anchor these would match, and the file would vanish
    // from audits.
    assert.notEqual(classifyPath('docs/my.env.notes.md'), 'sensitive');
    assert.notEqual(classifyPath('src/mysecrets.ts'), 'sensitive');
  });

  it('an extension pattern anchors at the END, so a mid-path match does not count', () => {
    assert.notEqual(classifyPath('pem/readme.md'), 'sensitive');
    assert.notEqual(classifyPath('key/index.mjs'), 'sensitive');
  });
});
