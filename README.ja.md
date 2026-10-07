<!-- readme-sync source=README.md blob=92869e4d74b0043640c419eb85dd16ab388cab71 Generated from README.md by scripts/sync-readme-translations.ts. Manual fixes are kept on later syncs. -->
<div align="center">

<a href="https://signetai.sh/"><img src="public/banner-typography.png" alt="Signet AI"></a>

Signet は、AI エージェントに共有メモリを与えます。メモリ、システムプロンプト、トランスクリプト、組織のナレッジ、シークレットを、お使いのすべての AI ツールやモデルの間で保存・同期・共有できます。

<a href="https://github.com/Signet-AI/signetai/releases"><img src="https://img.shields.io/github/v/release/Signet-AI/signetai?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
<a href="https://www.npmjs.com/package/signetai"><img src="https://img.shields.io/npm/v/signetai?style=for-the-badge" alt="npm"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=for-the-badge" alt="Apache-2.0 License"></a>
<a href="https://docs.signetai.sh/benchmarking/#current-longmemeval-score"><img src="https://img.shields.io/badge/LongMemEval-97.6%25-black?style=for-the-badge" alt="LongMemEval 97.6% answer accuracy"></a>

[クイックスタート](#クイックスタート) · [仕組み](#仕組み) · [Harnesses](#harnesses) · [ドキュメント](https://docs.signetai.sh/quickstart/) · [Discord](https://discord.gg/Psdeg7sQm7)

[English](README.md) · [Deutsch](README.de.md) · [한국어](README.ko.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

<sub>このドキュメントは自動翻訳です。内容に相違がある場合は[英語版](README.md)が優先されます。</sub>

</div>

---

Signet は、トランスクリプト、インポートしたファイル、その他のソースからメモリを自動的に作成します。バックグラウンドでは「Dreaming」と呼ばれるプロセスが、履歴の中の人物・プロジェクト・事実・関係性の構造化されたマップを構築し、維持します。すべての接続は元のソースへリンクしているため、情報の出所をたどることができます。

モデルやエージェントツールを乗り換えても、Signet がコンテキストを引き継ぎます。エージェントは次のプロンプトが始まる前に必要な情報を受け取り、詳細が必要になったときにはメモリを元のソースまでさかのぼって確認できます。Signet は自分のマシン上でも、チーム向けのサーバーとしても実行できます。

## クイックスタート

インストール方法は、どれか 1 つを選んでください。いずれの方法でも同じコンパイル済み Signet バイナリがインストールされ、npm パッケージと Bun パッケージは対応するネイティブパッケージを通じてバイナリを取得するだけです。

```bash
# macOS and Linux
curl -fsSL https://signetai.sh/install.sh | bash

# npm or Bun (Windows, macOS, Linux)
npm install -g signetai
bun add -g signetai
```

Windows x64 の場合は、PowerShell で以下を実行し、その後新しいウィンドウを開いて更新後の `PATH` を有効にしてください:

```powershell
iwr -useb https://signetai.sh/install.ps1 | iex
```

続いて、ワークスペースをセットアップします:

```bash
signet setup       # prepare a workspace and open guided onboarding
signet status      # confirm the daemon and Dreaming are healthy
signet dashboard   # browse memory, sources, and settings
```

ガイド付きオンボーディングでは、プロバイダーの選択からソースやエージェントの接続まで、手順を追って案内されます。ヘッドレスマシンを使っている場合や、セットアップをエージェントに任せたい場合は、以下をエージェントに貼り付けることで、セットアップを非対話で実行することもできます:

```
Install and fully configure Signet AI by following this guide exactly: https://signetai.sh/skill.md
```

対応プラットフォームは、Linux x64/arm64、macOS x64/arm64、Windows x64、Docker です。詳細は[インストールガイド](https://docs.signetai.sh/getting-started/install/)を、既存インストールのアップグレードについては[アップグレードガイド](https://docs.signetai.sh/upgrading/)を参照してください。

> 日常的な利用には `stable` チャネルをおすすめします。`nightly` ビルド（`install.sh | bash -s -- --nightly`）には未リリースの変更が含まれており、壊れる可能性があります。

## 仕組み

<a href="https://signetai.sh/"><img src="public/sources.png" alt="ソース"></a>

**ソース**は、すでにお持ちのコンテキストを Signet に取り込みます。接続済みのソースは変更に合わせて常に同期され、ファイルや Web ページをワンタイムインポートとして取り込むこともできます（[対応ソースとフォーマット](#対応ソースとフォーマット) を参照）。エージェントとの会話は、誰が・いつ・何を話したか、どこから来た情報かという記録とともにインポートされます。中断されたインポートは途中から再開され、再インポートしても証跡が重複することはありません。また、会話を構造化された JSONL として書き出すこともできます。

**Dreaming** は、作業が進むにつれて Signet の知識を維持します。新しい証跡を既存のコンテキストとともに読み込み、そこに描かれた人物・プロジェクト・事実・関係性を結び付け、矛盾を再確認し、主張の更新を提案します。変更は検証のうえ出典付きで記録され、元の証跡が書き換えられることはありません。締め切りや現在の役職など、時間の経過で変化する主張にはレビュー日を設定でき、陳腐化する前に再確認されます。Dreaming の動きは、ダッシュボードのライブトレースと操作台帳で見守ることができます。

さらに詳しく: [ソース](https://docs.signetai.sh/sources/) · [データポータビリティ](https://docs.signetai.sh/cli/data-portability/) · [Dreaming](https://docs.signetai.sh/pipeline/extraction-decisions/) · [ナレッジグラフ](https://docs.signetai.sh/knowledge-graph/) · [アーキテクチャ](https://docs.signetai.sh/architecture/)

### 対応ソースとフォーマット

|ソース|備考|
|---|---|
|Obsidian|リアルタイムのファイルウォッチャー。複数のボールトを読み取り専用で接続でき、LLM-Wiki 形式に対応しています。|
|GitHub|Issue、プルリクエスト、ディスカッションをリアルタイムで取り込みます。|
|Notion|Notion インテグレーションと共有されたページとデータベースのエントリを同期します。再同期時には変更のあったものだけを取得します。|
|Discord|メモリに反映され、既存のナレッジグラフとリンクされるリアルタイムクローラーです。|
|Webページ|公開 URL のワンタイムインポート。ページのメタデータ付きで読みやすい Markdown に抽出されます。|
|Slack、メール、Telegram、WhatsApp|_近日公開_|

|フォーマット|拡張子|
|---|---|
|Word|`.doc`, `.docx`, `.docm`|
|PowerPoint|`.ppt`, `.pps`, `.pot`, `.pptx`, `.pptm`, `.ppsx`, `.ppsm`|
|Excel|`.xls`, `.xlsx`, `.xlsm`, `.xlsb`|
|OpenDocument|`.odt`, `.ods`, `.odp`|
|Rich Text Format|`.rtf`|
|EPUB|`.epub`|
|CSV|`.csv`|
|PDF|`.pdf`|

## Harnesses

「Harness」とは、エージェントが動作するアプリや環境のことです。Signet は各 Harness が備えるフック、プラグイン、拡張機能を通じて接続し、バックグラウンドでメモリを提供しながら、作業中の新しいコンテキストを取り込みます。そのため、エージェントを乗り換えても一からやり直す必要はありません。

|Harness|統合方式|
|---|---|
|[Claude Code](https://docs.anthropic.com/en/docs/claude-code)|Hooks + MCP|
|[Codex](https://github.com/openai/codex) と ChatGPT デスクトップ版|ネイティブプラグイン（フォールバックとして hooks/MCP）|
|[OpenCode](https://github.com/sst/opencode)|プラグイン|
|[OpenClaw](https://github.com/openclaw/openclaw)|プラグイン|
|[Hermes Agent](https://github.com/NousResearch/hermes-agent)|メモリプロバイダープラグイン|
|[Kimi Code](https://github.com/MoonshotAI/kimi-cli)|Hooks + MCP、ACPX 推論|
|[Pi](https://github.com/mariozechner/pi-coding-agent)|拡張機能|
|Oh My Pi|拡張機能|
|[Gemini CLI](https://github.com/google-gemini/gemini-cli)|MCP + GEMINI.md 同期|
|[ForgeCode](https://forgecode.dev/)|Hooks + MCP|

また、エージェント同士が Signet を通じてメッセージをやり取りすることもできます。メッセージは再起動後も保持され、受信側の次のセッションまたはプロンプトの開始時に届きます。

お使いの Harness が見当たらない場合は、[Issue を起票](https://github.com/Signet-AI/signetai/issues)してください。セットアップ方法については [Harness ガイド](https://docs.signetai.sh/harnesses/)を参照してください。

## ダッシュボードとデスクトップ

<img src="public/dashboard-home.webp" alt="Signet ダッシュボードのホーム画面。デイリーブリーフ、最近保存されたメモリ、アクティビティ、システムの状態が表示されています">

ダッシュボードでは、メモリの閲覧、ソースやエージェントの接続、設定の変更、Signet の動作確認を行えます。Signet が把握している人物・プロジェクト・主張からなるメモリグラフに加え、接続した任意のモデルでメモリに質問できるチャットも備えています。回答には、根拠となったメモリが出典として示されます。

`signet dashboard` でブラウザ上で実行できるほか、macOS、Linux、Windows x64 ではデスクトップアプリとしても動作します:

```bash
signet desktop install
```

## メモリの確認と信頼性

- **出所（プロビナンス）:** メモリを取り出すとき、Signet はその出所、変更の履歴、レビュー済みかどうかを表示します。
- **主張のトレース:** Signet がなぜあることを確信しているのかを問い合わせると、その履歴、競合する主張、元のソースの該当箇所を、CLI、API、MCP のいずれからでも確認できます。
- **エージェントの分離:** 各エージェントは、読み取りを許可されたメモリしか参照できません。
- **シークレット:** シークレットは暗号化して保存され、マスターキーは OS のキーリングに保管されます。キーリングのないシステムでは暗号化ファイルストレージへフォールバックし、ヘルス警告が表示されます。キーチェーンは必ずリカバリープランに含めてください。詳細は[シークレット](https://docs.signetai.sh/secrets/)を参照してください。
- **リカバリー:** 保護ステータスには、バックアップが復元可能として検証済みかどうかが表示され、欠落していたり古くなったりしているバックアップにはフラグが立ちます。
- **敵対コンテンツ:** 既知の敵対パターンに一致するコンテンツは、エージェントの見る範囲から排除されます。

## テレメトリ

Signet は匿名の使用データを送信します。インストール数とバージョン数、機能の利用状況、プロバイダーごとのトークン数とコストの合計、サニタイズ済みのクラッシュレポートなどです。メモリの内容、プロンプト、検索クエリ、その他ユーザーを特定しうる情報が送信されることはありません。また、すべてのイベントはワークスペース内のローカルログにも書き込まれるため、何が送信されたのかを正確に確認できます。

無効にするには、設定で `telemetryEnabled: false` を指定するか、環境変数で `SIGNET_TELEMETRY_OPTOUT=1` を設定してください。詳細は[テレメトリコントロール](https://docs.signetai.sh/analytics/)を参照してください。

## ベンチマーク

Signet の最新の MemoryBench 記録では、**LongMemEval の回答精度が平均 97.6%** に達しています。メモリをローカルに保つからといって、弱い想起精度に甘んじる必要はありません。測定手法、スコアリングに関する注記、実行ワークフローについては [Benchmarks](https://docs.signetai.sh/benchmarking/#current-longmemeval-score) を参照してください。

## ドキュメント

[クイックスタート](https://docs.signetai.sh/quickstart/) · [CLI](https://docs.signetai.sh/cli/) · [設定](https://docs.signetai.sh/configuration/) · [ダッシュボード](https://docs.signetai.sh/dashboard/) · [Harnesses](https://docs.signetai.sh/harnesses/) · [フック](https://docs.signetai.sh/hooks/) · [スキル](https://docs.signetai.sh/skills/) · [シークレット](https://docs.signetai.sh/secrets/) · [認証](https://docs.signetai.sh/auth/) · [SDK](https://docs.signetai.sh/sdk/) · [API](https://docs.signetai.sh/api/) · [テレメトリ](https://docs.signetai.sh/analytics/) · [Workspace v2](https://docs.signetai.sh/workspace-v2/) · [ロードマップ](ROADMAP.md) · [リポジトリマップ](repo.map.yaml)

## 開発

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

このリポジトリを開発するには、以下が必要です:

- 通常のリポジトリ開発用の Bun
- Node 向けパッケージ開発用の Node.js 18 以上
- macOS の Node ランタイムからローカルのシークレットへアクセスするための、プロセス `PATH` 上の Bun（コンパイル済み Signet とデスクトップアプリにはヘルパーランタイムが同梱されています）
- macOS または Linux
- Harness 統合の開発（任意）: 上記のいずれかの Harness

## コントリビューティング

オープンソースへの参加が初めての方は、まず [Your First PR](https://docs.signetai.sh/first-pr/) から始めてください。コーディング規約とプロジェクト構成については [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。大きな機能をコントリビュートする前に必ず Issue を起票し、AI 支援による成果物を提出する前に [AI Policy](AI_POLICY.md) をお読みください。

## Star History

<a href="https://star-history.com/#Signet-AI/signetai&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Signet-AI/signetai&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Signet-AI/signetai&type=Date" />
    <img alt="Signet-AI/signetai のスター履歴チャート" src="https://api.star-history.com/svg?repos=Signet-AI/signetai&type=Date" />
  </picture>
</a>

## コントリビューター

愛を込めて、次の皆さんとともに作られています。

<a href="https://github.com/NicholaiVogel"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/217880623?v=4&s=48" width="48" height="48" alt="NicholaiVogel" title="NicholaiVogel" /></a> <a href="https://github.com/aaf2tbz"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/260091788?v=4&s=48" width="48" height="48" alt="aaf2tbz" title="aaf2tbz" /></a> <a href="https://github.com/Ostico"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/8008416?v=4&s=48" width="48" height="48" alt="Ostico" title="Ostico" /></a> <a href="https://github.com/BusyBee3333"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/241850310?v=4&s=48" width="48" height="48" alt="BusyBee3333" title="BusyBee3333" /></a> <a href="https://github.com/stephenwoska2-cpu"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/258141506?v=4&s=48" width="48" height="48" alt="stephenwoska2-cpu" title="stephenwoska2-cpu" /></a> <a href="https://github.com/PatchyToes"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/256889430?v=4&s=48" width="48" height="48" alt="PatchyToes" title="PatchyToes" /></a> <a href="https://github.com/ddasgupta4"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/ddasgupta4?v=4&s=48" width="48" height="48" alt="ddasgupta4" title="ddasgupta4" /></a> <a href="https://github.com/LeuciRemi"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/44776125?v=4&s=48" width="48" height="48" alt="LeuciRemi" title="LeuciRemi" /></a> <a href="https://github.com/nyashkn"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/1158551?v=4&s=48" width="48" height="48" alt="nyashkn" title="nyashkn" /></a> <a href="https://github.com/Alexi5000"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/135995822?v=4&s=48" width="48" height="48" alt="Alexi5000" title="Alexi5000" /></a> <a href="https://github.com/dragontvstaff"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/279829920?v=4&s=48" width="48" height="48" alt="dragontvstaff" title="dragontvstaff" /></a> <a href="https://github.com/maximhar"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/maximhar?v=4&s=48" width="48" height="48" alt="maximhar" title="maximhar" /></a> <a href="https://github.com/alcar2364"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/alcar2364?v=4&s=48" width="48" height="48" alt="alcar2364" title="alcar2364" /></a> <a href="https://github.com/noamsiegel"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/52804845?v=4&s=48" width="48" height="48" alt="noamsiegel" title="noamsiegel" /></a> <a href="https://github.com/lost-orchard"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/lost-orchard?v=4&s=48" width="48" height="48" alt="lost-orchard" title="lost-orchard" /></a> <a href="https://github.com/gpzack"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/271398594?v=4&s=48" width="48" height="48" alt="gpzack" title="gpzack" /></a> <a href="https://github.com/Jarvis-ORC-HPS"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/273477147?v=4&s=48" width="48" height="48" alt="Jarvis-ORC-HPS" title="Jarvis-ORC-HPS" /></a> <a href="https://github.com/nanookclaw"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/258741235?v=4&s=48" width="48" height="48" alt="nanookclaw" title="nanookclaw" /></a> <a href="https://github.com/quannon"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/5967?v=4&s=48" width="48" height="48" alt="quannon" title="quannon" /></a> <a href="https://github.com/arnavgoel17"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/136158339?v=4&s=48" width="48" height="48" alt="arnavgoel17" title="arnavgoel17" /></a> <a href="https://github.com/glen-tl"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/270518453?v=4&s=48" width="48" height="48" alt="glen-tl" title="glen-tl" /></a> <a href="https://github.com/mikemikimike"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/186855910?v=4&s=48" width="48" height="48" alt="mikemikimike" title="mikemikimike" /></a>
<br clear="left" />

## ライセンス

Apache-2.0 の下で公開されています。

---

[signetai.sh](https://signetai.sh) ·
[ドキュメント](https://docs.signetai.sh) ·
[spec](https://signetai.sh/spec) ·
[ディスカッション](https://github.com/Signet-AI/signetai/discussions) ·
[Issues](https://github.com/Signet-AI/signetai/issues)
