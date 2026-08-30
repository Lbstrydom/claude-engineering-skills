/**
 * @fileoverview Cluster A / Phase 1 — the vector-space identity is ONE shared
 * resolver (the D2/H3/H8 fix). These are the regression tests for the bug that
 * made Azure architectural-memory unusable: vectors made by the Azure deployment
 * while a stale Gemini name was published as provenance, so every query threw
 * EMBEDDING_MISMATCH.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveEmbedProfile, azureProvenanceId, providerTag, findingEmbeddingSpace } from '../scripts/lib/embed-text.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

const AZURE = Object.freeze({
  active: true,
  openaiEndpoint: 'https://contoso-ai-dev.openai.azure.com',
  embedDeployment: 'text-embedding-3-large',
});
const AZURE_OTHER_ENDPOINT = Object.freeze({
  active: true,
  openaiEndpoint: 'https://other-resource.openai.azure.com',
  embedDeployment: 'text-embedding-3-large', // SAME alias, different resource
});
const INACTIVE = Object.freeze({ active: false, openaiEndpoint: null, embedDeployment: 'text-embedding-3-small' });

describe('resolveEmbedProfile — one shared identity', () => {
  test('Azure: requestModel is the bare deployment, provenanceId is endpoint-qualified', () => {
    const p = resolveEmbedProfile({ azure: AZURE });
    assert.equal(p.kind, 'azure-openai');
    assert.equal(p.requestModel, 'text-embedding-3-large', 'the API needs the bare deployment name');
    assert.equal(p.provenanceId, 'https://contoso-ai-dev.openai.azure.com::text-embedding-3-large');
  });

  test('public: requestModel and provenanceId are BOTH the caller-supplied concrete model', () => {
    const p = resolveEmbedProfile({ azure: INACTIVE, concreteModel: 'gemini-embedding-001' });
    assert.equal(p.kind, 'gemini');
    assert.equal(p.requestModel, 'gemini-embedding-001');
    assert.equal(p.provenanceId, 'gemini-embedding-001');
  });

  test('H3: off-Azure WITHOUT a concrete model throws — never silently re-defaults', () => {
    assert.throws(() => resolveEmbedProfile({ azure: INACTIVE }), /concreteModel is required/);
  });

  test('H3 regression: a NON-default public model is published as-is, not the library default', () => {
    // The exact bug shape H3 caught: refresh must publish the model that made the
    // vectors, not `symbolIndexConfig.embedModel`'s default.
    const p = resolveEmbedProfile({ azure: INACTIVE, concreteModel: 'text-embedding-005-custom' });
    assert.equal(p.provenanceId, 'text-embedding-005-custom');
  });
});

describe('azureProvenanceId — endpoint qualifies the identity (H8)', () => {
  test('normalizes the origin (lower-case, path/query stripped)', () => {
    assert.equal(
      azureProvenanceId({ openaiEndpoint: 'https://CONTOSO-AI-DEV.openai.azure.com/openai/', embedDeployment: 'e' }),
      'https://contoso-ai-dev.openai.azure.com::e',
    );
  });

  test('SAME deployment alias on a DIFFERENT endpoint yields a DIFFERENT identity', () => {
    // This is the whole point of H8: a bare name would compare equal and let an
    // incremental refresh silently mix two resources' vector spaces.
    assert.notEqual(
      resolveEmbedProfile({ azure: AZURE }).provenanceId,
      resolveEmbedProfile({ azure: AZURE_OTHER_ENDPOINT }).provenanceId,
    );
  });
});

describe('D2 regression: the production call sites actually use the shared resolver', () => {
  // A behavioural equality test here would be tautological (calling one function
  // twice). The D2 bug was a WIRING divergence — refresh published a value the
  // vectors weren't made with. So guard the wiring at the source, the same way
  // anthropic-client-migration.test.mjs guards its factory: if a call site stops
  // using resolveEmbedProfile / publishes the stale name again, THIS breaks.
  const refresh = src('scripts/symbol-index/refresh.mjs');
  const embed = src('scripts/symbol-index/embed.mjs');

  test('refresh.mjs imports and uses resolveEmbedProfile', () => {
    assert.match(refresh, /import\s*\{[^}]*resolveEmbedProfile[^}]*\}\s*from\s*['"][^'"]*embed-text/);
    assert.match(refresh, /resolveEmbedProfile\(/);
  });

  test('refresh.mjs publishes embedProfile.provenanceId — NOT the bare concreteEmbedModel (the D2 bug)', () => {
    // The publish call must carry provenanceId. A regression that reverts to
    // `activeEmbeddingModel: concreteEmbedModel` re-opens the unfixable loop.
    assert.match(refresh, /activeEmbeddingModel:\s*embedProfile\.provenanceId/);
    assert.doesNotMatch(refresh, /activeEmbeddingModel:\s*concreteEmbedModel\b/);
  });

  test('embed.mjs stores embedProfile.provenanceId as embeddingModel and requests with requestModel', () => {
    assert.match(embed, /import\s*\{[^}]*resolveEmbedProfile[^}]*\}\s*from\s*['"][^'"]*embed-text/);
    assert.match(embed, /embeddingModel:\s*provenanceId/);
    assert.match(embed, /embedBatch\([^,]+,\s*requestModel\)/);
  });

  test('refresh-incidents.mjs persists provenanceId and REQUESTS with requestModel', () => {
    // The third writer, and the one this hand-written list did not mention until
    // 2026-08-30 — found by the final reviewer, not by this suite. It resolved
    // `modelToUse = azureConfig.embedDeployment` itself, so under Azure the
    // security index stored a BARE deployment name while the arch index stored
    // the endpoint-qualified id: two provenance formats in one store, and a
    // deployment-name collision across two Azure resources reading as one
    // vector space.
    const inc = src('scripts/security-memory/refresh-incidents.mjs');
    assert.match(inc, /import\s*\{[^}]*resolveEmbedProfile[^}]*\}\s*from\s*['"][^'"]*embed-text/);
    assert.match(inc, /modelToUse\s*=\s*embedProfile\.provenanceId/);
    assert.match(inc, /generateEmbedding\([^,]+,\s*requestModel\b/,
      'the WIRE call must send requestModel — sending the endpoint-qualified id 404s');
    assert.doesNotMatch(inc, /modelToUse\s*=\s*azureConfig\.embedDeployment\b/,
      'reverted to resolving the deployment locally — the split-brain bug');
  });

  // ── the three finding_embeddings writers (promoted from EXEMPT 2026-08-30) ──
  //
  // COMPAT DECISION, recorded here because the deferral rested on the opposite
  // premise. The gap was left open on the belief that changing the stored string
  // would make old and new rows "stop comparing" inside semantic-suppress. It
  // would not: NOTHING read `finding_embeddings.embedding_model`. It was written
  // by three writers, read by no query, and the btree index on
  // `(embedding_model, dimension)` served nothing. Every similarity read —
  // `nearestOpenReRaise`, `getFindingEmbeddings`, the
  // `memory_health_semantic_cluster` RPC, and this prototype's own pair
  // queries — selected by finding_id and compared cosine across whatever models
  // happened to be present.
  //
  // So the hazard ran the OTHER way: vectors from two spaces were ALREADY being
  // compared, and the one column that could have detected it lied. And because
  // `resolveEmbedProfile` returns `provenanceId === concreteModel` off Azure,
  // the fix is a NO-OP on the stored string except under Azure, i.e. exactly
  // where it was already wrong and the rows need re-embedding anyway. No
  // backfill script, no column version, no dual-format transition: the
  // reconciler's freshness check now includes the space, so a stale-space row
  // is re-embedded in place on the next run.
  const runsFindings = src('scripts/lib/store/runs-findings.mjs');
  const suppress = src('scripts/semantic-suppress.mjs');
  const proto = src('scripts/memory-pgvector-prototype.mjs');
  const core = src('scripts/lib/semantic-suppression.mjs');

  for (const [rel, code] of [
    ['scripts/lib/store/runs-findings.mjs', runsFindings],
    ['scripts/semantic-suppress.mjs', suppress],
    ['scripts/memory-pgvector-prototype.mjs', proto],
  ]) {
    test(`${rel} resolves ONE space and never re-reads the Gemini default`, () => {
      assert.match(code, /import\s*\{[^}]*findingEmbeddingSpace[^}]*\}\s*from\s*['"][^'"]*embed-text/,
        'must resolve the space through the shared helper, not locally');
      assert.match(code, /findingEmbeddingSpace\(/);
      // The regression that re-opens the bug: reaching for the configured
      // Gemini default at an embed or persist site. Comments are stripped first
      // so the explanatory prose naming it does not satisfy its own guard.
      const codeOnly = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.doesNotMatch(codeOnly, /symbolIndexConfig\.embed(Model|Dim)\b/,
        'the space comes from findingEmbeddingSpace(), never from symbolIndexConfig directly');
    });

    test(`${rel} sends requestModel on the wire and persists provenanceId`, () => {
      // The pair is the whole point and the two halves are NOT interchangeable:
      // under Azure the API needs the bare deployment (the endpoint-qualified id
      // 404s) while the STORED identity must be endpoint-qualified (or the same
      // alias on two resources reads as one vector space).
      assert.match(code, /model:\s*space\.requestModel\b/,
        'the embedText call must send requestModel');
      assert.match(code, /space\.provenanceId\b/,
        'the persisted embedding_model must be provenanceId');
      // Scoped to the embedText CALL, not to any `model:` key — the prototype
      // legitimately carries `model: space.provenanceId` in the row accumulator
      // it later BINDS, which is the correct half of the pair.
      assert.doesNotMatch(code, /embedText\([^)]*model:\s*space\.provenanceId/,
        'sending the endpoint-qualified id to the provider 404s under Azure');
    });
  }

  test('every finding_embeddings INSERT binds provenanceId, never a request model', () => {
    // Source-level because the bug was a WIRING divergence: the value reached
    // the INSERT from a different resolution than the one that made the vector.
    for (const [rel, code] of [
      ['scripts/lib/store/runs-findings.mjs', runsFindings],
      ['scripts/semantic-suppress.mjs', suppress],
    ]) {
      assert.match(code, /INSERT INTO finding_embeddings/, `${rel} still writes the table`);
      assert.match(code, /space\.provenanceId,\s*space\.dim/,
        `${rel}: the INSERT must bind (provenanceId, dim) as the stored identity`);
    }
    // The prototype binds via its per-row accumulator, so assert the accumulator
    // is built from provenanceId rather than the request model.
    assert.match(proto, /vec:\s*result,\s*model:\s*space\.provenanceId/);
    assert.match(proto, /\[e\.finding_id,[\s\S]*?e\.model, e\.dim, e\.hash\]/);
  });

  test('the READ side scopes to one vector space — the half a string swap would miss', () => {
    // Making the provenance truthful is only half the fix. Before this, every
    // reader compared cosine across whatever models were present, which is not a
    // similarity — and at these thresholds it DISMISSES A REAL OPEN FINDING.
    assert.match(core, /AND e\.embedding_model = \$6::text/,
      'nearestOpenReRaise must filter to the caller-supplied space');
    assert.match(core, /AND e\.dimension = \$7::int/,
      'a space is (model, dim) — the dim is not implied');
    assert.match(core, /assertEmbeddingSpace\(embeddingSpace, 'nearestOpenReRaise'\)/,
      'an absent space must throw, not silently fall back to an unscoped query');
    assert.match(suppress, /embedding_model = \$2::text AND dimension = \$3::int/,
      'the reconciler cluster read must be space-scoped too');
  });

  test('BACKFILL: freshness is (snapshot_hash, model, dim) — this is what re-embeds stale-space rows', () => {
    // The compat strategy, mechanised. The cache check compared the text hash
    // ALONE, so a row made in another space counted as fresh and was never
    // re-embedded — two spaces mixed forever with no run able to clear it.
    // Scoping the check makes the reconciler self-healing, which is why no
    // offline backfill script exists.
    for (const [rel, code] of [['scripts/semantic-suppress.mjs', suppress], ['scripts/memory-pgvector-prototype.mjs', proto]]) {
      assert.match(code, /SELECT finding_id, snapshot_hash FROM finding_embeddings\s+WHERE finding_id = ANY\(\$1::uuid\[\]\) AND embedding_model = \$2::text AND dimension = \$3::int/,
        `${rel}: the freshness query must be scoped to the current space`);
    }
  });

  test('CENSUS 2: every finding_embeddings SIMILARITY READ is space-scoped', () => {
    // The writer census cannot see this class at all — these files never call
    // `embedText`, they only COMPARE what it produced. And the read side is
    // where the damage lands: an unscoped cosine dismisses a real open finding
    // or groups unrelated ones. Iterate the filesystem again, this time on the
    // table name, and require every file that selects `embedding` from it to
    // constrain `embedding_model`.
    const READERS = new Map();
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(abs);
      return e.isFile() && e.name.endsWith('.mjs') ? [abs] : [];
    });
    for (const abs of walk(path.join(repoRoot, 'scripts'))) {
      const code = readFileSync(abs, 'utf8');
      // A similarity read: pulls the vector column out of the table. A write
      // (INSERT/UPDATE) names the column too, so require a SELECT-ish read of
      // `embedding` alongside the table reference.
      if (!/FROM finding_embeddings|JOIN finding_embeddings/.test(code)) continue;
      if (!/\be\.embedding\b|embedding::text|\bembedding IS NOT NULL/.test(code)) continue;
      READERS.set(path.relative(repoRoot, abs).split(path.sep).join('/'), code);
    }
    assert.ok(READERS.size >= 4, `expected to find the known readers, found ${READERS.size}`);
    const unscoped = [...READERS].filter(([, code]) => !/embedding_model\s*=\s*\$\d+::text/.test(code)).map(([rel]) => rel);
    assert.deepEqual(unscoped, [],
      `these compare finding_embeddings vectors without constraining embedding_model: ${unscoped.join(', ')}. `
      + 'A cosine across two embedding models is not a similarity.');
  });

  test('DEFERRED, not silent: the memory-health RPC is the one unscoped reader left', () => {
    // Named here rather than left unmentioned. `memory_health_semantic_cluster`
    // joins finding_embeddings and counts cosine pairs with no model predicate,
    // so its cluster-density number can mix two spaces.
    //
    // Deferred on INDEPENDENCE, not on authorship: it is a metric, it suppresses
    // nothing, and nothing in this change calls it or depends on its output —
    // whereas every reader fixed above sits on a path that drops or groups a
    // store row. Fixing it means a new migration plus an expected-schema fixture
    // regen, which is a real scope boundary and not "the correct fix is bigger".
    //
    // This test exists so the gap cannot go quiet: it FAILS once the RPC gains
    // the predicate, at which point delete it rather than weaken it.
    const rpc = src('supabase/migrations/20260721140000_memory_health_semantic_cluster.sql');
    assert.match(rpc, /LEFT JOIN finding_embeddings e ON e\.finding_id = f\.id/);
    assert.doesNotMatch(rpc, /e\.embedding_model\s*=/,
      'the RPC is now space-scoped — remove this deferral test, the gap is closed');
  });

  test('CENSUS: every embedText writer is enumerated above — a fourth cannot hide', () => {
    // The defect was not that a call site was wrong; it was that this list was
    // written by hand and did not know the call site existed. Iterate the side
    // that can see a file nobody mentioned: the filesystem. AGENTS.md — "of any
    // set comparison ask which side am I iterating, and what is unrepresentable
    // from it".
    const NAMED = new Set([
      'scripts/symbol-index/refresh.mjs',
      'scripts/symbol-index/embed.mjs',
      'scripts/security-memory/refresh-incidents.mjs',
      // The three `finding_embeddings` writers, promoted from EXEMPT 2026-08-30.
      'scripts/lib/store/runs-findings.mjs',
      'scripts/semantic-suppress.mjs',
      'scripts/memory-pgvector-prototype.mjs',
    ]);
    // Every exemption carries its reason; an unreasoned one is how a list stops
    // being a census.
    const EXEMPT = new Map([
      ['scripts/lib/embed-text.mjs', 'the helper itself'],
      // QUERY side: embeds a search vector and persists no `embedding_model`, so
      // it publishes no provenance to diverge. It must still COMPARE against the
      // stored identity, which neighbourhood-query already does via its own guard.
      ['scripts/lib/audit/duplication-detector.mjs', 'query-side; persists no provenance'],
      ['scripts/lib/neighbourhood-query.mjs', 'query-side; persists no provenance'],
    ]);
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(abs);
      return e.isFile() && e.name.endsWith('.mjs') ? [abs] : [];
    });
    const callers = walk(path.join(repoRoot, 'scripts'))
      .filter((abs) => /\bembedText\s*\(/.test(readFileSync(abs, 'utf8')))
      .map((abs) => path.relative(repoRoot, abs).split(path.sep).join('/'))
      .filter((rel) => !EXEMPT.has(rel));
    const unknown = callers.filter((rel) => !NAMED.has(rel));
    assert.deepEqual(unknown, [],
      `these call embedText() but no provenance assertion above names them: ${unknown.join(', ')}. `
      + 'Add a per-caller test (and check it publishes provenanceId), or exempt it with a reason.');
  });

  test('MIRROR: no NAMED or EXEMPT entry has gone stale', () => {
    // The other direction. A file that is renamed away leaves its entry behind,
    // and the census then passes while silently covering nothing — the same
    // one-directional blindness that let refresh-incidents.mjs drift.
    for (const rel of [
      'scripts/symbol-index/refresh.mjs', 'scripts/symbol-index/embed.mjs',
      'scripts/security-memory/refresh-incidents.mjs', 'scripts/lib/embed-text.mjs',
      'scripts/lib/audit/duplication-detector.mjs', 'scripts/lib/neighbourhood-query.mjs',
      'scripts/lib/store/runs-findings.mjs', 'scripts/semantic-suppress.mjs',
      'scripts/memory-pgvector-prototype.mjs',
    ]) {
      assert.ok(fs.existsSync(path.join(repoRoot, rel)), `${rel} is listed but no longer exists — renamed?`);
    }
  });

  test('the resolved Azure provenance is never the stale Gemini default', () => {
    assert.notEqual(resolveEmbedProfile({ azure: AZURE }).provenanceId, 'gemini-embedding-001');
  });
});

describe('providerTag stays a bare display string (H9 — never persisted/compared)', () => {
  test('Azure display tag is unchanged (backward-compatible with existing callers)', () => {
    assert.equal(providerTag({ azure: AZURE }), 'azure-openai:text-embedding-3-large');
  });
  test('public display tag is unchanged', () => {
    assert.equal(providerTag({ azure: INACTIVE, model: 'gemini-embedding-001' }), 'gemini:gemini-embedding-001');
  });
});
