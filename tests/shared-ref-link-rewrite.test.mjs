/**
 * @fileoverview Synced shared references must be CORRECT at their location,
 * not byte-identical to the canonical.
 *
 * ## The defect
 *
 * `sync-shared-audit-refs.mjs` copied bytes verbatim, which broke two things
 * across all 11 pairs (raised as M1/M3 by the consolidated audit; pre-existing,
 * not introduced by the change that surfaced them):
 *
 *  1. A relative link like `](../../plans/foo.md)` is correct from
 *     `docs/audit/shared-references/` and points at a NON-EXISTENT
 *     `skills/plans/` from a skill's `references/`. The two locations sit at
 *     different depths, so no single byte string can be right in both — the
 *     link has to be recomputed per target.
 *  2. Every copy asserted "This is the canonical copy… **Edit this file, never
 *     a copy.**" — advice that is exactly backwards when read in the copy it is
 *     telling you to edit.
 *
 * The fix is a per-target render, so these files are deliberately NOT
 * byte-identical any more. `--check` still catches drift because it compares
 * the RENDERED form, not the raw canonical.
 *
 * ## The second hop (2026-09-04)
 *
 * "Recompute the link for the target" was still half the answer, and the
 * assertions below encoded the half. `skills/<skill>/references/x.md` is not the
 * last stop: `skills:regenerate` copies it to
 * `.claude/skills/<skill>/references/x.md`, one level DEEPER, and that is the
 * tree a consumer receives. A `../../../docs/…` recomputed to reach the repo
 * root from the first path lands in `.claude/` from the second — dead in the
 * generated copy AND in every consumer, while resolving perfectly from the file
 * an author has open. Measured: 47 links, 35 of them emitted by this renderer.
 *
 * So the test is not "is this relative path right where I am writing it" but
 * "does it stay right after another move". Only a target inside `skills/`
 * survives, because `.claude/skills/**` mirrors `skills/**` at the same relative
 * offset; everything else gets an absolute upstream URL. Both branches are
 * asserted below, and the standing gate is `npm run docs:synced-links:gate`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { renderForTarget, findSyncTargets } from '../scripts/sync-shared-audit-refs.mjs';
import { upstreamUrlFor } from '../scripts/lib/synced-doc-links.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** Every `](./…)` / `](../…)` link in a document, anchors stripped. */
function relativeLinks(text) {
  return [...text.matchAll(/\]\((\.\.?\/[^)\s]+)\)/g)].map(m => m[1]);
}

describe('shared references — every relative link resolves FROM ITS OWN LOCATION', () => {
  const pairs = findSyncTargets(REPO_ROOT);

  it('vacuous-pass guard: there are pairs, and they contain links to check', () => {
    assert.ok(pairs.length > 0, 'no sync pairs — every assertion below would pass for free');
    const anyLinks = pairs.some(p => relativeLinks(fs.readFileSync(p.canonical, 'utf-8')).length > 0);
    assert.ok(anyLinks, 'no relative links in any canonical — this guard would be vacuous');
  });

  for (const { canonical, target, skill, basename } of pairs) {
    if (!fs.existsSync(target)) continue;   // bootstrap case; `--check` owns it
    it(`${skill}/references/${basename} — links resolve on disk`, () => {
      const broken = relativeLinks(fs.readFileSync(target, 'utf-8'))
        .map(l => ({ link: l, abs: path.resolve(path.dirname(target), l.split('#')[0]) }))
        .filter(x => !fs.existsSync(x.abs))
        .map(x => x.link);
      assert.deepEqual(
        broken, [],
        `a link copied verbatim from ${path.relative(REPO_ROOT, canonical)} does not resolve here — `
        + 'the sync must REWRITE relative links per target, not copy them',
      );
    });
  }

  it('the canonicals\' own links resolve too (the rewrite must not be papering over a bad source)', () => {
    const canonicals = [...new Set(pairs.map(p => p.canonical))];
    const broken = [];
    for (const c of canonicals) {
      for (const l of relativeLinks(fs.readFileSync(c, 'utf-8'))) {
        if (!fs.existsSync(path.resolve(path.dirname(c), l.split('#')[0]))) broken.push(`${c} -> ${l}`);
      }
    }
    assert.deepEqual(broken, []);
  });
});

