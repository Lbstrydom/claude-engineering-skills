/**
 * @fileoverview A research document that states a store-derived claim says what the
 * claim was measured FROM.
 *
 * Every tracked `docs/research/*.md` must (a) parse a population line, or (b) carry
 * `<!-- population: not-store-derived — <reason> -->`, or (c) be grandfathered: listed in
 * `tests/fixtures/research-population-grandfathered.json` pinned to the sha256 of its
 * EOL-canonical content. A grandfathered file whose content changes loses the exemption,
 * so an old document cannot quietly acquire new store-derived claims; a listed file that
 * no longer exists fails (re-baseline). New documents cannot skip it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parsePopulationLine } from '../scripts/lib/population.mjs';
import { canonicalizeEol } from '../scripts/lib/file-io.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'research-population-grandfathered.json');
const MARKER = /<!--\s*population:\s*not-store-derived\s*—\s*\S[^>]*-->/;

const sha = (buf) => crypto.createHash('sha256').update(canonicalizeEol(buf)).digest('hex');

/** The TRACKED top-level research documents: a clean checkout is the contract, not whatever is on this disk. */
function trackedResearchDocs() {
  const out = execFileSync('git', ['ls-files', '--', 'docs/research/*.md'], { cwd: ROOT, encoding: 'utf8' });
  return out.split(/\r?\n/).filter((f) => /^docs\/research\/[^/]+\.md$/.test(f));
}

/** @returns {'line'|'marker'|'grandfathered'|'missing'} */
function classifyResearchDoc(rel, buf, grandfathered) {
  const text = buf.toString('utf8');
  if (parsePopulationLine(text)) return 'line';
  if (MARKER.test(text)) return 'marker';
  if (grandfathered[rel] === sha(buf)) return 'grandfathered';
  return 'missing';
}

/** Grandfather entries whose file is not in the tracked set. */
function staleGrandfathered(listed, tracked) {
  return Object.keys(listed).filter((rel) => !tracked.includes(rel));
}

const grandfathered = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

describe('docs/research population line', () => {
  const docs = trackedResearchDocs();

  it('finds the research documents (vacuous-pass guard)', () => {
    assert.ok(docs.length >= 20, `only ${docs.length} documents found`);
  });

  it('every tracked document has a line, a marker, or an unchanged grandfather entry', () => {
    const bad = docs.filter((rel) => classifyResearchDoc(rel, fs.readFileSync(path.join(ROOT, rel)), grandfathered) === 'missing');
    assert.deepEqual(bad, [], 'add a population line (renderPopulationLine) or <!-- population: not-store-derived — <reason> -->');
  });

  it('a listed file that is no longer TRACKED fails (re-baseline) — the tracked set, not fs existence, is the contract', () => {
    assert.deepEqual(staleGrandfathered(grandfathered, docs), []);
  });

  it('negative control: a listed file that still EXISTS on disk but is not tracked is stale', () => {
    const rel = Object.keys(grandfathered)[0];
    assert.ok(fs.existsSync(path.join(ROOT, rel)), 'the fixture file exists on disk');
    assert.deepEqual(staleGrandfathered(grandfathered, docs.filter((d) => d !== rel)), [rel]);
  });

  it('negative controls: a new document without a line or marker is refused; with either it passes', () => {
    const plain = Buffer.from('# New finding\n\nWe measured a 12% drop.\n');
    assert.equal(classifyResearchDoc('docs/research/new.md', plain, grandfathered), 'missing');
    const marked = Buffer.from('# T\n<!-- population: not-store-derived — a literature survey -->\n');
    assert.equal(classifyResearchDoc('docs/research/new.md', marked, grandfathered), 'marker');
    const lined = Buffer.from('# T\nPopulation: measured from 1 store — d5a9d07b (consumers not known here). other consumers: not known here.\n');
    assert.equal(classifyResearchDoc('docs/research/new.md', lined, grandfathered), 'line');
    assert.equal(classifyResearchDoc('docs/research/new.md', Buffer.from('<!-- population: not-store-derived — -->'), grandfathered), 'missing', 'a marker needs a reason');
  });

  it('a grandfathered document that is edited loses the exemption; CRLF alone does not', () => {
    const rel = Object.keys(grandfathered)[0];
    const original = fs.readFileSync(path.join(ROOT, rel));
    assert.equal(classifyResearchDoc(rel, original, grandfathered), 'grandfathered');
    assert.equal(classifyResearchDoc(rel, Buffer.concat([original, Buffer.from('\nA new store-derived claim.\n')]), grandfathered), 'missing');
    assert.equal(classifyResearchDoc(rel, Buffer.from(original.toString('utf8').replace(/\r?\n/g, '\r\n')), grandfathered), 'grandfathered');
  });
});
