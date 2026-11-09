/**
 * @fileoverview Known-answer canary for code-audit rounds (opt-in: `AUDIT_CANARY=1`).
 *
 * A round that reports nothing is only evidence of cleanliness if the auditor
 * could have reported something. The canary plants one small virtual file with
 * one unambiguous defect (an authorization check written as an assignment) into
 * the code message of every wave-2 correctness pass. If a planted pass does not
 * name that defect, the round is INCOMPLETE — blind, not clean — and rides the
 * existing INCOMPLETE path (exit 3, `countFindings.failed`, no convergence).
 *
 * Fail closed when enabled: only `detected` in EVERY planted pass is evidence;
 * `missed`, `not-planted` (no eligible pass ran) and `unsupported-pipeline`
 * (tiered pipeline, v1) all make the round INCOMPLETE. Unset ⇒ byte-identical
 * prompts and results (no `_canary` key).
 *
 * Not a wave: no `PASS_PROMPTS` entry and no model call of its own, so it does
 * not belong in `MECHANICAL_WAVES` and the model shadow cannot enrol it.
 *
 * Detection reads each planted pass's RETURNED result (after safeCallGPT's own
 * retries; for map-reduce, after REDUCE — a reduce that drops the canary is
 * pipeline blindness) BEFORE ledger suppression, and every canary-cited finding
 * is stripped so none reaches the ledger, store, debt capture or counts.
 * Stated limit: keyword evidence that the defect was named, not proof the model
 * understood it — a floor against a blind or truncated pass, not a recall estimate.
 *
 * Plan: docs/plans/test-campaign-controls.md §2.2.
 *
 * @module scripts/lib/audit/canary
 */
import crypto from 'node:crypto';
import { normalizePath } from '../file-io.mjs';

