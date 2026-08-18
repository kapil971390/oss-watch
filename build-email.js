#!/usr/bin/env node
'use strict';

/**
 * build-email.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Turns _site/summary.json (written by render-report.js) into a small,
 * JS-free HTML email body — Gmail won't execute the dashboard's own <script>,
 * so this is a separate, static summary + a link to the real dashboard.
 *
 * Env: PAGES_URL (the deployed dashboard URL)
 * Usage: node build-email.js <summaryJsonPath> <outHtmlPath>
 */

const fs = require('fs');

const summaryPath = process.argv[2];
const outPath = process.argv[3];
const pagesUrl = process.env.PAGES_URL || '';

if (!summaryPath || !outPath) {
  process.stderr.write('Usage: node build-email.js <summaryJsonPath> <outHtmlPath>\n');
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const rows = summary.flagged.map((f) => `
  <li style="margin-bottom:14px">
    <b>${escapeHtml(f.repo)}</b> — <code>${escapeHtml(f.sha.slice(0, 8))}</code><br>
    ${escapeHtml(f.subject)}<br>
    <span style="color:#888;font-size:12px">${escapeHtml(f.reasons.join('; '))}</span>
    — <a href="${f.url}">view commit</a>
  </li>`).join('');

const html = `<!doctype html>
<html>
<body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#131A29;max-width:600px;margin:0 auto">
  <p><b>${summary.flaggedCount}</b> of ${summary.commitCount} commits across ${summary.repoCount} repos flagged for a manual look.</p>
  <p>
    <a href="${escapeHtml(pagesUrl)}" style="display:inline-block;padding:10px 18px;background:#0E9A87;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">
      Open full dashboard
    </a>
  </p>
  ${summary.flaggedCount ? `<ul style="padding-left:18px">${rows}</ul>` : '<p>Nothing flagged this run.</p>'}
  <p style="color:#93A0B8;font-size:11px;margin-top:24px">oss-watch · <a href="https://github.com/kapil971390/oss-watch">source</a></p>
</body>
</html>
`;

fs.writeFileSync(outPath, html);
process.stderr.write(`[build-email] wrote ${outPath}\n`);
