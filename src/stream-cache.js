// SPDX-License-Identifier: AGPL-3.0-only
// Signed playback URLs stay in this process and only outlive their request
// briefly. A session generation change makes every old entry unreachable.
export function createStreamCache({ version, load, ttl = 30_000, now = () => Date.now(), limit = 64 }) {
  const pending = new Map();
  const resolved = new Map();
  async function stream(id, quality) {
    const generation = version();
    const key = `${generation}\0${id}\0${quality}`;
    const hit = resolved.get(key);
    if (hit && now() - hit.at < ttl) return { ...hit.value };
    resolved.delete(key);
    if (pending.has(key)) return { ...await pending.get(key) };
    const promise = load(id, quality);
    pending.set(key, promise);
    try {
      const value = await promise;
      // An old account may finish a same-account renewal, but must not
      // populate a cache whose generation no longer identifies the request.
      if (version() === generation) {
        resolved.set(key, { value, at: now() });
        if (resolved.size > limit) resolved.delete(resolved.keys().next().value);
      }
      return { ...value };
    } finally {
      if (pending.get(key) === promise) pending.delete(key);
    }
  }
  return { stream, clear() { resolved.clear(); pending.clear(); } };
}
