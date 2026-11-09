import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFusion, relevance } from '../src/fusion.js';
import { convertLegacy } from '../src/legacy.js';

const song = (id, name = '反方向的钟') => ({ id: String(id), name, artists: [{ id: '7', name: '周杰伦' }], album: { id: '8', name: 'Jay' }, duration: 123000, unavailable: true });
function setup(custom = {}, storage = new Map()) {
  const settings = new Map();
  const calls = [];
  const providers = Object.fromEntries(['netease', 'qqmusic'].map(p => [p, {
    account: async () => null, signOut: async () => calls.push([p, 'signOut']),
    search: async args => ({ tracks: [song('9', p === 'netease' ? '反方向的钟 (翻唱)' : '反方向的钟')], more: false }),
    playlists: async () => [],
    stream: async args => { calls.push([p, args]); return { url: `https://example.com/${p}.mp3`, type: 'mp3' }; },
    ...custom[p],
  }]));
  const host = {
    storage: { get: key => structuredClone(storage.get(key)), set: (key, value) => storage.set(key, structuredClone(value)), remove: key => storage.delete(key) },
    setting: key => settings.get(key) || '', crypto: { md5: text => createHash('md5').update(text).digest('hex') },
  };
  return { api: createFusion(providers, host), providers, settings, storage, calls, host };
}

// The exact QQ title must precede NetEase's cover and retain an independent ID.
test('exact title wins while identical numeric IDs remain separate', async () => {
  const { api, calls } = setup();
  const found = await api.search({ query: '反方向的钟' });
  assert.deepEqual(found.tracks.map(t => t.id), ['qqmusic:9', 'netease:9']);
  assert.equal(found.tracks[0].name, '反方向的钟');
  assert.equal(found.tracks[0].unavailable, false);
  assert.equal(found.tracks[1].album.id, 'netease:8');
  await api.stream({ id: found.tracks[0].id, quality: 'lossless' });
  assert.deepEqual(calls, [['qqmusic', { id: '9', quality: 'lossless' }]]);
  assert.equal(relevance(song('1', '反方向，的钟'), '反 方 向 的 钟'), 0);
  assert.equal(relevance(song('1', '其他歌'), '周杰伦'), 3);
});

// External lyric tools receive the host's title, so provider routing must not decorate media metadata.
test('raw media titles preserve artist credits and route lyrics by provider ID', async () => {
  const requests = [];
  const custom = Object.fromEntries(['netease', 'qqmusic'].map(provider => [provider, {
    search: async () => ({ tracks: [{ ...song('9', 'May I Ask'), artists: [{ id: '7', name: 'Luke Chiang' }, { id: '6', name: 'Alexis Kim' }], album: { id: '8', name: 'May I Ask' } }], more: false }),
    lyrics: async args => { requests.push([provider, args]); return { lrc: '[00:01.00]May I ask', translation: '' }; },
  }]));
  const { api } = setup(custom);
  const found = await api.search({ query: 'May I Ask' });
  assert.deepEqual(found.tracks.map(t => t.id), ['netease:9', 'qqmusic:9']);
  for (const track of found.tracks) {
    assert.equal(track.name, 'May I Ask');
    assert.deepEqual(track.artists.map(a => a.name), ['Luke Chiang', 'Alexis Kim']);
    assert.equal(track.album.name, 'May I Ask');
    assert.equal((await api.lyrics({ id: track.id })).lrc, '[00:01.00]May I ask');
  }
  assert.deepEqual(requests, [['netease', { id: '9' }], ['qqmusic', { id: '9' }]]);
});

