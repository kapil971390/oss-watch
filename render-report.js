#!/usr/bin/env node
'use strict';

/**
 * render-report.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Builds the GitHub Pages dashboard from every reports/run-*.json this repo
 * has accumulated. Re-derives flagged/reasons from the raw fields (subject,
 * riskLevel, provenCount, verifyCount) using the CURRENT triage() from
 * watch.js — so a triage-logic fix (like the noise fix already shipped)
 * automatically applies to historical data too, not just future runs.
 *
 * Usage: node render-report.js [outDir]   (default outDir: _site)
 */

const fs = require('fs');
const path = require('path');
const { triage } = require('./watch.js');

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const OUT_DIR = path.resolve(process.argv[2] || path.join(ROOT, '_site'));

function loadAllRuns() {
  if (!fs.existsSync(REPORTS_DIR)) return [];
  const files = fs.readdirSync(REPORTS_DIR).filter((f) => f.endsWith('.json'));
  const all = [];
  for (const f of files) {
    try {
      const entries = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8'));
      if (Array.isArray(entries)) all.push(...entries);
    } catch {
      // skip unreadable/corrupt run file rather than fail the whole render
    }
  }
  return all;
}

// A stored entry has {repo, sha, subject, url, riskLevel, provenCount, verifyCount, ...}
// but not the raw VeriQA report object triage() expects. Reconstruct just
// enough of that shape from the counts already recorded.
function reconstructReport(entry) {
  const whereItCanBreak = [
    ...Array(entry.provenCount || 0).fill('[PROVEN] (recorded)'),
    ...Array(entry.verifyCount || 0).fill('[VERIFY] (recorded)'),
  ];
  return {
    qaGuidance: { whereItCanBreak },
    riskSummary: { level: entry.riskLevel },
  };
}

