#!/bin/bash
set -e

SERVER="tencent"
REMOTE_DIR="/opt/claude-code-manager"

echo "Remote self-update (no local rsync)..."
ssh $SERVER "export NVM_DIR=\"\$HOME/.nvm\" && [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\" && nvm use 22 && \
  cd $REMOTE_DIR && git fetch origin && git checkout main && git reset --hard origin/main && git clean -fd && \
  npm install && \
  npm install node-pty@1.0.0 --save-exact --build-from-source && \
  cd client && npm install && npm run build && cd .. && \
  set -a && [ -f \"\$HOME/.bash_profile\" ] && . \"\$HOME/.bash_profile\" && set +a && \
  (pm2 restart claude-manager --update-env 2>/dev/null || pm2 start server/index.js --name claude-manager) && \
  pm2 save"

echo "Done! http://43.138.129.193:3000"
