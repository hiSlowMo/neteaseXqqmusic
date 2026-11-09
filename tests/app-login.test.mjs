import test from 'node:test';
import assert from 'node:assert/strict';
import { qqMusicAppSignIn, appSession, appHelperPath, entropyRandom } from '../src/providers/qqmusic/auth-app.js';
import { parseQQLoginMethod } from '../src/providers/qqmusic/login-method.js';
import { providerHost } from '../src/host.js';

// New App mode must coexist with QQ and WeChat, and loading a host must not spawn anything.
test('App login mode and lazy host wrapper preserve existing modes', () => {
  for (const value of ['', 'qq', 'QQ']) assert.equal(parseQQLoginMethod(value), 'qq');
  for (const value of ['wechat', '微信']) assert.equal(parseQQLoginMethod(value), 'wechat');
  for (const value of ['qqmusic', 'app', 'QQ音乐']) assert.equal(parseQQLoginMethod(value), 'qqmusic');
  assert.throws(() => parseQQLoginMethod('typo'), { code: 'setup' });
  const previous = globalThis.host;
  try {
    delete globalThis.host;
    assert.doesNotThrow(() => providerHost('qqmusic'));
  } finally { if (previous === undefined) delete globalThis.host; else globalThis.host = previous; }
  assert.equal(appHelperPath('darwin', 'arm64'), 'bin/qqmusic-login-darwin-arm64');
  assert.throws(() => appHelperPath('../../shell', 'arm64'), { code: 'setup' });
});

function fixture(events = [], extra = {}) {
  const prompts = [], requests = [], commands = [];
  let killed = 0, closed = 0, spawned = 0;
  const queue = [{ type: 'ready', entropy: '42'.repeat(4096) }, { type: 'subscribed' }, ...events];
  const child = {
    readLine: async () => queue.length ? JSON.stringify(queue.shift()) : null,
    write: line => commands.push(JSON.parse(line)),
    closeStdin: () => closed++, kill: () => killed++,
  };
  const final = { musicid: 12345, musickey: 'FINAL_SYNTHETIC_KEY', loginType: 2, refresh_key: 'SYNTHETIC_REFRESH' };
  const deps = {
    platform: 'darwin', arch: 'arm64', spawn: async (path, args) => { spawned++; assert.equal(path, appHelperPath('darwin', 'arm64')); assert.deepEqual(args, []); return child; },
    prepareDevice: async ({ randomBytes }) => { assert.deepEqual([...randomBytes(2)], [66, 66]); return { qimei36: 'synthetic-device', uid: 'synthetic-uid', sid: 'synthetic-sid' }; },
    deviceComm: device => ({ ct: 11, cv: 14090008, QIMEI36: device.qimei36, uid: device.uid, sid: device.sid }),
    decodeQR: async bytes => { assert.equal(bytes[0], 137); return 'https://example.invalid/synthetic-qr'; },
    prompt: async value => prompts.push(value),
    fetch: async (url, options) => {
      assert.equal(url, 'https://u.y.qq.com/cgi-bin/musicu.fcg');
      const body = JSON.parse(options.body); requests.push(body);
      return { status: 200, json: async () => ({ code: 0, req_0: { code: 0, data: body.req_0.method === 'CreateQRCode' ? { qrcodeID: 'synthetic-qr-id', qrcode: 'data:image/png;base64,iVBORw0KGgo=' } : final } }) };
    }, ...extra,
  };
  return { deps, queue, child, final, prompts, commands, requests, stats: () => ({ killed, closed, spawned }) };
}
const cookies = () => ({ type: 'cookies', data: { cookies: { qqmusic_uin: { value: '12345' }, qqmusic_key: { value: 'INTERMEDIATE_SYNTHETIC_TOKEN' } } } });

// A cookie message is intermediate authorization, never the session that gets saved.
test('App QR waits for subscription, exchanges token and preserves returned credential type', async () => {
  const f = fixture([{ type: 'scanned' }, cookies()]);
  const session = await qqMusicAppSignIn(f.deps);
  assert.equal(session.musickey, 'FINAL_SYNTHETIC_KEY');
  assert.equal(session.loginType, 2);
  assert.equal(session.musicid, '12345');
  assert.equal(session.device.clientVersion, 20090008);
  assert.equal(f.prompts.length, 2);
  assert.match(f.prompts[0].text, /QQ 音乐 App/);
  assert.deepEqual(f.commands[0], { command: 'subscribe', qrcodeID: 'synthetic-qr-id', timeoutMs: 180000 });
  const [create, login] = f.requests;
  assert.equal(create.comm.ct, '23'); assert.equal(create.comm.cv, '0');
  assert.equal(create.comm.QIMEI36, 'synthetic-device');
  assert.deepEqual(create.req_0.param, { tmeAppID: 'qqmusic', ct: 11, cv: 20090008 });
  assert.equal(login.comm.tmeLoginType, '6');
  assert.deepEqual(login.req_0.param, { musicid: 12345, qrCodeID: 'synthetic-qr-id', token: 'INTERMEDIATE_SYNTHETIC_TOKEN' });
  assert.deepEqual(f.stats(), { killed: 1, closed: 1, spawned: 1 });
});

