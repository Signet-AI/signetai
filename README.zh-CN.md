<!-- readme-sync source=README.md blob=92869e4d74b0043640c419eb85dd16ab388cab71 Generated from README.md by scripts/sync-readme-translations.ts. Manual fixes are kept on later syncs. -->
<div align="center">

<a href="https://signetai.sh/"><img src="public/banner-typography.png" alt="Signet AI"></a>

Signet 为你的 AI 智能体提供共享记忆。你可以用它跨所有在用的 AI 工具和模型存储、同步并共享记忆、系统提示词、对话记录、机构知识和机密信息。

<a href="https://github.com/Signet-AI/signetai/releases"><img src="https://img.shields.io/github/v/release/Signet-AI/signetai?include_prereleases&style=for-the-badge" alt="GitHub 发布"></a>
<a href="https://www.npmjs.com/package/signetai"><img src="https://img.shields.io/npm/v/signetai?style=for-the-badge" alt="npm"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=for-the-badge" alt="Apache-2.0 许可证"></a>
<a href="https://docs.signetai.sh/benchmarking/#current-longmemeval-score"><img src="https://img.shields.io/badge/LongMemEval-97.6%25-black?style=for-the-badge" alt="LongMemEval 97.6% 回答准确率"></a>

[快速开始](#快速开始) · [工作原理](#工作原理) · [Harnesses](#harnesses) · [文档](https://docs.signetai.sh/quickstart/) · [Discord](https://discord.gg/Psdeg7sQm7)

[English](README.md) · [Deutsch](README.de.md) · [한국어](README.ko.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

<sub>本文档为自动翻译版本。如有出入，以[英文原版](README.md)为准。</sub>

</div>

---

Signet 会自动从你的对话记录、导入的文件及其他来源中创建记忆。在后台，一个名为 “Dreaming” 的过程会构建并持续维护一张结构化地图，涵盖你历史中的人物、项目、事实与关系。每一条关联都可追溯至其来源，让你清楚它从何而来。

切换模型或智能体工具时，Signet 会带着你的上下文一起迁移。在下一个提示开始之前，你的智能体就已拿到相关内容，并在需要更多细节时将记忆追溯到原始来源。你可以在自己的机器上运行 Signet，也可以将其作为团队的服务器运行。

## 快速开始

任选一种安装方式即可。它们安装的都是同一个编译好的 Signet 二进制文件；npm 和 Bun 包只是通过对应的原生包来获取它。

```bash
# macOS and Linux
curl -fsSL https://signetai.sh/install.sh | bash

# npm or Bun (Windows, macOS, Linux)
npm install -g signetai
bun add -g signetai
```

在 Windows x64 上，请在 PowerShell 中运行以下命令，然后打开一个新窗口以获取更新后的 `PATH`：

```powershell
iwr -useb https://signetai.sh/install.ps1 | iex
```

然后设置一个工作区：

```bash
signet setup       # prepare a workspace and open guided onboarding
signet status      # confirm the daemon and Dreaming are healthy
signet dashboard   # browse memory, sources, and settings
```

引导式上手流程会带你选择提供商，并连接你的来源和智能体。如果你在无头（headless）机器上，或者更愿意让智能体代为完成配置，也可以把下面这段话粘贴给智能体，以非交互方式运行安装：

```
Install and fully configure Signet AI by following this guide exactly: https://signetai.sh/skill.md
```

支持的平台：Linux x64/arm64、macOS x64/arm64、Windows x64 和 Docker。详情请参阅[安装指南](https://docs.signetai.sh/getting-started/install/)，已有安装请参阅[升级指南](https://docs.signetai.sh/upgrading/)。

> 日常使用我们推荐 `stable` 通道。`nightly` 构建（`install.sh | bash -s -- --nightly`）包含未发布的改动，可能会出问题。

## 工作原理

<a href="https://signetai.sh/"><img src="public/sources.png" alt="来源"></a>

你的**来源**会把已有的上下文引入 Signet。已连接的来源会随其变化保持同步，你也可以将文件和网页作为一次性导入（参见[支持的来源与格式](#支持的来源与格式)）。导入智能体对话时会保留谁在何时说了什么以及内容来自哪里；中断的导入可以续传，重复导入不会产生重复证据，你还可以将对话以结构化的 JSONL 格式重新导出。

**Dreaming** 会在你的工作不断推进的过程中维护 Signet 所知晓的内容。它会将新证据与现有上下文放在一起阅读，关联其中描述的人物、项目、事实和关系，重新审视矛盾之处，并对论断提出更新建议。所有变更都会经过校验并附带引用记录，原始证据绝不会被改写。具有时效性的论断（例如截止日期或某人的现任职位）可以设置复查日期，以免在过时之前得不到重新审视。你可以在仪表盘中通过实时追踪和操作台账观察 Dreaming 的工作。

延伸阅读：[来源](https://docs.signetai.sh/sources/) · [数据可移植性](https://docs.signetai.sh/cli/data-portability/) · [Dreaming](https://docs.signetai.sh/pipeline/extraction-decisions/) · [知识图谱](https://docs.signetai.sh/knowledge-graph/) · [架构](https://docs.signetai.sh/architecture/)

### 支持的来源与格式

|来源|说明|
|---|---|
|Obsidian|实时文件监视。可以只读方式连接多个 vault；支持 LLM-Wiki 格式。|
|GitHub|实时摄取 issue、pull request 和 discussion。|
|Notion|同步与 Notion 集成共享的页面和数据库条目；重新同步时只获取有变化的内容。|
|Discord|实时爬虫，为记忆贡献内容并链接到现有知识图谱。|
|网页|一次性导入公开 URL，提取为附带页面元数据的可读 Markdown。|
|Slack、电子邮件、Telegram、WhatsApp|_即将支持_|

|格式|扩展名|
|---|---|
|Word|`.doc`, `.docx`, `.docm`|
|PowerPoint|`.ppt`, `.pps`, `.pot`, `.pptx`, `.pptm`, `.ppsx`, `.ppsm`|
|Excel|`.xls`, `.xlsx`, `.xlsm`, `.xlsb`|
|OpenDocument|`.odt`, `.ods`, `.odp`|
|富文本格式|`.rtf`|
|EPUB|`.epub`|
|CSV|`.csv`|
|PDF|`.pdf`|

## Harnesses

所谓 “harness”，是指你的智能体运行时所处的应用或环境。Signet 通过各 harness 自带的 hooks、插件或扩展进行接入，在后台提供记忆，并在你工作的同时捕获新的上下文；这样一来，即使更换智能体，也不必从零开始。

|Harness|集成方式|
|---|---|
|[Claude Code](https://docs.anthropic.com/en/docs/claude-code)|Hooks + MCP|
|[Codex](https://github.com/openai/codex) 和 ChatGPT 桌面版|原生插件，hooks/MCP 兜底|
|[OpenCode](https://github.com/sst/opencode)|插件|
|[OpenClaw](https://github.com/openclaw/openclaw)|插件|
|[Hermes Agent](https://github.com/NousResearch/hermes-agent)|记忆提供方插件|
|[Kimi Code](https://github.com/MoonshotAI/kimi-cli)|Hooks + MCP，ACPX 推理|
|[Pi](https://github.com/mariozechner/pi-coding-agent)|扩展|
|Oh My Pi|扩展|
|[Gemini CLI](https://github.com/google-gemini/gemini-cli)|MCP + GEMINI.md 同步|
|[ForgeCode](https://forgecode.dev/)|Hooks + MCP|
|[Muse Code](https://dev.meta.ai/docs/muse-code)|Hooks + MCP|

智能体之间也可以通过 Signet 互发消息。消息在重启后依然保留，并会在接收方下一次会话或提示开始时送达。

没看到你使用的 harness？欢迎[提交 issue](https://github.com/Signet-AI/signetai/issues)。配置方法请参阅 [harness 指南](https://docs.signetai.sh/harnesses/)。

## 仪表盘与桌面应用

<img src="public/dashboard-home.webp" alt="Signet 仪表盘主页视图，展示每日简报、最近保存的记忆、活动与系统状态">

仪表盘是你浏览记忆、连接来源和智能体、修改设置并观察 Signet 工作的地方。它包含一张记忆图谱，展示 Signet 所知晓的人物、项目和论断，还有一个聊天窗口，可以用任何已连接的模型向你的记忆提问。回答会引用它们所依据的记忆。

你可以通过 `signet dashboard` 在浏览器中运行它，也可以在 macOS、Linux 和 Windows x64 上作为桌面应用运行：

```bash
signet desktop install
```

## 检查与信任记忆

- **溯源：**当你召回一条记忆时，Signet 会显示它来自哪里、发生过怎样的变化，以及是否经过复核。
- **论断追溯：**你可以通过 CLI、API 或 MCP 询问 Signet 为什么相信某个说法，并获得它的演变历史、与之相悖的论断，以及确切的原文出处段落。
- **智能体隔离：**每个智能体只能看到自己被允许读取的记忆。
- **机密信息：**机密信息以加密方式存储，主密钥保存在操作系统的钥匙串（keyring）中。没有钥匙串的系统会回退到加密文件存储，并显示健康警告。请务必将你的钥匙串纳入恢复计划；参见[机密信息](https://docs.signetai.sh/secrets/)。
- **恢复：**保护状态会显示备份是否已验证可恢复，并标记缺失或过期的备份。
- **恶意内容：**符合已知恶意模式的内容会被排除在智能体能看到的内容之外。

## 遥测

Signet 会发送匿名使用数据：安装量和版本统计、功能使用情况、各提供商的 token 与费用总计，以及经过脱敏处理的崩溃报告。它绝不会发送记忆内容、提示词、搜索查询或任何能识别你身份的信息。每个事件还会写入工作区中的本地日志，你可以据此查看实际发送了什么。

要关闭遥测，请在配置中设置 `telemetryEnabled: false`，或在环境中设置 `SIGNET_TELEMETRY_OPTOUT=1`。参见[遥测控制](https://docs.signetai.sh/analytics/)。

## 基准测试

Signet 最近一次纳入统计的 MemoryBench 运行平均取得 **97.6% 的 LongMemEval 回答准确率**。把记忆留在本地，不应该意味着你必须在召回效果上妥协。方法论、评分说明与运行流程请参阅[基准测试](https://docs.signetai.sh/benchmarking/#current-longmemeval-score)。

## 文档

[快速上手](https://docs.signetai.sh/quickstart/) · [CLI](https://docs.signetai.sh/cli/) · [配置](https://docs.signetai.sh/configuration/) · [仪表盘](https://docs.signetai.sh/dashboard/) · [Harnesses](https://docs.signetai.sh/harnesses/) · [Hooks](https://docs.signetai.sh/hooks/) · [Skills](https://docs.signetai.sh/skills/) · [机密信息](https://docs.signetai.sh/secrets/) · [认证](https://docs.signetai.sh/auth/) · [SDK](https://docs.signetai.sh/sdk/) · [API](https://docs.signetai.sh/api/) · [遥测](https://docs.signetai.sh/analytics/) · [Workspace v2](https://docs.signetai.sh/workspace-v2/) · [路线图](ROADMAP.md) · [仓库结构图](repo.map.yaml)

## 开发

```bash
git clone https://github.com/Signet-AI/signetai.git
cd signetai

bun install
bun run build
bun test
bun run lint
```

```bash
cd platform/daemon && bun run dev     # Daemon dev (watch mode)
cd surfaces/dashboard && bun run dev  # Dashboard dev
```

开发本仓库需要：

- Bun，用于常规仓库开发
- Node.js 18+，用于面向 Node 的软件包组件
- 进程 `PATH` 中需要有 Bun，以便 macOS 上的 Node 运行时访问本地机密信息；编译版 Signet 和桌面应用已内置相应的辅助运行时
- macOS 或 Linux
- 可选（用于 harness 集成）：上述任意一种 harness

## 参与贡献

如果你是开源新手，可以从[你的第一个 PR](https://docs.signetai.sh/first-pr/) 开始。代码规范和项目结构请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。在着手贡献重大功能之前请先提交 issue，提交 AI 辅助完成的工作之前请先阅读 [AI 政策](AI_POLICY.md)。

## Star History

<a href="https://star-history.com/#Signet-AI/signetai&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Signet-AI/signetai&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Signet-AI/signetai&type=Date" />
    <img alt="Signet-AI/signetai 的 Star 历史图表" src="https://api.star-history.com/svg?repos=Signet-AI/signetai&type=Date" />
  </picture>
</a>

## 贡献者

用心打造，感谢以下贡献者……

<a href="https://github.com/NicholaiVogel"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/217880623?v=4&s=48" width="48" height="48" alt="NicholaiVogel" title="NicholaiVogel" /></a> <a href="https://github.com/aaf2tbz"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/260091788?v=4&s=48" width="48" height="48" alt="aaf2tbz" title="aaf2tbz" /></a> <a href="https://github.com/Ostico"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/8008416?v=4&s=48" width="48" height="48" alt="Ostico" title="Ostico" /></a> <a href="https://github.com/BusyBee3333"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/241850310?v=4&s=48" width="48" height="48" alt="BusyBee3333" title="BusyBee3333" /></a> <a href="https://github.com/stephenwoska2-cpu"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/258141506?v=4&s=48" width="48" height="48" alt="stephenwoska2-cpu" title="stephenwoska2-cpu" /></a> <a href="https://github.com/PatchyToes"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/256889430?v=4&s=48" width="48" height="48" alt="PatchyToes" title="PatchyToes" /></a> <a href="https://github.com/ddasgupta4"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/ddasgupta4?v=4&s=48" width="48" height="48" alt="ddasgupta4" title="ddasgupta4" /></a> <a href="https://github.com/LeuciRemi"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/44776125?v=4&s=48" width="48" height="48" alt="LeuciRemi" title="LeuciRemi" /></a> <a href="https://github.com/nyashkn"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/1158551?v=4&s=48" width="48" height="48" alt="nyashkn" title="nyashkn" /></a> <a href="https://github.com/Alexi5000"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/135995822?v=4&s=48" width="48" height="48" alt="Alexi5000" title="Alexi5000" /></a> <a href="https://github.com/dragontvstaff"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/279829920?v=4&s=48" width="48" height="48" alt="dragontvstaff" title="dragontvstaff" /></a> <a href="https://github.com/maximhar"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/maximhar?v=4&s=48" width="48" height="48" alt="maximhar" title="maximhar" /></a> <a href="https://github.com/alcar2364"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/alcar2364?v=4&s=48" width="48" height="48" alt="alcar2364" title="alcar2364" /></a> <a href="https://github.com/noamsiegel"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/52804845?v=4&s=48" width="48" height="48" alt="noamsiegel" title="noamsiegel" /></a> <a href="https://github.com/lost-orchard"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/lost-orchard?v=4&s=48" width="48" height="48" alt="lost-orchard" title="lost-orchard" /></a> <a href="https://github.com/gpzack"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/271398594?v=4&s=48" width="48" height="48" alt="gpzack" title="gpzack" /></a> <a href="https://github.com/Jarvis-ORC-HPS"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/273477147?v=4&s=48" width="48" height="48" alt="Jarvis-ORC-HPS" title="Jarvis-ORC-HPS" /></a> <a href="https://github.com/nanookclaw"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/258741235?v=4&s=48" width="48" height="48" alt="nanookclaw" title="nanookclaw" /></a> <a href="https://github.com/quannon"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/5967?v=4&s=48" width="48" height="48" alt="quannon" title="quannon" /></a> <a href="https://github.com/arnavgoel17"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/136158339?v=4&s=48" width="48" height="48" alt="arnavgoel17" title="arnavgoel17" /></a> <a href="https://github.com/glen-tl"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/270518453?v=4&s=48" width="48" height="48" alt="glen-tl" title="glen-tl" /></a> <a href="https://github.com/mikemikimike"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/186855910?v=4&s=48" width="48" height="48" alt="mikemikimike" title="mikemikimike" /></a>
<br clear="left" />

## 许可证

Apache-2.0。

---

[signetai.sh](https://signetai.sh) ·
[文档](https://docs.signetai.sh) ·
[规范](https://signetai.sh/spec) ·
[讨论区](https://github.com/Signet-AI/signetai/discussions) ·
[Issues](https://github.com/Signet-AI/signetai/issues)
