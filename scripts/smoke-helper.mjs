// Exercise the actual local helper process without creating a real QR session.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { appHelperPath, entropyRandom } from '../src/providers/qqmusic/auth-app.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const platform = process.platform === 'win32' ? 'windows' : process.platform;
const arch = process.arch === 'x64' ? 'amd64' : process.arch;
const path = appHelperPath(platform, arch);
const child = spawn(join(root, path), [], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', value => { stderr += value; if (stderr.length > 65536) child.kill(); });
const ended = once(child, 'close');
const timeout = setTimeout(() => child.kill(), 5000);
try {
  const first = await lines[Symbol.asyncIterator]().next();
  assert.equal(first.done, false, 'Helper closed before readiness');
  assert.equal(first.value.length < 65536, true, 'Helper readiness exceeded the protocol limit');
  const ready = JSON.parse(first.value);
  assert.equal(ready.type, 'ready');
  assert.equal(entropyRandom(ready.entropy)(4096).length, 4096);
  // EOF cancels before any subscribe command, so no Tencent connection is made.
  child.stdin.end();
  const [code, signal] = await ended;
  assert.equal(code, 0, 'Helper did not exit cleanly after EOF');
  assert.equal(signal, null);
  assert.equal(stderr, '', 'Helper unexpectedly wrote diagnostic output');
  console.log(`Actual helper IPC smoke passed (${platform}/${arch}): ready → EOF → clean exit; no QR/network session.`);
} finally {
  clearTimeout(timeout);
  lines.close();
  if (child.exitCode === null) child.kill();
}
