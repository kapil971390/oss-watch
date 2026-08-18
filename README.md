# oss-watch

Personal tool. Not part of VeriQA. Runs `veriqa analyze` on new commits across
repos we've already gotten a PR merged into, twice daily via GitHub Actions,
and flags anything worth a manual look.

## What it does

1. `repos.json` — the list of watched repos (owner/repo). Grows automatically
   via `--add-repo`, no manual JSON editing needed.
2. `.github/workflows/watch.yml` runs `watch.js` on a schedule (03:00 and
   15:00 UTC). Each run:
   - clones the private `VeriQA_Dev` repo fresh to get a working `veriqa` CLI
     (not published on npm, so this repo can't depend on it directly)
   - for each watched repo, clones/diffs against the last commit this tool
     has seen (`state.json`), and runs `veriqa analyze` on each new commit
   - flags a commit if VeriQA found a `[PROVEN]` issue, called the risk
     HIGH/CRITICAL, or the commit message/changed files look
     security/auth-sensitive
   - writes `queue.md` (the flagged list) and commits `state.json` +
     `queue.md` + `reports/` back to this repo

## What it does NOT do

Replace manual review. Real bugs found so far this project (Kaneo,
future-agi) were found by a human reading code closely — VeriQA's own
automated pass, even with agentic multi-lens investigation, missed both. This
tool only narrows the search space: `queue.md` is a list of candidates worth
sitting down with, not a list of confirmed bugs.

## Adding a repo

```bash
node watch.js --add-repo=owner/repo
# or a full GitHub URL
node watch.js --add-repo=https://github.com/owner/repo.git
git add repos.json && git commit -m "add owner/repo to watch list" && git push
```

It's picked up on the next scheduled run automatically.

## Running locally

```bash
export VERIQA_CLI="veriqa"   # assumes VeriQA_Dev is npm-linked locally
node watch.js --max-per-repo=5
```

## Secrets (GitHub Actions → Settings → Secrets and variables → Actions)

- `VERIQA_DEV_PAT` — a token with `repo` scope, to clone the private
  `VeriQA_Dev` repo
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` — same keys VeriQA itself uses
- `VERIQA_USE_OPENAI` — `true`/`false`, matches VeriQA_Dev's own `.env`
