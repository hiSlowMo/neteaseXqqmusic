NetEaseXQQMusic 0.1.2 修复歌曲标题与外部歌词工具的兼容性问题。关联反馈：[歌词匹配问题](https://github.com/hiSlowMo/neteaseXqqmusic/issues/1)。

此前插件会把平台标签拼进歌名，例如 `May I Ask 〔网易云〕`；MyGo Music 会把这个标题直接发布给系统媒体控制。依赖歌名搜索歌词的工具因此可能匹配失败。

- 默认返回原始歌名，例如 `May I Ask`，歌手与专辑名称保持原样。
- 新增“歌名显示平台标签”设置：`true` 显示标签，`false` 或留空保持原始歌名。使用插件岛等外部歌词工具时请关闭。
- 兼容旧版本保存的混合歌单、最近播放和导入内容；歌曲 ID、平台路由及登录数据保持一致。

更新后，请从搜索或歌单重新加入歌曲，替换旧播放队列中缓存的标题。无需退出账号或删除歌单。

[在 MyGo Music 中安装](mygo-music://install-plugin?repo=hiSlowMo/neteaseXqqmusic) · [源码仓库](https://github.com/hiSlowMo/neteaseXqqmusic)

验证：22 项核心离线测试、JS 构建及语法检查通过。新增回归覆盖干净标题、歌词平台 ID 路由、旧歌单/最近播放/缓存恢复、标签开关及旧导入去重。

适用于 MyGo Music 0.1.20 及兼容后续版本。ZIP 包含完整源码、构建产物和许可。修复覆盖返回给宿主的歌曲资料；第三方插件岛的实际歌词匹配尚未实测，完整 provider 与 moejs 集成回归的原有限制保留。
