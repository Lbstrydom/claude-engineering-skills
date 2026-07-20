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
 * Keyed on the line's TEXT plus the cited path, never on a line number — so an
 * ack survives the file being reflowed, and **self-invalidates when the line is
 * edited**. That is the property that stops this becoming the usual rotting
 * allowlist: a changed line has, by definition, been looked at again.
 */
export function ackKey(lineText, citedPath) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([lineText.trim(), citedPath]))
    .digest('hex')
    .slice(0, 16);
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
  lines, lineDates, pathDates, resolve,
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

    const key = ackKey(text, worst.path);
    rows.push({
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
