// SPDX-License-Identifier: AGPL-3.0-only
// Offline conversion only; no filesystem or account access in this module.
const identity = (source, id) => id == null || id === '' ? '' : `${source}:${id}`;
// The old shared model dropped QQ artist/album MIDs. Preserve their names
// without turning a numeric legacy ID into a broken QQ detail-page link.
const detailID = (source, id) => source === 'qqmusic' && /^\d+$/.test(String(id || '')) ? '' : identity(source, id);
const artist = (source, a) => ({ id: detailID(source, a.id), name: String(a.name || '') });
export function convertLegacy(input) {
  if (!Array.isArray(input)) throw new Error('旧版歌单文件必须是 JSON 数组');
  const skipped = [];
  const playlists = input.filter(p => Number(p.id) < 0).map(p => {
    const byID = new Map();
    for (const t of p.tracks || []) {
      const source = !t.src ? 'netease' : t.src === 'qqmusic' ? 'qqmusic' : null;
      if (!source) { skipped.push({ playlist: p.name, id: t.id, source: t.src }); continue; }
      const rawID = source === 'qqmusic' ? t.ref || t.id : t.id;
      if (rawID == null || rawID === '') throw new Error('旧版歌曲缺少有效 ID');
      const name = String(t.name || '未命名歌曲');
      const album = t.al || t.album || {};
      const record = {
        id: identity(source, String(rawID)), name, fusionOriginalName: name,
        artists: (t.ar || t.artists || []).map(a => artist(source, a)),
        album: { id: detailID(source, album.id), name: String(album.name || ''), imageUrl: album.picUrl || '' },
        duration: Number(t.dt || t.duration) || 0,
        url: source === 'netease' ? `https://music.163.com/song?id=${t.id}` : `https://y.qq.com/n/ryqq/songDetail/${rawID}`,
        unavailable: false,
      };
      if (!byID.has(record.id)) byID.set(record.id, record);
    }
    return { name: String(p.name || '导入歌单'), description: String(p.description || ''), tracks: [...byID.values()] };
  });
  return { data: { format: 'mygo-music-fusion', version: 1, playlists }, skipped };
}
