/**
 * @fileoverview The per-file test timing REPORT: the event contract, the accumulator, and the
 * reader the runner uses to print a summary and to check a preflight's selection. Pure: importing
 * it has no side effects (the node reporter that feeds it, test-timing-reporter.mjs, is a separate
 * module for exactly that reason, see "WHY TWO MODULES"). Plan: docs/plans/gate-cost-slice-1.md.
 *
 * WHY IT EXISTS. One full pre-push gate took 1,647 s and 2,416 s on the same branch,
 * and nothing in its output said which file was responsible. A cost nobody can see
 * is a cost nobody fixes.
 *
 * WHY TWO MODULES. Node loads a reporter module in the `node --test` runner process, and a third
 * reporter is what crosses node's default listener ceiling, so the reporter module (and only it)
 * imports test-runner-listener-ceiling.mjs, which raises that ceiling process-wide. The runner
 * wrapper and the tests need the reader and the accumulator but must not inherit a global
 * side effect by importing a utility (code audit round 2, M1), so they import this module.
 *
 * WHY IT IS A SIBLING OF THE GUARD REPORTER AND NOT A FIELD IN ITS REPORT. The guard
 * report (`test-guard-reporter.mjs`) is read by `adjudicateRun`, which FAILS CLOSED on
 * anything it does not recognise: that is the repo's false-green defence. Putting an
 * informational number on that channel would couple "how long" to "did it pass", and
 * make the defence one typo away from rejecting every run. This reporter shares nothing
 * with it: its own version string, its own output, its own reader.
 *
 * TELEMETRY MUST NOT BE ABLE TO CHANGE THE VERDICT. The accumulator never throws on a malformed
 * event; the reporter (test-timing-reporter.mjs) writes its own file best-effort and yields
 * NOTHING, so no node-managed destination can abort the run.
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
 * first test are not in it, and the printed header says so. It is elapsed time inside the
 * test body, so time spent WAITING (on a spawned subprocess, say) is in it: a sum of these
 * is worker-seconds, not CPU.
 *
 * KNOWN LIMIT, file identity. `data.file` is where node says the test was DECLARED. A suite
 * declared in a helper that a test file imports is attributed to the helper. Measured on the
 * real tree (2026-10-12): all 949 default files reported, none missing, no strays, so nothing
 * does this today. The one consumer that ACTS on file identity is the preflight selection
 * check (run-tests.mjs), which compares the reported set with the expected one and fails the
 * run on any difference, so a helper-declared suite would be a loud failure there, not a
 * silently wrong number.
 *
 * COMPLETENESS. If the event stream fails part-way the reporter still writes what it gathered,
 * but marks it `complete: false`. A partial report must not read as a whole one: the summary
 * says so, and the preflight selection check treats it as no evidence.
 *
 * @module scripts/lib/test-timing-report
 */
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
    /**
     * @param {boolean} [complete] false when the event stream failed before its end
     * @returns {{version: string, complete: boolean, files: Array<{file: string, ms: number, tests: number}>, totalMs: number, ignored: number}}
     */
    report(complete = true) {
      const files = [...byFile].map(([file, v]) => ({ file, ms: Math.round(v.ms * 100) / 100, tests: v.tests }));
      files.sort((a, b) => b.ms - a.ms || a.file.localeCompare(b.file));
      const totalMs = Math.round(files.reduce((n, f) => n + f.ms, 0) * 100) / 100;
      return { version: TIMING_REPORT_VERSION, complete: complete === true, files, totalMs, ignored };
    },
  };
}

/** Convenience over a list of events (tests, and any caller that already has them). */
export function accumulateFileTimes(events, opts) {
  const acc = createTimingAccumulator(opts);
  for (const e of events) acc.add(e);
  return acc.report();
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
  if (typeof r.complete !== 'boolean') return { ok: false, reason: 'report has no complete flag' };
  if (!Array.isArray(r.files)) return { ok: false, reason: 'report has no files array' };
  if (!finite(r.totalMs)) return { ok: false, reason: 'report totalMs is not a finite non-negative number' };
  for (const f of r.files) {
    if (typeof f?.file !== 'string' || f.file === '' || !finite(f.ms) || !finite(f.tests)) {
      return { ok: false, reason: 'report has a malformed file entry' };
    }
  }
  return { ok: true, report: r };
}

/**
 * The set of files a run reports having executed, or null when the report is unusable OR
 * partial: a list that may be missing files is not evidence of which files ran.
 */
export function ranFiles(reportText) {
  const p = parseTimingReport(reportText);
  return p.ok && p.report.complete ? new Set(p.report.files.map((f) => f.file)) : null;
}

/** Why `ranFiles` returned null, in a sentence (for the line the runner prints). */
export function ranFilesUnavailableReason(reportText) {
  const p = parseTimingReport(reportText);
  if (!p.ok) return p.reason;
  return p.report.complete ? null : 'the timing report is partial (its event stream failed before the end)';
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
  const { files, totalMs, complete } = p.report;
  const partial = complete ? [] : ['Test timing is PARTIAL: the event stream failed before the end, so the figures understate the run.'];
  if (files.length === 0 || totalMs === 0) return { ok: true, lines: [...partial, 'No test timing recorded.'] };
  const shown = files.slice(0, top);
  const lines = [
    ...partial,
    `Slowest test files (${shown.length} of ${files.length}; test-body time as node reports it, not process wall time; total ${secs(totalMs)}):`,
    ...shown.map((f) => `  ${secs(f.ms).padStart(9)}  ${String(Math.round((100 * f.ms) / totalMs)).padStart(3)}%  ${f.file}`),
  ];
  return { ok: true, lines };
}
