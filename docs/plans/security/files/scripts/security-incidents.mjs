/**
 * @fileoverview Security incident audit-trail CLI.
 * Logs /security-strategy operations to the `security_incident_log` Postgres table.
 * Exit 0 = logged; exit 1 = write error or DB unavailable; exit 2 = usage error.
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { getPool } from './lib/db/client.mjs';

const VALID_CLASSIFICATIONS = ['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'PUBLIC'];

const [,, cmd, ...args] = process.argv;

if (cmd !== 'log') {
  process.stderr.write(
    'usage: node scripts/security-incidents.mjs log\n' +
    '         --incident-id INC-001\n' +
    '         [--mode bootstrap|add|add-from-commit]\n' +
    `         [--classification ${VALID_CLASSIFICATIONS.join('|')}]\n` +
    '         [--commit-sha <sha>]\n' +
    '         [--compliance-tags org-security,org-data]\n' +
    '         [--repo <name>]\n' +
    '         [--operator <git-user>]\n'
  );
  process.exit(2);
}

function flag(name, fallback = undefined) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] !== undefined ? args[idx + 1] : fallback;
}

const incidentId = flag('incident-id');
if (!incidentId) {
  process.stderr.write('error: --incident-id is required\n');
  process.exit(2);
}

const mode = flag('mode', 'unknown');
const classification = flag('classification', 'INTERNAL');
if (!VALID_CLASSIFICATIONS.includes(classification)) {
  process.stderr.write(`error: --classification must be one of ${VALID_CLASSIFICATIONS.join(', ')} (got: ${classification})\n`);
  process.exit(2);
}
const commitSha = flag('commit-sha', null) || null;
const complianceTags = (flag('compliance-tags', 'org-security')).split(',').map(t => t.trim()).filter(Boolean);
const repoName = flag('repo', null) || null;
const operator = flag('operator', null) || null;

function currentBranch() {
  try {
    // execFileSync (argv array) — no shell invocation / interpolation surface.
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return 'unknown';
  }
}

const branch = currentBranch();

let pool;
try {
  pool = await getPool();
} catch {
  pool = null;
}

if (!pool) {
  process.stderr.write('error: Postgres unavailable — audit trail not recorded\n');
  process.exit(1);
}

try {
  await pool.query(
    `INSERT INTO security_incident_log
       (incident_id, mode, classification, compliance_tags, commit_sha, branch, operator, repo_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [incidentId, mode, classification, complianceTags, commitSha, branch, operator, repoName]
  );
  const onMain = branch === 'main' || branch === 'master';
  console.log(`security:log — ${incidentId} recorded (branch=${branch}, classification=${classification}, on-main=${onMain})`);
} catch (err) {
  process.stderr.write(`error: audit trail insert failed: ${err.message}\n`);
  process.exit(1);
} finally {
  await pool.end();
}
