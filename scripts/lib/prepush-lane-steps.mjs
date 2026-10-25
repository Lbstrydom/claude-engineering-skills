/**
 * @fileoverview The git-touching half of the hook's v16 early exits (`prepush-step.mjs landing` and `sync-lane`): it gathers the facts,
 * `prepush-lanes.mjs` decides. Every failure direction is the "not proven" answer (`landing code`, `not-sync`), never a skip.
 * Plan: docs/plans/hook-fidelity-and-v15-field-gaps.md §2.1-2.2.
 *
 * @module scripts/lib/prepush-lane-steps
 */
import { resolvePushRange } from './push-range.mjs';
import {
  decideLanding, decideSyncLane, parseSyncBundleTrailer, syncLaneLine, notSyncLine, landingLine, landingCodeLine,
} from './prepush-lanes.mjs';

const OWNED_SIDECAR = 'scripts/.sync-owned.json';
const RECEIPT = '.sync-receipt.json';

/** `git` through an injected runner: `(args, {input}) => {ok, stdout: Buffer|string}`; defaults to the lane's own (sanitised, bounded) runner. */
async function laneGit(cwd) {
  const lane = await import('./prepush-archive-lane.mjs');
  return { lane, git: lane.makeGit(cwd) };
}

const text = (r) => (r.ok ? r.stdout.toString('utf8') : null);

/**
 * Commits of `tip` the destination does not hold: `rev-list --count <tip> --not <roots>`, the roots fed on stdin (a destination can
 * advertise hundreds of refs - more than an argv holds).
 * @returns {number|null} null = unknown
 */
function unpublishedCount(git, tip, roots) {
  if (roots.length === 0) return null;
  const r = git(['rev-list', '--count', '--stdin'], { input: `${tip}\n${roots.map((x) => `^${x}`).join('\n')}\n` });
  const out = text(r)?.trim();
  return out !== undefined && out !== null && /^\d+$/.test(out) ? Number(out) : null;
}

/**
 * `landing`: `landing none <n> ...` | `landing code <reason>`.
 * @returns {Promise<string>}
 */
export async function landingStepLine({ stdinText, destination, cwd = process.cwd(), lanes = null }) {
  try {
    if (!destination) return landingCodeLine('the push destination was not handed over');
    const { lane, git } = lanes ?? await laneGit(cwd);
    const parsed = lane.parsePushLines(stdinText);
    const published = parsed.entries.filter((e) => e.localSha !== lane.ZERO_SHA);
    // Cheap exits first: a branch update or an unparseable line needs no network round trip to be `code`.
    const pre = decideLanding({ entries: parsed.entries, malformed: parsed.malformed, tips: published.map(() => 'x'), unpublishedCount: () => 0 });
    if (pre.kind === 'code' && !pre.reason.startsWith('a pushed tag')) return landingCodeLine(pre.reason);
    const tips = lane.peelToCommits(git, published.map((e) => e.localSha));
    const roots = lane.establishRoots(git, destination, parsed.entries.map((e) => e.remoteSha).filter((s) => s !== lane.ZERO_SHA));
    const d = decideLanding({ entries: parsed.entries, malformed: parsed.malformed, tips, unpublishedCount: (tip) => unpublishedCount(git, tip, roots) });
    return d.kind === 'none' ? landingLine(d.tags, lane.displayDestination(destination)) : landingCodeLine(d.reason);
  } catch (e) {
    return landingCodeLine(`the landing step failed (${e?.code || e?.name || 'error'})`);
  }
}

/**
 * `sync-lane`: `sync-lane <bundleSha> <n>` | `not-sync <reason>`. The trailer is read BEFORE any heavy import, so an ordinary push pays for
 * one `git log`.
 * @returns {Promise<string>}
 */
