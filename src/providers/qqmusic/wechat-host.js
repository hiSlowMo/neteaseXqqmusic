// The host has no Web Crypto API. Obtain an unpredictable token from QQ over
// HTTPS for the device-registration envelope, which is sent to Tencent itself.
export async function wechatRandom(fetch, md5) {
  const url = 'https://xui.ptlogin2.qq.com/ssl/ptqrshow?appid=716027609&e=2&l=M&s=3&d=72&v=4&daid=383&pt_3rd_aid=100497308&u1=https%3A%2F%2Fgraph.qq.com%2Foauth2.0%2Flogin_jump&t=' + Math.random();
  const response = await fetch(url);
  if (!response.ok) throw new Error('Could not initialize WeChat login');
  const headers = response.headers.getSetCookie();
  const value = headers.map(v => /^qrsig=([^;]+)/i.exec(v)).find(Boolean)?.[1];
  if (!value || value.length < 64) throw new Error('Could not initialize WeChat login');
  await response.arrayBuffer();
  let counter = 0;
  return n => {
    const bytes = [];
    while (bytes.length < n) {
      const block = md5(value + ':' + counter++);
      for (let i = 0; i < block.length && bytes.length < n; i += 2) bytes.push(parseInt(block.slice(i, i + 2), 16));
    }
    return bytes;
  };
}

// The host fetch client does not keep cookies between WeChat QR requests.
export function wechatCookieFetch(fetch) {
  const jar = [];
  return async (address, options = {}) => {
    const url = new URL(address), isWechat = url.hostname === 'open.weixin.qq.com' || url.hostname === 'lp.open.weixin.qq.com';
    const headers = { ...options.headers };
    if (isWechat) {
      const values = jar.filter(c => (url.hostname === c.domain || !c.hostOnly && url.hostname.endsWith('.' + c.domain)) && url.pathname.startsWith(c.path)).map(c => c.name + '=' + c.value);
      if (values.length) headers.Cookie = values.join('; ');
    }
    const response = await fetch(address, { ...options, headers });
    if (isWechat && typeof response.headers.getSetCookie === 'function') for (const line of response.headers.getSetCookie()) {
      const parts = line.split(';'), pair = parts.shift(), split = pair.indexOf('=');
      if (split < 1) continue;
      const name = pair.slice(0, split).trim(), value = pair.slice(split + 1).trim();
      let domain = url.hostname, path = '/', hostOnly = true, expired = false;
      for (const part of parts) {
        const i = part.indexOf('='), key = (i < 0 ? part : part.slice(0, i)).trim().toLowerCase(), v = i < 0 ? '' : part.slice(i + 1).trim();
        if (key === 'domain') { domain = v.replace(/^\./, '').toLowerCase(); hostOnly = false; }
        else if (key === 'path' && v.startsWith('/')) path = v;
        else if (key === 'max-age' && Number(v) <= 0) expired = true;
      }
      if (!(url.hostname === domain || url.hostname.endsWith('.' + domain)) || !(domain === 'weixin.qq.com' || domain.endsWith('.weixin.qq.com'))) continue;
      const old = jar.findIndex(c => c.name === name && c.domain === domain && c.path === path);
      if (old >= 0) jar.splice(old, 1);
      if (value && !expired) jar.push({ name, value, domain, path, hostOnly });
    }
    return response;
  };
}
