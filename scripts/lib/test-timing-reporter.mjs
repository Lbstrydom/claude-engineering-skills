/**
 * @fileoverview A node:test reporter that records how long each TEST FILE took, so
 * the pre-push gate can say where its time goes. Plan: docs/plans/gate-cost-slice-1.md.
 *
 * WHY IT EXISTS. One full pre-push gate took 1,647 s and 2,416 s on the same branch,
 * and nothing in its output said which file was responsible. A cost nobody can see
 * is a cost nobody fixes.
 *
 * WHY IT IS A SIBLING OF THE GUARD REPORTER AND NOT A FIELD IN ITS REPORT. The guard
 * report (`test-guard-reporter.mjs`) is read by `adjudicateRun`, which FAILS CLOSED on
 * anything it does not recognise: that is the repo's false-green defence. Putting an
 * informational number on that channel would couple "how long" to "did it pass", and
 * make the defence one typo away from rejecting every run. This reporter shares nothing
 * with it: its own version string, its own output, its own reader.
 *
 * TELEMETRY MUST NOT BE ABLE TO CHANGE THE VERDICT. So nothing here is allowed to throw
 * out of the reporter, and the report is not written through a node-managed destination
 * (whose open or write failure can abort the run). The reporter writes its own file,
 * best-effort, inside a try/catch, and yields NOTHING. Node still needs a destination
 * for the pair; the runner gives it `stdout`, and since nothing is yielded stdout is
 * untouched.
 *
 * WHAT IS MEASURED (the event contract, plan D2):
 *   · events `test:pass` and `test:fail` with `data.nesting === 0` and a string `data.file`;
 *   · duration = `data.details.duration_ms`, accepted only if finite and >= 0 (anything
 *     else counts the event with 0 ms and is tallied in `ignored`);
 *   · each event counts exactly once; a suite's duration already covers its subtests, so
 *     only nesting 0 is summed;
 *   · a file-level failure (an import error is a nesting-0 `test:fail` for the file) is a
 *     normal event and carries whatever duration node attributes to it.
 * That is TEST-BODY time as node reports it: process start and module import before the
 * first test are not in it, and the printed header says so.
 *
 * @module scripts/lib/test-timing-reporter
 */
import fs from 'node:fs';
import path from 'node:path';

/** Bumped if the report shape changes; the reader refuses an unknown version. */
export const TIMING_REPORT_VERSION = 'test-timing/v1';

/** The runner tells the reporter where to write by environment, not by node destination. */
export const TIMING_REPORT_ENV = 'TEST_TIMING_REPORT';

/** Repo-relative, forward-slash file identity; an out-of-root path stays absolute. */
export function fileIdentity(file, root = process.cwd()) {
  const rel = path.relative(root, file);
  const id = rel.startsWith('..') || path.isAbsolute(rel) ? file : rel;
  return id.replace(/\\/g, '/');
}

/**
 * An accumulator over node test events. Pure: no I/O, never throws on a malformed event
 * (it counts it as ignored instead), so the reporter built on it cannot take a run down.
 *
 * @param {{root?: string}} [opts]
 */
export function createTimingAccumulator({ root = process.cwd() } = {}) {
  /** @type {Map<string, {ms: number, tests: number}>} */
  const byFile = new Map();
  let ignored = 0;

  return {
    add(event) {
      try {
        if (!event || (event.type !== 'test:pass' && event.type !== 'test:fail')) return;
        const data = event.data;
        if (!data || data.nesting !== 0 || typeof data.file !== 'string' || data.file === '') return;
        const raw = data.details?.duration_ms;
        const ok = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0;
        if (!ok) ignored++;
        const id = fileIdentity(data.file, root);
        const entry = byFile.get(id) ?? { ms: 0, tests: 0 };
        entry.ms += ok ? raw : 0;
        entry.tests += 1;
        byFile.set(id, entry);
      } catch {
        ignored++; // a malformed event is data about the input, never a failure of the run
      }
    },
    /** @returns {{version: string, files: Array<{file: string, ms: number, tests: number}>, totalMs: number, ignored: number}} */
    report() {
      const files = [...byFile].map(([file, v]) => ({ file, ms: Math.round(v.ms * 100) / 100, tests: v.tests }));
      files.sort((a, b) => b.ms - a.ms || a.file.localeCompare(b.file));
      const totalMs = Math.round(files.reduce((n, f) => n + f.ms, 0) * 100) / 100;
      return { version: TIMING_REPORT_VERSION, files, totalMs, ignored };
    },
  };
}

