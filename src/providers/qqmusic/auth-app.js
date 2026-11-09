// SPDX-License-Identifier: AGPL-3.0-only
// QQ Music App protocol reference: L-1124/QQMusicApi, GPL-3.0-or-later.
// See THIRD_PARTY_NOTICES.md. MQTT transport stays in the bundled Go helper.
const API = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const VERSION = 20090008;
const MAX_LINE = 65536;
const supported = new Set(['darwin-arm64', 'darwin-amd64', 'linux-arm64', 'linux-amd64', 'windows-arm64', 'windows-amd64']);
const failure = (message, code = 'signIn') => Object.assign(new Error(message), { code, appLogin: true });

export function appHelperPath(platform, arch) {
  const target = `${platform}-${arch}`;
  if (!supported.has(target)) throw failure('此系统暂未提供 QQ 音乐 App 扫码程序，请选 qq 或 wechat 扫码', 'setup');
  return `bin/qqmusic-login-${target}${platform === 'windows' ? '.exe' : ''}`;
}

export function entropyRandom(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]{8192}$/.test(hex)) throw failure('扫码程序未提供有效随机数据');
  let offset = 0;
  return n => {
    if (!Number.isSafeInteger(n) || n < 0 || offset + n * 2 > hex.length) throw failure('扫码随机数据不足，请重新登录');
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = parseInt(hex.slice(offset + i * 2, offset + i * 2 + 2), 16);
    offset += n * 2;
    return bytes;
  };
}

function musicID(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw failure('QQ 音乐返回了无效账号标识');
  if (!['string', 'number'].includes(typeof value) || !/^\d{1,20}$/.test(String(value)) || !/[1-9]/.test(String(value))) throw failure('QQ 音乐返回了无效账号标识');
  return String(value);
}
function token(value) {
  if (typeof value !== 'string' || !value || value.length > 16384 || /[;\s\x00-\x1f\x7f]/.test(value)) throw failure('QQ 音乐未返回有效授权');
  return value;
}
export function appSession(data, device, expectedID, now = Date.now()) {
  const id = musicID(data?.str_musicid || data?.musicid);
  if (id !== expectedID) throw failure('QQ 音乐返回的账号不一致，请重试');
  const key = token(data.musickey);
  // 6 selects the exchange. The returned loginType is the session's type.
  const type = data.loginType == null ? (key.startsWith('W_X') ? 1 : 2) : Number(data.loginType);
  if (![1, 2].includes(type)) throw failure('QQ 音乐返回了暂不支持的账号类型，请选 qq 或 wechat 登录');
  const created = Number(data.musickeyCreateTime), expires = Number(data.keyExpiresIn);
  if (created > 0 && expires > 0 && now / 1000 >= created + expires) throw failure('QQ 音乐返回的登录已过期，请重新扫码');
  const result = { musicid: id, musickey: key, loginType: type, device };
  for (const field of ['openid', 'refresh_token', 'access_token', 'unionid', 'refresh_key', 'nick', 'logo', 'encryptUin', 'musickeyCreateTime', 'keyExpiresIn']) {
    if (data[field] !== undefined) result[field] = data[field];
  }
  return result;
}
function decodeImage(value) {
  if (typeof value !== 'string' || value.length > 2 * 1024 * 1024) throw failure('QQ 音乐未返回有效二维码');
  const encoded = value.slice(value.lastIndexOf(',') + 1);
  if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw failure('QQ 音乐未返回有效二维码');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = [];
  let bits = 0, buffer = 0;
  for (const c of encoded.replace(/=+$/, '')) {
    buffer = (buffer << 6) | alphabet.indexOf(c); bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 255); }
  }
  if (bytes.length < 8 || ![137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) throw failure('QQ 音乐返回的二维码不是 PNG');
  return new Uint8Array(bytes);
}

