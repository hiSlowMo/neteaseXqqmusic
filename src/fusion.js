// SPDX-License-Identifier: AGPL-3.0-only
import { parseQQLoginMethod } from './providers/qqmusic/login-method.js';
import { searchSource, searchScope, sourceSections } from './source-views.js';
const SOURCES = ['netease', 'qqmusic'];
const LABEL = { netease: '网易云', qqmusic: 'QQ' };
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

function error(code, message) {
  const e = new Error(message);
  if (code) e.code = code;
  return e;
}
export function splitID(value) {
  const match = /^(netease|qqmusic|local):(.+)$/.exec(String(value));
  if (!match) throw error('unavailable', '歌曲或页面缺少有效来源，请重新搜索后添加');
  return { provider: match[1], id: match[2] };
}
const identify = (provider, id) => id == null || id === '' ? '' : `${provider}:${id}`;
export function normalize(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}
export function relevance(item, query) {
  const q = normalize(query);
  if (!q) return 4;
  const title = normalize(String(item.name || '').replace(/ 〔(?:网易云|QQ)〕$/, ''));
  if (title === q) return 0;
  if (title.startsWith(q)) return 1;
  if (title.includes(q)) return 2;
  if ((item.artists || []).some(a => normalize(a.name).includes(q))) return 3;
  return 4;
}

