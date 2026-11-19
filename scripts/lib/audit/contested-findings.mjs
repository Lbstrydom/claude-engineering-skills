/**
 * @fileoverview Contested-finding verification (sashiko PR B, docs/plans/sashiko-audit-improvements.md §4).
 *
 * A finding the author or the auditor disputes is settled by a QUOTED LINE instead of a whole extra round. This module
 * holds the pure parts: which findings are contested (`selectContested`), the deterministic evidence pack behind ONE
 * acquisition boundary (`acquire`, `buildEvidencePack`), the code-checked eligibility rule (`validateVerdict`), the strict
 * artifact schema, and the one function that trusts or rejects an artifact (`validateVerifyItem`).
 *
 * A verdict is EVIDENCE FOR TRIAGE, never a ruling: nothing here writes the ledger or dismisses a finding.
 *
 * @module scripts/lib/audit/contested-findings
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { z } from 'zod';
import { canonicalJson, sha256 } from './call-record.mjs';
import { resolveAndClassify, formatSkipLog } from '../sensitive-paths.mjs';
import { redactSecrets, assertEgressSafe } from '../sensitive-egress-gate.mjs';
import { generateTopicId, populateFindingMetadata } from '../ledger.mjs';
import { parseResultPath } from '../finalize-outcomes.mjs';

export const VERIFY_SCHEMA_VERSION = 1;
export const MIN_QUOTE_CHARS = 12;
const SEVERITY_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const CODE_RADIUS = 40;
const GREP_MAX_HITS = 20;
// Per-item caps; their sum (below) is the per-finding pack cap, so a pack can never exceed it and the stored text is
// byte-reproducible from provenance alone.
const CAPS = { finding: 1500, code: 4500, grep: 3500, history: 4000, test: 2000 };
export const PACK_CAP_CHARS = 24000;
const MAX_CODE_ITEMS = 2;
const MAX_TEST_ITEMS = 2;
const GIT_TIMEOUT_MS = 20000;
const TEST_TIMEOUT_MS = 120000;
const TEST_GLOB = /(^|\/)(tests?|__tests__)\/|\.test\./;

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const nonWs = (s) => String(s ?? '').replace(/\s+/g, '').length;
const clip = (text, cap) => (text.length > cap ? `${text.slice(0, cap)}\n…[truncated]` : text);

// ── schemas ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The model's structured answer. Every field required (structured-output rule). */
export const VerdictModelSchema = z.object({
  verdict: z.enum(['confirmed', 'refuted', 'inconclusive']),
  evidenceRefs: z.array(z.string()),
  quote: z.string(),
  reason: z.string(),
  severityIfConfirmed: z.enum(['HIGH', 'MEDIUM', 'LOW']),
});

const Provenance = z.object({
  source: z.enum(['code', 'grep', 'history', 'test', 'finding']),
  path: z.string().optional(),
  range: z.tuple([z.number(), z.number()]).optional(),
  query: z.string().optional(),
  rev: z.string(),
  run: z.string().optional(),
}).strict();
const PackItem = z.object({ tag: z.string(), provenance: Provenance, text: z.string(), eligible: z.boolean(), dropped: z.number().optional() }).strict();
const Pack = z.array(PackItem);
const Source = z.object({ kind: z.literal('round-finding'), findingId: z.string(), topicId: z.string() }).strict();
const ContestKind = z.enum(['author-dispute', 'auditor-dispute', 'flip']);
const Family = z.object({ verifier: z.string(), finder: z.string(), selfFamily: z.boolean() }).strict();
const Severity = z.enum(['HIGH', 'MEDIUM', 'LOW']);
const head = { source: Source, contestKind: ContestKind };

const VerifiedItem = z.object({
  ...head, state: z.literal('verified'), verdict: z.enum(['confirmed', 'refuted']), label: z.literal('evidence-backed'),
  evidence: z.object({ refs: z.array(z.string()), quote: z.string(), pack: Pack, packHash: z.string() }).strict(),
  reason: z.string(), severityIfConfirmed: Severity, model: z.string(), family: Family,
}).strict();
const InconclusiveItem = z.object({
  ...head, state: z.literal('inconclusive'), verdict: z.literal('inconclusive'),
  evidence: z.object({ pack: Pack, packHash: z.string() }).strict(),
  reason: z.string(), model: z.string(), family: Family,
  demotedFrom: z.enum(['confirmed', 'refuted']).optional(), demotionRule: z.string().optional(),
}).strict();
const OverCapItem = z.object({ ...head, state: z.literal('over-cap'), rank: z.number().int().positive() }).strict();
const FailedItem = z.object({
  ...head, state: z.literal('failed'),
  failure: z.object({ stage: z.enum(['acquire', 'call']), category: z.string() }).strict(),
  evidence: z.object({ pack: Pack, packHash: z.string() }).strict().optional(),
}).strict();
export const VerifyItemSchema = z.discriminatedUnion('state', [VerifiedItem, InconclusiveItem, OverCapItem, FailedItem]);

