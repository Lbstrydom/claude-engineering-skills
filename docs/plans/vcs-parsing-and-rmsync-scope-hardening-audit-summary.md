# Audit Summary — vcs-parsing-and-rmsync-scope-hardening

**Plan**: [`vcs-parsing-and-rmsync-scope-hardening.md`](vcs-parsing-and-rmsync-scope-hardening.md)
**Audit-code SID**: `audit-code-1785112849`
**Rounds**: 6 (GPT) + 2 (Gemini) | **Final**: H:0 M:0 L:0 | Gemini verdict: **APPROVE**

## GPT round-by-round

| Round | H | M | L | Notable |
|---|---|---|---|---|
| 1 | 1 | 5 | 0 | H1/M1/M2 (same root cause — retrySync wrapper name-only matching) fixed; M3 adjacency control-state dismissed; M4/M5 deferred (out-of-scope, unrelated files) |
| 2 | 0 | 2 | 0 | M1 (spread-masked options) + M2 (async wrapper accepted) fixed, both in find-rmsync-sites.mjs |
| 3 | 1 | 3 | 0 | H1 (`{default as fs}` import form) + M1 (quoted string option keys) fixed; M2 (raw-node coupling) accepted as `accepted-permanent` debt; M3 (duplication vs atomic-write-adoption-guard.test.mjs) suppressed via `@duplicate-justification` pragma |
| 4 | 0 | 0 | 0 | Clean |
| 5 | 0 | 1 | 0 | M1 (Set algebra Liskov claim) dismissed — empirically disproven on Node v22.19.0 |
| 6 | 0 | 1 | 0 | M1 (namespace member-extraction alias, e.g. `fs.rmSync.bind(fs)`) deferred (out-of-scope, unbounded scope, sole repo occurrence is test-mocking infra) |

Hit the max-6-round backstop while new findings kept surfacing, but every
round-6 finding was fixed, empirically disproven, or triaged as genuinely
independent debt with full rationale — 0 unresolved valid in-scope findings.

## Gemini gate

- **Round 1 → CONCERNS**: G1 (HIGH — computed-key/ObjectMethod options bypass) +
  G2 (MEDIUM — ES2022 string-literal import specifier names). Both empirically
  verified real via direct AST inspection, fixed, and covered by new regression
  tests.
- **Round 2 → APPROVE**, 0 new findings.
- Shadow reviewer (Claude Opus, non-gating): raised several observations across
  both rounds — the coupling-contract point matches the already-accepted R3 M2
  debt; a "parse failures silently pass" claim was checked against the actual
  code and found factually incorrect (the guard wraps `findRmSyncCallSites` in
  try/catch and calls `assert.fail` on a parse error); remaining LOW/MEDIUM
  items are accepted design headroom, not fixed.

## Debt captured (`.audit/tech-debt.json`)

| Topic | Reason | File(s) |
|---|---|---|
| `7d7d8917d7f5` | out-of-scope | `scripts/lib/store/arch/coverage.mjs` layer-boundary (pre-existing, unrelated) |
| `def2b640fe5d` | out-of-scope | `scripts/lib/audit/tiered-shadow-contract-digest.mjs` layer-boundary (pre-existing, unrelated) |
| `95dea9eea964` | accepted-permanent | `find-rmsync-sites.mjs`/`rmsync-retry-guard.test.mjs` raw-node/position-join coupling |
| `004c27af817f` | out-of-scope | `find-rmsync-sites.mjs` namespace-member-extraction alias resolution (unbounded, no live risk) |

## Verification

- `npm test`: 8876 passing, 22 pre-existing skips, 0 failures (final run).
- Empirical repro scripts run for every fix before committing to code: the
  `ReadOnlySet` construction gotcha, the NUL-parser wire format, the
  `@babel/traverse` scope-shadowing boundary, the `retrySync` shadowing bypass,
  the spread/computed/method options bypass, and the ES2022 string-literal
  import form — each verified against real Node/Babel behavior, not assumed.
