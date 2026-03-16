# Deployment

## Production Model

Production is remote-only.

- The live service runs on the remote host targeted by [`deploy.sh`](./deploy.sh).
- Local processes are for development and local verification only.
- Running something locally does not change production state.

## Release Flow

Deployments are based on `origin/main`.

```bash
git add ...
git commit -m "your change"
git push origin main
./deploy.sh
```

If a change is not pushed to `origin/main`, it will not be deployed.

## What `deploy.sh` Does

[`deploy.sh`](./deploy.sh) SSHes to the remote host alias configured in the script and updates `/opt/claude-code-manager`.

On the remote server it:

1. Loads Node via `nvm use 22`.
2. Runs `git fetch origin`.
3. Resets the remote checkout to `origin/main`.
4. Removes untracked files with `git clean -fd`.
5. Reinstalls backend dependencies when non-frontend files changed.
6. Rebuilds `node-pty` from source when backend changes were detected.
7. Reinstalls frontend dependencies and rebuilds `client/`.
8. Ensures `claude-manager-session` is online.
9. Restarts `claude-manager-session` only when session-owned files changed.
10. Ensures `claude-manager-chat` is online.
11. Restarts `claude-manager-chat` only when chat-owned files changed.
12. Restarts `claude-manager-api` when backend files changed.
13. Restarts `claude-manager-static` on every deploy.
14. Saves the PM2 process list.

The remote update is destructive by design:

- The script runs `git reset --hard origin/main`.
- The script runs `git clean -fd`.
- Uncommitted or remote-only ad hoc changes on the server will be discarded.

## Operational Rules

- Always run local tests before pushing.
- Push the exact commit you want to release before running `./deploy.sh`.
- Treat `origin/main` as the source of truth for production.
- If you need to confirm what was deployed, check the remote `git rev-parse HEAD`.

## Post-Deploy Smoke Checks

After deploy, verify:

- UI responds on `http://43.138.129.193:8080`
- API responds on `http://43.138.129.193:3000`
- Session manager responds on `http://43.138.129.193:3001/healthz`
- Chat manager responds on `http://43.138.129.193:3002/healthz`
- `pm2 status` shows `claude-manager-session`, `claude-manager-chat`, `claude-manager-api`, and `claude-manager-static` as `online`

Example checks:

```bash
curl -I http://43.138.129.193:8080
curl http://43.138.129.193:3000/api/adapters
curl http://43.138.129.193:3001/healthz
curl http://43.138.129.193:3002/healthz
ssh tencent 'cd /opt/claude-code-manager && git rev-parse --short HEAD && pm2 status'
```
