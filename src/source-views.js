// SPDX-License-Identifier: AGPL-3.0-only
const PROVIDERS = ['netease', 'qqmusic'];
const NAMES = { netease: '网易云', qqmusic: 'QQ 音乐' };
const invalid = () => Object.assign(new Error('搜索音源请填写 both、netease 或 qqmusic'), { code: 'setup' });
export function searchSource(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || ['both', '全部'].includes(raw)) return 'both';
  if (['netease', '网易云'].includes(raw)) return 'netease';
  if (['qqmusic', 'qq', 'qq音乐'].includes(raw)) return 'qqmusic';
  throw invalid();
}
export function searchScope(value, setting) {
  let query = String(value || '').trim();
  let source = searchSource(setting);
  const prefix = /^(qqmusic|qq|netease|网易云|qq音乐)[:：]\s*/i.exec(query);
  if (prefix) { source = searchSource(prefix[1]); query = query.slice(prefix[0].length).trim(); }
  return { query, source, providers: source === 'both' ? PROVIDERS : [source], prefix: prefix?.[0] || '' };
}
// Group with immutable IDs; track titles, artist credits and album names stay intact.
export function sourceSections(items, context, present = value => value) {
  return PROVIDERS.map(provider => {
    const tracks = items.filter(item => String(item.id).startsWith(provider + ':')).map(present);
    return { title: `${context} · ${NAMES[provider]}`, tracks, subtitle: `${tracks.length} 首`, empty: '暂无此音源歌曲' };
  });
}
