/**
 * @fileoverview Pure parser for docs/security-strategy.md.
 * Plan: docs/plans/security-strategy-postgres-port.md §5 (Phase 2).
 *
 * Ported from the upstream `claude-engineering-skills` parser and EXTENDED to
 * also read the corporate fields the audit-loop /security-strategy skill writes
 * into each incident block: Classification, Compliance tags, Commit. These are
 * optional and additive — the original field set (Description, Affected paths,
 * Mitigation, Lessons learned) and the `source_fingerprint` formula are
 * unchanged, so upstream fixtures still match the core shape.
 *
 * Parses incident blocks delimited by HTML comment markers:
 *   <!-- incident:start id="INC-001" -->
 *   ...field labels...
 *   <!-- incident:end -->
 *
 * No I/O. Returns { incidents, threatModel, warnings }. Caller emits warnings.
 *
 * @module scripts/security-memory/parse-strategy
 */
import crypto from 'node:crypto';

const SEMGREP_REF_RE = /^semgrep:[A-Za-z0-9._\-/]+$/;

/**
 * @param {string} markdownText
 * @returns {{
 *   incidents: Array<{
 *     incident_id: string,
 *     description: string,
 *     affected_paths: string[],
 *     mitigation_ref: string|null,
 *     mitigation_kind: 'semgrep'|'manual'|'file-ref',
 *     lessons_learned: string|null,
 *     classification: string|null,
 *     compliance_tags: string[],
 *     commit_sha: string|null,
 *     source_fingerprint: string,
 *   }>,
 *   threatModel: string|null,
 *   warnings: Array<{kind:'missing-id'|'missing-description'|'duplicate-id', line:number, snippet:string}>
 * }}
 */
export function parseSecurityStrategy(markdownText) {
  const incidents = [];
  const warnings = [];
  const seenIds = new Set();

  if (typeof markdownText !== 'string' || markdownText.length === 0) {
    return { incidents, threatModel: null, warnings };
  }

  // Normalise CRLF → LF for stable hashing across platforms.
  const text = markdownText.replace(/\r\n/g, '\n');

  // Threat model: optional "## Threat model" section, prose until the next
  // "## " heading or EOF. `$(?![\s\S])` is the end-of-string anchor (JS has no
  // \Z; \Z-like behaviour is emulated with a negative lookahead).
  let threatModel = null;
  const tmMatch = text.match(/^##\s+Threat\s+model\s*\n([\s\S]*?)(?=^##\s+|$(?![\s\S]))/im);
  if (tmMatch) {
    const trimmed = stripMarkerComments(tmMatch[1]).trim();
    if (trimmed.length > 0 && !/no threat model recorded yet/i.test(trimmed)) {
      threatModel = trimmed;
    }
  }

  // Walk every incident:start ... incident:end pair.
  const blockRe = /<!--\s*incident:start\s+id="([^"]*)"\s*-->([\s\S]*?)<!--\s*incident:end\s*-->/g;
  let match;
  while ((match = blockRe.exec(text)) !== null) {
    const lineNumber = lineOfOffset(text, match.index);
    const incident_id = match[1].trim();
    const body = match[2];
    const snippet = body.trim().slice(0, 80).replace(/\s+/g, ' ');

    if (!incident_id) {
      warnings.push({ kind: 'missing-id', line: lineNumber, snippet });
      continue;
    }

    // Dedupe by incident_id, first wins.
    if (seenIds.has(incident_id)) {
      warnings.push({ kind: 'duplicate-id', line: lineNumber, snippet: `${incident_id}: ${snippet}` });
      continue;
    }

    const fields = extractFields(body);
    if (!fields.description) {
      warnings.push({ kind: 'missing-description', line: lineNumber, snippet: `${incident_id}: ${snippet}` });
      continue;
    }

    seenIds.add(incident_id);

    const mitigation_ref = fields.mitigation || null;
    const mitigation_kind = deriveMitigationKind(mitigation_ref);

    const source_fingerprint = computeFingerprint({
      description: fields.description,
      lessons_learned: fields.lessons_learned,
      affected_paths: fields.affected_paths,
      mitigation_ref,
    });

    incidents.push({
      incident_id,
      description: fields.description,
      affected_paths: fields.affected_paths,
      mitigation_ref,
      mitigation_kind,
      lessons_learned: fields.lessons_learned,
      classification: fields.classification,
      compliance_tags: fields.compliance_tags,
      commit_sha: fields.commit_sha,
      source_fingerprint,
    });
  }

  return { incidents, threatModel, warnings };
}

