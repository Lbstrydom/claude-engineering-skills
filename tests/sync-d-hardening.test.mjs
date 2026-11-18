/**
 * @fileoverview Cluster D hardening that came out of the /audit-code rounds: the manifest base is selected from what was WRITTEN
 * (debt 4e0763d54f00, with the race exercised deterministically), the banner is a PLACEMENT and not a substring, the
 * prior-upstream fallback cannot rehabilitate an empty/unreadable destination, the shared-surface JSON set is pinned against
 * the real bundle, and the CLI's gc call passes the safeguards the library makes optional.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { selectManifestBases } from '../scripts/lib/sync-gc.mjs';
import { classifyOwnership } from '../scripts/lib/sync-ownership.mjs';
import { decideUnmanifested } from '../scripts/lib/sync-outbound.mjs';
import { isCoOwnedJsonDest } from '../scripts/lib/sync-path-map.mjs';
import { getSyncClosure } from '../scripts/lib/sync-inventory.mjs';
import { BANNER_BODY } from '../scripts/lib/sync-banner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BANNER = Array.isArray(BANNER_BODY) ? BANNER_BODY[0] : String(BANNER_BODY);
const W = 'sha256:' + 'a'.repeat(64);   // the hash of the bytes the sync WROTE
const EDITED = 'sha256:' + 'e'.repeat(64); // the hash of what a consumer put on disk afterwards

describe('selectManifestBases — the base is what was written, even when the disk changes after the write (4e0763d54f00)', () => {
  const args = (over = {}) => ({
    intendedDests: ['a.txt', 'held.txt', 'failed.txt', 'unaccounted.txt', 'gone.txt'],
    notWrittenByUs: new Set(['held.txt', 'failed.txt', 'gone.txt']),
    writtenHash: new Map([['a.txt', W]]),
    failedWrites: new Set(['failed.txt']),
    carriedFor: (rel) => ({ 'held.txt': 'sha256:' + '1'.repeat(64), 'gone.txt': 'sha256:' + '2'.repeat(64) })[rel],
    stillThere: (rel) => rel !== 'gone.txt',
    mayStillExist: () => true,
    ...over,
  });

  it('RED on the parent: re-hashing the disk after the loop records a post-write edit as OUR base', () => {
    const diskAfterEdit = { 'a.txt': EDITED };
    // The parent's rule (sync-to-repos.mjs at 80c2e1db): for a path we wrote, hash whatever is on disk NOW.
    const parentBase = (rel) => diskAfterEdit[rel];
    assert.equal(parentBase('a.txt'), EDITED, 'red evidence: the parent base is the consumer\'s bytes');
    const { files } = selectManifestBases(args({
      // the disk is never consulted for a written path: if it were, this would throw
      stillThere: (rel) => { if (rel === 'a.txt') throw new Error('the disk was consulted for a written path'); return rel !== 'gone.txt'; },
    }));
    assert.equal(files['a.txt'], W, 'the base is the hash of the bytes the sync wrote');
  });

  it('not written: the prior entry is carried while the file is still there; dropped when it is gone', () => {
    const { files } = selectManifestBases(args());
    assert.equal(files['held.txt'], 'sha256:' + '1'.repeat(64));
    assert.equal('gone.txt' in files, false, 'a carried base for an absent destination would assert a delivery that did not happen');
  });

  it('a path in neither set is omitted: a base is never invented', () => {
    assert.equal('unaccounted.txt' in selectManifestBases(args()).files, false);
  });

  it('a failed write with no carried base keeps the journal; with a carried base it does not', () => {
    assert.equal(selectManifestBases(args()).keepJournal, true);
    assert.equal(selectManifestBases(args({ carriedFor: () => 'sha256:' + '3'.repeat(64) })).keepJournal, false);
    assert.equal(selectManifestBases(args({ mayStillExist: () => false })).keepJournal, false);
  });
});

describe('the banner is a PLACEMENT, not a substring (audit R1 H2/H5)', () => {
  const owned = (destContent) => classifyOwnership({ destContent, sourceContent: 'something else\n', bannerMarker: BANNER }).provable;

  it('the injected banner (first content line, with or without a shebang) proves ownership', () => {
    assert.equal(owned(`// ${BANNER}\nexport {};\n`), true);
    assert.equal(owned(`#!/usr/bin/env node\n// ${BANNER}\nexport {};\n`), true);
    assert.equal(owned(`# ${BANNER}\nexport A=1\n`), true);
  });

  it('a consumer file that merely QUOTES the marker is NOT ours (red: the substring check claimed it)', () => {
    const quoting = `# Notes\n\nThe sync stamps files with "${BANNER}" at the top.\n`;
    assert.equal(quoting.includes(BANNER), true, 'red evidence: the old substring test would accept this');
    assert.equal(owned(quoting), false);
    assert.equal(owned(`const marker = '${BANNER}';\n`), false);
    assert.equal(owned(`export {};\n// ${BANNER}\n`), false, 'a banner NOT on the first content line is not the injected one');
    assert.equal(owned(`${BANNER} is how we start a plain sentence\n`), false, 'no comment prefix: not an injected banner (audit R2 H2)');
    assert.equal(owned(`/* ${BANNER} */\n`), false, 'only the comment tokens injectUpstreamBanner emits');
    assert.equal(owned(`// ${BANNER} is how we start a plain sentence\n`), false, 'a comment that STARTS with the marker but goes on in consumer words (audit R3 H2)');
    assert.equal(owned(`// ${BANNER}\r\nexport {};\r\n`), true, 'CRLF files carry the same banner');
  });
});

describe('decideUnmanifested — history cannot rehabilitate what was rejected on purpose (audit R1 H2)', () => {
  it('an empty or unreadable destination stays a collision even when the prior-upstream oracle says yes', () => {
    for (const destContent of ['', null]) {
      const v = decideUnmanifested({
        srcRel: '.claude/skills/plan/SKILL.md', dstRel: '.claude/skills/plan/SKILL.md', destContent, sourceText: '# u\n',
        rewriteConfig: { ownedSourceTails: new Set() }, bannerMarker: BANNER, priorUpstreamMatches: () => true,
      });
      assert.equal(v.disposition, 'collision', JSON.stringify(destContent));
    }
  });
});

describe('the shared-surface JSON set is pinned against the real bundle (audit R1 M2)', () => {
  it('exactly the consumer-namespace JSON files are co-owned; a new unmapped JSON asset must be a deliberate decision', () => {
    const files = getSyncClosure().files.map((f) => f.replaceAll('\\', '/')).filter((f) => f.endsWith('.json'));
    assert.ok(files.length >= 7, 'vacuous-pass guard: the bundle carries several JSON files');
    const shared = files.filter(isCoOwnedJsonDest).sort();
    assert.deepEqual(shared, ['.claude/settings.json', '.vscode/mcp.json', '.windowed-views.json', 'scripts/.sync-manifest.json']);
  });
});

describe('the CLI passes the safeguards the gc library keeps optional (audit R1 M1)', () => {
  it('planGarbageCollection gets a probe, and executeGarbageCollection gets expectHash', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/sync-to-repos.mjs'), 'utf8');
    assert.match(src, /planGarbageCollection\(\{[\s\S]*?probe: \(rel\) => hashConsumerFile\(repo\.path, rel\)/);
    assert.match(src, /executeGarbageCollection\(\{ root: repo\.path, deletions: gcRun, expectHash:/);
  });
});
