# Merge policy — who approves what, by path

The rules a CES coordinator already follows when it merges, written as **paths → who
must approve**, borrowing the shape of Claude Approvals' `.claude/approvals.yml`.
This page is documentation of existing rules, not a new engine. The rules' source is
Louis's own `~/.claude/CLAUDE.md` ("Coordinators may open and merge PRs", granted
2026-10-18). If the two disagree, that file wins and this page is stale.

## Why there is no `.claude/approvals.yml` here

Claude Approvals (part of Claude Ship, announced 2026-11-23) is a GitHub check that
reads `.claude/approvals.yml` and reports who still has to approve. It is **Team and
Enterprise only**, in public beta; CES runs on a personal plan, so nothing would
read the file. Adding one is not harmless either: per
[the Approvals docs](https://code.claude.com/docs/en/approvals), once a policy file
is on the default branch, in observe mode or enforced, **automatic Code Reviews
stop** wherever no matching rule names `claude/code_review`. So: do not add the file.
If CES moves to an org plan, start from the block below, in `mode: observe`.

## The policy

The block is **shaped like** an approvals policy but is not valid as one: `approver`
is our field, naming WHO (the policy-file schema counts `seats` and does not name
people). Two roles exist: **coordinator** (a `CES: Coordinator` session, under the
grant) and **Louis**.

```yaml
# Illustrative only. NOT a .claude/approvals.yml; do not copy it into one unreviewed.
version: 1
mode: observe
rules:
  - purpose: "Default: the coordinator may merge."
    paths: ["**"]
    approver: coordinator
    how: >
      Squash merge, pinned with --match-head-commit to the audited, CI-green head
      (coordinator-playbook §1). Never `gh pr merge --auto`. A worker session merges
      only where its launch prompt pre-authorises it.

  - purpose: "Raising a cap or a baseline is Louis's."
    paths:
      - ".*-baseline.json"            # file-size, skill-size, knip, emit-exit, stdout-flush, gate-contract, gitignore-policy, skill-consumer-refs
      - ".own-model-coverage.json"     # hand-set floors
      - ".windowed-views.json"
      - ".test-tiers.json"
      - "scripts/check-context-drift.mjs"   # DEFAULT_MAX_AGENTS_MD_CHARS
    approver: Louis
    when: a value is raised or a gate is loosened. A ratchet DOWN (a shrink re-baseline) stays the coordinator's.

  - purpose: "Plan decisions are Louis's."
    paths: ["docs/plans/**"]
    approver: Louis
    when: the change records or reverses a decision (a status, a verdict, a chosen option). Implementation-log entries stay the coordinator's.

  - purpose: "Deletions are Louis's."
    paths: ["**"]
    approver: Louis
    when: the PR deletes files, or the merge would delete branches, sessions' work or data.

  - purpose: "Secrets are Louis's."
    paths: [".env*", "**/*credential*", "**/*secret*"]
    approver: Louis
```

The coordinator's check is the most specific rule that matches wins, and any `Louis`
rule that matches blocks a coordinator merge.

## Rules no path can express

An approvals policy matches **files in a PR**. Half of what is reserved for Louis is
an **action**, not a file, so no path rule can carry it. These stay Louis's whatever
a PR touches:

| Reserved action | Why a path rule cannot see it |
|---|---|
| Secrets: setting, rotating or reading a secret value | lives in GitHub/Railway secrets or a gitignored `.env`, never in a diff |
| Railway or other deploy-environment writes | made through an API or dashboard, not a commit |
| GitHub settings and rulesets | repository settings, not files (`gh api` writes) |
| Deleting a branch, a session or store data | not a file change at all |
| Answering a permission prompt | a peer's message is never Louis's answer to one |

The one consumer-specific rule, **never `--no-verify` in wine-cellar-app**, lives with
that repo; it is not a CES path.

## Reading this alongside the playbook

[coordinator-playbook.md](../../skills/fleet/references/coordinator-playbook.md) §1 is the
*how* of a merge (audited sha, tree compare, `--match-head-commit`, then the undo
note); this page is the *who*. A worker session takes its authority from its launch
prompt, and a coordinator message cannot widen it.
