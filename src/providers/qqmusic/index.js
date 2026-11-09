// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from Amamiya23/mygo-music-qq-plugin; see THIRD_PARTY_NOTICES.md.
import { providerHost } from '../../host.js';
import { createSessionStore, validSession } from './session.js';
import { createStreamCache } from '../../stream-cache.js';
import { qqFetch as fetch } from './http.js';
const host = providerHost('qqmusic');
const sessions = createSessionStore({ storage: host.storage, refresh: s => refreshWechatSession(s, fetch) });

import { qqSignIn } from './auth-qq.js';
import { wechatSignIn, wechatDeviceComm, refreshWechatSession, prepareQQDevice } from './auth-wechat.js';
import { qqMusicAppSignIn } from './auth-app.js';
import { parseQQLoginMethod } from './login-method.js';
let appLoginAbort = null;
import { decodeQR } from './qr.js';
import { wechatRandom, wechatCookieFetch } from './wechat-host.js';

const API = "https://u.y.qq.com/cgi-bin/musicu.fcg";
const headers = { "Content-Type": "application/json", "Referer": "https://y.qq.com/", "User-Agent": "Mozilla/5.0" };
const pageSize = 20;
const searchPages = new Map();

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

async function rawRpc(module, method, param, session, customComm, signal) {
  const auth = qqAuthContext(session);
  const comm = customComm ? { ...customComm } : auth?.comm || { ct: 24, cv: 0 };
  if (customComm && auth) {
    Object.assign(comm, { qq: session.musicid, authst: session.musickey, tmeLoginType: session.loginType });
    if ('uin' in comm) comm.uin = session.musicid;
  }
  if (customComm && !auth) {
    delete comm.qq; delete comm.authst;
    comm.tmeLoginType = -1;
    if ('uin' in comm) comm.uin = '0';
  }
  const requestHeaders = { ...headers, 'User-Agent': 'QQMusic 14090008(android 10)' };
  if (auth) requestHeaders.Cookie = auth.cookie;
  if (method === 'DoSearchForQQMusicDesktop') {
    requestHeaders['User-Agent'] = headers['User-Agent'];
    if (!auth) requestHeaders.Cookie = 'tmeLoginType=-1';
  }
  const response = await fetch(API, { method: 'POST', headers: requestHeaders, signal, body: JSON.stringify({ comm, req_0: { module, method, param } }) });
  if (!response.ok) throw new Error(`QQ Music HTTP ${response.status}`);
  const body = await response.json();
  if (!body || typeof body.code !== 'number' || typeof body.req_0?.code !== 'number') throw new Error('QQ Music returned a malformed response');
  const code = body.req_0.code || body.req_0.subcode || 0;
  if (body.code !== 0 || code !== 0) {
    throw Object.assign(new Error(`QQ Music ${method}: ${body.code}/${code}`), { qqGlobalCode: body.code, qqCode: code });
  }
  if (body.req_0.data == null || typeof body.req_0.data !== 'object') throw new Error(`QQ Music ${method}: missing data`);
  return body.req_0.data;
}
async function rpc(module, method, param, comm) {
  if (module === 'music.globalComment.CommentRead') return rawRpc(module, method, param, null, comm);
  return sessions.run(s => rawRpc(module, method, param, s, comm));
}

async function rawCgi(path, params, session) {
  const query = Object.entries({ ...params, format: "json", outCharset: "utf-8" }).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const auth = qqAuthContext(session);
  const response = await fetch(`https://c.y.qq.com${path}?${query}`, { headers: { Referer: "https://y.qq.com/", "User-Agent": "Mozilla/5.0", ...(auth ? { Cookie: auth.cookie } : {}) } });
  if (!response.ok) throw new Error(`QQ Music HTTP ${response.status}`);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text.replace(/^\s*[a-zA-Z_$][\w$]*\s*\(([\s\S]*)\)\s*;?\s*$/, '$1')); }
  catch { throw new Error('QQ Music returned malformed data'); }
  if (body.code !== 0 || body.subcode) throw Object.assign(new Error(`QQ Music: ${body.code}`), { qqGlobalCode: 0, qqCode: body.code || body.subcode });
  return body;
}
async function cgi(path, params, expected) {
  return sessions.run(s => {
    if (expected && expected.musicid !== s?.musicid) throw qqAuthError('账号已改变，请重试', 'signIn');
    return rawCgi(path, params, s);
  });
}

function artistOf(a = {}) {
  const mid = a.mid || a.singermid || a.singer_mid || a.singerMid || a.singerMID || "";
  return { id: String(mid), name: a.name || a.singername || a.singer_name || a.singerName || "", imageUrl: mid ? `https://y.gtimg.cn/music/photo_new/T001R300x300M000${mid}.jpg` : "" };
}

