# Arm-eval session acf724d8-b03b-450a-9f64-de6e40b2b0e1

| Field | Value |
|---|---|
| Experiment | brainstorm |
| Phase | calibration |
| Task id | `task-65de4563` |
| Seed (presentation-order RNG) | 3 |
| Config / rubric version | 1 / 1 |
| Created (UTC) | 2026-07-02T05:30:15.711Z |
| Repo | 8548afbd-8d85-50de-baca-1bb158d696da |
| Archive mode | FULL (attribution + judgments) |

## Task

How should we structure a cache-invalidation strategy for the architecture map so it stays fresh without full rebuilds

## Arms + outputs

### Arm D

- Models: `{"models":["latest-gpt","latest-pro"],"resolved":["gpt-5.5","gemini-pro-latest"],"backfillNote":"backfilled 2026-07-02: sentinel resolved against live catalog same-day as all runs"}`
- Conformant: true
- Output hash: `f44db905d3da9e6d`

# Combined take: use dependency-aware incremental invalidation, not TTLs or whole-map rebuilds

The architecture map should be treated as a **versioned derived graph**, not as one cached artifact. The right strategy is:

```text
event-driven input changes
→ content-hashed fact extraction
→ semantic diff
→ update affected graph fragments
→ invalidate dependent subgraphs/views
→ recompute asynchronously
→ publish a new validated snapshot atomically
```

The core principle:

> **Invalidate by dependency impact, not by time, repo, or whole-map scope.**

TTLs are useful as a fallback for telemetry and missed events, but they should not be the main freshness mechanism for source, catalog, or infrastructure-derived facts.

---

## 1. Split the map into cacheable layers

Do not cache the architecture map as one object.

Split it into layers with separate cache keys, versions, and invalidation rules:

```text
Raw inputs
  ↓
Extracted facts
  ↓
Normalized graph entities and edges
  ↓
Computed graph projections
  ↓
Rendered UI/layout/cache
```

Example layers:

### Source-derived facts

- imports
- package dependencies
- OpenAPI/protobuf schemas
- database references
- config references
- Dockerfiles
- Terraform/Pulumi/Kubernetes manifests
- CI/CD config

### Runtime-derived facts

- service-to-service calls
- queues/topics observed
- database access observed
- traffic volume
- latency/error metadata
- service mesh/API gateway traces

### Catalog and ownership facts

- CODEOWNERS
- service catalog entries
- team ownership
- lifecycle status
- domain tags

### Graph objects

- services
- APIs
- databases
- queues
- deployments
- edges
- ownership links

### Views/projections

- service map
- domain map
- dependency map
- ownership map
- critical-path view
- environment-specific view
- change-impact view

### Render/layout cache

- node positions
- expanded/collapsed state
- visual grouping
- layout output

Each layer should be invalidated independently.

---

## 2. Use content hashes for deterministic source caching

For anything derived from source-controlled files, use content-addressed cache keys, not timestamps.

Example:

```text
fact:imports:{repo}:{file_path}:{file_content_hash}
fact:openapi:{repo}:{path}:{file_content_hash}
fact:terraform:{repo}:{path}:{file_content_hash}
```

If the content hash is unchanged, the extracted architecture facts are still valid.

This avoids two common TTL problems:

1. Refreshing unchanged files unnecessarily.
2. Serving stale facts after an important code/config change.

Recommended cache keys:

```text
fact:{source_type}:{source_id}:{content_hash}
entity:{entity_id}:{entity_version}
edge:{edge_id}:{edge_version}
view:{view_id}:{graph_snapshot_version}
render:{view_id}:{layout_input_hash}
```

---

## 3. Drive invalidation from events

Freshness should mostly come from events, not cron jobs.

Useful invalidation triggers:

### Source events

- merge to `main`
- PR merged
- release created
- package manifest changed
- API schema changed
- protobuf/OpenAPI changed
- Dockerfile changed
- CI/CD pipeline config changed

### Infrastructure events

- Terraform/Pulumi state changed
- Kubernetes manifests changed
- deployment changed
- new database/queue/topic provisioned
- ingress/API gateway changed

### Runtime events

- new dependency observed in tracing
- dependency not observed for N days
- new service discovered
- service mesh traffic changed
- API gateway route changed

### Catalog events

- owner changed
- service renamed
- domain tag changed
- lifecycle status changed
- service catalog entry updated

But the event should only identify the **candidate scope**. The system should still perform a semantic diff before invalidating graph objects.

Example:

```text
README changed
→ file changed
→ no architecture facts changed
→ no graph invalidation
```

Example:

```text
openapi.yaml changed
→ API contract fact changed
→ invalidate API entity
→ invalidate producer/consumer edges
→ invalidate affected views
```

