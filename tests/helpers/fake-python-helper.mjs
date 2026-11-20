/**
 * A controllable stand-in for scripts/lib/symbol-index/python-ast-helper.py,
 * speaking the same line protocol, so tests can drive every helper failure
 * mode deterministically: `node fake-python-helper.mjs <mode> [n]`.
 *
 *   ok            answer every request with one symbol
 *   malformed     answer request 1 with a non-JSON line, then behave
 *   dup-id        answer every request twice
 *   wrong-id      answer request 1 with an id nobody asked for
 *   early-id      answer request 1 as id 2 (a request not yet sent)
 *   die-after <n> answer n requests, then exit 3; with FAKE_HELPER_MARK=<file> set, every
 *                 later process (a restart) dies on hello — a permanently broken helper
 *   hang-hello    never answer the hello
 *   hang-file     answer hello, never answer a request
 *   slow <ms>     answer each request after <ms>
 *   oversize      answer request 1 with a line over the cap
 */
import fs from 'node:fs';
import readline from 'node:readline';

const [mode = 'ok', arg = '0'] = process.argv.slice(2);
const n = Number(arg);
let answered = 0;
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const symbolFor = (id) => ({
  symbolName: `f${id}`, kind: 'function', startLine: 1, endLine: 2,
  signature: `def f${id}()`, bodyText: `def f${id}():\n    return ${id}`, isExported: true,
});

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (req.hello) {
    if (mode === 'hang-hello') return;
    const mark = process.env.FAKE_HELPER_MARK;
    if (mode === 'die-after' && mark && fs.existsSync(mark)) process.exit(3);
    out({ v: 1, hello: true, python: '3.12.0' });
    return;
  }
  if (mode === 'hang-file') return;
  const answer = () => {
    answered++;
    if (mode === 'die-after' && answered > n) {
      if (process.env.FAKE_HELPER_MARK) fs.writeFileSync(process.env.FAKE_HELPER_MARK, 'dead');
      process.exit(3);
    }
    if (mode === 'malformed' && req.id === 1) { process.stdout.write('{not json\n'); return; }
    if (mode === 'early-id' && req.id === 1) { out({ v: 1, id: 2, ok: true, symbols: [], imports: [] }); return; }
    if (mode === 'wrong-id' && req.id === 1) { out({ v: 1, id: 999, ok: true, symbols: [], imports: [] }); return; }
    if (mode === 'oversize' && req.id === 1) { process.stdout.write(`${'x'.repeat(64 * 1024)}\n`); return; }
    const res = { v: 1, id: req.id, ok: true, symbols: req.wantSymbols ? [symbolFor(req.id)] : [], imports: [] };
    out(res);
    if (mode === 'dup-id') out(res);
  };
  if (mode === 'slow') setTimeout(answer, n); else answer();
});
