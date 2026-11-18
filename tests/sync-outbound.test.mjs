/**
 * @fileoverview Debts 07a3dbdd565b (blanket deepMerge), 77c917615461 (the ownership comparand was a second, shorter
 * pipeline) and ae70a5d51c16 (an unmanifested file was "ours" because its source and destination paths matched).
 *
 * `renderOutbound` is the ONE definition of "the bytes we would write"; `decideUnmanifested` is the ONE decision on an
 * existing destination the manifest does not vouch for. Red evidence replays the parent's behaviour as pure functions.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderOutbound, decideUnmanifested } from '../scripts/lib/sync-outbound.mjs';
import { isCoOwnedJsonDest } from '../scripts/lib/sync-path-map.mjs';
import { deepMerge } from '../scripts/lib/json-merge.mjs';
import { canonicaliseOutboundEol } from '../scripts/lib/sync-eol-pins.mjs';
import { rewriteCommandSurface } from '../scripts/lib/sync-rewriter.mjs';
import { injectUpstreamBanner, BANNER_BODY } from '../scripts/lib/sync-banner.mjs';

const cfg = { ownedSourceTails: new Set() };
const BANNER = Array.isArray(BANNER_BODY) ? BANNER_BODY[0] : String(BANNER_BODY);
const render = (srcRel, dstRel, srcContent, existingContent = null) =>
  renderOutbound({ srcRel, dstRel, srcContent, existingContent, rewriteConfig: cfg });

/** The parent's comparand: EOL fold -> rewrite -> banner, with NO JSON stage (sync-to-repos.mjs at 593a6f35). */
const parentExpected = (dstRel, src) =>
  injectUpstreamBanner(rewriteCommandSurface({ relPath: dstRel, content: canonicaliseOutboundEol(dstRel, src), config: cfg }).rewritten, dstRel);

describe('isCoOwnedJsonDest — derived from the layout map, not a list', () => {
  it('the consumer config namespace is shared; every relocated JSON asset is upstream-exclusive', () => {
    for (const f of ['.claude/settings.json', '.vscode/mcp.json', '.windowed-views.json']) assert.equal(isCoOwnedJsonDest(f), true, f);
    for (const f of ['scripts/lib/oss-call-policy.json', 'scripts/lib/bundle-deps.json', 'tests/fixtures/expected-schema.json', 'scripts/lib/dashboard/flows.json']) {
      assert.equal(isCoOwnedJsonDest(f), false, f);
    }
    assert.equal(isCoOwnedJsonDest('scripts/lib/x.mjs'), false, 'not a JSON file at all');
  });
});

describe('renderOutbound — a shared surface merges, an upstream-exclusive one is REPLACED (07a3dbdd565b)', () => {
  const upstream = JSON.stringify({ keep: 1, nested: { a: 1 } });

  it('RED on the parent: deepMerge kept a key upstream had deleted; the renderer does not', () => {
    const existing = JSON.stringify({ keep: 1, retiredByUpstream: true, nested: { a: 1, b: 2 } });
    const parentOut = deepMerge(JSON.parse(existing), JSON.parse(upstream));
    assert.equal(parentOut.retiredByUpstream, true, 'red evidence: the parent merged it back in for EVERY .json destination');
    const out = JSON.parse(render('scripts/lib/oss-call-policy.json', 'scripts/.claude-skills/lib/oss-call-policy.json', upstream, existing).content);
    assert.deepEqual(out, { keep: 1, nested: { a: 1 } });
  });

  it('an upstream-exclusive destination never even PARSES the consumer\'s content', () => {
    assert.doesNotThrow(() => render('scripts/lib/oss-call-policy.json', 'scripts/.claude-skills/lib/oss-call-policy.json', upstream, '{ not json'));
  });

  it('a SHARED surface keeps the consumer\'s own keys (positive control: the merge still happens)', () => {
    const consumer = JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, mine: true });
    const out = JSON.parse(render('.claude/settings.json', '.claude/settings.json', JSON.stringify({ hooks: { x: 1 } }), consumer).content);
    assert.equal(out.mine, true);
    assert.deepEqual(out.permissions, { allow: ['Bash(ls)'] });
    assert.deepEqual(out.hooks, { x: 1 });
  });

  it('a shared surface whose existing content is malformed THROWS (the caller reports that file as an error)', () => {
    assert.throws(() => render('.claude/settings.json', '.claude/settings.json', '{}', '{ not json'));
  });

  it('output is a function of the source alone on a first write (one stringify path)', () => {
    const a = render('.vscode/mcp.json', '.vscode/mcp.json', '{"args":["a","b"]}', null).content;
    const b = render('.vscode/mcp.json', '.vscode/mcp.json', '{"args":["a","b"]}', '{"args":["a","b"]}').content;
    assert.equal(a, b);
    assert.equal(a, '{\n  "args": [\n    "a",\n    "b"\n  ]\n}\n');
  });

  it('relocated tooling gets the banner, LF-folded, with rewrite hits reported', () => {
    const r = render('scripts/lib/x.mjs', 'scripts/.claude-skills/lib/x.mjs', 'export const a = 1;\r\n');
    assert.ok(r.content.includes(BANNER));
    assert.equal(r.content.includes('\r'), false);
    assert.equal(typeof r.rewrite.hits, 'number');
  });
});

