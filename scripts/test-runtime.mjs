import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const upstream = process.argv[2];
if (!upstream) {
  console.error('Usage: node scripts/test-runtime.mjs <path-to-egoist-mygo-music-checkout>');
  process.exitCode = 1;
} else {
  const checkout = resolve(upstream);
  if (!(await readFile(join(checkout, 'go.mod'), 'utf8')).startsWith('module mygo-music\n')) throw new Error('This is not the MyGo Music source checkout.');
  const temporary = await mkdtemp(join(tmpdir(), 'fusion-runtime-'));
  try {
    const overlay = join(temporary, 'overlay.json');
    await writeFile(overlay, JSON.stringify({ Replace: {
      [join(checkout, 'internal/plugin/fusion_external_test.go')]: join(root, 'scripts/runtime_test.go'),
    } }));
    const result = spawnSync('go', ['-C', checkout, 'test', '-overlay', overlay, './internal/plugin', '-run', '^TestFusionExternalBundle$', '-count=1', '-timeout=90s'], {
      stdio: 'inherit', env: { ...process.env, FUSION_PLUGIN_DIR: root },
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