// Titles saved before the fix must be clean when reopening playlists or playing from recent history.
test('legacy playlist, recent and catalog titles are restored without losing identity', async () => {
  const old = { ...song('netease:9', 'May I Ask 〔网易云〕'), artists: [{ id: 'netease:7', name: 'Luke Chiang' }], album: { id: 'netease:8', name: 'May I Ask' } };
  const cached = { ...old, id: 'qqmusic:10', name: 'Another Song 〔QQ〕' };
  const storage = new Map([
    ['fusion.playlists', [{ id: 'local:1', name: 'Saved Mix', mine: true, tracks: [old], trackCount: 1 }]],
    ['fusion.playlistSequence', 1], ['fusion.recent', [old]], ['fusion.catalog', { [cached.id]: cached }],
  ]);
  const { api, providers, host, settings } = setup({}, storage);
  assert.equal((await api.playlist({ id: 'local:1' })).tracks[0].name, 'May I Ask');
  assert.equal((await api.playlists())[0].tracks[0].name, 'May I Ask');
  assert.equal((await api.home()).sections[1].playlists[0].tracks[0].name, 'May I Ask');
  assert.equal(api.recent()[0].name, 'May I Ask');
  await api.addToPlaylist({ id: 'local:1', trackIds: [cached.id] });
  await api.played({ id: cached.id });
  settings.set('showSourceInTitle', 'true');
  api.setSetting({ key: 'showSourceInTitle', value: 'true' });
  assert.deepEqual((await api.playlist({ id: 'local:1' })).tracks.map(t => t.name), ['May I Ask 〔网易云〕', 'Another Song 〔QQ〕']);
  settings.set('showSourceInTitle', 'false');
  api.setSetting({ key: 'showSourceInTitle', value: 'false' });
  const restarted = createFusion(providers, host);
  assert.deepEqual((await restarted.playlist({ id: 'local:1' })).tracks.map(t => [t.id, t.name]), [['netease:9', 'May I Ask'], ['qqmusic:10', 'Another Song']]);
  assert.deepEqual(restarted.recent().map(t => t.name), ['Another Song', 'May I Ask']);
});

// Toggling labels must refresh cached search results and preserve suffixes that belong to the song itself.
test('optional source labels are reversible and retain genuine provider titles', async () => {
  const { api, settings, providers, host } = setup({
    netease: { search: async () => ({ tracks: [], more: false }) },
    qqmusic: { search: async () => ({ tracks: [song('9', 'A real title 〔QQ〕')], more: false }) },
  });
  const query = 'A real title';
  assert.equal((await api.search({ query })).tracks[0].name, 'A real title 〔QQ〕');
  settings.set('showSourceInTitle', 'true');
  api.setSetting({ key: 'showSourceInTitle', value: 'true' });
  assert.equal((await api.search({ query })).tracks[0].name, 'A real title 〔QQ〕 〔QQ〕');
  const list = api.createPlaylist({ name: 'Original titles' });
  await api.addToPlaylist({ id: list.id, trackIds: ['qqmusic:9'] });
  await api.played({ id: 'qqmusic:9' });
  settings.set('showSourceInTitle', '');
  api.setSetting({ key: 'showSourceInTitle', value: '' });
  const restarted = createFusion(providers, host);
  assert.equal((await restarted.search({ query })).tracks[0].name, 'A real title 〔QQ〕');
  assert.equal((await restarted.playlist({ id: list.id })).tracks[0].name, 'A real title 〔QQ〕');
  assert.equal(restarted.recent()[0].name, 'A real title 〔QQ〕');
  assert.throws(() => api.setSetting({ key: 'showSourceInTitle', value: 'maybe' }), { code: 'setup' });
});

// Import fingerprints from 0.1.1 must still prevent duplication when the setting is saved after updating.
test('legacy import fingerprints survive title normalization and new conversions preserve titles', async () => {
  const oldTrack = { ...song('netease:9', 'May I Ask 〔网易云〕'), unavailable: false };
  const incoming = [{ name: 'Imported', description: '', tracks: [oldTrack] }];
  const fingerprint = createHash('md5').update(JSON.stringify(incoming)).digest('hex');
  const saved = { ...incoming[0], id: 'local:1', mine: true, importKey: fingerprint };
  for (const markers of [[fingerprint], []]) {
    const storage = new Map([['fusion.playlists', [saved]], ['fusion.playlistSequence', 1], ['fusion.imports', markers]]);
    const { api } = setup({}, storage);
    api.setSetting({ key: 'importPlaylists', value: JSON.stringify({ format: 'mygo-music-fusion', version: 1, playlists: incoming }) });
    const lists = await api.playlists();
    assert.equal(lists.length, 1);
    assert.equal(lists[0].tracks[0].name, 'May I Ask');
  }
  const { data } = convertLegacy([{ id: -1, name: 'Legacy', tracks: [{ id: 10, src: 'qqmusic', name: 'A real title 〔QQ〕' }] }]);
  const { api } = setup();
  api.setSetting({ key: 'importPlaylists', value: JSON.stringify(data) });
  const track = (await api.playlists())[0].tracks[0];
  assert.equal(track.id, 'qqmusic:10');
  assert.equal(track.name, 'A real title 〔QQ〕');
});

