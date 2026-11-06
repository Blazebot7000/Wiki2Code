import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const dataDir = mkdtempSync(join(tmpdir(), 'w2c-smoke-'));
const services = ['github-svc', 'ai-svc', 'review-svc', 'sync-svc', 'gateway'];
const children = [];

const env = {
  ...process.env,
  WIKI2CODE_DATA_DIR: dataDir,
  WIKI2CODE_WEB_DIR: join(ROOT, 'apps', 'web', 'dist'),
};

for (const name of services) {
  const child = spawn(process.execPath, [join(ROOT, 'apps', name, 'dist', 'main.js')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.includes('listening') || line.includes('gateway')) {
        console.log(`[${name}] ${line}`);
      }
    }
  });
  child.stderr.on('data', (chunk) => console.error(`[${name}] ${chunk}`));
  children.push(child);
}

const base = 'http://127.0.0.1:3000';
const checks = [];

async function waitForGateway() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/setup`);
      if (response.ok) {
        return response.json();
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('gateway never became ready');
}

function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

try {
  const setup = await waitForGateway();
  check('setup state loads', setup && setup.completed === false, JSON.stringify(setup));
  check('no providers initially', Array.isArray(setup.providers) && setup.providers.length === 0);

  const index = await fetch(`${base}/`);
  check('gateway serves the web UI', index.ok && (await index.text()).includes('<div id="root">'));

  const complete = await fetch(`${base}/api/setup/complete`, { method: 'POST' });
  const completeBody = await complete.json();
  check(
    'setup cannot complete without providers',
    complete.status === 400 && /provider/i.test(completeBody.message),
    `${complete.status} ${completeBody.message}`,
  );

  const badHighlight = await fetch(`${base}/api/highlights/hl_missing`);
  const badBody = await badHighlight.json();
  check(
    'unknown highlight returns 404 with a message',
    badHighlight.status === 404 && typeof badBody.message === 'string',
    `${badHighlight.status} ${badBody.message}`,
  );

  const wiki = await fetch(`${base}/api/repos/owner__missing/wiki`);
  const wikiBody = await wiki.json();
  check(
    'unknown repo is reported clearly',
    wiki.status === 400 && /not connected/i.test(wikiBody.message),
    `${wiki.status} ${wikiBody.message}`,
  );

  const sync = await fetch(`${base}/api/sync-state`);
  const syncBody = await sync.json();
  check('sync state is reachable', sync.ok && Array.isArray(syncBody));

  const models = await fetch(`${base}/api/models`);
  const modelsBody = await models.json();
  check('models endpoint is reachable', models.ok && Array.isArray(modelsBody.models));

  const failures = checks.filter((item) => !item.ok);
  console.log(
    `\n${checks.length - failures.length}/${checks.length} checks passed`,
  );
  if (failures.length > 0) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error('SMOKE FAILED:', error);
  process.exitCode = 1;
} finally {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      // ignore
    }
  }
}
