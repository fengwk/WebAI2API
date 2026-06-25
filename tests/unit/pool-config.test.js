import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

import { validatePoolConfig } from '../../src/config/validator.js';

const repoRoot = path.resolve(process.cwd());

function writeTempConfig(rootDir) {
  const dataDir = path.join(rootDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.yaml'), `
server:
  port: 3000
backend:
  pool:
    strategy: least_busy
    waitTimeout: 120000
    failover:
      enabled: true
      maxRetries: 2
    instances:
      - name: browser_default
        workers:
          - name: default
            type: chatgpt
queue:
  queueBuffer: 2
  workerMaxPending: 10
  workerWaitTimeout: 300000
browser:
  headless: false
`, 'utf8');
}

test('validatePoolConfig validates queue-related fields', () => {
  assert.deepEqual(validatePoolConfig({
    strategy: 'least_busy',
    waitTimeout: 120,
    queueBuffer: 2,
    workerMaxPending: 10,
    workerWaitTimeout: 300000,
    failover: { enabled: true, maxRetries: 2 }
  }), { valid: true, errors: [] });

  const invalid = validatePoolConfig({
    queueBuffer: -1,
    workerMaxPending: 0,
    workerWaitTimeout: 999,
    waitTimeout: 0
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some(msg => msg.includes('queueBuffer')));
  assert.ok(invalid.errors.some(msg => msg.includes('workerMaxPending')));
  assert.ok(invalid.errors.some(msg => msg.includes('workerWaitTimeout')));
  assert.ok(invalid.errors.some(msg => msg.includes('waitTimeout')));
});

test('getPoolConfig/savePoolConfig expose queueBuffer and worker queue settings', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webai2api-pool-config-'));
  writeTempConfig(tempRoot);
  const prevCwd = process.cwd();
  process.chdir(tempRoot);

  try {
    const managerUrl = `${pathToFileURL(path.join(repoRoot, 'src/config/manager.js')).href}?t=${Date.now()}`;
    const { getPoolConfig, savePoolConfig } = await import(managerUrl);

    assert.deepEqual(getPoolConfig(), {
      strategy: 'least_busy',
      waitTimeout: 120,
      queueBuffer: 2,
      workerMaxPending: 10,
      workerWaitTimeout: 300000,
      failover: {
        enabled: true,
        maxRetries: 2
      }
    });

    savePoolConfig({
      strategy: 'round_robin',
      waitTimeout: 90,
      queueBuffer: 5,
      workerMaxPending: 7,
      workerWaitTimeout: 123000,
      failover: { enabled: false, maxRetries: 4 }
    });

    assert.deepEqual(getPoolConfig(), {
      strategy: 'round_robin',
      waitTimeout: 90,
      queueBuffer: 5,
      workerMaxPending: 7,
      workerWaitTimeout: 123000,
      failover: {
        enabled: false,
        maxRetries: 4
      }
    });
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
