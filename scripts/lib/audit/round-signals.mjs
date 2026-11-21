/**
 * @fileoverview Deterministic round-policy signals for the step-back trigger
 * (docs/plans/verification-lessons.md §2.4): reopen rate, severity drift and
 * unique defects retired. Pure — the only IO is the injected `git` runner that
 * `postImageHunks` uses (`git diff -U0 --find-renames`).
 *
 * **Honesty rules.** Every signal returns `{measured, value, fires, reason}`.
 * An unmeasured signal (missing `audited_sha`, unreachable commit, a rewritten
 * range, no cited lines, no ledger) NEVER fires and NEVER reads as quiet: it
 * says `measured: false` with the reason, and `summariseSignals` names it so
 * the operator is told the trigger is unmeasured.
 *
 * **Fix range.** For round N the fix range is `auditedSha(N-1)..auditedSha(N)` —
 * the commits made between round N-1's audit and round N's start, each taken
 * from the round result's recorded audited sha. Lines are mapped on the
 * POST-image side of that range's hunks, so a renamed file maps to its new path.
 *
 * **Importance.** Findings carry no `importance` tag in historical ledgers; when
 * no finding in the input has one, the signals use every finding of severity
 * >= MEDIUM and say so (`importanceSource: 'severity-proxy'`).
 *
 * Domain: audit-orchestration.
 *
 * @module scripts/lib/audit/round-signals
 */
import { spawnSync } from 'node:child_process';
import { generateTopicId, populateFindingMetadata } from '../ledger.mjs';

export const ROUND_SIGNALS_VERSION = 1;

/** Declared thresholds — constants, not tuned in prose. */
export const SIGNAL_THRESHOLDS = Object.freeze({
  reopenRate: 0.5,           // fires at >= this
  severityDriftMedian: -1,   // fires when the median delta is <= this ...
  severityDriftMinFiles: 2,  // ... and at least this many files qualify
  retiredMax: 1,             // fires when retired <= this ...
  retiredConsecutiveRounds: 2, // ... for this many consecutive rounds
});

export const SEVERITY_RANK = Object.freeze({ HIGH: 3, MEDIUM: 2, LOW: 1 });

const ACCEPTED_OUTCOMES = new Set(['accepted', 'severity_adjusted']);

const unmeasured = (reason) => ({ measured: false, value: null, fires: false, reason });

