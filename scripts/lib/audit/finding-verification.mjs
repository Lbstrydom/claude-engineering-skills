/**
 * @fileoverview Deterministic finding-verification gate.
 * Plan: docs/plans/adaptive-context-blast-radius.md — Phase 1.
 *
 * An audit `--scope diff` run cannot see unchanged-but-imported files, so
 * GPT periodically claims an existing file/module/symbol is "missing".
 * This gate resolves every such *existence claim* against the real
 * repository — deterministically, no LLM — and downgrades only the ones
 * it can PROVE false. It runs in CODE mode only (plan-audit findings
 * about not-yet-created artefacts are legitimately "missing").
 *
 * Soundness rules:
 *  - Presence is provable; absence is provable ONLY for files (the repo
 *    inventory is complete). A "missing symbol" claim is never `confirmed`
 *    — the AST index omits interfaces / types / enums / consts (audit G1).
 *  - Only `refuted` (proof of falsity) downgrades. `confirmed` and
 *    `requires_verification` preserve the model's original severity —
 *    capping an unverifiable finding could bury a real HIGH (audit G2).
 *  - The model's finding is immutable; the gate attaches a sibling
 *    `verification` object (audit M2).
 *  - REFUTE only on an UNAMBIGUOUS match: exact inventory membership, an
 *    ESM-exact relative resolve, or a UNIQUE segment-boundary suffix hit
 *    (a model cites `zone/zoneChat.js` for `src/services/zone/zoneChat.js`).
 *    Several suffix hits, an extensionless specifier or a scoped package →
 *    requires_verification — never a false refute (audit H2/H3/H4/H5/M6/M7).
 *  - A LIST claim ("…are absent: `a`, `b`, `c`") is adjudicated
 *    all-or-nothing: every path present → refuted; every path absent →
 *    confirmed; MIXED → requires_verification at the model's severity, since
 *    the genuinely-absent members may be a real defect and burying them at
 *    LOW is the failure direction this gate exists to prevent.
 *
 * @module scripts/lib/audit/finding-verification
 */
import path from 'node:path';
import { isSensitivePath } from '../quickfix-patterns.mjs';
import { resolveSpecifier, RESOLVABLE_EXTENSIONS } from '../module-graph.mjs';
import { resolveUniqueSuffix } from '../repo-inventory.mjs';

/** Token shape for a path/specifier/symbol cited in finding prose. */
const TOKEN = '[\\w./@$-]{2,200}';

/** An entity noun the prose may put between the cited token and the claim
 *  phrase: "`zone/zoneChat.js` **module** is missing". Without this the
 *  anchored CLAIM_BEFORE misses and CLAIM_AFTER takes over — badly (below). */
const ENTITY_NOUN = '(?:module|file|script|test|spec|import|export|symbol|dependency|package|component|route|handler|service|helper)s?';

/**
 * `missing` is the one claim word here with two readings, and the gate
 * conflated them (field report 2026-08-13):
 *  - PREDICATIVE — "`x.mjs` is missing." — the ENTITY is absent. The only
 *    reading this gate can adjudicate against a file inventory.
 *  - TRANSITIVE — "`x.mjs` is missing error handling." — the entity EXISTS
 *    and a FEATURE of it is absent. Resolving the path then "proves" the
 *    claim false: a real HIGH is dropped from the verdict while still
 *    reading HIGH in `findings[]`. That is the opposite direction from the
 *    false-absence problem the gate was built for, and it leaves no trace.
 *
 * A direct object is a noun phrase, and a noun phrase cannot begin with
 * punctuation, end-of-input, a preposition, a subordinator, a coordinator or
 * a degree adverb — so the predicative reading is admitted only when one of
 * those follows. Deliberately an ALLOWLIST: an unlisted continuation makes
 * the gate skip the finding, which survives at the model's own severity.
 * That is this file's stated safe direction (only `refuted` downgrades) —
 * a denylist of object shapes would fail toward the false refute instead.
 * Determiners/relativisers ("that", "which") are deliberately absent: "is
 * missing that null check" is transitive.
 */
const PREDICATIVE_CONTINUATION =
  'from|in|into|on|at|under|over|within|across|throughout|after|before|since|'
  + 'for|despite|although|though|while|whereas|because|'
  + 'and|or|but|so|yet|'
  + 'entirely|completely|altogether|wholly|outright|still|also|too|again|here|there';
const PREDICATIVE_TAIL =
  '(?=\\s*(?:$|[.,;:!?)\\]}"\'`\\n\\r—–-]|(?:' + PREDICATIVE_CONTINUATION + ')\\b))';