---

## 4. Use semantic diffing, not file-change invalidation

A file diff tells you what inputs changed. A semantic diff tells you whether the architecture changed.

Pipeline:

```text
1. Receive event.
2. Identify changed files/resources.
3. Re-extract facts only from changed inputs.
4. Compare old facts vs new facts.
5. Produce semantic diff.
6. Update only changed entities/edges.
7. Increment versions for changed fragments.
8. Invalidate dependent views.
```

Example mapping:

| Changed input | Re-extract | Possible invalidation |
|---|---|---|
| `src/**/*.go`, `src/**/*.ts`, `src/**/*.java` | imports/calls | internal module graph, service edges |
| `package.json`, `pom.xml`, `go.mod` | package deps | library/dependency view |
| `openapi.yaml`, `proto/**/*.proto` | API contracts | API entity, producer/consumer edges |
| `terraform/**/*.tf` | infra resources | DBs, queues, cloud resources |
| `k8s/**/*.yaml` | deployment topology | runtime/deployment view |
| `CODEOWNERS` | ownership facts | ownership overlay |
| `catalog-info.yaml` | catalog metadata | service metadata |
| `.github/workflows/*` | delivery metadata | CI/CD view |

The key distinction:

```text
Input changed ≠ architecture changed
```

Only architecture fact changes should invalidate graph fragments.

---

## 5. Maintain a reverse dependency index

The system needs to know what cached objects depend on what inputs.

Treat the architecture map like an incremental build graph:

```text
source/config/runtime/catalog inputs
        ↓
extracted facts
        ↓
normalized entities and edges
        ↓
computed views
        ↓
rendered map/UI/API responses
```

Every cached fragment should know its inputs.

Example reverse index:

```text
file:services/billing/api/openapi.yaml
  affects:
    fact:api-contract:billing
    entity:service:billing
    edge:checkout->billing
    view:payments-domain-map
    view:external-apis-map
```

When the OpenAPI file changes, invalidate only those objects and downstream projections.

This is stronger than a simple “invalidate one-hop neighbors” rule. One-hop invalidation is a good default for localized graph changes, but it is not sufficient for every view. Some views depend on rollups, topological ordering, domains, ownership, or critical paths. The correct invalidation radius should be determined by the dependency index.

In other words:

```text
Use local blast-radius invalidation where possible,
but let dependency metadata decide the actual scope.
```

---

## 6. Version every graph fragment

Every entity, edge, and view should carry a version.

Example:

```text
service:billing@v42
edge:checkout->billing@v17
owner:billing@v5
api:billing-public@v12
```

A cached view should declare the versions it depends on:

```json
{
  "view": "payments-domain-map",
  "depends_on": {
    "service:billing": 42,
    "service:checkout": 31,
    "edge:checkout->billing": 17,
    "owner:billing": 5
  }
}
```

If none of those versions changed, the view is still valid.

If only `owner:billing` changed, you can refresh the ownership overlay without recomputing the structural dependency graph.

---

## 7. Separate structural, metadata, runtime, and render freshness

Not all changes should invalidate the same cache.

### Structural changes

These affect topology:

- new service
- removed service
- new dependency edge
- removed dependency edge
- API contract changed
- database/queue dependency changed
- deployment topology changed

These should invalidate graph projections quickly.

### Metadata changes

These affect labels or annotations:

- owner
- description
- lifecycle status
- tier
- cost center
- documentation URL
- domain tag

These should update overlays without recomputing topology.

### Runtime metric changes

These are volatile:

- traffic volume
- latency
- error rate
- recent call activity

These should use short TTLs, streaming updates, or time-windowed caches.

### Render/layout changes

These affect visual presentation:

- node coordinates
- layout groups
- pinned positions
- expanded/collapsed state

These should be cached separately from graph data.

This matters because a tiny graph change can cause a layout engine to reshuffle the whole visual map. Keep existing node positions pinned where possible and place new nodes around stable anchors.

---

## 8. Keep data eager, rendering lazy

A useful split:

```text
Data cache: updated eagerly from events.
Render cache: recomputed lazily when needed.
```

When a backend event arrives, update the graph facts/entities/edges as soon as possible.

But do not always recalculate expensive visual layouts immediately. Instead:

```text
render:{view_id}:{layout_input_hash}
```

If the graph data hash changes, invalidate the render cache. Recompute it when a user requests the view, or precompute only high-traffic views.

This avoids wasting layout compute for views nobody opens.

Also preserve visual stability:

- pin existing nodes
- avoid global layout churn for small changes
- place new nodes near their connected neighbors
- keep user-customized positions separate from generated layout

