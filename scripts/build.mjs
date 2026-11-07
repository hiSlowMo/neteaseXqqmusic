import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(resolve(root, 'dist'), { recursive: true });
await build({
  absWorkingDir: root, entryPoints: ['src/index.js'], bundle: true,
  format: 'esm', platform: 'browser', target: 'es2020',
  outfile: resolve(root, 'dist/index.js'), legalComments: 'inline',
  banner: { js: '// NetEaseXQQMusic 0.1.1 — AGPL-3.0-only; full source and notices included.' },
});
await mkdir(resolve(root, 'licenses'), { recursive: true });
for (const [source, target] of [
  ['node_modules/jsqr/LICENSE', 'jsqr.LICENSE'],
  ['node_modules/jpeg-js/LICENSE', 'jpeg-js.LICENSE'],
  ['node_modules/pako/LICENSE', 'pako.LICENSE'],
]) await copyFile(resolve(root, source), resolve(root, 'licenses', target));
console.log('Built dist/index.js (single ES module for the MyGo plugin runtime).');
