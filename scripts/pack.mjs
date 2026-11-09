import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, copyFile, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
await readFile(join(root, manifest.main));
for (const path of manifest.permissions.process || []) {
  if (!/^bin\/qqmusic-login-(darwin|linux|windows)-(arm64|amd64)(\.exe)?$/.test(path)) throw new Error('Unexpected helper executable permission');
  const info = await stat(join(root, path));
  if (!info.isFile() || info.size < 1024 || !(info.mode & 0o111)) throw new Error(`Build the native helper before packing: ${path}`);
}
const releases = join(root, 'releases');
await mkdir(releases, { recursive: true });
const name = `neteaseXqqmusic-${manifest.version}.zip`;
const output = join(releases, name);
const temporary = await mkdtemp(join(tmpdir(), 'fusion-pack-'));
try {
  const archive = join(temporary, name);
  const entries = ['plugin.json', 'dist', 'bin', 'native', 'src', 'scripts', 'tests', 'docs', 'locales', 'licenses', 'LICENSE', 'README.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json', '.gitignore', '.gitattributes', '.github'];
  const zipped = spawnSync('zip', ['-q', '-r', '-X', archive, ...entries], { cwd: root, stdio: 'inherit' });
  if (zipped.error) throw zipped.error;
  if (zipped.status !== 0) throw new Error('ZIP packaging failed');
  // Refuse overwriting an older deliverable accidentally.
  await copyFile(archive, output, constants.COPYFILE_EXCL);
  const digest = createHash('sha256').update(await readFile(output)).digest('hex');
  await writeFile(join(releases, `${name}.sha256`), `${digest}  ${name}\n`, { flag: 'wx' });
  console.log(output);
  console.log(`SHA256 ${digest}`);
} finally { await rm(temporary, { recursive: true, force: true }); }