---

## 9. Publish graph snapshots atomically

Do not mutate the visible map in place.

Use versioned graph snapshots:

```text
graph-snapshot:v101
graph-snapshot:v102
graph-snapshot:v103
```

Flow:

```text
1. Current UI reads graph-snapshot:v102.
2. Incremental worker updates impacted fragments.
3. System validates the new graph.
4. Publish graph-snapshot:v103 atomically.
5. UI switches to v103.
```

This prevents mixed states like:

- edges pointing to missing nodes
- old owners with new service IDs
- environment data mixed across deployments
- partial topology updates

If validation fails, continue serving the last known good snapshot.

---

## 10. Validate before publishing

Incremental invalidation is efficient but can create subtle inconsistencies. Add validation gates before making a new snapshot visible.

Validate:

- all edges reference existing nodes
- no duplicate canonical service IDs
- owners resolve to known teams
- deleted services have no active edges unless marked external/unknown
- API consumers/producers are valid
- domain rollups match underlying services
- environment-specific views do not mix incompatible data
- runtime-only edges are labeled correctly
- service renames preserve identity

If validation fails:

```text
keep serving last-known-good snapshot
mark refresh failed
emit diagnostics
retry or escalate
```

---

## 11. Handle service identity explicitly

Cache invalidation becomes noisy if service identity is unstable.

The same service may appear as:

```text
billing
billing-service
prod-billing
payments/billing
github.com/acme/billing
k8s/prod/payments/billing
```

Create canonical IDs:

```text
service:billing
repo:github.com/acme/billing-service
deployment:k8s/prod/payments/billing
api:billing-public
database:billing-postgres
queue:invoice-events
```

Cache and invalidate by canonical IDs, not display names.

This avoids unnecessary invalidation when labels, aliases, or deployment names change.

---

## 12. Model static intent and runtime reality separately

Static analysis and runtime telemetry often disagree.

Example:

```text
Static scan: checkout imports billing client.
Runtime traces: checkout has not called billing in 30 days.
```

Or:

```text
Static scan: no dependency on fraud-service.
Runtime traces: checkout calls fraud-service in production.
```

Do not collapse these into one simplistic edge.

Represent evidence separately:

```json
{
  "edge": "checkout -> billing",
  "evidence": [
    {
      "type": "static_scan",
      "repo": "checkout",
      "commit": "abc123",
      "source": "BillingClient.ts"
    },
    {
      "type": "runtime_trace",
      "environment": "prod",
      "last_seen": "2026-07-02T10:10:00Z"
    }
  ],
  "status": "active",
  "confidence": 0.93
}
```

Then invalidate each layer differently:

```text
Intent/static edges: Git and CI/CD events.
Actual/runtime edges: telemetry windows and runtime events.
```

This prevents a static code change from incorrectly deleting a runtime dependency, and prevents transient telemetry gaps from corrupting the architecture map.

---

## 13. Treat removals as confidence-based, especially runtime removals

Adding a dependency is easy: you saw evidence.

Removing one is harder. Absence could mean:

- dependency was removed
- code path was not exercised
- tracing missed it
- traffic was low
- scanner failed
- environment was quiet

Use staged removal.

Example:

```json
{
  "edge": "checkout -> fraud-service",
  "status": "suspected_removed",
  "last_seen": "2026-06-01",
  "evidence": [
    "not_in_static_scan",
    "not_seen_in_traces_30d"
  ],
  "confidence": 0.42
}
```

Then after a grace period:

```text
active
→ suspected_removed
→ inactive
→ hidden from default view
→ retained in audit/history
```

This keeps the map fresh without making it brittle.

---

## 14. Use stale-while-revalidate for user-facing views

The UI/API should not block on recomputation.

Use:

```text
serve last known good map
trigger background refresh
publish new snapshot atomically when ready
```

Response metadata should expose freshness:

```json
{
  "map_version": "graph-snapshot:v103",
  "generated_at": "2026-07-02T10:15:30Z",
  "source_commit": "abc123",
  "runtime_data_freshness": "5m",
  "served_stale": false,
  "is_refreshing": false
}
```

During refresh:

```json
{
  "map_version": "graph-snapshot:v102",
  "served_stale": true,
  "is_refreshing": true,
  "last_successful_refresh": "2026-07-02T10:12:00Z"
}
```

This gives users a stable experience while still converging quickly.

---

## 15. Support client-side diff delivery

For large maps, avoid sending the full payload after every small change.

Use an ETag or graph version hash:

```text
ETag: graph-snapshot:v103
```

If the client already has `v102`, the server can return a JSON Patch or graph delta:

