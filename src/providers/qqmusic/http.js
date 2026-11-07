// SPDX-License-Identifier: AGPL-3.0-only
// Keep the deadline until the response body is consumed as well as headers.
export async function qqFetch(address, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), String(address).includes('lp.open.weixin.qq.com') ? 35000 : 12000);
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const done = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
  try {
    const response = await globalThis.fetch(address, { ...options, signal: controller.signal });
    // All QQ operations consume one small JSON/text/image body. Buffer here so
    // a stalled body obeys the same timeout and leaves no timer behind.
    const bytes = await response.arrayBuffer();
    done();
    const headers = response.headers;
    return {
      ok: response.ok, status: response.status, headers,
      arrayBuffer: async () => bytes,
      text: async () => new TextDecoder('utf-8').decode(new Uint8Array(bytes)),
      json: async () => JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(bytes))),
    };
  } catch (e) {
    done();
    if (controller.signal.aborted) throw new Error('QQ 音乐请求超时，请稍后重试');
    throw e;
  }
}
