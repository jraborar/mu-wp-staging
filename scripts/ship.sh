#!/bin/bash
set -e

# Require gh CLI
if ! command -v gh &> /dev/null; then
  echo "GitHub CLI not found. Install it: brew install gh && gh auth login"
  exit 1
fi

# Must be on main
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "Switch to main before shipping (currently on $CURRENT_BRANCH)."
  exit 1
fi

# Sync main before branching
git pull origin main --rebase 2>/dev/null || true

# Check for any changes (modified, staged, or untracked)
if [ -z "$(git status --porcelain)" ]; then
  echo "Nothing to commit."
  exit 0
fi

# Prompt for commit message
echo ""
echo "Commit message:"
read -r MSG
if [ -z "$MSG" ]; then
  echo "Commit message required."
  exit 1
fi

# Determine next PR number
COUNTER_FILE=".pr-counter"
CURRENT=$(cat "$COUNTER_FILE" 2>/dev/null || echo "0")
NEXT=$((CURRENT + 1))
PR_BRANCH=$(printf "pr-%04d" $NEXT)

# Create PR branch from current main — do NOT commit to main
git stash -u
git checkout -b "$PR_BRANCH"
git stash pop

# Stage, commit, update counter — all on the PR branch
git add -A
git commit -m "$MSG"

echo "$NEXT" > "$COUNTER_FILE"
git add "$COUNTER_FILE"
git commit -m "chore: bump PR counter to $(printf '%04d' $NEXT)"

# Push PR branch
git push -u origin "$PR_BRANCH"

# Open PR
gh pr create \
  --title "$(printf 'pr-%04d' $NEXT): $MSG" \
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

# Return to main
git checkout main

echo ""
echo "PR created: $PR_BRANCH — awaiting approval before merge to main."