/** `missing` used ATTRIBUTIVELY — "the missing module `x`" — where the object
 *  IS the cited entity rather than a feature of it. Keeps the plural/list
 *  pattern below from losing its attributive coverage to PREDICATIVE_TAIL. */
const ATTRIBUTIVE_TAIL = `(?=\\s+(?:${ENTITY_NOUN}\\b|[\`'"]))`;

/**
 * Regexes that mark a finding as an *existence claim* about the repo.
 * Single source of truth (#5). Tested against category + section + detail.
 */
export const EXISTENCE_CLAIM_SIGNAL = Object.freeze([
  /missing (?:module|file|import|dependency|export|symbol)/i,
  new RegExp(
    '\\b(?:module|file|import|export|symbol)s?\\b[^.]{0,60}\\b(?:does ?n[o\']?t exist|do not exist|not found|'
    + '(?:is|are) missing' + PREDICATIVE_TAIL
    + '|is absent|are absent|cannot be found|is not present|are not present)',
    'i',
  ),
  /no such (?:file|module)/i,
  /unresolved import/i,
  /cannot (?:find|resolve) (?:the )?(?:module|file|import|package)/i,
  /\b(?:undefined|unknown) export\b/i,
  /not (?:provided|present) in the (?:found-file set|file set|repo)/i,
  // ── Plural / list-shaped absence prose (field cases, 2026-08-13) ──
  // "The production modules … are absent: `a`, `b`, …" and "None of the three
  // planned verification files exists: `a`, `b`, `c`" matched NONE of the
  // singular patterns above, so the gate never ran on the two findings that
  // between them named 14 files — all of which existed. Absence prose is
  // written in the plural at least as often as the singular.
  /\bnone of the\b[^.]{0,80}\b(?:exists?|are present|were (?:created|added|found))\b/i,
  new RegExp(
    '\\b(?:module|file|script|test|spec|dependenc|export|symbol)\\w*\\b[^.]{0,60}\\bmissing\\b'
    + '(?:' + PREDICATIVE_TAIL + '|' + ATTRIBUTIVE_TAIL + ')',
    'i',
  ),
]);

/** English function words that can never name a repo entity. CLAIM_AFTER
 *  anchors on a keyword and captures the NEXT token, which in
 *  "…is missing **from** the repository inventory" is `from` — see the
 *  lookbehind note below; this is the belt to that pair of braces. */
const NON_ENTITY_TOKENS = new Set([
  'from', 'in', 'on', 'at', 'to', 'of', 'for', 'and', 'or', 'the', 'a', 'an',
  'it', 'its', 'this', 'that', 'these', 'those', 'any', 'all', 'both', 'here',
]);

/**
 * "<token> does not exist / is missing / not found / …"
 *
 * `(?:is|are) missing` carries PREDICATIVE_TAIL because classification is not
 * the only door in: a finding whose CATEGORY is an existence claim ("Missing
 * Module") reaches the extractor whatever its detail says. Without the guard
 * here, "`x.mjs` is missing error handling" still yields `x.mjs` as the cited
 * entity, the inventory resolves it, and the gate refutes a true finding. No
 * match ⇒ `requires_verification` at the model's severity — safe by design.
 */
const CLAIM_BEFORE = new RegExp(
  `[\`'"](${TOKEN})[\`'"]\\s*(?:\\([^)]*\\)\\s*)?(?:${ENTITY_NOUN}\\s+)?(?:was |is |were |are )?` +
  `(?:does ?n[o']?t exist|doesn'?t exist|(?:is|are) missing${PREDICATIVE_TAIL}|not found|` +
  `cannot be found|is absent|are absent|is not present|was not (?:provided|found))`,
  'i',
);
/**
 * "missing module <token>" / "cannot resolve <token>" / "no such file <token>".
 *
 * The lookbehind is load-bearing. `missing` is used both ATTRIBUTIVELY ("the
 * missing module `x`", entity follows) and PREDICATIVELY ("`x` is missing
 * **from** the repository inventory", entity PRECEDES). Without it this
 * pattern captured `from` and the gate reported
 * `"from" looks like an external dependency, not a repo file` — an extractor
 * failure wearing a considered adjudication's clothes. Measured 2026-08-13:
 * two runs made the same claim about the same file; the one phrased
 * predicatively went un-adjudicated and shipped as a HIGH.
 */
const CLAIM_AFTER = new RegExp(
  `(?<!\\b(?:is|are|was|were|be|been|being|still|not|also)\\s)` +
  `(?:missing|unresolved import|cannot (?:find|resolve)|no such (?:file|module)|` +
  `undefined export|unknown export)\\s+(?:module |file |import |the |dependency |` +
  `export |symbol )*[\`'"]?(${TOKEN})[\`'"]?`,
  'i',
);

