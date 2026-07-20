#!/usr/bin/env node
/**
 * @fileoverview Weekly review — produces a 3-section digest of the
 * adaptive-learning system's current state for one repo, posts it as a
 * sticky GitHub issue with label `learning-weekly-review`.
 *
 * The script runs PER consumer repo (not globally).  It MUST be given a
 * repo identity via `--repo <name>` flag or `LEARNING_REPO_NAME` env var;
 * without one it aborts to prevent cross-tenant data leakage in the issue
 * body.
 *
 * Sections (deterministic ordering, total cap 7 items):
 *   1. Awaiting triage — findings the auto-deferral classifier couldn't
 *                         confidently classify (cap 3, HIGH-first).
 *   2. No-brainer fix-now — recurring clusters that have hit the threshold
 *                            (3+ HIGH or 5+ MEDIUM occurrences) (cap 3).
 *   3. Stale deferrals — clusters with `last_seen` >30 days ago (cap 1).
 *
 * Each section shows overflow as `(...and N more — ...)`.
 *
 * CLI output contract:
 *   - Default: stdout is JSON (the digest object); markdown to stderr or --out
 *   - --format markdown: stdout is the markdown body
 *   - --dry-run: do not post to GitHub; emit JSON + markdown only
 *
 * Plan: docs/plans/adaptive-learning-phase-1-foundation.md §2 (weekly-review)
 *
 * @module scripts/learning/weekly-review
 */
import 'dotenv/config';
import {
  initLearningStore,
  isCloudEnabled,
  getRepoIdByName,
  readPendingTriageFindings,
  readNoBrainerRecommendations,
  readStaleClusters,
  readRecentFriction,
} from '../learning-store.mjs';
import { assertKnownFlags, ArgvError } from '../lib/cli-io.mjs';

// Every flag this CLI accepts. `--repo` and `--format` take a value; `--dry-run`
// is a boolean.
const KNOWN_FLAGS = ['--repo', '--format', '--dry-run'];

const TOTAL_CAP = 7;
// Section caps — when friction notes exist, they're prioritised (3 friction
// + 2 triage + 2 no-brainer + 0 stale = 7).  When no friction, fall back to
// the original Phase 1 split (3+3+1).
const SECTION_CAPS_DEFAULT  = { friction: 0, triage: 3, noBrainer: 3, stale: 1 };
const SECTION_CAPS_FRICTION = { friction: 3, triage: 2, noBrainer: 2, stale: 0 };
const STICKY_ISSUE_LABEL = 'learning-weekly-review';
const STICKY_MARKER = '<!-- audit-loop:learning-weekly-review -->';

// ── Severity ordering (single source — same expression as the SQL view) ────

function severityRank(severity) {
  if (severity === 'HIGH') return 0;
  if (severity === 'MEDIUM') return 1;
  if (severity === 'LOW') return 2;
  // Audit-fix M6: fail-safe ordering — unknown severities (e.g. typos,
  // future 'CRITICAL') sort to the TOP of the digest rather than the
  // bottom, so they get human attention instead of being silently buried.
  return -1;
}

/**
 * Escape characters that have markdown-control meaning so user-supplied
 * strings (titles, file paths, dismiss reasons, cluster labels) cannot
 * inject formatting or break the issue body's structure.  Conservative —
 * escapes a small set rather than HTML-escaping wholesale, since the
 * output is already inside markdown contexts.
 */
