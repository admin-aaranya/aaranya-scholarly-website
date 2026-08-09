// Runner for test/e2e.js.
//
// Boots the app on a spare port with a throwaway DATA_DIR, waits for it to
// answer, runs the walk, then tears everything down and deletes the data.
//
// The throwaway directory is the point: the end-to-end test creates real
// accounts, submissions and published articles, and running it against your
// own data/ would leave a fake published article in the archive.
//
// Cross-platform (no shell built-ins), so `npm run test:e2e` behaves the same
// on Windows as it does in CI.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.E2E_PORT || 4100;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aaranya-e2e-'));
const ROOT = path.join(__dirname, '..');

const env = Object.assign({}, process.env, {
  PORT: String(PORT),
  DATA_DIR,
  SITE_URL: BASE,
  EDITOR_EMAILS: 'editor@aaranyascholarly.com',
  // Force the local JSON store even on a machine that happens to have gcloud
  // credentials lying around -- an end-to-end test must never touch the real
  // Firestore project.
  GOOGLE_APPLICATION_CREDENTIALS: '',
  GOOGLE_CLOUD_PROJECT: '',
  GCLOUD_PROJECT: '',
  FIRESTORE_EMULATOR_HOST: '',
  GCS_BUCKET: '',
});

let server;

function cleanup() {
  if (server && !server.killed) server.kill();
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch (e) {
    /* best effort */
  }
}

async function waitForServer(attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(BASE + '/api/public/journals');
      if (res.ok) return true;
    } catch (e) {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  console.log(`[e2e] starting the server on ${BASE} with a throwaway data directory`);
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const serverLog = [];
  server.stdout.on('data', (d) => serverLog.push(d.toString()));
  server.stderr.on('data', (d) => serverLog.push(d.toString()));
  server.on('exit', (code) => {
    if (code) {
      console.error('[e2e] the server exited unexpectedly:\n' + serverLog.join(''));
    }
  });

  if (!(await waitForServer())) {
    console.error('[e2e] the server never came up:\n' + serverLog.join(''));
    cleanup();
    process.exit(1);
  }

  const walk = spawn(process.execPath, [path.join(__dirname, 'e2e.js')], {
    cwd: ROOT,
    env: Object.assign({}, env, { E2E_BASE: BASE }),
    stdio: 'inherit',
  });

  walk.on('exit', (code) => {
    cleanup();
    process.exit(code || 0);
  });
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
