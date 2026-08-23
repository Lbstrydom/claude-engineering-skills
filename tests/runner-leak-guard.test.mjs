/**
 * @fileoverview Structural leak guard (R1 H5, replaces the earlier
 * gitignored-deny-list design — see docs/plans/self-hosted-runner-management.md
 * §10 Security Considerations). Scans every TRACKED file (`git ls-files`,
 * minus the one allowlisted fixture directory) for the STRUCTURAL SHAPE of a
 * real `.runner` / `.credentials` / `.credentials_rsaparams` blob — never a
 * vendor term, never a gitignored input, so it is meaningful in a clean CI
 * checkout with zero external configuration (the sandbox-honesty rule:
 * "would this check pass having checked nothing?" — this one genuinely
 * scans every tracked file every run).
 *
 * Why quoted keys, not bare identifiers, is the detection signal: a real
 * `.runner`/`.credentials` file is strict JSON (`"agentId": 1`), while every
 * place this repo's OWN source/docs describe that shape does so as a JS
 * object-literal type illustration (`agentId: 1`, unquoted) — a JSDoc
 * `@typedef`, a markdown code fence, a destructuring assignment. Requiring
 * quoted keys is what lets this guard scan the plan document, the pure
 * module's docstrings, and this very test file's own positive-control
 * fixtures without tripping on prose ABOUT the shape.
 *
 * Allowlist: the FOUR named files under `tests/fixtures/runner/synthetic-install/`
 * that legitimately carry placeholder-valued `.runner`/`.credentials`-shaped
 * content, by design (Cluster A, tests/runner-probe.test.mjs's fixture tree).
 * An exact file list, not a directory prefix (audit round 2, H3) — a prefix
 * match would exempt any file added under that directory in the future,
 * including a real secret dropped there by accident.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
// EXACT file list, not a directory prefix (audit round 2, H3): a prefix
// match exempts anything future that ever lands under this directory, so a
// real credential-bearing file added there later — by accident or otherwise
// — would never be flagged. Adding a genuinely new synthetic fixture means
// widening this list explicitly; that friction is the point.
const ALLOWLISTED_FILES = new Set([
  'tests/fixtures/runner/synthetic-install/.runner',
  'tests/fixtures/runner/synthetic-install/.service',
  'tests/fixtures/runner/synthetic-install/.credentials',
  'tests/fixtures/runner/synthetic-install/.credentials_rsaparams',
]);

const RUNNER_SHAPE_KEYS = ['agentId', 'agentName', 'gitHubUrl', 'poolId'];
const RSA_PARAM_KEYS = ['n', 'e', 'd', 'p', 'q'];
const CREDENTIALS_REQUIRED_KEYS = ['scheme', 'clientId'];
const CREDENTIALS_ANY_OF_KEYS = ['authorizationUrl', 'oAuthEndpoint'];

// A large tracked file (e.g. package-lock.json) genuinely has thousands of
// flat `{...}` spans — scanning it is still correct, just not free. Capped,
// not skipped: files over the cap are scanned in fixed-size CHUNKS instead
// of one global match pass, so nothing is silently exempted from the guard
// merely for being large (the sandbox-honesty rule again — a size-based
// skip would be exactly the kind of "green having checked nothing" hole
// this repo gates against elsewhere).
const CHUNK_SIZE = 200_000;
const CHUNK_OVERLAP = 4_000; // >= the object-span cap, so a span never falls entirely in the gap between chunks

function objectSpansIn(text) {
  return text.match(/\{[^{}]{0,4000}\}/g) || [];
}

// Bounded TWO-level span, for the .credentials (OAuth) shape only — audit
// round 3 (M6). The R2 version checked scheme/clientId/URL-key co-occurrence
// across an ENTIRE 200,000-char chunk, so any large tracked file with those
// three substrings anywhere nearby — package-lock.json, this very test file's
// own comments — could false-positive. The real shape is a small, FIXED
// nesting depth (`{"scheme":…,"data":{…}}`), so matching that exact bounded
// shape (outer object containing exactly one nested object) is both more
// precise AND still catches every real instance.
function twoLevelSpansIn(text) {
  return text.match(/\{[^{}]{0,2000}\{[^{}]{0,4000}\}[^{}]{0,2000}\}/g) || [];
}

function hasAllKeys(span, keys) {
  return keys.every((k) => new RegExp(`["']${k}["']\\s*:`).test(span));
}
function hasAnyKey(span, keys) {
  return keys.some((k) => new RegExp(`["']${k}["']\\s*:`).test(span));
}

function classifySpan(span) {
  if (hasAllKeys(span, RUNNER_SHAPE_KEYS)) return 'runner-config';
  if (hasAllKeys(span, RSA_PARAM_KEYS)) return 'credentials-rsaparams';
  return null;
}

/**
 * The structural shape detector. Returns `{kind, span}` on a hit
 * (`kind` is `'runner-config'|'credentials-rsaparams'|'credentials-oauth'`),
 * or `null`. Pure function of the text — no fs, no git, so it is
 * independently unit-testable with an in-memory blob (the positive control).
 *
 * `runner-config` and `credentials-rsaparams` are matched per flat `{...}`
 * SPAN (real `.runner`/`.credentials_rsaparams` files are single-level
 * JSON). `credentials-oauth` is matched per CHUNK instead — the real
 * `.credentials` file's `scheme` key sits one level ABOVE its nested `data`
 * object (`{"scheme":"OAuth","data":{"clientId":...}}`), so a flat-span
 * check would only ever see the inner object and never find `scheme`
 * alongside it. `scheme`+`clientId`+a URL key together is a distinctive
 * enough combination that matching within a bounded two-level span (rather
 * than scanning the whole chunk for co-occurrence) is a precise, not merely
 * plausible, signal — audit round 3, M6 tightened this from a chunk-wide
 * check to `twoLevelSpansIn`, closing a false-positive path where the three
 * substrings could appear unrelated to each other anywhere in a large file.
 * @param {string} text
 * @returns {{kind:string, span:string}|null}
 */
