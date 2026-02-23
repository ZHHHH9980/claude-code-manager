#!/bin/bash
set -e

SERVER="tencent"
REMOTE_DIR="/opt/claude-code-manager"

echo "Building client..."
cd client && npm run build && cd ..

echo "Syncing to server..."
rsync -avz --exclude node_modules --exclude .git --exclude .env \
  ./ $SERVER:$REMOTE_DIR/

echo "Installing deps and restarting on server..."
ssh $SERVER "cd $REMOTE_DIR && npm install --production && \
  (pm2 restart claude-manager 2>/dev/null || pm2 start server/index.js --name claude-manager)"

echo "Done! http://43.138.129.193:3000"
