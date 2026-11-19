/**
 * @fileoverview Corpus-level rules for `known-defects.json` v4: per-suite shape validation, the frozen legacy-identity
 * exemption, subset selection, the content digest that stamps a run, and judge-free expect_clean scoring.
 * Plan: docs/plans/sashiko-audit-improvements.md §5 (PR C). Pure: no I/O, no LLM calls.
 *
 * @module scripts/lib/model-eval/corpus-selection
 */
import crypto from 'node:crypto';

export const SUITES = Object.freeze(['detect', 'missed', 'expect_clean']);
export const SUBSETS = Object.freeze(['tiny', 'small', 'full']);

/**
 * The 18 entries present before v4 (`git show 1df6fbfb:docs/experiments/audit-effectiveness/known-defects.json`). They are exempt
 * from `curation` ONLY while all four identity fields still match, so removing an entry and reusing its id, or repointing it at
 * another commit, loses the exemption. The array can only shrink.
 */
export const LEGACY_UNCURATED_KD = Object.freeze([
  Object.freeze({"id": "KD-002", "repo": "claude-engineering-skills", "buggyCommit": "153adb52c91c8c7b34b1222e4d7792e65a410bc1", "fixCommit": "aa5dd0beccbd0f4143fcfc4a80603a7bcbc52600"}),
  Object.freeze({"id": "KD-005", "repo": "claude-engineering-skills", "buggyCommit": "105da2fbe58bd3b37f511437ae4d86cde46f2e14", "fixCommit": "19a9ded6220b45098f799ed3669c3fb90bce3c3b"}),
  Object.freeze({"id": "KD-006", "repo": "claude-engineering-skills", "buggyCommit": "d1ee5cc2e4c213979dda4e58ccfbb0e97947701b", "fixCommit": "33a3f5cc421ac85352b806e09192892aad44784b"}),
  Object.freeze({"id": "KD-015", "repo": "claude-engineering-skills", "buggyCommit": "7ca21a3a86d45cc31fa0d50eb34db3e126df02ed", "fixCommit": "d557535fe56541a35b834596e71fcecccb9846d7"}),
  Object.freeze({"id": "KD-016", "repo": "claude-engineering-skills", "buggyCommit": "86dd669f3e773424d7dd37cd66482159dd140a88", "fixCommit": "af67b2c7076731e75e5df08b3b1223af68098cfe"}),
  Object.freeze({"id": "KD-017", "repo": "claude-engineering-skills", "buggyCommit": "5cd1fc72d68835ed98375f6e0728c52e2efa6357", "fixCommit": "e8535f04974be92115ea66ac37c1295240ef121d"}),
  Object.freeze({"id": "KD-018", "repo": "claude-engineering-skills", "buggyCommit": "2f57718324a134088828075fb67137c01b920637", "fixCommit": "4558c87fdb907acc7ce0ef3cf15a0ece2aada82c"}),
  Object.freeze({"id": "KD-019", "repo": "claude-engineering-skills", "buggyCommit": "540cacf1c4b1fe4251756f3d0610d9cd83f301ab", "fixCommit": "a506ba9adcf293ac117cdd2addad39c20fd8e391"}),
  Object.freeze({"id": "KD-008", "repo": "wine-cellar-app", "buggyCommit": "9b08adbe99b3edf41b6b2150f9b82b91941b21dc", "fixCommit": "e1706bae5de1c23512fdc4da79927a83a2541bce"}),
  Object.freeze({"id": "KD-011", "repo": "wine-cellar-app", "buggyCommit": "58bba0320e6d2fd6e9624e6b5681e7390d3f5cd3", "fixCommit": "f540f061e37ccc3c6a92a9808b4cfb5efe019f63"}),
  Object.freeze({"id": "KD-012", "repo": "ai-organiser", "buggyCommit": "8b61fa66b8b18ab20c2d0d9d34a4825c090140cc", "fixCommit": "cb152f50b5e53dac952eadc83a03da93311f3280"}),
  Object.freeze({"id": "KD-013", "repo": "ai-organiser", "buggyCommit": "573cbe186745f4f5b19a7ec24e6912a97f26f258", "fixCommit": "1478fa2e6faa6e63d10513149c2e2495a2d6f4e5"}),
  Object.freeze({"id": "KD-020", "repo": "claude-engineering-skills", "buggyCommit": "1823c7c81edfaa6624d29dd5de984031c4d20afe", "fixCommit": "ac013eda4fe05953ad5bab1d5c8cbc98fb4f4cae"}),
  Object.freeze({"id": "KD-021", "repo": "claude-engineering-skills", "buggyCommit": "fb8244f749b93c5b3ba1a62ecc30a23f02e85a5c", "fixCommit": "dc64e319900375d5371361c024a2e3855f9cd78a"}),
  Object.freeze({"id": "KD-022", "repo": "claude-engineering-skills", "buggyCommit": "b6917174f1ce2a3bdb866b27680a89c7ee9c409f", "fixCommit": "5a0f667e50223cad7b89fa337485922e9c687a80"}),
  Object.freeze({"id": "KD-023", "repo": "claude-engineering-skills", "buggyCommit": "6498f99b61b8ddea88456e29dfc017bae9db81c3", "fixCommit": "87738e8315fd54671e47ace4a3f10f459b1c56c8"}),
  Object.freeze({"id": "KD-024", "repo": "claude-engineering-skills", "buggyCommit": "eecdbf98915811e63d0223fd2d7ef95173435ea2", "fixCommit": "9d0ce472c5cd2d1c5e7efa5c26bfa1231274d23a"}),
  Object.freeze({"id": "KD-026", "repo": "claude-engineering-skills", "buggyCommit": "be9545d6f9e854eef8d9dd5d808cd8afd1d52d73", "fixCommit": "bc3c8f1b69cb4643d8e7e548484e31a41ec65e7c"})
]);

