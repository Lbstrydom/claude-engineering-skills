/**
 * @fileoverview Observe an Anthropic client on the WIRE under `CLAUDE_BACKEND=cli`, so a test can
 * assert "this builder pins the sdk backend" by what the client DOES instead of regexing the
 * source that builds it.
 *
 * Why it works: under `cli` an UNPINNED client is the `claude -p` adapter and never calls the
 * network, while a client that pinned `backend: 'sdk'` issues one POST to
 * api.anthropic.com/v1/messages. The Anthropic SDK binds its transport at CONSTRUCTION, so
 * `globalThis.fetch` is stubbed BEFORE `body` builds the client. `CLAUDE_BIN` points at a bogus
 * binary so that if the cli backend IS selected the spawn fails fast — never a real, billed
 * `claude -p` from inside a unit test.
 *
 * Limit: it cannot observe `azureRoute` (the Azure config is frozen at module import, so that
 * half needs a subprocess); callers keep that one source-pinned.
 */
import { _resetClientCache } from '../../scripts/lib/anthropic-client.mjs';

const ENV_KEYS = ['CLAUDE_BACKEND', 'ANTHROPIC_API_KEY', 'CLAUDE_BIN'];

/** A minimal valid Messages API request. */
export const MESSAGES_REQUEST = Object.freeze({
  model: 'claude-test', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }],
});

/** True when `url` is a call to the public Anthropic Messages endpoint. */
export const isAnthropicMessagesUrl = (url) => /^https:\/\/api\.anthropic\.com\/v1\/messages/.test(url);

/**
 * Run `body` under CLAUDE_BACKEND=cli with `fetch` stubbed; resolves to every URL fetched.
 * Environment, `fetch` and the client cache are restored afterwards, even if `body` throws.
 * @param {() => Promise<void>} body
 * @returns {Promise<string[]>}
 */
export async function fetchedUrlsUnderCli(body) {
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const realFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({
      id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-test',
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  process.env.CLAUDE_BACKEND = 'cli';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
  process.env.CLAUDE_BIN = 'no-such-claude-binary-for-this-test';
  _resetClientCache();
  try {
    await body();
  } finally {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
    _resetClientCache();
  }
  return urls;
}
