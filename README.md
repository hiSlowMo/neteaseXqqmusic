# NetEaseXQQMusic

网易云 + QQ 音乐双平台插件，适用于 MyGo Music。目标宿主为 [egoist/mygo-music](https://github.com/egoist/mygo-music) **0.1.20 或兼容后续版本**，不需要修改或重新编译播放器。源码采用 AGPL-3.0-only。

**v0.1.5 增加云端歌单管理、第三方歌单收藏、歌手关注、播客订阅和评论互动。** 网易云与 QQ 歌单分栏展示，首页使用封面卡片。插件更新统一在 MyGo Music 的 Settings → Plugins 中进行。收藏专辑页未通过实际账号验证，本版本不开放该功能。云端修改与评论互动通过合成响应的离线测试，尚未覆盖所有真实账号场景。

## 已实现

- 网易云、QQ 各自保存登录状态，可同时登录；QQ 支持手机 QQ、QQ 音乐 App 或微信扫码。App 扫码使用随包内置的辅助程序，需在 MyGo 授权运行程序。
- 一个搜索入口同时查询两边，优先展示标准化后标题完全相同的结果，再按标题前缀、包含及歌手匹配排序。歌曲按平台保留独立 ID，默认使用原始歌名；可在设置中开启 `〔网易云〕` / `〔QQ〕` 标题标签。
- 侧栏“按音源查看”将最近搜索已加载结果、最近播放和本地混合歌单按网易云 / QQ 音乐分组。搜索加 `qq:` / `netease:` 前缀可临时指定平台，也可设置默认搜索音源；歌曲和歌手元数据保持原样。
- 两个服务独立分页，单个服务失败时仍展示另一个服务的结果。
- 从歌曲 ID 的来源路由播放、歌词、专辑、歌手和喜欢操作。歌曲完整播放链接由原服务按当前登录账号提供；不根据 VIP 标记提前禁止选择，也不返回试听片段冒充完整歌曲。
- 新建本地混合歌单，混合添加、去重、移除、重排、改名、删除；重启后恢复完整歌曲资料。网易云与 QQ 歌单分栏展示；自建云端普通歌单支持添加/移除同平台歌曲、重命名和删除，也支持收藏第三方歌单。
- 两边喜欢的音乐、歌手关注、播客订阅、评论点赞与发表评论、发现页、电台、最近播放。
- QQ 播放前检查会话过期、合并并发续期；旧请求不能覆盖新登录或退出。歌曲解析重新读取 song MID 和 MediaMID，兼容旧歌单仅有数字 ID 的情况。相同歌曲与音质的并发地址解析合并，成功地址短时内存复用 30 秒；退出、换账号或续期代际改变后不复用，失败不缓存，不写磁盘。
- 离线转换旧定制版的本地歌单，导入去重。不会自动读取旧应用账号、钥匙串或会话文件。

## 安装

发布仓库：[`hiSlowMo/neteaseXqqmusic`](https://github.com/hiSlowMo/neteaseXqqmusic)。

[在 MyGo Music 中安装](mygo-music://install-plugin?repo=hiSlowMo/neteaseXqqmusic) · [下载最新版本](https://github.com/hiSlowMo/neteaseXqqmusic/releases/latest)

也可在原版 **MyGo Music** 的 Settings → Plugins → `+` 中填写仓库地址 `https://github.com/hiSlowMo/neteaseXqqmusic`，或从 Release 下载 `neteaseXqqmusic-0.1.4.zip` 通过本地 ZIP 安装。若界面只提供插件目录入口，可解压 ZIP，令 `plugin.json` 位于一个独立插件文件夹的根目录，再重启/重新加载插件。

文件结构至少包含：

```text
music-fusion/
  plugin.json
  dist/index.js
  bin/qqmusic-login-darwin-arm64
  bin/qqmusic-login-<其他系统与架构>
  native/qqmusic-login/
  locales/zh-CN.json
```

ZIP 包含六种系统 / 架构的辅助程序、完整源码、构建脚本、测试、依赖锁文件和许可。使用插件本身无需另行安装 Node、Go、MPV 或额外 API 服务。原定制版“ MyGo 云音乐 0.2.21 ”使用另一套原生扩展接口，不能直接安装此插件。

## 登录两个平台

MyGo Music 0.1.20 的插件设置为文本框，按以下值填写，回车或移开焦点保存：

| 设置 | 可填值 | 默认 |
| --- | --- | --- |
| 登录目标 | `both`（两个平台）、`netease`（网易云）、`qqmusic`（QQ） | `both` |
| QQ 音乐扫码方式 | `qq`（手机 QQ）、`qqmusic`（QQ 音乐 App）、`wechat`（微信） | `qq` |
| 搜索音源 | `both`（双平台）、`netease`（网易云）、`qqmusic`（QQ 音乐） | `both` |
| 歌名显示平台标签 | `true`（开启）、`false` 或留空（关闭） | 关闭 |

使用插件岛等依赖系统媒体信息匹配歌词的工具时，请关闭“歌名显示平台标签”。旧版本已加入播放队列的歌曲可能保留带标签的标题；更新或更改设置后，请从搜索或歌单重新加入歌曲以替换旧标题。无需删除歌单或重新登录。

首次点 Sign In，依次使用网易云 App 和所选的 QQ 平台扫码方式。手机 QQ 填 `qq`；QQ 音乐 App 填 `qqmusic`；微信会员填 `wechat`，并使用对应账号。两次登录独立保存，第二次扫码失败后可以重试，已完成的平台不用重复扫码。

QQ 音乐 App 扫码首次需到 Settings → Plugins → NetEaseXQQMusic 点击 **Allow Programs**（允许运行程序），然后点 Sign In。程序已包含在 ZIP 中，只在此扫码方式运行，完成、拒绝或超时后退出；仅直连腾讯，不启动本地服务器。未授权时会明确提示，不会自动改用手机 QQ 二维码。手机 QQ / 微信扫码和普通搜索播放均无需该程序权限。

要用 App 方式替换已有 QQ 登录，先把“登录目标”设为 `qqmusic`，再 Sign Out → Sign In，网易云登录保留。仅修改扫码方式不会退出原 QQ 账号。

若只登录/更换一个平台，先填写对应“登录目标”。目标尚未登录时会显示 Sign In。需要更换其账号时点 Sign Out，再点 Sign In；另一平台的凭据保留。填写 `both` 时 Sign Out 会退出两个平台。设置目标尚未登录时，上游会临时视这个组合源为未登录，歌单编辑需先完成该目标登录，或把目标切回已经登录的平台。

新插件需要重新扫码。旧应用仍使用自己的数据，本项目没有迁移或修改其凭据。

## 区分网易云与 QQ 音源

- 搜索 `qq: 反方向的钟` 只返回 QQ 音乐；`netease: 歌名` 只返回网易云。前缀会保留到搜索建议中，播放仍按歌曲本身 ID 路由。
- 设置“搜索音源”为 `netease` / `qqmusic` 可固定默认范围，`both` 恢复双平台；前缀可临时覆盖此设置，不影响账号登录。
- 侧栏“按音源查看”将最近一次歌曲搜索中**已加载**的各页结果及最近播放按平台分组；页面内的混合歌单入口也按平台分组。原歌单保持原来的顺序和编辑方式。

宿主当前没有给插件提供逐曲音源徽标字段，因此全局混合搜索和播放队列还不能在歌名之外增加自定义徽标。需要这些列表直接显示来源时，可选择开启“歌名显示平台标签”，但外部歌词工具可能受影响；默认维持原标题。

## 混合歌单与旧数据导入

在 NetEaseXQQMusic 侧栏点 `+` 新建歌单。从任一平台搜索结果的右键菜单 Add to Playlist 添加歌曲。本地歌单跟随插件数据保留，不会同步写回网易云或 QQ 服务器；更换电脑需备份/恢复插件数据。

旧版 `playlists.json` 是负数 ID 的本地歌单数组。用工具转换指定文件：

```bash
node scripts/import-playlists.mjs "$HOME/Library/Application Support/MyGo 云音乐/playlists.json" "$HOME/Desktop/mygo-fusion-import.json"
```

将输出文件的**全部 JSON 文本**粘贴到插件设置“导入旧版混合歌单 JSON”，保存后导入。工具不会覆盖已有输出文件，重复保存同一导入内容不会重复建单。导入后可清空该设置。工具只处理网易云与 QQ 曲目，其余来源会报告跳过数量；旧数据中的 QQ 歌手/专辑 MID 已丢失时保留名称，避免生成错误详情链接。音乐播放所需 MediaMID 会向 QQ 详情接口重新读取。

## 更新与数据

播放器通过其官方更新渠道更新；插件在自己的文件夹中独立安装或更新。**Settings → Plugins → NetEaseXQQMusic → `…` → Check for Updates** 可立即检查；发现新版后点 **Update**。通过 GitHub 仓库安装的插件由 MyGo Music 每 24 小时自动检查，安装更新前仍需确认，不会未经确认自动替换。保留插件 ID `music-fusion` 即可继续使用宿主 `plugin-data/music-fusion` 中的会话、歌单和最近播放。卸载时不要选择删除数据，备份时保留对应插件数据目录。

插件会话保存在 MyGo 的权限受限 JSON 存储中（宿主使用 0700 目录、0600 文件），**没有钥匙串加密接口**。分享源码/安装包不需要、也不应包含自己的插件数据目录。

## 播放器本体的边界

插件只提供歌曲资料和授权播放地址。暂停响应、音频缓冲、解码、设备切换、缓存下载及失败后的队列跳转由原版 MyGo Music 决定。原定制版的 MPV 引擎修复不在插件中，原版播放器不依赖那套 MPV 模块。

当前上游 0.1.20 仍会对部分歌曲加载失败尝试队列下一首，插件无法通过公开音乐源接口关闭这一行为；插件中的续期和有限重试只能减少由会话/链接解析造成的失败。CDN、版权及真实账号会员行为仍需实际验证。

搜索排序在每次合并的返回页内完成，不能提前保证尚未加载的后续远端页。网易云云端歌单保留 provider 的前 1000 首加载上限。

## 开发和验证

JS 构建需要 Node.js 22+；构建随包辅助程序还需 Go 1.27.3（此版本用于本地交叉构建）。使用插件无需安装这些工具。构建不需要运行第三方安装脚本：

```bash
npm ci --ignore-scripts
```

```bash
npm run build
```

```bash
npm run test:core
```

完整离线 provider 测试（只使用合成响应，不会访问音乐平台）：

```bash
npm test
```

原生辅助程序测试只使用合成 MQTT 帧和 loopback WebSocket，不生成真实二维码；`smoke:native` 会启动本机架构的实际程序，读取 ready 后关闭 stdin 验证退出，不连接腾讯。

真实宿主集成测试需要克隆的原版 MyGo Music 源码和它要求的 Go 工具链。脚本用 Go overlay 加入测试，不修改宿主文件，网络传输全部替换为合成响应：

```bash
npm run test:runtime -- /path/to/mygo-music
```

```bash
npm run test:native
```

```bash
npm run build:native
```

```bash
npm run smoke:native
```

```bash
npm run pack
```

设计见 [architecture.md](docs/architecture.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)，许可及来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。GitHub Actions 会检查核心测试、构建产物与源码是否一致，并验证安装包。

维护者确认候选版可以公开发布并提交后，可显式运行以下脚本。它从 `plugin.json` 读取版本，要求对应发布说明、非草稿标记和安装包，仅接受 `hiSlowMo` 的 GitHub 登录；核对干净工作区和校验和后推送 `main`、添加主题并上传 Release，已有 Release 不会被覆盖。本轮已生成本地安装包，但未运行发布脚本，公开 Release 仍为 0.1.2。

```bash
bash scripts/publish.sh
```