// MyGo counts the merged page; each provider must keep its own raw cursor.
test('merged pagination advances each provider independently and caches concurrent reads', async () => {
  const offsets = { netease: [], qqmusic: [] };
  const make = p => ({ search: async ({ offset }) => {
    offsets[p].push(offset);
    const length = p === 'netease' ? 3 : 2;
    return { tracks: Array.from({ length }, (_, n) => song(offset + n + 1)), more: offset === 0 };
  } });
  const { api } = setup({ netease: make('netease'), qqmusic: make('qqmusic') });
  const [first, duplicate] = await Promise.all([api.search({ query: 'clock' }), api.search({ query: 'clock' })]);
  assert.deepEqual(first, duplicate);
  assert.equal(first.tracks.length, 5);
  assert.equal(first.more, true);
  const last = await api.search({ query: 'clock', offset: 5 });
  assert.equal(last.more, false);
  assert.deepEqual(offsets, { netease: [0, 3], qqmusic: [0, 2] });
});

// One unavailable provider must not erase the other provider's usable results.
test('partial search failure returns working source and retries failed cursor on next page', async () => {
  let attempts = 0;
  const { api } = setup({
    netease: { search: async () => ({ tracks: [song('1')], more: false }) },
    qqmusic: { search: async ({ offset }) => { assert.equal(offset, 0); if (++attempts === 1) throw new Error('fixture offline'); return { tracks: [song('2')], more: false }; } },
  });
  const first = await api.search({ query: 'clock' });
  assert.deepEqual(first.tracks.map(t => t.id), ['netease:1']);
  assert.equal(first.more, true);
  assert.match((await api.home()).description, /上次请求失败/);
  const second = await api.search({ query: 'clock', offset: 1 });
  assert.deepEqual(second.tracks.map(t => t.id), ['qqmusic:2']);
  assert.equal(second.more, false);
});

// A mixed playlist survives a fresh plugin instance and never deduplicates across providers.
test('mixed playlist persists metadata, order, deduplication and edits across restart', async () => {
  const { api, storage, host, providers } = setup();
  await api.search({ query: 'clock' });
  const list = api.createPlaylist({ name: '我的两边音乐' });
  await api.addToPlaylist({ id: list.id, trackIds: ['netease:9', 'qqmusic:9', 'netease:9'] });
  const restarted = createFusion(providers, host);
  let got = await restarted.playlist({ id: list.id });
  assert.deepEqual(got.tracks.map(t => t.id), ['netease:9', 'qqmusic:9']);
  assert.equal(got.tracks[1].artists[0].id, 'qqmusic:7');
  restarted.movePlaylistTrack({ id: list.id, from: 0, to: 1 });
  restarted.renamePlaylist({ id: list.id, name: '混合' });
  got = await restarted.playlist({ id: list.id });
  assert.equal(got.name, '混合');
  assert.deepEqual(got.tracks.map(t => t.id), ['qqmusic:9', 'netease:9']);
  restarted.removeFromPlaylist({ id: list.id, trackIds: ['netease:9'] });
  assert.equal((await restarted.playlist({ id: list.id })).trackCount, 1);
  restarted.deletePlaylist({ id: list.id });
  await assert.rejects(restarted.playlist({ id: list.id }));
  assert.deepEqual(storage.get('fusion.playlists'), []);
});

// Adding uncached queue tracks rehydrates by immutable ID without a title search.
test('evicted metadata uses provider details and refuses partial playlist writes', async () => {
  const { api } = setup({ qqmusic: { track: async ({ id }) => song(id) } });
  const list = api.createPlaylist({ name: 'From queue' });
  await api.addToPlaylist({ id: list.id, trackIds: ['qqmusic:900'] });
  await assert.rejects(api.addToPlaylist({ id: list.id, trackIds: ['qqmusic:901', 'netease:404'] }));
  assert.deepEqual((await api.playlist({ id: list.id })).tracks.map(t => t.id), ['qqmusic:900']);
});

