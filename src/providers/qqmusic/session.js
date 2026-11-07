// SPDX-License-Identifier: AGPL-3.0-only
export function sessionError(message = 'QQ 音乐登录已失效，请重新扫码') {
  return Object.assign(new Error(message), { code: 'signIn' });
}
export function rejected(e) {
  return e.qqGlobalCode === 0 && [1000, 104400, 104401].includes(e.qqCode);
}
export function validSession(value) {
  if (!value || typeof value !== 'object' || typeof value.musicid !== 'string' || !/^\d+$/.test(value.musicid) || !/[1-9]/.test(value.musicid)) return null;
  if (typeof value.musickey !== 'string' || !value.musickey || /[;\s]/.test(value.musickey) || ![1, 2].includes(value.loginType)) return null;
  return { ...value };
}
const same = (a, b) => a?.musicid === b?.musicid && a?.musickey === b?.musickey && a?.loginType === b?.loginType;

// Async fetches may finish after a new sign-in or sign-out. Only the session
// generation that started a refresh can publish it; concurrent reads share it.
export function createSessionStore({ storage, refresh, now = () => Date.now() }) {
  const key = 'qqmusic.auth.v1';
  let epoch = 0;
  let loginEpoch = 0;
  let refreshing = null;
  const read = () => validSession(storage.get(key));
  const snapshot = () => ({ session: read(), epoch, loginEpoch });
  const sameAccount = s => s.loginEpoch === loginEpoch && s.session?.musicid === read()?.musicid;
  const unchanged = s => s.epoch === epoch && same(s.session, read());
  const expired = s => s && Number(s.musickeyCreateTime) > 0 && Number(s.keyExpiresIn) > 0 && now() / 1000 >= Number(s.musickeyCreateTime) + Number(s.keyExpiresIn) - 30;
  function set(value, expected = epoch, renewal = false) {
    const s = validSession(value);
    if (!s) throw new Error('QQ 音乐返回了无效登录信息');
    if (expected !== epoch) throw sessionError('账号已改变，请重试');
    storage.set(key, s);
    epoch++;
    if (!renewal) loginEpoch++;
    return s;
  }
  function clear() { storage.remove(key); epoch++; loginEpoch++; }
  async function renew(started) {
    if (!unchanged(started)) {
      const current = snapshot();
      if (!current.session) throw sessionError();
      return current;
    }
    if (refreshing && refreshing.epoch === started.epoch) return refreshing.promise;
    const previous = started.session;
    if (!previous || previous.loginType !== 1 || !previous.device || !(previous.refresh_key || previous.refresh_token)) throw sessionError();
    const promise = (async () => {
      let next;
      try { next = await refresh(previous); }
      catch (e) {
        if (!unchanged(started)) {
          const current = snapshot();
          if (!current.session) throw sessionError();
          return current;
        }
        if (rejected(e)) throw sessionError();
        throw e;
      }
      if (!unchanged(started)) {
        const current = snapshot();
        if (!current.session) throw sessionError();
        return current;
      }
      set(next, started.epoch, true);
      return snapshot();
    })();
    refreshing = { epoch: started.epoch, promise };
    try { return await promise; }
    finally { if (refreshing?.promise === promise) refreshing = null; }
  }
  async function readySnapshot() {
    const started = snapshot();
    return expired(started.session) ? renew(started) : started;
  }
  async function run(fn, { anonymous = true, retry = true } = {}) {
    let started = await readySnapshot();
    if (!started.session && !anonymous) throw sessionError('请先扫码登录 QQ 音乐');
    try {
      const value = await fn(started.session);
      if (!sameAccount(started)) throw sessionError('账号已改变，请重试');
      return value;
    } catch (e) {
      if (!retry || !started.session || !rejected(e)) throw e;
      started = await renew(started);
      const value = await fn(started.session);
      if (!sameAccount(started)) throw sessionError('账号已改变，请重试');
      return value;
    }
  }
  return { read, set, clear, run, version: () => epoch, ready: async () => (await readySnapshot()).session };
}
