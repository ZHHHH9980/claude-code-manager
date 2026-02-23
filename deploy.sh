#!/bin/bash
set -e

SERVER="tencent"
REMOTE_DIR="/opt/claude-code-manager"

echo "Syncing source to server..."
rsync -avz --exclude node_modules --exclude .git --exclude .env \
  --exclude client/dist --exclude data \
  ./ $SERVER:$REMOTE_DIR/

echo "Building and restarting on server..."
ssh $SERVER "export NVM_DIR=\"\$HOME/.nvm\" && [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\" && nvm use 22 && \
  cd $REMOTE_DIR && npm install && \
  cd client && npm install && npm run build && cd .. && \
  npm rebuild && \
  (pm2 restart claude-manager 2>/dev/null || pm2 start server/index.js --name claude-manager)"

echo "Done! http://43.138.129.193:3000"