// A shared provider account must remain available while the other target is signed in/out.
test('sequential dual login and target selection isolate accounts', async () => {
  const accounts = {};
  const steps = [];
  const custom = Object.fromEntries(['netease', 'qqmusic'].map(p => [p, {
    account: async () => accounts[p] || null,
    signIn: async () => { steps.push(p); return accounts[p] = { id: p, name: p }; },
    signOut: async () => { delete accounts[p]; },
  }]));
  const { api, settings } = setup(custom);
  assert.equal(await api.account(), null);
  assert.match((await api.signIn()).name, /netease.*qqmusic/);
  assert.deepEqual(steps, ['netease', 'qqmusic']);
  settings.set('loginTarget', 'qqmusic');
  await api.signOut();
  assert.equal(await api.account(), null);
  assert.ok(accounts.netease);
  await api.signIn();
  assert.deepEqual(steps, ['netease', 'qqmusic', 'qqmusic']);
  settings.set('loginTarget', 'netease');
  assert.ok(await api.account());
});

// An old combined account refresh must not erase a newly completed sign-in.
test('late account reads preserve a newer provider login', async () => {
  let finish;
  const { api, settings, storage } = setup({
    netease: { account: () => new Promise(resolve => { finish = resolve; }) },
    qqmusic: { signIn: async () => ({ id: '42', name: 'New QQ account' }) },
  });
  const pending = api.account();
  settings.set('loginTarget', 'qqmusic');
  await api.signIn();
  finish(null);
  assert.match((await pending).name, /New QQ account/);
  assert.equal(storage.get('fusion.profiles').qqmusic.id, '42');
});

// An invalid text setting must never turn a one-account sign-out into both.
test('invalid login target refuses sign-out before touching accounts', async () => {
  const { api, settings, calls } = setup();
  settings.set('loginTarget', 'typo');
  await assert.rejects(api.signOut(), { code: 'setup' });
  assert.deepEqual(calls, []);
});

// Source-owned playlist pages must never accept a mixed playlist mutation.
test('cloud collections are namespaced, visible and read-only', async () => {
  const { api } = setup({ qqmusic: {
    playlists: async () => [{ id: '1', name: 'QQ cloud', mine: true }],
    playlist: async () => ({ id: '1', name: 'QQ cloud', mine: true, tracks: [song('1')] }),
    home: async () => ({ sections: [{ links: [{ title: 'Charts', page: 'charts' }], playlists: [{ id: '1', name: 'QQ cloud' }] }] }),
  } });
  const cloud = (await api.playlists())[0];
  assert.equal(cloud.id, 'qqmusic:1');
  assert.equal(cloud.mine, true);
  assert.equal(cloud.fixed, true);
  assert.equal((await api.playlist({ id: cloud.id })).tracks[0].id, 'qqmusic:1');
  await assert.rejects(api.addToPlaylist({ id: cloud.id, trackIds: ['netease:1'] }), { code: 'unsupported' });
  const page = await api.browse({ page: 'qqmusic:home' });
  assert.equal(page.sections[0].links[0].page, 'qqmusic:charts');
});

// Old JSON stores numeric QQ IDs without MediaMID; retain stable IDs for detail hydration.
test('legacy import preserves mixed identity and repeat-save is idempotent', async () => {
  const legacy = [
    { id: -1, name: 'Old Mix', tracks: [
      { id: 9, name: 'NetEase' }, { id: 9, src: 'qqmusic', name: 'QQ' },
      { id: 10, src: 'qqmusic', ref: 'SomeMID', name: 'QQ MID' },
      { id: 11, src: 'subsonic', name: 'Unsupported' },
    ] },
    { id: 100, name: 'Cloud playlist', tracks: [] },
  ];
  const { data, skipped } = convertLegacy(legacy);
  assert.equal(skipped.length, 1);
  assert.deepEqual(data.playlists[0].tracks.map(t => t.id), ['netease:9', 'qqmusic:9', 'qqmusic:SomeMID']);
  const { api, host, providers } = setup();
  api.setSetting({ key: 'importPlaylists', value: JSON.stringify(data) });
  createFusion(providers, host).setSetting({ key: 'importPlaylists', value: JSON.stringify(data) });
  const lists = await api.playlists();
  assert.equal(lists.length, 1);
  assert.equal(lists[0].tracks.length, 3);
  assert.equal(lists[0].tracks[1].unavailable, false);
  assert.throws(() => api.setSetting({ key: 'importPlaylists', value: JSON.stringify({ ...data, playlists: [{ name: 'bad', tracks: [{ id: 'evil:1', name: 'x' }] }] }) }));
  assert.equal((await api.playlists()).length, 1);
});
