const QR = "https://xui.ptlogin2.qq.com";
const JUMP = "https://graph.qq.com/oauth2.0/login_jump";
function hash33(text, hash) {
  for (let i = 0; i < text.length; i++) hash = (hash * 33 + text.charCodeAt(i)) >>> 0;
  return hash & 0x7fffffff;
}

function trusted(raw, host, path) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("QQ login: invalid redirect"); }
  if (url.protocol !== "https:" || url.host !== host || url.pathname !== path || url.username || url.password || url.hash) throw new Error("QQ login: invalid redirect");
  return url;
}

function cookie(response, name, domain) {
  const h = response.headers;
  let headers = typeof h.getSetCookie === "function" ? h.getSetCookie() : [];
  if (!headers.length && h.get("set-cookie")) headers = h.get("set-cookie").split(/,(?=\s*[^\s;,=]+=)/);
  let result = "";
  for (const header of headers) {
    const parts = header.split(";"), at = parts[0].indexOf("=");
    if (at < 0 || parts[0].slice(0, at).trim() !== name) continue;
    let foundDomain = "", expired = false;
    for (const attr of parts.slice(1)) {
      const [key, ...rest] = attr.trim().split("="), value = rest.join("=").trim();
      if (key.toLowerCase() === "domain") foundDomain = value.replace(/^\./, "").toLowerCase();
      if (key.toLowerCase() === "max-age" && Number(value) <= 0) expired = true;
    }
    const value = parts[0].slice(at + 1).trim();
    if (foundDomain === domain) result = !expired && /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/.test(value) ? value : "";
  }
  return result;
}

