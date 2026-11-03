---
summary: Why nav-audit keeps a static engine beside --verify, and which existing mechanisms already serve coverage honesty.
---

# Design rationale

## Why a static engine at all

Static analysis cannot model arbitrary data-driven nav (`data-view="${x}"`,
`switchView(el.dataset.view)`) — `--verify` is where the authority lives. The
static engine is kept for what live can't do: the pre-deploy gate + completeness
(orphans/unreachable a live crawl never clicks into). Its unit of analysis is the whole
navigation graph — all entry points × all destinations — and it answers: *is
the information architecture coherent — is what's offered what's needed, and
is it sequenced right?* A finding here (e.g. "two nav models coexist") is
literally invisible to a journey test; a journey finding ("this form is dense")
is invisible to a structural map.

It is **static / code-derived, not browser-driven** — for completeness (the
code contains every entry point and destination, including the rarely-hit ones
where orphans and redundancy hide), determinism, and near-zero cost. The static
graph is a set of **hypotheses, not truth** (~80% recall); `--verify` (v1.1)
raises confidence against the live app.

## Coverage honesty, and what is deliberately not (yet) here

- **Coverage honesty, and what is deliberately not (yet) here**
  (`references/verification-discipline.md` §7): two existing mechanisms are
  already instances of the kernel's obligations — the `coverage-gap` finding
  kind above (a surface the model can't confirm is reachable is *reported*,
  not silently dropped) and the `authLiveness` degradation table (a run
  without a live auth sentinel degrades authoritative `misplaced`/`missing`
  verdicts to `unverified`, "rather than asserting a scorecard for the wrong
  surface"). A full per-run subject-line and per-edge taxonomy-classified
  rendering is **deferred, by name**: nav-audit's structured output is
  rendered by `scripts/nav-audit.mjs`, not composed from this file, so
  closing that gap is a code change outside this doc's own scope.
