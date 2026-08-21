#!/bin/bash
set -euo pipefail

# Ship the working tree as a PR branch.
#
# Two things used to make this tedious, both fixed here:
#
#   1. The sync was `git pull origin main --rebase 2>/dev/null || true`, which
#      FAILS on a dirty tree — and the `|| true` swallowed it. So the usual case
#      (uncommitted work, which is the only case this script runs in) silently
#      skipped the pull and branched off a stale main. That is how a whole PR got
#      built on a six-commit-old base and had to be rebuilt by hand.
#      → Now: stash FIRST, then fetch and fast-forward, and STOP LOUDLY if it
#        cannot.
#
#   2. The branch name came from local `.pr-counter`, which drifts behind
#      whenever another session ships. `git checkout -b` then died with "branch
#      already exists" — AFTER `git stash -u` had already run, leaving the work
#      stashed and the tree looking reverted.
#      → Now: the next number comes from the REMOTE branch list (the only source
#        of truth), and any taken number is skipped.

command -v gh >/dev/null 2>&1 || {
  echo "GitHub CLI not found. Install it: brew install gh && gh auth login" >&2
  exit 1
}

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "Switch to main before shipping (currently on $CURRENT_BRANCH)." >&2
  exit 1
fi

if [ -z "$(git status --porcelain)" ]; then
  echo "Nothing to commit."
  exit 0
fi

echo ""
echo "Commit message:"
read -r MSG
if [ -z "$MSG" ]; then
  echo "Commit message required." >&2
  exit 1
fi

# ── 1. Park the work so the sync cannot trip over it ────────────────────────────
STASHED=0
restore_stash() {
  if [ "$STASHED" = "1" ]; then
    echo "Restoring your working tree from the stash..." >&2
    git stash pop || echo "Stash pop failed — your work is safe in 'git stash list'." >&2
    STASHED=0
  fi
}
trap 'restore_stash' EXIT

git stash push -u -m "ship.sh: $MSG" >/dev/null
STASHED=1

# ── 2. Sync main — and refuse to continue on a stale or diverged base ───────────
echo "Syncing main with origin..."
git fetch origin --prune
BEHIND=$(git rev-list --count HEAD..origin/main)
AHEAD=$(git rev-list --count origin/main..HEAD)
if [ "$AHEAD" != "0" ]; then
  echo "Local main is $AHEAD commit(s) ahead of origin/main — it should never be." >&2
  echo "Sort that out first (commits belong on a pr-* branch, not main)." >&2
  exit 1
fi
if [ "$BEHIND" != "0" ]; then
  echo "  main was $BEHIND commit(s) behind — fast-forwarding."
  git merge --ff-only origin/main
fi
echo "  main is at $(git rev-parse --short HEAD) (== origin/main)."

# ── 3. Pick a branch number that is actually free, per the remote ───────────────
REMOTE_MAX=$(git ls-remote --heads origin 'refs/heads/pr-*' 2>/dev/null \
  | sed -n 's#.*refs/heads/pr-0*\([0-9][0-9]*\)$#\1#p' | sort -n | tail -1)
REMOTE_MAX=${REMOTE_MAX:-0}
LOCAL_MAX=$(cat .pr-counter 2>/dev/null || echo 0)
NEXT=$(( REMOTE_MAX > LOCAL_MAX ? REMOTE_MAX : LOCAL_MAX ))
NEXT=$(( NEXT + 1 ))

while :; do
  PR_BRANCH=$(printf "pr-%04d" "$NEXT")
  taken=0
  git show-ref --verify --quiet "refs/heads/$PR_BRANCH" && taken=1
  git ls-remote --exit-code --heads origin "$PR_BRANCH" >/dev/null 2>&1 && taken=1
  [ "$taken" = "0" ] && break
  echo "  $PR_BRANCH is taken — trying the next number."
  NEXT=$(( NEXT + 1 ))
done
echo "  shipping as $PR_BRANCH (remote high-water was $REMOTE_MAX)."

# ── 4. Branch, restore the work, commit ────────────────────────────────────────
git checkout -b "$PR_BRANCH"
restore_stash          # onto the new branch, where the work belongs
trap - EXIT

git add -A
git commit -q -m "$MSG"

echo "$NEXT" > .pr-counter
git add .pr-counter
git commit -q -m "chore: bump PR counter to $(printf '%04d' "$NEXT")"

# ── 5. Push and open the PR ────────────────────────────────────────────────────
git push -u origin "$PR_BRANCH"

gh pr create \
  --title "$(printf 'pr-%04d' "$NEXT"): $MSG" \
  --body "$(cat <<EOF
## Summary
$MSG

## Review checklist
- [ ] Changes reviewed
- [ ] Tested locally
- [ ] Safe to merge to main

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" \
  --base main \
  --head "$PR_BRANCH"

git checkout main

echo ""
echo "PR created: $PR_BRANCH — awaiting approval before merge to main."
