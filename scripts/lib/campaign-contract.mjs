/**
 * @fileoverview The campaign contract: the ONE list of `/plan --campaign` sections and
 * required fields, and the presence check `/audit-plan` runs over a campaign plan.
 *
 * Presence, not adequacy. The check proves a plan DECLARES a dress rehearsal, a
 * canary, a pinned revision and the rest; it cannot prove any of them ran. The
 * `--closeout` mode closes part of that gap: every evidence path the plan named must
 * be a committed, non-empty regular file at an immutable revision — "done" without its
 * artifact cannot close (E5 ledger B1, B15). Whether the artifact SHOWS a passing
 * rehearsal stays a reviewer judgement.
 *
 * `skills/plan/references/campaign.md` documents the same sections and fields; a test
 * compares the two in both directions.
 *
 * Plan: docs/plans/test-campaign-controls.md §2.4, back-test §6.
 *
 * @module scripts/lib/campaign-contract
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const CONTRACT_HEADING = '## Campaign Contract';
export const MODE_LINE_RE = /^-\s*\*\*Mode\*\*:\s*campaign\b/im;
export const MIN_REHEARSAL_ITEMS = 5;

/** id → { title, fields }. Order is the contract's order. */
export const CAMPAIGN_SECTIONS = Object.freeze({
  C1: { title: 'Decision and metric', fields: ['decision', 'metric', 'error-costs'] },
  C2: { title: 'Split, leakage and sealed test custody', fields: ['split', 'test-set-hash', 'access-record'] },
  C3: { title: 'Feasibility and power', fields: ['bound', 'assumptions'] },
  C4: { title: 'Instrument and controls', fields: ['controls', 'independence'] },
  C5: { title: 'Declared telemetry', fields: ['telemetry', 'fill-check'] },
  C6: { title: 'Operations', fields: ['revision', 'model', 'spend-limit', 'heartbeat'] },
  C7: { title: 'Dress rehearsal', fields: ['items', 'evidence'] },
  C8: { title: 'In-run canary', fields: ['canary', 'evidence'] },
  C9: { title: 'Contract epoch', fields: ['contract-epoch'] },
  C10: { title: 'Deviations', fields: ['ledger'] },
  C11: { title: 'Done means artifact', fields: ['done-evidence'] },
  C12: { title: 'Close-out claims check', fields: ['claims-check'] },
});

/** Fields whose value is a repo-relative evidence path (or, for done-evidence, a comma list). */
export const EVIDENCE_FIELDS = Object.freeze(['evidence', 'done-evidence']);

const SECTION_RE = /^###\s+(C\d+)\b/;
const FIELD_RE = /^\s*-\s*\*\*([a-z][a-z0-9-]*)\*\*\s*:\s*(.*)$/;

export function isCampaignPlan(markdown) {
  return MODE_LINE_RE.test(String(markdown ?? ''));
}

/** Split the `## Campaign Contract` section into `### C<n>` items with their fields. */
export function parseCampaignContract(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().startsWith(CONTRACT_HEADING));
  if (start < 0) return { found: false, sections: [] };
  const sections = [];
  let cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^##\s/.test(l)) break; // next H2 ends the contract
    const s = l.match(SECTION_RE);
    if (s) { cur = { id: s[1], fields: {} }; sections.push(cur); continue; }
    if (!cur) continue;
    const f = l.match(FIELD_RE);
    if (f && !(f[1] in cur.fields)) cur.fields[f[1]] = f[2].trim();
  }
  return { found: true, sections };
}

function isEmptyValue(v) {
  const t = String(v ?? '').trim().replace(/^`|`$/g, '').trim();
  return t === '' || /^(tbd|todo|n\/a|-|\?)$/i.test(t);
}

/**
 * Split an evidence value into paths (backticks stripped, comma-separated), each canonicalised the way git names
 * a tree entry — forward slashes, no `./` segments, no duplicate or trailing separators — so the presence check
 * and the close-out tree lookup compare the same string.
 */
export function evidencePaths(value) {
  return String(value ?? '').split(',').map((s) => s.trim().replace(/^`|`$/g, '').trim()).filter(Boolean).map(canonicalEvidencePath);
}

function canonicalEvidencePath(p) {
  const fwd = p.replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(fwd) || fwd.startsWith('/')) return fwd; // left as-is: containment rejects it
  const norm = path.posix.normalize(fwd);
  return norm.endsWith('/') && norm.length > 1 ? norm : norm.replace(/^\.\//, '');
}

/** Is `p` a repo-relative path that stays inside `repoRoot`? */
export function isContainedRelativePath(p, repoRoot = process.cwd()) {
  if (!p || path.isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.startsWith('\\') || p.startsWith('/')) return false;
  if (p.split(/[\\/]/).includes('..')) return false;
  const root = path.resolve(repoRoot);
  const abs = path.resolve(root, p);
  return abs === root ? false : abs.startsWith(root + path.sep);
}

/**
 * The presence check.
 * @returns {{ok:boolean, problems:Array<{id:string, field?:string, why:string}>}}
 */
