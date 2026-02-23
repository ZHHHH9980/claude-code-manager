import chokidar from 'chokidar';
import { spawn } from 'node:child_process';

const watcher = chokidar.watch('client/src/**/*.{js,jsx,ts,tsx,css}', {
  ignoreInitial: true,
});

let timer = null;
let running = false;
let queued = false;

function runChecks() {
  if (running) {
    queued = true;
    return;
  }

  running = true;
  const child = spawn('npm', ['--prefix', 'client', 'run', 'mobile:build-check'], {
    stdio: 'inherit',
  });

  child.on('close', (code) => {
    running = false;
    const status = code === 0 ? 'PASS' : 'FAIL';
    console.log(`ui-mobile-watch: ${status}`);
    if (queued) {
      queued = false;
      runChecks();
    }
  });
}

function schedule(file) {
  console.log(`ui-mobile-watch: detected UI change -> ${file}`);
  clearTimeout(timer);
  timer = setTimeout(runChecks, 350);
}

watcher
  .on('add', schedule)
  .on('change', schedule)
  .on('unlink', schedule)
  .on('ready', () => console.log('ui-mobile-watch: watching client/src for UI changes'));
