/**
 * @fileoverview Plans tab — Active + Completed grouped lists with full
 * inline render of each plan's markdown + Mermaid diagrams.
 *
 * Background: VS Code's Markdown Preview Mermaid pipeline (bierner.markdown-
 * mermaid) is unreliable in some VS Code builds — flashes-then-disappears.
 * The Mermaid Chart MCP renders fine, GitHub renders fine, but local
 * preview is brittle. This dashboard tab bypasses the VS Code render path
 * entirely: it embeds each plan's markdown as HTML and loads Mermaid via
 * CDN at the dashboard root, so diagrams render reliably in any browser.
 *
 * Signature: `default({src, plans}, ui) → string`.
 *   plans = { active, completed }, each plan carries `.body` (raw markdown).
 *
 * @module scripts/lib/dashboard/sections/plans
 */

const SECTION = 'plans';

// ── Minimal Markdown → HTML renderer (no external dep) ─────────────────────
//
// Deliberately narrow scope — handles what plan files use:
//   - ATX headings (#…######)
//   - Fenced code blocks (``` and ```lang) with `mermaid` passed through
//     as <pre class="mermaid"> for the CDN to process
//   - Inline code (`...`)
//   - Bold (**...**), italic (*...* / _..._)
//   - Inline links [text](url)
//   - Unordered + ordered lists (one level; nested lists render flat)
//   - Block quotes (> ...)
//   - Horizontal rules (---)
//   - Paragraph wrapping for the rest
//
// Out of scope (rare in plans): tables (rendered as flat lines), HTML
// pass-through, reference-style links. Upgrade to `marked` if needed.
//
// Security: every text token is HTML-escaped BEFORE inline markdown
// substitution so user-controlled content (plan markdown) can't inject HTML.

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderInline(text) {
  // Order matters: escape first, then add inline markup tokens.
  let out = escapeHtml(text);
  // Inline code (`...`) — protected from further token substitution by
  // wrapping in a placeholder we restore at the end.
  const inlineCodes = [];
  out = out.replace(/`([^`]+)`/g, (_, code) => {
    inlineCodes.push(code);
    return ` CODE${inlineCodes.length - 1} `;
  });
  // Bold then italic (bold uses ** so process first to avoid * collisions).
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  // Inline links [text](url). Persona-test 2026-05-23 caught that the
  // prior allow-list regex (/^(https?:|#|\.|\/)/) rejected relative paths
  // like `scripts/symbol-index/refresh.mjs#L99-L114` that don't start
  // with `./` — those showed as literal `[text](url)` in the rendered
  // body. Switched to a BLOCK-list: anything that doesn't open with a
  // known-dangerous scheme renders as a link. URL is HTML-escaped before
  // landing in the href attribute (escapeHtml already ran on `out`).
  const DANGEROUS_SCHEME = /^\s*(javascript|data|vbscript|file):/i;
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, url) => {
    if (DANGEROUS_SCHEME.test(url)) return m;
    return `<a href="${url}">${text}</a>`;
  });
  // Restore inline codes (escaped inside the code element).
  out = out.replace(/ CODE(\d+) /g, (_, i) => `<code>${escapeHtml(inlineCodes[+i])}</code>`);
  return out;
}