export function checkCampaignContract(markdown, { repoRoot = process.cwd() } = {}) {
  const problems = [];
  const parsed = parseCampaignContract(markdown);
  if (!parsed.found) return { ok: false, problems: [{ id: 'contract', why: `no "${CONTRACT_HEADING}" section` }] };
  const seen = new Map();
  for (const s of parsed.sections) {
    if (seen.has(s.id)) problems.push({ id: s.id, why: 'duplicate section' });
    else seen.set(s.id, s);
  }
  for (const [id, spec] of Object.entries(CAMPAIGN_SECTIONS)) {
    const s = seen.get(id);
    if (!s) { problems.push({ id, why: `missing section "### ${id} — ${spec.title}"` }); continue; }
    for (const field of spec.fields) {
      const v = s.fields[field];
      if (v === undefined || isEmptyValue(v)) { problems.push({ id, field, why: `missing or empty "- **${field}**:"` }); continue; }
      if (id === 'C3' && field === 'bound' && !/\d/.test(v)) problems.push({ id, field, why: 'bound states no number' });
      if (id === 'C7' && field === 'items') {
        const n = /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;
        if (!Number.isInteger(n) || n < MIN_REHEARSAL_ITEMS) problems.push({ id, field, why: `items must be an integer >= ${MIN_REHEARSAL_ITEMS}, got "${v}"` });
      }
      if (EVIDENCE_FIELDS.includes(field)) {
        if (evidencePaths(v).length === 0) problems.push({ id, field, why: `"${v}" names no evidence path` });
        // A literal `..` is refused BEFORE canonicalisation: the record should name the artifact, not a route to it.
        if (String(v).split(/[,\\/]/).some((seg) => seg.trim().replace(/^`|`$/g, '') === '..')) {
          problems.push({ id, field, why: `"${v}" contains a ".." segment — name the path directly` });
          continue;
        }
        for (const p of evidencePaths(v)) {
          if (!isContainedRelativePath(p, repoRoot)) problems.push({ id, field, why: `"${p}" is not a repo-relative path inside the repo` });
        }
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 256 * 1024 * 1024 });
}

/**
 * Close-out: every evidence path must be a committed, non-empty REGULAR file at `rev`.
 * @returns {{ok:boolean, oid:string|null, problems:object[], artifacts:Array<{id:string, field:string, path:string, sha256:string}>}}
 */
export function verifyEvidenceAtRevision(markdown, { repoRoot = process.cwd(), rev = 'origin/main' } = {}) {
  const problems = [];
  const artifacts = [];
  let oid;
  try { oid = git(['rev-parse', '--verify', `${rev}^{commit}`], repoRoot).toString('utf-8').trim(); } catch {
    return { ok: false, oid: null, problems: [{ id: 'closeout', why: `revision "${rev}" does not resolve to a commit` }], artifacts };
  }
  const parsed = parseCampaignContract(markdown);
  for (const s of parsed.sections) {
    for (const field of EVIDENCE_FIELDS) {
      for (const p of evidencePaths(s.fields[field])) {
        if (!isContainedRelativePath(p, repoRoot)) { problems.push({ id: s.id, field, why: `"${p}" is not a repo-relative path inside the repo — not verified` }); continue; }
        const rel = p.replace(/\\/g, '/');
        // A LITERAL pathspec (no glob/magic), --full-tree so the path is repo-root relative, and the returned path must
        // equal the requested one — never "the first entry ls-tree printed".
        let entries;
        try { entries = git(['ls-tree', '-z', '--full-tree', oid, '--', `:(literal)${rel}`], repoRoot).toString('utf-8'); } catch (err) {
          // git could not INSPECT the tree — never reported as "not committed", which would be a different claim.
          const why = String(err?.stderr ?? err?.message ?? '').trim().split('\n')[0];
          problems.push({ id: s.id, field, why: `git could not inspect "${rel}" at ${rev} (${why || 'ls-tree failed'}) — unverified, not absent` });
          continue;
        }
        const m = entries.split('\0').map((e) => e.match(/^(\d{6}) (\w+) ([0-9a-f]+)\t(.*)$/s)).find((x) => x && x[4] === rel);
        if (!m) { problems.push({ id: s.id, field, why: `"${rel}" is not committed at ${rev} (${oid.slice(0, 10)})` }); continue; }
        const [, mode, type, blob] = m; // m[4] is the path, already checked equal to rel
        if (type !== 'blob' || !['100644', '100755'].includes(mode)) {
          problems.push({ id: s.id, field, why: `"${rel}" at ${rev} is mode ${mode} ${type}, not a regular file (a symlink's blob is its link text)` });
          continue;
        }
        const content = git(['cat-file', 'blob', blob], repoRoot);
        if (content.length === 0) { problems.push({ id: s.id, field, why: `"${rel}" is empty at ${rev}` }); continue; }
        artifacts.push({ id: s.id, field, path: rel, sha256: crypto.createHash('sha256').update(content).digest('hex') });
      }
    }
  }
  return { ok: problems.length === 0, oid, problems, artifacts };
}
