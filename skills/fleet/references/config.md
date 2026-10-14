---
summary: The optional .fleet.json - base branch, merge method, test tiers, collision checks, hotFiles, archiveIgnore.
---

# Config — optional `.fleet.json` at the repo root

Never synced; read from the checkout you run in, so commit it — an untracked copy
in one worktree changes behaviour there only. Every key optional. `baseBranch` (a
branch name — `origin/main` is refused; default origin/HEAD, else main),
`mergeMethod` (`pr` default, `direct-squash`, `direct-merge`; fixed into the
train when built), `testCommand` (a string, or ordered tiers; `post-merge` tiers
never run in `land` and are listed as deferred), and `checks` (repo-owned
collision scripts; `land` runs them inside the combined train tree; a failing
`block` check makes a train non-approvable, and one listed with
`"runIn": [..., "ready"]` (opt-in) refuses `ready` too; a timed-out hook's
process tree is terminated, except a descendant that deliberately escapes it).
A monorepo with a long chain:

```json
{ "mergeMethod": "pr",
  "testCommand": { "tiers": [
    { "name": "fast", "command": ["npm", "run", "test:unit"], "stage": "pre-land" },
    { "name": "full", "command": ["npm", "test"], "stage": "pre-land", "timeoutMs": 3600000 },
    { "name": "packaged", "command": ["npm", "run", "test:packaged"], "stage": "post-merge" } ] },
  "checks": [ { "name": "semantic-collisions", "script": "scripts/<your-check>.mjs",
                "runIn": ["status", "land"], "severity": "block" } ] }
```

`hotFiles` (claim-grammar patterns, e.g. `["**/tech-debt.json"]`) are files nearly
every branch touches: an overlap made ONLY of them is listed apart (`[hot]`) and
never blocks; mixed evidence still blocks. A tier or check may carry a one-line
`"note"` (≤300 chars), printed and recorded in the manifest. Landing keys —
`requiredChecks`, `appendOnlyGlobs`, `restackIgnore`, `serialTimeoutMs` — are in
`references/landing.md`; `archiveIgnore` (default `node_modules/**`, `scripts/.claude-skills/**`: gitignored paths that `archive-check` and `prune` treat as disposable) is used by the verbs in `references/ending-a-session.md`.