/** Intro phrase of a LIST-shaped absence claim, terminated by the delimiter
 *  that opens the list. Everything after it is scanned for quoted paths. */
const LIST_INTRO = new RegExp(
  `(?:are absent|are missing|are not present|do not exist|were not (?:created|added|found)|` +
  `none of the[^:.]{0,80}?exists?)\\s*[:—-]`,
  'i',
);
/** Quoted, path-shaped tokens — the members of a list claim. */
const QUOTED_PATH = new RegExp('[`\'"](' + TOKEN + ')[`\'"]', 'g');

const EXT_RE = new RegExp(`(${RESOLVABLE_EXTENSIONS.map((e) => '\\' + e).join('|')}|\\.jsx|\\.ts|\\.tsx|\\.md)$`, 'i');

/**
 * Does this finding assert that a repo entity is missing?  Pure.
 * @param {object} finding
 * @returns {boolean}
 */
export function classifyFinding(finding) {
  const hay = `${finding?.category || ''}\n${finding?.section || ''}\n${finding?.detail || ''}`;
  return EXISTENCE_CLAIM_SIGNAL.some((re) => re.test(hay));
}

const SYMBOL_CONTEXT_RE = /\b(symbol|export|function|class|const|variable|method|interface|type)\b/i;

/**
 * Classify a cited token as a file path, an external package, or a symbol.
 * A bare word (no slash, no extension) is ambiguous — a package name and a
 * symbol identifier both look bare — so the finding's claim context
 * disambiguates: an "export/symbol" claim → symbol; otherwise → external
 * (a bare module specifier IS an external dependency, audit M7).
 */
function tokenKind(token, finding) {
  if (token.startsWith('@')) return 'external'; // scoped package
  if (token.includes('/') || EXT_RE.test(token)) return 'file';
  const ctx = `${finding?.category || ''} ${finding?.detail || ''}`;
  if (/^[A-Za-z_$][\w$]*$/.test(token) && SYMBOL_CONTEXT_RE.test(ctx)) return 'symbol';
  return 'external'; // bare module specifier with no symbol context
}

/**
 * Structured extraction of the entity a finding claims is missing — anchored
 * on the claim phrase, NOT "first quoted token wins" (audit H4/H5). When a
 * finding cites several tokens (e.g. importer + missing module), only the
 * one adjacent to the missing-claim phrase is taken. Returns `null` when
 * no single entity can be unambiguously identified → gate falls back to
 * `requires_verification`.
 *
 * @param {object} finding
 * @returns {{kind:'file'|'symbol'|'external', name:string, fromFile:string|null, exportName:string|null}|null}
 */