// A neutral location: a path that announces itself as a test plant invites the model to skip it (measured: see
// docs/plans/test-campaign-controls.md §10). The id keeps it unique; it never exists on disk.
export const CANARY_DIR = 'src/access';
/** The wave-2 correctness passes that receive the canary. Selected by NAME, never call order. */
export const CANARY_ELIGIBLE_PASSES = Object.freeze(['backend', 'be-routes', 'be-services', 'frontend']);
const ASSIGNMENT_RE = /\bassignment\b[^\n]{0,60}?\b(?:instead of|rather than|in place of|used as|as (?:a|the) (?:comparison|condition))|\bassign(?:s|ed|ing)?\b[^\n]{0,80}?\b(?:instead of|rather than)\b[^\n]{0,20}?\bcompar|single\s*['"`]?=['"`]?|['"`]=['"`]\s*(?:instead of|rather than|vs\.?|versus|not)|instead of\s*['"`]?={2,3}|role\s*=\s*['"`]admin/i;
const SUBJECT_RE = /admin|role|authori[sz]/i;
// The defect is an assignment USED AS a comparison/condition — "do not assign the admin role" names neither.
const COMPARISON_RE = /compar|equal|===|==|condition|\bif\b|\bcheck/i;

export function canaryEnabled(env = process.env) {
  return env.AUDIT_CANARY === '1';
}

/** The planted file for one round. `seed` varies it per round (path and names), never its defect. */
export function createCanary({ seed = String(Date.now()) } = {}) {
  const id = crypto.createHash('sha256').update(`audit-canary:${seed}`).digest('hex').slice(0, 10);
  const relPath = `${CANARY_DIR}/console-guard-${id}.mjs`;
  const source = [
    `// Request guard for the admin console (build ${id}).`,
    `export function canOpenAdminConsole(user) {`,
    `  if (!user) return false;`,
    `  if (user.role = 'admin') {`,
    `    return true;`,
    `  }`,
    `  return false;`,
    `}`,
  ].join('\n');
  const block = `\n\n### ${relPath}\n\`\`\`js\n${source}\n\`\`\`\n`;
  return { id, path: relPath, normalisedPath: normalizePath(relPath), block, chars: block.length };
}

function isPlantedUnit(unitLabel) {
  return !unitLabel || /^Audit Unit 1\//.test(unitLabel);
}

/**
 * Does this finding cite the canary file? A PRODUCER finding (raw pass output, ProducerFindingSchema) has no
 * `file` field — its location is `section` ("audit-canary/c<id>.mjs:4", or prose naming the path). `file` is
 * derived later in the pipeline, so both are checked. Found by the first live run: a `file`-only match read
 * every real canary report as a miss (docs/plans/test-campaign-controls.md §10).
 */
export function citesCanary(finding, canary) {
  // The ANCHOR is the FIRST path the section names — live sections read "<path>:4" or "<path>: fn", and a prefixed
  // "fn in <path>" is anchored too. A real-file finding that mentions the canary only after naming its own file is
  // about that file and is kept. The match is whole-path: `<canary>.backup` is not the canary.
  if (typeof finding?.file === 'string' && finding.file) return normalizePath(finding.file) === canary.normalisedPath;
  const section = typeof finding?.section === 'string' ? finding.section.replace(/\\/g, '/') : '';
  const first = section.match(PATH_TOKEN_RE);
  return Boolean(first) && first[0].replace(/^(?:\.\/)+/, '').toLowerCase() === canary.path.toLowerCase();
}

// A path token ending at a boundary: either `/`-joined segments ending in a file with an extension
// (`src/a/b.mjs`, `./src/a.mjs`), or a ROOT-level file with a code/doc extension (`app.js`) — the extension list keeps
// a dotted identifier like `user.role` from reading as a file.
const PATH_TOKEN_RE = /(?:(?:\.\/)*[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+|[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:m?[jt]sx?|cjs|cts|mts|py|rb|go|rs|java|kt|cs|php|vue|svelte|css|scss|html|md|json|ya?ml|sql|sh|ps1|toml))(?=$|[\s:,;)\]#'"`])/;

const TEXT_FIELDS = ['category', 'section', 'file', 'detail', 'description', 'recommendation', 'risk'];
const findingText = (f) => TEXT_FIELDS.map((k) => f?.[k]).filter((s) => typeof s === 'string').join(' \n ');

/**
 * Does this canary-file finding name the planted defect — an assignment used as the authorization comparison?
 * Needs one SPECIFIC signal, not loose keywords: "assignment" as a noun, an explicit `=`-for-`===` statement, or the
 * planted expression itself — plus comparison/condition wording and the guarded subject. "Do not assign the admin
 * role; check authorization" has none of the specific signals. Still keyword evidence (stated limit, see header).
 */
export function namesCanaryDefect(finding) {
  const text = findingText(finding);
  return ASSIGNMENT_RE.test(text) && COMPARISON_RE.test(text) && SUBJECT_RE.test(text);
}

/**
 * A per-round canary controller. Disabled ⇒ `plant` returns its input unchanged and
 * `outcome()` is null.
 */
export function createRoundCanary(env = process.env, { seed } = {}) {
  if (!canaryEnabled(env)) {
    return { enabled: false, plant: (built) => built, resolve: () => null, outcome: () => null, markUnsupported: () => null };
  }
  const canary = createCanary({ seed });
  const planted = new Set();
  let outcome = null;

  /** Append the canary file to the code (last) message of an eligible pass call. */
  function plant(built, opts = {}) {
    if (!CANARY_ELIGIBLE_PASSES.includes(opts.passName) || !isPlantedUnit(opts.unitLabel)) return built;
    if (opts.unitLabel === 'probe') return built;
    const messages = Array.isArray(built?.messages) ? built.messages : null;
    if (!messages || messages.length === 0) return built;
    planted.add(opts.passName);
    const last = messages[messages.length - 1];
    return { ...built, messages: [...messages.slice(0, -1), { ...last, content: `${last.content}${canary.block}` }] };
  }

  /**
   * Strip every canary-cited finding from the given pass results (in place) and
   * record which planted passes named the defect.
   * @param {Array<{result?: {findings?: object[]}, failed?: boolean}>} results
   * @param {string[]} passNames - same order as `results`
   */
  function resolve(results, passNames) {
    const detectedIn = [];
    const missedIn = [];
    const failedIn = [];
    const seen = new Set();
    (results || []).forEach((r, i) => {
      const name = passNames[i];
      const findings = Array.isArray(r?.result?.findings) ? r.result.findings : [];
      const cited = findings.filter((f) => citesCanary(f, canary));
      // Strip canary-ANCHORED findings only: one anchored to a real file is about that file even if its text mentions
      // the canary, and is kept. Replace, never mutate — a skipped pass's `result` can be a shared EMPTY_* constant.
      if (cited.length > 0) r.result = { ...r.result, findings: findings.filter((f) => !citesCanary(f, canary)) };
      if (!planted.has(name)) return;
      seen.add(name);
      const hit = cited.find(namesCanaryDefect);
      if (r?.failed) failedIn.push(name);
      else if (hit) detectedIn.push(name);
      else missedIn.push(name);
      process.stderr.write(`  [canary] ${name}: ${hit ? `detected (${hit.severity ?? '?'} "${String(hit.section ?? '').slice(0, 80)}")` : r?.failed ? 'pass failed' : `MISSED (${cited.length} finding(s) on the canary file, none naming the defect${cited[0] ? `; first: "${findingText(cited[0]).replace(/\s+/g, ' ').slice(0, 300)}"` : ''})`}\n`);
    });
    // A planted pass with no result to read was not measured — that is a miss, never a silent pass.
    for (const name of planted) if (!seen.has(name)) { missedIn.push(name); process.stderr.write(`  [canary] ${name}: MISSED (no result returned for a planted pass)\n`); }
    let status;
    if (planted.size === 0) status = 'not-planted';
    else if (missedIn.length > 0) status = 'missed';
    else if (failedIn.length > 0) status = 'pass-failed';
    else status = 'detected';
    outcome = { status, planted: [...planted], detectedIn, missedIn, failedIn, chars: canary.chars, path: canary.path };
    return outcome;
  }

  return {
    enabled: true,
    canary,
    plant,
    resolve,
    outcome: () => outcome ?? { status: 'not-planted', planted: [...planted], detectedIn: [], missedIn: [], failedIn: [], chars: canary.chars, path: canary.path },
  };
}

/** Is this canary outcome evidence? Only `detected` is; null (disabled) is "not asked". */
export function canaryBlocksEvidence(outcome) {
  return Boolean(outcome) && outcome.status !== 'detected';
}

/**
 * The tiered pipeline has no canary in v1: with the flag on, its result is
 * stamped `unsupported-pipeline` and made INCOMPLETE rather than passing unchecked.
 * Returns the (mutated) result.
 */
export function applyCanaryToUnsupportedPipeline(result, env = process.env) {
  if (!canaryEnabled(env) || !result || result._canary) return result;
  result._canary = { status: 'unsupported-pipeline', planted: [], detectedIn: [], missedIn: [], failedIn: [], chars: 0, path: null };
  result.verdict = 'INCOMPLETE';
  result._convergence = { ...(result._convergence || {}), converged: false, reason: 'canary-unsupported-pipeline' };
  process.stderr.write('  [canary] AUDIT_CANARY=1 but the tiered pipeline has no canary — round marked INCOMPLETE\n');
  return result;
}

/** The summary-line clause for a canary that blocks evidence. */
export function describeCanaryBlock(outcome) {
  switch (outcome?.status) {
    case 'missed': return `the planted canary defect was not reported by ${outcome.missedIn.join(', ')} (the auditor was blind this round)`;
    case 'not-planted': return 'AUDIT_CANARY=1 but no eligible pass ran, so the canary was never planted';
    case 'unsupported-pipeline': return 'AUDIT_CANARY=1 but this pipeline has no canary';
    case 'pass-failed': return `the canary's pass failed (${outcome.failedIn.join(', ')})`;
    default: return null;
  }
}
