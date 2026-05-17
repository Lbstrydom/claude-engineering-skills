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
 *  - REFUTE only on an UNAMBIGUOUS, exact match. Ambiguity (multiple cited
 *    paths, extensionless specifier, scoped package) → requires_verification
 *    — never a false refute (audit H2/H3/H4/H5/M6/M7).
 *
 * @module scripts/lib/audit/finding-verification
 */
import path from 'node:path';
import { isSensitivePath } from '../quickfix-patterns.mjs';
import { resolveSpecifier, RESOLVABLE_EXTENSIONS } from '../module-graph.mjs';

/**
 * Regexes that mark a finding as an *existence claim* about the repo.
 * Single source of truth (#5). Tested against category + section + detail.
 */
export const EXISTENCE_CLAIM_SIGNAL = Object.freeze([
  /missing (?:module|file|import|dependency|export|symbol)/i,
  /\b(?:module|file|import|export|symbol)\b[^.]{0,40}\b(?:does ?n[o']?t exist|not found|is missing|is absent|cannot be found)/i,
  /no such (?:file|module)/i,
  /unresolved import/i,
  /cannot (?:find|resolve) (?:the )?(?:module|file|import|package)/i,
  /\b(?:undefined|unknown) export\b/i,
  /not (?:provided|present) in the (?:found-file set|file set|repo)/i,
]);

/** Token shape for a path/specifier/symbol cited in finding prose. */
const TOKEN = '[\\w./@$-]{2,200}';

/** "<token> does not exist / is missing / not found / …" */
const CLAIM_BEFORE = new RegExp(
  `[\`'"](${TOKEN})[\`'"]\\s*(?:\\([^)]*\\)\\s*)?(?:was |is |were |are )?` +
  `(?:does ?n[o']?t exist|doesn'?t exist|is missing|are missing|not found|` +
  `cannot be found|is absent|is not present|was not (?:provided|found))`,
  'i',
);
/** "missing module <token>" / "cannot resolve <token>" / "no such file <token>" */
const CLAIM_AFTER = new RegExp(
  `(?:missing|unresolved import|cannot (?:find|resolve)|no such (?:file|module)|` +
  `undefined export|unknown export)\\s+(?:module |file |import |the |dependency |` +
  `export |symbol )*[\`'"]?(${TOKEN})[\`'"]?`,
  'i',
);

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

  const kind = tokenKind(token, finding);
  if (kind === 'symbol') return { kind, name: token, fromFile, exportName: token };
  return { kind, name: token, fromFile, exportName: null };
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
 * @returns {object[]} same findings; existence-claim ones gain `.verification`
 */
export function verifyExistenceFindings(findings, ctx = {}) {
  const { repoFiles = [] } = ctx;
  const fileSet = repoFiles instanceof Set ? repoFiles : new Set(repoFiles);

  return (findings || []).map((finding) => {
    if (!classifyFinding(finding)) return finding;

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
    const norm = entity.name.replace(/\\/g, '/');
    // Sensitive-path check BEFORE anything else (audit Gemini-R2-G1) — the
    // gate must not become a side channel confirming a secret file.
    if (isSensitivePath(norm)) {
      return { ...finding, verification: mk('requires_verification', 'cited path matches the sensitive-path denylist; not adjudicated', entity, finding) };
    }
    // Windows-absolute / drive-letter → out of scope.
    if (/^[A-Za-z]:/.test(norm) || path.posix.isAbsolute(norm)) {
      return { ...finding, verification: mk('requires_verification', 'cited path is absolute — outside the repo-relative inventory', entity, finding) };
    }

    if (norm.startsWith('./') || norm.startsWith('../')) {
      // Relative specifier — resolve against the importer, ESM-exact
      // (audit H2/M6: resolve THEN check; no extensionless probing).
      const r = resolveSpecifier({ fromFile: entity.fromFile, specifier: norm, repoFiles: fileSet, exact: true });
      if (r.kind === 'repo') {
        return { ...finding, verification: mk('refuted', `file "${r.resolved}" exists in the repository inventory — "missing" claim is a context-window artefact`, entity, finding, 'LOW') };
      }
      // Could not resolve to a repo file: importer unknown, the specifier
      // escapes the repo, or it is genuinely absent — all unprovable here.
      return { ...finding, verification: mk('requires_verification', `relative specifier "${norm}" could not be resolved to a repo file (importer unknown / escapes repo / absent)`, entity, finding) };
    }

    // A repo-root-relative path — exact inventory membership only (H3: the
    // inventory is the SOLE source of truth, no `fs` fallback).
    if (fileSet.has(norm)) {
      return { ...finding, verification: mk('refuted', `file "${norm}" exists in the repository inventory — "missing" claim is a context-window artefact`, entity, finding, 'LOW') };
    }
    return { ...finding, verification: mk('confirmed', `file "${norm}" is not present in the repository inventory`, entity, finding) };
  });
}
