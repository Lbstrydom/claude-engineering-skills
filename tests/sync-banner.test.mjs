/**
 * Tests for the upstream-owned banner injected into relocated synced tooling.
 * Plan: docs/plans/consumer-deployment-hardening.md. Pure string transform
 * (Tier-1 deterministic seam).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { injectUpstreamBanner, bannerTokenFor, BANNER_BODY } from '../scripts/lib/sync-banner.mjs';

const MARKER = 'UPSTREAM-OWNED — DO NOT EDIT HERE';

describe('sync-banner — injectUpstreamBanner', () => {
  it('injects a // banner into relocated .mjs tooling', () => {
    const out = injectUpstreamBanner('export const x = 1;\n', 'scripts/.claude-skills/foo.mjs');
    assert.ok(out.startsWith('// ' + BANNER_BODY[0]), 'banner first line at top');
    assert.ok(out.includes(MARKER));
    assert.ok(out.endsWith('export const x = 1;\n'), 'original content preserved');
  });

  it('is idempotent (re-running does not stack banners)', () => {
    const once = injectUpstreamBanner('export const x = 1;\n', 'scripts/.claude-skills/foo.mjs');
    const twice = injectUpstreamBanner(once, 'scripts/.claude-skills/foo.mjs');
    assert.equal(twice, once);
    assert.equal((twice.match(new RegExp(MARKER, 'g')) || []).length, 1, 'exactly one banner');
  });

  it('places the banner AFTER a shebang when present', () => {
    const out = injectUpstreamBanner('#!/usr/bin/env node\nconst x=1;\n', 'scripts/.claude-skills/cli.mjs');
    const lines = out.split('\n');
    assert.equal(lines[0], '#!/usr/bin/env node', 'shebang stays line 1');
    assert.ok(lines[1].startsWith('// ' + BANNER_BODY[0]), 'banner directly under shebang');
  });

  it('uses # for .sh tooling', () => {
    const out = injectUpstreamBanner('echo hi\n', 'scripts/.claude-skills/run.sh');
    assert.ok(out.startsWith('# ' + BANNER_BODY[0]));
  });

  it('does NOT touch tracked skills (only scripts/.claude-skills/)', () => {
    assert.equal(injectUpstreamBanner('# Skill\n', '.claude/skills/plan/SKILL.md'), '# Skill\n');
  });

  it('skips non-comment-capable (JSON) relocated files', () => {
    assert.equal(injectUpstreamBanner('{"a":1}\n', 'scripts/.claude-skills/data.json'), '{"a":1}\n');
    assert.equal(bannerTokenFor('scripts/.claude-skills/data.json'), null);
  });

  it('an import-intended bannered module still parses (banner is a comment)', async () => {
    // Sanity: a // comment block at the top never breaks ESM parsing.
    const src = injectUpstreamBanner('export const ok = 42;\n', 'scripts/.claude-skills/lib/x.mjs');
    const dataUrl = 'data:text/javascript,' + encodeURIComponent(src);
    const mod = await import(dataUrl);
    assert.equal(mod.ok, 42);
  });

  it('banners a file that merely CONTAINS the marker in its body (not already-bannered)', () => {
    // The idempotency guard must check the TOP, not whole-file includes() —
    // else sync-banner.mjs itself (which contains the marker) self-skips.
    const body = 'const M = "UPSTREAM-OWNED — DO NOT EDIT HERE";\nexport { M };\n';
    const out = injectUpstreamBanner(body, 'scripts/.claude-skills/lib/sync-banner.mjs');
    assert.ok(out.startsWith('// ' + BANNER_BODY[0]), 'body-marker file still gets a top banner');
    assert.ok(out.endsWith(body), 'original body preserved');
  });

  it('keeps a shebang at byte 0 even with no trailing newline', () => {
    const out = injectUpstreamBanner('#!/usr/bin/env node', 'scripts/.claude-skills/cli.mjs');
    assert.ok(out.startsWith('#!/usr/bin/env node\n'), 'shebang stays at byte 0');
    assert.ok(out.includes('// ' + BANNER_BODY[0]), 'banner present after shebang');
  });

  // Python files ship too (lib/symbol-index/python-ast-helper.py). Two Python
  // rules a naive prepend breaks: a BOM must stay byte 0, and a PEP 263 coding
  // cookie only counts on line 1 or 2.
  // The Python banner is ASCII-only (a file may declare an ascii cookie).
  const PY_FIRST = '# ' + BANNER_BODY[0].replace('\u26A0', '!!').replaceAll('\u2014', '-');

  it('the Python banner is pure ASCII, so an ascii-cookie file still decodes', () => {
    const out = injectUpstreamBanner('# coding: ascii\nx = 1\n', 'scripts/.claude-skills/lib/x.py');
    assert.ok(/^[\x00-\x7F]*$/.test(out), 'no non-ASCII byte may reach a .py file');
    assert.ok(out.split('\n')[1].startsWith('# !! UPSTREAM-OWNED'));
    // NEGATIVE CONTROL: other languages keep the original glyphs.
    assert.ok(injectUpstreamBanner('x', 'scripts/.claude-skills/a.mjs').includes('\u26A0'));
  });

  it('a .py BOM stays at byte 0, banner after it, idempotent', () => {
    const dst = 'scripts/.claude-skills/lib/x.py';
    const out = injectUpstreamBanner('﻿def f():\n    pass\n', dst);
    assert.ok(out.startsWith('\uFEFF' + PY_FIRST));
    assert.equal(out.indexOf('﻿', 1), -1, 'no BOM mid-file');
    assert.equal(injectUpstreamBanner(out, dst), out);
  });

  it('a .py coding cookie keeps its line-1/line-2 position, with or without a shebang', () => {
    const dst = 'scripts/.claude-skills/lib/x.py';
    const a = injectUpstreamBanner('# -*- coding: latin-1 -*-\nx = 1\n', dst).split('\n');
    assert.equal(a[0], '# -*- coding: latin-1 -*-');
    assert.equal(a[1], PY_FIRST);
    const b = injectUpstreamBanner('#!/usr/bin/env python3\n# coding: utf-8\nx = 1\n', dst).split('\n');
    assert.deepEqual(b.slice(0, 3), ['#!/usr/bin/env python3', '# coding: utf-8', PY_FIRST]);
    // NEGATIVE CONTROL: a cookie-looking line on line 3 is not a cookie and does not move.
    const c = injectUpstreamBanner('x = 1\ny = 2\n# coding: latin-1\n', dst).split('\n');
    assert.equal(c[0], PY_FIRST);
  });

  it('idempotency holds on CRLF line endings (Windows consumers)', () => {
    const once = injectUpstreamBanner('export const x = 1;\r\n', 'scripts/.claude-skills/foo.mjs');
    const twice = injectUpstreamBanner(once, 'scripts/.claude-skills/foo.mjs');
    assert.equal(twice, once, 'CRLF already-bannered file must not re-inject');
  });
});

// Guards the production wiring so the helper can't go inert if the call is ever
// removed. Presence-only (NOT position-ordering): asserting indexOf ordering
// would be brittle to harmless refactors — the unit tests + dry-run cover the
// rewrite→banner→hash sequence.
describe('sync-banner — production integration in sync-to-repos.mjs', () => {
  it('imports + calls injectUpstreamBanner on outbound content', () => {
    // The outbound pipeline is ONE function now (lib/sync-outbound.mjs `renderOutbound`); the banner is its last stage, and the
    // CLI's write loop renders through it.
    const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');
    const outbound = read('../scripts/lib/sync-outbound.mjs');
    assert.ok(/import\s*\{[^}]*injectUpstreamBanner[^}]*\}\s*from\s*['"]\.\/sync-banner\.mjs['"]/.test(outbound),
      'renderOutbound must import injectUpstreamBanner');
    assert.ok(outbound.includes('injectUpstreamBanner(rewritten.rewritten, dstRel)'),
      'renderOutbound must call injectUpstreamBanner on the rewritten content');
    assert.ok(/rendered = renderOutbound\(\{/.test(read('../scripts/sync-to-repos.mjs')),
      'sync-to-repos must render outbound content through renderOutbound');
  });
});
