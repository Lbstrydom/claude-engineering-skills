#!/usr/bin/env node
/**
 * @fileoverview PROTOTYPE — evaluate pgvector semantic clustering as a
 * replacement/supplement for the memory_health trigram cluster-density metric.
 *
 * The decision rule (AGENTS.md "Memory-Health Gate"): cluster density fired
 * consistently → "prototype pgvector similarity first (cheapest win),
 * re-measure." This is that measurement.
 *
 * The question: does semantic similarity (cosine over VECTOR(768) embeddings of
 * `detail_snapshot`) catch same-meaning/different-wording finding re-raises that
 * trigram (pg_trgm) misses? Those are the churn the flat fingerprint-dedup
 * leaks. If YES, pgvector recovers signal and a follow-up promotes it to the
 * gate. If NO, trigram is sufficient and this stays a prototype.
 *
 * What it does (idempotent, cheap to re-run):
 *   1. Select the SAME open-finding population memory_health clusters over.
 *   2. Embed each `detail_snapshot` not already embedded (or changed) →
 *      finding_embeddings (Gemini, secret-redacted by embedText).
 *   3. Count cross-fingerprint SIMILAR PAIRS under trigram (>0.5) and under
 *      cosine (at several thresholds), over the identical population.
 *   4. Cross-tabulate: pairs semantic catches that trigram MISSES (the target
 *      signal), and vice versa. Print concrete examples of each.
 *
 * Usage:
 *   node scripts/memory-pgvector-prototype.mjs                 # current repo
 *   node scripts/memory-pgvector-prototype.mjs --repo <name>
 *   node scripts/memory-pgvector-prototype.mjs --thresholds 0.80,0.85,0.90
 *   node scripts/memory-pgvector-prototype.mjs --window-days 30 --cap 200
 *   node scripts/memory-pgvector-prototype.mjs --no-embed      # skip embedding, report on what's stored
 *
 * @module scripts/memory-pgvector-prototype
 */
import crypto from 'node:crypto';
import { assertKnownFlags } from './lib/cli-io.mjs';
import { getPool } from './lib/db/client.mjs';
import { isCloudEnabled, resolveRepoForStore } from './lib/store/repo.mjs';
import { initLearningStore } from './learning-store.mjs';
import { embedText } from './lib/embed-text.mjs';
import { symbolIndexConfig } from './lib/config.mjs';

export const KNOWN_FLAGS = Object.freeze([
  '--selfcheck-relocation', '--repo', '--thresholds', '--window-days', '--cap', '--no-embed', '--concurrency',
]);

const G = '\x1b[32m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';

function arg(argv, name, def) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; }