export function createFusion(providers, host) {
  const searches = new Map();
  let lastTrackSearch = null;
  const statuses = new Map();
  let signingIn = false;
  let authEpoch = 0;
  const read = (key, fallback) => clone(host.storage.get(`fusion.${key}`) ?? fallback);
  const write = (key, value) => host.storage.set(`fusion.${key}`, clone(value));
  const setting = key => String(host.setting(key) || '');
  const parseTarget = value => {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw || ['both', '全部', '两个平台'].includes(raw)) return 'both';
    if (['netease', '网易云'].includes(raw)) return 'netease';
    if (['qqmusic', 'qq'].includes(raw)) return 'qqmusic';
    throw error('setup', '登录目标请填写 both、netease 或 qqmusic');
  };
  const target = () => parseTarget(setting('loginTarget'));
  const targets = () => target() === 'both' ? SOURCES : [target()];
  const method = (provider, name) => {
    const fn = providers[provider]?.[name];
    if (typeof fn !== 'function') throw error('unsupported', `${LABEL[provider] || provider} 暂不支持此操作`);
    return fn;
  };
  async function call(provider, name, args) {
    try {
      const result = await method(provider, name)(args);
      statuses.delete(provider);
      return result;
    } catch (e) {
      if (e.code !== 'unsupported') {
        statuses.set(provider, e.code === 'signIn' ? '需要重新扫码登录' : '上次请求失败，请检查网络或稍后重试');
      }
      throw e;
    }
  }
  function artist(provider, item = {}) {
    return { ...item, id: identify(provider, item.id) };
  }
  function album(provider, item = {}) {
    return { ...item, id: identify(provider, item.id), artists: (item.artists || []).map(a => artist(provider, a)) };
  }
  // 0.1.1 stored the display suffix in track names. Keep the original title
  // separately so toggling labels never accumulates suffixes or changes IDs.
  function storedTrack(item) {
    const provider = /^(netease|qqmusic):/.exec(String(item.id))?.[1];
    const hasOriginal = typeof item.fusionOriginalName === 'string';
    let name = hasOriginal ? item.fusionOriginalName : String(item.name || '未命名歌曲');
    const suffix = provider ? ` 〔${LABEL[provider]}〕` : '';
    if (!hasOriginal && suffix && name.endsWith(suffix)) name = name.slice(0, -suffix.length);
    return { ...item, name, fusionOriginalName: name };
  }
  function presentTrack(item) {
    const { fusionOriginalName, ...result } = storedTrack(item);
    const provider = /^(netease|qqmusic):/.exec(String(result.id))?.[1];
    if (provider && setting('showSourceInTitle').trim().toLowerCase() === 'true') result.name = `${fusionOriginalName} 〔${LABEL[provider]}〕`;
    return result;
  }
  function presentPlaylist(item) {
    return { ...item, ...(item.tracks ? { tracks: item.tracks.map(presentTrack) } : {}) };
  }
  function track(provider, item) {
    const name = String(item.name || '未命名歌曲');
    const result = {
      ...item, id: identify(provider, item.id), name, fusionOriginalName: name,
      artists: (item.artists || []).map(a => artist(provider, a)), album: album(provider, item.album),
    };
    if (item.showId) result.showId = identify(provider, item.showId);
    // List membership/VIP badges cannot prove that an authorized stream is
    // unavailable. Keep songs selectable and let stream() decide; podcast
    // episodes without an audio ID remain marked unavailable.
    result.unavailable = item.showId ? !!item.unavailable : false;
    delete result.source;
    return result;
  }
  function remember(items) {
    if (!items.length) return items;
    const catalog = read('catalog', {});
    for (const item of items) catalog[item.id] = item;
    // Playlist tracks live inside their playlists and aren't dependent on this
    // bounded search cache. Persisted queues only need their namespaced ID.
    const keys = Object.keys(catalog);
    for (const key of keys.slice(0, Math.max(0, keys.length - 3000))) delete catalog[key];
    write('catalog', catalog);
    return items;
  }
  const tracks = (provider, items = []) => remember(items.filter(t => t?.id).map(t => track(provider, t))).map(presentTrack);
  function playlistSummary(provider, item, options = {}) {
    const canEdit = typeof providers[provider]?.addToPlaylist === 'function';
    const showSource = options.showSource !== false;
    return {
      ...item, id: identify(provider, item.id),
      name: showSource ? `${LABEL[provider]} · ${item.name || '歌单'}` : (item.name || '歌单'),
      owner: showSource ? `${LABEL[provider]}${item.owner ? ' · ' + item.owner : ''}` : (item.owner || ''),
      mine: !!item.mine,
      fixed: !item.mine || !!item.fixed || !canEdit,
      ...(item.tracks ? { tracks: tracks(provider, item.tracks) } : {}),
    };
  }
  function showSummary(provider, item) {
    return { ...item, id: identify(provider, item.id), ...(item.publisherPage ? { publisherPage: identify(provider, item.publisherPage) } : {}) };
  }
  function browsePage(provider, value) {
    return {
      ...value, title: `${LABEL[provider]} · ${value.title || '音乐'}`,
      sections: (value.sections || []).map(section => ({
        ...section,
        ...(section.tracks ? { tracks: tracks(provider, section.tracks) } : {}),
        ...(section.albums ? { albums: section.albums.map(a => album(provider, a)) } : {}),
        ...(section.artists ? { artists: section.artists.map(a => artist(provider, a)) } : {}),
        ...(section.playlists ? { playlists: section.playlists.map(p => playlistSummary(provider, p)) } : {}),
        ...(section.shows ? { shows: section.shows.map(s => showSummary(provider, s)) } : {}),
        ...(section.stations ? { stations: section.stations.map(s => ({ ...s, id: identify(provider, s.id), name: `${LABEL[provider]} · ${s.name}` })) } : {}),
        ...(section.links ? { links: section.links.map(link => ({ ...link, page: identify(provider, link.page) })) } : {}),
        ...(section.morePage ? { morePage: identify(provider, section.morePage) } : {}),
      })),
    };
  }
  function playlistsLink(provider, mine, imageUrl) {
    return {
      title: mine ? '我的歌单' : '收藏的歌单',
      subtitle: `${LABEL[provider]} · ${mine ? '自建歌单与喜欢列表' : '收藏的其他歌单'}`,
      page: `playlists:${provider}:${mine ? 'mine' : 'saved'}`,
      imageUrl: imageUrl || '',
    };
  }
  async function libraryPlaylists({ page }) {
    const match = /^playlists:(netease|qqmusic):(mine|saved)$/.exec(String(page));
    if (!match) throw error('unsupported', '没有这个歌单页面');
    const [, provider, kind] = match;
    const result = await call(provider, 'playlists');
    const items = (result || [])
      .filter(p => !!p.mine === (kind === 'mine'))
      .map(p => playlistSummary(provider, p, { showSource: false }));
    return {
      title: `${LABEL[provider]} · ${kind === 'mine' ? '我的歌单' : '收藏的歌单'}`,
      subtitle: kind === 'mine' ? '自建歌单与喜欢列表' : '收藏的其他歌单',
      sections: [{ playlists: items, empty: kind === 'mine' ? '暂无自建歌单，点击侧栏 + 可新建' : '暂无收藏歌单，可在第三方歌单页点击收藏' }],
    };
  }
  function localLists() { return read('playlists', []).map(list => ({ ...list, tracks: (list.tracks || []).map(storedTrack) })); }
  function localList(id) {
    const list = localLists().find(p => p.id === id);
    if (!list) throw error('unavailable', '本地歌单不存在');
    return list;
  }
  function updateLocal(id, change) {
    const lists = localLists();
    const index = lists.findIndex(p => p.id === id);
    if (index < 0) throw error('unavailable', '本地歌单不存在');
    change(lists[index]);
    lists[index].trackCount = lists[index].tracks.length;
    lists[index].imageUrl = lists[index].tracks.find(t => t.album?.imageUrl)?.album.imageUrl || '';
    write('playlists', lists);
    return lists[index];
  }
  function validName(name) {
    if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('歌单名称需为 1–100 个字符');
    return name.trim();
  }
  function combinedAccount(profiles) {
    const selected = targets();
    if (!selected.some(p => profiles[p])) return null;
    return {
      id: 'fusion', name: SOURCES.filter(p => profiles[p]).map(p => `${LABEL[p]} · ${profiles[p].name}`).join(' / '),
      imageUrl: SOURCES.map(p => profiles[p]?.imageUrl).find(Boolean) || '', page: 'accounts',
    };
  }
  async function account() {
    const started = authEpoch;
    const answers = await Promise.all(SOURCES.map(async provider => {
      try { return { provider, profile: await call(provider, 'account') }; }
      catch { return { provider, failed: true }; }
    }));
    const profiles = read('profiles', {});
    if (started === authEpoch) {
      for (const { provider, profile, failed } of answers) {
        // A temporary network failure must not erase a restored login.
        if (failed) continue;
        if (profile) profiles[provider] = profile;
        else delete profiles[provider];
      }
      write('profiles', profiles);
    }
    return combinedAccount(profiles);
  }
  async function signIn() {
    if (signingIn) throw new Error('登录正在进行，请完成当前扫码');
    signingIn = true;
    const started = ++authEpoch;
    try {
      for (const provider of targets()) {
        // During the two-account flow, retrying after an interrupted second QR
        // must not force the first account to sign in again.
        let existing = null;
        try { existing = await call(provider, 'account'); } catch { /* Try a fresh QR. */ }
        const profile = existing || await call(provider, 'signIn');
        if (started !== authEpoch) throw new Error('账号已改变，请重试');
        const profiles = read('profiles', {});
        profiles[provider] = profile;
        write('profiles', profiles);
      }
      searches.clear(); lastTrackSearch = null;
      return combinedAccount(read('profiles', {}));
    } finally { signingIn = false; }
  }
  async function signOut() {
    const started = ++authEpoch;
    for (const provider of targets()) {
      await call(provider, 'signOut');
      if (started !== authEpoch) return;
      const profiles = read('profiles', {});
      delete profiles[provider];
      write('profiles', profiles);
    }
    searches.clear(); lastTrackSearch = null;
  }

  async function search({ query, kind = 'tracks', offset = 0 }) {
    const scope = searchScope(query, setting('searchSource'));
    query = scope.query;
    if (!query) return { [kind]: [], more: false };
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('无效搜索分页');
    if (!['tracks', 'albums', 'artists', 'playlists', 'shows'].includes(kind)) throw error('unsupported', '不支持该搜索类型');
    const selected = scope.providers;
    const key = `${kind}\0${scope.source}\0${query}`;
    let state = searches.get(key);
    if (!state || offset === 0 && (!state.pages.has(0) || Date.now() - state.created > 60000)) {
      state = { query, created: Date.now(), cursors: Object.fromEntries(selected.map(p => [p, { offset: 0, more: true }])), pages: new Map(), trackPages: new Map() };
      searches.set(key, state);
      if (searches.size > 12) searches.delete(searches.keys().next().value);
    }
    if (kind === 'tracks') lastTrackSearch = state;
    if (state.pages.has(offset)) return clone(await state.pages.get(offset));
    // The host advances by merged result count, while each service advances by
    // its own raw page length. Never send the merged offset to either service.
    if (offset && offset !== state.nextOffset) throw new Error('搜索已刷新，请从第一页重试');
    const pending = (async () => {
      const active = selected.filter(p => state.cursors[p].more && !(kind === 'shows' && p === 'qqmusic'));
      const pages = await Promise.all(active.map(async provider => {
        try {
          const page = await call(provider, 'search', { query, kind, offset: state.cursors[provider].offset });
          const items = page[kind] || [];
          state.cursors[provider].offset += items.length;
          state.cursors[provider].more = !!page.more && items.length > 0;
          return { provider, items };
        } catch (cause) { return { provider, cause }; }
      }));
      const succeeded = pages.filter(p => !p.cause);
      if (!succeeded.length && pages.length) throw pages[0].cause;
      const items = succeeded.flatMap(({ provider, items }) => items.map((item, index) => ({
        raw: item, index, provider,
        item: kind === 'tracks' ? track(provider, item) : kind === 'albums' ? album(provider, item) : kind === 'artists' ? artist(provider, item) : kind === 'playlists' ? playlistSummary(provider, item) : showSummary(provider, item),
      })));
      items.sort((a, b) => relevance(a.raw, query) - relevance(b.raw, query) || a.index - b.index || SOURCES.indexOf(a.provider) - SOURCES.indexOf(b.provider));
      const result = items.map(v => v.item);
      if (kind === 'tracks') { remember(result); state.trackPages.set(offset, result); }
      state.nextOffset = offset + result.length;
      // An empty merged page cannot advance the app's cursor. Keep failures
      // visible through status rather than returning an endless 'more' loop.
      return { [kind]: kind === 'tracks' ? result.map(presentTrack) : result, more: result.length > 0 && selected.some(p => state.cursors[p].more && !(kind === 'shows' && p === 'qqmusic')) };
    })();
    state.pages.set(offset, pending);
    try { return clone(await pending); }
    catch (e) { if (state.pages.get(offset) === pending) state.pages.delete(offset); throw e; }
  }

  async function playlists() {
    const result = localLists().map(presentPlaylist);
    const pages = await Promise.all(SOURCES.map(async provider => {
      try { return (await call(provider, 'playlists')).map(p => playlistSummary(provider, p, { showSource: false })); }
      catch { return []; }
    }));
    return [...result, ...pages.flat()];
  }
  async function playlist({ id }) {
    const identity = splitID(id);
    if (identity.provider === 'local') return presentPlaylist(localList(id));
    return playlistSummary(identity.provider, await call(identity.provider, 'playlist', { id: identity.id }));
  }
  function parseCloudPlaylistName(raw) {
    const text = validName(raw);
    const match = /^(netease|ncm|网易云音乐|网易云|qqmusic|qq|qq\s*音乐)\s*[:：]\s*(.+)$/i.exec(text);
    if (!match) return null;
    const prefix = match[1].toLowerCase();
    const provider = ['netease', 'ncm', '网易云音乐', '网易云'].includes(prefix) ? 'netease' : 'qqmusic';
    return { provider, name: validName(match[2]) };
  }
  function stripCloudPlaylistPrefix(provider, name) {
    const trimmed = validName(name);
    const prefix = `${LABEL[provider]} · `;
    if (trimmed.startsWith(prefix)) {
      const rest = trimmed.slice(prefix.length).trim();
      if (rest) return validName(rest);
    }
    return trimmed;
  }
  function sameProviderTrackIDs(provider, trackIds) {
    if (!Array.isArray(trackIds) || !trackIds.length) throw new Error('无效歌曲列表');
    return trackIds.map(trackId => {
      const parsed = splitID(trackId);
      if (parsed.provider !== provider) {
        throw error('unsupported', `${LABEL[provider]}云端歌单仅支持${LABEL[provider]}歌曲，跨平台歌曲请添加到本地混合歌单`);
      }
      return parsed.id;
    });
  }
  function createPlaylist({ name }) {
    const cloud = parseCloudPlaylistName(name);
    if (cloud && typeof providers[cloud.provider]?.createPlaylist === 'function') {
      return call(cloud.provider, 'createPlaylist', { name: cloud.name }).then(p => playlistSummary(cloud.provider, { ...p, mine: true }));
    }
    name = validName(name);
    const sequence = Number(read('playlistSequence', 0)) + 1;
    write('playlistSequence', sequence);
    const list = { id: `local:${sequence}`, name, owner: '本地混合歌单', mine: true, tracks: [], trackCount: 0 };
    write('playlists', [...localLists(), list]);
    return list;
  }
  function renamePlaylist({ id, name }) {
    const { provider, id: rawID } = splitID(id);
    if (provider !== 'local') {
      if (!SOURCES.includes(provider)) throw error('unsupported', '不支持的歌单来源');
      return call(provider, 'renamePlaylist', { id: rawID, name: stripCloudPlaylistPrefix(provider, name) });
    }
    updateLocal(id, list => { list.name = validName(name); });
  }
  function deletePlaylist({ id }) {
    const { provider, id: rawID } = splitID(id);
    if (provider !== 'local') {
      if (!SOURCES.includes(provider)) throw error('unsupported', '不支持的歌单来源');
      return call(provider, 'deletePlaylist', { id: rawID });
    }
    localList(id);
    write('playlists', localLists().filter(p => p.id !== id));
  }
  async function resolveTrack(id) {
    const { provider, id: rawID } = splitID(id);
    if (!SOURCES.includes(provider)) throw error('unavailable', '无效歌曲来源');
    const cached = read('catalog', {})[id] || localLists().flatMap(p => p.tracks).find(t => t.id === id);
    if (cached) return storedTrack(cached);
    // Resolve a track whose cache was evicted, without guessing another song
    // from a title search. Providers may rehydrate by their immutable ID.
    if (typeof providers[provider].track === 'function') {
      const found = track(provider, await call(provider, 'track', { id: rawID }));
      remember([found]);
      return found;
    }
    throw new Error('这首歌曲的资料已不在缓存，请重新搜索或打开原歌单后添加');
  }
  async function addToPlaylist({ id, trackIds }) {
    const { provider, id: rawID } = splitID(id);
    if (provider !== 'local') {
      if (!SOURCES.includes(provider)) throw error('unsupported', '不支持的歌单来源');
      const rawTrackIds = sameProviderTrackIDs(provider, trackIds);
      await call(provider, 'addToPlaylist', { id: rawID, trackIds: rawTrackIds });
      return;
    }
    if (!Array.isArray(trackIds)) throw new Error('无效歌曲列表');
    const resolved = await Promise.all(trackIds.map(resolveTrack));
    updateLocal(id, list => {
      const seen = new Set(list.tracks.map(t => t.id));
      for (const t of resolved) if (!seen.has(t.id)) { list.tracks.push(t); seen.add(t.id); }
    });
  }
  function removeFromPlaylist({ id, trackIds }) {
    const { provider, id: rawID } = splitID(id);
    if (provider !== 'local') {
      if (!SOURCES.includes(provider)) throw error('unsupported', '不支持的歌单来源');
      const rawTrackIds = sameProviderTrackIDs(provider, trackIds);
      return call(provider, 'removeFromPlaylist', { id: rawID, trackIds: rawTrackIds });
    }
    const removed = new Set(trackIds);
    updateLocal(id, list => { list.tracks = list.tracks.filter(t => !removed.has(t.id)); });
  }
  function movePlaylistTrack({ id, from, to }) {
    if (splitID(id).provider !== 'local') throw error('unsupported', '原平台云端歌单暂不支持调整顺序，仅本地混合歌单支持拖拽排序');
    updateLocal(id, list => {
      if (![from, to].every(n => Number.isInteger(n) && n >= 0 && n < list.tracks.length)) throw new Error('无效歌曲位置');
      list.tracks.splice(to, 0, list.tracks.splice(from, 1)[0]);
    });
  }
  function importLibrary(text) {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('导入内容必须是转换工具生成的 JSON'); }
    if (data?.format !== 'mygo-music-fusion' || data.version !== 1 || !Array.isArray(data.playlists)) throw new Error('不支持的歌单导入格式');
    if (data.playlists.length > 500 || text.length > 8 * 1024 * 1024) throw new Error('导入数据过大，请分批导入');
    // Validate every list before writing any of them.
    const incoming = data.playlists.map(p => ({
      name: validName(p.name), description: String(p.description || ''),
      tracks: (Array.isArray(p.tracks) ? p.tracks : []).map(t => {
        const { provider } = splitID(t.id);
        if (!SOURCES.includes(provider) || typeof t.name !== 'string') throw new Error('导入歌曲缺少名称或来源');
        return { ...t, unavailable: false };
      }),
    }));
    const previous = new Set(read('imports', []));
    // Idempotent even when the settings field is saved more than once.
    const fingerprint = host.crypto.md5(JSON.stringify(incoming));
    if (previous.has(fingerprint)) return;
    const lists = localLists();
    let sequence = Number(read('playlistSequence', 0));
    for (const p of incoming) {
      // Keep the fingerprint above identical to 0.1.1 for already imported JSON.
      const deduped = [...new Map(p.tracks.map(t => [t.id, storedTrack(t)])).values()];
      lists.push({ ...p, tracks: deduped, id: `local:${++sequence}`, mine: true, owner: '本地混合歌单', trackCount: deduped.length, imageUrl: deduped.find(t => t.album?.imageUrl)?.album.imageUrl || '' });
    }
    write('playlistSequence', sequence);
    // Lists and import marker are one storage entry, so recover a repeated
    // save by persisting its marker on each imported list as well.
    for (const list of lists.slice(lists.length - incoming.length)) list.importKey = fingerprint;
    const already = localLists().some(p => p.importKey === fingerprint);
    if (!already) write('playlists', lists);
    write('imports', [...previous, fingerprint]);
  }
  function setSetting({ key, value }) {
    if (key === 'loginTarget') parseTarget(value);
    if (key === 'qqLoginMethod') parseQQLoginMethod(value);
    if (key === 'searchSource') searchSource(value);
    if (key === 'importPlaylists' && String(value).trim()) importLibrary(String(value));
    if (key === 'showSourceInTitle' && !['', 'true', 'false'].includes(String(value).trim().toLowerCase())) throw error('setup', '歌名平台标签请填写 true 或 false；留空默认关闭');
    if (['loginTarget', 'qqLoginMethod', 'showSourceInTitle', 'searchSource'].includes(key)) { searches.clear(); lastTrackSearch = null; }
  }
  async function home() {
    const profiles = read('profiles', {});
    const status = SOURCES.map(p => `${LABEL[p]}：${profiles[p] ? profiles[p].name : '未登录'}${statuses.has(p) ? '（' + statuses.get(p) + '）' : ''}`).join('\n');
    const covers = { netease: '', qqmusic: '' };
    await Promise.all(SOURCES.map(async provider => {
      try {
        const lists = await call(provider, 'playlists');
        covers[provider] = lists.find(p => p.imageUrl)?.imageUrl || '';
      } catch { /* The home cards stay usable when a source is offline. */ }
    }));
    return {
      title: 'NetEaseXQQMusic', subtitle: '统一搜索 · 跨平台播放 · 本地混合歌单',
      description: status,
      sections: [
        { title: '音乐发现', links: [
          { title: '网易云音乐', subtitle: '推荐、排行榜、每日推荐', page: 'netease:home', imageUrl: covers.netease },
          { title: 'QQ 音乐', subtitle: '推荐歌单、排行榜', page: 'qqmusic:home', imageUrl: covers.qqmusic },
        ] },
        { title: '歌单管理', links: [
          { title: '网易云歌单', subtitle: '我的歌单与收藏歌单', page: 'library:netease', imageUrl: covers.netease },
          { title: 'QQ 歌单', subtitle: '我的歌单与收藏歌单', page: 'library:qqmusic', imageUrl: covers.qqmusic },
        ] },
        { title: '其他', links: [
          { title: '按音源查看', subtitle: '最近搜索、播放记录和混合歌单按平台分组', page: 'sources' },
          { title: '账号与使用说明', subtitle: '双平台登录、收藏与插件更新说明', page: 'accounts' },
        ] },
        { title: '本地混合歌单', playlists: localLists().map(presentPlaylist), empty: '使用侧栏的 + 新建歌单，再从搜索结果添加两边的歌曲。' },
      ],
    };
  }
  async function browse({ page }) {
    if (page.startsWith('updates')) throw error('unsupported', '请到设置 → 插件 → NetEaseXQQMusic 的菜单中检查更新');
    if (page.startsWith('playlists:')) return libraryPlaylists({ page });
    if (page.startsWith('library:')) {
      const provider = page.slice('library:'.length);
      if (!SOURCES.includes(provider)) throw error('unsupported', '没有这个歌单页面');
      const lists = await call(provider, 'playlists');
      const mine = lists.filter(p => p.mine);
      const saved = lists.filter(p => !p.mine);
      const cover = lists.find(p => p.imageUrl)?.imageUrl || '';
      return {
        title: `${LABEL[provider]}歌单`,
        subtitle: '我的歌单与收藏歌单已分开整理',
        sections: [{ links: [
          playlistsLink(provider, true, mine.find(p => p.imageUrl)?.imageUrl || cover),
          playlistsLink(provider, false, saved.find(p => p.imageUrl)?.imageUrl || cover),
        ] }],
      };
    }
    if (page.startsWith('sources:playlist:')) {
      const list = await playlist({ id: page.slice('sources:playlist:'.length) });
      return { title: `${list.name} · 按音源查看`, description: '按平台分组播放和添加歌曲；在原歌单中编辑顺序。', sections: sourceSections(list.tracks || [], '歌曲') };
    }
    if (page === 'sources') {
      const loaded = lastTrackSearch ? [...new Map([...lastTrackSearch.trackPages.values()].flat().map(t => [t.id, t])).values()] : [];
      return { title: '按音源查看', description: '平台标题下的歌曲来自对应音源，保留原始歌名。搜索可加 qq: 或 netease: 前缀临时筛选，也可在插件设置的“搜索音源”中选择默认平台。全局搜索和播放队列暂不支持插件自定义逐曲音源徽标。', sections: [
        ...(lastTrackSearch ? sourceSections(loaded, `最近搜索：${lastTrackSearch.query}（已加载结果）`, presentTrack) : []),
        ...sourceSections(read('recent', []), '最近播放', presentTrack),
        { title: '混合歌单 · 按音源分组', links: localLists().map(list => ({ title: list.name, subtitle: `${list.trackCount} 首 · 网易云 / QQ 音乐`, page: `sources:playlist:${list.id}` })), empty: '使用侧栏 + 新建本地混合歌单' },
      ] };
    }
    if (page === 'accounts') {
      const value = await home();
      return { title: '账号与使用说明', description: `${value.description}\n\n在设置 → 插件 → NetEaseXQQMusic 的“登录目标”中填写 both（两个平台）、netease（网易云）或 qqmusic（QQ），保存后点 Sign In。默认依次扫描两边二维码；也可单独登录或退出一个平台。QQ 扫码方式填写 qq（手机 QQ）、qqmusic（QQ 音乐 App）或 wechat（微信）。App 扫码首次需在 MyGo 中允许此插件运行程序；另外两种方式无需运行程序权限。\n\n默认保留原始歌名，便于插件岛等工具匹配歌词。侧栏“按音源查看”按网易云 / QQ 音乐分组展示已加载的最近搜索、最近播放和混合歌单；搜索词前加 qq: 或 netease: 可临时指定音源，也可设置“搜索音源”为 both、netease 或 qqmusic。宿主目前没有插件自定义逐曲音源徽标接口，全局混合搜索和队列无法单独加徽标。如需在歌名中显示〔网易云〕或〔QQ〕，可把“歌名显示平台标签”填写为 true；使用外部歌词工具时请关闭。更新或切换设置后，从搜索或歌单重新加入歌曲，才能替换旧播放队列里的标题。歌曲始终按原平台播放；平台歌单和发现页保留来源名称。新建歌单默认保存在本机（支持跨平台混合来源），名称前加“网易云：”或“QQ：”可直接新建对应平台云端歌单；自建云端普通歌单支持直接添加/移除同平台歌曲、重命名和删除。更新请到设置 → 插件 → NetEaseXQQMusic 的 ⋯ 菜单选择 Check for Updates；发现新版后点 Update。从 GitHub 仓库安装的插件由 MyGo Music 每 24 小时自动检查，安装前会确认，插件更新不会删除会话和本地歌单。\n\n播放完整链接受账号、版权和地区权限限制；暂停、缓冲及失败后是否跳歌由 MyGo Music 本体处理。`, sections: [] };
    }
    const { provider, id } = splitID(page);
    if (!SOURCES.includes(provider)) throw error('unsupported', '没有这个页面');
    return browsePage(provider, await call(provider, id === 'home' ? 'home' : 'browse', id === 'home' ? undefined : { page: id }));
  }
  async function paged(methodName, key, offset = 0) {
    // These provider offsets also need independent cursors; reuse the search
    // pagination engine with a tiny adapter for liked/saved libraries.
    const cacheKey = `@${methodName}`;
    let state = searches.get(cacheKey);
    if (!state || offset === 0) {
      state = { offsets: { netease: 0, qqmusic: 0 }, done: {}, next: 0 };
      searches.set(cacheKey, state);
    }
    if (offset !== state.next) throw new Error('列表已刷新，请重新打开');
    const pages = await Promise.all(SOURCES.map(async p => {
      if (state.done[p] || typeof providers[p][methodName] !== 'function') return [];
      try {
        const page = await call(p, methodName, { offset: state.offsets[p] });
        const items = page[key] || [];
        state.offsets[p] += items.length;
        state.done[p] = !page.more || !items.length;
        return key === 'tracks' ? tracks(p, items) : items.map(a => album(p, a));
      } catch (e) {
        if (e.code === 'signIn') {
          state.done[p] = true;
          return [];
        }
        // A failed library request is not an empty library. Let the host show
        // its error/retry state instead of hiding albums the account has saved.
        throw e;
      }
    }));
    const values = pages.flat();
    state.next += values.length;
    return { [key]: values, more: values.length > 0 && SOURCES.some(p => !state.done[p] && typeof providers[p][methodName] === 'function') };
  }
  async function isLiked({ ids }) {
    const result = Object.fromEntries(ids.map(id => [id, false]));
    await Promise.all(SOURCES.map(async provider => {
      const selected = ids.filter(id => splitID(id).provider === provider);
      if (!selected.length) return;
      try {
        const values = await call(provider, 'isLiked', { ids: selected.map(id => splitID(id).id) });
        for (const id of selected) result[id] = !!values[splitID(id).id];
      } catch { /* Offline/sign-out leaves heart state unknown, not a login gate. */ }
    }));
    return result;
  }
  const routed = name => async args => {
    const { provider, id } = splitID(args.id);
    if (!SOURCES.includes(provider)) throw error('unsupported', '不支持的来源');
    return call(provider, name, { ...args, id });
  };
  async function played({ id }) {
    const list = read('recent', []).filter(t => t.id !== id).map(storedTrack);
    try { list.unshift(await resolveTrack(id)); } catch { return; }
    write('recent', list.slice(0, 100));
  }
  return {
    account, signIn, signOut, setSetting, home, browse, search, playlists, playlist,
    createPlaylist, renamePlaylist, deletePlaylist, addToPlaylist, removeFromPlaylist, movePlaylistTrack,
    savePlaylist: routed('savePlaylist'),
    recent: () => read('recent', []).map(presentTrack), played,
    suggest: async ({ query }) => {
      const scope = searchScope(query, setting('searchSource'));
      if (!scope.query) return [];
      const answers = await Promise.all(scope.providers.map(async p => {
        try { return await call(p, 'suggest', { query: scope.query }); } catch { return []; }
      }));
      return [...new Set(answers.flat())].slice(0, 12).map(value => scope.prefix + value);
    },
    stream: routed('stream'), lyrics: routed('lyrics'),
    like: async args => {
      const result = await routed('like')(args);
      searches.delete('@liked');
      return result;
    },
    isLiked,
    liked: ({ offset = 0 } = {}) => paged('liked', 'tracks', offset),
    followArtist: routed('followArtist'),
    shows: async () => {
      const all = await Promise.all(SOURCES.map(async p => {
        if (typeof providers[p]?.shows !== 'function') return [];
        try { return (await call(p, 'shows')).map(s => showSummary(p, s)); }
        catch { return []; }
      }));
      return all.flat();
    },
    show: async ({ id, offset = 0 }) => {
      const { provider, id: raw } = splitID(id);
      if (!SOURCES.includes(provider)) throw error('unsupported', '不支持的来源');
      const page = await call(provider, 'show', { id: raw, offset });
      return {
        show: showSummary(provider, page.show),
        episodes: tracks(provider, page.episodes),
        more: !!page.more,
      };
    },
    subscribeShow: routed('subscribeShow'),
    album: async ({ id }) => {
      const { provider, id: raw } = splitID(id);
      const page = await call(provider, 'album', { id: raw });
      return { album: album(provider, page.album), tracks: tracks(provider, page.tracks) };
    },
    artist: async ({ id }) => {
      const { provider, id: raw } = splitID(id);
      const page = await call(provider, 'artist', { id: raw });
      return { artist: artist(provider, page.artist), albums: (page.albums || []).map(a => album(provider, a)), tracks: tracks(provider, page.tracks) };
    },
    stations: async () => {
      const all = await Promise.all(SOURCES.map(async p => {
        try { return (await call(p, 'stations')).map(s => ({ ...s, id: identify(p, s.id), name: `${LABEL[p]} · ${s.name}` })); }
        catch { return []; }
      }));
      return all.flat();
    },
    stationNext: async ({ id }) => {
      const { provider, id: raw } = splitID(id);
      return tracks(provider, await call(provider, 'stationNext', { id: raw }));
    },
    comments: async ({ trackId, offset = 0 }) => {
      const { provider, id } = splitID(trackId);
      return call(provider, 'comments', { trackId: id, offset });
    },
    likeComment: async ({ trackId, commentId, on }) => {
      const { provider, id } = splitID(trackId);
      if (!SOURCES.includes(provider)) throw error('unsupported', '不支持的来源');
      return call(provider, 'likeComment', { trackId: id, commentId: String(commentId || '').replace(/^(?:netease|qqmusic):/, ''), on });
    },
    postComment: async ({ trackId, text }) => {
      const { provider, id } = splitID(trackId);
      if (!SOURCES.includes(provider)) throw error('unsupported', '不支持的来源');
      return call(provider, 'postComment', { trackId: id, text });
    },
  };
}
