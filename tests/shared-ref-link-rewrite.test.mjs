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
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { renderForTarget, findSyncTargets } from '../scripts/sync-shared-audit-refs.mjs';

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

  it('re-expresses a relative link for the target depth', () => {
    const out = renderForTarget('See [p](../../plans/foo.md).', CANON, TARGET, REPO_ROOT);
    assert.match(out, /\]\(\.\.\/\.\.\/\.\.\/docs\/plans\/foo\.md\)/);
    // The real assertion: it points at the same FILE from the new location.
    const link = relativeLinks(out)[0];
    assert.equal(
      path.resolve(path.dirname(TARGET), link),
      path.resolve(path.dirname(CANON), '../../plans/foo.md'),
      'the rewritten link must denote the same file, not merely look different',
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

  it('rendering FOR THE CANONICAL ITSELF is identity on links (same directory)', () => {
    const src = 'See [p](../../plans/foo.md).';
    const out = renderForTarget(src, CANON, CANON, REPO_ROOT);
    assert.equal(
      path.resolve(path.dirname(CANON), relativeLinks(out)[0]),
      path.resolve(path.dirname(CANON), '../../plans/foo.md'),
    );
  });

  it('is idempotent — rendering an already-rendered copy does not shift links again', () => {
    const once = renderForTarget('See [p](../../plans/foo.md).', CANON, TARGET, REPO_ROOT);
    const twice = renderForTarget(once, TARGET, TARGET, REPO_ROOT);
    assert.equal(
      path.resolve(path.dirname(TARGET), relativeLinks(twice)[0]),
      path.resolve(path.dirname(TARGET), relativeLinks(once)[0]),
      'a re-render from the target location must be stable, or repeated syncs would walk the link',
    );
  });
});
