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
  assert.match(found.tracks[0].name, /〔QQ〕$/);
  assert.equal(found.tracks[0].unavailable, false);
  assert.equal(found.tracks[1].album.id, 'netease:8');
  await api.stream({ id: found.tracks[0].id, quality: 'lossless' });
  assert.deepEqual(calls, [['qqmusic', { id: '9', quality: 'lossless' }]]);
  assert.equal(relevance(song('1', '反方向，的钟'), '反 方 向 的 钟'), 0);
  assert.equal(relevance(song('1', '其他歌'), '周杰伦'), 3);
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
