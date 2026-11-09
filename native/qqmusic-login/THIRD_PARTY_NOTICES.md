# Native QQ Music transport notices

This directory is the complete source distribution of the MyGo QQ Music APP scanning transport helper. See [NOTICE](NOTICE) for its original-work and protocol adaptation notice. The helper sources and authored synthetic tests use GPL-3.0-or-later.

## QQMusicApi protocol reference

- Project: <https://github.com/L-1124/QQMusicApi>
- Author: Luren and contributors
- Pinned revision: `c046788dd1f11daacc74da487cbbf1bcd8ac6f33`
- Referenced files: `qqmusic_api/utils/mqtt.py`, `qqmusic_api/modules/login.py`
- License: GNU General Public License, version 3 or (at your option) any later version
- Full retained license: [licenses/qqmusic-api/LICENSE](licenses/qqmusic-api/LICENSE)

The transport protocol behavior was adapted into original Go source. The changes add a fixed-origin MQTT 5 WebSocket client, bounded JSON-lines commands/events, cancellation, and offline fixtures. No upstream Python source is bundled or executed. The helper does not perform QR creation, device operations, or HTTP login/session exchange.

## github.com/coder/websocket

- Version: `v1.8.15`
- Source: <https://github.com/coder/websocket/tree/v1.8.15>
- Release commit: `9c8faadccd1b679e811a79ce506f8a10237251ad`
- Copyright (c) 2025 Coder
- License: ISC
- Full unmodified notice and license: [licenses/coder-websocket/LICENSE.txt](licenses/coder-websocket/LICENSE.txt)

The version was verified available through the Go module proxy and its checksums are pinned in `go.sum`. The complete dependency source used to build the executable is included under `vendor/github.com/coder/websocket/`; `vendor/modules.txt` records its version and module selection. No network access or separate Go installation is needed to run the built helper.

## Go standard library

- Copyright 2009 The Go Authors
- License: BSD-style Go license
- Retained license: [licenses/GO-LICENSE](licenses/GO-LICENSE)

These notices and license files must accompany redistributed binaries. GPL redistribution also requires the corresponding source under its applicable terms. The helper and dependency licenses disclaim warranty.