/**
 * Field labels are case-insensitive, order-independent bold markers
 * (`**Label**:`). Only RECOGNISED labels delimit a field — unknown bold-prefix
 * paragraphs become part of the surrounding field's body, never boundaries.
 */
function extractFields(body) {
  const fields = {
    description: null,
    affected_paths: [],
    mitigation: null,
    lessons_learned: null,
    classification: null,
    compliance_tags: [],
    commit_sha: null,
  };
  const FIELD_ALT =
    '(?:Description|Affected\\s+paths?|Mitigation(?:\\s+ref)?|Lessons(?:\\s+learned)?' +
    '|Classification|Compliance(?:\\s+tags?)?|Commit(?:\\s+sha)?)';
  const labelRe = new RegExp(
    `^\\s*\\*\\*\\s*(${FIELD_ALT})\\s*\\*\\*\\s*:\\s*([\\s\\S]*?)` +
    `(?=^\\s*\\*\\*\\s*${FIELD_ALT}\\s*\\*\\*\\s*:|$(?![\\r\\n]))`,
    'gmi',
  );
  let m;
  while ((m = labelRe.exec(body)) !== null) {
    const label = m[1].toLowerCase().replace(/\s+/g, ' ').trim();
    const value = m[2].trim();
    if (!value) continue;
    switch (label) {
      case 'description':
        fields.description = value;
        break;
      case 'affected paths':
      case 'affected path':
        fields.affected_paths = parseList(value);
        break;
      case 'mitigation':
      case 'mitigation ref':
        fields.mitigation = unwrapBackticks(value);
        break;
      case 'lessons learned':
      case 'lessons':
        fields.lessons_learned = value;
        break;
      case 'classification':
        fields.classification = unwrapBackticks(value).toUpperCase();
        break;
      case 'compliance tags':
      case 'compliance tag':
      case 'compliance':
        fields.compliance_tags = parseList(value);
        break;
      case 'commit':
      case 'commit sha':
        fields.commit_sha = unwrapBackticks(value) || null;
        break;
      default:
        // unknown labels ignored silently
    }
  }
  return fields;
}

/**
 * List value: bulleted, newline-separated, or comma-separated. Backtick-wrapped
 * entries are unwrapped. (A description after a list never leaks in because the
 * value is already bounded by the next field label.)
 *
 * Known limitation: a single path/tag value containing a literal comma is split
 * into two. Paths with commas are vanishingly rare; prefer a bulleted or
 * one-per-line list if a value must contain a comma.
 */
function parseList(raw) {
  const bulleted = raw.match(/^\s*[-*]\s+.+/gm);
  let parts;
  if (bulleted && bulleted.length > 0) {
    parts = bulleted.map(s => s.replace(/^\s*[-*]\s+/, ''));
  } else {
    parts = raw.split(/[\n,]+/);
  }
  return parts.map(p => unwrapBackticks(p.trim())).filter(p => p.length > 0);
}

function unwrapBackticks(s) {
  return s.trim().replace(/^`(.+)`$/, '$1').trim();
}

function deriveMitigationKind(mitigation_ref) {
  if (!mitigation_ref || mitigation_ref.toLowerCase() === 'manual') return 'manual';
  if (SEMGREP_REF_RE.test(mitigation_ref)) return 'semgrep';
  return 'file-ref';
}

function computeFingerprint({ description, lessons_learned, affected_paths, mitigation_ref }) {
  const normalised = [
    description || '',
    lessons_learned || '',
    (affected_paths || []).slice().sort().join('\n'),
    mitigation_ref || '',
  ].join(' ');
  return crypto.createHash('sha256').update(normalised).digest('hex').slice(0, 16);
}

/** Drop HTML comment markers (e.g. <!-- threat-model:end -->) from a span. */
function stripMarkerComments(s) {
  return s.replace(/<!--[\s\S]*?-->/g, '');
}

function lineOfOffset(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}
