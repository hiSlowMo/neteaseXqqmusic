import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore } from '../src/providers/qqmusic/session.js';

const old = { musicid: '18446744073709551615', musickey: 'synthetic-old', loginType: 1, musickeyCreateTime: 1, keyExpiresIn: 20, refresh_key: 'fake-refresh', device: {} };
const fresh = { ...old, musickey: 'synthetic-renewed', musickeyCreateTime: 2000, keyExpiresIn: 10000 };
const reject = () => Object.assign(new Error('fixture auth rejection'), { qqGlobalCode: 0, qqCode: 104400 });
function setup(refresh, initial = old) {
  const storage = new Map([['qqmusic.auth.v1', structuredClone(initial)]]);
  const api = createSessionStore({ storage: { get: k => structuredClone(storage.get(k)), set: (k, v) => storage.set(k, structuredClone(v)), remove: k => storage.delete(k) }, refresh, now: () => 2000000 });
  return { api, storage };
}

// Simultaneous requests after restart must share one refresh before issuing protected reads.
test('concurrent expired reads coalesce refresh and retain string account identity', async () => {
  let release, count = 0;
  const { api } = setup(async s => { assert.equal(s.musicid, old.musicid); count++; return new Promise(resolve => { release = () => resolve(fresh); }); });
  const requests = [api.run(s => s.musickey), api.run(s => s.musickey), api.ready()];
  release();
  const [a, b, restored] = await Promise.all(requests);
  assert.equal(count, 1);
  assert.equal(a, fresh.musickey); assert.equal(b, fresh.musickey);
  assert.equal(restored.musicid, '18446744073709551615');
});

// A key can be rejected before expiry; only explicit authentication codes renew it once.
test('explicit rejection renews once and missing URL does not renew', async () => {
  let refreshes = 0, calls = 0;
  const { api } = setup(async () => { refreshes++; return fresh; }, { ...old, musickeyCreateTime: 2000, keyExpiresIn: 5000 });
  assert.equal(await api.run(s => { if (++calls === 1) throw reject(); return s.musickey; }), fresh.musickey);
  assert.equal(refreshes, 1); assert.equal(calls, 2);
  await assert.rejects(api.run(() => { throw Object.assign(new Error('no stream'), { code: 'unavailable' }); }));
  assert.equal(refreshes, 1);
});

// Refresh responses that arrive after logout or a newer sign-in cannot publish their old credentials.
test('logout and newer login win over a pending renewal', async () => {
  for (const action of ['logout', 'login']) {
    let finish;
    const { api, storage } = setup(() => new Promise(resolve => { finish = resolve; }));
    const result = api.ready();
    if (action === 'logout') api.clear();
    else api.set({ ...fresh, musicid: '42', musickey: 'synthetic-new-login' });
    finish(fresh);
    if (action === 'logout') {
      await assert.rejects(result, { code: 'signIn' });
      assert.equal(storage.has('qqmusic.auth.v1'), false);
    } else {
      assert.equal((await result).musicid, '42');
      assert.equal(storage.get('qqmusic.auth.v1').musickey, 'synthetic-new-login');
    }
  }
});

// An expired nonrefreshable account cannot silently issue an anonymous playback request.
test('expired QQ login stops before the protected request', async () => {
  const { api } = setup(async () => { throw new Error('unexpected refresh'); }, { ...old, loginType: 2 });
  let called = false;
  await assert.rejects(api.run(() => { called = true; }), { code: 'signIn' });
  assert.equal(called, false);
});

// An account response after sign-out must not become a success for the previous user.
test('late reads and late login validation cannot resurrect a session', async () => {
  let finish;
  const { api } = setup(async () => fresh, fresh);
  const expected = api.version();
  const pending = api.run(() => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  api.clear();
  finish('old profile');
  await assert.rejects(pending, { code: 'signIn' });
  assert.throws(() => api.set(fresh, expected), { code: 'signIn' });
});

// Successful in-flight reads remain usable if another read renewed the same account.
test('same-account renewal does not invalidate a successful parallel read', async () => {
  let finish;
  const { api } = setup(async () => fresh, { ...fresh, musickey: 'synthetic-initial' });
  const pending = api.run(() => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  let first = true;
  await api.run(() => { if (first) { first = false; throw reject(); } return true; });
  finish('profile');
  assert.equal(await pending, 'profile');
});