export async function syncLaneStepLine({ stdinText, destination, env = process.env, cwd = process.cwd(), lanes = null }) {
  try {
    if (String(stdinText ?? '').split(/\r?\n/).filter((l) => l.trim() !== '').length !== 1) return notSyncLine('the push has more or fewer than one ref update');
    const { lane, git } = lanes ?? await laneGit(cwd);
    const g = (args, opts) => git(args, opts);
    const range = resolvePushRange({ env, run: (args) => text(g(args))?.trim() || null });
    if (!range.ok || !range.trusted) return notSyncLine('the push range was not handed over by git');
    const { base, head } = range;
    const count = text(g(['rev-list', '--count', `${base}..${head}`]))?.trim();
    if (count !== '1') return notSyncLine(`the range holds ${count ?? 'an unknown number of'} commit(s); sync:pr makes one`);
    const log = text(g(['log', '-1', '--format=%H%x1f%P%x1f%B', head]));
    if (log === null) return notSyncLine('the commit could not be read');
    const [sha, parents, ...rest] = log.split('\x1f');
    const message = rest.join('\x1f');
    if (!parseSyncBundleTrailer(message)) return notSyncLine('no Sync-Bundle trailer');

    // A sync commit: now the heavy half.
    const parsed = lane.parsePushLines(stdinText);
    const { parseNameStatus, ALWAYS_SYNC_OWNED } = await import('./sync-pr.mjs');
    const { comparisonKey, isUpstreamOwned, isUsableSidecar } = await import('./sync-owned-sidecar.mjs');
    const { readSyncReceipt, latestReceiptEntry } = await import('./sync-receipt.mjs');
    const { classifyGitignoreTransition } = await import('./sync-gitignore.mjs');
    const json = (rev, rel) => { const t = text(g(['show', `${rev}:${rel}`])); try { return t === null ? null : JSON.parse(t); } catch { return null; } };
    const headSidecar = json(head, OWNED_SIDECAR);
    const baseSidecar = json(base, OWNED_SIDECAR);
    const receipt = json(head, RECEIPT);
    const nameStatus = text(g(['diff', '--name-status', '--no-renames', '-z', base, head, '--']));
    const changes = nameStatus === null ? null : parseNameStatus(nameStatus);
    const [u] = parsed.entries;
    let basePublished = null;
    if (u && /^0+$/.test(u.remoteSha)) {
      // A new branch: its base must sit under a tip the DESTINATION advertises, not under a local remote-tracking ref.
      const roots = lane.establishRoots(git, destination, []);
      basePublished = unpublishedCount(git, base, roots) === 0;
    }
    const usable = isUsableSidecar(headSidecar);
    const d = decideSyncLane({
      entries: parsed.entries, malformed: parsed.malformed, exportedBase: base, exportedHead: head,
      commits: [{ sha, parents: parents.split(' ').filter(Boolean), message }],
      basePublished, changes,
      receiptEntry: receipt === null ? null : latestReceiptEntry(readSyncReceipt(receipt)),
      isOwned: ({ status, path: p }) => usable && (ALWAYS_SYNC_OWNED.has(comparisonKey(p)) || isUpstreamOwned(headSidecar, p) || (status === 'D' && isUpstreamOwned(baseSidecar, p))),
      gitignoreBlockOnly: () => {
        const headText = text(g(['show', `${head}:.gitignore`]));
        // Absence is ESTABLISHED by ls-tree answering with nothing; a failed git call is not absence (it is `not proven`).
        const listed = g(['ls-tree', '-z', base, '--', '.gitignore']);
        if (!listed.ok) return false;
        let baseText = null;
        if (listed.stdout.length > 0) { baseText = text(g(['show', `${base}:.gitignore`])); if (baseText === null) return false; }
        return headText !== null && classifyGitignoreTransition(baseText, headText) === 'block-only';
      },
    });
    return d.syncLane ? syncLaneLine(d.bundleSha, d.files) : notSyncLine(d.reason);
  } catch (e) {
    return notSyncLine(`the sync-lane step failed (${e?.code || e?.name || 'error'})`);
  }
}