export const VerifyArtifactSchema = z.object({
  schemaVersion: z.literal(VERIFY_SCHEMA_VERSION),
  sid: z.string(), round: z.number().int().positive(),
  resultSha256: z.string(), auditedTree: z.string(), evidenceTree: z.string(), headSha: z.string(),
  complete: z.boolean(),
  counts: z.object({ verified: z.number(), inconclusive: z.number(), overCap: z.number(), failed: z.number() }).strict(),
  items: z.array(VerifyItemSchema),
  notSelected: z.array(z.object({ findingId: z.string().optional(), topicId: z.string().optional(), reason: z.string() }).strict()),
}).strict();

// ── selection ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function withTopic(f, passName = 'plan') {
  populateFindingMetadata(f, f._pass || passName);
  return generateTopicId(f);
}

/**
 * Which findings of the LATEST round are contested. Pure and deterministic.
 *
 * @param {{results: {round: number, result: {findings?: object[]}}[], ledger?: {entries?: object[]}, triage?: object,
 *   max?: number, shaByRound?: Record<number,string>, changedFiles?: (a: string, b: string) => string[]|null}} input
 * @returns {{selected: object[], overCap: object[], notSelected: object[]}}
 */
export function selectContested({ results, ledger = { entries: [] }, triage = {}, max = 10, shaByRound = {}, changedFiles = null }) {
  const rounds = [...results].sort((a, b) => a.round - b.round);
  const latest = rounds[rounds.length - 1];
  if (!latest) return { selected: [], overCap: [], notSelected: [] };
  const dismissed = new Set((ledger.entries ?? []).filter((e) => e.adjudicationOutcome === 'dismissed').map((e) => e.topicId));
  const byRound = new Map(rounds.map((r) => [r.round, new Map((r.result.findings ?? []).map((f) => [withTopic(f), f]))]));
  const notSelected = [];

  // Kind 3: a flip is DETECTED from history. It is claimed only when both rounds' shas are known and the files held still.
  const unchanged = (aRound, bRound, files) => {
    const a = shaByRound[aRound]; const b = shaByRound[bRound];
    if (!a || !b || typeof changedFiles !== 'function') return false;
    const changed = changedFiles(a, b);
    if (!Array.isArray(changed)) return false;
    const set = new Set(changed.map((p) => String(p).toLowerCase()));
    return (files ?? []).every((p) => !set.has(String(p).toLowerCase()));
  };
  const flips = new Set();
  const allTopics = new Set(rounds.flatMap((r) => [...byRound.get(r.round).keys()]));
  for (const topic of allTopics) {
    const seen = rounds.map((r) => ({ round: r.round, f: byRound.get(r.round).get(topic) }));
    for (let i = 0; i + 2 < seen.length; i++) {
      const [a, b, c] = [seen[i], seen[i + 1], seen[i + 2]];
      if (a.f && !b.f && c.f && unchanged(a.round, c.round, a.f.affectedFiles)) flips.add(topic);
    }
    for (let i = 0; i + 1 < seen.length; i++) {
      const [a, b] = [seen[i], seen[i + 1]];
      if (a.f && b.f && a.f.severity !== b.f.severity && unchanged(a.round, b.round, a.f.affectedFiles)) flips.add(topic);
    }
  }
  for (const topic of flips) {
    if (!byRound.get(latest.round).has(topic)) notSelected.push({ topicId: topic, reason: 'flip-not-present-in-latest-round' });
  }

  const candidates = [];
  // Iterate the round's findings, not the topic map: two findings may share a topicId and each is triaged by its own id.
  for (const f of latest.result.findings ?? []) {
    const topicId = withTopic(f);
    const t = triage[f.id];
    let contestKind = null;
    if (t && (t.validity === 'uncertain' || t.action === 'rebut')) contestKind = 'author-dispute';
    else if (dismissed.has(topicId) || (f._priorRuling?.topicId && dismissed.has(f._priorRuling.topicId))) contestKind = 'auditor-dispute';
    else if (flips.has(topicId)) contestKind = 'flip';
    if (!contestKind) continue;
    if (!(f.severity in SEVERITY_RANK) || f.severity === 'LOW') { notSelected.push({ findingId: f.id, topicId, reason: 'low-severity' }); continue; }
    const firstRound = rounds.find((r) => byRound.get(r.round).has(topicId))?.round ?? latest.round;
    candidates.push({ source: { kind: 'round-finding', findingId: f.id, topicId }, contestKind, severity: f.severity, firstRound, finding: f });
  }
  candidates.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.firstRound - b.firstRound || a.source.findingId.localeCompare(b.source.findingId));
  const cap = Math.max(0, max);
  return {
    selected: candidates.slice(0, cap),
    overCap: candidates.slice(cap).map((c, i) => ({ ...c, rank: i + 1 })),
    notSelected,
  };
}