/** Convenience over a list of events (tests, and any caller that already has them). */
export function accumulateFileTimes(events, opts) {
  const acc = createTimingAccumulator(opts);
  for (const e of events) acc.add(e);
  return acc.report();
}

/**
 * The reporter. Best-effort end to end; yields nothing (see the file header).
 * @param {AsyncIterable<object>} source
 */
export default async function* testTimingReporter(source) {
  const acc = createTimingAccumulator();
  try {
    for await (const event of source) acc.add(event);
  } catch {
    // the stream failing is the runner's business; whatever was gathered is still reported
  }
  try {
    const target = process.env[TIMING_REPORT_ENV];
    if (target) fs.writeFileSync(target, `${JSON.stringify(acc.report())}\n`);
  } catch {
    // an unwritable path means "timing unavailable", never a failed run
  }
}

// ── The reader ──────────────────────────────────────────────────────────────

const unavailable = (reason) => ({ ok: false, reason, report: null, lines: [`Test timing unavailable (${reason}).`] });

/**
 * Parse and validate a timing report. Structural validation is strict because the
 * summary is printed under a header claiming to describe the whole run.
 *
 * @param {string|null} reportText
 * @returns {{ok: true, report: ReturnType<ReturnType<typeof createTimingAccumulator>['report']>} | {ok: false, reason: string}}
 */
export function parseTimingReport(reportText) {
  if (reportText === null || reportText === undefined) return { ok: false, reason: 'no report was written' };
  let r;
  try { r = JSON.parse(reportText); } catch { return { ok: false, reason: 'report unparseable' }; }
  if (r?.version !== TIMING_REPORT_VERSION) {
    return { ok: false, reason: `report version ${JSON.stringify(r?.version)} is not ${TIMING_REPORT_VERSION}` };
  }
  const finite = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!Array.isArray(r.files)) return { ok: false, reason: 'report has no files array' };
  if (!finite(r.totalMs)) return { ok: false, reason: 'report totalMs is not a finite non-negative number' };
  for (const f of r.files) {
    if (typeof f?.file !== 'string' || f.file === '' || !finite(f.ms) || !finite(f.tests)) {
      return { ok: false, reason: 'report has a malformed file entry' };
    }
  }
  return { ok: true, report: r };
}

/** The set of files a run reports having executed, or null when the report is unusable. */
export function ranFiles(reportText) {
  const p = parseTimingReport(reportText);
  return p.ok ? new Set(p.report.files.map((f) => f.file)) : null;
}

const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

/**
 * The human summary. Never throws, never returns an empty table of zeros: no files or a
 * zero total reads "no timing recorded".
 *
 * @param {string|null} reportText
 * @param {{top?: number}} [opts]
 * @returns {{ok: boolean, reason?: string, lines: string[]}}
 */
export function summariseTiming(reportText, { top = 8 } = {}) {
  const p = parseTimingReport(reportText);
  if (!p.ok) return unavailable(p.reason);
  const { files, totalMs } = p.report;
  if (files.length === 0 || totalMs === 0) return { ok: true, lines: ['No test timing recorded.'] };
  const shown = files.slice(0, top);
  const lines = [
    `Slowest test files (${shown.length} of ${files.length}; test-body time as node reports it, not process wall time; total ${secs(totalMs)}):`,
    ...shown.map((f) => `  ${secs(f.ms).padStart(9)}  ${String(Math.round((100 * f.ms) / totalMs)).padStart(3)}%  ${f.file}`),
  ];
  return { ok: true, lines };
}
