import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import net from 'net';
import { captureProcessStartToken, isProcessAlive } from '../../src/services/infrastructure/ProcessManager.js';
import { ensureWorkerStarted } from '../../src/services/worker-spawner.js';

const dataDir = path.join(homedir(), '.claude-mem');
const pidFile = path.join(dataDir, 'worker.pid');
const fixturePath = path.join(dataDir, 'worker-spawner-fixture.cjs');
const children: number[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to allocate test port'));
        return;
      }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function workerFixture(): string {
  return `
    const fs = require('fs');
    const http = require('http');
    const path = require('path');
    const port = Number(process.env.CLAUDE_MEM_WORKER_PORT);
    const dataDir = process.env.CLAUDE_MEM_DATA_DIR;
    const server = http.createServer((request, response) => {
      if (request.url === '/api/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (request.url === '/api/readiness') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ready' }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.listen(port, '127.0.0.1', () => {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'worker.pid'), JSON.stringify({
        pid: process.pid,
        port,
        startedAt: new Date().toISOString(),
        startToken: 'fixture'
      }));
    });
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `;
}

function wedgedWorkerFixture(): string {
  return `
    const fs = require('fs');
    const path = require('path');
    const port = Number(process.env.CLAUDE_MEM_WORKER_PORT);
    const dataDir = process.env.CLAUDE_MEM_DATA_DIR;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'worker.pid'), JSON.stringify({
      pid: process.pid,
      port,
      startedAt: new Date().toISOString()
    }));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1_000);
  `;
}

afterEach(() => {
  for (const pid of children.splice(0)) {
    if (isProcessAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* process already exited */ }
    }
  }

  if (existsSync(pidFile)) {
    try {
      const pid = JSON.parse(readFileSync(pidFile, 'utf-8')).pid as number;
      if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
    } catch { /* fixture cleanup is best effort */ }
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe('ensureWorkerStarted unhealthy PID recovery', () => {
  it('reclaims a wedged PID holder and starts a healthy replacement in the same launcher call', async () => {
    const port = await freePort();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(fixturePath, workerFixture());

    const wedge: ChildProcess = spawn(process.execPath, [
      '-e',
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
    ], { stdio: 'ignore' });
    expect(wedge.pid).toBeNumber();
    const wedgePid = wedge.pid!;
    children.push(wedgePid);

    const startToken = captureProcessStartToken(wedgePid);
    expect(startToken).not.toBeNull();
    writeFileSync(pidFile, JSON.stringify({
      pid: wedgePid,
      port,
      startedAt: new Date().toISOString(),
      startToken
    }));

    expect(await ensureWorkerStarted(port, fixturePath)).toBe(true);
    expect(isProcessAlive(wedgePid)).toBe(false);

    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(health.ok).toBe(true);
    expect(await health.json()).toEqual({ status: 'ok' });
  }, 15_000);

  it('performs only one reclaim when the replacement also wedges', async () => {
    const port = await freePort();
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
    writeFileSync(fixturePath, wedgedWorkerFixture());

    const wedge: ChildProcess = spawn(process.execPath, [
      '-e',
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
    ], { stdio: 'ignore' });
    expect(wedge.pid).toBeNumber();
    const wedgePid = wedge.pid!;
    children.push(wedgePid);

    const startToken = captureProcessStartToken(wedgePid);
    expect(startToken).not.toBeNull();
    writeFileSync(pidFile, JSON.stringify({
      pid: wedgePid,
      port,
      startedAt: new Date().toISOString(),
      startToken
    }));

    expect(await ensureWorkerStarted(port, fixturePath)).toBe(false);
    expect(isProcessAlive(wedgePid)).toBe(false);

    const replacementPid = JSON.parse(readFileSync(pidFile, 'utf-8')).pid as number;
    expect(isProcessAlive(replacementPid)).toBe(true);
    children.push(replacementPid);
  }, 30_000);
});
