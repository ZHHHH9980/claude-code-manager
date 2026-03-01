#!/bin/bash
set -e

SERVER="tencent"
REMOTE_DIR="/opt/claude-code-manager"

echo "Remote self-update (no local rsync)..."
ssh $SERVER bash << 'REMOTE_SCRIPT'
set -e

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 22

cd /opt/claude-code-manager

git fetch origin
OLD_HEAD=$(git rev-parse HEAD)
git checkout main && git reset --hard origin/main && git clean -fd

CHANGED=$(git diff "$OLD_HEAD" HEAD --name-only)

if echo "$CHANGED" | grep -qv '^client/'; then
  echo "Backend changes detected, installing server deps..."
  npm install --ignore-scripts
  (cd /opt/claude-code-manager && npm rebuild node-pty --build-from-source)
fi

cd client && npm install && npm run build && cd ..

set -a && [ -f "$HOME/.bash_profile" ] && . "$HOME/.bash_profile" && set +a

if echo "$CHANGED" | grep -qv '^client/'; then
  echo "Restarting API server..."
  pm2 restart claude-manager-api --update-env 2>/dev/null || pm2 start server/index.js --name claude-manager-api
fi

echo "Restarting static server..."
pm2 restart claude-manager-static --update-env 2>/dev/null || pm2 start static-server.js --name claude-manager-static

pm2 save
REMOTE_SCRIPT

echo "Done! http://43.138.129.193:3000"