function dedupeAndRetriage(entries) {
  const byKey = new Map();
  for (const e of entries) {
    // Later files win on collision — a repo/sha re-analyzed in a later run
    // (shouldn't normally happen given incremental state, but be defensive).
    byKey.set(`${e.repo}@${e.sha}`, e);
  }
  return [...byKey.values()].map((e) => {
    const verdict = triage(reconstructReport(e), e.subject);
    return {
      repo: e.repo,
      sha: e.sha,
      subject: e.subject,
      url: e.url,
      risk: (e.riskLevel || 'LOW').toUpperCase(),
      proven: e.provenCount || 0,
      verify: e.verifyCount || 0,
      flagged: verdict.flagged,
      reasons: verdict.reasons,
    };
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildHtml(rows, repoCount) {
  const flaggedCount = rows.filter((r) => r.flagged).length;
  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const dataJson = JSON.stringify(rows);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OSS Watch — Signal Report</title>
<style>
  :root {
    --bg: #0F1420; --surface: #171E2E; --surface-2: #1E2740; --border: #28324A;
    --text: #E4E8F1; --text-muted: #7C88A6; --text-faint: #4C5772;
    --accent: #4DD8C4; --accent-dim: rgba(77, 216, 196, 0.13);
    --danger: #F0665A; --danger-dim: rgba(240, 102, 90, 0.14);
    --warning: #E8A33D; --warning-dim: rgba(232, 163, 61, 0.14);
    --ok: #5FBF8F; --ok-dim: rgba(95, 191, 143, 0.13);
    --mono: ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Consolas, "Roboto Mono", monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    --radius: 10px;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #F5F7FA; --surface: #FFFFFF; --surface-2: #EDF1F6; --border: #DDE3EC;
      --text: #131A29; --text-muted: #5C6B85; --text-faint: #93A0B8;
      --accent: #0E9A87; --accent-dim: rgba(14, 154, 135, 0.09);
      --danger: #D9463A; --danger-dim: rgba(217, 70, 58, 0.09);
      --warning: #B8760F; --warning-dim: rgba(184, 118, 15, 0.10);
      --ok: #2F9463; --ok-dim: rgba(47, 148, 99, 0.09);
    }
  }
  :root[data-theme="dark"] {
    --bg: #0F1420; --surface: #171E2E; --surface-2: #1E2740; --border: #28324A;
    --text: #E4E8F1; --text-muted: #7C88A6; --text-faint: #4C5772;
    --accent: #4DD8C4; --accent-dim: rgba(77, 216, 196, 0.13);
    --danger: #F0665A; --danger-dim: rgba(240, 102, 90, 0.14);
    --warning: #E8A33D; --warning-dim: rgba(232, 163, 61, 0.14);
    --ok: #5FBF8F; --ok-dim: rgba(95, 191, 143, 0.13);
  }
  :root[data-theme="light"] {
    --bg: #F5F7FA; --surface: #FFFFFF; --surface-2: #EDF1F6; --border: #DDE3EC;
    --text: #131A29; --text-muted: #5C6B85; --text-faint: #93A0B8;
    --accent: #0E9A87; --accent-dim: rgba(14, 154, 135, 0.09);
    --danger: #D9463A; --danger-dim: rgba(217, 70, 58, 0.09);
    --warning: #B8760F; --warning-dim: rgba(184, 118, 15, 0.10);
    --ok: #2F9463; --ok-dim: rgba(47, 148, 99, 0.09);
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--mono); font-size: 13.5px; line-height: 1.55; -webkit-font-smoothing: antialiased; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  a:focus-visible, button:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .wrap { max-width: 980px; margin: 0 auto; padding: 40px 24px 80px; }
  header { display: flex; flex-direction: column; gap: 10px; margin-bottom: 36px; padding-bottom: 28px; border-bottom: 1px solid var(--border); }
  .eyebrow { font-family: var(--mono); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent); display: flex; align-items: center; gap: 8px; }
  .eyebrow .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim); }
  h1 { font-family: var(--sans); font-weight: 800; font-stretch: condensed; font-size: clamp(26px, 4vw, 36px); letter-spacing: -0.01em; margin: 0; text-wrap: balance; }
  .sub { color: var(--text-muted); font-size: 13px; max-width: 62ch; }
  .meta-row { display: flex; flex-wrap: wrap; gap: 18px; font-size: 12px; color: var(--text-faint); margin-top: 4px; }
  .meta-row b { color: var(--text-muted); font-weight: 600; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 40px; }
  .stat { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; }
  .stat .num { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; }
  .stat .num.accent { color: var(--accent); }
  .stat .num.danger { color: var(--danger); }
  .stat .label { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-faint); margin-top: 6px; }
  .section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
  h2 { font-family: var(--sans); font-weight: 700; font-size: 15px; letter-spacing: 0.01em; margin: 0; display: flex; align-items: center; gap: 8px; }
  .section-note { color: var(--text-faint); font-size: 12px; }
  section { margin-bottom: 44px; }
  .queue-list { display: flex; flex-direction: column; gap: 10px; }
  .qcard { background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--danger); border-radius: var(--radius); padding: 14px 16px; }
  .qcard-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .qcard-repo { font-weight: 700; color: var(--text); }
  .sha-link { font-family: var(--mono); color: var(--text-muted); background: var(--surface-2); border: 1px solid var(--border); border-radius: 5px; padding: 1px 6px; font-size: 12px; }
  .sha-link:hover { color: var(--accent); text-decoration: none; border-color: var(--accent); }
  .qcard-subject { margin-top: 6px; color: var(--text); font-size: 13px; }
  .qcard-reasons { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { font-size: 11px; padding: 2px 8px; border-radius: 100px; border: 1px solid transparent; white-space: nowrap; }
  .chip.risk-CRITICAL, .chip.risk-HIGH { background: var(--danger-dim); color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, transparent); }
  .chip.risk-MEDIUM { background: var(--warning-dim); color: var(--warning); border-color: color-mix(in srgb, var(--warning) 35%, transparent); }
  .chip.risk-LOW { background: var(--ok-dim); color: var(--ok); border-color: color-mix(in srgb, var(--ok) 35%, transparent); }
  .chip.reason { background: var(--surface-2); color: var(--text-muted); }
  .filter-row { display: flex; gap: 10px; margin-bottom: 14px; }
  #filter { flex: 1; background: var(--surface); border: 1px solid var(--border); color: var(--text); font-family: var(--mono); font-size: 13px; padding: 9px 12px; border-radius: 8px; }
  #filter::placeholder { color: var(--text-faint); }
  #filter:focus { border-color: var(--accent); outline: none; }
  .repo-list { display: flex; flex-direction: column; gap: 8px; }
  details.repo { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  details.repo[open] summary { border-bottom: 1px solid var(--border); }
  summary.repo-summary { cursor: pointer; list-style: none; padding: 12px 16px; display: flex; align-items: center; gap: 12px; user-select: none; }
  summary.repo-summary::-webkit-details-marker { display: none; }
  summary.repo-summary::before { content: "▸"; color: var(--text-faint); font-size: 11px; transition: transform 0.15s ease; flex-shrink: 0; }
  details[open] > summary.repo-summary::before { transform: rotate(90deg); }
  .repo-name { font-weight: 700; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .repo-counts { display: flex; gap: 10px; align-items: center; font-size: 12px; color: var(--text-muted); flex-shrink: 0; }
  .badge-flagged { background: var(--danger-dim); color: var(--danger); border-radius: 100px; padding: 1px 8px; font-weight: 700; font-size: 11px; }
  .badge-clean { background: var(--ok-dim); color: var(--ok); border-radius: 100px; padding: 1px 8px; font-weight: 700; font-size: 11px; }
  table.commits { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  table.commits th { text-align: left; font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-faint); font-weight: 600; padding: 8px 16px; border-bottom: 1px solid var(--border); }
  table.commits td { padding: 9px 16px; border-bottom: 1px solid var(--border); vertical-align: top; }
  table.commits tr:last-child td { border-bottom: none; }
  table.commits tr.is-flagged { background: var(--danger-dim); }
  .commit-subject { color: var(--text); }
  .commit-reasons { color: var(--text-faint); font-size: 11.5px; margin-top: 2px; }
  .risk-pill { font-size: 10.5px; padding: 1px 7px; border-radius: 100px; white-space: nowrap; }
  .table-scroll { overflow-x: auto; }
  footer { margin-top: 48px; padding-top: 20px; border-top: 1px solid var(--border); color: var(--text-faint); font-size: 11.5px; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  .empty-state { color: var(--text-faint); font-size: 12.5px; padding: 24px; text-align: center; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="eyebrow"><span class="dot"></span> oss-watch · signal report</div>
    <h1>${repoCount} repos, ${rows.length} commits, ${flaggedCount} worth a look</h1>
    <div class="sub">VeriQA's automated pass across every repo we've contributed to — merged fixes and PRs still waiting on a maintainer. This narrows the search space; it doesn't replace sitting down and reading the diff.</div>
    <div class="meta-row">
      <span>Generated: <b>${generatedAt}</b></span>
      <span>Schedule: <b>twice daily</b></span>
      <span>Source: <a href="https://github.com/kapil971390/oss-watch" target="_blank" rel="noopener">kapil971390/oss-watch</a></span>
    </div>
  </header>

  <div class="stats">
    <div class="stat"><div class="num">${repoCount}</div><div class="label">Repos watched</div></div>
    <div class="stat"><div class="num">${rows.length}</div><div class="label">Commits analyzed</div></div>
    <div class="stat"><div class="num danger">${flaggedCount}</div><div class="label">Flagged for review</div></div>
    <div class="stat"><div class="num accent" id="clean-repo-count">–</div><div class="label">Repos fully clean</div></div>
  </div>

  <section>
    <div class="section-head"><h2>Queue — needs a manual look</h2><span class="section-note">sorted by repo</span></div>
    <div class="queue-list" id="queue-list"></div>
  </section>

  <section>
    <div class="section-head"><h2>All ${repoCount} repos</h2><span class="section-note">click to expand</span></div>
    <div class="filter-row"><input id="filter" type="text" placeholder="Filter by repo name…" autocomplete="off" /></div>
    <div class="repo-list" id="repo-list"></div>
  </section>

  <footer>
    <span>Triage rule: CRITICAL risk, or HIGH risk + (security-flavored commit message or ≥3 VERIFY findings), or any [PROVEN] finding.</span>
    <span>Not a bug list — a review queue.</span>
  </footer>
</div>

<script type="application/json" id="data">${dataJson}</script>
<script>
  const rows = JSON.parse(document.getElementById('data').textContent);
  const byRepo = new Map();
  for (const r of rows) { if (!byRepo.has(r.repo)) byRepo.set(r.repo, []); byRepo.get(r.repo).push(r); }
  const repos = [...byRepo.keys()].sort((a, b) => a.localeCompare(b));
  document.getElementById('clean-repo-count').textContent = repos.filter(repo => byRepo.get(repo).every(c => !c.flagged)).length;

  function riskClass(risk) { return 'risk-' + (risk || 'LOW'); }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  const queueRows = rows.filter(r => r.flagged).sort((a, b) => a.repo.localeCompare(b.repo));
  const queueList = document.getElementById('queue-list');
  if (!queueRows.length) {
    queueList.innerHTML = '<div class="empty-state">Nothing flagged.</div>';
  } else {
    for (const r of queueRows) {
      const card = document.createElement('div');
      card.className = 'qcard';
      card.innerHTML = \`
        <div class="qcard-top">
          <span class="qcard-repo">\${escapeHtml(r.repo)}</span>
          <a class="sha-link" href="\${r.url}" target="_blank" rel="noopener">\${r.sha}</a>
        </div>
        <div class="qcard-subject">\${escapeHtml(r.subject)}</div>
        <div class="qcard-reasons">
          <span class="chip \${riskClass(r.risk)}">\${r.risk || 'LOW'}</span>
          \${r.reasons.map(reason => \`<span class="chip reason">\${escapeHtml(reason)}</span>\`).join('')}
        </div>\`;
      queueList.appendChild(card);
    }
  }

  const repoList = document.getElementById('repo-list');
  function renderRepos(filterText) {
    repoList.innerHTML = '';
    const needle = filterText.trim().toLowerCase();
    const visible = repos.filter(r => r.toLowerCase().includes(needle));
    if (!visible.length) { repoList.innerHTML = '<div class="empty-state">No repos match.</div>'; return; }
    for (const repo of visible) {
      const commits = byRepo.get(repo).slice().sort((a, b) => (b.flagged - a.flagged));
      const flaggedCount = commits.filter(c => c.flagged).length;
      const details = document.createElement('details');
      details.className = 'repo';
      const summary = document.createElement('summary');
      summary.className = 'repo-summary';
      summary.innerHTML = \`
        <span class="repo-name">\${escapeHtml(repo)}</span>
        <span class="repo-counts">
          \${flaggedCount > 0 ? \`<span class="badge-flagged">\${flaggedCount} flagged</span>\` : '<span class="badge-clean">clean</span>'}
          <span>\${commits.length} commit\${commits.length === 1 ? '' : 's'}</span>
        </span>\`;
      details.appendChild(summary);
      const tableWrap = document.createElement('div');
      tableWrap.className = 'table-scroll';
      const rowsHtml = commits.map(c => \`
        <tr class="\${c.flagged ? 'is-flagged' : ''}">
          <td><a class="sha-link" href="\${c.url}" target="_blank" rel="noopener">\${c.sha}</a></td>
          <td><div class="commit-subject">\${escapeHtml(c.subject)}</div>\${c.reasons.length ? \`<div class="commit-reasons">\${c.reasons.map(escapeHtml).join(' · ')}</div>\` : ''}</td>
          <td><span class="risk-pill chip \${riskClass(c.risk)}">\${c.risk || 'LOW'}</span></td>
          <td style="font-variant-numeric: tabular-nums;">\${c.verify}</td>
        </tr>\`).join('');
      tableWrap.innerHTML = \`<table class="commits"><thead><tr><th>Commit</th><th>Subject</th><th>Risk</th><th>Verify</th></tr></thead><tbody>\${rowsHtml}</tbody></table>\`;
      details.appendChild(tableWrap);
      repoList.appendChild(details);
    }
  }
  renderRepos('');
  document.getElementById('filter').addEventListener('input', e => renderRepos(e.target.value));
</script>
</body>
</html>
`;
}

function main() {
  const repos = JSON.parse(fs.readFileSync(path.join(ROOT, 'repos.json'), 'utf8'));
  const rawEntries = loadAllRuns();
  const rows = dedupeAndRetriage(rawEntries);
  const flaggedRows = rows.filter((r) => r.flagged);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), buildHtml(rows, repos.length));

  // Small machine-readable summary — the workflow's email step reads this
  // rather than re-deriving counts in shell/jq.
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify({
    repoCount: repos.length,
    commitCount: rows.length,
    flaggedCount: flaggedRows.length,
    flagged: flaggedRows.map((r) => ({ repo: r.repo, sha: r.sha, subject: r.subject, url: r.url, reasons: r.reasons })),
  }, null, 2));

  process.stderr.write(`[render-report] wrote ${path.join(OUT_DIR, 'index.html')} (${rows.length} commits, ${flaggedRows.length} flagged)\n`);
}

main();