// Expiry, refusal, malformed messages and helper failure must always release the process.
test('terminal and malformed helper events clean up without exposing payloads', async () => {
  for (const event of [{ type: 'timeout' }, { type: 'canceled' }, { type: 'error', message: 'PRIVATE_TOKEN_DO_NOT_EXPOSE' }, { type: 'unknown' }, { type: 'cookies', data: { cookies: {} } }]) {
    const f = fixture([event]);
    await assert.rejects(qqMusicAppSignIn(f.deps), e => e.code === 'signIn' && !e.message.includes('PRIVATE_TOKEN'));
    assert.equal(f.requests.length, 1);
    assert.equal(f.stats().killed, 1);
  }
  for (const line of ['{"invalid":"PRIVATE_TOKEN', 'x'.repeat(65537)]) {
    const f = fixture([cookies()]);
    f.child.readLine = async () => line;
    await assert.rejects(qqMusicAppSignIn(f.deps), e => !e.message.includes('PRIVATE_TOKEN'));
    assert.equal(f.stats().killed, 1);
  }
});

// Cancel/new login while waiting must stop the child and reject any later credentials.
test('cancellation and changed generation abort in-flight App login', async () => {
  const controller = new AbortController();
  const f = fixture([], { signal: controller.signal });
  let notify;
  const waiting = new Promise(resolve => { notify = resolve; });
  f.child.readLine = () => { notify(); return new Promise(() => {}); };
  const pending = qqMusicAppSignIn(f.deps);
  await waiting;
  controller.abort();
  await assert.rejects(pending, { code: 'signIn' });
  assert.equal(f.stats().killed >= 1, true);
  const changed = fixture([cookies()], { isCurrent: () => false });
  await assert.rejects(qqMusicAppSignIn(changed.deps), { code: 'signIn' });
  assert.equal(changed.requests.length, 0);
});

// Missing permission must not fall back to a different scanner or disclose OS error details.
test('spawn refusal is actionable and keeps OS errors private', async () => {
  const f = fixture([], { spawn: () => { throw new Error('PRIVATE_LOCAL_PATH'); } });
  await assert.rejects(qqMusicAppSignIn(f.deps), e => e.code === 'setup' && e.message.includes('MyGo') && !e.message.includes('PRIVATE_LOCAL_PATH'));
  assert.equal(f.requests.length, 0);
});

// Explicit unsupported types must never be relabelled as QQ or the exchange selector 6.
test('session parser rejects unknown types, mismatched IDs and expired credentials', () => {
  const data = { musicid: '12345', musickey: 'W_X_SYNTHETIC' };
  assert.equal(appSession(data, {}, '12345').loginType, 1);
  assert.equal(appSession({ ...data, musickey: 'SYNTHETIC' }, {}, '12345').loginType, 2);
  for (const changed of [{ loginType: 6 }, { musicid: '999' }, { musickey: 'x;injection' }, { musickeyCreateTime: 1, keyExpiresIn: 1 }]) assert.throws(() => appSession({ ...data, ...changed }, {}, '12345'), { code: 'signIn' });
  const random = entropyRandom('42'.repeat(4096));
  assert.equal(random(4096).length, 4096);
  assert.throws(() => random(1));
  assert.throws(() => entropyRandom('not-entropy'));
});

// Malformed credentials and out-of-order messages must not complete login or reveal server data.
test('invalid final credentials and event order are rejected before any session is returned', async () => {
  for (const change of [{ loginType: 6 }, { musicid: '99999' }, { musickey: 'PRIVATE;COOKIE' }]) {
    const f = fixture([cookies()]); Object.assign(f.final, change);
    await assert.rejects(qqMusicAppSignIn(f.deps), e => e.code === 'signIn' && !e.message.includes('PRIVATE'));
    assert.equal(f.stats().killed, 1);
  }
  const early = fixture([cookies()]); early.queue.splice(1, 1);
  await assert.rejects(qqMusicAppSignIn(early.deps), { code: 'signIn' });
  assert.equal(early.requests.length, 1); assert.equal(early.prompts.length, 0);
  const entropy = fixture(); entropy.queue[0].entropy = 'invalid';
  await assert.rejects(qqMusicAppSignIn(entropy.deps), { code: 'signIn' });
  assert.equal(entropy.requests.length, 0); assert.equal(entropy.stats().killed, 1);
});

// Global expiry must stop a connected helper even if no terminal event arrives.
test('overall App login deadline aborts a stalled subscription', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  let subscribed;
  const shown = new Promise(resolve => { subscribed = resolve; });
  f.deps.prompt = async () => subscribed();
  const original = f.child.readLine;
  f.child.readLine = () => f.queue.length ? original() : new Promise(() => {});
  const pending = qqMusicAppSignIn(f.deps);
  await shown;
  t.mock.timers.tick(240000);
  await assert.rejects(pending, { code: 'signIn' });
  assert.equal(f.stats().killed, 1); assert.equal(f.stats().closed, 1);
});

// A broken helper must not leave the sign-in pending indefinitely.
test('startup deadline kills a silent helper', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.child.readLine = () => new Promise(() => {});
  const pending = qqMusicAppSignIn(f.deps);
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(8000);
  await assert.rejects(pending, { code: 'signIn' });
  assert.equal(f.stats().killed, 1);
});
