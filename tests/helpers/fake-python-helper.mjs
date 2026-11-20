/**
 * A controllable stand-in for scripts/lib/symbol-index/python-ast-helper.py,
 * speaking the same line protocol, so tests can drive every helper failure
 * mode deterministically: `node fake-python-helper.mjs <mode> [n]`.
 *
 * "First request" means the first one received (by order, not by id), so a
 * mode behaves the same whatever ids the parent assigns — per process, or once
 * across restarts when FAKE_HELPER_MARK=<file> is set.
 *
 *   ok            answer every request with one symbol
 *   malformed     answer the first request with a non-JSON line, then behave
 *   dup-id        answer every request twice
 *   wrong-id      answer the first request with an id nobody asked for
 *   early-id      answer the first request with the NEXT id (a request not yet sent)
 *   die-after <n> answer n requests, then exit 3 right after the nth; with
 *                 FAKE_HELPER_MARK=<file> set, every later process (a restart)
 *                 dies on hello — a permanently broken helper
 *   hang-hello    never answer the hello
 *   hang-file     answer hello, never answer a request
 *   slow <ms>     answer each request after <ms>
 *   oversize      answer the first request with a line over the cap
 */
import fs from 'node:fs';
import readline from 'node:readline';

const [mode = 'ok', arg = '0'] = process.argv.slice(2);
const n = Number(arg);
const mark = process.env.FAKE_HELPER_MARK;
const ONE_SHOT = new Set(['malformed', 'wrong-id', 'early-id', 'oversize']);
let received = 0;
let answered = 0;
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const symbolFor = (id) => ({
  symbolName: `f${id}`, kind: 'function', startLine: 1, endLine: 2,
  signature: `def f${id}()`, bodyText: `def f${id}():\n    return ${id}`, isExported: true,
});
const die = () => {
  if (mark) fs.writeFileSync(mark, 'dead');
  // Exit only once stdout has drained, so the nth answer is delivered first.
  process.stdout.write('', () => process.exit(3));
};

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (req.hello) {
    if (mode === 'hang-hello') return;
    if (mode === 'die-after' && mark && fs.existsSync(mark)) process.exit(3);
    out({ v: 1, hello: true, python: '3.12.0' });
    return;
  }
  if (mode === 'hang-file') return;
  // With FAKE_HELPER_MARK set, a one-shot fault fires once across restarts
  // (the marker records it); without it, once per process.
  let first = ++received === 1;
  if (first && mark && ONE_SHOT.has(mode)) {
    if (fs.existsSync(mark)) first = false; else fs.writeFileSync(mark, 'fired');
  }
  const answer = () => {
    if (mode === 'malformed' && first) { process.stdout.write('{not json\n'); return; }
    if (mode === 'early-id' && first) { out({ v: 1, id: req.id + 1, ok: true, symbols: [], imports: [] }); return; }
    if (mode === 'wrong-id' && first) { out({ v: 1, id: -1, ok: true, symbols: [], imports: [] }); return; }
    if (mode === 'oversize' && first) { process.stdout.write(`${'x'.repeat(64 * 1024)}\n`); return; }
    const res = { v: 1, id: req.id, ok: true, symbols: req.wantSymbols ? [symbolFor(req.id)] : [], imports: [] };
    out(res);
    if (mode === 'dup-id') out(res);
    if (mode === 'die-after' && ++answered === n) die();
  };
  if (mode === 'die-after' && n === 0) { die(); return; }
  if (mode === 'slow') setTimeout(answer, n); else answer();
});
