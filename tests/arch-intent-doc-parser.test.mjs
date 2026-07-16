import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { parseIntentDoc } from '../scripts/lib/arch-intent/intent-doc-parser.mjs';

function mkDoc(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-intent-parser-'));
  const file = path.join(dir, 'doc.md');
  fs.writeFileSync(file, content);
  return { dir, file };
}

describe('parseIntentDoc', () => {
  it('returns _present=false when file missing', () => {
    const r = parseIntentDoc('/nonexistent/path.md');
    assert.equal(r._present, false);
    assert.equal(r.mermaid, null);
  });

  it('handles empty path', () => {
    const r = parseIntentDoc('');
    assert.equal(r._present, false);
  });

  it('extracts the first ```mermaid block', () => {
    const { dir, file } = mkDoc(`# Title

\`\`\`mermaid
graph TB
  a --> b
\`\`\`

Text after.

\`\`\`mermaid
ignored second block
\`\`\`
`);
    const r = parseIntentDoc(file);
    assert.equal(r._present, true);
    assert.match(r.mermaid, /graph TB/);
    assert.equal(r.mermaid.includes('ignored second block'), false);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('warns when no mermaid block present', () => {
    const { dir, file } = mkDoc('# No diagram here');
    const r = parseIntentDoc(file);
    assert.equal(r.mermaid, null);
    assert.ok(r._warnings.some(w => /No mermaid/i.test(w)));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('extracts version from header', () => {
    const { dir, file } = mkDoc('- **Version**: 1.2.3\n# Title');
    const r = parseIntentDoc(file);
    assert.equal(r.version, '1.2.3');
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('captures section narratives keyed by header', () => {
    const { dir, file } = mkDoc(`# Title

## Domains

Some narrative.

## Boundaries

Other text here.
`);
    const r = parseIntentDoc(file);
    assert.ok(Object.keys(r.narratives).length >= 1);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('never throws on malformed input', () => {
    const { dir, file } = mkDoc('```mermaid\nincomplete fence');
    assert.doesNotThrow(() => parseIntentDoc(file));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
});
