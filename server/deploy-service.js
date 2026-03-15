function createDeployService({
  exec,
  rootDir,
  apiProcessName = 'claude-manager-api',
  staticProcessName = 'claude-manager-static',
}) {
  let deploying = false;

  function selfDeploy() {
    if (deploying) return Promise.resolve('already deploying');
    deploying = true;
    return new Promise((resolve, reject) => {
      const nvm = 'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm use 22 2>/dev/null;';
      const cmd = `${nvm} cd ${rootDir} && git fetch origin && git checkout main && git reset --hard origin/main && git clean -fd && npm install && npm install node-pty@1.0.0 --save-exact --build-from-source && cd client && npm install && npm run build && cd ..`;
      exec(cmd, { timeout: 120000 }, (err, stdout) => {
        deploying = false;
        if (err) return reject(err);
        setTimeout(() => {
          exec(`pm2 restart ${apiProcessName}`, () => {});
          exec(`pm2 restart ${staticProcessName}`, () => {});
        }, 500);
        resolve(stdout);
      });
    });
  }

  return {
    selfDeploy,
  };
}

module.exports = {
  createDeployService,
};
