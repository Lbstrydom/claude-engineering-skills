---
description: 'Consumer-sync tripwires: declared divergence, the sync-path-map oracle, the consumer package manager.'
applyTo: 'scripts/sync-*.mjs, scripts/lib/sync-*.mjs, scripts/lib/package-manager.mjs, scripts/lib/install/**, scripts/install-skills.mjs, scripts/skills-hydrate.mjs, .sync-overrides.json, .sync-receipt.json'
paths:
  - "scripts/sync-*.mjs"
  - "scripts/lib/sync-*.mjs"
  - "scripts/lib/package-manager.mjs"
  - "scripts/lib/install/**"
  - "scripts/install-skills.mjs"
  - "scripts/skills-hydrate.mjs"
  - ".sync-overrides.json"
  - ".sync-receipt.json"
---

# Consumer sync — path-scoped tripwires

Moved from `AGENTS.md` §Consumer-repo layout (text verbatim, links re-rooted to
this folder), whose resident stub names each one. This file and
`.github/instructions/consumer-sync.instructions.md` are byte-identical twins
(Claude Code reads the first, the VS Code Copilot harness the second);
`tests/path-scoped-instructions-twins.test.mjs` fails when they differ.

> **Consumer divergence is DECLARED, never inferred — and the sync must never
> revert it silently.** The **manifest hash, never HEAD**, is the three-way BASE;
> standing divergence lives in the committed `.sync-overrides.json`
> (`scripts/.claude-skills/**` is never claimable — that is an upstream report);
> and the committed, append-only `.sync-receipt.json` is a deliberate
> generated-artifact-policy exception, because its dirtiness is the only evidence
> a sync ran. The three mechanics in full (refusal rules, `upstreamMoved`,
> `--overwrite-diverged`) before you touch the sync:
> [consumer-repo-layout.md](../../docs/reference/consumer-repo-layout.md) §Consumer
> divergence · [Plan](../../docs/plans/consumer-sync-durability.md).

## Sync mechanics

Sync detail (isolated subdir, what-goes-where table, managed-gitignore block, `sync-*`
modules): [`consumer-adoption.md`](../../docs/runbooks/consumer-adoption.md) §"Sync internals".
One invariant: **the sync layout's single source of truth is
[`sync-path-map.mjs`](../../scripts/lib/sync-path-map.mjs)** — never hand-compute one.

**A consumer's package manager is [`package-manager.mjs`](../../scripts/lib/package-manager.mjs)'s
answer, never a hardcoded `npm`/`npx`** — the managers are not swappable, so two
lockfiles + no `packageManager` field is **ambiguous and left alone**, never
guessed. Adjudicate an install by RE-PROBING `node_modules`, never the exit code
(pnpm exits non-zero on `ERR_PNPM_IGNORED_BUILDS` after a successful install). The
corepack/`.cmd` trap:
[consumer-adoption.md](../../docs/runbooks/consumer-adoption.md) §Your package manager.
