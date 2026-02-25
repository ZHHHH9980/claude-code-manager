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

npm install
npm install node-pty@1.0.0 --save-exact --build-from-source
cd client && npm install && npm run build && cd ..

set -a && [ -f "$HOME/.bash_profile" ] && . "$HOME/.bash_profile" && set +a

if git diff "$OLD_HEAD" HEAD --name-only | grep -qv '^client/'; then
  echo "Backend changes detected, restarting server..."
  pm2 restart claude-manager --update-env 2>/dev/null || pm2 start server/index.js --name claude-manager
  pm2 save
else
  echo "Frontend-only changes, skipping server restart"
fi
REMOTE_SCRIPT

echo "Done! http://43.138.129.193:3000"