```json
[
  {
    "op": "replace",
    "path": "/edges/checkout->billing/status",
    "value": "runtime_only"
  },
  {
    "op": "add",
    "path": "/nodes/invoice-events",
    "value": {
      "type": "queue",
      "owner": "payments-platform"
    }
  }
]
```

This is especially useful when the map is large but the invalidation scope is small.

---

## 16. Use TTLs only where time is part of the source

TTL is not the right primary mechanism for source or catalog data.

But TTLs are useful for:

- runtime metrics
- telemetry windows
- external API enrichment
- fallback against missed events
- periodic consistency checks

Recommended defaults:

| Data type | Strategy |
|---|---|
| Source-derived facts | content-hash invalidation |
| Service catalog metadata | event-driven + backup TTL |
| Ownership metadata | event-driven + daily reconciliation |
| Runtime dependency observations | time-windowed TTL |
| Metrics overlays | short TTL, e.g. 30s–5m |
| Rendered graph views | graph/version invalidation |
| External enrichment | TTL + ETag/last-modified checks |

---

## 17. Add a dirty ledger and incremental workers

A practical implementation can use a dirty ledger.

Flow:

```text
1. Event arrives.
2. Determine affected repo/service/resource.
3. Add canonical entity IDs to dirty ledger.
4. Worker consumes dirty items.
5. Worker re-extracts affected facts.
6. Worker computes semantic diff.
7. Worker updates graph fragments.
8. Worker increments versions.
9. Worker invalidates dependent views.
10. Worker publishes a validated snapshot.
```

Example dirty record:

```json
{
  "entity": "service:checkout",
  "reason": "git_merge",
  "repo": "github.com/acme/checkout-service",
  "commit": "abc123",
  "changed_paths": [
    "src/payments/BillingClient.ts",
    "README.md"
  ]
}
```

The worker should ignore non-architectural changes after semantic diffing.

---

## 18. Keep lineage and freshness metadata per fragment

Every cached node, edge, and view should be explainable.

Example:

```json
{
  "id": "edge:checkout->billing",
  "version": 17,
  "last_updated": "2026-07-02T10:14:00Z",
  "sources": [
    {
      "type": "static_scan",
      "repo": "checkout",
      "commit": "abc123",
      "evidence": "import BillingClient"
    },
    {
      "type": "runtime_trace",
      "environment": "prod",
      "last_seen": "2026-07-02T10:10:00Z"
    }
  ],
  "confidence": 0.93
}
```

This helps debug stale maps and reduces the temptation to run full rebuilds blindly.

---

## 19. Use reconciliation jobs, not routine full rebuilds

Event-driven systems can miss events. Webhooks fail, queues drop messages, CI steps are skipped, or external systems drift.

So add reconciliation.

But the normal path should still be incremental.

Suggested cadence:

```text
hourly: verify recent events were processed
daily: reconcile catalog/ownership metadata
weekly: sample or rescan high-value repositories
monthly/occasional: full rebuild as audit, not normal operation
```

A full rebuild can still exist as a correctness audit, but it should not be the mechanism that keeps the map fresh day to day.

This reconciles the tension between “avoid full rebuilds” and “event-driven systems drift”: full rebuilds are a safety check, not the steady-state strategy.

---

# Recommended default architecture

Use this baseline:

```text
1. Event ingestion
   Git, CI/CD, IaC, service catalog, deployment, runtime telemetry

2. Scope detection
   repo, service, file paths, infra resource, environment, domain

3. Content-hash extraction
   parse only changed source/config/input files

4. Semantic diff
   compare old facts vs new facts

5. Graph fragment update
   update entities, edges, metadata, evidence, confidence

6. Version increment
   only changed fragments get new versions

7. Reverse dependency invalidation
   invalidate affected views/projections/layouts

8. Async recomputation
   rebuild impacted subgraphs and high-value views

9. Validation
   ensure graph consistency

10. Atomic snapshot publish
   expose new graph version only after validation

11. UI/API delivery
   stale-while-revalidate, ETags, optional JSON Patch deltas

12. Reconciliation
   catch missed events and drift
```

---

## Example end-to-end flow

A PR merges into `checkout-service`.

Changed files:

```text
src/payments/BillingClient.ts
README.md
```

Pipeline:

```text
1. Git event arrives for checkout-service at commit abc123.
2. Changed paths are identified.
3. README.md is ignored.
4. BillingClient.ts content hash changed.
5. Static extractor reruns only for that file/module.
6. New static facts say checkout no longer imports billing client.
7. Previous static fact had checkout -> billing.
8. Runtime traces still show checkout calling billing within the last 2 hours.
9. Edge is not deleted.
10. Edge is changed from static+runtime to runtime-only.
11. Confidence is lowered.
12. edge:checkout->billing version increments.
13. Views containing checkout or billing are invalidated.
14. Payments-domain view is recomputed asynchronously.
15. Existing layout positions are pinned.
16. New graph snapshot is validated.
17. graph-snapshot:v103 is published atomically.
18. UI serves v102 during recomputation, then switches to v103.
```

