/**
 * @fileoverview `fleet decision record | revoke | list` — the verb over decisions.mjs
 * (docs/plans/ship-record-catchup.md §2.6).
 *
 *   decision record --scope <record-catchup|note> --words-file - [--expires <ISO>] [--id <session>] [--host-session <id>]
 *   decision revoke <dec-id> --words-file - [--id <session>]
 *   decision list [--scope <s>]
 *
 * The words come on STDIN (or a file), never argv: a backtick in an argv string runs as command substitution and silently
 * elides text the record can never repair (AGENTS.md, "every body and --note goes on stdin").
 *
 * @module scripts/lib/fleet/decisions-cmd
 */
import fs from 'node:fs';
import { ArgvError } from '../cli-io.mjs';
import { transact } from './registry.mjs';
import { currentBranch, lockFailed, nowIso, ok, refused } from './commands.mjs';
import {
  DECISION_SCOPES, DECISION_ID_RE, GRANTS_NOTE, WORDS_MAX, newDecisionId, newRevocationId, readDecisions, writeRecord,
} from './decisions.mjs';

const SUBS = ['record', 'revoke', 'list'];

/** Read the words: `-` is stdin, anything else a file path. Exact bytes, only a trailing newline trimmed. */
export function readWords(spec, { readStdin = () => fs.readFileSync(0, 'utf8') } = {}) {
  if (spec === undefined) throw new ArgvError('fleet decision: --words-file - (stdin) or --words-file <path> is required — the user\'s exact words');
  let text;
  try { text = spec === '-' ? readStdin() : fs.readFileSync(spec, 'utf8'); } catch (e) { throw new ArgvError(`fleet decision: could not read --words-file ${spec} (${e.code ?? e.message})`); }
  text = String(text).replace(/\r\n/g, '\n').replace(/\n+$/, '');
  if (!text.trim()) throw new ArgvError('fleet decision: the words are empty');
  if (text.length > WORDS_MAX) throw new ArgvError(`fleet decision: the words are over ${WORDS_MAX} characters`);
  return text;
}

const byOf = (ctx, flags) => ({ session: flags['--id'] ?? currentBranch(ctx.cwd) ?? 'coordinator', hostSession: flags['--host-session'] ?? null });

function render(d, revoked) {
  const state = revoked ? `REVOKED by ${revoked.id}` : d.expiresAt && Date.parse(d.expiresAt) <= Date.now() ? 'expired' : 'active';
  return [`${d.id}  ${d.scope}  ${state}  recorded ${d.at} by ${d.recordedBy.session}${d.expiresAt ? `, expires ${d.expiresAt}` : ''}`,
    ...d.words.split('\n').map((l) => `    > ${l}`)].join('\n');
}

export function cmdDecision(ctx, flags, positionals, deps = {}) {
  const sub = positionals[0];
  if (!SUBS.includes(sub)) throw new ArgvError(`fleet decision: sub-command must be one of ${SUBS.join(', ')} (got ${JSON.stringify(sub ?? '')})`);
  if (sub === 'list') {
    const scope = flags['--scope'];
    if (scope !== undefined && !DECISION_SCOPES.includes(scope)) throw new ArgvError(`fleet decision list: --scope must be one of ${DECISION_SCOPES.join(', ')}`);
    const r = readDecisions(ctx.dir);
    const shown = r.decisions.filter((d) => !scope || d.scope === scope);
    const lines = shown.length ? shown.map((d) => render(d, r.revocations.find((x) => x.revokes === d.id))) : ['no decisions recorded'];
    if (!r.complete) lines.push(`warning: incomplete read (${r.reason}) — this is not the whole list`);
    for (const u of r.unsupported) lines.push(`unsupported: ${u.file} (${u.reason}) — listed, never active`);
    for (const i of r.invalid) lines.push(`invalid: ${i.file} (${i.reason})`);
    lines.push(`(${GRANTS_NOTE})`);
    return ok({ decisions: shown, revocations: r.revocations, complete: r.complete, text: lines.join('\n') });
  }
  if (positionals.length > (sub === 'revoke' ? 2 : 1)) throw new ArgvError(`fleet decision ${sub}: unexpected argument ${JSON.stringify(positionals.at(-1))}`);
  const words = readWords(flags['--words-file'], deps);
  const at = nowIso(ctx);
  if (sub === 'record') {
    const scope = flags['--scope'];
    if (!DECISION_SCOPES.includes(scope)) throw new ArgvError(`fleet decision record: --scope must be one of ${DECISION_SCOPES.join(', ')} (got ${JSON.stringify(scope ?? null)}); merge, push and override are deliberately not expressible`);
    const expires = flags['--expires'] ?? null;
    if (expires !== null && (!Number.isFinite(Date.parse(expires)) || Date.parse(expires) <= ctx.now.getTime())) throw new ArgvError('fleet decision record: --expires must be a future ISO timestamp');
    const tx = transact(ctx.dir, () => writeRecord(ctx.dir, {
      schemaVersion: 1, kind: 'decision', id: newDecisionId(ctx.now), at, scope, words, recordedBy: byOf(ctx, flags),
      expiresAt: expires === null ? null : new Date(Date.parse(expires)).toISOString(),
    }));
    if (!tx.ok) return lockFailed();
    const d = tx.value;
    return ok({ decision: d, text: [`decision ${d.id} recorded (${d.scope})`, render(d, null), `(${GRANTS_NOTE})`,
      ...(d.scope === 'record-catchup' ? [`use it: ship-commit.mjs --record --decision ${d.id}`] : [])].join('\n') });
  }
  const target = positionals[1];
  if (!DECISION_ID_RE.test(String(target ?? ''))) throw new ArgvError('fleet decision revoke <dec-id>: name the decision to revoke');
  const tx = transact(ctx.dir, () => {
    const r = readDecisions(ctx.dir);
    if (!r.decisions.some((d) => d.id === target)) return { missing: true };
    if (r.revocations.some((x) => x.revokes === target)) return { already: true };
    return { rev: writeRecord(ctx.dir, { schemaVersion: 1, kind: 'revocation', id: newRevocationId(ctx.now), at, revokes: target, words, recordedBy: byOf(ctx, flags) }) };
  });
  if (!tx.ok) return lockFailed();
  if (tx.value.missing) return refused(`no decision ${target} to revoke`);
  if (tx.value.already) return ok({ text: `decision ${target} is already revoked` });
  return ok({ revocation: tx.value.rev, text: `decision ${target} revoked by ${tx.value.rev.id}` });
}
