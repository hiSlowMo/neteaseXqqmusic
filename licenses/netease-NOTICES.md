# Third-party notices

This plugin is licensed under AGPL-3.0-only. The complete license is in `LICENSE`.

The NetEase API protocol and data mappings are adapted from:

- Repository: https://github.com/sogud/mygo-cloudmusic
- Original project: https://github.com/egoist/mygo-cloudmusic
- Upstream author: egoist and contributors; preserved fork: sogud.
- Reference commit: `b13f52a2a2ff0746502b85b9c4c7fa1e86a1c385`.
- Files consulted: `internal/netease/eapi.go`, `auth.go`, `netease.go`, `catalog.go`, `podcast.go`, `subscriptions.go`.
- Upstream license: GNU Affero General Public License version 3.

Modifications made on 2026-11-06: ported Go requests to MyGo Music's JavaScript
plugin API; replaced the HTTP cookie jar and keychain integration with explicit
cookie handling and the host's private storage; added host data conversion,
quality mapping, bounded playlist loading, session invalidation, domain
validation, and tests. No Go code or upstream binaries are included in the plugin.

Host API reference: https://github.com/egoist/mygo-music at
`9c7f629ef202d66ee064ee9128c34b169b5e7215` (MyGo Music 0.1.6), especially its
README, `examples/demo-plugin`, `internal/music/music.go`, and `internal/plugin`.
The host itself is licensed under AGPL-3.0 and is distributed separately.

NetEase Cloud Music names and content belong to their respective owners. This
project is not an official NetEase or MyGo Music release. The license covers
this plugin's source, not music content or service access rights.

Recommendation endpoint shapes and FM modes were also checked against
AkinoKaede/mygo-music-netease-cloud-music, commit
`c988df7f4d787c1a133ba66e1f4f9dd71a2650cf` (`index.js`, AGPL-3.0),
and the public playlist metadata returned by NetEase for private radar.

Modifications made on 2026-11-07: added read-only comment pages, subscribed
podcasts and episode browsing, and kept program identity separate from its
audio ID for playback and comments; retained server cookie updates on
transient playback refusals for the existing bounded retry.
