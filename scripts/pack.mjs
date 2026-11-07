import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
await readFile(join(root, manifest.main));
const releases = join(root, 'releases');
await mkdir(releases, { recursive: true });
const name = `mygo-music-fusion-${manifest.version}.zip`;
const output = join(releases, name);
const temporary = await mkdtemp(join(tmpdir(), 'fusion-pack-'));
try {
  const archive = join(temporary, name);
  const entries = ['plugin.json', 'dist', 'src', 'scripts', 'tests', 'docs', 'locales', 'licenses', 'LICENSE', 'README.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json', '.gitignore', '.gitattributes', '.github'];
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
