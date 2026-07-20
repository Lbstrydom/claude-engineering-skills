/**
 * @fileoverview Churn-divergence detector for AGENTS.md — the "is this still
 * TRUE" companion to the structural guards.
 *
 * Every existing guard on AGENTS.md checks FORM: `context:check` enforces the
 * import topology, the heading allowlist and the line cap; `docs:refs:gate`
 * checks that a cited path RESOLVES. None checks whether a claim is still true,
 * which is how a line describing `learning-store.mjs` as "Cloud persistence via
 * Supabase" survived 105 days and three milestones past the migration that made
 * it false.
 *
 * **This is a REPORT, never a gate**, and that is a deliberate design decision
 * rather than an omission. `check-docs-refs.mjs` states the doctrine: a lint
 * that guesses aptness "would be noise — noisy gates get bypassed, which is how
 * the stale refs accumulated". Measured precision here is roughly 3-in-8, which
 * is useful for a periodic skim and intolerable for a push gate.
 *
 * The signal is factual, not a judgement: it never asks whether a claim is apt,
 * only whether the code a line NAMES has moved since the line did.
 *
 * **Line granularity is load-bearing.** A first version scored whole `##`
 * sections and missed the known-stale case entirely, because another session
 * had appended a subsection that day — so the section read as fresh while a
 * paragraph inside it was 105 days stale. Appending makes a section look
 * maintained. Lines cannot be gamed that way.
 *
 * @module scripts/lib/context-staleness
 */
import crypto from 'node:crypto';

/** Default drift, in days, above which a line is worth a human glance. */
export const DEFAULT_THRESHOLD_DAYS = 60;

const DAY_MS = 86400000;

/**
 * Repo paths a single line names. Two grammars, both observed in AGENTS.md:
 * a backticked or linked qualified path, and a bolded bare module name.
 *
 * Bare names need an existence check to resolve, so `resolve` is injected —
 * that keeps this function pure and the filesystem in the CLI adapter.
 *
 * @param {string} line
 * @param {(candidate: string) => boolean} resolve
 * @returns {string[]} distinct repo-relative paths
 */
export function citationsInLine(line, resolve) {
  const out = new Set();

  // `scripts/lib/foo.mjs` or [text](scripts/lib/foo.mjs)
  const QUALIFIED = /(?:`|\]\()((?:scripts|tests|skills)\/[A-Za-z0-9._/-]+\.(?:mjs|js|json|sql))(?:`|\))/g;
  for (const m of line.matchAll(QUALIFIED)) if (resolve(m[1])) out.add(m[1]);

  // **foo.mjs** — the bare-module form the "Script Responsibilities" bullets used.
  const BARE = /\*\*([a-z0-9][a-z0-9-]*\.mjs)\*\*/g;
  for (const m of line.matchAll(BARE)) {
    for (const cand of [`scripts/${m[1]}`, `scripts/lib/${m[1]}`]) {
      if (resolve(cand)) { out.add(cand); break; }
    }
  }
  return [...out];
}

/**
 * Stable identity for an acknowledgement.
 *
 * Keyed on the file, the line's TEXT and the cited path — never on a line
 * number, so an ack survives the file being reflowed, and **self-invalidates
 * when the line is edited**. That is the property that stops this becoming the
 * usual rotting allowlist: a changed line has, by definition, been looked at
 * again.
 *
 * The file is part of the key because widening beyond AGENTS.md made identical
 * boilerplate lines citing the same path genuinely common across docs/ — one
 * ack must not silence another file's line.
 */
export function ackKey(file, lineText, citedPath) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([file, lineText.trim(), citedPath]))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Whether a doc's claims are meant to TRACK the code, or are a record of what
 * was true when written.
 *
 * Measured on this repo: without this filter, **613 of 627** flagged lines came
 * from terminal plans. That is not a tuning problem — a completed plan is a
 * historical artefact, so flagging its citations is both noise and
 * semantically wrong. Excluding them leaves 14 across 95 files.
 *
 * `parseStatus` is injected so this stays pure; the CLI passes the canonical
 * `parsePlanStatus` from `lib/plan-status.mjs` rather than re-deriving the
 * vocabulary (an earlier probe hand-rolled the regex and mis-classified almost
 * every terminal plan).
 *
 * @param {string} file repo-relative path
 * @param {string} content
 * @param {(c: string) => {ok: boolean, kind?: string}} parseStatus
 * @returns {{tracked: boolean, reason: string}}
 */
