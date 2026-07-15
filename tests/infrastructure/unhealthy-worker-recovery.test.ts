import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';
import {
  captureProcessStartToken,
  isProcessAlive,
  terminateUnhealthyWorker,
  type PidInfo
} from '../../src/services/infrastructure/ProcessManager.js';

const children: ChildProcess[] = [];

function spawnWorkerFixture(ignoreSigterm: boolean = false): ChildProcess {
  const handler = ignoreSigterm ? "process.on('SIGTERM', () => {});" : '';
  const child = spawn(process.execPath, ['-e', `${handler}setInterval(() => {}, 1_000);`], {
    stdio: 'ignore'
  });
  children.push(child);
  return child;
}

async function waitFor(condition: () => boolean, timeoutMs: number = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return condition();
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.pid && isProcessAlive(child.pid)) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* process already exited */ }
    }
  }
});

describe('terminateUnhealthyWorker', () => {
  it('reclaims a positively identified worker that ignores SIGTERM', async () => {
    const child = spawnWorkerFixture(true);
    expect(child.pid).toBeNumber();
    const pid = child.pid!;
    expect(await waitFor(() => isProcessAlive(pid))).toBe(true);

    const startToken = captureProcessStartToken(pid);
    expect(startToken).not.toBeNull();
    const pidInfo: PidInfo = {
      pid,
      port: 39031,
      startedAt: new Date().toISOString(),
      startToken: startToken!
    };

    expect(await terminateUnhealthyWorker(pidInfo, 100, 1_000)).toBe(true);
    expect(await waitFor(() => !isProcessAlive(pid))).toBe(true);
  });

  it('refuses a legacy PID file without a process start token', async () => {
    const child = spawnWorkerFixture();
    expect(child.pid).toBeNumber();
    const pid = child.pid!;
    expect(await waitFor(() => isProcessAlive(pid))).toBe(true);

    const pidInfo: PidInfo = {
      pid,
      port: 39032,
      startedAt: new Date().toISOString()
    };

    expect(await terminateUnhealthyWorker(pidInfo, 10, 10)).toBe(false);
    expect(isProcessAlive(pid)).toBe(true);
  });
});
