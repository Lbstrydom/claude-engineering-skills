#!/usr/bin/env node
/**
 * @fileoverview Semantic re-raise suppression — RETROSPECTIVE reconciler.
 *
 * The pgvector prototype (docs/research/pgvector-clustering-prototype.md) proved
 * the store accumulates duplicate OPEN findings: one real issue re-raised across
 * runs with different wording, each a fresh fingerprint the trigram/ledger
 * suppression misses. This collapses those duplicates: it embeds the open
 * findings, greedily clusters same-file cosine re-raises (`greedyReRaiseClusters`),
 * KEEPS the oldest (canonical) per cluster, and dismisses the reworded repeats
 * with a `semantic-duplicate` ruling.
 *
 * SAFE BY DEFAULT: dry-run unless `--apply`. Conservative threshold + same-file
 * (config `semanticSuppressConfig`). Never touches the canonical, never
 * suppresses a finding already dismissed/fixed, never crosses repos. Every
 * dismissal names the canonical it dedups to.
 *
 * This is the OFFLINE form of suppression — reversible, auditable, and the
 * validation vehicle for the prospective (record-time) hook, which reuses the
 * same core (`nearestOpenReRaise` + `decideReRaise`). That hook flips on only
 * after this reconciler's results are trusted — same "validate before default"
 * convention as the tiered pipeline.
 *
 * Usage:
 *   node scripts/semantic-suppress.mjs --repo <name>              # dry-run report
 *   node scripts/semantic-suppress.mjs --repo <name> --apply      # dismiss duplicates
 *   node scripts/semantic-suppress.mjs --repo <name> --threshold 0.94
 *   node scripts/semantic-suppress.mjs --repo <name> --window-days 30 --cap 400
 *   node scripts/semantic-suppress.mjs --repo <name> --order newest   # see CAP_ORDERS
 *
 * @module scripts/semantic-suppress
 */
import crypto from 'node:crypto';
import { assertKnownFlags } from './lib/cli-io.mjs';
import { getPool } from './lib/db/client.mjs';
import { isCloudEnabled } from './lib/store/repo.mjs';
import { initLearningStore, recordAdjudicationEvent } from './learning-store.mjs';
import { embedText } from './lib/embed-text.mjs';
import { symbolIndexConfig, semanticSuppressConfig } from './lib/config.mjs';
import { greedyReRaiseClusters, toVectorLiteral, buildOpenFindingsQuery, CAP_ORDERS } from './lib/semantic-suppression.mjs';

export const KNOWN_FLAGS = Object.freeze([
  '--selfcheck-relocation', '--repo', '--apply', '--threshold', '--window-days', '--cap', '--concurrency',
  '--order',
]);

