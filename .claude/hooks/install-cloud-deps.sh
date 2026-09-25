#!/bin/bash
# Cloud-only dependency install for consumer repos.
#
# A Claude Code cloud environment's "Setup script" field runs BEFORE the repo
# is checked out to its final path, so a plain `npm install` (or pnpm/yarn
# equivalent) placed there fails looking for package.json in the wrong place:
# https://code.claude.com/docs/en/cloud-environments#setup-scripts-vs-sessionstart-hooks
# SessionStart hooks run AFTER checkout instead, in both local and cloud
# sessions -- the CLAUDE_CODE_REMOTE check below is what keeps this a no-op
# locally, where dependencies are already installed by hand.
if [ "$CLAUDE_CODE_REMOTE" != "true" ]; then
  exit 0
fi

if [ -f pnpm-lock.yaml ]; then
  corepack pnpm install
  PLAYWRIGHT_RUNNER="corepack pnpm exec playwright"
elif [ -f yarn.lock ]; then
  yarn install
  PLAYWRIGHT_RUNNER="yarn playwright"
else
  npm install
  PLAYWRIGHT_RUNNER="npx playwright"
fi

# Only fetch a browser binary if the repo actually declares Playwright as a
# dependency -- most consumers don't, and the download costs real
# environment-cache build time (docs' own five-minute setup-script ceiling).
if grep -qE '"(@playwright/test|playwright)"' package.json 2>/dev/null; then
  $PLAYWRIGHT_RUNNER install --with-deps chromium
fi

exit 0
