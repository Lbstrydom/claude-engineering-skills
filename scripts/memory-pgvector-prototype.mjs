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
import { embedText, findingEmbeddingSpace } from './lib/embed-text.mjs';

export const KNOWN_FLAGS = Object.freeze([
  '--selfcheck-relocation', '--repo', '--thresholds', '--window-days', '--cap', '--no-embed', '--concurrency', '--clusters',
]);

const G = '\x1b[32m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';

function arg(argv, name, def) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; }

/** Embed a batch with bounded concurrency; returns [{finding_id, vec, model, dim, hash}]. */
async function embedFindings(rows, { space, concurrency }) {
  const out = [];
  let i = 0;
  async function worker() {
    while (i < rows.length) {
      const r = rows[i++];
      try {
        const { result } = await embedText(r.snap, { dim: space.dim, model: space.requestModel });
        // `provenanceId`, never the request model: under Azure the wire needs the
        // bare deployment while the STORED identity must be endpoint-qualified,
        // or the same alias on two resources reads as one vector space.
        out.push({ finding_id: r.id, vec: result, model: space.provenanceId, dim: space.dim, hash: r.hash });
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
  // The ONE vector space for this run: `requestModel` on the wire,
  // `provenanceId` persisted and compared. Both were `symbolIndexConfig.embedModel`
  // — the Gemini default — even when embedText routed to Azure.
  const space = findingEmbeddingSpace();

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
    // Freshness is (snapshot_hash, model, dim) — a row made in a DIFFERENT
    // space is stale no matter how fresh its text hash, and scoping the cache
    // check is what re-embeds it rather than leaving two spaces mixed forever.
    const { rows: have } = await pool.query(
      `SELECT finding_id, snapshot_hash FROM finding_embeddings
        WHERE finding_id = ANY($1::uuid[]) AND embedding_model = $2::text AND dimension = $3::int`,
      [withHash.map((r) => r.id), space.provenanceId, space.dim]);
    const haveMap = new Map(have.map((h) => [h.finding_id, h.snapshot_hash]));
    const todo = withHash.filter((r) => haveMap.get(r.id) !== r.hash);
    process.stderr.write(`  ${todo.length} to embed (${withHash.length - todo.length} cached), model=${space.provenanceId} dim=${space.dim}\n`);
    if (todo.length) {
      const embedded = await embedFindings(todo, { space, concurrency });
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
      WHERE f.id = ANY($1::uuid[]) AND e.embedding IS NOT NULL
        AND e.embedding_model = $2::text AND e.dimension = $3::int),
    pairs AS (
      SELECT similarity(a.snap, b.snap) AS trg, (1 - (a.embedding <=> b.embedding)) AS cos
      FROM pop a JOIN pop b ON a.id < b.id AND a.fp <> b.fp)
    SELECT count(*) AS total_pairs,
           count(*) FILTER (WHERE trg > 0.5) AS trigram_pairs
    FROM pairs`, [ids, space.provenanceId, space.dim]);

  console.log(`\n${B}Population (embedded, cross-fingerprint):${X} ${cmp.total_pairs} candidate pairs`);
  console.log(`  ${B}Trigram similar-pairs (>0.5):${X} ${cmp.trigram_pairs}   ${D}(this is the memory_health metric)${X}`);

  console.log(`\n${B}Cosine threshold${X}   ${B}semantic${X}   ${B}sem∧¬trg${X}   ${B}trg∧¬sem${X}   ${D}(sem∧¬trg = re-raises trigram misses)${X}`);
  for (const t of thresholds) {
    const { rows: [row] } = await pool.query(`
      WITH pop AS (
        SELECT f.id, LEFT(f.detail_snapshot,500) AS snap, f.finding_fingerprint AS fp, e.embedding
        FROM audit_findings f JOIN finding_embeddings e ON e.finding_id=f.id
        WHERE f.id = ANY($1::uuid[]) AND e.embedding IS NOT NULL
          AND e.embedding_model = $2::text AND e.dimension = $3::int),
      pairs AS (
        SELECT similarity(a.snap,b.snap) AS trg, (1-(a.embedding <=> b.embedding)) AS cos
        FROM pop a JOIN pop b ON a.id<b.id AND a.fp<>b.fp)
      SELECT count(*) FILTER (WHERE cos > $4) AS sem,
             count(*) FILTER (WHERE cos > $4 AND trg <= 0.5) AS sem_not_trg,
             count(*) FILTER (WHERE trg > 0.5 AND cos <= $4) AS trg_not_sem
      FROM pairs`, [ids, space.provenanceId, space.dim, t]);
    console.log(`  ${t.toFixed(2)}             ${String(row.sem).padStart(6)}     ${G}${String(row.sem_not_trg).padStart(6)}${X}     ${String(row.trg_not_sem).padStart(6)}`);
  }

  // 5. Concrete examples: same-issue re-raises that semantic catches but
  //    trigram misses (the whole point). Use the middle threshold.
  const midT = thresholds[Math.floor(thresholds.length / 2)] ?? 0.85;
  const { rows: examples } = await pool.query(`
    WITH pop AS (
      SELECT f.id, LEFT(f.detail_snapshot,500) AS snap, f.finding_fingerprint AS fp, f.primary_file, e.embedding
      FROM audit_findings f JOIN finding_embeddings e ON e.finding_id=f.id
      WHERE f.id = ANY($1::uuid[]) AND e.embedding IS NOT NULL
        AND e.embedding_model = $2::text AND e.dimension = $3::int)
    SELECT round((1-(a.embedding <=> b.embedding))::numeric,3) AS cos,
           round(similarity(a.snap,b.snap)::numeric,3) AS trg,
           (a.primary_file=b.primary_file) AS same_file,
           left(a.snap,95) AS a_snip, left(b.snap,95) AS b_snip
    FROM pop a JOIN pop b ON a.id<b.id AND a.fp<>b.fp
    WHERE (1-(a.embedding <=> b.embedding)) > $4 AND similarity(a.snap,b.snap) <= 0.5
    ORDER BY (1-(a.embedding <=> b.embedding)) DESC LIMIT 6`, [ids, space.provenanceId, space.dim, midT]);

  console.log(`\n${B}Examples — semantic caught, trigram missed${X} (cos>${midT}, trg≤0.5):`);
  if (examples.length === 0) console.log(`  ${D}none — trigram already covers the similar pairs at this threshold${X}`);
  for (const e of examples) {
    console.log(`  ${G}cos ${e.cos}${X} / trg ${e.trg} ${e.same_file ? '(same file)' : ''}`);
    console.log(`    A: ${e.a_snip}`);
    console.log(`    B: ${e.b_snip}`);
  }

  console.log(`\n${D}Read: a high "sem∧¬trg" count with genuine re-raise examples ⇒ pgvector recovers churn signal trigram misses ⇒ worth promoting. Near-zero ⇒ trigram is sufficient.${X}`);

  if (argv.includes('--clusters')) await reportClusters(pool, ids, midT, space);

  await pool.end();
}

/**
 * CLUSTERING pass — the question pairwise similarity cannot answer.
 *
 * The 2026-07-21 prototype measured PAIRS and shipped pairwise suppression. But
 * "are there many similar pairs?" and "do those pairs form COMMUNITIES?" are
 * different questions with different answers, and only the second one decides
 * whether a graph-shaped memory earns its keep. If the pairs are disjoint duos,
 * pairwise suppression already captures everything and a cluster layer adds
 * nothing. If they collapse into a few multi-finding communities, then N
 * findings are really one recurring issue and a cluster-aware memory can say so.
 *
 * Connected components over the similarity graph, deliberately — it is the
 * cheapest clustering that can answer the question, and its failure mode is
 * known and measurable rather than hidden: components CHAIN (A~B, B~C, A≁C all
 * at once), so a single component can span unrelated findings. That is why
 * cohesion is reported per component: `minCos` is the weakest pair inside it.
 * A component whose minCos sits far below the edge threshold is chained, not
 * coherent, and must not be read as one issue. Reporting it is the difference
 * between a prototype and a plausible-looking number.
 *
 * Measures, never writes — a prototype that mutates the store is a promotion.
 */
async function reportClusters(pool, ids, tau, space) {
  const { rows: edges } = await pool.query(`
    WITH pop AS (
      SELECT f.id, f.finding_fingerprint AS fp, e.embedding
      FROM audit_findings f JOIN finding_embeddings e ON e.finding_id = f.id
      WHERE f.id = ANY($1::uuid[]) AND e.embedding IS NOT NULL
        AND e.embedding_model = $2::text AND e.dimension = $3::int)
    SELECT a.id AS a, b.id AS b, (1 - (a.embedding <=> b.embedding)) AS cos
    FROM pop a JOIN pop b ON a.id < b.id AND a.fp <> b.fp
    WHERE (1 - (a.embedding <=> b.embedding)) > $4`, [ids, space.provenanceId, space.dim, tau]);

  // Union-find over the edge list.
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (x, y) => { for (const v of [x, y]) if (!parent.has(v)) parent.set(v, v); const rx = find(x), ry = find(y); if (rx !== ry) parent.set(rx, ry); };
  for (const e of edges) union(e.a, e.b);

  const members = new Map();
  for (const v of parent.keys()) {
    const r = find(v);
    if (!members.has(r)) members.set(r, []);
    members.get(r).push(v);
  }
  const comps = [...members.values()].filter((m) => m.length > 1).sort((p, q) => q.length - p.length);

  const clustered = comps.reduce((n, c) => n + c.length, 0);
  console.log(`\n${B}Clustering (connected components, cos > ${tau})${X}`);
  console.log(`  edges: ${edges.length}   components (size>1): ${comps.length}   findings in a component: ${clustered}`);
  if (comps.length === 0) {
    console.log(`  ${D}no multi-finding communities — pairwise suppression already covers this; a cluster layer would add nothing${X}`);
    return;
  }
  // Collapse ratio: what a cluster-aware memory would reduce these to.
  console.log(`  collapse: ${clustered} findings → ${comps.length} canonical issue(s)  ` +
    `${D}(${(clustered / comps.length).toFixed(2)} findings per issue)${X}`);
  const hist = new Map();
  for (const c of comps) hist.set(c.length, (hist.get(c.length) ?? 0) + 1);
  console.log(`  size histogram: ${[...hist.entries()].sort((p, q) => p[0] - q[0]).map(([s, n]) => `${s}x${n}`).join('  ')}`);

  // Cohesion + exemplars for the largest components.
  const edgeCos = new Map();
  for (const e of edges) edgeCos.set(`${e.a}|${e.b}`, Number(e.cos));
  console.log(`\n${B}Largest communities${X} ${D}(minCos = weakest pair inside; far below ${tau} ⇒ CHAINED, not one issue)${X}`);
  for (const c of comps.slice(0, 4)) {
    const { rows: snips } = await pool.query(
      'SELECT id, left(detail_snapshot, 88) AS s, primary_file FROM audit_findings WHERE id = ANY($1::uuid[])', [c]);
    let minCos = 1, present = 0;
    for (let i = 0; i < c.length; i++) {
      for (let j = i + 1; j < c.length; j++) {
        const v = edgeCos.get(`${c[i]}|${c[j]}`) ?? edgeCos.get(`${c[j]}|${c[i]}`);
        if (v === undefined) continue;
        present++; minCos = Math.min(minCos, v);
      }
    }
    const possible = (c.length * (c.length - 1)) / 2;
    const density = possible ? present / possible : 1;
    const chained = density < 1;
    console.log(`\n  ${B}${c.length} findings${X}  density ${(density * 100).toFixed(0)}% of pairs linked  ` +
      `minCos ${minCos.toFixed(3)}  ${chained ? `${Y}CHAINED — not all members are pairwise similar${X}` : `${G}fully connected${X}`}`);
    const files = new Set(snips.map((r) => r.primary_file).filter(Boolean));
    console.log(`    files: ${files.size === 1 ? [...files][0] : `${files.size} distinct`}`);
    for (const r of snips.slice(0, 4)) console.log(`    · ${r.s}`);
  }

  console.log(`\n${D}Read: high collapse ratio + fully-connected components ⇒ real recurring issues a cluster layer would name. ` +
    `Mostly 2-member components ⇒ pairwise suppression is already the whole win.${X}`);
}

main().catch((err) => {
  if (err?.code === 'ARGV_ERROR') { process.stderr.write(`memory-pgvector-prototype: ${err.message}\n`); process.exit(2); }
  process.stderr.write(`memory-pgvector-prototype: fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
