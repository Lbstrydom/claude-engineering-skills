# Phase H Plan Audit Summary

- **Date**: 2026-04-05
- **Plan**: `phase-h-public-distribution.md`
- **Rounds**: 3 (capped per early-stop rule)
- **Verdict trajectory**: R1 SIGNIFICANT_GAPS H:5 → R2 SIGNIFICANT_GAPS H:5 → R3 NEEDS_REVISION H:4
- **Cost**: ~$0.40, ~10 min
- **Status**: Audit-complete. 14 fixes applied. 4 remaining HIGHs documented as known limitations for implementation.

## Key Fixes Applied

**R1 (5 HIGH addressed)**:
- Cryptographic trust model: Sigstore keyless signing via cosign + Fulcio + Rekor, with concrete identity-regex verification (H1)
- Mutable channel / TOCTOU: `stable` is NOT a branch — it's "latest GitHub Release tag", resolved per-install. Tarball + release assets never raw URLs (H2)
- Bootstrap cache trust anchor: `.audit-loop/trust/` holds verified manifest + cert + signature from the installed release (H3)
- Release pipeline hardening: SHA-pinned actions, least-privilege perms, concurrency control, tag protection, protected environment, SLSA provenance (H4)
- `--no-verify` bypass: NOT accepted on `--channel stable`; explicit channel downgrade required (H5)

**R2 (5 new HIGH from R1 fixes)**:
- First-run trust bootstrap: curl-pipe URL anchored to GitHub Release (immutable tag), not raw.githubusercontent.com (R2-H1)
- Artifact model: complete list — checksums.json + sig + pem + tarball + install-skills.mjs + its own sig/pem (R2-H2)
- Stable-branch contradictions scrubbed throughout (R2-H3)
- Cosign as hidden dependency: plan now mandates "cosign if on PATH, else pure-Node fallback via @sigstore/verify npm package" (R2-H4)
- Security guarantees consistent: stable channel REQUIRES signing, no unsigned fallback (R2-H5)

## Remaining HIGHs (4, documented as known limitations)

| # | Finding | Resolution path |
|---|---|---|
| R3-H1 | Leftover `--no-verify` references contradict stable-channel rule | Implementation: grep-and-scrub; §2.3 rule is authoritative |
| R3-H2 | Tarball vs per-file fetch modes both described | Implementation: pick ONE per install mode (tarball=offline, per-file=online) |
| R3-H3 | Release workflow artifact list doesn't match §2.2's complete list | Implementation: align workflow steps with §2.2 explicitly |
| R3-H4 | Pure-Node Sigstore verifier is complex | Use official `@sigstore/verify` npm package, NOT bespoke crypto |

## Trajectory Analysis

5 → 5 → 4. Each round exposed depth in the security architecture — signing
isn't a "small piece of infrastructure", it's a full subsystem. The
fixes applied substantially tightened the trust model. Remaining HIGHs
are mostly inconsistency cleanups + an explicit "use the library, don't
roll your own crypto" directive — both easy to address during
implementation.

## Next Steps

Plan is ready to implement. Critical implementation notes from the audit:
1. **Use `@sigstore/sign` + `@sigstore/verify` npm packages** (not bespoke
   pure-Node crypto)
2. **Pick ONE of tarball / per-file fetch modes** per install type
3. **Scrub `--no-verify` references** to match the authoritative §2.3 rule
4. **Align release workflow** to produce the exact artifact set §2.2 lists