No full rebuild is required, and the system avoids incorrectly deleting a dependency based on one signal.

---

# Bottom line

Structure the cache around a **versioned, dependency-aware architecture graph**.

The strongest strategy is:

```text
content-hashed facts
+ event-driven invalidation
+ semantic diffs
+ reverse dependency index
+ fragment-level versions
+ static/runtime evidence separation
+ lazy render caching with stable layout
+ stale-while-revalidate UI
+ atomic graph snapshots
+ validation gates
+ periodic reconciliation
```

That gives you a map that stays fresh, avoids full rebuilds in normal operation, and still has safeguards against drift, missed events, bad removals, and visual instability.

### Arm E

- Models: `{"models":["z-ai/glm-5.2","latest-pro"],"resolved":["z-ai/glm-5.2","gemini-pro-latest"],"backfillNote":"backfilled 2026-07-02: sentinel resolved against live catalog same-day as all runs"}`
- Conformant: true
- Output hash: `1d222bdc2cf9f8a7`

# Cache-Invalidation Strategy for an Architecture Map

## Core principle: stop expiring the map. Expire layers, nodes, and edges.

An architecture map is a directed graph, not a document. Full rebuilds happen when you treat it as a single cache entry. Instead, split it into three layers with different volatility, trust, and refresh economics — and invalidate at the layer and node level.

| Layer | Examples | Volatility | TTL | Invalidation trigger |
|---|---|---|---|---|
| **Static topology** | service→service deps, code-declared integrations, infra from Terraform/k8s, cloud accounts, VPCs | Low (hours-days) | Long (1-24h) | Content-hash change |
| **Runtime facts** | observed traffic edges, latency, error rates, instance counts, active pods | High (seconds-minutes) | Short (30s-2m) | Telemetry/event stream |
| **Curated metadata** | ownership, criticality tier, on-call, business domain | Manual, rare | Infinite | Changelog/manual edit |

Full rebuilds become unnecessary because only one layer is typically affected by any given change, and each layer has its own invalidation economics. When the UI renders, it stitches all three together — you never rebuild the bedrock just to update the weather.

## Entry schema: content hashing as the backbone

Every cached node/edge carries:

```
entity_id | layer | source_ref | content_hash | generated_at | ttl | deps[] | blast_radius_id
```

- **`content_hash`** is the critical field. Assign a deterministic hash per component based on its underlying state (Git commit hash + Terraform state hash for static; telemetry-derived for runtime). When a source "changes" but produces identical output, you skip recomputation entirely. This kills ~60-80% of spurious invalidations in practice — especially from `kubectl annotate` and Terraform plans that churn annotations without semantic change.
- **`blast_radius_id`** is a precomputed grouping (e.g., "stack:payments", "namespace:checkout") so you can invalidate a region of the graph in one shot without walking it.
- **`deps[]`** enables transitive invalidation when a downstream entity changes in a way that affects upstream edges.

**The catch:** you must define "semantic" carefully per source — hashing the wrong fields gives you both false positives and false negatives.

## The invalidation pipeline

1. **Source emits change** — git push, k8s apply, deploy event, telemetry spike, or manual metadata edit.
2. **Lookup inverse index**: `source → [entity_ids]`. This is the only structure you need to maintain eagerly; everything else can be lazy.
3. **Recompute content hash** for affected entries. If unchanged → no-op.
4. **If changed**: mark entry `stale` (not delete). Rebuild asynchronously. Serve stale-while-revalidate.
5. **Propagate to dependents** via `deps[]` with bounded depth (2 hops is enough — beyond that the signal is noise). 3rd-order effects get caught on the next TTL cycle.
6. **Coalesce bursts**: a mass redeploy shouldn't trigger N×M invalidations. Window 5-10s, dedupe by `blast_radius_id`.

## Event-driven with polling fallback — not either/or

Real architectures have 3-5 sources, not all instrumented, and out-of-band changes (rogue sysadmin in the AWS console, manual `kubectl apply`) will defeat a pure push model. Run a **hybrid**: events where you have them (CI/CD webhooks, k8s watch events, deploy pipelines), polling with hash comparison where you don't. Polling is fine when you're comparing hashes, not rebuilding — the content hash makes cheap polling semantically equivalent to event-driven invalidation.

## Stale-while-revalidate — but don't hide staleness

