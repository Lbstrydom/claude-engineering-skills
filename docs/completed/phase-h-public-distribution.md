# Plan: Phase H — Public-Distribution Hardening

- **Date**: 2026-04-05
- **Status**: Complete (shipped — `install.mjs` (one-shot installer with key collection) + `scripts/check-deps.mjs` (dependency audit) + `scripts/lib/assert-repo-root.mjs` (boundary guard called by every entry point) + `.claude/settings.local.example.json` (per-developer personal-config template, gitignored from public repo). Repo is publicly distributable via `npx github:Lbstrydom/claude-engineering-skills`. Status line corrected 2026-05-23.)
- **Author**: Claude + Louis
- **Parent**: [skill-bundle-mega-plan.md](./skill-bundle-mega-plan.md)
- **Depends on**: Phase G complete (pluggable adapters shipped)
- **Scope**: supply-chain integrity, signed checksums, release channels, security audit, first public launch. No new runtime features — release-engineering + security.

---

## 1. Context

Phases E/F/G built the skill bundle, install infrastructure, and pluggable
storage. Phase H makes the repo safe + trustworthy for public consumption.

The current distribution model (Phase F) fetches scripts from GitHub raw URLs
and executes them — trusting the `main` branch implicitly. For a few users this
is fine; for public distribution we need supply-chain integrity so consumers
can verify what they're running.

### Key Requirements

1. **Signed checksums** — every release publishes a signed SHA manifest as a GitHub Release asset
2. **Release channels** — `main` (latest, unverified) vs `stable` (tagged, verified)
3. **Checksum verification in installer + bootstrap** — fetch checksums, verify downloaded scripts, fail if mismatch
4. **Security audit** — env var handling, secret patterns, CODEOWNERS defaults, dependency vulnerabilities
5. **Community docs** — SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md
6. **Automated release workflow** — GitHub Action cuts tagged releases with checksums

### Non-Goals

