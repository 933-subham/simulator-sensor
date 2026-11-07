#!/usr/bin/env bash
# ==============================================================================
# Secure Pull & Merge Workflow with Automated Functionality Verification (Bash)
# ==============================================================================
set -e

REMOTE="${1:-origin}"
BRANCH="${2:-$(git rev-parse --abbrev-ref HEAD)}"

echo -e "\033[1;35m=====================================================\033[0m"
echo -e "\033[1;35m       SENSOR-SIM-API SECURE PULL & MERGE (BASH)     \033[0m"
echo -e "\033[1;35m=====================================================\033[0m"

echo -e "\n\033[1;36m==> Checking current state (Branch: ${BRANCH}, Remote: ${REMOTE})\033[0m"

STASHED=0
if [ -n "$(git status --porcelain)" ]; then
    echo "Uncommitted local changes detected. Stashing safely..."
    STASH_NAME="secure-pull-backup-$(date +%Y%m%d-%H%M%S)"
    git stash push -m "$STASH_NAME" >/dev/null
    STASHED=1
    echo -e "\033[1;32m[OK] Local changes stashed\033[0m"
else
    echo -e "\033[1;32m[OK] Working directory is clean\033[0m"
fi

PREV_HEAD=$(git rev-parse HEAD)

rollback() {
    echo -e "\n\033[1;31m=====================================================\033[0m"
    echo -e "\033[1;31m ROLLBACK TRIGGERED: Pull aborted to protect codebase\033[0m"
    echo -e "\033[1;31m=====================================================\033[0m\n"
    git merge --abort 2>/dev/null || true
    git reset --hard "$PREV_HEAD" 2>/dev/null || true
    if [ "$STASHED" -eq 1 ]; then
        echo "Restoring stashed changes..."
        git stash pop >/dev/null || true
    fi
    echo -e "\033[1;33mRestored repository to pre-pull commit (${PREV_HEAD})\033[0m\n"
    exit 1
}

trap rollback ERR

echo -e "\n\033[1;36m==> Fetching latest commits securely from ${REMOTE}/${BRANCH}...\033[0m"
git fetch "$REMOTE" "$BRANCH"

INCOMING_COUNT=$(git rev-list --count HEAD.."${REMOTE}/${BRANCH}")
if [ "$INCOMING_COUNT" -eq 0 ]; then
    AHEAD_COUNT=$(git rev-list --count "${REMOTE}/${BRANCH}"..HEAD)
    if [ "$AHEAD_COUNT" -gt 0 ]; then
        echo -e "\033[1;32m[OK] Local branch '${BRANCH}' is ahead of ${REMOTE}/${BRANCH} by ${AHEAD_COUNT} commit(s) and already includes all remote commits.\033[0m"
    else
        echo -e "\033[1;32m[OK] Local branch '${BRANCH}' is completely up to date with ${REMOTE}/${BRANCH}.\033[0m"
    fi

    echo -e "\n\033[1;36m==> Running full test suite to verify current code...\033[0m"
    node test/run-tests.js

    if [ "$STASHED" -eq 1 ]; then
        git stash pop >/dev/null
        echo -e "\033[1;32m[OK] Stash restored\033[0m"
    fi
    echo -e "\n\033[1;32m=====================================================\033[0m"
    echo -e "\033[1;32m SUCCESS: Code verified & perfectly synchronized!    \033[0m"
    echo -e "\033[1;32m=====================================================\033[0m\n"
    exit 0
fi

echo -e "\n\033[1;36m==> Simulating trial merge without committing...\033[0m"
git merge --no-commit --no-ff "${REMOTE}/${BRANCH}"
echo -e "\033[1;32m[OK] Trial merge applied cleanly\033[0m"

DIFF_FILES=$(git diff --cached --name-only "$PREV_HEAD")
if echo "$DIFF_FILES" | grep -q "package.*json"; then
    echo -e "\n\033[1;36m==> Updating npm dependencies...\033[0m"
    npm install
fi

echo -e "\n\033[1;36m==> Running JavaScript syntax verification...\033[0m"
npm run test:syntax

echo -e "\n\033[1;36m==> Running 99-test functionality test suite...\033[0m"
node test/run-tests.js

echo -e "\n\033[1;36m==> Finalizing secure merge...\033[0m"
git commit -m "Merge remote-tracking branch '${REMOTE}/${BRANCH}' (Secure Verified)" >/dev/null

if [ "$STASHED" -eq 1 ]; then
    git stash pop >/dev/null
    echo -e "\033[1;32m[OK] Stash restored\033[0m"
fi

echo -e "\n\033[1;32m=====================================================\033[0m"
echo -e "\033[1;32m SUCCESS: Code pulled & merged securely!             \033[0m"
echo -e "\033[1;32m All backend functionality tests passed.             \033[0m"
echo -e "\033[1;32m=====================================================\033[0m\n"
