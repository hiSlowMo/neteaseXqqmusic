import { readFile, writeFile } from 'node:fs/promises';
import { convertLegacy } from '../src/legacy.js';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('Usage: node scripts/import-playlists.mjs <old-playlists.json> <new-import.json>');
  process.exitCode = 1;
} else {
  try {
    const { data, skipped } = convertLegacy(JSON.parse(await readFile(input, 'utf8')));
    // Never overwrite the source or an existing destination.
    await writeFile(output, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
    console.log(`Converted ${data.playlists.length} playlists, ${data.playlists.reduce((n, p) => n + p.tracks.length, 0)} tracks.`);
    if (skipped.length) console.log(`Skipped ${skipped.length} tracks from unsupported providers.`);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