// ── acquisition: ONE boundary per source ──────────────────────────────────────────────────────────────────────────────

function skipHash(p) {
  const lines = formatSkipLog([{ path: p, category: 'sensitive', pattern: 'verify' }], { debug: true, logger: 'verify' });
  const m = lines.map((l) => /\[redacted:([0-9a-f]+)\]/.exec(l)).find(Boolean);
  return m ? m[1] : 'unknown';
}

function gitOut(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The single exit for a source's text: redact, cap, egress-check. */
function finish(provenance, rawText, cap, { eligible = true, dropped } = {}) {
  const text = clip(redactSecrets(rawText), cap);
  const item = { provenance, text, eligible };
  if (dropped) item.dropped = dropped;
  return item;
}

/** A withheld item records the HASH of its path, never the path: the persisted artifact must not name a sensitive file. */
function withheld(provenance, p) {
  const hash = skipHash(p);
  return { provenance: { ...provenance, path: `withheld:${hash}` }, text: `[withheld: sensitive path ${hash}]`, eligible: false };
}

/** Is this path readable as evidence? Follows symlinks (INC-001); sensitive, escaping and unresolvable all withhold. */
function readable(p, repoRoot) {
  const c = resolveAndClassify(p, { repoRoot });
  return c.category === null && !c.escapedRepo && !c.resolutionFailed ? c : null;
}

function acquireCode(prov, ctx) {
  const c = readable(prov.path, ctx.repoRoot);
  if (!c) return withheld(prov, prov.path);
  const lines = fs.readFileSync(c.canonical, 'utf-8').split(/\r?\n/);
  const [lo, hi] = prov.range;
  return finish(prov, `// ${prov.path}:${lo}-${hi}\n${lines.slice(lo - 1, hi).join('\n')}`, CAPS.code);
}

function acquireGrep(prov, ctx) {
  let out = '';
  try { out = gitOut(ctx.repoRoot, ['grep', '-n', '-w', '-I', '-e', prov.query, '--']); } catch (e) {
    if (e.code === 'ENOBUFS' && typeof e.stdout === 'string') out = e.stdout; // a very common identifier: the cap keeps the first hits anyway
    else if (e.status !== 1) throw e;
  }
  const kept = []; let dropped = 0;
  for (const line of out.split('\n').filter(Boolean)) {
    const file = line.slice(0, line.indexOf(':'));
    if (!readable(file, ctx.repoRoot)) { dropped += 1; continue; }
    if (kept.length < GREP_MAX_HITS) kept.push(line);
  }
  return finish(prov, kept.join('\n'), CAPS.grep, { dropped });
}

function acquireHistory(prov, ctx) {
  if (!readable(prov.path, ctx.repoRoot)) return withheld(prov, prov.path);
  const [lo, hi] = prov.range;
  const parts = [];
  // Commit messages are dropped (format is the sha only). Always redacted: an old blob can hold a secret since removed.
  try { parts.push(gitOut(ctx.repoRoot, ['log', `-L${lo},${hi}:${prov.path}`, '--format=%H', prov.rev, '--'])); } catch { parts.push('[history unavailable]'); }
  try { parts.push(gitOut(ctx.repoRoot, ['blame', '-w', `-L${lo},${hi}`, prov.rev, '--', prov.path])); } catch { /* the log half stands alone */ }
  // Historical: it shows removed lines too, so it is context for the model, never quotable proof of what the code does now.
  return finish(prov, parts.join('\n'), CAPS.history, { eligible: false });
}

/** Rebuild one item from its provenance. The same function builds a pack and re-checks a stored one. */
export function acquire(prov, ctx) {
  if (prov.source === 'code') return acquireCode(prov, ctx);
  if (prov.source === 'grep') return acquireGrep(prov, ctx);
  if (prov.source === 'history') return acquireHistory(prov, ctx);
  throw new Error(`acquire: ${prov.source} is not re-acquirable`);
}

/** The finding's own text, as pack item E0. Never eligible: the finder's claim cannot prove itself. */
export function findingItem(f) {
  const text = [`id: ${f.id}`, `severity: ${f.severity}`, `category: ${f.category}`, `section: ${f.section}`, `detail: ${f.detail}`, `risk: ${f.risk ?? ''}`, `recommendation: ${f.recommendation ?? ''}`].join('\n');
  return finish({ source: 'finding', rev: 'finding' }, text, CAPS.finding, { eligible: false });
}

/** Run an operator-named, tracked test with a scrubbed env. Context for the model and triage, never quotable proof. */
export function runTestItem(testPath, ctx) {
  const prov = { source: 'test', path: testPath, rev: 'audited-tree', run: 'node --test' };
  const tracked = (() => { try { return gitOut(ctx.repoRoot, ['ls-files', '--error-unmatch', '--', testPath]).trim() !== ''; } catch { return false; } })();
  const inRepo = (() => { try { return readable(testPath, ctx.repoRoot) !== null; } catch { return false; } })();
  if (!tracked || !inRepo || !TEST_GLOB.test(testPath.replace(/\\/g, '/'))) return { error: `--run-test ${testPath}: must be a tracked file that matches the test glob` };
  const env = { PATH: process.env.PATH, NODE_ENV: 'test', AUDIT_DB_URL: '' }; // an empty DSN is the air-gap signal: the test cannot reach a store
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  if (process.env.HOME) env.HOME = process.env.HOME;
  const r = spawnSync(process.execPath, ['--test', testPath], { cwd: ctx.repoRoot, env, encoding: 'utf-8', timeout: TEST_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
  if (r.error || r.signal) return { error: `--run-test ${testPath}: the test did not finish (${r.error?.code ?? r.signal})` };
  const keep = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.split(/\r?\n/).filter((l) => /^\s*(not ok|# (tests|pass|fail)|error:|message:|expected:|actual:)/.test(l));
  return { item: finish(prov, keep.join('\n') || '[no TAP summary]', CAPS.test, { eligible: false }) };
}

/** Pull `path:line` hints, then backticked identifiers, out of a finding. */
function citedLocations(f) {
  const files = [...new Set([f._primaryFile, ...(f.affectedFiles ?? [])].filter((p) => typeof p === 'string' && p))].slice(0, MAX_CODE_ITEMS);
  const text = `${f.section ?? ''} ${f.detail ?? ''} ${f.recommendation ?? ''}`;
  const hint = /(?:line|lines|L|:)\s*(\d{1,6})\b/.exec(text);
  const idents = [...new Set([...text.matchAll(/`([A-Za-z_$][\w$]{3,})`/g)].map((m) => m[1]))].slice(0, 3);
  if (idents.length === 0) {
    const tail = /[—–:-]\s*([A-Za-z_$][\w$]{3,})\s*$/.exec(f.section ?? '');
    if (tail) idents.push(tail[1]);
  }
  return { files, line: hint ? Number(hint[1]) : null, idents };
}

function windowFor(file, loc, repoRoot) {
  const c = readable(file, repoRoot);
  if (!c) return [1, 1 + CODE_RADIUS * 2];
  const lines = fs.readFileSync(c.canonical, 'utf-8').split(/\r?\n/);
  let at = loc.line;
  if (!at) for (const id of loc.idents) { const i = lines.findIndex((l) => l.includes(id)); if (i >= 0) { at = i + 1; break; } }
  if (!at) return [1, Math.min(lines.length, CODE_RADIUS * 2)];
  return [Math.max(1, at - CODE_RADIUS), Math.min(Math.max(lines.length, 1), at + CODE_RADIUS)];
}

/**
 * The finding's evidence pack: E0 (the finding), cited code, an identifier grep, history of the cited range, and any
 * operator-named tests. Every source passes through `acquire`; the assembled pack passes `assertEgressSafe`.
 *
 * @returns {{pack: object[], packHash: string}}
 */
export function buildEvidencePack({ finding, repoRoot, headSha, testItems = [] }) {
  const ctx = { repoRoot, headSha };
  const loc = citedLocations(finding);
  const items = [findingItem(finding)];
  loc.files.forEach((file) => {
    const range = windowFor(file, loc, repoRoot);
    items.push(acquire({ source: 'code', path: file, range, rev: 'audited-tree' }, ctx));
  });
  if (loc.idents[0]) items.push(acquire({ source: 'grep', query: loc.idents[0], rev: 'audited-tree' }, ctx));
  if (loc.files[0]) {
    const range = windowFor(loc.files[0], loc, repoRoot);
    items.push(acquire({ source: 'history', path: loc.files[0], range, rev: headSha }, ctx));
  }
  // Run ONCE per invocation by the CLI (the operator named them), shared by every pack.
  items.push(...testItems.slice(0, MAX_TEST_ITEMS));
  const pack = items.map((it, i) => ({ tag: `E${i}`, ...it }));
  assertEgressSafe(pack, { label: 'contested-finding evidence pack' });
  const total = pack.reduce((n, it) => n + it.text.length, 0);
  if (total > PACK_CAP_CHARS) throw new Error(`evidence pack ${total} chars exceeds the ${PACK_CAP_CHARS} cap`);
  return { pack, packHash: sha256(canonicalJson(pack)) };
}

// ── verdict eligibility ───────────────────────────────────────────────────────────────────────────────────────────────

/** The part of an item that came from the repo: the synthetic code header and the truncation marker are ours, not evidence. */
function provableText(it) {
  let t = it.text.replace(/\n…\[truncated\]$/, '');
  if (it.provenance.source === 'code') t = t.replace(/^\/\/ [^\n]*\n/, '');
  // git grep prefixes every hit with `path:line:`; that prefix is ours, the text after it is the repo's.
  if (it.provenance.source === 'grep') t = t.split('\n').map((l) => l.replace(/^[^:\n]*:\d+:/, '')).join('\n');
  return t;
}

/**
 * Eligibility, not truth. A non-inconclusive verdict whose quote cannot be found in a cited ELIGIBLE item is demoted.
 * The pass label `evidence-backed` means the quote is there, nothing more.
 *
 * @returns {{verdict: string, backed: boolean, demotedFrom?: string, demotionRule?: string}}
 */
export function validateVerdict({ verdict, evidenceRefs, quote }, pack) {
  if (verdict === 'inconclusive') return { verdict, backed: false };
  const demote = (rule) => ({ verdict: 'inconclusive', backed: false, demotedFrom: verdict, demotionRule: rule });
  if (nonWs(quote) < MIN_QUOTE_CHARS) return demote('quote-too-short');
  const byTag = new Map(pack.map((it) => [it.tag, it]));
  const cited = [];
  for (const ref of evidenceRefs ?? []) {
    const it = byTag.get(ref);
    if (!it) return demote('unknown-ref');
    if (!it.eligible) return demote(it.provenance.source === 'test' ? 'test-only-quote' : 'ineligible-ref');
    cited.push(it);
  }
  if (cited.length === 0) return demote('no-ref');
  const q = norm(quote);
  if (cited.some((it) => norm(provableText(it)).includes(q))) return { verdict, backed: true };
  const e0 = pack.find((it) => it.provenance.source === 'finding');
  return demote(e0 && norm(e0.text).includes(q) ? 'quote-only-in-finding' : 'quote-not-in-evidence');
}

/** The verifier prompt. Sashiko's rule, both directions. */
export function verifierPrompt(finding, pack) {
  const system = [
    'You verify ONE code-audit finding against numbered evidence items. You decide nothing about the project; you report what the evidence shows.',
    'Answer `refuted` only with a quote, copied verbatim from a cited item, that shows the defect cannot occur.',
    'Answer `confirmed` only with a quote, copied verbatim from a cited item, that shows the defect does occur.',
    'An argument about intent, design or style, or a quote that does not settle the claim, is `inconclusive`.',
    'E0 is the finding itself: it is never proof. A quote must come from E1 or later. List the item tags you quote in evidenceRefs.',
  ].join('\n');
  const body = pack.map((it) => `### ${it.tag} (${it.provenance.source}${it.eligible ? '' : ', not citable'})\n${it.text}`).join('\n\n');
  const content = redactSecrets(`Finding ${finding.id} (${finding.severity}): ${finding.category}\n\n${body}`);
  assertEgressSafe(content, { label: 'contested-finding verifier prompt' });
  return { system, messages: [{ role: 'user', content }] };
}

// ── the one place an artifact is trusted ──────────────────────────────────────────────────────────────────────────────

/**
 * Trust or reject one item of a verify artifact. Fails on the first check that does not hold.
 *
 * @param {object} artifact
 * @param {string} findingId
 * @param {{repoRoot: string, resultPath: string, headSha?: string}} opts
 * @returns {{ok: boolean, reason?: string, item?: object}}
 */
export function checkArtifactIdentity(artifact, { resultPath }) {
  const parsed = VerifyArtifactSchema.safeParse(artifact);
  if (!parsed.success) return { ok: false, reason: `schema: ${parsed.error.issues[0]?.message ?? 'invalid'} at ${parsed.error.issues[0]?.path.join('.')}` };
  const a = parsed.data;
  const named = parseResultPath(resultPath);
  if (named.sid !== a.sid || named.round !== a.round) return { ok: false, reason: `sid/round mismatch: artifact is ${a.sid} r${a.round}, result is ${named.sid} r${named.round}` };
  let raw;
  try { raw = fs.readFileSync(path.resolve(resultPath)); } catch (e) { return { ok: false, reason: `cannot read result: ${e.message}` }; }
  if (sha256(raw) !== a.resultSha256) return { ok: false, reason: 'result file changed since verification (hash mismatch)' };
  return { ok: true, a, raw };
}

export function validateVerifyItem(artifact, findingId, { repoRoot, resultPath }) {
  const id = checkArtifactIdentity(artifact, { resultPath });
  if (!id.ok) return id;
  const { a, raw } = id;
  const findings = JSON.parse(raw.toString('utf-8')).findings ?? [];
  const finding = findings.find((f) => f.id === findingId);
  if (!finding) return { ok: false, reason: `finding ${findingId} is not in round ${a.round}` };
  const hits = a.items.filter((it) => it.source.findingId === findingId);
  if (hits.length === 0) return { ok: false, reason: `no verification item for ${findingId}` };
  if (hits.length > 1) return { ok: false, reason: `duplicate verification items for ${findingId}` };
  const item = hits[0];
  if (item.source.topicId !== withTopic(finding)) return { ok: false, reason: 'item topicId does not match the round finding' };
  if (item.state !== 'verified' && item.state !== 'inconclusive') return { ok: false, reason: `item is ${item.state}: it carries no verdict to rely on` };
  const { pack, packHash } = item.evidence;
  if (sha256(canonicalJson(pack)) !== packHash) return { ok: false, reason: 'packHash mismatch (pack edited or corrupted)' };

  // v1 checks the stored artifact only. Re-acquiring evidence from the repo (so a forged pack is caught) was cut: see the
  // plan's Implementation Log. Test output, history and the finding's own text can never be eligible proof.
  for (const it of pack) {
    if (['test', 'history', 'finding'].includes(it.provenance.source) && it.eligible !== false) return { ok: false, reason: `evidence ${it.tag} (${it.provenance.source}) cannot be eligible` };
  }
  if (item.state === 'verified') {
    const re = validateVerdict({ verdict: item.verdict, evidenceRefs: item.evidence.refs, quote: item.evidence.quote }, pack);
    if (!re.backed || re.verdict !== item.verdict) return { ok: false, reason: `stored verdict does not validate against its pack (${re.demotionRule ?? 'not backed'})` };
  }
  return { ok: true, item };
}


/** The `[verify: …]` line triage sees, for an item that passed `validateVerifyItem`. */
export function triageLine(findingId, item) {
  if (item.state === 'verified') {
    const ref = item.evidence.refs[0] ?? 'E?';
    return `${findingId} [verify: ${item.verdict} — ${ref} "${norm(item.evidence.quote).slice(0, 160)}" · evidence-backed${item.family.selfFamily ? ' · same-family' : ''}]`;
  }
  return `${findingId} [verify: inconclusive${item.demotedFrom ? ` (demoted from ${item.demotedFrom}: ${item.demotionRule})` : ''} → rebuttal]`;
}
