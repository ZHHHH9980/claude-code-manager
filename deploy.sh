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
  npm rebuild node-pty --build-from-source
fi

cd client && npm install && npm run build && cd ..

set -a && [ -f "$HOME/.bash_profile" ] && . "$HOME/.bash_profile" && set +a

if echo "$CHANGED" | grep -qv '^client/'; then
  echo "Restarting server..."
  pm2 restart claude-manager --update-env 2>/dev/null || pm2 start server/index.js --name claude-manager
  pm2 save
else
  echo "Frontend-only changes, skipping server restart"
fi
REMOTE_SCRIPT

echo "Done! http://43.138.129.193:3000"