describe('renderForTarget — the rewrite itself', () => {
  const CANON = path.join(REPO_ROOT, 'docs', 'audit', 'shared-references', 'x.md');
  const TARGET = path.join(REPO_ROOT, 'skills', 'audit-code', 'references', 'x.md');

  it('a link OUT of skills/ becomes an absolute upstream URL', () => {
    const out = renderForTarget('See [p](../../plans/foo.md).', CANON, TARGET, REPO_ROOT);
    // Same invariant as before — it must denote the same FILE — now expressed
    // as a repo-relative path inside the URL rather than as a `../` count.
    assert.equal(
      out,
      `See [p](${upstreamUrlFor('docs/plans/foo.md')}).`,
      'the rewritten link must denote the same file, not merely look different',
    );
    assert.equal(relativeLinks(out).length, 0, 'nothing relative may survive for an out-of-skills target');
  });

  it('a link INTO skills/ stays relative, because .claude/skills mirrors skills', () => {
    // The one target that survives the SECOND copy: skills:regenerate puts this
    // file at .claude/skills/audit-code/references/x.md, and `.claude/skills/**`
    // mirrors `skills/**` at the same relative offset — so the same `../` count
    // is correct in both. Everything else is why the URL branch exists.
    const src = 'See [s](../../../skills/ship/examples/e.md).';
    const out = renderForTarget(src, CANON, TARGET, REPO_ROOT);
    const link = relativeLinks(out)[0];
    assert.ok(link, 'an intra-skills target must not be URL-ified');
    assert.equal(
      path.resolve(path.dirname(TARGET), link),
      path.join(REPO_ROOT, 'skills', 'ship', 'examples', 'e.md'),
    );
    // And the same string, read one level deeper, still lands on the mirror.
    const deeper = path.join(REPO_ROOT, '.claude', 'skills', 'audit-code', 'references', 'x.md');
    assert.equal(
      path.resolve(path.dirname(deeper), link),
      path.join(REPO_ROOT, '.claude', 'skills', 'ship', 'examples', 'e.md'),
      'the whole point of keeping this one relative: it survives the copy into .claude/skills/',
    );
  });

  it('leaves URLs, absolute paths and anchors alone', () => {
    const src = 'a [x](https://example.com/a) b [y](/abs/path.md) c [z](#anchor)';
    assert.equal(renderForTarget(src, CANON, TARGET, REPO_ROOT), src);
  });

  it('preserves an optional link title', () => {
    const out = renderForTarget('[p](../../plans/foo.md "Title")', CANON, TARGET, REPO_ROOT);
    assert.match(out, /"Title"\)/, 'the title must survive the rewrite');
  });

  it('replaces the canonical self-description with a generated-copy banner', () => {
    const src = 'Intro.\n\nThis is the canonical copy. Blah blah.\n**Edit this file, never a copy.**\n\nBody.';
    const out = renderForTarget(src, CANON, TARGET, REPO_ROOT);
    assert.ok(!out.includes('Edit this file, never a copy'),
      'a COPY must not instruct the reader to edit it');
    assert.match(out, /GENERATED COPY — do not edit/);
    assert.match(out, /docs\/audit\/shared-references\/x\.md/, 'the banner must name the canonical');
    assert.ok(out.includes('Body.'), 'surrounding content must be preserved');
  });

  it('is a no-op on text with neither links nor the self-description', () => {
    const src = '# Title\n\nJust prose.\n';
    assert.equal(renderForTarget(src, CANON, TARGET, REPO_ROOT), src);
  });

  it('rendering FOR THE CANONICAL ITSELF still denotes the same file', () => {
    // `docs/` is outside skills/, so even the identity render URL-ifies. The
    // invariant under test was never "the bytes are unchanged" — it is "the
    // link still points at docs/plans/foo.md", and that survives.
    const out = renderForTarget('See [p](../../plans/foo.md).', CANON, CANON, REPO_ROOT);
    assert.equal(out, `See [p](${upstreamUrlFor('docs/plans/foo.md')}).`);
  });

  it('is idempotent — rendering an already-rendered copy does not shift links again', () => {
    const once = renderForTarget('See [p](../../plans/foo.md).', CANON, TARGET, REPO_ROOT);
    const twice = renderForTarget(once, TARGET, TARGET, REPO_ROOT);
    assert.equal(
      twice, once,
      'a re-render from the target location must be stable, or repeated syncs would walk the link',
    );
    // The relative branch has to be idempotent too — it is the one that can walk.
    const relOnce = renderForTarget('See [s](../../../skills/ship/examples/e.md).', CANON, TARGET, REPO_ROOT);
    const relTwice = renderForTarget(relOnce, TARGET, TARGET, REPO_ROOT);
    assert.equal(relTwice, relOnce);
  });
});