function albumOf(a = {}) {
  const mid = a.mid || a.albummid || a.album_mid || a.albumMid || a.albumMID || "";
  return { id: String(mid), name: a.name || a.title || a.albumname || a.album_name || a.albumName || "", imageUrl: a.albumPic || (mid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${mid}.jpg` : ""), artists: (a.singer || a.singer_list || []).map(artistOf), released: a.publicTime || a.aDate || a.time_public || "" };
}

function trackOf(raw) {
  const t = raw.musicData || raw.songInfo || raw.track_info || raw;
  const mid = t.mid || t.songmid || t.songMid || "";
  const album = t.album || { albummid: t.albummid || t.album_mid, albumname: t.albumname || t.album_name };
  return { id: String(mid), name: t.title || t.name || t.songname || t.songName || "", artists: (t.singer || t.singers || []).map(artistOf), album: albumOf(album), duration: (Number(t.interval) || 0) * 1000, url: `https://y.qq.com/n/ryqq/songDetail/${mid}` };
}

export async function search({ query, kind = 'tracks', offset = 0 }) {
  if (kind === 'playlists') return qqBrowse.searchPlaylists({ query, offset });
  const kinds = { tracks: [0, 'song', trackOf, 0], artists: [1, 'singer', artistOf, 9], albums: [2, 'album', albumOf, 8] };
  const spec = kinds[kind];
  if (!spec) fail('unsupported', 'This search type is not supported');
  query = query.trim();
  if (!query) return { [kind]: [], more: false };
  const key = `${kind}\0${query}`;
  if (!offset || !searchPages.has(key)) {
    searchPages.set(key, new Map());
    if (searchPages.size > 24) searchPages.delete(searchPages.keys().next().value);
  }
  const pages = searchPages.get(key);
  const cursor = pages.get(offset) || { page: Math.floor(offset / pageSize) + 1, backend: '' };
  const page = cursor.page;
  let list, total, backend = cursor.backend;
  if (backend !== 'legacy') {
    try {
      const data = await rpc('music.search.SearchCgiService', 'DoSearchForQQMusicDesktop', { query, search_type: spec[0], num_per_page: pageSize, page_num: page }, { ct: 11, cv: 0, uin: '0', format: 'json' });
      if (data.code) throw new Error(`QQ Music search: ${data.code}`);
      list = data.body?.[spec[1]]?.list;
      if (!Array.isArray(list) || !data.meta || !list.length && Number(data.meta.is_filter) < 0) throw new Error('QQ Music search was filtered or malformed');
      total = Number(data.meta.sum || 0);
      backend = 'desktop';
    } catch (e) {
      if (cursor.backend === 'desktop' || e.code === 'signIn') throw e;
      backend = 'legacy';
    }
  }
  if (backend === 'legacy') {
    const body = await cgi('/soso/fcgi-bin/client_search_cp', { p: page, n: pageSize, w: query, t: spec[3], cr: 1, new_json: 1 });
    const group = body.data?.[spec[1]];
    list = group?.list;
    if (!Array.isArray(list)) throw new Error('QQ Music: malformed legacy search response');
    total = Number(group.totalnum || group.total || 0);
  }
  const found = list.map(spec[2]).filter(item => item.id);
  if (list.length && !found.length) throw new Error('QQ Music search returned no valid identities');
  const more = list.length > 0 && page * pageSize < total;
  if (more && found.length) pages.set(offset + found.length, { page: page + 1, backend });
  return { [kind]: found, more };
}

export async function suggest({ query }) {
  query = query.trim();
  if (!query) return [];
  const result = await cgi("/splcloud/fcgi-bin/smartbox_new.fcg", { key: query, inCharset: "utf-8", platform: "yqq", needNewCode: "0" });
  if (!result.data) throw new Error("QQ Music: malformed search suggestions");
  const groups = ["song", "singer", "album"].map(key => result.data[key]).filter(Boolean).sort((a, b) => (a.order || 0) - (b.order || 0));
  return [...new Set(groups.flatMap(group => (group.itemlist || []).map(item => item?.name).filter(Boolean)))];
}

async function trackDetails(id, session, signal) {
  id = String(id);
  const numeric = /^\d+$/.test(id);
  if (!/^[a-zA-Z0-9]{1,64}$/.test(id)) fail('unavailable', '无效的 QQ 歌曲 ID');
  const detail = await rawRpc('music.pf_song_detail_svr', 'get_song_detail_yqq', { song_type: 0, song_mid: numeric ? '' : id, song_id: numeric ? id : '0' }, session, undefined, signal);
  const t = detail.track_info;
  const mid = t?.mid || t?.songmid;
  if (!mid || (numeric ? String(t.id || t.songid) !== id : mid !== id)) fail('unavailable', 'QQ 音乐未返回匹配的歌曲资料');
  return t;
}
function streamURL(purl, base) {
  const url = new URL(purl, base);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !/(^|\.)(qqmusic\.qq\.com|qq\.com)$/i.test(url.hostname)) fail('unavailable', 'QQ 音乐返回了不支持的音频地址');
  return url.href;
}
async function streamOnce(id, quality, session, signal) {
  const t = await trackDetails(id, session, signal);
  id = String(t.mid || t.songmid);
  const media = t.file?.media_mid || t.strMediaMid || t.media_mid || id;
  const guid = Array.from({ length: 18 }, () => Math.floor(Math.random() * 10)).join('');
  const qualities = [{ prefix: "M500", type: "mp3", quality: "standard", size: t.file?.size_128mp3 }];
  if (session && (quality === "high" || quality === "lossless")) qualities.unshift({ prefix: "M800", type: "mp3", quality: "high", size: t.file?.size_320mp3 });
  if (session && quality === "lossless") qualities.unshift({ prefix: "F000", type: "flac", quality: "lossless", size: t.file?.size_flac });
  for (const q of qualities) {
    const param = { filename: [`${q.prefix}${id}${media}.${q.type}`], guid, songmid: [id], songtype: [0], uin: session?.musicid || "0" };
    if (session) param.ctx = 0;
    else { param.loginflag = 1; param.platform = "20"; }
    const data = await rawRpc(session ? 'music.vkey.GetVkey' : 'vkey.GetVkeyServer', session ? 'UrlGetVkey' : 'CgiGetVkey', param, session, undefined, signal);
    const entry = (data.midurlinfo || []).find(item => (!item.songmid || item.songmid === id) && item.purl);
    if (!entry) continue;
    const base = (data.sip || []).find(url => /^https?:\/\/(?:[a-z0-9-]+\.)*(?:qqmusic\.qq\.com|qq\.com)(?::\d+)?\//i.test(url) && !/^http:\/\/ws/i.test(url)) || "http://dl.stream.qqmusic.qq.com/";
    return { url: streamURL(entry.purl, base), type: q.type, quality: q.quality, size: Number(q.size) || 0, gain: Number(t.volume?.gain) || 0, peak: Number(t.volume?.peak) || 0, headers: { Referer: "https://y.qq.com/", "User-Agent": "Mozilla/5.0" } };
  }
  throw Object.assign(new Error('QQ 音乐暂未提供完整播放链接，请检查对应账号与歌曲权限'), { code: 'unavailable', missingStream: true });
}
export async function stream({ id, quality = 'standard' }) {
  return streamCache.stream(String(id), quality);
}
const streamCache = createStreamCache({ version: sessions.version, load: resolveStream });
async function resolveStream(id, quality) {
  // Stay within MyGo's 30-second call deadline even with quality fallbacks.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 24000);
  try {
    for (let attempt = 0; ; attempt++) {
      try { return await sessions.run(s => streamOnce(id, quality, s, controller.signal)); }
      catch (e) {
        if (!e.missingStream || attempt > 0 || controller.signal.aborted) throw e;
        // Retry the selected song once, without rotating an otherwise valid key.
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
  } finally { clearTimeout(timer); }
}
export async function track({ id }) {
  return sessions.run(async s => {
    const result = trackOf(await trackDetails(id, s));
    // Keep an imported numeric ID stable even after resolving its MID.
    return { ...result, id: String(id) };
  });
}

function decodeLyric(value) {
  if (!value) return "";
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

async function lyricTranslation(id) {
  try {
    const comm = { ct: 11, cv: "1003006", v: "1003006", tmeAppID: "qqmusiclight", nettype: "NETWORK_WIFI", udid: "0", uid: "0" };
    const result = await rpc("music.musichallSong.PlayLyricInfo", "GetPlayLyricInfo", { songMID: id, songName: "", singerName: "", albumName: "", interval: 0, crypt: 0, ct: 19, cv: 2111, lrc_t: 0, qrc: 0, qrc_t: 0, roma: 0, roma_t: 0, trans: 1, trans_t: 0, type: 0 }, comm);
    const candidate = decodeLyric(result.trans);
    return /\[\d{1,3}:\d{2}/.test(candidate) ? candidate : "";
  } catch { return ""; }
}

export async function lyrics({ id }) {
  try {
    const data = await rpc("music.musichallSong.PlayLyricInfo", "GetPlayLyricInfo", { songMID: id, crypt: 1, ct: 24, cv: 0, lver: 0, qrc: 1, trans: 1, roma: 0 });
    const original = decodeQRC(data.lyric || "");
    const lines = parseQRC(original);
    if (lines.length) {
      let translation = "";
      try { translation = decodeQRC(data.trans || ""); } catch { /* Some songs have no encrypted translation. */ }
      if (!translation) translation = await lyricTranslation(id);
      if (translation) attachLyricTranslations(lines, translation);
      return { lines, translation };
    }
    if (/\[\d{1,3}:\d{2}/.test(original)) return { lrc: original, translation: decodeQRC(data.trans || "") };
  } catch { /* QQ may not have QRC for this song; use the ordinary lyrics. */ }
  const data = await cgi("/lyric/fcgi-bin/fcg_query_lyric_new.fcg", { songmid: id });
  let translation = decodeLyric(data.trans);
  if (!translation) translation = await lyricTranslation(id);
  return { lrc: decodeLyric(data.lyric), translation };
}

export function parseQRC(input) {
  const wrapped = /\bLyricContent="([\s\S]*?)"/.exec(input);
  const content = wrapped ? decodeEntities(wrapped[1]) : input;
  const lines = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[(\d+),(\d+)\]/.exec(line);
    if (!header) continue;
    const start = Number(header[1]);
    let end = start + Number(header[2]);
    const body = line.slice(header[0].length), words = [], tags = /\((\d+),(\d+)\)/g;
    let match, at = 0;
    while ((match = tags.exec(body))) {
      const text = body.slice(at, match.index);
      at = tags.lastIndex;
      if (!text) continue;
      const wordStart = Number(match[1]), wordEnd = wordStart + Number(match[2]);
      words.push({ start: wordStart, end: wordEnd, text });
      end = Math.max(end, wordEnd);
    }
    const text = words.map(word => word.text).join("").trim();
    if (text && !body.slice(at).trim()) lines.push({ start, end, text, words });
  }
  return lines.sort((a, b) => a.start - b.start);
}

function attachLyricTranslations(lines, translation) {
  for (const raw of translation.split(/\r?\n/)) {
    const matches = [...raw.matchAll(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g)];
    if (!matches.length) continue;
    const last = matches[matches.length - 1];
    const text = raw.slice(last.index + last[0].length).trim();
    if (!text) continue;
    for (const match of matches) {
      const time = Number(match[1]) * 60000 + Number(match[2]) * 1000 + Number(`0.${match[3] || 0}`) * 1000;
      let best, gap = 1500;
      for (const line of lines) {
        const distance = Math.abs(line.start - time);
        if (distance < gap) { best = line; gap = distance; }
      }
      if (best && !best.translation) best.translation = text;
    }
  }
}

export async function album({ id }) {
  const body = await cgi("/v8/fcg-bin/fcg_v8_album_info_cp.fcg", { albummid: id });
  const data = body.data;
  if (!data) fail("unavailable", "Album not found");
  const tracks = (data.list || data.songlist || []).map(trackOf).filter(t => t.id);
  const result = albumOf(data);
  if (!result.id) result.id = id;
  if (!result.artists.length && tracks.length) result.artists = tracks[0].artists;
  const session = qqReadSession();
  if (session) {
    const numeric = Number(session.musicid);
    const owner = Number.isSafeInteger(numeric) ? numeric : session.musicid;
    const status = await qqAuthRpc("music.musicasset.AlbumFavRead", "IsAlbumFan", { uin: owner, v_albumMid: [id] }, session);
    if (typeof status.m_fan?.[id] !== "boolean") throw new Error("QQ Music missing album saved status");
    result.saved = status.m_fan[id];
  }
  return { album: result, tracks };
}

export async function artist({ id }) {
  const data = await rpc("music.web_singer_info_svr", "get_singer_detail_info", { sort: 5, singermid: id, sin: 0, num: 50 });
  const result = artistOf(data.singer_info || {});
  if (!result.id) result.id = id;
  const list = await rpc("music.musichallAlbum.AlbumListServer", "GetAlbumList", { sort: 5, singermid: id, begin: 0, num: 50 }, { ct: 24, cv: 0 });
  const albums = (list.albumList || list.albumlist || []).map(albumOf).filter(a => a.id);
  return { artist: result, tracks: (data.songlist || []).map(trackOf).filter(t => t.id), albums };
}

export function stations() {
  return [{ id: "personal-fm", name: host.t("Personal FM") }];
}

export async function stationNext({ id }) {
  if (id !== "personal-fm") fail("unavailable", "Unknown station");
  if (!qqReadSession()) fail("signIn", "Sign in to QQ Music");
  const data = await rpc("music.radioProxy.MbTrackRadioSvr", "get_radio_track", { id: 99, firstplay: 1, num: 15 });
  if (!Array.isArray(data.tracks)) throw new Error("QQ Music: malformed radio response");
  return data.tracks.map(trackOf).filter(track => track.id);
}

// Merge into index.js. host.storage is persistent JSON, not a secret store.
const qqAuthStorageKey = "qqmusic.auth.v1";
const qqAuthURL = "https://u.y.qq.com/cgi-bin/musicu.fcg";

function qqAuthError(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

const qqSession = validSession;
function qqReadSession() { return sessions.read(); }
export { qqReadSession, qqAuthContext, qqAuthRpc };

function qqAuthContext(session = qqReadSession()) {
  session = qqSession(session);
  if (!session) return null;
  return {
    comm: { ...(session.device ? wechatDeviceComm(session.device) : { ct: 11, cv: 14090008, v: 14090008, chid: "10003505", tmeAppID: "qqmusic" }), qq: session.musicid, authst: session.musickey, tmeLoginType: session.loginType },
    cookie: `uin=${session.musicid}; qqmusic_uin=${session.musicid}; qm_keyst=${session.musickey}; qqmusic_key=${session.musickey}`,
  };
}

async function qqAuthRpc(module, method, param, expected) {
  // Never replay a mutation after a partial server-side success.
  const retry = /^(Get|Is|CgiGet|UrlGet|get_)/.test(method);
  return sessions.run(s => {
    if (expected && expected.musicid !== s.musicid) throw qqAuthError('账号已改变，请重试', 'signIn');
    return rawRpc(module, method, param, s);
  }, { anonymous: false, retry });
}

async function qqAccountFor(session) {
  const data = await rawRpc('music.UserInfo.userInfoServer', 'GetLoginUserInfo', {}, session);
  if (!data.info || typeof data.info !== "object") throw qqAuthError("QQ Music returned no account information");
  const info = data.info;
  return { id: session.musicid, name: info.nick || info.nickname || session.musicid, imageUrl: info.headurl || info.logo || info.avatarUrl || info.avatar || "" };
}

export async function qqFinishSignIn(value, expected = sessions.version()) {
  const session = qqSession(value);
  if (!session) throw qqAuthError('QQ Music login returned an invalid credential');
  const profile = await qqAccountFor(session);
  sessions.set(session, expected);
  streamCache.clear();
  searchPages.clear();
  return profile;
}

export async function signIn() {
  const expected = sessions.version();
  const method = parseQQLoginMethod(typeof host.setting === 'function' ? host.setting('loginMethod') : '');
  appLoginAbort?.abort();
  const deps = { fetch, decodeQR, prompt: value => host.signInPrompt(value), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
  if (method === 'qqmusic') {
    const controller = new AbortController();
    appLoginAbort = controller;
    try {
      const value = await qqMusicAppSignIn({ ...deps, platform: host.platform, arch: host.arch,
        spawn: (command, args) => host.spawn(command, args), prepareDevice: prepareQQDevice,
        deviceComm: wechatDeviceComm, signal: controller.signal, isCurrent: () => sessions.version() === expected });
      return await qqFinishSignIn(value, expected);
    } finally { if (appLoginAbort === controller) appLoginAbort = null; }
  }
  if (method === 'wechat') {
    deps.randomBytes = await wechatRandom(fetch, text => host.crypto.md5(text));
    deps.fetch = wechatCookieFetch(fetch);
    return qqFinishSignIn(await wechatSignIn(deps), expected);
  }
  return qqFinishSignIn(await qqSignIn(deps), expected);
}

export async function account() {
  if (!qqReadSession()) return null;
  try { return await sessions.run(s => qqAccountFor(s), { anonymous: false }); }
  catch (e) { if (e.code === 'signIn') return null; throw e; }
}
export function signOut() { appLoginAbort?.abort(); appLoginAbort = null; sessions.clear(); streamCache.clear(); searchPages.clear(); }

// Inject index.js helpers and export the returned handlers when integrating.
export function createBrowse({ rpc, cgi, trackOf, t = value => value }) {
  const cursors = new Map();
  const searchPages = new Map();
  const pc = { ct: 24, cv: 0 };
  const idOf = value => value == null ? "" : String(value);
  const list = (value, name) => {
    if (!Array.isArray(value)) throw new Error(`QQ Music: missing ${name}`);
    return value;
  };
  const tracksOf = items => items.map(trackOf).filter(track => track.id);
  const unavailable = message => { const error = new Error(message); error.code = "unavailable"; throw error; };

  async function featuredPlaylists() {
    const data = await rpc("music.playlist.PlaylistSquare", "GetRecommendFeed", { From: 0, Size: 60 });
    return list(data.List, "playlist feed").map(entry => {
      const b = entry.Playlist?.basic || {};
      return { id: idOf(b.tid), name: b.title || "", description: b.desc || "", trackCount: Number(b.song_cnt) || 0, imageUrl: b.cover?.default_url || b.cover?.big_url || b.cover?.medium_url || b.cover?.small_url || "", owner: b.creator?.nick || "" };
    }).filter(item => /^[1-9]\d*$/.test(item.id));
  }

  async function charts() {
    const data = await rpc("musicToplist.ToplistInfoServer", "GetAll", {}, pc);
    return list(data.group, "chart groups").flatMap(group => list(group.toplist, "chart list"))
      .filter(item => Number(item.recType) === 10005 && /^[1-9]\d*$/.test(idOf(item.topId)))
      .map(item => ({ id: `chart:${item.topId}`, name: item.title || "", imageUrl: item.headPicUrl || item.frontPicUrl || item.musichallPicUrl || "", description: item.intro || "", trackCount: Number(item.totalNum) || 0 }));
  }

  async function home() {
    const [featured, ranking] = await Promise.all([featuredPlaylists(), charts()]);
    return { title: t("QQ Music"), sections: [{ title: t("Featured Playlists"), playlists: featured }, { title: t("Charts"), playlists: ranking }] };
  }

  async function browse({ page }) {
    if (page === "playlists") return { title: t("Featured Playlists"), sections: [{ playlists: await featuredPlaylists() }] };
    if (page === "charts") return { title: t("Charts"), sections: [{ playlists: await charts() }] };
    unavailable("Unknown browse page");
  }

  async function playlist({ id }) {
    id = idOf(id);
    if (id.startsWith("chart:")) {
      const topid = id.slice(6);
      if (!/^[1-9]\d*$/.test(topid) || !Number.isSafeInteger(Number(topid))) unavailable("Invalid chart ID");
      const data = await rpc("musicToplist.ToplistInfoServer", "GetDetail", { topid: Number(topid), offset: 0, num: 100, period: "" }, pc);
      const info = data.data || {};
      if (Number(info.recType) !== 10005) unavailable("This chart is not a song chart");
      const tracks = tracksOf(list(data.songInfoList, "chart songs"));
      if (!tracks.length) unavailable("Chart songs are unavailable");
      return { id, name: info.title || "", imageUrl: info.headPicUrl || info.frontPicUrl || "", description: info.intro || "", trackCount: Number(info.totalNum) || tracks.length, tracks };
    }
    if (!/^[1-9]\d*$/.test(id)) unavailable("Invalid playlist ID");
    const data = await cgi("/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg", { disstid: id, type: "1", json: "1", utf8: "1", onlysong: "0", new_format: "1" });
    const info = list(data.cdlist, "playlist details")[0];
    if (!info) unavailable("Playlist not found");
    const tracks = tracksOf(list(info.songlist, "playlist songs"));
    const trackCount = Number(info.total_song_num || info.songnum) || tracks.length;
    if (!tracks.length && trackCount > 0) unavailable("Playlist songs are unavailable");
    return { id, name: info.dissname || info.title || "", imageUrl: info.logo || info.picurl || "", description: info.desc || "", owner: info.nickname || info.nick || "", trackCount, tracks };
  }

  async function searchPlaylists({ query, offset = 0 }) {
    query = query.trim();
    if (!query) return { playlists: [], more: false };
    const size = 20;
    if (!offset) searchPages.set(query, new Map());
    const pages = searchPages.get(query);
    const page = pages?.get(offset) || Math.floor(Math.max(0, offset) / size) + 1;
    const data = await rpc("music.search.SearchCgiService", "DoSearchForQQMusicDesktop", { query, search_type: 3, num_per_page: size, page_num: page }, { ct: 11, cv: 0, uin: "0", format: "json" });
    if (data.code) throw new Error(`QQ Music search: ${data.code}`);
    const entries = list(data.body?.songlist?.list, "playlist search results");
    if (!data.meta) throw new Error("QQ Music: missing search metadata");
    if (!entries.length && Number(data.meta.is_filter) < 0) throw new Error("QQ Music search was filtered; try again later");
    const playlists = entries.map(item => ({ id: idOf(item.dissid), name: item.dissname || "", imageUrl: item.imgurl || "", description: item.introduction || "", trackCount: Number(item.song_count) || 0, owner: item.creator?.name || "" })).filter(item => /^[1-9]\d*$/.test(item.id));
    const more = playlists.length > 0 && page * size < Number(data.meta.sum || 0);
    if (more && pages) pages.set(offset + playlists.length, page + 1);
    return { playlists, more };
  }

  async function comments({ trackId, offset = 0 }) {
    const key = idOf(trackId);
    if (!key || !Number.isInteger(offset) || offset < 0) unavailable("Invalid comment request");
    let cursor = offset ? cursors.get(key)?.get(offset) : null;
    if (offset && !cursor) unavailable("Comment cursor expired; reopen comments");
    if (!cursor) {
      const detail = await rpc("music.pf_song_detail_svr", "get_song_detail_yqq", { song_type: 0, song_mid: key, song_id: "0" });
      const song = detail.track_info;
      if (!song || (song.mid || song.songmid) !== key || !/^[1-9]\d*$/.test(idOf(song.id || song.songid))) unavailable("Song comment ID is unavailable");
      cursor = { thread: idOf(song.id || song.songid), sequence: "", page: 0, total: 0, version: "0", seen: new Set() };
    }
    const seen = new Set(cursor.seen);
    let comments, more, total;
    do {
      const data = await rpc("music.globalComment.CommentRead", "GetNewCommentList", { BizType: 1, BizId: cursor.thread, PageSize: 25, PageNum: cursor.page, LastCommentSeqNo: cursor.sequence, PicEnable: 1, FromCommentId: "", WithHot: 0, LastTotal: cursor.total, LastTotalVer: cursor.version }, pc);
      const section = data.CommentList;
      const entries = list(section?.Comments, "comments");
      const valid = entries.filter(item => idOf(item.CmId));
      if (entries.length && !valid.length) throw new Error("QQ Music: no valid comments");
      comments = valid.filter(item => {
        const id = idOf(item.CmId);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      }).map(item => ({ id: idOf(item.CmId), author: item.Nick || "", avatarUrl: item.Avatar || "", text: decodeEntities(item.Content || ""), time: (Number(item.PubTime) || 0) * 1000, likes: Number(item.PraiseNum) || 0 }));
      const sequence = idOf(entries.length ? entries[entries.length - 1].SeqNo : "");
      more = !!sequence && sequence !== cursor.sequence && (section.HasMore === true || Number(section.HasMore) === 1);
      total = Number(section.Total) || 0;
      cursor = { thread: cursor.thread, sequence, page: cursor.page + 1, total, version: data.TotalVer ?? "0", seen };
    } while (!comments.length && more);
    if (!offset) cursors.set(key, new Map());
    if (more) cursors.get(key).set(offset + comments.length, cursor);
    return { comments, total, more };
  }

  return { home, browse, playlist, comments, searchPlaylists, featuredPlaylists, charts };
}

function decodeEntities(text) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] || whole;
    const value = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : whole;
  });
}

const qqBrowse = createBrowse({ rpc, cgi, trackOf, t: text => host.t(text) });
export async function home() {
  const page = await qqBrowse.home();
  const session = qqReadSession();
  if (!session) return page;
  try {
    const comm = { ct: 20, cv: 13020008, qq: session.musicid, authst: session.musickey, tmeLoginType: session.loginType };
    const feed = await rpc("music.recommend.RecommendFeed", "get_recommend_feed", { direction: 0, page: 1, s_num: 0, v_cache: [] }, comm);
    if (feed.retcode !== 0 || !Array.isArray(feed.v_shelf)) throw new Error("QQ Music: malformed personal recommendations");
    const cards = feed.v_shelf.flatMap(shelf => shelf.v_niche || []).flatMap(niche => niche.v_card || []);
    const seen = new Set();
    const playlists = cards.filter(card => card.type === 500 && card.subtype === 0 && card.jumptype === 10014 && /^[1-9]\d*$/.test(String(card.id)) && !seen.has(String(card.id)) && seen.add(String(card.id)))
      .map(card => ({ id: String(card.id), name: card.title || "", imageUrl: card.cover || "" }));
    if (playlists.length) page.sections.unshift({ title: host.t("Recommended for You"), playlists });
  } catch (error) {
    console.warn(`QQ Music recommendations: ${error.message}`);
  }
  return page;
}
export const browse = qqBrowse.browse;
export const comments = qqBrowse.comments;

// Authenticated RPC and CGI must send the Cookie for the supplied session.
export function createLibrary({ qqAuthRpc, qqReadSession, qqAuthCgi, cgi, trackOf, fetch: fetchProfile = globalThis.fetch }) {
  async function account(optional = false) {
    const s = await qqReadSession();
    if (!s || !/^\d+$/.test(String(s.musicid || '')) || !s.musickey || !s.loginType) {
      if (optional) return null;
      const error = new Error('QQ Music login required');
      error.code = 'signIn';
      throw error;
    }
    return s;
  }
  const call = (s, module, method, param) => qqAuthRpc(module, method, param, s);
  function idNumber(value, what) {
    const n = Number(value);
    if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(n) || n <= 0) throw new Error(`Invalid ${what}`);
    return n;
  }
  function mid(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9]{1,64}$/.test(value)) throw new Error('Invalid song MID');
    return value;
  }
  function array(value, name) {
    if (!Array.isArray(value)) throw new Error(`QQ Music missing ${name}`);
    return value;
  }
  function checked(data) {
    if (!data || ['code', 'subcode'].some(k => data[k] != null && Number(data[k]) !== 0)) throw new Error('QQ Music rejected request');
    return data;
  }
  const hasMore = p => p.hasmore === true || Number(p.hasmore) === 1;
  const asPlaylist = (p, mine = false) => ({ id: String(p.tid || p.dissid || p.id || ''), name: p.dirName || p.title || p.dissname || p.name || '', imageUrl: p.bigpicUrl || p.picUrl || p.picurl || p.coverUrl || p.logo || p.albumPicUrl || '', description: p.desc || '', trackCount: Number(p.songNum || p.songnum || p.song_cnt || p.total_song_num || 0), mine });
  const owned = async s => array((await call(s, 'music.musicasset.PlaylistBaseRead', 'GetPlaylistByUin', { uin: s.musicid })).v_playlist, 'playlists');
  async function encrypted(s) {
    if (typeof s.encryptUin === 'string' && s.encryptUin) return s.encryptUin;
    const query = new URLSearchParams({ ct: '20', cv: '4747474', cid: '205360838', userid: s.musicid, format: 'json' });
    const response = await fetchProfile(`https://c6.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg?${query}`, { headers: { Referer: 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) throw new Error(`QQ Music profile HTTP ${response.status}`);
    const body = await response.json();
    if (!body || body.code !== 0 || body.subcode || typeof body.data?.creator?.encrypt_uin !== 'string' || !body.data.creator.encrypt_uin) throw new Error('QQ Music profile missing encryptUin');
    return body.data.creator.encrypt_uin;
  }
  async function ordinary(s, id) {
    const n = idNumber(id, 'playlist ID');
    const matches = (await owned(s)).filter(p => String(p.tid) === String(n));
    const p = matches[0];
    if (matches.length !== 1 || !Number.isInteger(Number(p.dirId)) || Number(p.dirId) <= 0 || Number(p.dirId) >= 200 || Number(p.dirType) !== 0 || (p.uin && String(p.uin) !== String(s.musicid))) throw new Error('Only owned ordinary playlists can be edited');
    return { id: n, dir: Number(p.dirId), entry: p };
  }
  async function write(s, module, method, param) {
    const data = await call(s, module, method, param);
    if (!data || data.retCode !== 0 || !data.result || typeof data.result !== 'object') throw new Error(`QQ Music did not confirm ${method}`);
    return data.result;
  }
  function confirm(result, p) {
    if (Number(result.tid) !== p.id || Number(result.dirId) !== p.dir) throw new Error('QQ Music returned inconsistent playlist identity');
  }
  async function songID(s, id) {
    mid(id);
    const data = await call(s, 'music.pf_song_detail_svr', 'get_song_detail_yqq', { song_type: 0, song_mid: id, song_id: '0' });
    const t = data?.track_info;
    if (!t || (t.mid || t.songmid) !== id) throw new Error('QQ Music song identity mismatch');
    return idNumber(t.id || t.songid, 'song ID');
  }
  async function status(s, ids) {
    if (!Array.isArray(ids)) throw new Error('Invalid song IDs');
    ids.forEach(mid);
    if (!ids.length) return {};
    const data = await call(s, 'music.musicasset.SongFavRead', 'IsSongFanByMid', { v_songMid: ids });
    const result = {};
    for (const id of ids) {
      if (typeof data?.m_fan?.[id] !== 'boolean') throw new Error('QQ Music missing liked status');
      result[id] = data.m_fan[id];
    }
    return result;
  }
  const tracks = items => array(items, 'song list').map(item => {
    const track = trackOf(item);
    if (!track.id) throw new Error('QQ Music missing song MID');
    return track;
  });
  function validName(name) {
    if (typeof name !== 'string' || !name.trim() || [...name].length > 20 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new Error('Invalid playlist name');
  }
  async function playlists() {
    const s = await account(true);
    if (!s) return [];
    const euin = await encrypted(s);
    const own = (await owned(s)).map(p => asPlaylist(p, Number(p.dirId) > 0 && Number(p.dirId) < 200 && Number(p.dirType) === 0)).filter(p => p.id);
    const saved = [], seen = new Set();
    for (let offset = 0; offset < 10000;) {
      const page = await call(s, 'music.musicasset.PlaylistFavRead', 'CgiGetPlaylistFavInfo', { uin: euin, offset, size: 100 });
      const items = array(page.v_list, 'favorite playlists');
      let fresh = 0;
      for (const item of items) {
        const p = asPlaylist(item);
        if (p.id && !seen.has(p.id)) { seen.add(p.id); saved.push({ ...p, saved: true }); fresh++; }
      }
      if (!hasMore(page)) return [...own, ...saved];
      if (!items.length || !fresh) throw new Error('QQ Music favorite playlists incomplete');
      offset += items.length;
    }
    throw new Error('QQ Music favorite playlists incomplete');
  }
  async function liked({ offset = 0 } = {}) {
    const s = await account(), euin = await encrypted(s);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid offset');
    const page = checked(await call(s, 'music.srfDissInfo.DissInfo', 'CgiGetDiss', { disstid: 0, dirid: 201, tag: true, song_begin: offset, song_num: 20, userinfo: true, orderlist: true, enc_host_uin: euin }));
    const result = tracks(page.songlist);
    if (hasMore(page) && !result.length) throw new Error('QQ Music liked songs incomplete');
    return { tracks: result, more: hasMore(page) };
  }
  async function playlist({ id }) {
    const pid = idNumber(id, 'playlist ID');
    const s = await account();
    const entry = (await owned(s)).find(p => String(p.tid) === String(pid));
    if (!entry) {
      const body = await cgi('/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg', { disstid: pid, type: 1, json: 1, utf8: 1, onlysong: 0, new_format: 1 });
      const info = array(body.cdlist, 'playlist')[0];
      if (!info) throw new Error('QQ Music playlist unavailable');
      return { ...asPlaylist({ ...info, tid: pid }), tracks: tracks(info.songlist) };
    }
    const euin = await encrypted(s), result = [], seen = new Set();
    let first;
    for (let offset = 0; offset < 10000;) {
      const data = checked(await call(s, 'music.srfDissInfo.DissInfo', 'CgiGetDiss', { disstid: pid, dirid: 0, tag: true, song_begin: offset, song_num: 100, userinfo: true, orderlist: true, enc_host_uin: euin }));
      first ||= data;
      const items = tracks(data.songlist);
      if (!items.length && hasMore(data)) throw new Error('QQ Music playlist incomplete');
      if (items.length && seen.has(items[0].id)) throw new Error('QQ Music playlist paging repeated');
      if (items.length) seen.add(items[0].id);
      result.push(...items);
      const total = Number(data.total_song_num || 0);
      if (!hasMore(data) && (total === 0 || result.length >= total)) return { ...asPlaylist({ ...(first.dirinfo || {}), tid: pid, total_song_num: first.total_song_num }, Number(entry.dirId) > 0 && Number(entry.dirId) < 200 && Number(entry.dirType) === 0), tracks: result };
      if (!items.length) throw new Error('QQ Music playlist incomplete');
      offset += items.length;
    }
    throw new Error('QQ Music playlist incomplete');
  }
  async function isLiked({ ids }) {
    if (!Array.isArray(ids)) throw new Error('Invalid song IDs');
    const s = await account(true);
    if (!s) return Object.fromEntries(ids.map(id => [id, false]));
    return status(s, ids);
  }
  async function like({ id, on }) {
    const s = await account(); mid(id);
    if (typeof on !== 'boolean') throw new Error('Invalid liked state');
    if ((await status(s, [id]))[id] === on) return;
    const numeric = await songID(s, id);
    await write(s, 'music.musicasset.PlaylistDetailWrite', on ? 'AddSonglist' : 'DelSonglist', { dirId: 201, v_songInfo: [{ songId: numeric, songType: 0 }] });
    if ((await status(s, [id]))[id] !== on) throw new Error('QQ Music did not confirm liked state');
  }
  async function createPlaylist({ name }) {
    const s = await account(); validName(name);
    const result = await write(s, 'music.musicasset.PlaylistBaseWrite', 'AddPlaylist', { dirName: name });
    const p = await ordinary(s, idNumber(result.tid, 'playlist ID'));
    if (p.dir !== Number(result.dirId)) throw new Error('QQ Music returned inconsistent new playlist');
    return asPlaylist(p.entry, true);
  }
  async function renamePlaylist({ id, name }) {
    const s = await account(); validName(name);
    const p = await ordinary(s, id);
    const read = async () => {
      const data = checked(await call(s, 'music.srfDissInfo.aiDissInfo', 'uniform_get_Dissinfo', { dirid: p.dir, optype: 3, tag: 1, userinfo: 0, pic_dpi: 300 }));
      const info = data.dirinfo;
      if (!info || Number(info.dirid) !== p.dir || ['title', 'desc', 'picurl', 'picurl2'].some(k => typeof info[k] !== 'string') || !Array.isArray(info.tag) || info.tag.length > 3 || ![1, 2].includes(Number(info.dir_show)) || info.picurl2) throw new Error('QQ Music playlist settings incomplete');
      return info;
    };
    const before = await read();
    const tags = before.tag.map(t => idNumber(t.id, 'tag ID'));
    const result = await write(s, 'music.musicasset.PlaylistBaseWrite', 'EditPlaylist', { dirId: p.dir, mask: 95, dirNewName: name, dirNewDesc: before.desc, dirNewPicUrl: before.picurl, dirNewPicUrl2: '', dirNewtaglist: tags.join(','), dirShow: Number(before.dir_show) });
    confirm(result, p);
    const after = await read();
    if (after.title !== name || after.desc !== before.desc || after.picurl !== before.picurl || Number(after.dir_show) !== Number(before.dir_show)) throw new Error('QQ Music did not confirm playlist settings');
  }
  async function deletePlaylist({ id }) {
    const s = await account(), p = await ordinary(s, id);
    const result = await write(s, 'music.musicasset.PlaylistBaseWrite', 'DelPlaylist', { dirId: p.dir });
    confirm(result, p);
    if (Number(result.updateTime) !== 0 || (await owned(s)).some(x => String(x.tid) === String(p.id) || Number(x.dirId) === p.dir)) throw new Error('QQ Music did not confirm playlist deletion');
  }
  async function editSongs({ id, trackIds }, add) {
    const s = await account();
    if (!Array.isArray(trackIds) || !trackIds.length || trackIds.length > 100) throw new Error('Select 1-100 songs');
    trackIds.forEach(mid);
    const p = await ordinary(s, id);
    const songIds = await Promise.all(trackIds.map(song => songID(s, song)));
    const result = await write(s, 'music.musicasset.PlaylistDetailWrite', add ? 'AddSonglist' : 'DelSonglist', { dirId: p.dir, v_songInfo: songIds.map(songId => ({ songId, songType: 0 })) });
    confirm(result, p);
  }
  async function savedAlbums({ offset = 0 } = {}) {
    const s = await account();
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid offset');
    if (typeof qqAuthCgi !== 'function') throw new Error('Authenticated QQ Music CGI is required');
    const body = checked(await qqAuthCgi('/fav/fcgi-bin/fcg_get_profile_order_asset.fcg', { ct: 20, cid: 205360956, userid: s.musicid, reqtype: 2, sin: offset, ein: offset + 19 }, s));
    const data = body.data;
    if (!data || !Number.isSafeInteger(data.totalalbum) || data.totalalbum < 0) throw new Error('QQ Music missing saved album total');
    const entries = array(data.albumlist, 'saved albums');
    if (!entries.length && offset < data.totalalbum) throw new Error('QQ Music saved albums incomplete');
    const albums = entries.map(a => {
      if (!a || typeof a !== 'object') throw new Error('QQ Music invalid saved album');
      const id = a.albummid || a.album_mid || a.albumMid || a.albumMID || a.mid;
      if (typeof id !== 'string' || !/^[a-zA-Z0-9]{1,64}$/.test(id)) throw new Error('QQ Music missing album MID');
      const singers = a.singers || a.singer;
      const artists = Array.isArray(singers) ? singers.map(x => ({ id: String(x.mid || x.singermid || ''), name: x.name || x.singername || '' })) : [];
      if (!artists.length && (a.singerName || a.singername || a.singer_name)) artists.push({ id: String(a.singermid || a.singerMid || a.singer_mid || ''), name: a.singerName || a.singername || a.singer_name });
      return { id, name: a.albumname || a.album_name || a.albumName || a.name || a.title || '', imageUrl: a.picurl || a.picUrl || a.albumPicUrl || `https://y.gtimg.cn/music/photo_new/T002R300x300M000${id}.jpg`, artists, released: a.release_time || a.publishDate || a.pubtime || '' };
    });
    return { albums, more: offset + albums.length < data.totalalbum };
  }
  async function saveAlbum({ id, on }) {
    const s = await account();
    if (typeof id !== 'string' || !/^[a-zA-Z0-9]{1,64}$/.test(id)) throw new Error('Invalid album MID');
    if (typeof on !== 'boolean') throw new Error('Invalid album saved state');
    const numericOwner = Number(s.musicid);
    if (!/[1-9]/.test(s.musicid)) throw new Error('Invalid account ID');
    const owner = Number.isSafeInteger(numericOwner) ? numericOwner : s.musicid;
    const read = async () => {
      const data = await call(s, 'music.musicasset.AlbumFavRead', 'IsAlbumFan', { uin: owner, v_albumMid: [id] });
      if (typeof data?.m_fan?.[id] !== 'boolean') throw new Error('QQ Music missing album saved status');
      return data.m_fan[id];
    };
    if (await read() === on) return;
    const data = await call(s, 'music.musicasset.AlbumFavWrite', on ? 'FavAlbum' : 'CancelFavAlbum', { uin: s.musicid, v_albumMid: [id] });
    if (!data || data.result !== 0 || !Array.isArray(data.v_failedAlbumId) || !Array.isArray(data.v_failedAlbumMid) || data.v_failedAlbumId.length || data.v_failedAlbumMid.length) throw new Error('QQ Music did not confirm album change');
    if (await read() !== on) throw new Error('QQ Music did not confirm album saved state');
  }
  return { playlists, playlist, liked, isLiked, like, savedAlbums, saveAlbum, createPlaylist, renamePlaylist, deletePlaylist,
    addToPlaylist: args => editSongs(args, true), removeFromPlaylist: args => editSongs(args, false) };
}

const qqLibrary = createLibrary({ qqAuthRpc, qqReadSession: () => sessions.ready(), qqAuthCgi: cgi, cgi, trackOf, fetch });
export const playlists = qqLibrary.playlists;
export const liked = qqLibrary.liked;
export const isLiked = qqLibrary.isLiked;
export const like = qqLibrary.like;
export const savedAlbums = qqLibrary.savedAlbums;
export const saveAlbum = qqLibrary.saveAlbum;
export const createPlaylist = qqLibrary.createPlaylist;
export const renamePlaylist = qqLibrary.renamePlaylist;
export const deletePlaylist = qqLibrary.deletePlaylist;
export const addToPlaylist = qqLibrary.addToPlaylist;
export const removeFromPlaylist = qqLibrary.removeFromPlaylist;
export async function playlist({ id }) {
  if (id.startsWith("chart:") || !qqReadSession()) return qqBrowse.playlist({ id });
  return qqLibrary.playlist({ id });
}

// QQ cloud QRC decoder, adapted from mygo-cloudmusic internal/qqmusic/
// qrc_decrypt.go (AGPL-3.0), modified 2026-11-07. DES tables derive from
// Go crypto/des (BSD-3-Clause). Bundled pako 1.0.11 is MIT AND Zlib.
// See LICENSE, qrc-des.LICENSE and qrc-pako.LICENSE.

const qrcIP = [6,14,22,30,38,46,54,62,4,12,20,28,36,44,52,60,2,10,18,26,34,42,50,58,0,8,16,24,32,40,48,56,7,15,23,31,39,47,55,63,5,13,21,29,37,45,53,61,3,11,19,27,35,43,51,59,1,9,17,25,33,41,49,57];
const qrcFP = [24,56,16,48,8,40,0,32,25,57,17,49,9,41,1,33,26,58,18,50,10,42,2,34,27,59,19,51,11,43,3,35,28,60,20,52,12,44,4,36,29,61,21,53,13,45,5,37,30,62,22,54,14,46,6,38,31,63,23,55,15,47,7,39];
const qrcExpansion = [0,31,30,29,28,27,28,27,26,25,24,23,24,23,22,21,20,19,20,19,18,17,16,15,16,15,14,13,12,11,12,11,10,9,8,7,8,7,6,5,4,3,4,3,2,1,0,31];
const qrcP = [16,25,12,11,3,20,4,15,31,17,9,6,27,14,1,22,30,24,8,18,0,5,29,23,13,19,2,26,10,21,28,7];
const qrcPC1 = [7,15,23,31,39,47,55,63,6,14,22,30,38,46,54,62,5,13,21,29,37,45,53,61,4,12,20,28,1,9,17,25,33,41,49,57,2,10,18,26,34,42,50,58,3,11,19,27,35,43,51,59,36,44,52,60];
const qrcPC2 = [42,39,45,32,55,51,53,28,41,50,35,46,33,37,44,52,30,48,40,49,29,36,43,54,15,4,25,19,9,1,26,16,5,11,23,8,12,7,17,0,22,3,10,14,6,20,27,24];
const qrcSBoxes = [[[14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7],[0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8],[4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0],[15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13]],[[15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10],[3,13,4,7,15,2,8,15,12,0,1,10,6,9,11,5],[0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15],[13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9]],[[10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8],[13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1],[13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7],[1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12]],[[7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15],[13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9],[10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4],[3,15,0,6,10,10,13,8,9,4,5,11,12,7,2,14]],[[2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9],[14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6],[4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14],[11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3]],[[12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11],[10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8],[9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6],[4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13]],[[4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1],[13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6],[1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2],[6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12]],[[13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7],[1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2],[7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8],[2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11]]];
const qrcRotations = [1,1,2,2,2,2,2,2,1,2,2,2,2,2,2,1];
const qrcPako = (() => { const module = { exports: {} }; const exports = module.exports;
!function(e){if("object"==typeof exports&&"undefined"!=typeof module)module.exports=e();else if("function"==typeof define&&define.amd)define([],e);else{("undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof self?self:this).pako=e()}}(function(){return function r(o,s,f){function l(t,e){if(!s[t]){if(!o[t]){var i="function"==typeof require&&require;if(!e&&i)return i(t,!0);if(d)return d(t,!0);var n=new Error("Cannot find module '"+t+"'");throw n.code="MODULE_NOT_FOUND",n}var a=s[t]={exports:{}};o[t][0].call(a.exports,function(e){return l(o[t][1][e]||e)},a,a.exports,r,o,s,f)}return s[t].exports}for(var d="function"==typeof require&&require,e=0;e<f.length;e++)l(f[e]);return l}({1:[function(e,t,i){"use strict";var n="undefined"!=typeof Uint8Array&&"undefined"!=typeof Uint16Array&&"undefined"!=typeof Int32Array;i.assign=function(e){for(var t,i,n=Array.prototype.slice.call(arguments,1);n.length;){var a=n.shift();if(a){if("object"!=typeof a)throw new TypeError(a+"must be non-object");for(var r in a)t=a,i=r,Object.prototype.hasOwnProperty.call(t,i)&&(e[r]=a[r])}}return e},i.shrinkBuf=function(e,t){return e.length===t?e:e.subarray?e.subarray(0,t):(e.length=t,e)};var a={arraySet:function(e,t,i,n,a){if(t.subarray&&e.subarray)e.set(t.subarray(i,i+n),a);else for(var r=0;r<n;r++)e[a+r]=t[i+r]},flattenChunks:function(e){var t,i,n,a,r,o;for(t=n=0,i=e.length;t<i;t++)n+=e[t].length;for(o=new Uint8Array(n),t=a=0,i=e.length;t<i;t++)r=e[t],o.set(r,a),a+=r.length;return o}},r={arraySet:function(e,t,i,n,a){for(var r=0;r<n;r++)e[a+r]=t[i+r]},flattenChunks:function(e){return[].concat.apply([],e)}};i.setTyped=function(e){e?(i.Buf8=Uint8Array,i.Buf16=Uint16Array,i.Buf32=Int32Array,i.assign(i,a)):(i.Buf8=Array,i.Buf16=Array,i.Buf32=Array,i.assign(i,r))},i.setTyped(n)},{}],2:[function(e,t,i){"use strict";var f=e("./common"),a=!0,r=!0;try{String.fromCharCode.apply(null,[0])}catch(e){a=!1}try{String.fromCharCode.apply(null,new Uint8Array(1))}catch(e){r=!1}for(var l=new f.Buf8(256),n=0;n<256;n++)l[n]=252<=n?6:248<=n?5:240<=n?4:224<=n?3:192<=n?2:1;function d(e,t){if(t<65534&&(e.subarray&&r||!e.subarray&&a))return String.fromCharCode.apply(null,f.shrinkBuf(e,t));for(var i="",n=0;n<t;n++)i+=String.fromCharCode(e[n]);return i}l[254]=l[254]=1,i.string2buf=function(e){var t,i,n,a,r,o=e.length,s=0;for(a=0;a<o;a++)55296==(64512&(i=e.charCodeAt(a)))&&a+1<o&&56320==(64512&(n=e.charCodeAt(a+1)))&&(i=65536+(i-55296<<10)+(n-56320),a++),s+=i<128?1:i<2048?2:i<65536?3:4;for(t=new f.Buf8(s),a=r=0;r<s;a++)55296==(64512&(i=e.charCodeAt(a)))&&a+1<o&&56320==(64512&(n=e.charCodeAt(a+1)))&&(i=65536+(i-55296<<10)+(n-56320),a++),i<128?t[r++]=i:(i<2048?t[r++]=192|i>>>6:(i<65536?t[r++]=224|i>>>12:(t[r++]=240|i>>>18,t[r++]=128|i>>>12&63),t[r++]=128|i>>>6&63),t[r++]=128|63&i);return t},i.buf2binstring=function(e){return d(e,e.length)},i.binstring2buf=function(e){for(var t=new f.Buf8(e.length),i=0,n=t.length;i<n;i++)t[i]=e.charCodeAt(i);return t},i.buf2string=function(e,t){var i,n,a,r,o=t||e.length,s=new Array(2*o);for(i=n=0;i<o;)if((a=e[i++])<128)s[n++]=a;else if(4<(r=l[a]))s[n++]=65533,i+=r-1;else{for(a&=2===r?31:3===r?15:7;1<r&&i<o;)a=a<<6|63&e[i++],r--;1<r?s[n++]=65533:a<65536?s[n++]=a:(a-=65536,s[n++]=55296|a>>10&1023,s[n++]=56320|1023&a)}return d(s,n)},i.utf8border=function(e,t){var i;for((t=t||e.length)>e.length&&(t=e.length),i=t-1;0<=i&&128==(192&e[i]);)i--;return i<0?t:0===i?t:i+l[e[i]]>t?i:t}},{"./common":1}],3:[function(e,t,i){"use strict";t.exports=function(e,t,i,n){for(var a=65535&e|0,r=e>>>16&65535|0,o=0;0!==i;){for(i-=o=2e3<i?2e3:i;r=r+(a=a+t[n++]|0)|0,--o;);a%=65521,r%=65521}return a|r<<16|0}},{}],4:[function(e,t,i){"use strict";t.exports={Z_NO_FLUSH:0,Z_PARTIAL_FLUSH:1,Z_SYNC_FLUSH:2,Z_FULL_FLUSH:3,Z_FINISH:4,Z_BLOCK:5,Z_TREES:6,Z_OK:0,Z_STREAM_END:1,Z_NEED_DICT:2,Z_ERRNO:-1,Z_STREAM_ERROR:-2,Z_DATA_ERROR:-3,Z_BUF_ERROR:-5,Z_NO_COMPRESSION:0,Z_BEST_SPEED:1,Z_BEST_COMPRESSION:9,Z_DEFAULT_COMPRESSION:-1,Z_FILTERED:1,Z_HUFFMAN_ONLY:2,Z_RLE:3,Z_FIXED:4,Z_DEFAULT_STRATEGY:0,Z_BINARY:0,Z_TEXT:1,Z_UNKNOWN:2,Z_DEFLATED:8}},{}],5:[function(e,t,i){"use strict";var s=function(){for(var e,t=[],i=0;i<256;i++){e=i;for(var n=0;n<8;n++)e=1&e?3988292384^e>>>1:e>>>1;t[i]=e}return t}();t.exports=function(e,t,i,n){var a=s,r=n+i;e^=-1;for(var o=n;o<r;o++)e=e>>>8^a[255&(e^t[o])];return-1^e}},{}],6:[function(e,t,i){"use strict";t.exports=function(){this.text=0,this.time=0,this.xflags=0,this.os=0,this.extra=null,this.extra_len=0,this.name="",this.comment="",this.hcrc=0,this.done=!1}},{}],7:[function(e,t,i){"use strict";t.exports=function(e,t){var i,n,a,r,o,s,f,l,d,c,u,h,b,m,w,k,_,g,v,p,x,y,S,E,Z;i=e.state,n=e.next_in,E=e.input,a=n+(e.avail_in-5),r=e.next_out,Z=e.output,o=r-(t-e.avail_out),s=r+(e.avail_out-257),f=i.dmax,l=i.wsize,d=i.whave,c=i.wnext,u=i.window,h=i.hold,b=i.bits,m=i.lencode,w=i.distcode,k=(1<<i.lenbits)-1,_=(1<<i.distbits)-1;e:do{b<15&&(h+=E[n++]<<b,b+=8,h+=E[n++]<<b,b+=8),g=m[h&k];t:for(;;){if(h>>>=v=g>>>24,b-=v,0===(v=g>>>16&255))Z[r++]=65535&g;else{if(!(16&v)){if(0==(64&v)){g=m[(65535&g)+(h&(1<<v)-1)];continue t}if(32&v){i.mode=12;break e}e.msg="invalid literal/length code",i.mode=30;break e}p=65535&g,(v&=15)&&(b<v&&(h+=E[n++]<<b,b+=8),p+=h&(1<<v)-1,h>>>=v,b-=v),b<15&&(h+=E[n++]<<b,b+=8,h+=E[n++]<<b,b+=8),g=w[h&_];i:for(;;){if(h>>>=v=g>>>24,b-=v,!(16&(v=g>>>16&255))){if(0==(64&v)){g=w[(65535&g)+(h&(1<<v)-1)];continue i}e.msg="invalid distance code",i.mode=30;break e}if(x=65535&g,b<(v&=15)&&(h+=E[n++]<<b,(b+=8)<v&&(h+=E[n++]<<b,b+=8)),f<(x+=h&(1<<v)-1)){e.msg="invalid distance too far back",i.mode=30;break e}if(h>>>=v,b-=v,(v=r-o)<x){if(d<(v=x-v)&&i.sane){e.msg="invalid distance too far back",i.mode=30;break e}if(S=u,(y=0)===c){if(y+=l-v,v<p){for(p-=v;Z[r++]=u[y++],--v;);y=r-x,S=Z}}else if(c<v){if(y+=l+c-v,(v-=c)<p){for(p-=v;Z[r++]=u[y++],--v;);if(y=0,c<p){for(p-=v=c;Z[r++]=u[y++],--v;);y=r-x,S=Z}}}else if(y+=c-v,v<p){for(p-=v;Z[r++]=u[y++],--v;);y=r-x,S=Z}for(;2<p;)Z[r++]=S[y++],Z[r++]=S[y++],Z[r++]=S[y++],p-=3;p&&(Z[r++]=S[y++],1<p&&(Z[r++]=S[y++]))}else{for(y=r-x;Z[r++]=Z[y++],Z[r++]=Z[y++],Z[r++]=Z[y++],2<(p-=3););p&&(Z[r++]=Z[y++],1<p&&(Z[r++]=Z[y++]))}break}}break}}while(n<a&&r<s);n-=p=b>>3,h&=(1<<(b-=p<<3))-1,e.next_in=n,e.next_out=r,e.avail_in=n<a?a-n+5:5-(n-a),e.avail_out=r<s?s-r+257:257-(r-s),i.hold=h,i.bits=b}},{}],8:[function(e,t,i){"use strict";var z=e("../utils/common"),R=e("./adler32"),N=e("./crc32"),O=e("./inffast"),C=e("./inftrees"),I=1,D=2,T=0,U=-2,F=1,n=852,a=592;function L(e){return(e>>>24&255)+(e>>>8&65280)+((65280&e)<<8)+((255&e)<<24)}function r(){this.mode=0,this.last=!1,this.wrap=0,this.havedict=!1,this.flags=0,this.dmax=0,this.check=0,this.total=0,this.head=null,this.wbits=0,this.wsize=0,this.whave=0,this.wnext=0,this.window=null,this.hold=0,this.bits=0,this.length=0,this.offset=0,this.extra=0,this.lencode=null,this.distcode=null,this.lenbits=0,this.distbits=0,this.ncode=0,this.nlen=0,this.ndist=0,this.have=0,this.next=null,this.lens=new z.Buf16(320),this.work=new z.Buf16(288),this.lendyn=null,this.distdyn=null,this.sane=0,this.back=0,this.was=0}function o(e){var t;return e&&e.state?(t=e.state,e.total_in=e.total_out=t.total=0,e.msg="",t.wrap&&(e.adler=1&t.wrap),t.mode=F,t.last=0,t.havedict=0,t.dmax=32768,t.head=null,t.hold=0,t.bits=0,t.lencode=t.lendyn=new z.Buf32(n),t.distcode=t.distdyn=new z.Buf32(a),t.sane=1,t.back=-1,T):U}function s(e){var t;return e&&e.state?((t=e.state).wsize=0,t.whave=0,t.wnext=0,o(e)):U}function f(e,t){var i,n;return e&&e.state?(n=e.state,t<0?(i=0,t=-t):(i=1+(t>>4),t<48&&(t&=15)),t&&(t<8||15<t)?U:(null!==n.window&&n.wbits!==t&&(n.window=null),n.wrap=i,n.wbits=t,s(e))):U}function l(e,t){var i,n;return e?(n=new r,(e.state=n).window=null,(i=f(e,t))!==T&&(e.state=null),i):U}var d,c,u=!0;function H(e){if(u){var t;for(d=new z.Buf32(512),c=new z.Buf32(32),t=0;t<144;)e.lens[t++]=8;for(;t<256;)e.lens[t++]=9;for(;t<280;)e.lens[t++]=7;for(;t<288;)e.lens[t++]=8;for(C(I,e.lens,0,288,d,0,e.work,{bits:9}),t=0;t<32;)e.lens[t++]=5;C(D,e.lens,0,32,c,0,e.work,{bits:5}),u=!1}e.lencode=d,e.lenbits=9,e.distcode=c,e.distbits=5}function j(e,t,i,n){var a,r=e.state;return null===r.window&&(r.wsize=1<<r.wbits,r.wnext=0,r.whave=0,r.window=new z.Buf8(r.wsize)),n>=r.wsize?(z.arraySet(r.window,t,i-r.wsize,r.wsize,0),r.wnext=0,r.whave=r.wsize):(n<(a=r.wsize-r.wnext)&&(a=n),z.arraySet(r.window,t,i-n,a,r.wnext),(n-=a)?(z.arraySet(r.window,t,i-n,n,0),r.wnext=n,r.whave=r.wsize):(r.wnext+=a,r.wnext===r.wsize&&(r.wnext=0),r.whave<r.wsize&&(r.whave+=a))),0}i.inflateReset=s,i.inflateReset2=f,i.inflateResetKeep=o,i.inflateInit=function(e){return l(e,15)},i.inflateInit2=l,i.inflate=function(e,t){var i,n,a,r,o,s,f,l,d,c,u,h,b,m,w,k,_,g,v,p,x,y,S,E,Z=0,B=new z.Buf8(4),A=[16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];if(!e||!e.state||!e.output||!e.input&&0!==e.avail_in)return U;12===(i=e.state).mode&&(i.mode=13),o=e.next_out,a=e.output,f=e.avail_out,r=e.next_in,n=e.input,s=e.avail_in,l=i.hold,d=i.bits,c=s,u=f,y=T;e:for(;;)switch(i.mode){case F:if(0===i.wrap){i.mode=13;break}for(;d<16;){if(0===s)break e;s--,l+=n[r++]<<d,d+=8}if(2&i.wrap&&35615===l){B[i.check=0]=255&l,B[1]=l>>>8&255,i.check=N(i.check,B,2,0),d=l=0,i.mode=2;break}if(i.flags=0,i.head&&(i.head.done=!1),!(1&i.wrap)||(((255&l)<<8)+(l>>8))%31){e.msg="incorrect header check",i.mode=30;break}if(8!=(15&l)){e.msg="unknown compression method",i.mode=30;break}if(d-=4,x=8+(15&(l>>>=4)),0===i.wbits)i.wbits=x;else if(x>i.wbits){e.msg="invalid window size",i.mode=30;break}i.dmax=1<<x,e.adler=i.check=1,i.mode=512&l?10:12,d=l=0;break;case 2:for(;d<16;){if(0===s)break e;s--,l+=n[r++]<<d,d+=8}if(i.flags=l,8!=(255&i.flags)){e.msg="unknown compression method",i.mode=30;break}if(57344&i.flags){e.msg="unknown header flags set",i.mode=30;break}i.head&&(i.head.text=l>>8&1),512&i.flags&&(B[0]=255&l,B[1]=l>>>8&255,i.check=N(i.check,B,2,0)),d=l=0,i.mode=3;case 3:for(;d<32;){if(0===s)break e;s--,l+=n[r++]<<d,d+=8}i.head&&(i.head.time=l),512&i.flags&&(B[0]=255&l,B[1]=l>>>8&255,B[2]=l>>>16&255,B[3]=l>>>24&255,i.check=N(i.check,B,4,0)),d=l=0,i.mode=4;case 4:for(;d<16;){if(0===s)break e;s--,l+=n[r++]<<d,d+=8}i.head&&(i.head.xflags=255&l,i.head.os=l>>8),512&i.flags&&(B[0]=255&l,B[1]=l>>>8&255,i.check=N(i.check,B,2,0)),d=l=0,i.mode=5;case 5:if(1024&i.flags){for(;d<16;){if(0===s)break e;s--,l+=n[r++]<<d,d+=8}i.length=l,i.head&&(i.head.extra_len=l),512&i.flags&&(B[0]=255&l,B[1]=l>>>8&255,i.check=N(i.check,B,2,0)),d=l=0}else i.head&&(i.head.extra=null);i.mode=6;case 6:if(1024&i.flags&&(s<(h=i.length)&&(h=s),h&&(i.head&&(x=i.head.extra_len-i.length,i.head.extra||(i.head.extra=new Array(i.head.extra_len)),z.arraySet(i.head.extra,n,r,h,x)),512&i.flags&&(i.check=N(i.check,n,h,r)),s-=h,r+=h,i.length-=h),i.length))break e;i.length=0,i.mode=7;case 7:if(2048&i.flags){if(0===s)break e;for(h=0;x=n[r+h++],i.head&&x&&i.length<65536&&(i.head.name+=String.fromCharCode(x)),x&&h<s;);if(512&i.flags&&(i.check=N(i.check,n,h,r)),s-=h,r+=h,x)break e}else i.head&&(i.head.name=null);i.length=0,i.mode=8;case 8:if(4096&i.flags){if(0===s)break e;for(h=0;x=n[r+h++],i.head&&x&&i.length<65536&&(i.head.comment+=String.fromCharCode(x)),x&&h<s;);if(512&i.flags&&(i.check=N(i.check,n,h,r)),s-=h,r+=h,x)break e}else i.head&&(i.head.comment=null);i.mode=9;case 9:if(512&i.flags){for(;d<16;){if(0===s)break e;s--,l+=n[r++]<<d,d+=8}if(l!==(65535&i.check)){e.msg="header crc mismatch",i.mode=30;break}d=l=0}i.head&&(i.head.hcrc=i.flags>>9&1,i.head.done=!0),e.adler=i.check=0,i.mode=12;break;case 10:for(;d<32;){if(0===s)break e;s--,l+=n[r++]<<d,d+=8}e.adler=i.check=L(l),d=l=0,i.mode=11;case 11:if(0===i.havedict)return e.next_out=o,e.avail_out=f,e.next_in=r,e.avail_in=s,i.hold=l,i.bits=d,2;e.adler=i.check=1,i.mode=12;case 12:if(5===t||6===t)break e;case 13:if(i.last){l>>>=7&d,d-=7&d,i.mode=27;break}for(;d<3;){if(0===s)break e;s--,l+=n[r++]<<d,d+=8}switch(i.last=1&l,d-=1,3&(l>>>=1)){case 0:i.mode=14;break;case 1:if(H(i),i.mode=20,6!==t)break;l>>>=2,d-=2;break e;case 2:i.mode=17;break;case 3:e.msg="invalid block type",i.mode=30}l>>>=2,d-=2;break;case 14:for(l>>>=7&d,d-=7&d;d<32;){if(0===s)break e;s--,l+=n[r++]<<d,d+=8}if((65535&l)!=(l>>>16^65535)){e.msg="invalid stored block lengths",i.mode=30;break}if(i.length=65535&l,d=l=0,i.mode=15,6===t)break e;case 15:i.mode=16;case 16:if(h=i.length){if(s<h&&(h=s),f<h&&(h=f),0===h)break e;z.arraySet(a,n,r,h,o),s-=h,r+=h,f-=h,o+=h,i.length-=h;break}i.mode=12;break;case 17:for(;d<14;){if(0===s)break e;s--,l+=n[r++]<<d,d+=8}if(i.nlen=257+(31&l),l>>>=5,d-=5,i.ndist=1+(31&l),l>>>=5,d-=5,i.ncode=4+(15&l),l>>>=4,d-=4,286<i.nlen||30<i.ndist){e.msg="too many length or distance symbols",i.mode=30;break}i.have=0,i.mode=18;case 18:for(;i.have<i.ncode;){for(;d<3;){if(0===s)break e;s--,l+=n[r++]<<d,d+=8}i.lens[A[i.have++]]=7&l,l>>>=3,d-=3}for(;i.have<19;)i.lens[A[i.have++]]=0;if(i.lencode=i.lendyn,i.lenbits=7,S={bits:i.lenbits},y=C(0,i.lens,0,19,i.lencode,0,i.work,S),i.lenbits=S.bits,y){e.msg="invalid code lengths set",i.mode=30;break}i.have=0,i.mode=19;case 19:for(;i.have<i.nlen+i.ndist;){for(;k=(Z=i.lencode[l&(1<<i.lenbits)-1])>>>16&255,_=65535&Z,!((w=Z>>>24)<=d);){if(0===s)break e;s--,l+=n[r++]<<d,d+=8}if(_<16)l>>>=w,d-=w,i.lens[i.have++]=_;else{if(16===_){for(E=w+2;d<E;){if(0===s)break e;s--,l+=n[r++]<<d,d+=8}if(l>>>=w,d-=w,0===i.have){e.msg="invalid bit length repeat",i.mode=30;break}x=i.lens[i.have-1],h=3+(3&l),l>>>=2,d-=2}else if(17===_){for(E=w+3;d<E;){if(0===s)break e;s--,l+=n[r++]<<d,d+=8}d-=w,x=0,h=3+(7&(l>>>=w)),l>>>=3,d-=3}else{for(E=w+7;d<E;){if(0===s)break e;s--,l+=n[r++]<<d,d+=8}d-=w,x=0,h=11+(127&(l>>>=w)),l>>>=7,d-=7}if(i.have+h>i.nlen+i.ndist){e.msg="invalid bit length repeat",i.mode=30;break}for(;h--;)i.lens[i.have++]=x}}if(30===i.mode)break;if(0===i.lens[256]){e.msg="invalid code -- missing end-of-block",i.mode=30;break}if(i.lenbits=9,S={bits:i.lenbits},y=C(I,i.lens,0,i.nlen,i.lencode,0,i.work,S),i.lenbits=S.bits,y){e.msg="invalid literal/lengths set",i.mode=30;break}if(i.distbits=6,i.distcode=i.distdyn,S={bits:i.distbits},y=C(D,i.lens,i.nlen,i.ndist,i.distcode,0,i.work,S),i.distbits=S.bits,y){e.msg="invalid distances set",i.mode=30;break}if(i.mode=20,6===t)break e;case 20:i.mode=21;case 21:if(6<=s&&258<=f){e.next_out=o,e.avail_out=f,e.next_in=r,e.avail_in=s,i.hold=l,i.bits=d,O(e,u),o=e.next_out,a=e.output,f=e.avail_out,r=e.next_in,n=e.input,s=e.avail_in,l=i.hold,d=i.bits,12===i.mode&&(i.back=-1);break}for(i.back=0;k=(Z=i.lencode[l&(1<<i.lenbits)-1])>>>16&255,_=65535&Z,!((w=Z>>>24)<=d);){if(0===s)break e;s--,l+=n[r++]<<d,d+=8}if(k&&0==(240&k)){for(g=w,v=k,p=_;k=(Z=i.lencode[p+((l&(1<<g+v)-1)>>g)])>>>16&255,_=65535&Z,!(g+(w=Z>>>24)<=d);){if(0===s)break e;s--,l+=n[r++]<<d,d+=8}l>>>=g,d-=g,i.back+=g}if(l>>>=w,d-=w,i.back+=w,i.length=_,0===k){i.mode=26;break}if(32&k){i.back=-1,i.mode=12;break}if(64&k){e.msg="invalid literal/length code",i.mode=30;break}i.extra=15&k,i.mode=22;case 22:if(i.extra){for(E=i.extra;d<E;){if(0===s)break e;s--,l+=n[r++]<<d,d+=8}i.length+=l&(1<<i.extra)-1,l>>>=i.extra,d-=i.extra,i.back+=i.extra}i.was=i.length,i.mode=23;case 23:for(;k=(Z=i.distcode[l&(1<<i.distbits)-1])>>>16&255,_=65535&Z,!((w=Z>>>24)<=d);){if(0===s)break e;s--,l+=n[r++]<<d,d+=8}if(0==(240&k)){for(g=w,v=k,p=_;k=(Z=i.distcode[p+((l&(1<<g+v)-1)>>g)])>>>16&255,_=65535&Z,!(g+(w=Z>>>24)<=d);){if(0===s)break e;s--,l+=n[r++]<<d,d+=8}l>>>=g,d-=g,i.back+=g}if(l>>>=w,d-=w,i.back+=w,64&k){e.msg="invalid distance code",i.mode=30;break}i.offset=_,i.extra=15&k,i.mode=24;case 24:if(i.extra){for(E=i.extra;d<E;){if(0===s)break e;s--,l+=n[r++]<<d,d+=8}i.offset+=l&(1<<i.extra)-1,l>>>=i.extra,d-=i.extra,i.back+=i.extra}if(i.offset>i.dmax){e.msg="invalid distance too far back",i.mode=30;break}i.mode=25;case 25:if(0===f)break e;if(h=u-f,i.offset>h){if((h=i.offset-h)>i.whave&&i.sane){e.msg="invalid distance too far back",i.mode=30;break}h>i.wnext?(h-=i.wnext,b=i.wsize-h):b=i.wnext-h,h>i.length&&(h=i.length),m=i.window}else m=a,b=o-i.offset,h=i.length;for(f<h&&(h=f),f-=h,i.length-=h;a[o++]=m[b++],--h;);0===i.length&&(i.mode=21);break;case 26:if(0===f)break e;a[o++]=i.length,f--,i.mode=21;break;case 27:if(i.wrap){for(;d<32;){if(0===s)break e;s--,l|=n[r++]<<d,d+=8}if(u-=f,e.total_out+=u,i.total+=u,u&&(e.adler=i.check=i.flags?N(i.check,a,u,o-u):R(i.check,a,u,o-u)),u=f,(i.flags?l:L(l))!==i.check){e.msg="incorrect data check",i.mode=30;break}d=l=0}i.mode=28;case 28:if(i.wrap&&i.flags){for(;d<32;){if(0===s)break e;s--,l+=n[r++]<<d,d+=8}if(l!==(4294967295&i.total)){e.msg="incorrect length check",i.mode=30;break}d=l=0}i.mode=29;case 29:y=1;break e;case 30:y=-3;break e;case 31:return-4;case 32:default:return U}return e.next_out=o,e.avail_out=f,e.next_in=r,e.avail_in=s,i.hold=l,i.bits=d,(i.wsize||u!==e.avail_out&&i.mode<30&&(i.mode<27||4!==t))&&j(e,e.output,e.next_out,u-e.avail_out)?(i.mode=31,-4):(c-=e.avail_in,u-=e.avail_out,e.total_in+=c,e.total_out+=u,i.total+=u,i.wrap&&u&&(e.adler=i.check=i.flags?N(i.check,a,u,e.next_out-u):R(i.check,a,u,e.next_out-u)),e.data_type=i.bits+(i.last?64:0)+(12===i.mode?128:0)+(20===i.mode||15===i.mode?256:0),(0===c&&0===u||4===t)&&y===T&&(y=-5),y)},i.inflateEnd=function(e){if(!e||!e.state)return U;var t=e.state;return t.window&&(t.window=null),e.state=null,T},i.inflateGetHeader=function(e,t){var i;return e&&e.state?0==(2&(i=e.state).wrap)?U:((i.head=t).done=!1,T):U},i.inflateSetDictionary=function(e,t){var i,n=t.length;return e&&e.state?0!==(i=e.state).wrap&&11!==i.mode?U:11===i.mode&&R(1,t,n,0)!==i.check?-3:j(e,t,n,n)?(i.mode=31,-4):(i.havedict=1,T):U},i.inflateInfo="pako inflate (from Nodeca project)"},{"../utils/common":1,"./adler32":3,"./crc32":5,"./inffast":7,"./inftrees":9}],9:[function(e,t,i){"use strict";var I=e("../utils/common"),D=[3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258,0,0],T=[16,16,16,16,16,16,16,16,17,17,17,17,18,18,18,18,19,19,19,19,20,20,20,20,21,21,21,21,16,72,78],U=[1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577,0,0],F=[16,16,16,16,17,17,18,18,19,19,20,20,21,21,22,22,23,23,24,24,25,25,26,26,27,27,28,28,29,29,64,64];t.exports=function(e,t,i,n,a,r,o,s){var f,l,d,c,u,h,b,m,w,k=s.bits,_=0,g=0,v=0,p=0,x=0,y=0,S=0,E=0,Z=0,B=0,A=null,z=0,R=new I.Buf16(16),N=new I.Buf16(16),O=null,C=0;for(_=0;_<=15;_++)R[_]=0;for(g=0;g<n;g++)R[t[i+g]]++;for(x=k,p=15;1<=p&&0===R[p];p--);if(p<x&&(x=p),0===p)return a[r++]=20971520,a[r++]=20971520,s.bits=1,0;for(v=1;v<p&&0===R[v];v++);for(x<v&&(x=v),_=E=1;_<=15;_++)if(E<<=1,(E-=R[_])<0)return-1;if(0<E&&(0===e||1!==p))return-1;for(N[1]=0,_=1;_<15;_++)N[_+1]=N[_]+R[_];for(g=0;g<n;g++)0!==t[i+g]&&(o[N[t[i+g]]++]=g);if(0===e?(A=O=o,h=19):1===e?(A=D,z-=257,O=T,C-=257,h=256):(A=U,O=F,h=-1),_=v,u=r,S=g=B=0,d=-1,c=(Z=1<<(y=x))-1,1===e&&852<Z||2===e&&592<Z)return 1;for(;;){for(b=_-S,o[g]<h?(m=0,w=o[g]):o[g]>h?(m=O[C+o[g]],w=A[z+o[g]]):(m=96,w=0),f=1<<_-S,v=l=1<<y;a[u+(B>>S)+(l-=f)]=b<<24|m<<16|w|0,0!==l;);for(f=1<<_-1;B&f;)f>>=1;if(0!==f?(B&=f-1,B+=f):B=0,g++,0==--R[_]){if(_===p)break;_=t[i+o[g]]}if(x<_&&(B&c)!==d){for(0===S&&(S=x),u+=v,E=1<<(y=_-S);y+S<p&&!((E-=R[y+S])<=0);)y++,E<<=1;if(Z+=1<<y,1===e&&852<Z||2===e&&592<Z)return 1;a[d=B&c]=x<<24|y<<16|u-r|0}}return 0!==B&&(a[u+B]=_-S<<24|64<<16|0),s.bits=x,0}},{"../utils/common":1}],10:[function(e,t,i){"use strict";t.exports={2:"need dictionary",1:"stream end",0:"","-1":"file error","-2":"stream error","-3":"data error","-4":"insufficient memory","-5":"buffer error","-6":"incompatible version"}},{}],11:[function(e,t,i){"use strict";t.exports=function(){this.input=null,this.next_in=0,this.avail_in=0,this.total_in=0,this.output=null,this.next_out=0,this.avail_out=0,this.total_out=0,this.msg="",this.state=null,this.data_type=2,this.adler=0}},{}],"/lib/inflate.js":[function(e,t,i){"use strict";var c=e("./zlib/inflate"),u=e("./utils/common"),h=e("./utils/strings"),b=e("./zlib/constants"),n=e("./zlib/messages"),a=e("./zlib/zstream"),r=e("./zlib/gzheader"),m=Object.prototype.toString;function o(e){if(!(this instanceof o))return new o(e);this.options=u.assign({chunkSize:16384,windowBits:0,to:""},e||{});var t=this.options;t.raw&&0<=t.windowBits&&t.windowBits<16&&(t.windowBits=-t.windowBits,0===t.windowBits&&(t.windowBits=-15)),!(0<=t.windowBits&&t.windowBits<16)||e&&e.windowBits||(t.windowBits+=32),15<t.windowBits&&t.windowBits<48&&0==(15&t.windowBits)&&(t.windowBits|=15),this.err=0,this.msg="",this.ended=!1,this.chunks=[],this.strm=new a,this.strm.avail_out=0;var i=c.inflateInit2(this.strm,t.windowBits);if(i!==b.Z_OK)throw new Error(n[i]);if(this.header=new r,c.inflateGetHeader(this.strm,this.header),t.dictionary&&("string"==typeof t.dictionary?t.dictionary=h.string2buf(t.dictionary):"[object ArrayBuffer]"===m.call(t.dictionary)&&(t.dictionary=new Uint8Array(t.dictionary)),t.raw&&(i=c.inflateSetDictionary(this.strm,t.dictionary))!==b.Z_OK))throw new Error(n[i])}function s(e,t){var i=new o(t);if(i.push(e,!0),i.err)throw i.msg||n[i.err];return i.result}o.prototype.push=function(e,t){var i,n,a,r,o,s=this.strm,f=this.options.chunkSize,l=this.options.dictionary,d=!1;if(this.ended)return!1;n=t===~~t?t:!0===t?b.Z_FINISH:b.Z_NO_FLUSH,"string"==typeof e?s.input=h.binstring2buf(e):"[object ArrayBuffer]"===m.call(e)?s.input=new Uint8Array(e):s.input=e,s.next_in=0,s.avail_in=s.input.length;do{if(0===s.avail_out&&(s.output=new u.Buf8(f),s.next_out=0,s.avail_out=f),(i=c.inflate(s,b.Z_NO_FLUSH))===b.Z_NEED_DICT&&l&&(i=c.inflateSetDictionary(this.strm,l)),i===b.Z_BUF_ERROR&&!0===d&&(i=b.Z_OK,d=!1),i!==b.Z_STREAM_END&&i!==b.Z_OK)return this.onEnd(i),!(this.ended=!0);s.next_out&&(0!==s.avail_out&&i!==b.Z_STREAM_END&&(0!==s.avail_in||n!==b.Z_FINISH&&n!==b.Z_SYNC_FLUSH)||("string"===this.options.to?(a=h.utf8border(s.output,s.next_out),r=s.next_out-a,o=h.buf2string(s.output,a),s.next_out=r,s.avail_out=f-r,r&&u.arraySet(s.output,s.output,a,r,0),this.onData(o)):this.onData(u.shrinkBuf(s.output,s.next_out)))),0===s.avail_in&&0===s.avail_out&&(d=!0)}while((0<s.avail_in||0===s.avail_out)&&i!==b.Z_STREAM_END);return i===b.Z_STREAM_END&&(n=b.Z_FINISH),n===b.Z_FINISH?(i=c.inflateEnd(this.strm),this.onEnd(i),this.ended=!0,i===b.Z_OK):n!==b.Z_SYNC_FLUSH||(this.onEnd(b.Z_OK),!(s.avail_out=0))},o.prototype.onData=function(e){this.chunks.push(e)},o.prototype.onEnd=function(e){e===b.Z_OK&&("string"===this.options.to?this.result=this.chunks.join(""):this.result=u.flattenChunks(this.chunks)),this.chunks=[],this.err=e,this.msg=this.strm.msg},i.Inflate=o,i.inflate=s,i.inflateRaw=function(e,t){return(t=t||{}).raw=!0,s(e,t)},i.ungzip=s},{"./utils/common":1,"./utils/strings":2,"./zlib/constants":4,"./zlib/gzheader":6,"./zlib/inflate":8,"./zlib/messages":10,"./zlib/zstream":11}]},{},[])("/lib/inflate.js")});

return module.exports; })();

function permute(value, positions) {
  let out = 0n;
  for (const position of positions) out = (out << 1n) | ((value >> BigInt(position)) & 1n);
  return out;
}

function swapWords(value) {
  let result = 0n;
  for (let group = 0; group < 2; group++) {
    const word = (value >> BigInt((1 - group) * 32)) & 0xffffffffn;
    let reverse = 0n;
    for (let i = 0; i < 4; i++) reverse = (reverse << 8n) | ((word >> BigInt(i * 8)) & 255n);
    result = (result << 32n) | reverse;
  }
  return result;
}

function keysFor(text) {
  let key = 0n;
  for (let i = 0; i < 8; i++) key = (key << 8n) | BigInt(text.charCodeAt(i));
  const bits = permute(swapWords(key), qrcPC1);
  let left = Number(bits >> 28n), right = Number(bits & 0xfffffffn);
  return qrcRotations.map(shift => {
    left = ((left << shift) | (left >>> (28 - shift))) & 0xfffffff;
    right = ((right << shift) | (right >>> (28 - shift))) & 0xfffffff;
    let subkey = 0n;
    for (let j = 0; j < 48; j++) {
      const pos = qrcPC2[j];
      const bit = j < 24 ? (left >>> (pos - 28)) & 1 : pos > 0 ? (right >>> (pos - 1)) & 1 : 0;
      subkey = (subkey << 1n) | BigInt(bit);
    }
    return subkey;
  });
}

const qrcKeys = ['!@#)(*$%', '123ZXC!@', '!@#)(NHL'].map(keysFor);

function cryptBlock(block, keys, decrypt) {
  const value = permute(block, qrcIP);
  let left = value >> 32n, right = value & 0xffffffffn;
  for (let round = 0; round < 16; round++) {
    const x = permute(right, qrcExpansion) ^ keys[decrypt ? 15 - round : round];
    let substituted = 0n;
    for (let box = 0; box < 8; box++) {
      const part = Number((x >> BigInt(42 - 6 * box)) & 63n);
      const row = ((part & 32) >> 4) | (part & 1), column = (part >> 1) & 15;
      substituted = (substituted << 4n) | BigInt(qrcSBoxes[box][row][column]);
    }
    const next = left ^ permute(substituted, qrcP);
    left = right;
    right = next;
  }
  return permute((right << 32n) | left, qrcFP);
}

export function decodeQRC(input) {
  if (input === '') return '';
  if (typeof input !== 'string' || !/^(?:[0-9a-fA-F]{16})+$/.test(input)) throw new Error('Malformed QRC ciphertext');
  const bytes = new Uint8Array(input.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(input.slice(i * 2, i * 2 + 2), 16);
  for (let i = 0; i < bytes.length; i += 8) {
    let block = 0n;
    for (let j = 0; j < 8; j++) block = (block << 8n) | BigInt(bytes[i + j]);
    block = swapWords(block);
    block = cryptBlock(block, qrcKeys[2], true);
    block = cryptBlock(block, qrcKeys[1], false);
    block = swapWords(cryptBlock(block, qrcKeys[0], true));
    for (let j = 7; j >= 0; j--) { bytes[i + j] = Number(block & 255n); block >>= 8n; }
  }
  const inflater = new qrcPako.Inflate();
  if (!inflater.push(bytes, false) || inflater.err || !inflater.ended) throw new Error('Invalid QRC compression');
  return new TextDecoder('utf-8', { fatal: true }).decode(inflater.result);
}
