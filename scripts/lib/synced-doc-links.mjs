/**
 * @fileoverview One oracle for "can a reader in a CONSUMER repo follow this
 * markdown link?" — used by the shared-reference generator to emit links that
 * survive the sync, and by `check-synced-doc-links.mjs` to gate the rest.
 *
 * **The defect class.** A relative markdown href is resolved against the
 * directory the file sits in, and the sync moves files between directories at
 * two different depths. `skills/<skill>/references/x.md` is copied to
 * `.claude/skills/<skill>/references/x.md` — one level deeper — so a
 * `../../../docs/…` written to reach the repo root from the first lands in
 * `.claude/` from the second. It is dead in the generated copy AND in every
 * consumer, while resolving perfectly from the file the author was looking at.
 *
 * Two existing gates could not see it. `check-docs-refs.mjs` and
 * `check-skill-consumer-refs.mjs` both extract literal `docs/…md` TOKENS, so a
 * link whose text says `docs/plans/<name>.md` and whose href says `../completed/x.md`
 * reads as healthy to both — which is exactly how the reported instance
 * (upstream 15da01b6, wine-cellar-app, 2026-09-04) survived. The href is the
 * half nothing was reading.
 *
 * **The rule this module encodes.** A link in synced markdown is followable in a
 * consumer only if it resolves, at that file's CONSUMER path, to another path
 * the sync also ships. Everything else has to be an absolute upstream URL —
 * the one spelling that is correct in both repos at once. That is not a
 * stylistic preference: `docs/reference/consistency-contract.md` is the ONLY
 * `docs/` file in the 783-file closure, so a `../plans/…` from it can never
 * resolve anywhere but here.
 *
 * @module scripts/lib/synced-doc-links
 */
import path from 'node:path';

/** Blob root of the public upstream repo — the link form that works in both repos. */
export const UPSTREAM_BLOB_BASE = 'https://github.com/Lbstrydom/claude-engineering-skills/blob/main';

/**
 * The upstream URL for a repo-relative path.
 *
 * @param {string} repoRel forward-slash repo-relative path
 * @returns {string}
 */
export function upstreamUrlFor(repoRel) {
  return `${UPSTREAM_BLOB_BASE}/${String(repoRel).replaceAll('\\', '/').replace(/^\/+/, '')}`;
}

/** Inline markdown link: `](target)`, target stopping at whitespace or `)`. */
const LINK_RE = /\]\(\s*<?([^)>\s]+?)>?\s*(?:"[^"]*")?\)/g;
/** A relative href — the only kind whose meaning depends on where the file sits. */
const RELATIVE_RE = /^\.{1,2}\//;

/**
 * Every relative-href inline link in a markdown document, outside fenced code.
 *
 * **Fences are skipped, and that is the opposite of `check-skill-consumer-refs`
 * on purpose.** There, a command inside a ```bash fence is the MOST
 * instructional form a pointer takes, so skipping fences would blind the gate.
 * Here the subject is a link a reader CLICKS, and a markdown link inside a
 * fence is sample bytes — `/ai-context-management` ships three, showing the
 * reader what to write into their own root `AGENTS.md`, where `./AGENTS.md` is
 * the correct href. Rewriting those would corrupt the template.
 *
 * @param {string} text
 * @returns {{line: number, href: string}[]} 1-indexed line numbers
 */
export function scanRelativeLinks(text) {
  const out = [];
  let inFence = false;
  let fenceChar = '';
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const fence = trimmed.match(/^(`{3,}|~{3,})/);
    if (fence) {
      if (!inFence) { inFence = true; fenceChar = fence[1][0]; continue; }
      if (trimmed.startsWith(fenceChar.repeat(3))) { inFence = false; continue; }
    }
    if (inFence) continue;
    let m;
    LINK_RE.lastIndex = 0;
    while ((m = LINK_RE.exec(lines[i])) !== null) {
      if (RELATIVE_RE.test(m[1])) out.push({ line: i + 1, href: m[1] });
    }
  }
  return out;
}

/**
 * Where a relative href lands, given the CONSUMER path of the file carrying it.
 *
 * Any `#anchor` is dropped: it selects within the target, and the target is
 * what has to exist.
 *
 * @param {string} destRel consumer-relative path of the linking file
 * @param {string} href
 * @returns {string|null} consumer-relative target, or null for a pure anchor
 */
export function resolveAtDest(destRel, href) {
  const target = String(href).split('#')[0];
  if (!target) return null;
  return path.posix.normalize(path.posix.join(path.posix.dirname(destRel), target));
}

/**
 * Adjudicate one synced document's relative links.
 *
 * @param {object} args
 * @param {string} args.sourceRel repo-relative path in THIS repo
 * @param {string} args.destRel consumer-relative path the sync writes
 * @param {string} args.text file contents
 * @param {Set<string>} args.destPaths every consumer-relative path the sync ships
 * @returns {{sourceRel: string, line: number, href: string, resolved: string}[]}
 */
export function findUnfollowableLinks({ sourceRel, destRel, text, destPaths }) {
  const out = [];
  for (const { line, href } of scanRelativeLinks(text)) {
    const resolved = resolveAtDest(destRel, href);
    if (resolved === null || destPaths.has(resolved)) continue;
    out.push({ sourceRel, line, href, resolved });
  }
  return out;
}
