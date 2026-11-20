/**
 * @fileoverview Injects an "UPSTREAM-OWNED — do not edit" banner into synced
 * tooling that lands in consumer repos under `scripts/.claude-skills/` (the
 * gitignored isolation tree).
 *
 * Why: that tree is the deceptively-attractive fiddle target — an agent hitting
 * a bug there mid-task is tempted to patch the synced copy locally. But it's
 * gitignored (invisible to review), overwritten on the next sync (fix lost), and
 * the upstream bug never gets fixed (every consumer keeps hitting it). The banner
 * is a forcing function *at the moment of temptation* (opening the file): you
 * can't edit without reading "don't — fix upstream + re-sync." Plan:
 * docs/plans/consumer-deployment-hardening.md.
 *
 * Comment-only (never breaks `.mjs`/`import`); idempotent by construction (sync
 * reads the banner-free SOURCE each time, injects exactly one); placed after a
 * shebang when present. JSON tooling can't carry comments → skipped (the
 * manifest-hash drift detector + the dir name cover those).
 *
 * @module scripts/lib/sync-banner
 */

/** Destination prefix for relocated (gitignored) synced tooling. */
export const RELOCATED_TOOLING_PREFIX = 'scripts/.claude-skills/';

/** Line-comment token by extension. Absent ⇒ not comment-capable ⇒ no banner. */
const COMMENT_TOKEN_BY_EXT = {
  '.mjs': '//', '.js': '//', '.cjs': '//', '.sh': '#', '.bash': '#', '.py': '#',
};

/** The banner body (comment token is prefixed per line at injection time). */
export const BANNER_BODY = [
  '⚠ UPSTREAM-OWNED — DO NOT EDIT HERE. Synced from claude-engineering-skills',
  '  and OVERWRITTEN on the next sync. A bug here is an UPSTREAM bug: fix it in',
  '  claude-engineering-skills + re-sync. Editing the synced copy = silent drift,',
  '  lost on the next sync. (see docs/runbooks/consumer-adoption.md)',
  // Naming the POLICY without naming the COMMAND is what left reports arriving
  // as ad-hoc prose — wrong paths, no bundle version, no way to tell whether the
  // bug was already fixed upstream. The command auto-captures all three.
  '  Report it: node scripts/.claude-skills/cross-skill.mjs upstream report --help',
];

/**
 * @param {string} destRel POSIX destination path relative to the consumer root
 * @returns {string|null} the comment token to use, or null when no banner applies
 */
export function bannerTokenFor(destRel) {
  if (typeof destRel !== 'string' || !destRel.startsWith(RELOCATED_TOOLING_PREFIX)) return null;
  const dot = destRel.lastIndexOf('.');
  if (dot < 0) return null;
  return COMMENT_TOKEN_BY_EXT[destRel.slice(dot)] ?? null;
}

/** First line of actual content, skipping a leading shebang line. */
function firstContentLine(content) {
  let c = content;
  if (c.startsWith('#!')) {
    const nl = c.indexOf('\n');
    if (nl === -1) return ''; // shebang-only file (no content line)
    c = c.slice(nl + 1);
  }
  const nl = c.indexOf('\n');
  const line = nl === -1 ? c : c.slice(0, nl);
  // Strip a trailing CR so the idempotency check matches on CRLF files too
  // (Windows consumers) — else an already-bannered CRLF file re-injects.
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Prepend the upstream-owned banner to relocated, comment-capable tooling.
 * No-op for any other destination (tracked skills/prompts, JSON, etc.).
 *
 * @param {string} content outbound file content (post command-rewrite)
 * @param {string} destRel POSIX destination path relative to the consumer root
 * @returns {string} content with the banner injected once, or unchanged
 */
export function injectUpstreamBanner(content, destRel) {
  if (typeof content !== 'string') return content;
  const token = bannerTokenFor(destRel);
  if (!token) return content;

  // A UTF-8 BOM must stay byte 0: inject into what follows it, then restore it.
  if (content.startsWith('﻿')) return '﻿' + injectUpstreamBanner(content.slice(1), destRel);

  const firstBannerLine = `${token} ${BANNER_BODY[0]}`;
  // Idempotent guard: skip ONLY if the banner already sits at the TOP (as
  // injected) — NOT merely present somewhere in the body. A relocated source
  // file can legitimately contain the marker text (e.g. this very module),
  // so a whole-file `includes()` check would wrongly skip bannering it.
  if (firstContentLine(content) === firstBannerLine) return content;

  const block = BANNER_BODY.map((l) => `${token} ${l}`).join('\n');
  // A Python encoding declaration (PEP 263) only counts on line 1 or 2, so it
  // keeps its position with the shebang above the banner.
  const keep = pinnedHeadLength(content, destRel);
  if (keep > 0) {
    const head = content.slice(0, keep);
    if (content.slice(keep).startsWith(firstBannerLine)) return content;
    return (head.endsWith('\n') ? head : `${head}\n`) + block + '\n' + content.slice(keep);
  }
  const lead = content.startsWith('\n') ? '' : '\n';
  return block + lead + content;
}

const PY_CODING_COOKIE = /^[ \t\f]*#.*?coding[:=][ \t]*[-\w.]+/;

/**
 * Length of the head that must stay above the banner: a shebang line, and for
 * Python a coding-cookie line among the first two.
 */
function pinnedHeadLength(content, destRel) {
  const lines = content.split('\n');
  let n = 0;
  if (lines[0].startsWith('#!')) n = 1;
  if (destRel.endsWith('.py')) {
    for (let i = 0; i < Math.min(2, lines.length); i++) {
      if (PY_CODING_COOKIE.test(lines[i].replace(/\r$/, ''))) n = Math.max(n, i + 1);
    }
  }
  if (n === 0) return 0;
  // Degenerate shebang-only-no-newline file: the whole content is the head.
  const idx = lines.slice(0, n).join('\n').length;
  return Math.min(content.length, idx + 1);
}
