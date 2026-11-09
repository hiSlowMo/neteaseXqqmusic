import test from 'node:test';
import assert from 'node:assert/strict';
let sequence = 0;
const authKey = 'provider.qqmusic.qqmusic.auth.v1';
const mid = '0039MnYb0qxYhV';
const song = { id: 97759, mid, title: '反方向的钟', interval: 258, singer: [{ mid: 'artistMID', name: '周杰伦' }], album: { mid: 'albumMID', name: 'Jay' }, file: { media_mid: 'differentMediaMID', size_128mp3: 100, size_320mp3: 300, size_flac: 900 } };
const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const envelope = data => ({ code: 0, req_0: { code: 0, data } });
const initial = () => ({ musicid: '18446744073709551615', musickey: 'synthetic-account', loginType: 1, refresh_key: 'synthetic-refresh', device: {}, musickeyCreateTime: Math.floor(Date.now() / 1000), keyExpiresIn: 3600 });
async function setup(handler, session) {
  const storage = new Map(session ? [[authKey, structuredClone(session)]] : []);
  const calls = [];
  globalThis.host = {
    storage: { get: k => structuredClone(storage.get(k)), set: (k, v) => storage.set(k, structuredClone(v)), remove: k => storage.delete(k) },
    setting: () => '', t: text => text, language: () => 'zh-CN', signInPrompt: () => {},
  };
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return handler(String(url), init); };
  const api = await import(`../src/providers/qqmusic/index.js?case=${++sequence}`);
  return { api, storage, calls };
}

// Imported playlists may have only a decimal QQ ID; reconstruct the two-MID filename before playback.
test('numeric ID rehydrates media MID and uses one authenticated snapshot', async () => {
  const session = initial();
  const { api, calls } = await setup((url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.comm.qq, session.musicid);
    assert.equal(body.comm.authst, session.musickey);
    assert.match(init.headers.Cookie, new RegExp(`qqmusic_uin=${session.musicid}`));
    assert.ok(init.headers.Cookie.includes(session.musickey));
    if (body.req_0.method === 'get_song_detail_yqq') {
      assert.equal(body.req_0.param.song_id, '97759'); assert.equal(body.req_0.param.song_mid, '');
      return json(envelope({ track_info: song }));
    }
    assert.equal(body.req_0.method, 'UrlGetVkey');
    assert.equal(body.req_0.param.uin, session.musicid);
    assert.equal(body.req_0.param.filename[0], `M800${mid}differentMediaMID.mp3`);
    return json(envelope({ midurlinfo: [{ songmid: mid, purl: '/test.mp3?vkey=synthetic' }], sip: ['https://dl.stream.qqmusic.qq.com/'] }));
  }, session);
  const stream = await api.stream({ id: '97759', quality: 'high' });
  assert.equal(stream.type, 'mp3'); assert.equal(stream.size, 300);
  assert.equal(stream.url, 'https://dl.stream.qqmusic.qq.com/test.mp3?vkey=synthetic');
  assert.equal(stream.headers.Cookie, undefined);
  assert.equal(calls.length, 2);
});

// Playback starts with refresh readiness, not an account-page visit, including parallel selections.
test('expired WeChat playback refreshes once before detail and vkey requests', async () => {
  const old = { ...initial(), musickeyCreateTime: 1, keyExpiresIn: 1 };
  let finishRefresh, refreshes = 0, enteredRefresh;
  const entered = new Promise(resolve => { enteredRefresh = resolve; });
  const { api, storage } = await setup(async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.req?.method === 'Login') {
      refreshes++;
      enteredRefresh();
      return new Promise(resolve => { finishRefresh = () => resolve(json({ code: 0, req: { code: 0, data: { ...initial(), musickey: 'synthetic-renewed' } } })); });
    }
    assert.equal(body.comm.authst, 'synthetic-renewed');
    assert.ok(init.headers.Cookie.includes('synthetic-renewed'));
    if (body.req_0.method === 'get_song_detail_yqq') return json(envelope({ track_info: song }));
    assert.equal(body.req_0.param.uin, old.musicid);
    return json(envelope({ midurlinfo: [{ songmid: mid, purl: '/test.mp3' }], sip: ['https://dl.stream.qqmusic.qq.com/'] }));
  }, old);
  const requests = [api.stream({ id: mid }), api.stream({ id: mid })];
  await entered;
  finishRefresh();
  await Promise.all(requests);
  assert.equal(refreshes, 1);
  assert.equal(storage.get(authKey).musickey, 'synthetic-renewed');
});

