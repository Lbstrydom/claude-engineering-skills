#!/usr/bin/env node
/**
 * @fileoverview /explain --history <topic> — "did we already solve this?"
 *
 * Cross-source aggregator that surfaces every past touch of a topic across
 * four independent sources, ranked chronologically:
 *
 *   1. git log search   — commit subjects/bodies (--grep) AND code introductions (-S)
 *   2. arch-memory      — neighbourhood query with the topic as intentDescription
 *   3. plan documents   — grep docs/plans/*.md for substring matches
 *   4. brainstorm ledger — scan .brainstorm/sessions/*.jsonl by topic + provider text
 *
 * Output: one consolidated JSON document (or pretty-printed Markdown via
 * the SKILL.md formatter). Pure aggregator — no LLM call, no writes.
 *
 * Usage:
 *   node scripts/explain-history.mjs --topic "<text>" [--since <date>] [--out <path>]
 *   node scripts/explain-history.mjs --topic "<text>" --paths "<csv>"  (narrows arch-memory)
 *
 * @module scripts/explain-history
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ArgvError } from './lib/cli-io.mjs';

const HELP_TEXT = `explain-history — "did we already solve this?" cross-source search

USAGE
  node scripts/explain-history.mjs --topic "<text>" [flags]

FLAGS
  --topic <text>     Topic / question to search for (required)
  --since <date>     Lower bound for git log (any git --since format, e.g. "3 months ago")
  --paths <csv>      Comma-separated file paths to focus arch-memory on
                     (default: scripts/, skills/, docs/)
  --limit <n>        Per-source result cap (default 10)
  --out <path>       Write JSON output to file (default: stdout)
  --skip-arch        Skip the arch-memory consultation (offline mode)
  --help             Show this message

OUTPUT
  Consolidated JSON: { topic, sources: {git, archMemory, plans, brainstorm},
                       chronological: [...], summary: "..." }
  Exit 0 = ran successfully (zero matches is a valid result).
  Exit 1 = argv error or fatal.
`;


function parseArgs(argv) {
  const args = { topic: null, since: null, paths: null, limit: 10, out: null, skipArch: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new ArgvError(`Flag ${a} requires a value`);
      return v;
    };
    switch (a) {
      case '--topic': args.topic = next(); break;
      case '--since': args.since = next(); break;
      case '--paths': args.paths = next().split(',').map(s => s.trim()).filter(Boolean); break;
      case '--limit': args.limit = Number(next()); break;
      case '--out': args.out = next(); break;
      case '--skip-arch': args.skipArch = true; break;
      case '--help':
      case '-h': args.help = true; break;
      default: throw new ArgvError(`Unknown flag: ${a}`);
    }
  }
  if (args.help) return args;
  if (!args.topic || args.topic.trim().length === 0) {
    throw new ArgvError('--topic is required');
  }
  if (!Number.isInteger(args.limit) || args.limit <= 0) {
    throw new ArgvError('--limit must be a positive integer');
  }
  return args;
}

// ── Source 1: git log search ──────────────────────────────────────────────
//
// Two passes:
//   (a) commit subject/body grep — matches "fix X", "added Y", "discussed Z"
//   (b) `git log -S` content search — matches commits that introduced/removed
//       a string in any file. Catches code touches that the message doesn't mention.
//
function gitLogSearch(topic, opts = {}) {
  const since = opts.since ? ['--since', opts.since] : [];
  const limit = String(opts.limit || 10);
  const matches = [];

  function tryGit(args) {
    try {
      return execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      if (err.status === 1) return '';   // git log: no matches
      throw err;
    }
  }

  // Pass A: subject/body grep
  const subjectOut = tryGit([
    'log', '--all', '-i', '--grep', topic,
    '--pretty=format:%H|%aI|%an|%s', '-n', limit, ...since,
  ]);
  for (const line of subjectOut.split('\n').filter(Boolean)) {
    const [sha, date, author, ...rest] = line.split('|');
    matches.push({
      source: 'git-subject',
      sha: sha?.slice(0, 8),
      date,
      author,
      subject: rest.join('|'),
    });
  }

  // Pass B: content search (-S). Use the topic verbatim as a literal.
  const contentOut = tryGit([
    'log', '--all', '-S', topic,
    '--pretty=format:%H|%aI|%an|%s', '-n', limit, ...since,
  ]);
  for (const line of contentOut.split('\n').filter(Boolean)) {
    const [sha, date, author, ...rest] = line.split('|');
    const sub = rest.join('|');
    // Skip duplicates — same SHA already present from pass A
    if (!matches.some(m => m.sha === sha?.slice(0, 8))) {
      matches.push({
        source: 'git-content',
        sha: sha?.slice(0, 8),
        date,
        author,
        subject: sub,
      });
    }
  }

  return matches.slice(0, opts.limit || 10);
}

// ── Source 2: arch-memory neighbourhood ───────────────────────────────────
//
// Reuses the existing cross-skill get-neighbourhood subcommand. Uses the
// topic as intentDescription. Reads the result and projects to a slim
// shape {symbolName, filePath, similarity, recommendation, purposeSummary}.
//
function archMemoryNeighbourhood(topic, opts = {}) {
  if (opts.skipArch) return { skipped: 'flag', records: [] };
  const paths = opts.paths || ['scripts/', 'skills/', 'docs/'];
  const payload = JSON.stringify({
    targetPaths: paths,
    intentDescription: topic,
    k: opts.limit || 10,
  });
  let raw;
  try {
    raw = execFileSync('node', ['scripts/cross-skill.mjs', 'get-neighbourhood', '--json', payload], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
  } catch (err) {
    return { skipped: `arch-memory call failed: ${err.code || err.message}`, records: [] };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { skipped: 'parse failed', records: [] }; }
  if (!parsed || parsed.cloud === false) {
    return { skipped: 'cloud disabled — run npm run arch:refresh', records: [] };
  }
  const records = (parsed.records || []).slice(0, opts.limit || 10).map(r => ({
    symbolName: r.symbolName,
    filePath: r.filePath,
    similarity: r.similarityScore || r.score,
    recommendation: r.recommendation,
    purposeSummary: (r.purposeSummary || '').slice(0, 200),
  }));
  return { records };
}

// ── Source 3: plan-document grep ──────────────────────────────────────────
//
// Lightweight grep over docs/plans/*.md (recursive). Matches whole-line
// occurrences, captures plan + heading context.
//
function planSearch(topic, opts = {}) {
  const dir = path.resolve('docs/plans');
  if (!fs.existsSync(dir)) return [];
  const files = walkMarkdown(dir);
  const matches = [];
  const needle = topic.toLowerCase();
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    let currentHeading = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) currentHeading = headingMatch[2].trim();
      if (line.toLowerCase().includes(needle)) {
        matches.push({
          source: 'plan',
          path: path.relative(process.cwd(), file).replace(/\\/g, '/'),
          line: i + 1,
          heading: currentHeading,
          excerpt: line.trim().slice(0, 200),
        });
        if (matches.length >= (opts.limit || 10)) break;
      }
    }
    if (matches.length >= (opts.limit || 10)) break;
  }
  return matches;
}

function walkMarkdown(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

// ── Source 4: brainstorm session ledger ───────────────────────────────────
//
// Scans .brainstorm/sessions/*.jsonl. Each line is a V2 envelope per
// scripts/lib/brainstorm/schemas.mjs. Match if (a) topic substring matches
// envelope.topic, OR (b) topic substring appears in any provider response
// text. Emit slim records {sid, round, capturedAt, topic, matchedIn}.
//
function brainstormSearch(topic, opts = {}) {
  const dir = path.resolve('.brainstorm/sessions');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && !f.endsWith('.quarantine.jsonl'));
  const needle = topic.toLowerCase();
  const matches = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      let parsed;
      try { parsed = JSON.parse(line); }
      catch { continue; }
      if (!parsed || typeof parsed !== 'object') continue;
      const topicHit = (parsed.topic || '').toLowerCase().includes(needle);
      let providerHit = false;
      let providerExcerpt = null;
      if (!topicHit && Array.isArray(parsed.providers)) {
        for (const p of parsed.providers) {
          const text = (p?.text || '').toLowerCase();
          if (text.includes(needle)) {
            providerHit = true;
            // Excerpt the matched neighbourhood (~120 chars centered on hit)
            const idx = text.indexOf(needle);
            const start = Math.max(0, idx - 50);
            providerExcerpt = (p.text || '').slice(start, start + 200);
            break;
          }
        }
      }
      if (topicHit || providerHit) {
        matches.push({
          source: 'brainstorm',
          sid: parsed.sid,
          round: parsed.round,
          capturedAt: parsed.capturedAt,
          topic: parsed.topic,
          matchedIn: topicHit ? 'topic' : 'provider-response',
          excerpt: providerExcerpt || (parsed.topic || '').slice(0, 200),
        });
        if (matches.length >= (opts.limit || 10)) break;
      }
    }
    if (matches.length >= (opts.limit || 10)) break;
  }
  return matches;
}

// ── Chronological merge ───────────────────────────────────────────────────
//
// Combine all dated touches into one timeline (most recent first). Plan
// matches don't have intrinsic dates; use git mtime of the plan file as a
// rough proxy so they slot in chronologically.
//
function buildChronological({ git, plans, brainstorm, planFileMtimes }) {
  const items = [];
  for (const g of git) items.push({ kind: 'git', date: g.date, summary: `${g.source}: ${g.subject}`, ref: g.sha, author: g.author });
  for (const b of brainstorm) items.push({ kind: 'brainstorm', date: b.capturedAt, summary: `${b.matchedIn === 'topic' ? 'topic' : 'response'}: ${(b.topic || '').slice(0, 80)}`, ref: `${b.sid}/round ${b.round}` });
  for (const p of plans) {
    const mtime = planFileMtimes[p.path];
    items.push({ kind: 'plan', date: mtime || null, summary: `${p.heading || '(no heading)'}: ${p.excerpt.slice(0, 80)}`, ref: `${p.path}:${p.line}` });
  }
  // Sort: dated items most-recent first; null-date items at the end
  return items.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return b.date.localeCompare(a.date);
  });
}

function planMtimeMap(plans) {
  const out = {};
  for (const p of plans) {
    if (out[p.path]) continue;
    try {
      const stat = fs.statSync(path.resolve(p.path));
      out[p.path] = new Date(stat.mtimeMs).toISOString();
    } catch { out[p.path] = null; }
  }
  return out;
}

function buildSummary({ topic, git, archRecords, plans, brainstorm }) {
  const counts = { git: git.length, archMemory: archRecords.length, plans: plans.length, brainstorm: brainstorm.length };
  const totalTouches = counts.git + counts.archMemory + counts.plans + counts.brainstorm;
  if (totalTouches === 0) {
    return `No prior touches of "${topic}" found across git history, arch-memory, plan documents, or brainstorm sessions. Topic appears to be new ground.`;
  }
  return `Found ${totalTouches} touches of "${topic}": ${counts.git} git commits, ${counts.archMemory} arch-memory matches, ${counts.plans} plan-document references, ${counts.brainstorm} brainstorm-session entries.`;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (err) {
    if (err.code === 'ARGV_ERROR') {
      process.stderr.write(`Error: ${err.message}\n\n${HELP_TEXT}`);
      process.exit(1);
    }
    throw err;
  }
  if (args.help) { process.stdout.write(HELP_TEXT); process.exit(0); }

  process.stderr.write(`  [explain-history] Searching for "${args.topic}"...\n`);

  const git = gitLogSearch(args.topic, { since: args.since, limit: args.limit });
  process.stderr.write(`  [explain-history] git: ${git.length} commit(s)\n`);

  const archResult = archMemoryNeighbourhood(args.topic, { paths: args.paths, limit: args.limit, skipArch: args.skipArch });
  process.stderr.write(`  [explain-history] arch-memory: ${archResult.records.length} record(s)${archResult.skipped ? ` (skipped: ${archResult.skipped})` : ''}\n`);

  const plans = planSearch(args.topic, { limit: args.limit });
  process.stderr.write(`  [explain-history] plans: ${plans.length} match(es)\n`);

  const brainstorm = brainstormSearch(args.topic, { limit: args.limit });
  process.stderr.write(`  [explain-history] brainstorm: ${brainstorm.length} session(s)\n`);

  const planFileMtimes = planMtimeMap(plans);
  const chronological = buildChronological({ git, plans, brainstorm, planFileMtimes });
  const summary = buildSummary({ topic: args.topic, git, archRecords: archResult.records, plans, brainstorm });

  const output = {
    topic: args.topic,
    sources: {
      git,
      archMemory: { records: archResult.records, skipped: archResult.skipped || null },
      plans,
      brainstorm,
    },
    chronological,
    summary,
    counts: {
      git: git.length,
      archMemory: archResult.records.length,
      plans: plans.length,
      brainstorm: brainstorm.length,
      total: git.length + archResult.records.length + plans.length + brainstorm.length,
    },
  };

  const json = JSON.stringify(output, null, 2);
  if (args.out) {
    fs.writeFileSync(args.out, json);
    process.stderr.write(`  [explain-history] Output: ${args.out}\n`);
  } else {
    process.stdout.write(json + '\n');
  }
  process.exit(0);
}

// Run main() only when invoked as a script, not when imported by tests.
// pathToFileURL match handles the Windows file:///C:/... vs unix /... differences.
import { pathToFileURL } from 'node:url';
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  main().catch(err => {
    process.stderr.write(`  [explain-history] FATAL: ${err.message}\n${err.stack || ''}\n`);
    process.exit(1);
  });
}

// Exports for tests (pure functions; main() is CLI-only)
export {
  parseArgs, gitLogSearch, planSearch, brainstormSearch,
  buildChronological, buildSummary, planMtimeMap, walkMarkdown,
};
