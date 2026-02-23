#!/usr/bin/env bash
# Wait for GitHub release workflow then pull the result.
# Usage: ./scripts/post-push-sync.sh [branch]

set -euo pipefail

BRANCH="${1:-$(git branch --show-current)}"
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
TIMEOUT=180
POLL_INTERVAL=10

if [[ "$BRANCH" != "main" ]]; then
  echo "Not on main, skipping release sync."
  exit 0
fi

echo "Waiting for release workflow to start..."
sleep 3

RUN_ID=""
for i in $(seq 1 5); do
  RUN_ID=$(gh run list \
    --workflow=release.yml \
    --branch=main \
    --limit=1 \
    --json databaseId,status \
    -q '.[0].databaseId' 2>/dev/null || true)
  [[ -n "$RUN_ID" ]] && break
  sleep 2
done

if [[ -z "$RUN_ID" ]]; then
  echo "No release workflow run found. Nothing to sync."
  exit 0
fi

echo "Watching workflow run $RUN_ID..."
ELAPSED=0
while [[ $ELAPSED -lt $TIMEOUT ]]; do
  STATUS=$(gh run view "$RUN_ID" --json status,conclusion \
    -q '.status' 2>/dev/null || echo "unknown")

  if [[ "$STATUS" == "completed" ]]; then
    CONCLUSION=$(gh run view "$RUN_ID" --json conclusion \
      -q '.conclusion' 2>/dev/null || echo "unknown")

    if [[ "$CONCLUSION" == "success" ]]; then
      echo "Release workflow succeeded. Pulling..."
      git pull --ff-only
      echo "Synced to latest release commit."
    elif [[ "$CONCLUSION" == "skipped" ]]; then
      echo "Release workflow skipped (likely a release commit). Already up to date."
    else
      echo "Release workflow finished with: $CONCLUSION"
      echo "You may want to check: gh run view $RUN_ID"
    fi
    exit 0
  fi

  sleep "$POLL_INTERVAL"
  ELAPSED=$((ELAPSED + POLL_INTERVAL))
  echo "  ...still running (${ELAPSED}s)"
done

echo "Timed out after ${TIMEOUT}s. Check: gh run view $RUN_ID"
exit 1
