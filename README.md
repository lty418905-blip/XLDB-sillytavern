# XLDB for SillyTavern

XLDB 在酒馆助手中为单角色或多 NPC 跑团接入连续记忆、OpenHer 情绪、角色知情范围、承诺、剧情时间和世界状态。聊天正文仍由酒馆当前选用的模型生成；XLDB 核心负责在生成前处理已接受事件，并提供按角色筛选的上下文。

**当前处于 MVP 测试阶段，功能可能存在实际应用问题。**

Windows x64 用户从 [最新 Release](https://github.com/lty418905-blip/XLDB-sillytavern/releases/latest) 下载 `XLDB-SillyTavern.zip`，解压后运行 `START-XLDB.cmd`，在 Tavern Helper 导入同目录的 `XLDB-酒馆.json` 并启用脚本。`XLDB-酒馆.js` 是同一内容的直接粘贴版本；`adapters/sillytavern/xldb.js` 是未包装的插件源码。两种加载方式只启用一种。详细步骤见 [安装与连接](INSTALL_TAVERN.md)。

本仓库提供 Tavern 入口；运行时依赖安装在包内 `.local/`，私有令牌与模型配置放在安装目录旁的私有目录。

首次安装请在酒馆包双击 START-XLDB.cmd会自动下载、校验权重与便携运行时。自动安装对应依赖并启动。

建议预留至少5GB磁盘空间

[连接与配置](INSTALL_TAVERN.md) · [故障恢复](RECOVERY.md) · [许可](LICENSE.md) · [第三方声明](THIRD_PARTY_NOTICES.md)