Serving stale data while rebuilding in the background is the right default. But someone debugging an outage acting on a 90-second-stale topology can make wrong calls. **Expose staleness to consumers explicitly** ("this slice last verified 2m ago, source: k8s informer"). Let the consumer downgrade trust; don't lie. If the background check detects drift, push a UI notification — but the metadata about freshness is non-negotiable.

## The honest trade-offs

**Temporal tearing is real.** Localized caching means Node A's freshly rebuilt cache says it talks to Database X, but Database X hasn't been updated yet, so its cache has no record of Service A. Mitigation: a **nightly reconciliation loop** that runs a full map rebuild to heal dangling edges and correct localized drift. This is your safety net — not your primary invalidation path, but a backstop against silent drift.

**Key cardinality can explode.** Granular caching with 1,000 services and 5,000 edges means 6,000+ cache keys, and managing their lifecycle can become more expensive than rebuilding a 10MB JSON blob every 5 minutes. Mitigation: don't start at the individual component level. Start at the **domain/namespace level** (`blast_radius_id`), then drop to per-component granularity only where the cardinality and churn justify it.

**Stable identity is the hardest failure mode.** Not staleness — a service getting renamed and your cache treating old and new as unrelated entities. Invest early in a canonical ID (e.g., `service:{team}:{logical_name}` decoupled from k8s deployment name) and an alias map. Without this, partial invalidation silently rots.

**Bounded propagation is a feature, not a limitation.** Walking the entire dependency graph on every change is what makes "full rebuild" feel necessary. Cap propagation at 2 hops and accept that freshness degrades gracefully instead of all-or-nothing.

## Where to start

Build two things first:

1. **The inverse source→entity index** (`source → [entity_ids]`). This is the only eagerly-maintained structure you need.
2. **Content-hash comparison** per entry. This alone eliminates most full rebuilds.

Then implement **tiered volatility**: separate static topology generation from live telemetry, serve the structural map from a long-TTL cache invalidated by CI/CD events, and layer runtime data on top dynamically. Everything else — blast radius grouping, bounded propagation, staleness surfacing, nightly reconciliation — is optimization layered on top of that foundation.

### Arm F

- Models: `{"models":["z-ai/glm-5.2","latest-gpt"],"resolved":["z-ai/glm-5.2","gpt-5.5"],"backfillNote":"backfilled 2026-07-02: sentinel resolved against live catalog same-day as all runs"}`
- Conformant: true
- Output hash: `4fde3a0b7f6dfc35`

# Cache Invalidation for an Architecture Map

## Core Principle: Provenance-Driven, Incrementally Recomputable

Don't treat the architecture map as one blob with a single freshness policy. Model it as a pipeline of artifacts, each derived from a set of versioned inputs, and invalidate only the affected artifacts when inputs change.

Every node and edge carries metadata about **where its truth comes from** and **what version it was computed from**. Invalidation is then a targeted, source-driven action — not a sweeping timer or a full rebuild.

---

## 1. Structure the map as cacheable units

Avoid treating the map as one object. Model it as three layers:

**Source inputs** — git repos, manifests, OpenAPI specs, Terraform, runtime telemetry, service catalog, deploy events.

**Derived artifacts** — "Service A imports package X", "Service B exposes endpoint Y", "Team T owns service S". These are intermediate computations keyed by their input versions.

**Composed map views** — dependency graph, ownership map, deployment topology, API call graph. These compose derived artifacts rather than rebuilding from raw sources each time.

The final map should mostly be a composition of intermediate artifacts. When one input changes, you recompute the relevant artifact, create a new map generation pointing to it, and reuse the rest.

---

## 2. Content-addressed cache keys, not timestamps

For every source input, compute a fingerprint:

```
repo:payments-service@commit:abc123
openapi:billing.yaml@sha256:...
terraform:prod/network.tf@sha256:...
service-catalog:service-id-42@version:17
```

Cache derived artifacts based on the fingerprints of their inputs. If the fingerprint is unchanged, reuse the artifact. This eliminates rebuilds triggered by timestamp churn or cosmetic edits.

---

## 3. Three-tier invalidation, by source volatility

Not all sources support the same mechanisms. Use a tiered fallback:

**Tier 1 — Event-driven (push).** For volatile, high-signal sources: deploy pipelines, API gateway, IaC webhooks, service catalog updates, Kubernetes watch events. Each event carries a scope signature. The invalidator marks affected artifacts stale and queues a targeted recompute.

**Tier 2 — Content-hash polling (pull with diffing).** For sources that don't push: poll on a per-source schedule, but fetch a lightweight content hash and compare. Only re-ingest when the hash changes. Poll intervals should be tuned per source — a Terraform repo that changes weekly doesn't need minute-level polling.

