# Arm-eval session f380a9e3-add3-4420-93f2-93dc20034c3c

| Field | Value |
|---|---|
| Experiment | brainstorm |
| Phase | prospective |
| Task id | `task-33303e43` |
| Seed (presentation-order RNG) | 2236801743 |
| Config / rubric version | 1 / 1 |
| Created (UTC) | 2026-07-03T18:28:59.401Z |
| Repo | 8548afbd-8d85-50de-baca-1bb158d696da |
| Archive mode | BLINDED (prospective, human ranking pending — arm identity/models/scores withheld to protect the anchor) |

## Task

one sentence: biggest single risk of vendoring a JS dependency instead of using npm?

## Outputs (blinded — rank via `arm-eval-adjudicate`)

### output-1

The biggest risk is creating a silent fork: once vendored, the dependency falls out of npm’s update and vulnerability tooling, so security fixes, bug fixes, and compatibility updates must be tracked manually and can easily be missed.

### output-2

The biggestsingle risk of vendoring a JS dependency is **silent rot**: by stepping outside npm's ecosystem tooling, you lose automated advisory tracking, transitive dependency resolution, and update signals, so your vendored copy quietly becomes an untracked, unpatched fork where a critical upstream CVE can sit unnoticed for years.

**The Honest Trade-off:**
Vendoring buys you immunity to left-pad-style supply chain attacks and malicious maintainer takeovers, but you're trading passive safety for active maintenance. The npm ecosystem is designed around automated dependency management; when you vendor, you bet that your team's vigilance will outperform an automated bot—and it usually won't.

**Actionable Takeaway:**
If you must vendor (abandoned library, security-critical lockdown), treat the vendored folder as an active fork, not a frozen artifact. Set up a CI cron job that periodically diffs your copy against upstream release tags and alerts on commits containing security keywords. Do not rely on developers manually checking for updates—because they won't.

### output-3

**The One Sentence:**
The biggest single risk of vendoring a JavaScript dependency is becoming permanently blind to critical security patches because copy-pasted code bypasses automated vulnerability scanners (like `npm audit` or Dependabot), leading to silent security rot.

### The Core Risk: Silent Security Rot
When you vendor a dependency by copying its source into your repo, you sever the signal chain provided by the JS ecosystem's security tooling. Your lockfile no longer tracks it, automated scanners can't resolve it to known advisories, and no upgrade PR is generated when a patch lands. 

Unlike maintenance burden (which is painful but obvious) or bundle bloat (which is measurable), security rot is silent and asymmetric. You get no signal, and the downside is a known CVE sitting in your production app that nobody knew to patch. Humans are notoriously bad at manually monitoring security advisories, which is exactly why this automated tooling exists.

### The Honest Trade-Off
Vendoring is sometimes the *right* call, but it exchanges ecosystem-backed safety nets for manual ownership of the entire lifecycle.

**Why it’s tempting:**
- **Absolute immutability:** You are immune to the "left-pad" problem (an author unpublishing a package) or registry outages.
- **Supply chain security:** You are protected from malicious actors hijacking a maintainer's account and publishing a compromised version that your CI automatically pulls.
- **Deep customization:** You can tweak the source code for hyper-niche use cases without dealing with fork-publishing mechanics.

**Why it bites back:**
- **The update black hole:** When a CVE is disclosed, GitHub, Snyk, and npm will not warn you. You have to actively monitor the original project.
- **Update inertia:** Because upgrading vendored code requires manually pulling files and resolving merge conflicts, developers simply *won't do it*. The code rots.
- **Bundle bloat:** If you vendor `Library A` but install `Library B` via npm, and `Library B` depends on `Library A`, your bundler cannot deduplicate them. You will ship `Library A` to your users twice.

### Diverse Angles on the Risk
- **The Legal/Compliance Angle:** Tools that automatically generate SBOMs (Software Bill of Materials) and scan for license compliance rely on `package.json` and `node_modules`. Vendored code is invisible to these scanners, risking accidental licensing violations (e.g., silently shipping GPL code in a proprietary app).
- **The TypeScript / DX Angle:** Vendoring a raw `.js` file often loses the ecosystem's type definitions (`@types/package`). You trade tooling integration for raw code possession, worsening the developer experience.
- **The Git History Bloat Angle:** Vendoring large dependencies pollutes your Git history. `git grep` becomes noisy, PR diffs get massive, and cloning your repository gets slower.

### Actionable Takeaways: How to Vendor Intelligently
If your threat model dictates that you *must* vendor dependencies, do not just copy-paste files into a `vendor/` folder and forget about them. Treat vendoring as a managed process:

1. **Use Modern Ecosystem Vendoring (The Best Alternative):** Instead of raw copy-pasting, use **Yarn Zero-Installs** (or pnpm equivalents). This checks a zip archive of the dependency directly into your Git repo, giving you 100% offline reliability and immutability, *but* the package manager still knows it's there. You get Dependabot alerts, `npm audit` support, and easy upgrade paths.
2. **Use Git Submodules or Subtrees:** If you must copy files, use submodules or subtrees rather than detached files. This keeps a tether to the upstream repository, allowing you to pull security patches without losing your local modifications.
3. **Maintain a Vendoring Manifest:** If you end up with a flat copy, create a `vendor.json` logging exactly *which* version was copied, the date, the original commit hash, and the license. Wire it into scanning using tools like `osv-scanner` or Syft.
4. **Subscribe to the source:** For high-risk packages (like auth libraries), actively turn on GitHub release notifications for the upstream repository so a human is alerted when a patch drops. Set a recurring review cadence (quarterly minimum) on a calendar.
5. **Document *why* it's vendored:** If the reason expires (e.g., upstream merged your patch), un-vendor it immediately. 

Vendoring trades an active, ecosystem-backed security signal for a promise you make to yourself. That promise is the risk.

