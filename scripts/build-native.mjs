import { spawnSync } from 'node:child_process';
import { mkdir, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const targets = ['darwin-arm64', 'darwin-amd64', 'linux-arm64', 'linux-amd64', 'windows-arm64', 'windows-amd64'];
const chosen = process.argv.slice(2);
for (const target of chosen) if (!targets.includes(target)) throw new Error(`Unsupported target: ${target}`);
await mkdir(join(root, 'bin'), { recursive: true });
for (const target of chosen.length ? chosen : targets) {
  const [GOOS, GOARCH] = target.split('-');
  const output = join(root, 'bin', `qqmusic-login-${target}${GOOS === 'windows' ? '.exe' : ''}`);
  const result = spawnSync(process.env.GO || 'go', ['-C', join(root, 'native/qqmusic-login'), 'build', '-mod=vendor', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -buildid=', '-o', output, '.'], {
    env: { ...process.env, CGO_ENABLED: '0', GOOS, GOARCH }, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Native helper build failed: ${target}`);
  await chmod(output, 0o755);
  console.log(`Built QQ Music login helper: ${target}`);
}