- npm package publishing (GitHub raw URLs remain the distribution channel)
- Code signing via GPG/Sigstore (future — simple SHA manifest is enough for v1)
- Reproducible builds (scripts are plain JS, no build step)
- CVE scanning integration (GitHub's default Dependabot is enough for v1)
- Legal review of licensing (MIT assumed, operator confirms)

---

## 2. Proposed Architecture

### 2.1 Release Channels (fix R1-H2 — no mutable channels on the verification path)

Two channels, each with a **different trust model**:

| Channel | Source | Trust model |
|---|---|---|
| `stable` (default) | GitHub Release assets at a **specific tag** (e.g. `v1.0.0`) | Immutable. Signed checksums. Tag SHA is fixed. |
| `main` | `raw.githubusercontent.com/.../main/...` | Mutable. No signing. Marked INSECURE. Explicitly opt-in via `--channel main --allow-unsigned`. |

**Critical difference from v1 plan**: `stable` is NOT a branch. It's **the
latest GitHub Release tag**. The installer resolves `--channel stable` by:

1. Fetch `https://api.github.com/repos/Lbstrydom/claude-engineering-skills/releases/latest`
2. Extract the tag name (e.g. `v1.2.3`)
3. Fetch ALL artifacts (checksums.json, .sig, .pem, skills-bundle.tar.gz) FROM
   that tag's Release assets — NOT from raw.githubusercontent.com
4. Verify signature as per §2.2
5. Expand tarball locally, verify each file's checksum
6. Install verified files

**No TOCTOU window**: the tag is fixed after step 2; all subsequent fetches
reference the immutable tag. The signature was produced by the workflow
that created THIS specific tag. The tarball is a self-contained archive,
not a set of raw URL fetches that could drift.

**`main` channel explicitly insecure**: operators who choose it must pass
`--allow-unsigned`. Default CLI behavior refuses unsigned installs on any
channel that claims to be `stable`.

**Release cadence**: when a new version ships, the release workflow creates
a new tag + Release. `stable` channel consumers always get the latest tag.
No `stable` branch — there's nothing to push.

**First-run trust bootstrap** (fix R2-H1):

The very first `curl` fetch happens before ANY local trust anchor exists.
We anchor first-run trust to **GitHub Release URLs** (immutable per tag),
never `raw.githubusercontent.com` (mutable branches).

README's documented install command uses a tag-pinned GitHub Release URL:
```bash
curl -fsSL https://github.com/Lbstrydom/claude-engineering-skills/releases/download/v1.0.0/install-skills.mjs | node -
```

On each release, the README is updated to reference the new tag. Users can
also verify the installer signature BEFORE piping to node (documented
alternative in SECURITY.md + README).

Trust has to start somewhere; we anchor it to signed GitHub Release assets.

### 2.2 Signed Checksum Manifest

**Published with each release** as a GitHub Release asset:

Release assets (fix R2-H2 — explicit complete list):

```
Release v1.0.0 assets:
├── checksums.json              # canonical manifest of all SHAs
├── checksums.json.sig          # detached signature
├── checksums.json.pem          # signing certificate from Sigstore
├── skills-bundle.tar.gz        # archive of skills/ + scripts/ + metadata for offline install
├── install-skills.mjs          # standalone installer script (tag-signed)
├── install-skills.mjs.sig      # detached signature for install-skills.mjs
├── install-skills.mjs.pem      # signing certificate
└── checksums.json entries cover EVERY file distributed this release
```

The `.sig` + `.pem` for install-skills.mjs are separate from checksums.json's
signature — because the installer is the first-run bootstrap, it must be
verifiable independently before checksums.json is trusted. Individual
signatures for:
- `install-skills.mjs` (first-run entry point)
- `checksums.json` (trust manifest for everything else)

All other artifacts (skills, scripts, metadata) are verified via their
SHA256 entries in checksums.json, not individually signed.

**`checksums.json` structure**:

```json
{
  "version": "v1.0.0",
  "releasedAt": "2026-05-15T12:00:00Z",
  "bundleVersion": "a3bc12de4f56-20260515",
  "files": {
    "skills/audit-loop/SKILL.md": "sha256-abc1234...",
    "skills/plan-backend/SKILL.md": "sha256-def5678...",
    "scripts/install-skills.mjs": "sha256-...",
    "scripts/check-skill-updates.mjs": "sha256-...",
    "scripts/lib/stores/noop-store.mjs": "sha256-...",
    "skills.manifest.json": "sha256-..."
  }
}
```

**Cryptographic trust model** (fix R1-H1 — concrete, implementable spec):

v1 uses **Sigstore cosign keyless signing** with OIDC identity from GitHub
Actions. This is the industry-standard approach as of 2024+ and is what
`anthropic/skills`, `npm`, and many official projects use.

Concrete mechanism:
1. Release workflow runs on GitHub-hosted runner with `id-token: write` permission
2. Workflow installs `cosign` (v2+) and signs `checksums.json` using
   `cosign sign-blob --yes checksums.json`
3. Cosign fetches an OIDC token from the runner, exchanges it with Sigstore's
   Fulcio for a short-lived signing certificate bound to the workflow identity
   (`repo:Lbstrydom/claude-engineering-skills:ref:refs/tags/v1.0.0`)
4. Produces `checksums.json.sig` (signature) + `checksums.json.pem` (cert)
5. Both uploaded as Release assets alongside the manifest
6. Transparency log entry published to Rekor (public, append-only)

Verification options (fix R2-H4 — no hidden dependency):

**Option A (recommended, requires cosign installed)**: native `cosign verify-blob`:
```bash
cosign verify-blob \
  --certificate checksums.json.pem \
  --signature checksums.json.sig \
  --certificate-identity-regexp="^https://github\.com/Lbstrydom/claude-engineering-skills/\.github/workflows/release\.yml@refs/tags/v.*$" \
  --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
  checksums.json
```

**Option B (no external dependency, what the installer uses by default)**:
pure-Node verification via the Rekor transparency log API.

The installer `scripts/lib/verify-sigstore.mjs` implements:
1. Fetch the Rekor log entry by UUID (UUID is in the release asset `checksums.json.rekor-uuid.txt`)
2. Verify the entry's inclusion proof against Rekor's current tree root
3. Extract the signing certificate from the log entry
4. Verify the cert's identity claims match the expected workflow ref
5. Verify the signature over `checksums.json` using the cert's public key
6. Verify the cert chains to Sigstore's Fulcio root (pinned in `scripts/lib/sigstore-roots.mjs`)

This uses only Node's built-in `crypto` + `fetch`. Zero npm deps, zero
external binaries. Slower than `cosign` but portable.

Installer flow: prefer local `cosign` when found on PATH (faster), fall
back to built-in pure-Node verification.

**The identity regex** pins verification to: (1) this specific repo, (2) the
release workflow specifically, (3) tag refs only (not branches). This
prevents attackers from signing a checksums.json via an unrelated workflow
in the same repo.

**No unsigned fallback on `stable`** (fix R2-H5 — consistent security guarantee):

Sigstore signing IS the Phase H security guarantee for the `stable` channel.
If cosign proves too complex to implement, Phase H is **NOT DONE**. We do
not ship a `stable` channel without signatures — that would be false
advertising. Unsigned content is always `main` channel with `--allow-unsigned`.

Fallback is only: ship Phase H without any `stable` channel at all, delay
public launch until signing is working. No middle ground.

**Distribution**: `checksums.json`, `checksums.json.sig`, `checksums.json.pem`
are ALL published as GitHub Release assets — never fetched from
`raw.githubusercontent.com` (which has no integrity guarantee beyond TLS).

### 2.3 Checksum Verification in Installer

`scripts/install-skills.mjs` gains a `--verify` flag (default ON for `stable`
channel, default OFF for `main`):

**Flow**:
1. Before any file write, fetch `checksums.json` from the resolved release tag (never a mutable branch)
2. If `--channel stable` → also fetch `checksums.json.sig`, verify signature
3. For each file to be written: fetch content, compute SHA256, compare to manifest
4. On mismatch: **abort install**, exit 1 with specific file + expected/actual SHAs
5. Only proceed with install if all checksums verify

**Consumer-facing flag** (fix R1-H5 — no silent escape hatch on stable):
- `--no-verify` NOT ACCEPTED on `--channel stable`. Exits 1 with error:
  `"--no-verify is incompatible with --channel stable. Use --channel main if you need unverified installs, with --allow-unsigned."`
- On `--channel main`: `--allow-unsigned` flag required. Logs loud warning on every invocation.
- Verification failures are NEVER auto-bypassed. Operator must explicitly downgrade channel.

**Bootstrap cache verification** (fix R1-H3 — explicit trust anchor):

After a successful `--channel stable` install, the bootstrap stores:
- `.audit-loop/trust/checksums.json` — the verified manifest from the
  installed release
- `.audit-loop/trust/checksums.json.pem` — the signing certificate
- `.audit-loop/trust/checksums.json.sig` — the signature
- `.audit-loop/trust/installed-tag.txt` — e.g. `v1.2.3`

These files are the **trust anchor** for subsequent cached script executions.
Before executing a cached script, bootstrap:

1. Read the local trust anchor (or fail if missing — force re-install via `--channel stable`)
2. Compute the cached script's SHA256
3. Look up its expected SHA in the local `checksums.json`
4. On mismatch → delete cached script, re-fetch from the same release tag,
   re-verify against the trust anchor

Trust anchor is only updated by a fresh `--channel stable` install, which
re-verifies the Sigstore signature against the new manifest. Cached scripts
can never drift undetected because the manifest is immutable for a given
release tag.

**Gitignored** (not committed to consumer repo): `.audit-loop/trust/`
contains per-machine trust state, not repo state.

### 2.3a Failure-Path Specification (fix R1-M2)

Every fetch + verification path has defined behavior on failure:

| Failure | Behavior | Exit code |
|---|---|---|
| GitHub API 404 (release not found) | Error: "release not found at tag X — check release channel" | 1 |
| GitHub API 403 (rate limit) | Retry with exponential backoff (3 attempts, 1s/2s/4s). Still 403 → error with `Retry-After` hint | 1 |
| GitHub API 5xx | Retry 3 attempts. Still failing → error, fall back to cached trust anchor | 1 |
| Network timeout (10s) | Retry 2 attempts. Still timeout → error, fall back to cached trust anchor | 1 |
| Partial download (bytes < Content-Length) | Discard, retry once. Still partial → error | 1 |
| Signature verification failure (Sigstore / cosign) | Error: "checksums.json signature invalid — DO NOT TRUST this release". **NEVER auto-fallback.** | 1 |
| Checksum mismatch on skill file | Error naming the file + expected/actual SHA. Abort install | 1 |
| Manifest missing file entry | Error: "manifest for release X does not list skill/file Y" | 1 |
| Extracted tarball contains unexpected path | Error (path traversal guard): "tarball entry Y outside expected directory" | 1 |
| Local trust anchor corrupted | Error: "trust anchor missing/corrupt — run install --channel stable to reinitialize" | 1 |

No failure path silently degrades verification.

### 2.3b Artifact Set Schema (fix R1-M3)

**New file**: `scripts/lib/release-artifacts.mjs` — single source of truth
for the set of files in every release. Used by:
- release workflow (what to sign + upload)
- installer (what to verify)
- bootstrap (what to look up in checksums.json)
- update checker (what paths to compare)

```javascript
export const RELEASE_ARTIFACTS = Object.freeze({
  // Files bundled in skills-bundle.tar.gz AND individually SHA-hashed
  skills: [
    'skills/audit-loop/SKILL.md',
    'skills/plan-backend/SKILL.md',
    'skills/plan-frontend/SKILL.md',
    'skills/ship/SKILL.md',
    'skills/audit/SKILL.md',
  ],
  // Installer tooling fetched per install
  scripts: [
    'scripts/install-skills.mjs',
    'scripts/check-skill-updates.mjs',
    'scripts/lib/bootstrap-template.mjs',
    // ... full list
  ],
  // Metadata files
  metadata: [
    'skills.manifest.json',
    'bundle-history.json',
  ],
});
```

Single import used everywhere. Adding a file to the release means ONE edit.

### 2.4 Automated Release Workflow

**New file**: `.github/workflows/release.yml`

Triggers on push of semver tags (`v*.*.*`). Steps:

1. Build canonical `skills-bundle.tar.gz` from `skills/` directory
2. Compute SHA256 of every file in `skills/` + `scripts/` + `skills.manifest.json`
3. Write `checksums.json` with all SHAs
4. Sign manifest (GitHub OIDC → cosign-equivalent)
5. Create GitHub Release with: tarball, checksums.json, checksums.json.sig
6. (no branch update — `stable` is always "latest release tag", resolved via GitHub API)
7. (no branch push)

**Manual release trigger**: `workflow_dispatch` for on-demand releases. Louis
cuts a release by running the workflow or pushing a tag.

**Release notes**: auto-generated from commit messages between previous tag
and current tag, published in the GitHub Release description.

**Supply-chain hardening** (fix R1-H4 — required controls on release workflow):

| Control | Implementation |
|---|---|
| SHA-pinned actions | All `uses:` lines pin to full commit SHA (not tag), e.g. `actions/checkout@b4ffde65...` |
| Least-privilege permissions | Job-level `permissions:` scoped to: `id-token: write` (for cosign), `contents: write` (for release + tag), no `pull-requests:`, no `issues:` |
| Concurrency control | `concurrency: { group: release, cancel-in-progress: false }` — only one release workflow at a time |
| Tag protection | GitHub repo setting: `v*.*.*` tags require approval from CODEOWNERS before creation via Actions |
| Protected environment | Release workflow uses `environment: production` which requires manual approval for the first N releases (can be relaxed later) |
| Guardrails on inputs | `workflow_dispatch` inputs validated server-side (tag must match semver regex) |
| No secrets in logs | Workflow uses `::add-mask::` for any intermediate values |
| Provenance attestation | `actions/attest-build-provenance@v1` generates SLSA L3 provenance for every artifact |
| Checkout with `persist-credentials: false` | Default is true; explicitly false to prevent credential leak into signing steps |

These controls are standard for OSS projects publishing signed artifacts.
Not optional — they ship together with the signing mechanism or the signing
is theatre.

### 2.5 Security Audit + Documentation

**Automated security audit** (fix R1-M1 — runs on every PR, not one-off):

New workflow `.github/workflows/security-audit.yml` runs:
- `npm audit --audit-level=high` — fails on HIGH/CRITICAL vulnerabilities
- `gitleaks detect --no-git` — scans working tree for leaked secrets
- Custom check: no matches for known-secret regex in committed files (our own `secret-patterns.mjs` scanner)
- Custom check: every `.env.example` placeholder is `<placeholder>` shape, not real
- Custom check: `execFileSync` used everywhere (no shell strings)
- Custom check: every `.github/workflows/*.yml` uses SHA-pinned actions
- Fail-the-check on any violation

This runs on every PR. Can't regress after launch.

**Security audit checklist** (one-pass before first public release, supplements the workflow):

- [ ] No API keys, tokens, or personal refs in committed code (search `grep` for common shapes)
- [ ] `.env.example` has placeholders only (already done)
- [ ] Every shell-exec uses `execFileSync` with argv arrays (no shell strings, already enforced in Phase C linter)
- [ ] Secret-pattern scanner coverage includes all common keys (Phase D.2)
- [ ] CODEOWNERS defaults set to `@Lbstrydom` for all paths
- [ ] Dependabot enabled for npm + GitHub Actions
- [ ] `package.json` has no `postinstall` scripts that execute fetched code
- [ ] Installer uses `execFileSync` for git/gh commands, never shell-interpolated user input
- [ ] All URLs baked into code point to the public renamed repo (no leftover `claude-audit-loop` refs)
- [ ] Test fixtures use synthetic values (no AWS docs values, no real-format tokens — already done)

**Community documentation** (new files):

| File | Content |
|---|---|
| `SECURITY.md` | How to report vulnerabilities (email or GitHub private advisory), supported versions, response SLA |
| `CONTRIBUTING.md` | Dev setup, test commands, PR process, skill authoring guidelines |
| `CODE_OF_CONDUCT.md` | Contributor Covenant v2.1 (standard) |
| `LICENSE` | MIT (operator confirms) |
| `.github/ISSUE_TEMPLATE/bug_report.md` | Bug template |
| `.github/ISSUE_TEMPLATE/feature_request.md` | Feature template |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR checklist incl. tests + audit-loop run |

### 2.6 Dependabot + Security Scanning

`.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
```

GitHub's native secret scanning + code scanning alerts enabled via repo
settings (manual action, one-time).

### 2.7 Public Launch Checklist

Separate from the technical implementation — a launch runbook:

- [ ] Verify all docs/setup/*.md walkthroughs work end-to-end on clean machines
- [ ] Clean Supabase project (remove any smoke-test data)
- [ ] Update repo description + topics on GitHub
- [ ] Enable GitHub Discussions for community Q&A
- [ ] Write launch blog post / README top-banner
- [ ] (no branch setup — v1.0.0 tag + GitHub Release is the `stable` pointer)
- [ ] Announce via whatever channels make sense

---

## 3. File Impact Summary

**New files**:

| File | Purpose |
|---|---|
| `.github/workflows/release.yml` | Automated tagged-release workflow |
| `.github/dependabot.yml` | Weekly dep updates |
| `.github/ISSUE_TEMPLATE/*.md` | Bug + feature templates |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR checklist |
| `SECURITY.md` | Vulnerability reporting + supported versions |
| `CONTRIBUTING.md` | Dev + contribution guide |
| `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1 |
| `LICENSE` | MIT |

**Modified files**:

| File | Change |
|---|---|
| `scripts/install-skills.mjs` | Add `--channel`, `--verify`, `--no-verify` flags |
| `scripts/lib/bootstrap-template.mjs` | Cache verification before execution |
| `scripts/check-skill-updates.mjs` | Honor release channel |
| `README.md` | Add security section, channel selection, verification flow |
| `CODEOWNERS` | Default owners for all paths |

**No changes to**: skills content, existing scripts beyond flag additions,
storage adapters, tests (new Phase H tests added separately).

---

## 4. Testing Strategy

### Unit Tests

| Test | Validates |
|---|---|
| Checksum verification: manifest match → install proceeds | Positive case |
| Checksum verification: manifest mismatch → install aborts | Safety |
| Checksum verification: missing manifest + `--channel stable` → fail | Channel policy |
| `--no-verify` on stable channel logs warning, proceeds | Override semantics |
| Bootstrap cache verification: stale SHA → re-fetch | Cache integrity |
| Release workflow YAML syntax valid | Workflow correctness |
| `checksums.json` format validates against Zod schema | Manifest integrity |

### Integration Tests

- Fake GitHub Release with bad checksum → installer aborts
- Fake GitHub Release with valid checksum → installer succeeds
- `--channel main` bypasses checksum verification (with log warning)
- Stable channel URL resolves to latest tag

### Release Workflow Dry-Run

Before cutting v1.0.0, run the workflow against a throwaway tag (`v0.9.0-rc`)
to verify:
- Tarball builds correctly
- Checksums.json generated
- Signature valid
- No branch updates (tag + Release is the pointer)

### Manual Pre-Launch Verification

- Fresh clone + install on Linux, macOS, Windows (3 machines)
- Verify each documented `docs/setup/*.md` walkthrough actually works
- Verify `gh repo view` shows correct name, description, topics
- Verify Dependabot + secret scanning enabled

---

## 5. Rollback Strategy

**Rolling back bad releases WITHOUT breaking provenance** (fix R1-M4):

- **NEVER delete a published Release or tag** — consumers may have pinned to it, cached it, or linked to it. Deletion breaks their verification.
- **Instead: publish a new release** (`v1.2.4`) that supersedes the bad one. `stable` channel auto-advances to latest tag.
- Yanked releases: mark as "pre-release" on GitHub (removes them from "latest" but preserves the artifacts + signatures). Document the reason in the yanked Release's body.
- **Critical-vulnerability CVE process**: separate SECURITY.md advisory published via GitHub Security Advisories. Patch release within 72hrs.

| Scenario | Response |
|---|---|
| Bad content in release | Publish superseding release, mark bad release as pre-release (preserves artifacts) |
| Bad checksums.json (metadata, content fine) | Publish new release with corrected manifest; artifacts re-signed |
| Bad signature | Publish new release; old signature stays but signed-cert identity mismatches prevent trust |
| Compromised signing key / workflow | CVE advisory + revoke cosign identity via Sigstore; new release with rotated trust anchor |
| Bad workflow logic | Disable workflow, cut releases manually using `cosign sign-blob` locally until fixed |

Phase H additions are release infrastructure + docs. No runtime code changes
that require application-level rollback.

---

## 6. Implementation Order

1. **Security audit checklist** — run through items in §2.5, fix anything found. May spawn sub-tasks.
2. **Community docs** — SECURITY, CONTRIBUTING, CODE_OF_CONDUCT, LICENSE, ISSUE_TEMPLATEs, PULL_REQUEST_TEMPLATE. Zero code, high leverage.
3. **Dependabot config** — `.github/dependabot.yml`. Enable in repo settings.
4. **Release workflow** — `.github/workflows/release.yml` (tarball + checksums + signing + release). Test against `v0.9.0-rc` throwaway tag.
5. **Checksum verification in installer** — `--verify` flag, manifest fetch, SHA compare, abort on mismatch. Tests.
6. **Bootstrap cache verification** — verify cached scripts against last-known-good before execution. Tests.
7. **Release channels** — `--channel stable|main` flag, URL resolution per channel. Tests.
8. **README public-facing rewrite** — security section, channel explanation, verification flow, install commands for both channels.
9. **Manual pre-launch verification** — fresh installs on 3 OSes, walkthrough each setup guide.
10. **Cut v1.0.0** — push tag, workflow runs, GitHub Release + signed assets published.
11. **Public launch** — GitHub Discussions enabled, blog post / top-banner, topics set.

---

## 7. Known Limitations (accepted for Phase H)

**Limitations surfaced by R3 audit** (stopping at 3 rounds per early-stop rule):

1. **Leftover `--no-verify` references** (R3-H1): several sections still
   mention `--no-verify` as a possible flag despite §2.3's "never accepted on
   stable" rule. Implementation MUST scrub these — the rule is authoritative.
2. **Tarball-vs-individual-files flow** (R3-H2): §2.1 describes tarball
   expansion; §2.3 describes per-file fetch. These are alternative
   distribution modes; implementation picks ONE. Recommendation: tarball
   for offline install, individual fetch for online install. Plan should
   pick explicitly at implementation start.
3. **Release workflow artifact list** (R3-H3): §2.4's workflow steps don't
   match §2.2's complete artifact list. Implementation MUST align them.
4. **Pure-Node Sigstore verifier complexity** (R3-H4): the Option B pure-Node
   verifier is non-trivial (cert chain validation, Rekor inclusion proofs).
   Defer to implementation: try cosign-on-PATH first, fall back to
   `@sigstore/sign` + `@sigstore/verify` npm packages (maintained by Sigstore
   team) if no cosign binary found. **Avoid bespoke crypto.**

**Other known limitations**:


1. **GPG / Sigstore full crypto** — v1 uses GitHub-OIDC-backed signing OR plain SHA256 manifest. Full Sigstore integration is future-phase.
2. **Reproducible builds** — scripts are plain JS, no build step, so "reproducibility" is trivial. Tarball contents may vary by 1 byte (timestamp metadata) between re-runs of the release workflow; not a real concern.
3. **No supply-chain attestations (SLSA)** — future-phase.
4. **Dependabot is our only vuln scanner** — GitHub's built-in, not a dedicated SAST tool.
5. **Manual launch checklist** — not automated. Low-frequency activity, manual is fine.
6. **License compatibility audit** — operator confirms MIT is appropriate; no automated dep-license auditing in Phase H.
7. **Public issue triage SLA** — none committed; `SECURITY.md` documents best-effort response.

---

## 8. Resolved Design Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| Q1 | Signing scheme? | Sigstore keyless signing (cosign + Fulcio + Rekor), enforced for `stable` channel (fix R2-H5) | Industry standard, no private-key management, auditable via Rekor |
| Q2 | Distribution channel? | GitHub raw URLs + GitHub Releases (no npm) | Matches existing Phase F pattern |
| Q3 | Release channels? | `main` (latest) + `stable` (tagged) | Two-tier is standard; covers dev + prod use cases |
| Q4 | Default channel for consumers? | **`stable`** (single default). `main` requires explicit `--channel main --allow-unsigned` | Safe-by-default, no ambiguous "two defaults" (fix R1-L1) |
| Q5 | License? | MIT | Standard permissive open-source; operator confirms |
| Q6 | CVE scanning? | Dependabot only in v1 | GitHub-native, zero config |
| Q7 | Community code? | Adopt Contributor Covenant 2.1 | Industry standard |
| Q8 | Verification mandatory on `stable`? | **Mandatory, no opt-out.** `--no-verify` incompatible with `--channel stable` | Verification is the WHOLE POINT of stable channel (fix R1-H5) |
| Q9 | Release cadence? | On-demand + automated on tag push | Louis controls cadence |
| Q10 | Launch announcement? | Manual — blog post + repo banner + GitHub Discussions | Low-volume, high-touch |
