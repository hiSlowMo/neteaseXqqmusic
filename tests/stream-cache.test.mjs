import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamCache } from '../src/stream-cache.js';

test('stream cache expires, coalesces failures and isolates account generations', async () => {
  let generation = 0, now = 1000, calls = 0, finish;
  const cache = createStreamCache({
    version: () => generation, now: () => now, ttl: 30,
    load: async () => {
      const n = ++calls;
      if (n === 1) return new Promise(resolve => { finish = () => resolve({ url: `https://media.invalid/${n}` }); });
      if (n === 3) throw new Error('synthetic network failure');
      return { url: `https://media.invalid/${n}` };
    },
  });
  const first = cache.stream('track', 'high');
  const parallel = cache.stream('track', 'high');
  finish();
  assert.equal((await first).url, 'https://media.invalid/1');
  assert.equal((await parallel).url, 'https://media.invalid/1');
  assert.equal((await cache.stream('track', 'high')).url, 'https://media.invalid/1');
  assert.equal(calls, 1);
  now += 31;
  assert.equal((await cache.stream('track', 'high')).url, 'https://media.invalid/2');
  assert.equal(calls, 2);
  await assert.rejects(cache.stream('other', 'high'), /network failure/);
  assert.equal((await cache.stream('other', 'high')).url, 'https://media.invalid/4');
  generation++;
  assert.equal((await cache.stream('track', 'high')).url, 'https://media.invalid/5');
  assert.equal(calls, 5);
});

test('account changes do not accept a late result from an older generation', async () => {
  let generation = 0, calls = 0, finish;
  const cache = createStreamCache({
    version: () => generation,
    load: () => {
      calls++;
      if (calls === 1) return new Promise(resolve => { finish = resolve; });
      return { url: 'https://media.invalid/new-account' };
    },
  });
  const pending = cache.stream('track', 'lossless');
  generation++;
  finish({ url: 'https://media.invalid/old-account' });
  assert.equal((await pending).url, 'https://media.invalid/old-account');
  assert.equal((await cache.stream('track', 'lossless')).url, 'https://media.invalid/new-account');
  assert.equal(calls, 2);
});
