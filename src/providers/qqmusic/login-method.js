// SPDX-License-Identifier: AGPL-3.0-only
// Share setting validation between the combined source and QQ login entrypoint.
export function parseQQLoginMethod(value) {
  const method = String(value || '').trim().toLowerCase();
  if (!method || method === 'qq') return 'qq';
  if (method === 'wechat' || method === '微信') return 'wechat';
  if (['qqmusic', 'app', 'qq音乐'].includes(method)) return 'qqmusic';
  throw Object.assign(new Error('QQ 扫码方式请填写 qq（手机 QQ）、qqmusic（QQ 音乐 App）或 wechat（微信）'), { code: 'setup' });
}