// Parallel playback/prefetch requests share detail and vkey work. Success is
// briefly reused, but failures, other tracks/qualities and account changes
// must never become another request's playback authorization.
test('stream work coalesces and short-lived success is scoped to track, quality and account', async () => {
  let calls = 0;
  const details = [];
  const session = initial();
  const { api } = await setup(async (url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    if (body.req_0.method === 'get_song_detail_yqq') {
      await new Promise(resolve => { details.push(resolve); });
      return json(envelope({ track_info: song }));
    }
    return json(envelope({ midurlinfo: [{ songmid: mid, purl: `/synthetic-${calls}.mp3` }], sip: ['https://dl.stream.qqmusic.qq.com/'] }));
  }, session);
  const resolveDetails = async count => {
    for (let tries = 0; tries < 50 && details.length < count; tries++) await new Promise(setImmediate);
    assert.equal(details.length, count);
    for (const finish of details.splice(0)) finish();
  };
  const first = api.stream({ id: mid, quality: 'high' });
  const second = api.stream({ id: mid, quality: 'high' });
  await resolveDetails(1);
  const [original] = await Promise.all([first, second]);
  assert.equal(calls, 2, 'two in-flight requests share two API calls');
  assert.equal((await api.stream({ id: mid, quality: 'high' })).url, original.url);
  assert.equal(calls, 2, 'a short-lived success needs no new detail/vkey calls');
  const otherQuality = api.stream({ id: mid, quality: 'lossless' });
  const otherTrack = api.stream({ id: '97759', quality: 'high' });
  await resolveDetails(2);
  await Promise.all([otherQuality, otherTrack]);
  assert.equal(calls, 6, 'different qualities and tracks stay separate');
  api.signOut();
  const signedOut = api.stream({ id: mid, quality: 'high' });
  await resolveDetails(1);
  const anonymous = await signedOut;
  assert.notEqual(anonymous.url, original.url);
  assert.equal(calls, 8, 'sign-out invalidates the old signed URL');
});

test('failed stream resolution is not cached as a success', async () => {
  let calls = 0;
  const { api } = await setup((url, init) => {
    calls++;
    if (calls === 1) throw new Error('synthetic temporary failure');
    return json(envelope(JSON.parse(init.body).req_0.method === 'get_song_detail_yqq'
      ? { track_info: song }
      : { midurlinfo: [{ songmid: mid, purl: '/recovered.mp3' }], sip: ['https://dl.stream.qqmusic.qq.com/'] }));
  });
  await assert.rejects(api.stream({ id: mid }), /temporary failure/);
  assert.equal((await api.stream({ id: mid })).url, 'https://dl.stream.qqmusic.qq.com/recovered.mp3');
  assert.equal(calls, 3);
});

// Desktop filtering falls back once, then the raw backend page stays pinned across merged offsets.
test('search fallback pins legacy page cursor', async () => {
  let desktop = 0;
  const pages = [];
  const { api } = await setup((url, init) => {
    if (url.includes('musicu.fcg')) {
      desktop++;
      return json(envelope({ body: { song: { list: [] } }, meta: { is_filter: -1, sum: 100 } }));
    }
    const params = new URL(url).searchParams;
    pages.push(params.get('p'));
    return json({ code: 0, data: { song: { list: [song, { ...song, mid: 'anotherMID' }], totalnum: 40 } } });
  });
  const first = await api.search({ query: '反方向的钟', kind: 'tracks' });
  assert.equal(first.tracks.length, 2); assert.equal(first.more, true);
  const next = await api.search({ query: '反方向的钟', kind: 'tracks', offset: 2 });
  assert.equal(next.more, false);
  assert.equal(desktop, 1);
  assert.deepEqual(pages, ['1', '2']);
});

