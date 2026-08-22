#!/usr/bin/env bash
# deploy.sh — Commit dev changes and push to GitHub to trigger Docker build
# Usage:
#   ./deploy.sh "your commit message"            # Push to GitHub only
#   ./deploy.sh "your commit message" --deploy   # Push + SSH deploy to prod server
#
# Environment variables (set in .env or export before running):
#   DEPLOY_SSH_HOST  — Production server hostname/IP
#   DEPLOY_SSH_USER  — SSH user (default: ubuntu)
#   DEPLOY_SSH_PATH  — Path on server (default: /opt/icao-runway-tester)

set -e

MSG="${1:-chore: production deploy}"
DO_SSH=false

for arg in "$@"; do
  if [[ "$arg" == "--deploy" ]]; then
    DO_SSH=true
  fi
done

DEPLOY_SSH_USER="${DEPLOY_SSH_USER:-ubuntu}"
DEPLOY_SSH_PATH="${DEPLOY_SSH_PATH:-/opt/icao-runway-tester}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  🚀 ICAO Runway Tester — Production Deploy"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📋 Message : $MSG"
echo "📁 Branch  : $(git rev-parse --abbrev-ref HEAD)"
echo ""

# Stage and commit
git add -A

STATUS=$(git status --porcelain)
if [ -z "$STATUS" ]; then
  echo "✅ Nothing to commit — already up to date"
else
  echo "📝 Staging:"
  git status --short
  echo ""
  git commit -m "$MSG"
  echo "✅ Committed"
fi

# Push to GitHub → triggers GitHub Actions → builds Docker image
git push origin main
echo "✅ Pushed to GitHub"
echo "⏳ GitHub Actions will build & push the Docker image (~2-3 min)"
echo "   Watch: https://github.com/MYTECHREVIEW/icao-runway-tester/actions"
echo ""

# Optional: SSH into production and pull new image
if [[ "$DO_SSH" == "true" ]]; then
  if [ -z "${DEPLOY_SSH_HOST}" ]; then
    echo "⚠️  DEPLOY_SSH_HOST not set — skipping SSH deploy"
    echo "   Set it with: export DEPLOY_SSH_HOST=your.server.ip"
  else
    echo "🔗 SSHing into ${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}..."
    echo "   (Waiting 90s for Docker build to complete first)"
    sleep 90
    ssh -o StrictHostKeyChecking=no "${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}" \
      "cd ${DEPLOY_SSH_PATH} && docker-compose pull && docker-compose up -d && echo '✅ Container updated'"
    echo "✅ Production server updated"
  fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Deploy complete"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
