/**
 * @fileoverview Tests for the dashboard Plans section's markdown renderer
 * + inline-link block-list. The Mermaid CDN bootstrap is verified at the
 * shape level (block-list regex rejects dangerous schemes; relative paths
 * render as `<a>`).
 *
 * Reported behaviour (2026-05-23 persona-test): 9 relative-path links in
 * the liveness plan body rendered as literal markdown text because the
 * prior renderInline allow-list regex `/^[\w-]+\.(md|html)/` rejected
 * paths starting with `scripts/...`. Fix switched to a block-list of
 * known-dangerous URL schemes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../scripts/lib/dashboard/sections/plans.mjs';

describe('renderMarkdown — inline link rendering', () => {
  it('renders relative paths with anchor as <a> (the persona-test bug)', () => {
    const html = renderMarkdown('[ref](scripts/symbol-index/refresh.mjs#L99-L114)');
    assert.match(html, /<a href="scripts\/symbol-index\/refresh\.mjs#L99-L114">ref<\/a>/);
  });

  it('renders relative paths without anchor as <a>', () => {
    const html = renderMarkdown('[lib](scripts/lib/sensitive-paths.mjs)');
    assert.match(html, /<a href="scripts\/lib\/sensitive-paths\.mjs">lib<\/a>/);
  });

  it('renders http(s) URLs', () => {
    assert.match(renderMarkdown('[x](https://example.com)'), /<a href="https:\/\/example\.com">/);
    assert.match(renderMarkdown('[x](http://example.com)'), /<a href="http:\/\/example\.com">/);
  });

  it('renders in-page anchor links', () => {
    assert.match(renderMarkdown('[x](#some-section)'), /<a href="#some-section">/);
  });

  it('renders ./ relative paths', () => {
    assert.match(renderMarkdown('[x](./docs/foo.md)'), /<a href="\.\/docs\/foo\.md">/);
  });

  // ── Block-list: dangerous schemes must NOT render as links ─────────
  for (const url of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',                       // leading whitespace
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ]) {
    it(`blocks dangerous URL: ${url.slice(0, 30)}…`, () => {
      const html = renderMarkdown(`[click](${url})`);
      assert.doesNotMatch(html, /<a\s/, `must not produce <a>; got: ${html}`);
    });
  }
});