describe('decideUnmanifested — ownership needs EVIDENCE (ae70a5d51c16, 77c917615461)', () => {
  const base = { rewriteConfig: cfg, bannerMarker: BANNER, priorUpstreamMatches: () => false };

  it('RED on the parent: a consumer\'s OWN same-named skill file was claimed because dst === src', () => {
    const consumerOwn = '# My own plan skill\nnot ours\n';
    const v = decideUnmanifested({ ...base, srcRel: '.claude/skills/plan/SKILL.md', dstRel: '.claude/skills/plan/SKILL.md', destContent: consumerOwn, sourceText: '# upstream plan\n' });
    assert.equal(v.disposition, 'collision');
    // The parent's rule (sync-to-repos.mjs at 593a6f35, `ownedByInventoryNonRelocating`): absent from the manifest and dst === src.
    const parentOwnedByInventory = (dstRel, srcRel, inManifest) => !inManifest && dstRel === srcRel;
    assert.equal(parentOwnedByInventory('.claude/skills/plan/SKILL.md', '.claude/skills/plan/SKILL.md', false), true,
      'red evidence: the parent called it owned on the path alone');
  });

  it('byte-identical to what we would write: owned (positive control)', () => {
    const src = '# upstream plan\n';
    const v = decideUnmanifested({ ...base, srcRel: '.claude/skills/plan/SKILL.md', dstRel: '.claude/skills/plan/SKILL.md', destContent: src, sourceText: src });
    assert.deepEqual([v.disposition, v.evidence], ['owned', 'identical-to-source']);
  });

  it('carries our banner: owned', () => {
    const dest = `// ${BANNER}\nexport {};\n`;
    const v = decideUnmanifested({ ...base, srcRel: 'scripts/lib/x.mjs', dstRel: 'scripts/.claude-skills/lib/x.mjs', destContent: dest, sourceText: 'export const different = 1;\n' });
    assert.deepEqual([v.disposition, v.evidence], ['owned', 'banner']);
  });

  it('identical to an EARLIER upstream version: owned, but only when asked last and only when nothing was rewritten', () => {
    let asked = 0;
    const stale = decideUnmanifested({ ...base, srcRel: '.claude/skills/plan/SKILL.md', dstRel: '.claude/skills/plan/SKILL.md', destContent: '# an older upstream\n', sourceText: '# upstream plan\n', priorUpstreamMatches: () => { asked++; return true; } });
    assert.deepEqual([stale.disposition, stale.evidence, asked], ['owned', 'prior-upstream', 1]);
    for (const answer of [false, null]) {
      const v = decideUnmanifested({ ...base, srcRel: '.claude/skills/plan/SKILL.md', dstRel: '.claude/skills/plan/SKILL.md', destContent: '# mine\n', sourceText: '# upstream plan\n', priorUpstreamMatches: () => answer });
      assert.equal(v.disposition, 'collision', `answer ${answer} (unknown is never evidence)`);
    }
  });

  it('an unreadable source proves nothing: only a banner could', () => {
    const v = decideUnmanifested({ ...base, srcRel: '.claude/skills/plan/SKILL.md', dstRel: '.claude/skills/plan/SKILL.md', destContent: '# x\n', sourceText: null, priorUpstreamMatches: () => true });
    assert.equal(v.disposition, 'collision');
  });

  it('an empty or unreadable destination is a collision (fails closed)', () => {
    for (const destContent of ['', null]) {
      assert.equal(decideUnmanifested({ ...base, srcRel: '.claude/skills/plan/SKILL.md', dstRel: '.claude/skills/plan/SKILL.md', destContent, sourceText: '# u\n' }).disposition, 'collision');
    }
  });

  it('a SHARED config surface is merged, not claimed: shared-merge for a JSON object, collision for anything else', () => {
    const f = (destContent) => decideUnmanifested({ ...base, srcRel: '.claude/settings.json', dstRel: '.claude/settings.json', destContent, sourceText: '{"hooks":{}}' }).disposition;
    assert.equal(f('{"permissions":{"allow":[]}}'), 'shared-merge');
    for (const bad of ['', 'not json', '[1,2]', 'null', null]) assert.equal(f(bad), 'collision', JSON.stringify(bad));
  });

  it('a byte-identical canonical JSON orphan on an upstream-exclusive path is OWNED; the parent comparand called it a collision (77c917615461)', () => {
    const srcRel = 'scripts/lib/oss-call-policy.json';
    const dstRel = 'scripts/.claude-skills/lib/oss-call-policy.json';
    const src = '{"a":[1,2],"b":{"c":3}}'; // compact on purpose: the writer pretty-prints it
    const onDisk = render(srcRel, dstRel, src).content;
    assert.notEqual(onDisk, parentExpected(dstRel, src), 'red evidence: the parent comparand (no JSON stage) differs from what is written');
    const v = decideUnmanifested({ ...base, srcRel, dstRel, destContent: onDisk, sourceText: src });
    assert.deepEqual([v.disposition, v.evidence], ['owned', 'identical-to-source']);
  });
});
