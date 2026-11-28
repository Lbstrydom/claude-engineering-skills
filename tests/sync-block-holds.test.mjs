/**
 * @fileoverview Block holds — the declaration (`.sync-overrides.json` `blocks`),
 * the fragment loader, the inventory-time checks, and the renderer stage.
 *
 * Tier 3 (consumer sync contract). The grammar and splice are pinned in
 * `sync-slots.test.mjs`; the wiring through the real CLI in
 * `sync-block-holds-e2e.test.mjs`. Plan: docs/plans/sync-skill-block-holds.md
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateOverrides, loadBlockFragments, checkFragmentSources, reconcileBlockDestinations,
} from '../scripts/lib/sync-overrides.mjs';
import { renderOutbound, decideUnmanifested } from '../scripts/lib/sync-outbound.mjs';
import { normaliseFragment, SlotError } from '../scripts/lib/sync-slots.mjs';

const DEST = '.claude/skills/nav-audit/SKILL.md';
const ok = { path: DEST, slot: 'target-adapter', from: '.sync-blocks/nav.md', reason: 'electron target' };
const v = (blocks, overrides = []) => validateOverrides({ version: 1, overrides, blocks });

describe('validateOverrides — blocks', () => {
  it('a valid declaration validates; path and from are normalised', () => {
    const r = v([{ ...ok, path: '.\\.claude\\skills\\nav-audit\\SKILL.md', from: './.sync-blocks/nav.md' }]);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.blocks.map((b) => [b.path, b.slot, b.from, b.adoptHeldFile]), [[DEST, 'target-adapter', '.sync-blocks/nav.md', null]]);
  });

  it('each static rule rejects', () => {
    const rows = [
      [{ ...ok, path: '.claude/skills/nav-audit/references/x.md' }, /"path" must be a synced/],
      [{ ...ok, path: 'docs/x/SKILL.md' }, /"path" must be a synced/],
      [{ ...ok, slot: 'Target' }, /"slot" must match/],
      [{ ...ok, from: '../outside.md' }, /"from" must be a plain/],
      [{ ...ok, from: 'a//b.md' }, /"from" must be a plain/],
      [{ ...ok, from: 'a b.md' }, /"from" must be a plain/],
      [{ ...ok, from: 'x-->.md' }, /"from" must be a plain/],
      [{ ...ok, from: 'scripts/.claude-skills/x.md' }, /may not name a file the sync writes/],
      [{ ...ok, from: '.claude/skills/nav-audit/SKILL.md' }, /may not name a file the sync writes/],
      [{ ...ok, from: '.sync-receipt.json' }, /may not name a file the sync writes/],
      [{ ...ok, from: '.sync-overrides.json' }, /may not name a file the sync writes/],
      [{ ...ok, reason: ' ' }, /"reason" is required/],
      [{ ...ok, adoptHeldFile: true }, /"adoptHeldFile" must be/],
      [{ ...ok, adoptHeldFile: 'sha256:ABC' }, /"adoptHeldFile" must be/],
    ];
    for (const [entry, re] of rows) {
      const r = v([entry]);
      assert.equal(r.blocks.length, 0, JSON.stringify(entry));
      assert.ok(r.errors.some((e) => re.test(e)), `${JSON.stringify(entry)} -> ${r.errors.join(' | ')}`);
    }
  });

  it('a duplicate (path, slot) and a path also held whole-file are errors', () => {
    assert.match(v([ok, ok]).errors.join('\n'), /already declared at blocks\[0\]/);
    const r = v([ok], [{ path: DEST, reason: 'held' }]);
    assert.match(r.errors.join('\n'), /also held whole-file/);
    assert.equal(r.blocks.length, 0);
  });

  it('adoptHeldFile values on one path must agree', () => {
    const t1 = 'sha256:0123456789abcdef';
    const t2 = 'sha256:fedcba9876543210';
    assert.deepEqual(v([{ ...ok, adoptHeldFile: t1 }, { ...ok, slot: 'b', adoptHeldFile: t1 }]).errors, []);
    assert.match(v([{ ...ok, adoptHeldFile: t1 }, { ...ok, slot: 'b', adoptHeldFile: t2 }]).errors.join(), /must agree/);
  });

  it('absent blocks is fine; a non-array is an error', () => {
    assert.deepEqual(validateOverrides({ version: 1 }).blocks, []);
    assert.match(validateOverrides({ version: 1, blocks: {} }).errors.join(), /"blocks" must be an array/);
  });
});

describe('loadBlockFragments', () => {
  it('present is normalised; absent, refused and empty are errors, never "no block"', () => {
    const blocks = v([ok, { ...ok, slot: 'b', from: 'gone.md' }, { ...ok, slot: 'c', from: 'link.md' }, { ...ok, slot: 'd', from: 'empty.md' }]).blocks;
    const files = {
      '.sync-blocks/nav.md': { state: 'present', content: 'A\r\nB\r\n\r\n' },
      'gone.md': { state: 'absent' },
      'link.md': { state: 'refused', reason: 'a link' },
      'empty.md': { state: 'present', content: '\n' },
    };
    const r = loadBlockFragments('/repo', blocks, (_root, rel) => files[rel]);
    assert.equal(r.errors.length, 3, r.errors.join('\n'));
    assert.match(r.errors.join('\n'), /gone\.md is absent/);
    assert.match(r.errors.join('\n'), /link\.md is refused \(a link\)/);
    assert.match(r.errors.join('\n'), /empty/);
    const [frag] = r.byDest.get(DEST);
    assert.equal(frag.content, 'A\nB\n');
    assert.match(frag.fragmentSha, /^sha256:[0-9a-f]{64}$/);
  });
});

describe('inventory-time checks', () => {
  it('checkFragmentSources rejects a managed file under another case', () => {
    const blocks = v([{ ...ok, from: 'Docs/Guide.md' }]).blocks;
    assert.equal(checkFragmentSources(blocks, ['docs/guide.md']).length, 1);
    assert.equal(checkFragmentSources(blocks, ['docs/other.md']).length, 0);
  });

  it('reconcileBlockDestinations: rendered passes; retired and unknown are reported distinctly', () => {
    const blocks = v([ok, { ...ok, path: '.claude/skills/old/SKILL.md' }, { ...ok, path: '.claude/skills/typo/SKILL.md' }]).blocks;
    const r = reconcileBlockDestinations(blocks, { rendered: new Set([DEST]), retired: new Set(['.claude/skills/old/SKILL.md']) });
    assert.deepEqual(r.map((x) => [x.path, x.code]), [
      ['.claude/skills/old/SKILL.md', 'block-dest-retired'],
      ['.claude/skills/typo/SKILL.md', 'block-dest-unknown'],
    ]);
  });
});

describe('renderOutbound — consumer blocks splice AFTER the rewriter', () => {
  const dst = '.claude/skills/demo/SKILL.md';
  const src = '# Demo\n\nrun node scripts/openai-audit.mjs\n\n<!-- sync-slot:target-adapter -->\n\n## Next\n';
  const rewriteConfig = { ownedSourceTails: new Set(['openai-audit.mjs']) };
  const blocks = [{ slot: 'target-adapter', from: '.sync-blocks/demo.md', content: normaliseFragment('consumer: node scripts/openai-audit.mjs --local\n') }];

  it('upstream text is rewritten; the consumer fragment reaches the file verbatim', () => {
    const r = renderOutbound({ srcRel: dst, dstRel: dst, srcContent: src, rewriteConfig, blocks });
    assert.match(r.content, /^run node scripts\/\.claude-skills\/openai-audit\.mjs$/m, 'upstream line rewritten');
    assert.match(r.content, /^consumer: node scripts\/openai-audit\.mjs --local$/m, 'fragment line untouched');
    assert.deepEqual(r.blocksApplied, [{ slot: 'target-adapter', anchorHeading: '# Demo' }]);
  });

  it('no blocks renders as before: the marker line stays, inert', () => {
    const r = renderOutbound({ srcRel: dst, dstRel: dst, srcContent: src, rewriteConfig });
    assert.ok(r.content.includes('<!-- sync-slot:target-adapter -->'));
    assert.deepEqual(r.blocksApplied, []);
  });

  it('a declared slot upstream no longer has THROWS, so the caller fails the file rather than dropping the block', () => {
    assert.throws(() => renderOutbound({ srcRel: dst, dstRel: dst, srcContent: '# Demo\n', rewriteConfig, blocks }),
      (e) => e instanceof SlotError && e.code === 'slot-missing');
  });

  it('decideUnmanifested compares against the SPLICED bytes', () => {
    const rendered = renderOutbound({ srcRel: dst, dstRel: dst, srcContent: src, rewriteConfig, blocks }).content;
    const withBlocks = decideUnmanifested({ srcRel: dst, dstRel: dst, destContent: rendered, sourceText: src, rewriteConfig, blocks, bannerMarker: 'UPSTREAM-OWNED' });
    assert.equal(withBlocks.disposition, 'owned');
    const without = decideUnmanifested({ srcRel: dst, dstRel: dst, destContent: rendered, sourceText: src, rewriteConfig, bannerMarker: 'UPSTREAM-OWNED' });
    assert.equal(without.disposition, 'collision', 'negative control: without the blocks the same bytes are not provably ours');
  });
});

describe('adoption: a whole-file hold swapped for a block hold (plan Q4)', async () => {
  const { decideAction, adoptionState, adoptionToken, assessBlockMigration, BASE_STATE } = await import('../scripts/lib/sync-divergence.mjs');
  const held = (p) => ({ syncedAt: 't', overridesHeld: [{ path: p }] });
  const applied = (p) => ({ syncedAt: 't', blocksApplied: [{ path: p, slot: 's' }] });
  const refusedOnly = (p) => ({ syncedAt: 't', divergenceRefused: [{ path: p }] });
  const cur = { hasBlocks: true, hasOverride: false };

  it('adoptionState reads the newest entry that RECORDS the path; refusal-only entries are skipped', () => {
    assert.equal(adoptionState([held(DEST)], DEST, cur), 'pending');
    assert.equal(adoptionState([refusedOnly(DEST), refusedOnly(DEST), held(DEST)], DEST, cur), 'pending', 'a failed attempt keeps the evidence');
    assert.equal(adoptionState([applied(DEST), held(DEST)], DEST, cur), 'adopted');
    assert.equal(adoptionState([held(DEST), applied(DEST)], DEST, cur), 'pending', 'held again after an adoption: a new generation');
    assert.equal(adoptionState([], DEST, cur), 'none');
  });

  it('pending requires a CURRENT block declaration and no override (a dropped hold keeps the old table)', () => {
    assert.equal(adoptionState([held(DEST)], DEST, { hasBlocks: false, hasOverride: false }), 'none');
    assert.equal(adoptionState([held(DEST)], DEST, { hasBlocks: true, hasOverride: true }), 'none');
  });

  it('adoptionToken folds EOL: a CRLF checkout of the same commit yields the same token', () => {
    assert.equal(adoptionToken(Buffer.from('a\r\nb\r\n')), adoptionToken('a\nb\n'));
    assert.match(adoptionToken('x'), /^sha256:[0-9a-f]{16}$/);
    assert.notEqual(adoptionToken('x'), adoptionToken('y'));
  });

  it('assessBlockMigration: (c) fragment present, (d) committed, (e) token names these bytes — each fails alone', () => {
    const disk = Buffer.from('# Skill\n<!-- repo:start -->\nADAPTER\n<!-- repo:end -->\nold upstream\n');
    const frags = [{ content: '<!-- repo:start -->\nADAPTER\n<!-- repo:end -->\n' }];
    const token = adoptionToken(disk);
    const base = { diskBytes: disk, fragments: frags, matchesHead: true, adoptHeldFile: token };
    assert.deepEqual(assessBlockMigration(base), { eligible: true, failed: null, token });
    assert.equal(assessBlockMigration({ ...base, fragments: [{ content: 'NOT THERE\n' }] }).failed, 'c');
    assert.equal(assessBlockMigration({ ...base, matchesHead: false }).failed, 'd');
    assert.equal(assessBlockMigration({ ...base, matchesHead: null }).failed, 'd', 'git unanswerable is not committed');
    assert.equal(assessBlockMigration({ ...base, adoptHeldFile: null }).failed, 'e');
    assert.equal(assessBlockMigration({ ...base, adoptHeldFile: adoptionToken('an older generation') }).failed, 'e', 'a stale token refuses');
  });

  it('decideAction: 1b/1c sit below HOLD and above prior-upstream and untracked; the flag beats 1c', () => {
    const D = BASE_STATE.DIVERGED;
    const go = (extra) => decideAction({ baseState: D, vcs: { tracked: false, matchesHead: null, priorUpstream: true }, overrideActive: false, allowOverwriteDiverged: false, ...extra });
    assert.equal(go({ overrideActive: true, blockAdoption: { pending: true, eligible: true } }).action, 'hold');
    assert.deepEqual(go({ blockAdoption: { pending: true, eligible: true } }), { action: 'write-loud', reason: 'block-hold-migration' });
    assert.deepEqual(go({ blockAdoption: { pending: true, eligible: false } }), { action: 'refuse', reason: 'block-hold-migration-blocked' },
      'an untracked, prior-upstream-matching held file is still REFUSED while its adoption is pending');
    assert.equal(go({ blockAdoption: { pending: true, eligible: false }, allowOverwriteDiverged: true }).reason, 'diverged-overwrite-flag');
    assert.equal(go({ blockAdoption: null }).reason, 'diverged-prior-upstream', 'no adoption question: the existing table, unchanged');
    assert.equal(decideAction({ baseState: BASE_STATE.PRISTINE, vcs: null, overrideActive: false, allowOverwriteDiverged: false, blockAdoption: { pending: true, eligible: false } }).action, 'write',
      'adoption rules apply to a DIVERGED base only');
  });
});

describe('prior-upstream rendering: a blob that predates the slot is incomparable, not a renderer fault', async () => {
  const { createPriorUpstreamResolver } = await import('../scripts/lib/sync-divergence.mjs');
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const SRC = '.claude/skills/demo/SKILL.md';

  it('a SlotError counts as slotIncomparable and never matches; any other throw still counts as renderFailures', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slot-prior-'));
    try {
      const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
      git('init', '-q', '--initial-branch=main');
      git('config', 'user.email', 't@example.invalid');
      git('config', 'user.name', 't');
      mkdirSync(join(dir, '.claude/skills/demo'), { recursive: true });
      writeFileSync(join(dir, SRC), '# old version, no marker\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'v1', '--no-gpg-sign');

      const slotThrow = createPriorUpstreamResolver({ sourceRoot: dir });
      const v1 = slotThrow.matches(SRC, 'f'.repeat(64), { render: () => { throw new SlotError('slot-missing', 'no marker'); }, acceptRaw: false });
      assert.notEqual(v1, true, 'an incomparable blob never grants prior-upstream permission');
      assert.equal(slotThrow.stats.slotIncomparable, 1);
      assert.equal(slotThrow.stats.renderFailures, 0);

      // Positive control: the instrument CAN count a real renderer fault.
      const plainThrow = createPriorUpstreamResolver({ sourceRoot: dir });
      plainThrow.matches(SRC, 'f'.repeat(64), { render: () => { throw new Error('boom'); }, acceptRaw: false });
      assert.equal(plainThrow.stats.renderFailures, 1);
      assert.equal(plainThrow.stats.slotIncomparable, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
