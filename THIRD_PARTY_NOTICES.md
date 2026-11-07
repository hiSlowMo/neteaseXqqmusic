# Third-party notices

MyGo Music Fusion is licensed under GNU AGPL-3.0-only. See LICENSE. It is an independent community plugin, not an official NetEase, Tencent/QQ, or MyGo Music release.

## Provider implementations

- NetEase provider adapted from https://github.com/sogud/mygo-music-netease at `bfaed424da72f3c776c42e2643b328f2a210c5ac` (AGPL-3.0). Original notices, including its earlier Go protocol sources, are retained in `licenses/netease-NOTICES.md`.
- QQ provider adapted from https://github.com/Amamiya23/mygo-music-qq-plugin at `e341a3b03c5da68397ce02e0994367c1a16b3a7e` (AGPL-3.0). This includes the QQ/WeChat QR protocol, library/discovery code, QR image decoder and QRC decoder. Its source carries attribution to mygo-cloudmusic and the Go DES implementation.
- Customized Go application consulted for session readiness, provider identity, song/media MID handling, relevance sorting and legacy local-playlist schema: https://github.com/cfour-hi/mygo-cloudmusic at base `f6af6ac`, with local uncommitted customizations developed in this workspace. That project descends from egoist/mygo-cloudmusic and vicnoah/mygo-cloudmusic (AGPL-3.0).
- Host API reference: https://github.com/egoist/mygo-music at `cb5e4cc49f8d4774d3a57b993e5b53c89b5a8f73`, release line 0.1.20 (AGPL-3.0). The host is distributed separately and is not modified or bundled here.

Modifications dated 2026-11-07: added source namespaces and isolated storage, combined search/ranking/cursors, account targeting, persisted local mixed playlists and offline import, session generation/concurrency protection, request deadlines, authorized-read retry, numeric QQ ID hydration and stream-host validation. Removed list-level VIP flags as playback gates. Adapted NetEase tests to isolated storage and full-stream authorization. Full plugin source is included in the installation ZIP.

## Bundled runtime dependencies

- jsQR 1.4.0, Apache-2.0: `licenses/jsqr.LICENSE`.
- jpeg-js 0.4.4, BSD-3-Clause: `licenses/jpeg-js.LICENSE`.
- pako 3.0.3, MIT AND Zlib: `licenses/pako.LICENSE`.
- The QRC decoder includes older embedded pako code, MIT AND Zlib: `licenses/qrc-pako.LICENSE`.
- QRC DES tables derive from Go crypto/des, BSD-3-Clause: `licenses/qrc-des.LICENSE`.

esbuild is a development dependency under MIT. qrcode is a development-only test dependency under MIT. Neither its test image generator nor the Go host binaries are included as runtime dependencies. Dependency versions are locked in package-lock.json.

The license applies to plugin source and does not grant music-content licenses or change service account entitlements. Provider names, artwork and music remain the property of their respective owners.