**Tier 3 — Lazy revalidation on read (safety net).** When a cache entry is read, check its age against a per-source-type TTL. If expired, serve stale and trigger an async background refresh (stale-while-revalidate). TTLs are per source-type: K8s discovery 30s, ADRs 24h, etc.

TTL is secondary, not primary. It exists to catch things that change without clean events (runtime telemetry, cloud inventory, third-party metadata) and to bound maximum staleness.

---

## 4. Maintain a reverse-dependency index

This is the most important piece. Without it, you're choosing between stale data and full rebuilds.

The index maps:

```
source input → derived artifacts → composed map views
```

When an input changes, ask: "Which cached artifacts were derived from this input?" Invalidate only those.

**The cascade problem.** When Service A changes its API contract, you don't just invalidate Service A's node. You need to invalidate:

1. Direct dependents (services calling A) — their edges may now be inaccurate
2. Transitive dependents (two hops out is usually sufficient; beyond that signal dilutes)
3. Derived views (blast-radius, ownership maps, precomputed cross-cuts)

Mechanism: walk the reverse-dependency graph bounded to depth 2, mark those edges "probe-stale" — not necessarily wrong, but should be re-verified on next access or next poll cycle. Going deeper creates invalidation storms that look like full rebuilds anyway. Be honest about the cutoff.

---

## 5. Classify changes by impact

Not all changes have the same effect. Maintain a rules table:

| Change detected | Invalidate |
|---|---|
| `package.json` / dependency file changed | code dependency artifact for that service |
| `openapi.yaml` changed | API surface artifact + known consumers |
| `terraform/**/*.tf` changed | infra topology artifacts |
| `catalog-info.yaml` / ownership metadata changed | ownership artifact |
| deploy config changed | deployment topology artifacts |
| README / docs / test files changed | metadata only, no architecture artifacts |
| service renamed/deleted | service node + all inbound/outbound edges |

Classify first, invalidate second. Low-impact changes (comments, formatting, docs) shouldn't trigger recomputation at all.

---

## 6. Separate human-authored from machine-discovered data

Human-authored data (ADRs, runbooks, ownership) changes slowly, is authoritative, and is low-noise. Machine-discovered topology changes fast but is noisy. Separate their invalidation policies entirely:

- Human data: long TTL, event-driven on documented changes, treat as authoritative.
- Machine data: short TTL, smoothing required (edge must appear N times before added, absent for a time window before removed), annotate with confidence score.

Runtime telemetry especially causes map churn. Don't let it destabilize the map.

---

## 7. Stale-while-revalidate for user-facing views

Don't block users while recomputing unless correctness is critical. Serve the cached view, mark affected regions stale, recompute in background, swap when ready.

Expose freshness in the API/UI:

```json
{
  "edge": "payments-service -> billing-service",
  "freshness": "stale",
  "computed_at": "2026-07-02T10:14:00Z",
  "input_versions": {
    "payments-service": "abc123",
    "billing-openapi.yaml": "sha256:123"
  }
}
```

Let the map say "this service is fresh", "this dependency edge may be stale", "this infra relationship is from yesterday's scan". That's much better than pretending the whole map is uniformly fresh.

---

## 8. Queue-based, idempotent recomputation

Invalidation enqueues work; it doesn't rebuild inline.

```
change event → normalize → classify impact → mark stale → enqueue recomputation → workers recompute → update artifact store → new map generation
```

Jobs are idempotent: `recompute-service-artifacts(service_id, input_version)`. Duplicate events don't matter. If a newer version arrives before an older job finishes, discard the stale result by checking input versions before writing.

---

## 9. Handle deletions explicitly

Deletions are where incremental systems fail. If a service, API, repo, or resource disappears:

- Create a tombstone with `status: deleted`, `deleted_at`, `source_event`.
- Invalidate all inbound/outbound edges, ownership annotations, deployment references, docs/search entries, rendered views containing that node.
- **Do not rely on "absence from latest scan" alone** — temporary scan failures will delete real nodes. Require explicit delete events or confirmed absence over a time window.
- Soft delete first, hard delete after confirmation.

---

## 10. Consistency checks + periodic reconciliation

Incremental systems drift. Run cheap consistency checks continuously:

- edges point to existing nodes
- ownership references valid teams
- deleted nodes absent from active views
- API consumers reference existing providers
- artifact input versions still valid

Then run deeper reconciliation nightly/weekly, and full rebuilds rarely — only for schema migrations, parser upgrades, suspected corruption, or periodic audit. Full rebuilds should be intentional and controlled, not the default recovery path.

---

## 11. Three cache categories