// A returned purl must not redirect the host player to an unrelated host or scheme.
test('untrusted playback URLs are rejected without forwarding account cookies', async () => {
  for (const purl of ['https://unrelated.example/track', 'file:///tmp/track', '//unrelated.example/track']) {
    const { api } = await setup((url, init) => JSON.parse(init.body).req_0.method === 'get_song_detail_yqq'
      ? json(envelope({ track_info: song }))
      : json(envelope({ midurlinfo: [{ songmid: mid, purl }], sip: ['https://dl.stream.qqmusic.qq.com/'] })));
    await assert.rejects(api.stream({ id: mid }), { code: 'unavailable' });
  }
});

// A normal missing-vkey response retries the same song once without token refresh or account downgrade.
test('missing vkey is bounded and does not rotate credentials', async () => {
  let keys = 0;
  const session = initial();
  const { api, storage } = await setup((url, init) => {
    const body = JSON.parse(init.body);
    assert.ok(body.req_0, 'unexpected refresh');
    if (body.req_0.method === 'get_song_detail_yqq') return json(envelope({ track_info: song }));
    assert.equal(body.req_0.method, 'UrlGetVkey'); keys++;
    return json(envelope({ midurlinfo: [] }));
  }, session);
  await assert.rejects(api.stream({ id: mid, quality: 'standard' }), { code: 'unavailable' });
  assert.equal(keys, 2);
  assert.equal(storage.get(authKey).musickey, session.musickey);
});

// Special system playlists stay fixed while ordinary user playlists are editable and third-party playlists can be saved.
test('owned playlists mark system folders fixed and savePlaylist writes favorite status', async () => {
  const session = { ...initial(), encryptUin: 'encUin' };
  const methods = [];
  const { api } = await setup((url, init) => {
    const body = JSON.parse(init.body);
    const { module, method, param } = body.req_0;
    methods.push([module, method, param]);
    if (method === 'GetPlaylistByUin') {
      return json(envelope({
        v_playlist: [
          { tid: 20100, dirId: 201, dirType: 1, dirName: '我喜欢', songNum: 10 },
          { tid: 10001, dirId: 1, dirType: 0, dirName: '我的普通歌单', songNum: 3 },
        ],
      }));
    }
    if (method === 'CgiGetPlaylistFavInfo') {
      return json(envelope({ v_list: [{ tid: 30001, dissname: '别人歌单', songnum: 5 }], hasmore: 0 }));
    }
    if (method === 'FavPlaylist' || method === 'CancelFavPlaylist') {
      return json(envelope({ result: 0, v_failedPlaylistId: [] }));
    }
    throw new Error(`unexpected ${method}`);
  }, session);
  const lists = await api.playlists();
  assert.deepEqual(lists.map(p => [p.id, p.mine, !!p.fixed, !!p.saved]), [
    ['20100', true, true, false],
    ['10001', true, false, false],
    ['30001', false, false, true],
  ]);
  await api.savePlaylist({ id: '30001', on: true });
  await api.savePlaylist({ id: '30001', on: false });
  assert.deepEqual(methods.slice(-2).map(m => m[1]), ['FavPlaylist', 'CancelFavPlaylist']);
});

// The saved-album asset CGI may return its total as a decimal string.
test('saved albums accept decimal string totals and paginate independently', async () => {
  const offsets = [];
  const { api } = await setup((url, init) => {
    assert.match(url, /fcg_get_profile_order_asset\.fcg/);
    assert.match(init.headers.Cookie, /synthetic-account/);
    const params = new URL(url).searchParams;
    assert.equal(params.get('reqtype'), '2');
    assert.equal(params.get('userid'), '18446744073709551615');
    const offset = Number(params.get('sin'));
    offsets.push(offset);
    assert.equal(Number(params.get('ein')), offset + 19);
    return json({ code: 0, data: {
      totalalbum: '21',
      albumlist: Array.from({ length: offset ? 1 : 20 }, (_, index) => ({
        albummid: `album${offset + index}`,
        albumname: `Saved ${offset + index}`,
        singers: [{ mid: 'artistMID', name: 'Artist' }],
      })),
    } });
  }, initial());
  const first = await api.savedAlbums({ offset: 0 });
  assert.equal(first.albums.length, 20);
  assert.equal(first.albums[0].id, 'album0');
  assert.equal(first.more, true);
  const second = await api.savedAlbums({ offset: 20 });
  assert.equal(second.albums.length, 1);
  assert.equal(second.more, false);
  assert.deepEqual(offsets, [0, 20]);
});
