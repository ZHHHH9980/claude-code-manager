#!/bin/bash
set -e

SERVER="tencent"
REMOTE_DIR="/opt/claude-code-manager"

echo "Remote self-update (no local rsync)..."
ssh $SERVER "export NVM_DIR=\"\$HOME/.nvm\" && [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\" && nvm use 22 && \
  cd $REMOTE_DIR && git fetch origin && git checkout main && git reset --hard origin/main && git clean -fd && \
  npm install && \
  cd client && npm install && npm run build && cd .. && \
  (pm2 restart claude-manager 2>/dev/null || pm2 start server/index.js --name claude-manager)"

echo "Done! http://43.138.129.193:3000"