export async function qqMusicAppSignIn(deps) {
  const path = appHelperPath(deps.platform, deps.arch);
  if (deps.signal?.aborted) throw failure('QQ 音乐 App 登录已取消');
  let child;
  try { child = await deps.spawn(path, []); }
  catch { throw failure('无法启动内置扫码程序。请在 MyGo 的插件设置中允许此插件运行程序，并确认已安装完整 ZIP；也可选 qq 或 wechat 扫码', 'setup'); }
  const controller = new AbortController();
  let active = true, stopped = false, timeout, startupTimer, abort;
  const check = () => {
    if (!active || deps.signal?.aborted || deps.isCurrent && !deps.isCurrent()) throw failure('账号已改变或登录已取消，请重试');
  };
  const read = async () => {
    const line = await child.readLine(); check();
    if (typeof line !== 'string' || !line || line.length > MAX_LINE) throw failure('扫码程序已结束或返回无效消息，请重试');
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') throw new Error();
      return event;
    } catch { throw failure('扫码程序返回无效消息，请重试'); }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    active = false;
    controller.abort();
    try { child.write(JSON.stringify({ command: 'cancel' }) + '\n'); } catch { /* Already exited. */ }
    try { child.closeStdin(); } catch { /* Already exited. */ }
    try { child.kill(); } catch { /* Already exited. */ }
  };
  try {
    const interrupted = new Promise((_, reject) => {
      abort = () => { stop(); reject(failure('QQ 音乐 App 登录已取消')); };
      deps.signal?.addEventListener('abort', abort, { once: true });
      timeout = setTimeout(() => { stop(); reject(failure('QQ 音乐 App 登录超时，请重新扫码')); }, 240000);
    });
    const flow = (async () => {
      check();
      const ready = await Promise.race([read(), new Promise((_, reject) => {
        startupTimer = setTimeout(() => reject(failure('内置扫码程序启动超时，请检查安装包')), 8000);
      })]);
      clearTimeout(startupTimer);
      if (ready.type !== 'ready') throw failure('扫码程序无法启动，请重新安装完整 ZIP', 'setup');
      const randomBytes = entropyRandom(ready.entropy);
      const fetch = (url, options = {}) => { check(); return deps.fetch(url, { ...options, signal: controller.signal }); };
      const device = await deps.prepareDevice({ fetch, randomBytes }); check();
      device.clientVersion = VERSION;
      const comm = () => Object.fromEntries(Object.entries({ ...deps.deviceComm(device), ct: 11, cv: VERSION, v: VERSION }).map(([k, v]) => [k, String(v)]));
      const rpc = async (method, param, overrides = {}) => {
        const response = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': `QQMusic ${VERSION}(android 10)`, Referer: 'https://y.qq.com/' }, body: JSON.stringify({ comm: { ...comm(), ...overrides }, req_0: { module: 'music.login.LoginServer', method, param } }) }); check();
        if (!response || response.status < 200 || response.status >= 300) throw failure('QQ 音乐登录网络请求失败，请稍后重试');
        const body = await response.json(); check();
        if (body?.code !== 0 || body.req_0?.code !== 0 || body.req_0.subcode || !body.req_0.data || typeof body.req_0.data !== 'object') throw failure('QQ 音乐拒绝了登录请求，请重新扫码');
        return body.req_0.data;
      };
      const data = await rpc('CreateQRCode', { tmeAppID: 'qqmusic', ct: 11, cv: VERSION }, { ct: '23', cv: '0' });
      const id = data.qrcodeID;
      if (typeof id !== 'string' || !id || id.length > 512 || /[\x00-\x1f\x7f#+]/.test(id)) throw failure('QQ 音乐返回了无效二维码标识');
      const qr = await deps.decodeQR(decodeImage(data.qrcode)); check();
      if (typeof qr !== 'string' || !qr || qr.length > 8192) throw failure('无法识别 QQ 音乐 App 二维码，请重试');
      child.write(JSON.stringify({ command: 'subscribe', qrcodeID: id, timeoutMs: 180000 }) + '\n');
      // Show the QR after SUBACK, so an early scan cannot outrun subscription.
      let subscribed = false, scanned = false;
      while (true) {
        const event = await read();
        if (event.type === 'subscribed') {
          if (!subscribed) { subscribed = true; await deps.prompt({ qr, text: '请使用 QQ 音乐 App 扫码登录' }); check(); }
        } else if (event.type === 'scanned') {
          if (!subscribed) throw failure('扫码程序的消息顺序无效');
          if (!scanned) { scanned = true; await deps.prompt({ qr, text: '已扫码，请在 QQ 音乐 App 确认登录' }); check(); }
        } else if (event.type === 'cookies') {
          if (!subscribed) throw failure('扫码程序的消息顺序无效');
          const account = musicID(event.data?.cookies?.qqmusic_uin?.value);
          const key = token(event.data?.cookies?.qqmusic_key?.value);
          const numericID = Number(account);
          if (!Number.isSafeInteger(numericID)) throw failure('此账号标识暂不支持 App 扫码，请选 qq 或 wechat 登录');
          const final = await rpc('Login', { musicid: numericID, qrCodeID: id, token: key }, { tmeLoginType: '6' });
          return appSession(final, device, account);
        } else if (event.type === 'timeout') throw failure('QQ 音乐 App 二维码已过期，请重新扫码');
        else if (event.type === 'canceled') throw failure('已在 QQ 音乐 App 取消登录');
        else if (event.type === 'error') throw failure('QQ 音乐扫码连接失败，请检查网络后重试');
        else throw failure('扫码程序返回未知消息，请重新安装完整 ZIP');
      }
    })();
    return await Promise.race([flow, interrupted]);
  } catch (e) {
    if (e?.appLogin) throw e;
    throw failure('QQ 音乐 App 登录失败，请检查网络后重试');
  } finally {
    clearTimeout(timeout); clearTimeout(startupTimer);
    deps.signal?.removeEventListener('abort', abort);
    stop();
  }
}