/**
 * Does this doc declare itself generated?
 *
 * Scoped to the HEADER (first ~10 lines) on purpose: prose deeper in a
 * hand-written file routinely discusses generated artefacts — AGENTS.md's own
 * generated-artifact policy says "Generated: … do not edit" about OTHER files —
 * and a whole-file scan would silence the very document that explains the rule.
 */
export function isGeneratedDoc(content) {
  const header = String(content).split('\n').slice(0, 10).join('\n');
  return /generated[^\n]{0,80}(do not (hand-)?edit|regenerate)/i.test(header)
    || /^-\s*Generated:\s/im.test(header);
}

export function shouldTrack(file, content, parseStatus) {
  const p = String(file).replace(/\\/g, '/');

  // Generated artefacts: the fix for a stale one is REGENERATION, not editing
  // its prose, so flagging its lines would point at the wrong action.
  //
  // Detected by the header marker rather than a filename list, so a newly
  // generated doc is covered without anyone remembering to add it. All three
  // of this repo's generated docs already declare themselves this way
  // (`plans/README.md`, `architecture-map.md`, `requirements-map.md`).
  if (isGeneratedDoc(content)) return { tracked: false, reason: 'generated artefact' };

  if (p.startsWith('docs/plans/')) {
    // Mirrors check-plan-status.mjs's own exemption for these.
    if (/-audit-summary(?:-[\w-]+)?\.md$/.test(p)) {
      return { tracked: false, reason: 'audit summary — a record of a converged audit' };
    }
    const status = parseStatus(content);
    if (status.ok && status.kind === 'terminal') {
      return { tracked: false, reason: `terminal plan (${status.token}) — a historical record` };
    }
  }
  return { tracked: true, reason: 'live' };
}

/**
 * Pure core. No git, no filesystem — dates come from the caller.
 *
 * @param {object} args
 * @param {string[]} args.lines            file lines, in order
 * @param {(Date|null)[]} args.lineDates   per-line last-change date, parallel to `lines`
 * @param {Map<string, Date>} args.pathDates last-change date per repo path
 * @param {(c: string) => boolean} args.resolve
 * @param {Set<string>} [args.acked]       ack keys to suppress
 * @param {number} [args.thresholdDays]
 * @returns {{rows: object[], flagged: object[], suppressed: object[], coverage: object}}
 */
export function computeStaleness({
  file = 'AGENTS.md', lines, lineDates, pathDates, resolve,
  acked = new Set(), thresholdDays = DEFAULT_THRESHOLD_DAYS,
}) {
  const rows = [];
  let citingLines = 0;

  lines.forEach((text, i) => {
    const lineDate = lineDates[i];
    const cites = citationsInLine(text, resolve);
    if (cites.length === 0) return;
    citingLines++;
    if (!lineDate) return;

    // The worst offender on the line: the cited path that moved most recently
    // AFTER the line was last touched.
    let worst = null;
    for (const p of cites) {
      const pd = pathDates.get(p);
      if (pd && pd > lineDate && (!worst || pd > worst.date)) worst = { path: p, date: pd };
    }
    if (!worst) return;

    const key = ackKey(file, text, worst.path);
    rows.push({
      file,
      lineNumber: i + 1,
      text: text.trim(),
      path: worst.path,
      driftDays: Math.round((worst.date - lineDate) / DAY_MS),
      ackKey: key,
      acked: acked.has(key),
    });
  });

  rows.sort((a, b) => b.driftDays - a.driftDays);
  const over = rows.filter((r) => r.driftDays >= thresholdDays);

  return {
    rows,
    flagged: over.filter((r) => !r.acked),
    suppressed: over.filter((r) => r.acked),
    // Coverage is reported so a run that checked NOTHING cannot read as clean —
    // zero citing lines means the grammar or the blame adapter broke, not that
    // the file is healthy.
    coverage: {
      totalLines: lines.length,
      citingLines,
      datedLines: lineDates.filter(Boolean).length,
      withDrift: rows.length,
    },
  };
}

/**
 * A run that examined nothing must not report "clean" (gate-honesty doctrine:
 * audit your success paths). Returns a reason string, or null when the run is
 * genuinely conclusive.
 */
export function unverifiableReason(coverage) {
  if (coverage.totalLines === 0) return 'file is empty or unreadable';
  if (coverage.datedLines === 0) return 'no line dates — the blame adapter returned nothing';
  if (coverage.citingLines === 0) return 'no line cites a repo path — the citation grammar matched nothing';
  return null;
}
