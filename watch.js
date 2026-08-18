#!/usr/bin/env node
'use strict';

/**
 * OSS contribution watcher — personal tool, not part of the VeriQA product
 * (see .gitignore: this whole folder is untracked).
 *
 * For every repo in repos.json (repos we already have a merged PR in),
 * pulls latest, finds commits since the last run, runs `veriqa analyze` on
 * each one, and writes a triage queue of commits worth a manual look —
 * PROVEN findings, HIGH/CRITICAL risk, or security/auth-sensitive keywords.
 *
 * This does NOT replace manual review. It narrows the search space: VeriQA
 * (whatever model is configured in AIClient.js) does the first pass here;
 * a genuinely thorough check still means sitting down with the flagged
 * commits by hand, the same way Kaneo and future-agi were found.
 *
 * Usage:
 *   node oss-watch/watch.js [--max-per-repo=5] [--repo=owner/name]
 *   node oss-watch/watch.js --add-repo=<owner/name or full GitHub URL>
 *
 * --add-repo just appends to repos.json (the single source of truth this
 * script reads) and exits — it does not run analysis itself. The new repo
 * is picked up automatically by every future run (including a cron'd one),
 * the same way as every repo already there. Its first real run scans the
 * last INITIAL_BACKLOG commits as a baseline, same as any other new repo.
 */

const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CLONES_DIR = path.join(ROOT, 'clones');
const REPORTS_DIR = path.join(ROOT, 'reports');
const STATE_PATH = path.join(ROOT, 'state.json');
const REPOS_PATH = path.join(ROOT, 'repos.json');
const QUEUE_PATH = path.join(ROOT, 'queue.md');

const args = process.argv.slice(2);
const MAX_PER_REPO = Number((args.find((a) => a.startsWith('--max-per-repo=')) || '').split('=')[1]) || 5;
const ONLY_REPO = (args.find((a) => a.startsWith('--repo=')) || '').split('=')[1] || null;
const ADD_REPO = (args.find((a) => a.startsWith('--add-repo=')) || '').split('=').slice(1).join('=') || null;
// On a repo's first run, scan this many recent commits instead of the whole
// history, so onboarding a new repo doesn't burn analysis on years of past
// commits that were already fine.
const INITIAL_BACKLOG = 5;

// Word-boundaried on purpose — the un-bounded version matched "auth" inside
// "author" and flagged plain docs commits. "scope" dropped entirely: too
// common a word (variable scope, project scope) to carry any signal here.
const SECURITY_KEYWORDS = /\b(auth|security|credential|token|password|secret|crypto|encrypt|permission|privilege|sanitiz\w*|injection|traversal|xss|csrf|ssrf|vulnerab\w*)\b/i;

function log(msg) {
  process.stderr.write(`[watch] ${msg}\n`);
}

function loadJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function parseOwnerRepo(input) {
  const trimmed = input.trim().replace(/\.git$/, '').replace(/\/$/, '');
  const urlMatch = trimmed.match(/github\.com[/:]([^/]+)\/([^/]+)$/);
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2] };
  const shortMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (shortMatch) return { owner: shortMatch[1], repo: shortMatch[2] };
  return null;
}

function addRepo(input) {
  const parsed = parseOwnerRepo(input);
  if (!parsed) {
    log(`--add-repo: could not parse "${input}" as owner/repo or a GitHub URL`);
    process.exit(1);
  }
  const repos = loadJson(REPOS_PATH, []);
  const key = `${parsed.owner}/${parsed.repo}`;
  if (repos.some((r) => `${r.owner}/${r.repo}` === key)) {
    log(`${key} is already in repos.json — nothing to do`);
    return;
  }
  repos.push({ owner: parsed.owner, repo: parsed.repo, url: `https://github.com/${parsed.owner}/${parsed.repo}.git` });
  repos.sort((a, b) => `${a.owner}/${a.repo}`.toLowerCase().localeCompare(`${b.owner}/${b.repo}`.toLowerCase()));
  saveJson(REPOS_PATH, repos);
  log(`Added ${key} to repos.json — it will be picked up (with a ${INITIAL_BACKLOG}-commit backlog scan) on the next run, cron or manual.`);
}

function saveJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

function sh(cmd, cwd, opts = {}) {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function cloneDirFor(repo) {
  return path.join(CLONES_DIR, `${repo.owner}__${repo.repo}`);
}

function ensureClone(repo) {
  const dir = cloneDirFor(repo);
  if (fs.existsSync(path.join(dir, '.git'))) {
    log(`${repo.owner}/${repo.repo}: fetching…`);
    sh('git fetch --quiet origin', dir);
    const defaultBranch = sh('git symbolic-ref refs/remotes/origin/HEAD', dir).trim().replace('refs/remotes/origin/', '');
    sh(`git checkout --quiet ${defaultBranch}`, dir);
    sh(`git reset --quiet --hard origin/${defaultBranch}`, dir);
    return dir;
  }
  log(`${repo.owner}/${repo.repo}: cloning fresh…`);
  fs.mkdirSync(CLONES_DIR, { recursive: true });
  sh(`git clone --quiet "${repo.url}" "${dir}"`, ROOT);
  return dir;
}

function newCommitsSince(dir, lastSeenSha) {
  if (lastSeenSha) {
    try {
      const out = sh(`git log --reverse --format=%H ${lastSeenSha}..HEAD`, dir);
      return out.split('\n').filter(Boolean);
    } catch {
      // lastSeenSha no longer reachable (force-push/rebase upstream) — fall
      // back to treating this like a first run rather than crashing.
    }
  }
  const out = sh(`git log --reverse --format=%H -n ${INITIAL_BACKLOG}`, dir);
  return out.split('\n').filter(Boolean);
}

function runVeriqaAnalyze(dir, oldSha, newSha) {
  // Local (Mac/Ubuntu) runs use the globally `npm link`-ed `veriqa` binary.
  // CI (GitHub Actions) has no global link — it sets VERIQA_CLI to
  // `node /path/to/cloned/VeriQA_Dev/src/cli.js` instead.
  const veriqaCli = process.env.VERIQA_CLI || 'veriqa';
  try {
    sh(`${veriqaCli} analyze ${oldSha} ${newSha}`, dir, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
  } catch (err) {
    // veriqa exits non-zero on some warning paths even when it still wrote a
    // report — check for the report before treating this as a hard failure.
    log(`  veriqa analyze exited non-zero (${err.status}) — checking for a report anyway`);
  }
  const reportDir = path.join(dir, 'veriqa-reports');
  if (!fs.existsSync(reportDir)) return null;
  const files = fs.readdirSync(reportDir).filter((f) => f.endsWith('.json'));
  if (!files.length) return null;
  // Most recently written report — this run's.
  const latest = files
    .map((f) => ({ f, t: fs.statSync(path.join(reportDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0].f;
  try {
    return loadJson(path.join(reportDir, latest), null);
  } catch {
    return null;
  }
}

function triage(report, commitMessage) {
  if (!report) return { flagged: false, reasons: ['no report produced'] };
  const reasons = [];
  const whereItCanBreak = report.qaGuidance?.whereItCanBreak || [];
  const proven = whereItCanBreak.filter((f) => typeof f === 'string' && /^\[PROVEN\]/i.test(f.trim()));
  const verifyCount = whereItCanBreak.length - proven.length;
  if (proven.length) reasons.push(`${proven.length} [PROVEN] finding(s)`);

  const riskLevel = (report.riskSummary?.level || report.intelligence?.overallRisk || '').toUpperCase();
  const securityHit = SECURITY_KEYWORDS.test(commitMessage || '');

  // VeriQA rates a lot of diffs HIGH on its own — that alone was flagging
  // nearly everything (mechanical release/version-pin commits included) and
  // defeated the point of triage. Require it to converge with a second
  // signal before treating it as worth a manual look.
  if (riskLevel === 'CRITICAL') {
    reasons.push('risk level CRITICAL');
  } else if (riskLevel === 'HIGH' && (securityHit || verifyCount >= 3)) {
    reasons.push(securityHit
      ? 'risk level HIGH + security-sensitive commit message'
      : `risk level HIGH + ${verifyCount} VERIFY findings`);
  } else if (securityHit) {
    // Explicitly security-flavored commit message is worth a glance even at
    // lower risk — file-path matching was dropped, it false-positived on
    // substrings (e.g. "auth" inside "author.tsx") too easily.
    reasons.push('security/auth-sensitive commit message');
  }

  return { flagged: reasons.length > 0, reasons, riskLevel, provenCount: proven.length, verifyCount };
}

function main() {
  if (ADD_REPO) {
    addRepo(ADD_REPO);
    return;
  }

  const repos = loadJson(REPOS_PATH, []);
  const state = loadJson(STATE_PATH, {});
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const runTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runLog = [];
  const flagged = [];

  for (const repo of repos) {
    const key = `${repo.owner}/${repo.repo}`;
    if (ONLY_REPO && key !== ONLY_REPO) continue;

    let dir;
    try {
      dir = ensureClone(repo);
    } catch (err) {
      log(`${key}: clone/fetch failed — ${err.message.split('\n')[0]}`);
      continue;
    }

    const lastSeenSha = state[key]?.lastSeenSha || null;
    let commits;
    try {
      commits = newCommitsSince(dir, lastSeenSha);
    } catch (err) {
      log(`${key}: could not list commits — ${err.message.split('\n')[0]}`);
      continue;
    }

    if (!commits.length) {
      log(`${key}: no new commits`);
      continue;
    }

    const toProcess = commits.slice(0, MAX_PER_REPO);
    if (toProcess.length < commits.length) {
      log(`${key}: ${commits.length} new commits, processing first ${toProcess.length} (--max-per-repo)`);
    }

    for (const sha of toProcess) {
      const parentSha = sh(`git rev-parse ${sha}~1`, dir).trim();
      const subject = sh(`git log -1 --format=%s ${sha}`, dir).trim();

      log(`${key}: analyzing ${sha.slice(0, 8)} — ${subject.slice(0, 70)}`);
      const report = runVeriqaAnalyze(dir, parentSha, sha);
      const verdict = triage(report, subject);

      const entry = { repo: key, sha, subject, url: `https://github.com/${key}/commit/${sha}`, ...verdict };
      runLog.push(entry);
      if (verdict.flagged) flagged.push(entry);

      // Advance state per-commit, not just at the end of the repo's batch —
      // a crash partway through still leaves progress recorded.
      state[key] = { lastSeenSha: sha, lastCheckedAt: new Date().toISOString() };
      saveJson(STATE_PATH, state);
    }
  }

  saveJson(path.join(REPORTS_DIR, `run-${runTimestamp}.json`), runLog);

  const queueLines = ['# OSS watch queue', '', `Last run: ${new Date().toISOString()}`, ''];
  if (!flagged.length) {
    queueLines.push('Nothing flagged this run.');
  } else {
    for (const f of flagged) {
      queueLines.push(`## ${f.repo} — ${f.sha.slice(0, 8)}`);
      queueLines.push(`${f.subject}`);
      queueLines.push(`${f.url}`);
      queueLines.push(`Reasons: ${f.reasons.join('; ')}`);
      queueLines.push('');
    }
  }
  fs.writeFileSync(QUEUE_PATH, queueLines.join('\n') + '\n');

  log(`Done. ${runLog.length} commit(s) analyzed, ${flagged.length} flagged. See oss-watch/queue.md`);
}

module.exports = { triage };

if (require.main === module) {
  main();
}
