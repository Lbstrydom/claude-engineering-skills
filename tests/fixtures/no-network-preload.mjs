/**
 * Test preload (`node --import`): records and refuses every outbound network attempt.
 *
 * The round-cap tests prove "a refused round makes zero audit-inference requests" by observing the
 * transport, not by trusting a log line: `fetch` (the OpenAI/Gemini SDKs ride it), TCP `connect`
 * (pg, https) and `tls.connect` are wrapped; each attempt is appended to the file named by
 * `NO_NET_LOG` and then fails. Unix-socket / named-pipe connects (no host/port) pass, so child-process
 * stdio is unaffected.
 */
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';

const LOG = process.env.NO_NET_LOG;
const record = (kind, target) => {
  if (!LOG) return;
  try { fs.appendFileSync(LOG, `${kind} ${target}\n`); } catch { /* the preload must never throw into the program */ }
};

globalThis.fetch = async (input) => {
  record('fetch', String(input?.url ?? input));
  throw new TypeError('no-network-preload: fetch blocked');
};

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedConnect(...args) {
  // net.connect hands the socket an already-normalised `[options, cb]` array; a direct call passes the options.
  const o = Array.isArray(args[0]) ? args[0][0] : args[0];
  const isNetwork = (typeof o === 'object' && o !== null && (o.port !== undefined || o.host !== undefined)) || typeof o === 'number';
  if (!isNetwork) return realConnect.apply(this, args);
  record('net.connect', typeof o === 'object' ? `${o.host ?? ''}:${o.port ?? ''}` : String(o));
  queueMicrotask(() => this.destroy(new Error('no-network-preload: connect blocked')));
  return this;
};

tls.connect = function patchedTlsConnect(...args) {
  const o = args[0];
  record('tls.connect', typeof o === 'object' ? `${o.host ?? ''}:${o.port ?? ''}` : String(o));
  throw new Error('no-network-preload: tls.connect blocked');
};
