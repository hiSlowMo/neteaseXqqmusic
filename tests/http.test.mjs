import test from 'node:test';
import assert from 'node:assert/strict';
import { qqFetch } from '../src/providers/qqmusic/http.js';

// The network deadline covers body reads, not only the moment response headers arrive.
test('stalled response body aborts and releases its timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const savedFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = savedFetch; t.mock.timers.reset(); });
  let received;
  globalThis.fetch = async (_url, { signal }) => {
    received = signal;
    return { ok: true, status: 200, headers: new Headers(), arrayBuffer: () => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('fixture aborted')), { once: true })) };
  };
  const pending = qqFetch('https://u.y.qq.com/test');
  await Promise.resolve();
  const checked = assert.rejects(pending, /请求超时/);
  t.mock.timers.tick(12000);
  await checked;
  assert.equal(received.aborted, true);
});

// Fast responses must leave no live timer that can abort an unrelated later request.
test('completed response cancels its deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const savedFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = savedFetch; t.mock.timers.reset(); });
  let received;
  globalThis.fetch = async (_url, { signal }) => { received = signal; return new Response('{"ok":true}'); };
  assert.deepEqual(await (await qqFetch('https://u.y.qq.com/test')).json(), { ok: true });
  t.mock.timers.tick(12000);
  assert.equal(received.aborted, false);
});
