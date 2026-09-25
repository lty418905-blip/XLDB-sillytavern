# 第三方声明

XLDB 自有且未另行许可的部分适用 [自定义许可](LICENSE.md)。以下部分保持其原有许可证。

## OpenHer

- 来源：https://github.com/kellyvv/OpenHer
- 固定版本：`ef5b2145c9c15582499ecc5fb9d10376d82eccdf`
- Copyright 2026 OpenHer Contributors
- 许可证：Apache-2.0；随附上游文本：[third-party/OpenHer-LICENSE](third-party/OpenHer-LICENSE)。
- 适用文件：`src/emotion/neural.ts`、`src/emotion/openher.ts`，遵循文件已有许可声明。
- XLDB 修改包括 TypeScript 移植、显式时钟、可序列化确定性随机状态、事务及来源生命周期接线、关系校准和有界历史。详见 [采用说明](docs/OPENHER_ADOPTION.md)。

## 安装时获取的依赖

Node.js、LanceDB、TypeScript 及类型定义等依赖由安装器获取，分别适用其分发包中的许可证。基础源码包不包含这些运行时、依赖二进制、模型权重或用户数据；AgentJev 扩展安装包另附下述模型与运行时。自定义许可不覆盖任何第三方组件。

## AgentJev

- 源码：<https://github.com/malevrigns/agent-jev>，固定版本 `a965ca8ff06ccabc0c796dca5447b55cc2069cee`，Apache-2.0，许可全文见 `third-party/agentjev/LICENSE`。
- 采用范围：`agentjev/model.py`、`jev_service/contract.py`、`jev_service/prefix.py`。XLDB 修改骨干初始化为本地配置构造，完整权重只加载一次；新增 `runner.py` 提供离线 CPU 管道调用。未采用上游 HTTP 服务或训练平台。
- 模型：<https://huggingface.co/aimeigaoshou/agent-jev>，固定版本 `e711cf4be8d1009458d2254f60df21738db8c6c0`，上游模型卡标注 Apache-2.0；保留模型卡和源码许可证。权重 SHA-256 为 `a3c3503b71a04da0e30cbd17362f5733ba0a5ccae6d3eb5db7a84a2398a4953b`。
- Windows 扩展包附带 Python 3.12.10、PyTorch 2.14.0 CPU、Transformers 5.16.1、Safetensors 0.8.0 及依赖，各自沿用运行时目录中的许可证及包元数据。它们只装入项目 `.local/agentjev/`，不修改全局环境。