export function extractCitedEntity(finding) {
  const detail = String(finding?.detail || '');
  const section = String(finding?.section || '');

  const fromFile = (EXT_RE.test(section) || section.includes('/'))
    ? section.replace(/\\/g, '/').replace(/^\.\//, '').split(/[\s,:]/)[0]
    : null;

  let token = null;
  for (const re of [CLAIM_BEFORE, CLAIM_AFTER]) {
    const m = detail.match(re) || section.match(re);
    if (m) { token = m[1].trim(); break; }
  }
  if (!token) return null;
  token = token.replace(/\\/g, '/').replace(/^\.\//, '');
  // A bare function word is an extraction failure, not an entity.
  if (NON_ENTITY_TOKENS.has(token.toLowerCase())) return null;

  const kind = tokenKind(token, finding);
  if (kind === 'symbol') return { kind, name: token, fromFile, exportName: token };
  return { kind, name: token, fromFile, exportName: null };
}

/**
 * The entities of a LIST-shaped absence claim ("…are absent: `a.js`, `b.js`,
 * and `c.js`"). `extractCitedEntity` returns exactly one, so before this a
 * list claim was unadjudicatable by construction — the single most common
 * shape in which a structure pass asserts absence, and the one that named 14
 * existing files as missing across two runs.
 *
 * Returns `null` unless the prose is unambiguously list-shaped AND cites at
 * least two path-shaped tokens; a one-element "list" is the singular path's
 * job and must not take a different code route.
 *
 * @param {object} finding
 * @returns {{kind:'file', name:string, fromFile:null, exportName:null}[]|null}
 */
export function extractCitedEntityList(finding) {
  const detail = String(finding?.detail || '');
  const intro = detail.match(LIST_INTRO);
  if (!intro) return null;

  const tail = detail.slice(intro.index + intro[0].length);
  const names = [];
  QUOTED_PATH.lastIndex = 0;
  for (let m = QUOTED_PATH.exec(tail); m; m = QUOTED_PATH.exec(tail)) {
    const name = m[1].trim().replace(/\\/g, '/').replace(/^\.\//, '');
    // Members of a file list must LOOK like files — a bare word in the tail
    // is prose, not a cited path, and guessing costs a false verdict.
    if (!name.includes('/') && !EXT_RE.test(name)) continue;
    if (!names.includes(name)) names.push(name);
  }
  if (names.length < 2) return null;
  return names.map((name) => ({ kind: 'file', name, fromFile: null, exportName: null }));
}

/**
 * Resolve ONE cited file path against the inventory.
 *
 * `present` and `absent` are both sound only under the stated soundness
 * rules; everything else is `unknown` and must never be turned into a
 * verdict. Split out of `verifyExistenceFindings` so the singular and list
 * paths cannot drift into two different notions of "exists".
 *
 * @returns {{status:'present'|'absent'|'unknown', resolved?:string, reason:string}}
 */
function resolveFileClaim(name, { fileSet, fromFile, inventoryComplete }) {
  const norm = String(name).replace(/\\/g, '/');

  // Sensitive-path check BEFORE anything else (audit Gemini-R2-G1) — the gate
  // must not become a side channel confirming a secret file.
  if (isSensitivePath(norm)) {
    return { status: 'unknown', reason: 'cited path matches the sensitive-path denylist; not adjudicated' };
  }
  if (/^[A-Za-z]:/.test(norm) || path.posix.isAbsolute(norm)) {
    return { status: 'unknown', reason: 'cited path is absolute — outside the repo-relative inventory' };
  }

  if (norm.startsWith('./') || norm.startsWith('../')) {
    // Relative specifier — resolve against the importer, ESM-exact
    // (audit H2/M6: resolve THEN check; no extensionless probing).
    const r = resolveSpecifier({ fromFile, specifier: norm, repoFiles: fileSet, exact: true });
    if (r.kind === 'repo') return { status: 'present', resolved: r.resolved, reason: '' };
    return {
      status: 'unknown',
      reason: `relative specifier "${norm}" could not be resolved to a repo file (importer unknown / escapes repo / absent)`,
    };
  }

  // Exact membership, then UNIQUE segment-boundary suffix — a model routinely
  // cites "zone/zoneChat.js" for "src/services/zone/zoneChat.js", and exact
  // membership answers "no" there, which is why the same true claim refuted in
  // one run and not the next. Delegated to `resolveUniqueSuffix` so this gate
  // and `extractPlanPaths` cannot drift into two notions of "exists" — the
  // drift that let a resolvable path be called missing on the way IN and
  // refuted on the way OUT (see that function's header).
  const hit = resolveUniqueSuffix(norm, fileSet);
  if (hit.status === 'exact' || hit.status === 'suffix') {
    return { status: 'present', resolved: hit.resolved, reason: '' };
  }
  if (hit.status === 'ambiguous') {
    return { status: 'unknown', reason: `"${norm}" matches more than one repository path as a suffix — ambiguous, not adjudicated` };
  }

  // `absent` asserts provable absence — sound only against a COMPLETE
  // inventory. If a subtree was unreadable, absence is not provable
  // (audit P3-M2).
  if (!inventoryComplete) {
    return {
      status: 'unknown',
      reason: `file "${norm}" not in the inventory, but the inventory is incomplete (a subtree was unreadable) — absence is not provable`,
    };
  }
  return { status: 'absent', reason: `file "${norm}" is not present in the repository inventory` };
}

/**
 * The severity a reader should TRIAGE on. `finding.severity` is the model's
 * immutable claim (audit M2); when the gate refuted it, that number is known
 * false and acting on it is the whole defect this gate exists to prevent.
 *
 * Exported because the orchestrator had this as an inline `effSeverity`
 * lambda and `skills/audit-code/SKILL.md` had no equivalent at all — so the
 * verdict counted a refuted HIGH as LOW while the human triaging `findings[]`
 * read it as a HIGH and fixed a file that was never missing. One accessor,
 * one spelling (AGENTS.md, prose↔code seam).
 */
export function effectiveSeverity(finding) {
  return finding?.verification ? finding.verification.verdictSeverity : finding?.severity;
}

/** Does this finding still count toward the audit verdict? */
export function countsTowardVerdict(finding) {
  return finding?.verification ? finding.verification.countsTowardVerdict : true;
}

/** Proven false against the repo inventory — never a reason to change code. */
export function isRefuted(finding) {
  return finding?.verification?.verification === 'refuted';
}

function mk(verification, reason, entity, finding, verdictSeverity) {
  return {
    verification,
    verificationReason: reason.slice(0, 300),
    citedEntity: entity,
    verdictSeverity: verdictSeverity || finding.severity,
    countsTowardVerdict: verification !== 'refuted',
  };
}

/**
 * Verify every existence-claim finding against the real repo.
 *
 * @param {object[]} findings
 * @param {object} ctx
 * @param {Set<string>|string[]} ctx.repoFiles - the canonical, sensitive-
 *   filtered inventory (`listRepoFiles().files`). The SOLE source of file
 *   existence — no `fs` fallback (audit H3).
 * @param {boolean} [ctx.inventoryComplete=true] - `listRepoFiles().complete`.
 *   When false (a subtree was unreadable), file *absence* is not provable —
 *   a "missing file" claim degrades to `requires_verification` instead of
 *   `confirmed` (audit P3-M2 — `confirmed` is a soundness claim that only
 *   holds against a complete inventory).
 * @returns {object[]} same findings; existence-claim ones gain `.verification`
 */
export function verifyExistenceFindings(findings, ctx = {}) {
  const { repoFiles = [], inventoryComplete = true } = ctx;
  const fileSet = repoFiles instanceof Set ? repoFiles : new Set(repoFiles);

  return (findings || []).map((finding) => {
    if (!classifyFinding(finding)) return finding;

    // ── List-shaped claim: adjudicate every cited path, all-or-nothing ──
    const list = extractCitedEntityList(finding);
    if (list) {
      const results = list.map((e) => ({ e, r: resolveFileClaim(e.name, { fileSet, fromFile: null, inventoryComplete }) }));
      const present = results.filter((x) => x.r.status === 'present');
      const unknown = results.filter((x) => x.r.status === 'unknown');
      const cited = `${list.length} cited path(s)`;
      if (present.length === list.length) {
        return { ...finding, verification: mk('refuted', `all ${cited} exist in the repository inventory — "missing" claim is a context-window artefact`, list, finding, 'LOW') };
      }
      if (unknown.length === 0 && present.length === 0) {
        return { ...finding, verification: mk('confirmed', `none of the ${cited} is present in the repository inventory`, list, finding) };
      }
      // Partially false. NOT refuted — the paths that really are absent may be
      // a genuine defect, and burying them at LOW is the failure direction the
      // gate exists to avoid. Severity is preserved; the reason names the
      // falsity so a reader is not left to re-derive it.
      const names = present.map((x) => x.r.resolved || x.e.name);
      return {
        ...finding,
        verification: mk('requires_verification',
          present.length
            ? `${present.length} of ${list.length} cited path(s) DO exist (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''}) — the claim is at least partly false`
            : `${unknown.length} of ${list.length} cited path(s) could not be adjudicated`,
          list, finding),
      };
    }

    const entity = extractCitedEntity(finding);
    if (!entity) {
      return { ...finding, verification: mk('requires_verification', 'existence claim, but no single cited entity could be unambiguously extracted', null, finding) };
    }

    // External dependency claim — repo inventory cannot adjudicate it.
    if (entity.kind === 'external') {
      return { ...finding, verification: mk('requires_verification', `"${entity.name}" looks like an external dependency, not a repo file — not adjudicated by the repo inventory`, entity, finding) };
    }

    // ── Symbol claims — the gate does not adjudicate these ──
    // A name-only "symbol X exists" check is not sound proof for an
    // import/export claim: a same-named symbol elsewhere does not show the
    // cited import/export is correct (audit H2), and absence is unprovable
    // from the incomplete AST index (audit G1). Per-module export
    // verification is a future enhancement; until then a symbol claim is
    // never `refuted` or `confirmed` — it always `requires_verification`,
    // preserving the model's original severity.
    if (entity.kind === 'symbol') {
      return { ...finding, verification: mk('requires_verification', `symbol "${entity.name}" — symbol/export existence is not deterministically adjudicated by this gate`, entity, finding) };
    }

    // ── File / module claims ──
    const r = resolveFileClaim(entity.name, { fileSet, fromFile: entity.fromFile, inventoryComplete });
    if (r.status === 'present') {
      return { ...finding, verification: mk('refuted', `file "${r.resolved}" exists in the repository inventory — "missing" claim is a context-window artefact`, entity, finding, 'LOW') };
    }
    if (r.status === 'absent') {
      return { ...finding, verification: mk('confirmed', r.reason, entity, finding) };
    }
    return { ...finding, verification: mk('requires_verification', r.reason, entity, finding) };
  });
}
