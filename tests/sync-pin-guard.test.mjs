/**
 * @fileoverview Guards the supply-chain invariant: a sync may never move a
 * consumer from a pinned local launcher to an unpinned network fetch.
 *
 * The regression this pins (upstream report `5b1a121e`): this repo's
 * `.vscode/mcp.json` uses `npx -y @playwright/mcp@latest`; a consumer had
 * re-pointed both servers at `${workspaceFolder}/node_modules/…` to satisfy its
 * own pinning gate; `deepMerge` gives a source leaf authority and replaces
 * arrays wholesale, so every sync silently un-pinned it.
 *
 * The load-bearing case here is the FALSE-fire direction: this guard sits on
 * every synced JSON, so a classifier that reads an ordinary consumer config as
 * "pinned" would freeze upstream out of files it legitimately owns.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyLaunchSpec, findPinDowngrades, guardPinDowngrades, assertNoPinDowngrade,
} from '../scripts/lib/sync-pin-guard.mjs';

// The two real configurations from the incident, verbatim.
const UPSTREAM_MCP = {
  servers: {
    playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest', '--headless'] },
    mermaid: { type: 'stdio', command: 'npx', args: ['-y', 'mcp-mermaid@latest'] },
  },
};
const CONSUMER_MCP = {
  servers: {
    playwright: {
      type: 'stdio',
      command: 'node',
      args: ['${workspaceFolder}/node_modules/@playwright/mcp/cli.js', '--headless'],
    },
    mermaid: {
      type: 'stdio',
      command: 'node',
      args: ['${workspaceFolder}/node_modules/mcp-mermaid/build/index.js'],
    },
  },
};

describe('classifyLaunchSpec', () => {
  test('fetch-and-run commands are unpinned', () => {
    for (const command of ['npx', 'npx.cmd', 'bunx', 'uvx', 'pnpx']) {
      assert.equal(classifyLaunchSpec({ command, args: ['pkg'] }), 'unpinned', command);
    }
  });

  test('a package-manager subcommand that fetches is unpinned', () => {
    assert.equal(classifyLaunchSpec({ command: 'pnpm', args: ['dlx', 'pkg'] }), 'unpinned');
    assert.equal(classifyLaunchSpec({ command: 'npm', args: ['exec', 'pkg'] }), 'unpinned');
  });

  test('a floating version specifier is unpinned even with a plain command', () => {
    assert.equal(classifyLaunchSpec({ command: 'node', args: ['run', 'pkg@latest'] }), 'unpinned');
  });

  test('a filesystem path is pinned', () => {
    assert.equal(classifyLaunchSpec(CONSUMER_MCP.servers.playwright), 'pinned');
    assert.equal(classifyLaunchSpec({ command: 'node', args: ['./bin/server.js'] }), 'pinned');
    assert.equal(classifyLaunchSpec({ command: '/usr/local/bin/server' }), 'pinned');
  });

  test('an absolute fetcher path is still a fetcher (matched on the basename)', () => {
    assert.equal(classifyLaunchSpec({ command: '/usr/bin/npx', args: ['pkg'] }), 'unpinned');
  });

  test('unreadable shapes are `unknown`, which is inert in both directions', () => {
    for (const spec of [null, undefined, 'npx', [], {}, { args: ['x'] }]) {
      assert.equal(classifyLaunchSpec(spec), 'unknown');
    }
    assert.equal(classifyLaunchSpec({ command: 'my-server' }), 'unknown');
  });
});

describe('findPinDowngrades — the incident', () => {
  test('the real upstream/consumer pair is a downgrade on both servers', () => {
    const hits = findPinDowngrades(CONSUMER_MCP, UPSTREAM_MCP);
    assert.deepEqual(
      hits.map((h) => `${h.key}.${h.server}`).sort(),
      ['servers.mermaid', 'servers.playwright'],
    );
  });

  test('mcpServers is covered too, not just servers', () => {
    const before = { mcpServers: { a: { command: 'node', args: ['./a.js'] } } };
    const after = { mcpServers: { a: { command: 'npx', args: ['-y', 'a@latest'] } } };
    assert.equal(findPinDowngrades(before, after).length, 1);
  });
});

describe('findPinDowngrades — the direction it must NOT fire', () => {
  test('unpinned → unpinned is not a downgrade', () => {
    assert.deepEqual(findPinDowngrades(UPSTREAM_MCP, UPSTREAM_MCP), []);
  });

  test('unpinned → pinned is not a downgrade (a consumer improving is fine)', () => {
    assert.deepEqual(findPinDowngrades(UPSTREAM_MCP, CONSUMER_MCP), []);
  });

  test('a server the consumer did not previously have is not a downgrade', () => {
    // Nothing was un-pinned; upstream is introducing it. Refusing here would
    // block every new server the bundle ever ships.
    const before = { servers: {} };
    assert.deepEqual(findPinDowngrades(before, UPSTREAM_MCP), []);
  });

  test('configs with no server map are untouched', () => {
    assert.deepEqual(findPinDowngrades({ permissions: { allow: [] } }, { permissions: { allow: ['x'] } }), []);
  });

  test('a first sync (no existing file) is not a downgrade', () => {
    assert.deepEqual(findPinDowngrades(null, UPSTREAM_MCP), []);
  });
});

describe('guardPinDowngrades', () => {
  test('restores the consumer spec wholesale, and leaves everything else ours', () => {
    const merged = { ...UPSTREAM_MCP, other: { keep: 1 } };
    const { value, held } = guardPinDowngrades(CONSUMER_MCP, merged);
    assert.equal(held.length, 2);
    assert.deepEqual(value.servers.playwright, CONSUMER_MCP.servers.playwright);
    assert.deepEqual(value.servers.mermaid, CONSUMER_MCP.servers.mermaid);
    // Not half-restored: taking our `args` with their `command` would be a third
    // configuration neither side tested.
    assert.equal(value.servers.playwright.command, 'node');
    assert.deepEqual(value.other, { keep: 1 });
  });

  test('is a no-op when there is nothing to hold', () => {
    const merged = { servers: { ...UPSTREAM_MCP.servers } };
    const { value, held } = guardPinDowngrades(UPSTREAM_MCP, merged);
    assert.deepEqual(held, []);
    assert.equal(value, merged);
  });

  test('does not mutate either input', () => {
    const before = structuredClone(CONSUMER_MCP);
    const after = structuredClone(UPSTREAM_MCP);
    guardPinDowngrades(before, after);
    assert.deepEqual(before, CONSUMER_MCP);
    assert.deepEqual(after, UPSTREAM_MCP);
  });
});

describe('assertNoPinDowngrade — the independent post-condition', () => {
  test('throws on a downgrade that reached the write path', () => {
    // The guard and the assertion must not share an implementation of "did we
    // guard?" — this is what makes a future refactor that routes around
    // `guardPinDowngrades` fail loudly instead of shipping the regression.
    assert.throws(
      () => assertNoPinDowngrade({
        relPath: '.vscode/mcp.json', existing: CONSUMER_MCP, outbound: UPSTREAM_MCP,
      }),
      (err) => /servers\.playwright/.test(err.message) && /supply-chain/.test(err.message),
    );
  });

  test('passes on the guard\'s own output — guard and assertion agree', () => {
    const { value } = guardPinDowngrades(CONSUMER_MCP, UPSTREAM_MCP);
    assert.doesNotThrow(() => assertNoPinDowngrade({
      relPath: '.vscode/mcp.json', existing: CONSUMER_MCP, outbound: value,
    }));
  });
});
