/**
 * @fileoverview Tests for scripts/check-architecture-intent-drift.mjs.
 * Fixture matrix per docs/plans/refactor-architecture-debt-remainder-2026-07.md
 * item 3 step 5's testability requirement (Gemini shadow finding): proves the
 * gate can actually FAIL, not just that it happens to exit 0 against the real
 * repo today.
 *
 * Contracted gate: `architecture-intent-check-detects-an-undocumented-domain`
 * (scripts/gate-contracts/architecture-intent-check.json). That contract names
 * this file, and the contract validator requires the reference to be mutual —
 * a contract may not claim a test that has never heard of it, or the "tested"
 * column becomes an assertion nobody wrote.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  extractDomainMapDomains,
  extractDocDomains,
  compareDomainSets,
  runArchitectureIntentDriftCheck,
} from '../scripts/check-architecture-intent-drift.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(TEST_DIR, '..', 'scripts', 'check-architecture-intent-drift.mjs');
const REPO_ROOT = path.resolve(TEST_DIR, '..');

function domainMapJson(domains) {
  return JSON.stringify({ rules: domains.map((domain) => ({ pattern: `${domain}/**`, domain })) });
}

describe('extractDomainMapDomains', () => {
  it('collects the domain set, deduping repeated domains across multiple rules', () => {
    const json = domainMapJson(['alpha', 'beta', 'alpha']);
    assert.deepEqual([...extractDomainMapDomains(json)].sort(), ['alpha', 'beta']);
  });

  it('empty rules array yields an empty set', () => {
    assert.deepEqual(extractDomainMapDomains(JSON.stringify({ rules: [] })), new Set());
  });
});

describe('extractDocDomains', () => {
  it('collects every ### `<domain>` heading inside the ## Domains section', () => {
    const md = [
      '# Doc',
      '## Domains',
      '### `alpha`',
      'Alpha description.',
      '### `beta`',
      'Beta description.',
      '## Cross-cutting concerns',
      'Not a domain section.',
    ].join('\n');
    assert.deepEqual([...extractDocDomains(md)].sort(), ['alpha', 'beta']);
  });

  it('a grouped heading with multiple backtick-quoted names captures all of them', () => {
    const md = [
      '## Domains',
      '### `alpha`, `beta`, `gamma`',
      'Grouped description.',
      '## Boundary rationale',
    ].join('\n');
    assert.deepEqual([...extractDocDomains(md)].sort(), ['alpha', 'beta', 'gamma']);
  });

  it('a tilde (~~~) fence is also recognized, not just triple-backtick (audit R3 M1)', () => {
    const md = [
      '## Domains',
      '### `alpha`',
      'Desc.',
      '~~~',
      '### `fake-domain`',
      '~~~',
      '## Boundary rationale',
    ].join('\n');
    const domains = extractDocDomains(md);
    assert.ok(domains.has('alpha'));
    assert.ok(!domains.has('fake-domain'), 'tilde-fenced content must not be parsed as a heading');
  });

  it('a nested shorter/different-marker fence does NOT close the outer fence (audit R4 M3 — CommonMark fence-length matching)', () => {
    // A closing fence must use the SAME character as the opening fence and
    // be AT LEAST as long. A naive "toggle on any fence-looking line" gets
    // this wrong: the inner ``` here must not be treated as closing the
    // outer ````, which would wrongly un-fence `### \`fake-domain\`` below it.
    const md = [
      '## Domains',
      '### `alpha`',
      'Desc.',
      '````',
      'example: ```js',
      '### `fake-domain`',
      '```',
      '````',
      '## Boundary rationale',
    ].join('\n');
    const domains = extractDocDomains(md);
    assert.ok(domains.has('alpha'));
    assert.ok(!domains.has('fake-domain'), 'a shorter nested fence marker must not close the longer outer fence');
  });

  it('accepts any non-empty backtick content as a domain name, not just [a-z0-9-]+ (audit R3 M2 — must never be stricter than the domain-map side)', () => {
    const md = ['## Domains', '### `Weird_Name.v2`', 'Desc.'].join('\n');
    const domains = extractDocDomains(md);
    assert.ok(domains.has('Weird_Name.v2'));
  });

  it('a ### line inside a fenced code block is NOT treated as a real heading (audit R2 M2)', () => {
    const md = [
      '## Domains',
      '### `alpha`',
      'Desc.',
      '```mermaid',
      'graph TB',
      'subgraph "### `fake-domain`"',
      'end',
      '```',
      '## Boundary rationale',
    ].join('\n');
    const domains = extractDocDomains(md);
    assert.ok(domains.has('alpha'));
    assert.ok(!domains.has('fake-domain'), 'fenced-code-block content must not be parsed as a heading');
  });

  it('a domain name appearing only OUTSIDE the ## Domains span is NOT counted (section-boundary scoping)', () => {
    // This is the exact false-pass class round-3 M1 flagged: a whole-document
    // regex would find `gamma` anywhere and wrongly treat it as documented.
    const md = [
      '## Domains',
      '### `alpha`',
      'Alpha description.',
      '## Boundary rationale',
      'This section mentions `gamma` in passing prose, not as a domain heading.',
    ].join('\n');
    const domains = extractDocDomains(md);
    assert.ok(domains.has('alpha'));
    assert.ok(!domains.has('gamma'), 'gamma appears outside ## Domains and must not count');
  });

  it('no ## Domains heading at all yields an empty set (fails loud, not a crash)', () => {
    const md = ['# Doc', '## Some Other Section', '### `alpha`'].join('\n');
    assert.deepEqual(extractDocDomains(md), new Set());
  });

  it('## Domains as the last section (no trailing ## heading) still scopes correctly', () => {
    const md = ['# Doc', '## Domains', '### `alpha`', 'Alpha description.'].join('\n');
    assert.deepEqual(extractDocDomains(md), new Set(['alpha']));
  });
});

describe('compareDomainSets', () => {
  it('doc is a superset of the map — no missing domains', () => {
    const { missing } = compareDomainSets(new Set(['alpha']), new Set(['alpha', 'beta']));
    assert.deepEqual(missing, []);
  });

  it('doc missing one map domain — reports exactly that one, sorted', () => {
    const { missing } = compareDomainSets(new Set(['alpha', 'beta', 'gamma']), new Set(['beta']));
    assert.deepEqual(missing, ['alpha', 'gamma']);
  });

  it('doc missing everything (empty doc-side set) — reports all map domains', () => {
    const { missing } = compareDomainSets(new Set(['alpha', 'beta']), new Set());
    assert.deepEqual(missing, ['alpha', 'beta']);
  });
});

describe('runArchitectureIntentDriftCheck', () => {
  function mkTmpRepo() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'arch-intent-drift-'));
  }

  function writeFixture(root, { domains, docMarkdown }) {
    fs.mkdirSync(path.join(root, '.audit-loop'), { recursive: true });
    fs.writeFileSync(path.join(root, '.audit-loop', 'domain-map.json'), domainMapJson(domains));
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'architecture-intent.md'), docMarkdown);
  }

  it('fixture 1: doc documents every map domain — 0 missing (pass)', () => {
    const root = mkTmpRepo();
    try {
      writeFixture(root, {
        domains: ['alpha', 'beta'],
        docMarkdown: '## Domains\n### `alpha`\nDesc.\n### `beta`\nDesc.\n',
      });
      const result = runArchitectureIntentDriftCheck(root);
      assert.deepEqual(result.missing, []);
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('fixture 2: doc missing one map domain — fails, names it', () => {
    const root = mkTmpRepo();
    try {
      writeFixture(root, {
        domains: ['alpha', 'beta'],
        docMarkdown: '## Domains\n### `alpha`\nDesc.\n',
      });
      const result = runArchitectureIntentDriftCheck(root);
      assert.deepEqual(result.missing, ['beta']);
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('fixture 3: a domain name appearing only outside ## Domains still fails (section-boundary scoping proven end-to-end)', () => {
    const root = mkTmpRepo();
    try {
      writeFixture(root, {
        domains: ['alpha', 'beta'],
        docMarkdown: '## Domains\n### `alpha`\nDesc.\n## Boundary rationale\nMentions `beta` in prose only.\n',
      });
      const result = runArchitectureIntentDriftCheck(root);
      assert.deepEqual(result.missing, ['beta']);
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('fixture 4: missing ## Domains heading entirely — fails loud (every map domain reported), never a vacuous pass', () => {
    const root = mkTmpRepo();
    try {
      writeFixture(root, {
        domains: ['alpha', 'beta'],
        docMarkdown: '# Doc\n## Some Other Section\nNo Domains heading here.\n',
      });
      const result = runArchitectureIntentDriftCheck(root);
      assert.deepEqual(result.missing, ['alpha', 'beta']);
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('missing doc file entirely also fails loud rather than crashing', () => {
    const root = mkTmpRepo();
    try {
      fs.mkdirSync(path.join(root, '.audit-loop'), { recursive: true });
      fs.writeFileSync(path.join(root, '.audit-loop', 'domain-map.json'), domainMapJson(['alpha']));
      const result = runArchitectureIntentDriftCheck(root);
      assert.deepEqual(result.missing, ['alpha']);
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

describe('CLI', () => {
  function run(argv) {
    return spawnSync('node', [CLI, ...argv], { encoding: 'utf-8', timeout: 8000, cwd: REPO_ROOT });
  }

  it('default invocation against the real repo exits 0', () => {
    const r = run([]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^OK /);
  });

  it('--repo with no value exits 2 with a clear error, not a path.resolve crash (audit R2 M4)', () => {
    const r = run(['--repo']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--repo requires a value/);
  });

  it('--help exits 0', () => {
    const r = run(['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage:/);
  });

  it('unknown flag exits 2 (via the canonical assertKnownFlags helper)', () => {
    const r = run(['--bogus']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown flag/);
  });
});
