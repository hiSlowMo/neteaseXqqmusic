// SPDX-License-Identifier: AGPL-3.0-only
// Provider modules keep their own cookies, settings and session generations.
// Access the native host lazily so loading the bundle has no side effects.
export function providerHost(provider) {
  const prefix = `provider.${provider}.`;
  return {
    storage: {
      get: key => globalThis.host.storage.get(prefix + key),
      set: (key, value) => globalThis.host.storage.set(prefix + key, value),
      remove: key => globalThis.host.storage.remove(prefix + key),
    },
    setting: key => globalThis.host.setting(provider === 'qqmusic' && key === 'loginMethod' ? 'qqLoginMethod' : `${provider}.${key}`),
    crypto: {
      md5: text => globalThis.host.crypto.md5(text),
      aesEcbEncrypt: (key, text) => globalThis.host.crypto.aesEcbEncrypt(key, text),
    },
    // Accessors keep older/mocked hosts usable until App login is selected.
    get platform() { return globalThis.host.platform; },
    get arch() { return globalThis.host.arch; },
    spawn: (command, args) => globalThis.host.spawn(command, args),
    signInPrompt: prompt => globalThis.host.signInPrompt(prompt),
    t: text => globalThis.host.t(text),
    language: () => globalThis.host.language(),
  };
}
