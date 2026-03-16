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

export SESSION_MANAGER_URL="${SESSION_MANAGER_URL:-http://127.0.0.1:3001}"
export SESSION_MANAGER_PORT="${SESSION_MANAGER_PORT:-3001}"
export SESSION_MANAGER_PUBLIC_PORT="${SESSION_MANAGER_PUBLIC_PORT:-3001}"
export CHAT_MANAGER_URL="${CHAT_MANAGER_URL:-http://127.0.0.1:3002}"
export CHAT_MANAGER_PORT="${CHAT_MANAGER_PORT:-3002}"
export CHAT_MANAGER_PUBLIC_PORT="${CHAT_MANAGER_PUBLIC_PORT:-3002}"

SESSION_CHANGED=0
if echo "$CHANGED" | grep -Eq '^(package(-lock)?\.json|server/(session-manager\.js|session-manager-routes\.js|pty-manager\.js|terminal-socket\.js|terminal-http-helpers\.js|http-bootstrap\.js|runtime-lifecycle\.js))'; then
  SESSION_CHANGED=1
fi

CHAT_CHANGED=0
if echo "$CHANGED" | grep -Eq '^(package(-lock)?\.json|server/(chat-manager\.js|chat-service-config\.js|chat-runtime-control\.js|task-chat-runtime\.js|task-chat-service\.js|task-chat-routes\.js|agent-service\.js|agent-routes\.js|http-bootstrap\.js|runtime-lifecycle\.js|task-process\.js|project-context\.js|adapter-launch\.js|adapters/))'; then
  CHAT_CHANGED=1
fi

echo "Ensuring session manager is online..."
pm2 describe claude-manager-session >/dev/null 2>&1 \
  || pm2 start server/session-manager.js --name claude-manager-session

if [ "$SESSION_CHANGED" -eq 1 ]; then
  echo "Session service changes detected, restarting session manager..."
  pm2 restart claude-manager-session --update-env
fi

echo "Ensuring chat manager is online..."
pm2 describe claude-manager-chat >/dev/null 2>&1 \
  || pm2 start server/chat-manager.js --name claude-manager-chat

if [ "$CHAT_CHANGED" -eq 1 ]; then
  echo "Chat service changes detected, restarting chat manager..."
  pm2 restart claude-manager-chat --update-env
fi

if echo "$CHANGED" | grep -qv '^client/'; then
  echo "Restarting API server..."
  pm2 restart claude-manager-api --update-env 2>/dev/null || pm2 start server/index.js --name claude-manager-api
fi

echo "Restarting static server..."
pm2 restart claude-manager-static --update-env 2>/dev/null || pm2 start static-server.js --name claude-manager-static

pm2 save
REMOTE_SCRIPT

echo "Done!"
echo "UI:  http://43.138.129.193:8080"
echo "API: http://43.138.129.193:3000"
echo "TTY: http://43.138.129.193:3001"
echo "CHAT: http://43.138.129.193:3002"
