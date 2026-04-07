#!/bin/bash
# Pre-build guard: ensures builds only happen from the 'deploy' branch.
# Prevents accidental deployment of feature branches missing merged features.

REQUIRED_BRANCH="deploy"
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null)

if [ "$CURRENT_BRANCH" != "$REQUIRED_BRANCH" ]; then
  echo ""
  echo "ERROR: Build blocked. Must be on '$REQUIRED_BRANCH' branch."
  echo "  Current branch: $CURRENT_BRANCH"
  echo ""
  echo "  To fix: git checkout $REQUIRED_BRANCH"
  echo "  To bypass (not recommended): SKIP_BRANCH_CHECK=1 npm run build-and-sync"
  echo ""
  if [ "$SKIP_BRANCH_CHECK" != "1" ]; then
    exit 1
  fi
  echo "  WARNING: SKIP_BRANCH_CHECK is set. Proceeding on wrong branch."
fi

# Stamp build info into a manifest file that the worker can read
BUILD_MANIFEST="plugin/scripts/build-manifest.json"
cat > "$BUILD_MANIFEST" << EOF
{
  "branch": "$CURRENT_BRANCH",
  "commit": "$(git rev-parse --short HEAD 2>/dev/null)",
  "commitFull": "$(git rev-parse HEAD 2>/dev/null)",
  "buildTime": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "version": "$(node -p "require('./package.json').version" 2>/dev/null)",
  "features": [
$(git log --oneline deploy --not $(git merge-base deploy feat/flashrank-reranking 2>/dev/null || echo "HEAD~20") 2>/dev/null | sed 's/^/    "/;s/$/"/' | paste -sd, - 2>/dev/null || echo '    "unknown"')
  ]
}
EOF

echo "Build manifest written: branch=$CURRENT_BRANCH commit=$(git rev-parse --short HEAD)"