export function renderMarkdown(md) {
  const lines = String(md || '').split('\n');
  const out = [];
  let i = 0;
  let inList = null;       // 'ul' | 'ol' | null
  let paraBuf = [];

  function flushPara() {
    if (paraBuf.length === 0) return;
    const text = paraBuf.join(' ').trim();
    paraBuf = [];
    if (text) out.push(`<p>${renderInline(text)}</p>`);
  }
  function closeList() {
    if (inList) { out.push(`</${inList}>`); inList = null; }
  }

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = line.match(/^```(\S*)?\s*$/);
    if (fence) {
      flushPara(); closeList();
      const lang = fence[1] || '';
      const code = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i]); i++;
      }
      i++; // skip closing fence
      if (lang === 'mermaid') {
        // Mermaid CDN's mermaid.run() scans for <pre class="mermaid">.
        // ESCAPE content — <pre> content is text-decoded by the browser,
        // so escaping prevents stray "</pre>" sequences from breaking
        // the markup. Mermaid parses the textContent (post-decode), which
        // gives it the original characters.
        out.push(`<pre class="mermaid">${escapeHtml(code.join('\n'))}</pre>`);
      } else {
        out.push(`<pre class="lang-${escapeHtml(lang)}"><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      }
      continue;
    }

    // Headings
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      flushPara(); closeList();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${renderInline(h[2])}</h${lvl}>`);
      i++; continue;
    }

    // Horizontal rule
    if (/^\s*---+\s*$/.test(line)) {
      flushPara(); closeList();
      out.push('<hr>');
      i++; continue;
    }

    // Block quote
    const bq = line.match(/^>\s?(.*)$/);
    if (bq) {
      flushPara(); closeList();
      const buf = [bq[1]];
      i++;
      while (i < lines.length) {
        const m = lines[i].match(/^>\s?(.*)$/);
        if (!m) break;
        buf.push(m[1]); i++;
      }
      out.push(`<blockquote>${renderInline(buf.join(' '))}</blockquote>`);
      continue;
    }

    // List items
    const ul = line.match(/^\s*[-*]\s+(.+)$/);
    const ol = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ul || ol) {
      flushPara();
      const wantList = ul ? 'ul' : 'ol';
      if (inList && inList !== wantList) closeList();
      if (!inList) { out.push(`<${wantList}>`); inList = wantList; }
      const body = (ul || ol)[1];
      out.push(`<li>${renderInline(body)}</li>`);
      i++; continue;
    }

    // Blank line
    if (line.trim() === '') {
      flushPara(); closeList();
      i++; continue;
    }

    // Paragraph
    paraBuf.push(line);
    i++;
  }
  flushPara(); closeList();
  return out.join('\n');
}

// ── Section render ─────────────────────────────────────────────────────────

function planList(plans, ui) {
  if (!plans.length) return '<p class="empty">None.</p>';
  return plans.map((p) => {
    const shortStatus = p.status ? p.status.split(/\s+[—–-]\s+|\s*\(/)[0].trim() : '';
    const statusBled = p.status && shortStatus !== p.status.trim();
    const body = p.body ? renderMarkdown(p.body) : '';
    return `<details class="row plan">
    <summary><strong>${ui.escapeHtml(p.title)}</strong>${shortStatus ? ` &mdash; ${ui.escapeHtml(shortStatus)}` : ''}</summary>
    <div class="plan-body">
      <div class="plan-meta">${p.date ? `Date: ${ui.escapeHtml(p.date)} &middot; ` : ''}${statusBled ? `Status: ${ui.escapeHtml(p.status)} &middot; ` : ''}<code>${ui.escapeHtml(p.path)}</code>${p.malformed ? ` <span class="lock">(metadata unparsed${p.statusConflict ? `: conflicting Status — ${ui.escapeHtml(p.statusConflict.join(' vs '))}` : ''})</span>` : ''}</div>
      <div class="plan-content">${body}</div>
    </div>
  </details>`;
  }).join('');
}

export default function sectionPlans({ src, plans }, ui) {
  const { active, completed } = plans;
  // A non-ok status (e.g. one plan file failed to read) gets a warning
  // PREFIX — but any plans that WERE discovered are still rendered;
  // discarding them would be a degraded-mode data-loss bug.
  const warn = ui.NON_OK.has(src.status) ? ui.warningPanel(SECTION, src) : '';
  if (!active.length && !completed.length) {
    return warn || ui.emptyPanel(null, 'No plans found.');
  }
  // Mermaid CDN bootstrap. Renders happen lazily — only when a plan's
  // <details> is open. Processing a hidden block once would mark it as
  // processed (Mermaid is idempotent), then later opens would skip it —
  // leaving an invisible SVG. Instead we target `details[open] pre.mermaid`
  // exclusively, which only matches visible blocks. Initial run handles
  // any plan that loads pre-expanded; toggle handler covers the rest.
  const mermaidBootstrap = `
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
  mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
  const runVisible = () => mermaid.run({
    querySelector: 'details[open] pre.mermaid:not([data-processed])',
    suppressErrors: true,
  }).catch(() => {});
  runVisible();
  document.addEventListener('toggle', (e) => {
    if (e.target.tagName === 'DETAILS' && e.target.open) runVisible();
  }, true);
</script>`;
  return `${warn}<h3>Active (${active.length})</h3>${planList(active, ui)}
    <h3>Completed (${completed.length})</h3>${planList(completed, ui)}
    ${mermaidBootstrap}`;
}