**Immutable artifact cache** — keyed by content hash or source version. Never invalidate; just stop referencing old versions. Best for parsed manifests, code scans, OpenAPI parsing.

**Mutable freshness cache** — stores latest known artifact per entity, pointer to immutable version. Invalidated when source changes. Best for latest service view, dependency graph, ownership state.

**Ephemeral runtime cache** — short TTL, refreshed frequently. Best for observed traffic edges, runtime discovery, cloud inventory, metrics-derived dependencies.

---

## Practical architecture

```
[Change Sources]
  Git webhooks, CI/CD, catalog, deploy, cloud inventory, telemetry
       │
       ▼
[Event Normalizer + Change Classifier]
       │
       ▼
[Dependency Index + Scope Resolver]
       │
       ▼
[Invalidation Planner] → [Invalidation Event Log]
       │
       ▼
[Artifact Store + Staleness Flags]
       │
       ▼
[Recompute Queue] → [Incremental Workers]
       │
       ▼
[Map Generation Builder]
       │
       ▼
[Architecture Map API/UI]
```

The **Scope Resolver / Dependency Index** is the brain — it maps a raw change event to affected node/edge IDs, applies cascade rules, and classifies impact. The **Invalidation Event Log** is the most underrated piece: it gives observability into what was invalidated and why, which is what you need when someone asks "why is the map wrong right now?"

---

## What to avoid

- **Global TTL invalidation as primary policy.** Guarantees either excessive staleness or excessive rebuilds. Only acceptable as a last-resort backstop ("rebuild everything if no event in 7 days").
- **Full graph re-serialization on any change.** Serialize deltas, not snapshots. Keep a write-ahead log of invalidation events for replay and audit.
- **Treating human-authored and machine-discovered data identically.** Different volatility, different authority, different policies.
- **Relying on absence-from-scan for deletions.** Use tombstones and explicit confirmation.

---

## How to start

If building this now, don't start at maximum granularity. Start simple and evolve:

1. Define entities and artifacts: service node, API edge, code dependency edge, infra resource, ownership record, deployment record.
2. Fingerprint all source inputs: repo commit, relevant file hashes, catalog versions, deploy versions.
3. Build the reverse-dependency index: input → artifact → view.
4. Wire event-driven invalidation for the highest-signal sources (Git, CI/CD, catalog, deploys).
5. Invalidate at service granularity first — any relevant file in repo changes → recompute that service's artifacts. Evolve toward file-level later only if needed.
6. Store immutable artifacts by version. Don't overwrite derived outputs blindly.
7. Serve stale-while-revalidate with visible freshness metadata.
8. Add periodic reconciliation: daily targeted scan, occasional full rebuild.
9. Add tombstones and explicit deletion handling before you need it.

---

## The honest summary

You will never achieve perfect freshness without full rebuilds. The goal is **proportionate freshness**: parts that change often and matter most (runtime topology, service versions, dependency edges) are event-driven and near-real-time; parts that change rarely (documentation, ownership, data classification) are poll-based with long TTLs. Cascade depth is bounded and explicit. Stale-while-revalidate is the default read behavior so consumers never block. Incremental invalidation reduces cost but accumulates drift, so periodic reconciliation is non-negotiable.

The invalidation event log is what makes this debuggable. The reverse-dependency index is what makes it tractable. Everything else is tuning.

## Judge scores (blinded at judge time; unblinded here post-ranking)

| Pass | Label | Arm | Scores |
|---|---|---|---|
| 1 | output-1 | E | `{"clarity":5,"insight":4,"correctness":4,"completeness":4,"right_sizing":5,"actionability":4,"risk_handling":4,"angle_diversity":4}` |
| 1 | output-2 | D | `{"clarity":3,"insight":4,"correctness":5,"completeness":5,"right_sizing":2,"actionability":3,"risk_handling":5,"angle_diversity":5}` |
| 1 | output-3 | F | `{"clarity":5,"insight":5,"correctness":5,"completeness":5,"right_sizing":4,"actionability":5,"risk_handling":5,"angle_diversity":4}` |
| 2 | output-1 | E | `{"clarity":5,"insight":4,"correctness":4,"completeness":4,"right_sizing":5,"actionability":4,"risk_handling":4,"angle_diversity":4}` |
| 2 | output-2 | D | `{"clarity":3,"insight":4,"correctness":5,"completeness":5,"right_sizing":2,"actionability":3,"risk_handling":5,"angle_diversity":5}` |
| 2 | output-3 | F | `{"clarity":5,"insight":5,"correctness":5,"completeness":5,"right_sizing":4,"actionability":5,"risk_handling":5,"angle_diversity":4}` |