export function findLeakyShape(text) {
  for (let start = 0; start < text.length; start += CHUNK_SIZE) {
    const chunk = text.slice(Math.max(0, start - CHUNK_OVERLAP), start + CHUNK_SIZE);
    for (const span of objectSpansIn(chunk)) {
      const kind = classifySpan(span);
      if (kind) return { kind, span };
    }
    for (const span of twoLevelSpansIn(chunk)) {
      if (hasAllKeys(span, CREDENTIALS_REQUIRED_KEYS) && hasAnyKey(span, CREDENTIALS_ANY_OF_KEYS)) {
        return { kind: 'credentials-oauth', span };
      }
    }
    if (text.length <= CHUNK_SIZE) break; // single-chunk fast path, no overlap needed
  }
  return null;
}

function isAllowlisted(relPath) {
  return ALLOWLISTED_FILES.has(relPath.replace(/\\/g, '/'));
}

function listTrackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf-8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────
// Scanner unit tests — positive and negative controls, no fs/git involved.
// ─────────────────────────────────────────────────────────────────────────

describe('findLeakyShape — the structural shape detector', () => {
  it('POSITIVE CONTROL: an in-memory synthetic .runner-shaped blob trips the scanner directly', () => {
    const blob = JSON.stringify({
      agentId: 999999,
      agentName: 'synthetic-positive-control-agent',
      poolId: 1,
      poolName: 'Default',
      gitHubUrl: 'https://github.com/example-owner/example-repo',
      workFolder: '_work',
    });
    const hit = findLeakyShape(blob);
    assert.ok(hit, 'the scanner must trip on a flat, quoted-key .runner-shaped JSON object');
    assert.equal(hit.kind, 'runner-config');
  });

  it('POSITIVE CONTROL: an in-memory synthetic .credentials_rsaparams-shaped blob trips the scanner', () => {
    const blob = JSON.stringify({ n: 'modulus', e: 'exponent', d: 'private-exponent', p: 'prime1', q: 'prime2' });
    const hit = findLeakyShape(blob);
    assert.ok(hit);
    assert.equal(hit.kind, 'credentials-rsaparams');
  });

  it('POSITIVE CONTROL: an in-memory synthetic .credentials (OAuth)-shaped blob trips the scanner', () => {
    const blob = JSON.stringify({
      scheme: 'OAuth',
      data: { clientId: 'x', authorizationUrl: 'https://example.invalid/authorize', oAuthEndpoint: 'https://example.invalid/token' },
    });
    const hit = findLeakyShape(blob);
    assert.ok(hit);
    assert.equal(hit.kind, 'credentials-oauth');
  });

  it('NEGATIVE CONTROL: a runner-config object missing exactly one of the four required keys does not trip it', () => {
    const blob = JSON.stringify({ agentId: 1, agentName: 'x', gitHubUrl: 'https://github.com/o/r' }); // no poolId
    assert.equal(findLeakyShape(blob), null);
  });

  it('NEGATIVE CONTROL: an RSA-param object missing one key does not trip it', () => {
    const blob = JSON.stringify({ n: 'a', e: 'b', d: 'c', p: 'd' }); // no q
    assert.equal(findLeakyShape(blob), null);
  });

  it('NEGATIVE CONTROL: ordinary prose naming the key IDENTIFIERS (unquoted, scattered) does not trip it', () => {
    const prose = 'The .runner file has fields agentId, agentName, gitHubUrl and poolId, described separately in this paragraph.';
    assert.equal(findLeakyShape(prose), null);
  });

  it('NEGATIVE CONTROL: a JS/TS object-literal illustration (unquoted keys, exactly this repo\'s own docstring style) does not trip it', () => {
    const jsdocStyle = "{ root: 'C:/actions-runner', agentId: 24, agentName: 'some-name', gitHubUrl: 'https://github.com/OWNER/REPO', poolId: 1 }";
    assert.equal(findLeakyShape(jsdocStyle), null);
  });

  it('chunking does not lose a match that straddles the chunk boundary', () => {
    const leak = JSON.stringify({ agentId: 1, agentName: 'x', gitHubUrl: 'https://github.com/o/r', poolId: 1 });
    const padding = 'x'.repeat(CHUNK_SIZE - 40);
    const text = padding + leak; // the object literal spans across the CHUNK_SIZE boundary
    assert.ok(findLeakyShape(text), 'a leak straddling a chunk boundary must still be found');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Real scan — every tracked file, minus the one allowlisted fixture dir.
// Needs no vendor term, no gitignored input: meaningful in a clean checkout.
// ─────────────────────────────────────────────────────────────────────────

describe('tracked-file scan (git ls-files, minus tests/fixtures/runner/synthetic-install/)', () => {
  it('sanity: the allowlisted fixture .runner file genuinely matches the shape detector (else the allowlist test below is vacuous)', () => {
    const runnerPath = path.join(REPO_ROOT, 'tests', 'fixtures', 'runner', 'synthetic-install', '.runner');
    const content = fs.readFileSync(runnerPath, 'utf-8');
    const hit = findLeakyShape(content);
    assert.ok(hit, 'the fixture .runner file should genuinely trip the detector');
    assert.equal(hit.kind, 'runner-config');
  });

  it('sanity: the allowlist directory is actually tracked in git (else the exclusion below is testing nothing)', () => {
    const files = listTrackedFiles();
    const fixtureFiles = files.filter((f) => isAllowlisted(f));
    assert.ok(fixtureFiles.length > 0, 'tests/fixtures/runner/synthetic-install/ must be tracked for this guard to mean anything');
  });

  it('NEGATIVE CONTROL: the allowlisted directory\'s real .runner file does NOT appear as an offender once excluded', () => {
    assert.ok(isAllowlisted('tests/fixtures/runner/synthetic-install/.runner'));
    assert.ok(isAllowlisted('tests\\fixtures\\runner\\synthetic-install\\.service'), 'the exclusion must be separator-tolerant');
  });

  it('no tracked file OUTSIDE the allowlisted fixture directory contains a .runner/.credentials-shaped blob', () => {
    const files = listTrackedFiles();
    const offenders = [];
    for (const rel of files) {
      if (isAllowlisted(rel)) continue;
      const abs = path.join(REPO_ROOT, rel);
      let content;
      try {
        content = fs.readFileSync(abs, 'utf-8');
      } catch {
        continue; // unreadable/binary — not a JSON-shaped leak candidate
      }
      const hit = findLeakyShape(content);
      if (hit) offenders.push({ file: rel, kind: hit.kind });
    }
    assert.deepEqual(
      offenders,
      [],
      `tracked files outside tests/fixtures/runner/synthetic-install/ must never carry .runner/.credentials-shaped content: ${JSON.stringify(offenders)}`,
    );
  });
});