// `--order` (default `oldest`) decides which end of the window the cap keeps.
// The rationale, and the measurement that motivated flipping the default, live
// with `buildOpenFindingsQuery` in lib/semantic-suppression.mjs.

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
const arg = (argv, n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

async function embedMissing(pool, rows, { model, dim, concurrency, log }) {
  const { rows: have } = await pool.query(
    'SELECT finding_id, snapshot_hash FROM finding_embeddings WHERE finding_id = ANY($1::uuid[])',
    [rows.map((r) => r.id)]);
  const haveHash = new Map(have.map((h) => [h.finding_id, h.snapshot_hash]));
  const todo = rows.filter((r) => haveHash.get(r.id) !== r.hash);
  if (!todo.length) { log(`  embeddings: all ${rows.length} cached`); return; }
  log(`  embeddings: ${todo.length} to embed (${rows.length - todo.length} cached)`);
  let i = 0, done = 0;
  async function worker() {
    while (i < todo.length) {
      const r = todo[i++];
      try {
        const { result } = await embedText(r.snap, { dim, model });
        await pool.query(
          `INSERT INTO finding_embeddings (finding_id, embedding, embedding_model, dimension, snapshot_hash)
           VALUES ($1::uuid,$2::vector,$3,$4,$5)
           ON CONFLICT (finding_id) DO UPDATE SET embedding=EXCLUDED.embedding,
             embedding_model=EXCLUDED.embedding_model, dimension=EXCLUDED.dimension,
             snapshot_hash=EXCLUDED.snapshot_hash, created_at=now()`,
          [r.id, toVectorLiteral(result), model, dim, r.hash]);
        done++;
      } catch (e) { log(`  [embed] ${r.id.slice(0, 8)} failed: ${e.message?.slice(0, 70)}`); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  log(`  embeddings: stored ${done}`);
}

async function main() {
  const argv = process.argv;
  if (argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'semantic-suppress' });

  const repoName = arg(argv, '--repo', null);
  if (!repoName) { console.error('--repo <name> is required'); process.exit(2); }
  const apply = argv.includes('--apply');
  const threshold = Number(arg(argv, '--threshold', String(semanticSuppressConfig.threshold)));
  const requireSameFile = semanticSuppressConfig.requireSameFile;
  const windowDays = Number(arg(argv, '--window-days', '30'));
  const cap = Number(arg(argv, '--cap', '400'));
  const order = arg(argv, '--order', 'oldest');
  if (!CAP_ORDERS.includes(order)) {
    console.error(`--order must be one of ${CAP_ORDERS.join('|')} (got "${order}")`);
    process.exit(2);
  }
  const concurrency = Number(arg(argv, '--concurrency', '6'));
  const model = symbolIndexConfig.embedModel, dim = symbolIndexConfig.embedDim;
  const log = (m) => process.stderr.write(m + '\n');

  await initLearningStore();
  if (!await isCloudEnabled()) { console.error('AUDIT_DB_URL unset — cloud store required'); process.exit(1); }
  const pool = await getPool();
  const rr = await pool.query('SELECT id FROM audit_repos WHERE name = $1', [repoName]);
  if (!rr.rows[0]) { console.error(`repo not found: ${repoName}`); process.exit(1); }
  const repoId = rr.rows[0].id;

  // Open findings (the population the memory-health metric counts). The query
  // lives in the pure module so its two load-bearing properties — an unbiased
  // cap, and a cap that reports what it dropped — are testable without a store.
  const { sql, params } = buildOpenFindingsQuery({ repoId, windowDays, cap, order });
  const { rows: open } = await pool.query(sql, params);
  const eligible = open.length > 0 ? Number(open[0].eligible) : 0;
  const notExamined = Math.max(0, eligible - open.length);
  log(`${B}semantic-suppress${X} — ${repoName}: ${open.length} open finding(s), τ=${threshold}, same-file=${requireSameFile}, ${apply ? R + 'APPLY' + X : Y + 'DRY-RUN' + X}`);
  log(`  window=${windowDays}d · eligible=${eligible} · examined=${open.length} (${order}-first)`
    + (notExamined > 0
      ? ` · ${Y}${notExamined} NOT examined${X} — raise --cap or re-run with --order ${order === 'oldest' ? 'newest' : 'oldest'}`
      : ` · ${G}full window covered${X}`));
  if (open.length < 2) { console.log('too few findings'); await pool.end(); process.exit(0); }

  const withHash = open.map((r) => ({ ...r, hash: crypto.createHash('sha256').update(r.snap).digest('hex').slice(0, 16) }));
  await embedMissing(pool, withHash, { model, dim, concurrency, log });

  // Load embeddings + cluster (pure).
  const { rows: embRows } = await pool.query(
    'SELECT finding_id, embedding::text AS vec FROM finding_embeddings WHERE finding_id = ANY($1::uuid[]) AND embedding IS NOT NULL',
    [withHash.map((r) => r.id)]);
  const vecOf = new Map(embRows.map((e) => [e.finding_id, e.vec.slice(1, -1).split(',').map(Number)]));
  const findings = withHash
    .filter((r) => vecOf.has(r.id))
    .map((r) => ({ id: r.id, primaryFile: r.primary_file, createdAt: r.created_at, embedding: vecOf.get(r.id), snap: r.snap }));

  const clusters = greedyReRaiseClusters(findings, { threshold, requireSameFile }).filter((c) => c.duplicates.length > 0);
  const totalDupes = clusters.reduce((n, c) => n + c.duplicates.length, 0);

  console.log(`\n${B}Semantic re-raise clusters:${X} ${clusters.length} (${totalDupes} duplicate finding(s) to suppress, keeping ${clusters.length} canonical)`);
  for (const c of clusters.slice(0, 12)) {
    console.log(`  ${G}canonical${X} ${c.canonical.id.slice(0, 8)} ${D}${c.canonical.primaryFile}${X}`);
    console.log(`    ${D}${c.canonical.snap.slice(0, 90)}${X}`);
    for (const d of c.duplicates) console.log(`    ${Y}└ dup${X} ${d.id.slice(0, 8)} ${D}${d.snap.slice(0, 80)}${X}`);
  }
  if (clusters.length > 12) console.log(`  ${D}… ${clusters.length - 12} more clusters${X}`);

  if (!apply) {
    console.log(`\n${Y}DRY-RUN${X} — no findings dismissed. Re-run with ${B}--apply${X} to suppress the ${totalDupes} duplicate(s).`);
    await pool.end(); process.exit(0);
  }

  // Apply: dismiss each duplicate, naming its canonical. Verify by re-count.
  let ok = 0;
  for (const c of clusters) {
    for (const d of c.duplicates) {
      const meta = await pool.query('SELECT run_id, finding_fingerprint, pass_name, round_raised FROM audit_findings WHERE id=$1', [d.id]);
      const m = meta.rows[0];
      if (!m) continue;
      await recordAdjudicationEvent(m.run_id, m.finding_fingerprint, {
        passName: m.pass_name, round: m.round_raised,
        adjudicationOutcome: 'dismissed', ruling: 'overrule', remediationState: 'pending',
        rulingRationale: `Semantic re-raise duplicate (cosine ≥ ${threshold}, same file) of open finding ${c.canonical.id}. Suppressed by scripts/semantic-suppress.mjs — the canonical finding remains open. The audit's own report is unaffected; only the duplicate learning-store row is removed.`,
      });
      ok++;
    }
  }
  // Verify against the store (best-effort recordAdjudicationEvent must not be trusted on its word).
  const dupIds = clusters.flatMap((c) => c.duplicates.map((d) => d.id));
  const { rows: [v] } = await pool.query(
    `SELECT count(*)::int total,
            (count(*) FILTER (WHERE EXISTS(SELECT 1 FROM finding_adjudication_events ev
              WHERE ev.finding_id=f.id AND ev.adjudication_outcome='dismissed')))::int AS dismissed
       FROM audit_findings f WHERE f.id = ANY($1::uuid[])`, [dupIds]);
  console.log(`\n${G}Applied${X}: ${v.dismissed}/${v.total} duplicates dismissed (verified against the store), ${clusters.length} canonical kept open.`);
  if (v.dismissed !== v.total) console.log(`  ${R}WARNING${X}: ${v.total - v.dismissed} write(s) did not land — re-run.`);
  await pool.end();
}

main().catch((err) => {
  if (err?.code === 'ARGV_ERROR') { process.stderr.write(`semantic-suppress: ${err.message}\n`); process.exit(2); }
  process.stderr.write(`semantic-suppress: fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