/** Embed a batch with bounded concurrency; returns [{finding_id, vec, model, dim, hash}]. */
async function embedFindings(rows, { model, dim, concurrency }) {
  const out = [];
  let i = 0;
  async function worker() {
    while (i < rows.length) {
      const r = rows[i++];
      try {
        const { result } = await embedText(r.snap, { dim, model });
        out.push({ finding_id: r.id, vec: result, model, dim, hash: r.hash });
      } catch (e) {
        process.stderr.write(`  [embed] ${r.id.slice(0, 8)} failed: ${e.message?.slice(0, 80)}\n`);
      }
      if (out.length % 25 === 0) process.stderr.write(`  embedded ${out.length}/${rows.length}\n`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  return out;
}

async function main() {
  const argv = process.argv;
  if (argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'memory-pgvector-prototype' });

  const windowDays = Number(arg(argv, '--window-days', '30'));
  const cap = Number(arg(argv, '--cap', '200'));
  const concurrency = Number(arg(argv, '--concurrency', '6'));
  const thresholds = String(arg(argv, '--thresholds', '0.80,0.85,0.90'))
    .split(',').map(Number).filter((n) => n > 0 && n < 1);
  const noEmbed = argv.includes('--no-embed');
  const model = symbolIndexConfig.embedModel;
  const dim = symbolIndexConfig.embedDim;

  await initLearningStore();
  if (!await isCloudEnabled()) { console.error('AUDIT_DB_URL unset — cloud store required'); process.exit(1); }
  const repoName = arg(argv, '--repo', null);
  const ref = repoName ? null : await resolveRepoForStore({});
  const pool = await getPool();

  // Resolve repo_id (by name if given, else current).
  let repoId = ref?.repoRowId;
  if (repoName) {
    const r = await pool.query('SELECT id FROM audit_repos WHERE name = $1', [repoName]);
    if (!r.rows[0]) { console.error(`repo not found: ${repoName}`); process.exit(1); }
    repoId = r.rows[0].id;
  }

  // 1. The SAME open-finding population memory_health clusters over (control
  //    markers excluded via the migration 20260720210000 sentinel; dismissed /
  //    fixed excluded; per-repo cap by recency).
  const { rows: open } = await pool.query(`
    WITH base AS (
      SELECT f.id, LEFT(f.detail_snapshot, 500) AS snap, f.finding_fingerprint AS fp, f.created_at,
             ROW_NUMBER() OVER (ORDER BY f.created_at DESC) AS rn
      FROM audit_findings f JOIN audit_runs r ON r.id = f.run_id
      WHERE r.repo_id = $1 AND f.created_at >= now() - ($2 || ' days')::interval
        AND f.detail_snapshot IS NOT NULL AND length(f.detail_snapshot) >= 30
        AND NOT starts_with(f.detail_snapshot, 'ADJACENCY_INCOMPLETE')
        AND NOT EXISTS (SELECT 1 FROM finding_adjudication_events ev
          WHERE ev.finding_id = f.id
            AND (ev.adjudication_outcome = 'dismissed' OR ev.remediation_state IN ('fixed','verified'))))
    SELECT id, snap, fp FROM base WHERE rn <= $3`,
    [repoId, windowDays, cap]);
  process.stderr.write(`${B}pgvector prototype${X} — ${open.length} open finding(s), window ${windowDays}d, cap ${cap}\n`);
  if (open.length < 2) { console.log('too few findings to cluster'); await pool.end(); process.exit(0); }

  // 2. Embed those not yet stored (or whose snapshot changed).
  const withHash = open.map((r) => ({ ...r, hash: crypto.createHash('sha256').update(r.snap).digest('hex').slice(0, 16) }));
  if (!noEmbed) {
    const { rows: have } = await pool.query(
      'SELECT finding_id, snapshot_hash FROM finding_embeddings WHERE finding_id = ANY($1::uuid[])',
      [withHash.map((r) => r.id)]);
    const haveMap = new Map(have.map((h) => [h.finding_id, h.snapshot_hash]));
    const todo = withHash.filter((r) => haveMap.get(r.id) !== r.hash);
    process.stderr.write(`  ${todo.length} to embed (${withHash.length - todo.length} cached), model=${model} dim=${dim}\n`);
    if (todo.length) {
      const embedded = await embedFindings(todo, { model, dim, concurrency });
      for (const e of embedded) {
        await pool.query(
          `INSERT INTO finding_embeddings (finding_id, embedding, embedding_model, dimension, snapshot_hash)
           VALUES ($1::uuid, $2::vector, $3, $4, $5)
           ON CONFLICT (finding_id) DO UPDATE SET embedding=EXCLUDED.embedding,
             embedding_model=EXCLUDED.embedding_model, dimension=EXCLUDED.dimension,
             snapshot_hash=EXCLUDED.snapshot_hash, created_at=now()`,
          [e.finding_id, `[${e.vec.join(',')}]`, e.model, e.dim, e.hash]);
      }
      process.stderr.write(`  stored ${embedded.length} embedding(s)\n`);
    }
  }

  // 3+4. Compare trigram vs cosine over the SAME population (only findings that
  //      now have an embedding, so the comparison is apples-to-apples).
  const ids = withHash.map((r) => r.id);
  const { rows: [cmp] } = await pool.query(`
    WITH pop AS (
      SELECT f.id, LEFT(f.detail_snapshot,500) AS snap, f.finding_fingerprint AS fp, e.embedding
      FROM audit_findings f JOIN finding_embeddings e ON e.finding_id = f.id
      WHERE f.id = ANY($1::uuid[]) AND e.embedding IS NOT NULL),
    pairs AS (
      SELECT similarity(a.snap, b.snap) AS trg, (1 - (a.embedding <=> b.embedding)) AS cos
      FROM pop a JOIN pop b ON a.id < b.id AND a.fp <> b.fp)
    SELECT count(*) AS total_pairs,
           count(*) FILTER (WHERE trg > 0.5) AS trigram_pairs
    FROM pairs`, [ids]);

  console.log(`\n${B}Population (embedded, cross-fingerprint):${X} ${cmp.total_pairs} candidate pairs`);
  console.log(`  ${B}Trigram similar-pairs (>0.5):${X} ${cmp.trigram_pairs}   ${D}(this is the memory_health metric)${X}`);

  console.log(`\n${B}Cosine threshold${X}   ${B}semantic${X}   ${B}sem∧¬trg${X}   ${B}trg∧¬sem${X}   ${D}(sem∧¬trg = re-raises trigram misses)${X}`);
  for (const t of thresholds) {
    const { rows: [row] } = await pool.query(`
      WITH pop AS (
        SELECT f.id, LEFT(f.detail_snapshot,500) AS snap, f.finding_fingerprint AS fp, e.embedding
        FROM audit_findings f JOIN finding_embeddings e ON e.finding_id=f.id
        WHERE f.id = ANY($1::uuid[]) AND e.embedding IS NOT NULL),
      pairs AS (
        SELECT similarity(a.snap,b.snap) AS trg, (1-(a.embedding <=> b.embedding)) AS cos
        FROM pop a JOIN pop b ON a.id<b.id AND a.fp<>b.fp)
      SELECT count(*) FILTER (WHERE cos > $2) AS sem,
             count(*) FILTER (WHERE cos > $2 AND trg <= 0.5) AS sem_not_trg,
             count(*) FILTER (WHERE trg > 0.5 AND cos <= $2) AS trg_not_sem
      FROM pairs`, [ids, t]);
    console.log(`  ${t.toFixed(2)}             ${String(row.sem).padStart(6)}     ${G}${String(row.sem_not_trg).padStart(6)}${X}     ${String(row.trg_not_sem).padStart(6)}`);
  }

  // 5. Concrete examples: same-issue re-raises that semantic catches but
  //    trigram misses (the whole point). Use the middle threshold.
  const midT = thresholds[Math.floor(thresholds.length / 2)] ?? 0.85;
  const { rows: examples } = await pool.query(`
    WITH pop AS (
      SELECT f.id, LEFT(f.detail_snapshot,500) AS snap, f.finding_fingerprint AS fp, f.primary_file, e.embedding
      FROM audit_findings f JOIN finding_embeddings e ON e.finding_id=f.id
      WHERE f.id = ANY($1::uuid[]) AND e.embedding IS NOT NULL)
    SELECT round((1-(a.embedding <=> b.embedding))::numeric,3) AS cos,
           round(similarity(a.snap,b.snap)::numeric,3) AS trg,
           (a.primary_file=b.primary_file) AS same_file,
           left(a.snap,95) AS a_snip, left(b.snap,95) AS b_snip
    FROM pop a JOIN pop b ON a.id<b.id AND a.fp<>b.fp
    WHERE (1-(a.embedding <=> b.embedding)) > $2 AND similarity(a.snap,b.snap) <= 0.5
    ORDER BY (1-(a.embedding <=> b.embedding)) DESC LIMIT 6`, [ids, midT]);

  console.log(`\n${B}Examples — semantic caught, trigram missed${X} (cos>${midT}, trg≤0.5):`);
  if (examples.length === 0) console.log(`  ${D}none — trigram already covers the similar pairs at this threshold${X}`);
  for (const e of examples) {
    console.log(`  ${G}cos ${e.cos}${X} / trg ${e.trg} ${e.same_file ? '(same file)' : ''}`);
    console.log(`    A: ${e.a_snip}`);
    console.log(`    B: ${e.b_snip}`);
  }

  console.log(`\n${D}Read: a high "sem∧¬trg" count with genuine re-raise examples ⇒ pgvector recovers churn signal trigram misses ⇒ worth promoting. Near-zero ⇒ trigram is sufficient.${X}`);
  await pool.end();
}

main().catch((err) => {
  if (err?.code === 'ARGV_ERROR') { process.stderr.write(`memory-pgvector-prototype: ${err.message}\n`); process.exit(2); }
  process.stderr.write(`memory-pgvector-prototype: fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