/** Default git runner: `(args) => {status, stdout, stderr}`. Big buffer — a fix range's diff can exceed spawnSync's 1 MiB default. */
export function makeGitRunner(cwd = process.cwd()) {
  return (args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
    return { status: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
}

/** A finding's topic id, derived on a COPY exactly as write-ledger-entries derives it. */
export function defaultTopicOf(finding) {
  const f = { ...finding };
  populateFindingMetadata(f, f._pass);
  return generateTopicId(f);
}

/** Decode git's C-style quoted path: octal escapes are UTF-8 bytes, plus backslash, quote, t, n, r. Unquoted paths pass through. */
export function unquoteGitPath(p) {
  if (!(p.length >= 2 && p.startsWith('"') && p.endsWith('"'))) return p;
  const bytes = [];
  const body = p.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') { bytes.push(...Buffer.from(c, 'utf8')); continue; }
    const n = body[++i];
    if (/[0-7]/.test(n)) { let oct = n; while (oct.length < 3 && /[0-7]/.test(body[i + 1] || '')) oct += body[++i]; bytes.push(parseInt(oct, 8)); }
    else bytes.push({ t: 9, n: 10, r: 13 }[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Parse a `git diff -U0` text into post-image line ranges per file. Pure.
 * A `+++ b/<path>` header names the NEW path, so a rename maps to its new path;
 * `+++ /dev/null` (a deletion) has no post-image and is skipped. A hunk with a
 * zero-length post-image (pure deletion) contributes no lines.
 * @param {string} diffText
 * @returns {Map<string, Array<[number, number]>>}
 */
export function parsePostImageHunks(diffText) {
  const out = new Map();
  let file = null;
  for (const line of String(diffText || '').split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = unquoteGitPath(line.slice(4).trim());
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      if (file && !out.has(file)) out.set(file, []);
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && file) {
      const start = Number(m[1]);
      const len = m[2] === undefined ? 1 : Number(m[2]);
      if (len > 0) out.get(file).push([start, start + len - 1]);
    }
  }
  return out;
}

/**
 * The post-image hunks of a fix range, or the reason it cannot be measured.
 * Missing sha, unreachable commit and a rewritten range (base not an ancestor of
 * head) are each `measured: false` — never an empty hunk set.
 * @param {{base: string|null|undefined, head: string|null|undefined}} fixRange
 * @param {(args: string[]) => {status: number, stdout: string}} git
 * @returns {{measured: true, hunks: Map<string, Array<[number, number]>>}|{measured: false, reason: string}}
 */
export function postImageHunks(fixRange, git) {
  const { base, head } = fixRange || {};
  if (!base || !head) return { measured: false, reason: `missing audited_sha (base=${base || 'none'}, head=${head || 'none'})` };
  if (!/^[0-9a-f]{7,64}$/i.test(base) || !/^[0-9a-f]{7,64}$/i.test(head)) return { measured: false, reason: 'audited_sha is not a commit id' };
  for (const sha of [base, head]) {
    const r = git(['cat-file', '-e', `${sha}^{commit}`]);
    if (r.status !== 0) return { measured: false, reason: `commit ${sha.slice(0, 8)} is unreachable` };
  }
  if (base !== head) {
    const anc = git(['merge-base', '--is-ancestor', base, head]);
    if (anc.status === 1) return { measured: false, reason: `range rewritten (${base.slice(0, 8)} is not an ancestor of ${head.slice(0, 8)})` };
    if (anc.status !== 0) return { measured: false, reason: `ancestry of ${base.slice(0, 8)}..${head.slice(0, 8)} could not be determined` };
  }
  const d = git(['diff', '-U0', '--find-renames', '--no-color', '--no-ext-diff', `${base}..${head}`]);
  if (d.status !== 0) return { measured: false, reason: `git diff ${base.slice(0, 8)}..${head.slice(0, 8)} failed` };
  return { measured: true, hunks: parsePostImageHunks(d.stdout) };
}

/** The file a finding is about (first of `_primaryFile` / `affectedFiles`), or null. */
export function primaryFileOf(f) {
  const x = f?._primaryFile || (Array.isArray(f?.affectedFiles) ? f.affectedFiles[0] : null);
  return typeof x === 'string' && x ? x.replace(/\\/g, '/') : null;
}

/**
 * Cited line ranges of a finding: `f.line`, `f.lineStart/lineEnd`, `f.lines`, or a
 * `<file>:<n>[-<m>]` mention in its section/detail for one of its own files.
 * @returns {{file: string|null, ranges: Array<[number, number]>}}
 */
export function citedLocation(f) {
  const file = primaryFileOf(f);
  const ranges = [];
  const num = (x) => (Number.isInteger(x) && x > 0 ? x : null);
  if (num(f?.line)) ranges.push([f.line, num(f.lineEnd) ?? f.line]);
  if (num(f?.lineStart)) ranges.push([f.lineStart, num(f.lineEnd) ?? f.lineStart]);
  if (Array.isArray(f?.lines)) for (const l of f.lines) if (num(l)) ranges.push([l, l]);
  if (file && ranges.length === 0) {
    const esc = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`${esc}:(\\d+)(?:-(\\d+))?`, 'g');
    for (const m of `${f?.section || ''} ${f?.detail || ''}`.matchAll(re)) {
      const a = Number(m[1]); const b = m[2] ? Number(m[2]) : a;
      ranges.push([Math.min(a, b), Math.max(a, b)]);
    }
  }
  return { file, ranges };
}

/**
 * The findings the signals count, and where "important" came from. Selection is PER FINDING: a tagged finding
 * counts when `importance` is `important`; an untagged one falls back to the severity proxy (>= MEDIUM).
 * @param {object[][]} findingLists - every round's findings, to state the source once for the whole input
 * @returns {{importanceSource: 'importance'|'severity-proxy'|'mixed', select: (findings: object[]) => object[]}}
 */
export function importanceSelector(findingLists) {
  const all = findingLists.flatMap((l) => (Array.isArray(l) ? l : []));
  const tagged = all.filter((f) => typeof f?.importance === 'string').length;
  const importanceSource = tagged === 0 ? 'severity-proxy' : tagged === all.length ? 'importance' : 'mixed';
  const counts = (f) => (typeof f?.importance === 'string' ? f.importance === 'important' : (SEVERITY_RANK[String(f?.severity).toUpperCase()] || 0) >= SEVERITY_RANK.MEDIUM);
  return { importanceSource, select: (l) => (l || []).filter(counts) };
}

const byRound = (rounds, n) => (rounds || []).find((r) => r.round === n) || null;
/** A round with no findings LIST is unmeasured (an absent list is not an empty one). */
const lacksFindings = (...rs) => rs.some((r) => !Array.isArray(r?.findings));

/** reopenRate(N) = located findings of N whose cited lines fall in the post-image hunks of the fix range / located findings of N. */
export function reopenRate({ round, rounds, select, git }) {
  const cur = byRound(rounds, round); const prev = byRound(rounds, round - 1);
  if (!cur || !prev) return unmeasured(`needs round results for ${round - 1} and ${round}`);
  if (lacksFindings(cur)) return unmeasured(`round ${round} has no findings list`);
  const h = postImageHunks({ base: prev.auditedSha, head: cur.auditedSha }, git);
  if (!h.measured) return unmeasured(h.reason);
  const sel = select(cur.findings);
  if (sel.length === 0) return { measured: true, value: 0, fires: false, reason: `no findings in round ${round}`, hits: 0, located: 0 };
  const located = sel.map(citedLocation).filter((l) => l.file && l.ranges.length > 0);
  if (located.length === 0) return unmeasured(`round ${round}'s ${sel.length} findings cite no lines`);
  const hits = located.filter((l) => {
    const hunks = h.hunks.get(l.file) || [];
    return l.ranges.some(([a, b]) => hunks.some(([s, e]) => a <= e && b >= s));
  }).length;
  const value = hits / located.length;
  return { measured: true, value, fires: value >= SIGNAL_THRESHOLDS.reopenRate, reason: `${hits} of ${located.length} located findings in fix-range hunks`, hits, located: located.length, unlocated: sel.length - located.length };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function maxSevByFile(findings) {
  const m = new Map();
  for (const f of findings) {
    const file = primaryFileOf(f); if (!file) continue;
    const r = SEVERITY_RANK[String(f.severity).toUpperCase()] || 0;
    m.set(file, Math.max(m.get(file) || 0, r));
  }
  return m;
}

/** severityDrift(N): median over files present in both N-1 and N of maxSev(N) - maxSev(N-1); fires at <= -1 over >= 2 files. */
export function severityDrift({ round, rounds, select }) {
  const cur = byRound(rounds, round); const prev = byRound(rounds, round - 1);
  if (!cur || !prev) return unmeasured(`needs round results for ${round - 1} and ${round}`);
  if (lacksFindings(cur, prev)) return unmeasured('a round has no findings list');
  const a = maxSevByFile(select(prev.findings)); const b = maxSevByFile(select(cur.findings));
  const deltas = [...b].filter(([f]) => a.has(f)).map(([f, r]) => r - a.get(f));
  if (deltas.length < SIGNAL_THRESHOLDS.severityDriftMinFiles) return unmeasured(`only ${deltas.length} file(s) have findings in both rounds (need ${SIGNAL_THRESHOLDS.severityDriftMinFiles})`);
  const value = median(deltas);
  return { measured: true, value, fires: value <= SIGNAL_THRESHOLDS.severityDriftMedian, reason: `median severity delta ${value} over ${deltas.length} files`, files: deltas.length };
}

/** retired(N): topicIds accepted in N-1 with no finding of that topicId in N. */
function retiredAt({ round, rounds, select, ledgerEntries, topicOf }) {
  const cur = byRound(rounds, round); const prev = byRound(rounds, round - 1);
  if (!cur || !prev) return { unmeasured: `needs round results for ${round - 1} and ${round}` };
  if (lacksFindings(cur, prev)) return { unmeasured: 'a round has no findings list' };
  if (!ledgerEntries) return { unmeasured: 'no ledger' };
  const prevTopics = new Set(select(prev.findings).map(topicOf));
  const curTopics = new Set((cur.findings || []).map(topicOf)); // any finding of that topic in N (not only selected) keeps it open
  const ruled = ledgerEntries.filter((e) => prevTopics.has(e?.topicId));
  if (ruled.length === 0 && prevTopics.size > 0) return { unmeasured: `round ${round - 1} has no rulings in the ledger (not triaged)` };
  const accepted = ruled.filter((e) => ACCEPTED_OUTCOMES.has(e.adjudicationOutcome));
  const closed = accepted.filter((e) => !curTopics.has(e.topicId));
  return { retired: closed.length, closed };
}

/**
 * retired(N) with the two-consecutive-rounds fire rule, and `retiredUnverified`
 * (closed topics whose file is absent from the fix range — closure uncertain).
 */
export function retired({ round, rounds, select, ledgerEntries, topicOf = defaultTopicOf, git }) {
  const now = retiredAt({ round, rounds, select, ledgerEntries, topicOf });
  if (now.unmeasured) return unmeasured(now.unmeasured);
  const before = retiredAt({ round: round - 1, rounds, select, ledgerEntries, topicOf });
  if (before.unmeasured) return unmeasured(`retired(${round - 1}): ${before.unmeasured}`);
  const h = postImageHunks({ base: byRound(rounds, round - 1)?.auditedSha, head: byRound(rounds, round)?.auditedSha }, git);
  const retiredUnverified = h.measured
    ? now.closed.filter((e) => !(e.affectedFiles || []).some((f) => h.hunks.has(String(f).replace(/\\/g, '/')))).length
    : null;
  const fires = now.retired <= SIGNAL_THRESHOLDS.retiredMax && before.retired <= SIGNAL_THRESHOLDS.retiredMax;
  return {
    measured: true, value: now.retired, fires, retiredUnverified,
    reason: `retired(${round}) = ${now.retired}, retired(${round - 1}) = ${before.retired}${h.measured ? '' : `; closure unverified (${h.reason})`}`,
    previous: before.retired,
  };
}

/**
 * All three signals for a checkpoint round. `rounds`: `[{round, findings, auditedSha}]`
 * (up to and including `round` — nothing later is read). `ledgerEntries`: the
 * checkpoint's ledger snapshot entries.
 * @returns {{version: number, round: number, importanceSource: string, signals: Record<string, object>,
 *   anyFires: boolean, unmeasured: string[]}}
 */
export function computeRoundSignals({ round, rounds, ledgerEntries = null, git = makeGitRunner(), topicOf = defaultTopicOf }) {
  const upTo = (rounds || []).filter((r) => r.round <= round);
  const { importanceSource, select } = importanceSelector(upTo.map((r) => r.findings));
  const signals = {
    reopenRate: reopenRate({ round, rounds: upTo, select, git }),
    severityDrift: severityDrift({ round, rounds: upTo, select }),
    retired: retired({ round, rounds: upTo, select, ledgerEntries, topicOf, git }),
  };
  const names = Object.keys(signals);
  return {
    version: ROUND_SIGNALS_VERSION, round, importanceSource, signals,
    anyFires: names.some((n) => signals[n].fires),
    unmeasured: names.filter((n) => !signals[n].measured),
  };
}

/** The card lines for the signals; an unmeasured signal is printed as such and the trigger is called unmeasured. */
export function renderRoundSignals(s) {
  const lines = [`Round signals @ round ${s.round} (v${s.version}, importance: ${s.importanceSource})`];
  for (const [name, sig] of Object.entries(s.signals)) {
    lines.push(sig.measured
      ? `  ${name}: ${typeof sig.value === 'number' ? Number(sig.value.toFixed(3)) : sig.value}${sig.fires ? '  FIRES' : ''} — ${sig.reason}`
      : `  ${name}: UNMEASURED — ${sig.reason}`);
  }
  if (s.unmeasured.length) lines.push(`  ⚠ step-back trigger is UNMEASURED for: ${s.unmeasured.join(', ')} (an unmeasured signal never fires and is not quiet).`);
  return lines.join('\n');
}