function mdEscape(s) {
  if (s == null) return '';
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Section builders ───────────────────────────────────────────────────────

function buildTriageSection(rows, cap) {
  const sorted = [...rows].sort((a, b) => {
    const r = severityRank(a.severity) - severityRank(b.severity);
    if (r !== 0) return r;
    return new Date(b.created_at) - new Date(a.created_at);
  });
  const shown = sorted.slice(0, cap);
  const overflow = Math.max(0, sorted.length - cap);
  return { items: shown, overflow, total: sorted.length };
}

function buildNoBrainerSection(rows, cap) {
  const sorted = [...rows].sort((a, b) => {
    if (b.occurrence_count !== a.occurrence_count) return b.occurrence_count - a.occurrence_count;
    return new Date(b.last_seen) - new Date(a.last_seen);
  });
  const shown = sorted.slice(0, cap);
  const overflow = Math.max(0, sorted.length - cap);
  return { items: shown, overflow, total: sorted.length };
}

function buildStaleSection(rows, cap) {
  const sorted = [...rows].sort((a, b) => new Date(a.last_seen) - new Date(b.last_seen));
  const shown = sorted.slice(0, cap);
  const overflow = Math.max(0, sorted.length - cap);
  return { items: shown, overflow, total: sorted.length };
}

/**
 * Friction notes — sorted by severity (blocker first), then created_at DESC.
 * v1 plan: friction-log-and-digest-v1.md.
 */
function buildFrictionSection(rows, cap) {
  const SEV_RANK = { blocker: 0, annoyance: 1, note: 2 };
  const sorted = [...rows].sort((a, b) => {
    const r = (SEV_RANK[a.severity] ?? 3) - (SEV_RANK[b.severity] ?? 3);
    if (r !== 0) return r;
    return new Date(b.created_at) - new Date(a.created_at);
  });
  const shown = sorted.slice(0, cap);
  const overflow = Math.max(0, sorted.length - cap);
  return { items: shown, overflow, total: sorted.length };
}

/**
 * Greedy fill: distribute the total cap across sections in priority
 * order.  When friction notes exist, they take precedence (3+2+2+0);
 * when absent, fall back to the original Phase 1 split (0+3+3+1).
 *
 * Order: friction > triage > noBrainer > stale.
 */
function applyTotalCap(sections) {
  const order = ['friction', 'triage', 'noBrainer', 'stale'];
  // Pick caps based on whether friction notes exist.
  const hasFriction = sections.friction && sections.friction.items.length > 0;
  const caps = hasFriction ? SECTION_CAPS_FRICTION : SECTION_CAPS_DEFAULT;
  let used = 0;
  const out = {};
  for (const k of order) {
    const cap = caps[k];
    const remaining = TOTAL_CAP - used;
    const allowed = Math.max(0, Math.min(cap, remaining));
    const src = sections[k] || { items: [], overflow: 0, total: 0 };
    out[k] = {
      items: src.items.slice(0, allowed),
      overflow: src.overflow + Math.max(0, src.items.length - allowed),
      total: src.total,
    };
    used += out[k].items.length;
  }
  return out;
}

// ── Markdown rendering ─────────────────────────────────────────────────────

function fmtTitle(s) {
  // Markdown-escape AFTER truncation so escape sequences don't get cut mid-pair.
  const trimmed = (s || '').replace(/\s+/g, ' ').slice(0, 120);
  return mdEscape(trimmed);
}

function fmtPath(p) {
  // Paths go inside backticks; escape only the backtick that would break the span.
  return (p || 'unknown').replace(/`/g, '\\`');
}

/**
 * Compact "Xd ago", "Xh ago", "just now" style for friction-note timestamps.
 * Pure given input; falls back to the raw ISO string on bad input.
 */
function humanizeAgo(iso, now = Date.now()) {
  if (!iso) return 'unknown';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diffMs = Math.max(0, now - t);
  const min = Math.floor(diffMs / 60000);
  if (min < 1)   return 'just now';
  if (min < 60)  return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24)   return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function renderMarkdown({ repoName, sections, generatedAt }) {
  const friction = sections.friction || { items: [], overflow: 0, total: 0 };
  const totalShown = friction.items.length
    + sections.triage.items.length
    + sections.noBrainer.items.length
    + sections.stale.items.length;
  if (totalShown === 0) {
    return `${STICKY_MARKER}\n\n## ${repoName} — Adaptive Learning Weekly Review\n\nAll quiet this week. No friction notes, no findings awaiting triage, no recurring no-brainers, no stale deferrals.\n\n_Generated: ${generatedAt}_\n`;
  }

  const lines = [
    STICKY_MARKER,
    '',
    `## ${repoName} — Adaptive Learning Weekly Review`,
    '',
    `_Generated: ${generatedAt}_`,
    '',
  ];

  // Section 0 — Friction notes (only when present; takes priority)
  if (friction.items.length > 0) {
    lines.push('### 1. Friction notes (last 7 days)');
    lines.push('');
    for (const note of friction.items) {
      const ago = humanizeAgo(note.created_at);
      const sev = mdEscape(note.severity || 'note');
      lines.push(`- **[${sev}]** ${ago} — ${mdEscape((note.message || '').slice(0, 200))}`);
    }
    if (friction.overflow > 0) {
      lines.push(`- _(...and ${friction.overflow} more — query \`friction_log\` directly via Supabase Studio for now)_`);
    }
    lines.push('');
  }

  // Section 1 — Awaiting triage
  lines.push(`### ${friction.items.length > 0 ? '2' : '1'}. Awaiting triage`);
  lines.push('');
  if (sections.triage.items.length === 0) {
    lines.push('_None._');
  } else {
    for (const row of sections.triage.items) {
      lines.push(`- **[${mdEscape(row.severity)}]** \`${fmtPath(row.primary_file)}\` — ${fmtTitle(row.title)}`);
      if (row.dismiss_reason) lines.push(`  > ${mdEscape(row.dismiss_reason)}`);
    }
    if (sections.triage.overflow > 0) {
      lines.push(`- _(...and ${sections.triage.overflow} more — see full list: \`npm run learning:stats\`)_`);
    }
  }
  lines.push('');

  // No-brainer fix-now — number shifts based on friction presence.
  lines.push(`### ${friction.items.length > 0 ? '3' : '2'}. No-brainer fix-now (recurring clusters)`);
  lines.push('');
  if (sections.noBrainer.items.length === 0) {
    lines.push('_None._');
  } else {
    for (const row of sections.noBrainer.items) {
      const severities = [...new Set(row.severity_history || [])].map(mdEscape).join(', ');
      const label = mdEscape(row.cluster_label || row.cluster_hash.slice(0, 16));
      lines.push(`- **${label}** — ${row.occurrence_count} occurrences (${severities})`);
      if (row.files_affected && row.files_affected.length > 0) {
        const files = row.files_affected.slice(0, 3).map(fmtPath).join(', ');
        lines.push(`  Files: \`${files}\`${row.files_affected.length > 3 ? ` _(+${row.files_affected.length - 3} more)_` : ''}`);
      }
    }
    if (sections.noBrainer.overflow > 0) {
      lines.push(`- _(...and ${sections.noBrainer.overflow} more — see full list: \`npm run learning:stats\`)_`);
    }
  }
  lines.push('');

  // Stale deferrals — number shifts based on friction presence.
  lines.push(`### ${friction.items.length > 0 ? '4' : '3'}. Stale deferrals (last_seen >30 days)`);
  lines.push('');
  if (sections.stale.items.length === 0) {
    lines.push('_None._');
  } else {
    for (const row of sections.stale.items) {
      const ageDays = Math.floor((Date.now() - new Date(row.last_seen)) / 86400000);
      const label = mdEscape(row.cluster_label || row.cluster_hash.slice(0, 16));
      lines.push(`- **${label}** — last seen ${ageDays} days ago, ${row.occurrence_count}× occurrences`);
    }
    if (sections.stale.overflow > 0) {
      lines.push(`- _(...and ${sections.stale.overflow} more — see full list: \`npm run learning:stats\`)_`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('_Auto-generated by `scripts/learning/weekly-review.mjs`. To suppress for one week, close this issue (it auto-reopens on next firing if findings persist)._');
  return lines.join('\n');
}

// ── GitHub posting ─────────────────────────────────────────────────────────

async function postOrUpdateStickyIssue({ markdown, dryRun }) {
  if (dryRun) return { ok: true, dryRun: true, posted: false };
  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPOSITORY; // owner/repo when run from Actions
  if (!token || !repo) {
    process.stderr.write('[weekly-review] GITHUB_TOKEN or GITHUB_REPOSITORY missing — skipping post\n');
    return { ok: true, dryRun: false, posted: false, reason: 'no-github-context' };
  }

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // Find existing sticky issue — search ALL states (audit-fix M14): a
  // user-closed sticky should be re-opened and updated rather than spawning
  // a fresh duplicate when findings persist.
  const search = await fetch(
    `https://api.github.com/repos/${repo}/issues?labels=${encodeURIComponent(STICKY_ISSUE_LABEL)}&state=all&per_page=50`,
    { headers }
  );
  if (!search.ok) {
    return { ok: false, posted: false, error: `search ${search.status}` };
  }
  const issues = await search.json();
  const existing = issues.find(i => i.body && i.body.includes(STICKY_MARKER));

  if (existing) {
    // Re-open if closed, then update body.
    const patchBody = existing.state === 'closed'
      ? { body: markdown, state: 'open' }
      : { body: markdown };
    const upd = await fetch(`https://api.github.com/repos/${repo}/issues/${existing.number}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(patchBody),
    });
    return {
      ok: upd.ok,
      posted: upd.ok,
      action: existing.state === 'closed' ? 'reopened' : 'updated',
      issueNumber: existing.number,
    };
  }

  const create = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Adaptive Learning — Weekly Review',
      body: markdown,
      labels: [STICKY_ISSUE_LABEL],
    }),
  });
  if (!create.ok) return { ok: false, posted: false, error: `create ${create.status}` };
  const created = await create.json();
  return { ok: true, posted: true, action: 'created', issueNumber: created.number };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * @param {object} [opts]
 * @param {string} [opts.repoName] — defaults to LEARNING_REPO_NAME env
 * @param {boolean} [opts.dryRun]
 * @param {'json'|'markdown'} [opts.format]
 * @returns {Promise<object>} — emit-shape result
 */
export async function runWeeklyReview(opts = {}) {
  const repoName = opts.repoName || process.env.LEARNING_REPO_NAME || null;
  if (!repoName) {
    return {
      ok: false,
      error: { code: 'BAD_INPUT', message: 'repoName required (LEARNING_REPO_NAME env or --repo flag)' },
    };
  }

  await initLearningStore();
  if (!await isCloudEnabled()) {
    return { ok: true, cloud: false, repoName, posted: false, reason: 'cloud-disabled' };
  }

  const repoId = await getRepoIdByName(repoName);
  if (!repoId) {
    return { ok: true, cloud: true, repoName, posted: false, reason: 'unknown-repo' };
  }

  const [triageRows, noBrainerRows, staleRows, frictionRows] = await Promise.all([
    readPendingTriageFindings({ repoId, limit: 1000 }),
    readNoBrainerRecommendations({ repoId, limit: 1000 }),
    readStaleClusters({ repoId, ageDays: 30, limit: 1000 }),
    readRecentFriction({ repoId, sinceMs: 7 * 24 * 60 * 60 * 1000, limit: 100 }),
  ]);

  const sections = applyTotalCap({
    friction:  buildFrictionSection(frictionRows, SECTION_CAPS_FRICTION.friction),
    triage:    buildTriageSection(triageRows, SECTION_CAPS_FRICTION.triage),
    noBrainer: buildNoBrainerSection(noBrainerRows, SECTION_CAPS_FRICTION.noBrainer),
    stale:     buildStaleSection(staleRows, SECTION_CAPS_DEFAULT.stale),
  });

  const totalShown = (sections.friction?.items.length || 0)
    + sections.triage.items.length
    + sections.noBrainer.items.length
    + sections.stale.items.length;
  const generatedAt = new Date().toISOString();
  const markdown = renderMarkdown({ repoName, sections, generatedAt });

  if (totalShown === 0 && opts.skipWhenEmpty !== false) {
    return { ok: true, cloud: true, repoName, posted: false, reason: 'all-quiet', sections, markdown };
  }

  const post = opts.dryRun
    ? { ok: true, posted: false, dryRun: true }
    : await postOrUpdateStickyIssue({ markdown, dryRun: false });

  return {
    ok: post.ok,
    cloud: true,
    repoName,
    repoId,
    sections: {
      friction:  { count: sections.friction?.items.length || 0, overflow: sections.friction?.overflow || 0, total: sections.friction?.total || 0 },
      triage:    { count: sections.triage.items.length,    overflow: sections.triage.overflow,    total: sections.triage.total },
      noBrainer: { count: sections.noBrainer.items.length, overflow: sections.noBrainer.overflow, total: sections.noBrainer.total },
      stale:     { count: sections.stale.items.length,     overflow: sections.stale.overflow,     total: sections.stale.total },
    },
    posted: !!post.posted,
    action: post.action,
    issueNumber: post.issueNumber,
    markdown: opts.format === 'markdown' ? markdown : undefined,
  };
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────

const isMain = import.meta.url === `file://${process.argv[1]}`
  || import.meta.url === `file:///${(process.argv[1] || '').replace(/\\/g, '/')}`;

if (isMain) {
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'weekly-review' });
  } catch (err) {
    if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') {
      process.stderr.write(err.message + '\n');
      process.exit(2);
    }
    throw err;
  }
  const args = process.argv.slice(2);
  const repoIdx = args.indexOf('--repo');
  const formatIdx = args.indexOf('--format');
  const dryRun = args.includes('--dry-run');
  const opts = {
    repoName: repoIdx >= 0 ? args[repoIdx + 1] : null,
    format:   formatIdx >= 0 ? args[formatIdx + 1] : 'json',
    dryRun,
  };
  const result = await runWeeklyReview(opts);

  if (opts.format === 'markdown' && result.markdown) {
    process.stdout.write(result.markdown + '\n');
  } else {
    // Default: stdout JSON; markdown (if present) goes to stderr for visibility.
    if (result.markdown) {
      process.stderr.write(result.markdown + '\n');
      // Don't include markdown in stdout JSON; it's a side channel.
      const { markdown, ...rest } = result;
      process.stdout.write(JSON.stringify(rest) + '\n');
    } else {
      process.stdout.write(JSON.stringify(result) + '\n');
    }
  }

  process.exit(result.ok ? 0 : 1);
}

export {
  renderMarkdown,
  applyTotalCap,
  severityRank,
  buildTriageSection,
  buildNoBrainerSection,
  buildStaleSection,
  buildFrictionSection,
  humanizeAgo,
};