// Parse JSONP as data, never as JavaScript.
function status(body) {
  const wrapper = /^\s*ptuiCB\(([\s\S]*)\)\s*;?\s*$/.exec(body);
  if (!wrapper) throw new Error("QQ login: malformed QR status");
  let rest = wrapper[1].trim();
  const values = [];
  while (rest) {
    const m = /^'((?:[^'\\\r\n]|\\(?:['\\nrt]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}))*)'\s*/.exec(rest);
    if (!m) throw new Error("QQ login: malformed QR status");
    values.push(m[1].replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|['\\nrt])/g, (_, c) => c[0] === "x" || c[0] === "u" ? String.fromCharCode(parseInt(c.slice(1), 16)) : ({ n: "\n", r: "\r", t: "\t" }[c] || c)));
    rest = rest.slice(m[0].length);
    if (!rest) break;
    if (rest[0] !== "," || values.length >= 7 || !rest.slice(1).trim()) throw new Error("QQ login: malformed QR status");
    rest = rest.slice(1).trim();
  }
  if (values.length < 6 || values.length > 7) throw new Error("QQ login: malformed QR status");
  return values;
}

function session(body) {
  if (!body || typeof body.code !== "number" || !body.req || typeof body.req.code !== "number") throw new Error("QQ login: malformed response");
  if (body.code !== 0 || body.req.code !== 0 || body.req.subcode) throw new Error("QQ login rejected: " + body.code + "/" + body.req.code);
  const data = body.req.data;
  if (!data || typeof data !== "object") throw new Error("QQ login: missing session");
  const id = typeof data.musicid === "string" ? data.musicid : Number.isSafeInteger(data.musicid) ? String(data.musicid) : "";
  if (!/^\d+$/.test(id) || !/[1-9]/.test(id) || typeof data.musickey !== "string" || !data.musickey || /[;\s]/.test(data.musickey) || Number(data.loginType) !== 2) throw new Error("QQ login: invalid session");
  const result = { musicid: id, musickey: data.musickey, loginType: 2 };
  for (const key of ["nick", "logo", "encryptUin", "openid", "refresh_token", "unionid", "refresh_key"]) if (typeof data[key] === "string" && data[key]) result[key] = data[key];
  for (const key of ["musickeyCreateTime", "keyExpiresIn"]) { const n = Number(data[key]); if (Number.isSafeInteger(n) && n > 0) result[key] = n; }
  if (result.musickeyCreateTime && result.keyExpiresIn && Date.now() / 1000 >= result.musickeyCreateTime + result.keyExpiresIn) throw new Error("QQ login: expired session");
  return result;
}

export async function qqSignIn({ fetch, prompt, sleep, decodeQR }) {
  async function send(url, options = {}) {
    const res = await fetch(url, { ...options, redirect: "manual", headers: { "User-Agent": "Mozilla/5.0", ...options.headers } });
    if (res.status < 200 || res.status >= 400) throw new Error("QQ login: HTTP " + res.status);
    return res;
  }
  const show = await send(QR + "/ssl/ptqrshow?" + query({ appid: 716027609, e: 2, l: "M", s: 3, d: 72, v: 4, t: Math.random(), daid: 383, pt_3rd_aid: 100497308, u1: JUMP }));
  const sig = cookie(show, "qrsig", "ptlogin2.qq.com");
  if (show.status !== 200 || !sig) throw new Error("QQ login: missing QR signature or Set-Cookie access");
  const image = new Uint8Array(await show.arrayBuffer());
  if (!image.length || image.length > 65536) throw new Error("QQ login: invalid QR image");
  const qr = await decodeQR(image);
  if (typeof qr !== "string" || !qr) throw new Error("QQ login: cannot decode QR image");
  await prompt({ qr, text: "请使用手机 QQ 扫码登录" });
  let callback;
  for (let i = 0; i < 60; i++) {
    const res = await send(QR + "/ssl/ptqrlogin?" + query({ u1: JUMP, from_ui: 1, aid: 716027609, daid: 383, pt_3rd_aid: 100497308, ptqrtoken: hash33(sig, 0) }), { headers: { Cookie: "qrsig=" + sig } });
    if (res.status !== 200) throw new Error("QQ login: QR status request failed");
    const text = await res.text();
    if (text.length > 16384) throw new Error("QQ login: oversized QR status");
    const args = status(text);
    if (args[0] === "0") { callback = args[2]; break; }
    if (args[0] === "65") throw new Error("QQ login: QR code expired");
    if (args[0] !== "66" && args[0] !== "67") throw new Error("QQ login: QR status " + args[0]);
    if (i < 59) await sleep(2000);
  }
  if (!callback) throw new Error("QQ login: QR code expired");
  const check = trusted(callback, "ssl.ptlogin2.graph.qq.com", "/check_sig");
  const response = await send(check.href);
  if (response.status !== 302) throw new Error("QQ login: check_sig did not redirect");
  const jump = trusted(response.headers.get("location"), "graph.qq.com", "/oauth2.0/login_jump");
  const names = ["p_uin", "p_skey", "pt_oauth_token"], cookies = names.map(name => cookie(response, name, "graph.qq.com"));
  if (cookies.some(value => !value)) throw new Error("QQ login: missing authorization cookies or Set-Cookie access");
  const jumped = await send(jump.href);
  if (jumped.status !== 200) throw new Error("QQ login: login_jump failed");
  // qrsig is a server-issued unpredictable value unique to this login.
  const state = sig;
  const ui = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const n = Math.floor(Math.random() * 16); return (c === "x" ? n : (n & 3) | 8).toString(16); });
  const form = query({ response_type: "code", client_id: 100497308, redirect_uri: "https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/", scope: "get_user_info,get_app_friends", state, switch: "", from_ptlogin: 1, src: 1, update_auth: 1, openapi: "1010_1030", g_tk: hash33(cookies[1], 5381), auth_time: Date.now(), ui });
  const authorized = await send("https://graph.qq.com/oauth2.0/authorize", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: names.map((name, i) => name + "=" + cookies[i]).join("; ") }, body: form });
  if (authorized.status !== 302) throw new Error("QQ login: authorization did not redirect");
  const back = trusted(authorized.headers.get("location"), "y.qq.com", "/portal/wx_redirect.html");
  const codes = back.searchParams.getAll("code"), states = back.searchParams.getAll("state");
  if (codes.length !== 1 || !/^[A-F0-9]{32}$/.test(codes[0]) || states.length !== 1 || states[0] !== state) throw new Error("QQ login: invalid authorization state or code");
  const login = await send("https://u.y.qq.com/cgi-bin/musicu.fcg", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: JSON.stringify({ comm: { g_tk: 5381, platform: "yqq", ct: 24, cv: 0 }, req: { module: "QQConnectLogin.LoginServer", method: "QQLogin", param: { code: codes[0] } } }) });
  if (login.status !== 200) throw new Error("QQ login: session request failed");
  return session(await login.json());
}
const query = obj => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