const sameIdentity = (e, l) => e.id === l.id && e.repo === l.repo && e.buggyCommit === l.buggyCommit && e.fixCommit === l.fixCommit;
export const suiteOf = (e) => e?.suite ?? 'detect';

/** Canonical JSON (sorted keys): the byte-stable form the digest hashes. */
export function canonicalize(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/** sha256 over the WHOLE corpus: an edit without a version bump still changes a run's stamp. */
export const corpusDigest = (corpus) => crypto.createHash('sha256').update(canonicalize(corpus)).digest('hex');

/**
 * @param {object} corpus parsed known-defects.json
 * @param {{requireCuration?:boolean}} [opts] `requireCuration:false` skips the curation rule (an ad-hoc corpus passed with --corpus)
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateCorpus(corpus, { requireCuration = true } = {}) {
  const errors = [];
  const defects = Array.isArray(corpus?.defects) ? corpus.defects : null;
  if (!defects) return { ok: false, errors: ['corpus.defects is not an array'] };
  const ids = new Set();
  for (const e of defects) {
    const tag = `entry ${e?.id ?? '(no id)'}`;
    if (!e?.id) { errors.push('an entry has no id'); continue; }
    if (ids.has(e.id)) errors.push(`${tag}: duplicate id`);
    ids.add(e.id);
    const suite = suiteOf(e);
    if (!SUITES.includes(suite)) { errors.push(`${tag}: unknown suite "${suite}"`); continue; }
    if (suite === 'expect_clean') {
      if (!e.commit || !Array.isArray(e.files) || !e.files.length || !e.rationale) errors.push(`${tag}: expect_clean needs commit, files and rationale`);
      if (e.buggyCommit || e.fixCommit || e.expectedFindingRubric) errors.push(`${tag}: expect_clean must not carry buggyCommit, fixCommit or expectedFindingRubric`);
    } else if (!e.buggyCommit || !e.expectedFindingRubric) {
      errors.push(`${tag}: ${suite} needs buggyCommit and expectedFindingRubric`);
    }
    const legacy = LEGACY_UNCURATED_KD.some((l) => sameIdentity(e, l));
    if (e.curation) {
      if (e.curation.method !== 'human-review' || !e.curation.reviewedIn) errors.push(`${tag}: curation needs method "human-review" and reviewedIn`);
    } else if (!legacy && requireCuration) {
      errors.push(`${tag}: a non-legacy entry needs curation {method, reviewedIn, miner}`);
    }
  }
  for (const [name, list] of Object.entries(corpus.subsets ?? {})) {
    if (!Array.isArray(list)) { errors.push(`subset ${name} is not an array`); continue; }
    for (const id of list) {
      const e = defects.find((d) => d.id === id);
      if (!e) errors.push(`subset ${name}: unknown id ${id}`);
      else if (e.invalidated) errors.push(`subset ${name}: ${id} is invalidated`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** The sampling pool: never an `invalidated` entry; only the requested suite; narrowed by `--subset` (full = every usable entry). */
export function selectPool(corpus, { suite = 'detect', subset = 'full' } = {}) {
  if (!SUITES.includes(suite)) throw new Error(`unknown suite "${suite}" (known: ${SUITES.join(', ')})`);
  if (!SUBSETS.includes(subset)) throw new Error(`unknown subset "${subset}" (known: ${SUBSETS.join(', ')})`);
  let pool = (corpus.defects ?? []).filter((e) => !e.invalidated && suiteOf(e) === suite);
  if (subset !== 'full') {
    const ids = new Set(corpus.subsets?.[subset] ?? []);
    if (ids.size === 0) throw new Error(`corpus has no "${subset}" subset`);
    pool = pool.filter((e) => ids.has(e.id));
  }
  return pool;
}

/** The comparability stamp: what must match before two runs may be compared. */
export function selectionStamp(corpus, { suite, subset, seed, requestedN, selected }) {
  return {
    suite, subset, corpusVersion: String(corpus.version), corpusDigest: corpusDigest(corpus),
    selection: { seed, requestedN, selectedIds: selected.map((e) => e.id) },
  };
}

const STAMP_FIELDS = ['suite', 'subset', 'corpusDigest', 'corpusLoaderVersion'];
/** @returns {string|null} the first field two stamps disagree on, else null */
export function stampMismatch(a, b) {
  for (const f of STAMP_FIELDS) if (a?.[f] !== b?.[f]) return f;
  return canonicalize(a?.selection?.selectedIds) === canonicalize(b?.selection?.selectedIds) ? null : 'selection.selectedIds';
}

const BLOCKING = new Set(['MEDIUM', 'HIGH']);
/**
 * Judge-free expect_clean scoring (sashiko's rule): zero findings at MEDIUM or above on the case's files is `clean`; any such
 * finding is a `false_positive` (its pass recorded); a run that failed is `failed` and counts in the denominator, never as clean.
 * @param {{failed?:boolean, findings?:Array<{file?:string, severity?:string, pass?:string}>}} out
 */
export function scoreExpectCleanCase(out, files) {
  if (!out || out.failed) return { outcome: 'failed', passes: [] };
  const want = new Set(files.map((f) => f.toLowerCase()));
  const hits = (out.findings ?? []).filter((f) => BLOCKING.has(f.severity) && want.has(String(f.file ?? '').toLowerCase()));
  return hits.length === 0 ? { outcome: 'clean', passes: [] } : { outcome: 'false_positive', passes: [...new Set(hits.map((h) => h.pass ?? 'unknown'))] };
}

/** Suite block; zero cases is `unmeasured`, never fpRate 0. */
export function summarizeExpectClean(perCase) {
  const cases = perCase.length;
  if (cases === 0) return { cases: 0, unmeasured: true };
  const count = (o) => perCase.filter((c) => c.outcome === o).length;
  const failed = count('failed');
  return { cases, clean: count('clean'), falsePositive: count('false_positive'), failed, fpRate: count('false_positive') / cases, measuredRate: (cases - failed) / cases };
}
