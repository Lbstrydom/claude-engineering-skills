#!/usr/bin/env node
// Fixture: a fake CLI that claims to refuse --gate without --verify, but
// actually exits 0 unconditionally. The cli-exit oracle must catch this.
process.exit(0);
