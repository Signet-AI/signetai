<!-- readme-sync source=README.md blob=b536a907a7fa5c3940a4a56389dda03a13460096 Generated from README.md by scripts/sync-readme-translations.ts. Manual fixes are kept on later syncs. -->
<div align="center">

<a href="https://signetai.sh/"><img src="public/banner-typography.png" alt="Signet AI"></a>

Signet은 AI 에이전트에 공유 메모리를 제공합니다. 메모리, 시스템 프롬프트, 대화 기록, 조직 지식, 시크릿을 사용 중인 모든 AI 도구와 모델에 걸쳐 저장하고, 동기화하고, 공유하는 데 활용할 수 있습니다.

<a href="https://github.com/Signet-AI/signetai/releases"><img src="https://img.shields.io/github/v/release/Signet-AI/signetai?include_prereleases&style=for-the-badge" alt="GitHub 릴리스"></a>
<a href="https://www.npmjs.com/package/signetai"><img src="https://img.shields.io/npm/v/signetai?style=for-the-badge" alt="npm"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=for-the-badge" alt="Apache-2.0 라이선스"></a>
<a href="https://docs.signetai.sh/benchmarking/#current-longmemeval-score"><img src="https://img.shields.io/badge/LongMemEval-97.6%25-black?style=for-the-badge" alt="LongMemEval 97.6% 정답 정확도"></a>

[빠른 시작](#빠른-시작) · [작동 방식](#작동-방식) · [Harnesses](#harnesses) · [문서](https://docs.signetai.sh/quickstart/) · [Discord](https://discord.gg/Psdeg7sQm7)

[English](README.md) · [Deutsch](README.de.md) · [한국어](README.ko.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

<sub>이 문서는 자동 번역본입니다. 내용이 다를 경우 [영어 원문](README.md)이 우선합니다.</sub>

</div>

---

Signet은 대화 기록, 가져온 파일, 기타 소스로부터 메모리를 자동으로 생성합니다. 백그라운드에서는 "dreaming"이라는 프로세스가 기록 속 인물, 프로젝트, 사실, 관계를 담은 구조화된 맵을 만들고 유지합니다. 모든 연결은 원본 소스로 되돌아갈 수 있어서 출처를 확인할 수 있습니다.

모델이나 에이전트 도구를 바꾸면 Signet이 컨텍스트까지 함께 옮겨 줍니다. 다음 프롬프트가 시작되기 전에 에이전트는 관련된 내용을 미리 받아 보고, 더 자세한 내용이 필요할 때는 메모리를 원본 소스까지 추적할 수 있습니다. Signet은 자신의 머신에서 실행할 수도 있고, 팀을 위한 서버로 실행할 수도 있습니다.

## 빠른 시작

설치 방법은 한 가지만 선택하면 됩니다. 어떤 방법이든 동일하게 컴파일된 Signet 바이너리를 설치하며, npm과 Bun 패키지는 대응하는 네이티브 패키지를 통해 이를 가져올 뿐입니다.

```bash
# macOS and Linux
curl -fsSL https://signetai.sh/install.sh | bash

# npm or Bun (Windows, macOS, Linux)
npm install -g signetai
bun add -g signetai
```

Windows x64에서는 PowerShell에서 아래 명령을 실행한 뒤, 새 창을 열어 갱신된 `PATH`를 적용하세요:

```powershell
iwr -useb https://signetai.sh/install.ps1 | iex
```

이어서 워크스페이스를 설정합니다:

```bash
signet setup       # prepare a workspace and open guided onboarding
signet status      # confirm the daemon and Dreaming are healthy
signet dashboard   # browse memory, sources, and settings
```

가이드 온보딩이 프로바이더 선택부터 소스와 에이전트 연결까지 안내합니다. 헤드리스 머신을 사용 중이거나 설정을 에이전트에게 맡기고 싶다면, 아래 문구를 에이전트에 붙여넣어 비대화형으로 설정을 진행할 수도 있습니다:

```
Install and fully configure Signet AI by following this guide exactly: https://signetai.sh/skill.md
```

지원 플랫폼: Linux x64/arm64, macOS x64/arm64, Windows x64, Docker. 자세한 내용은 [설치 가이드](https://docs.signetai.sh/getting-started/install/)를, 기존 설치 환경은 [업그레이드 가이드](https://docs.signetai.sh/upgrading/)를 참고하세요.

> 일상적인 용도로는 `stable` 채널을 권장합니다. `nightly` 빌드(`install.sh | bash -s -- --nightly`)에는 아직 정식 출시되지 않은 변경 사항이 포함되어 있어 불안정할 수 있습니다.

## 작동 방식

<a href="https://signetai.sh/"><img src="public/sources.png" alt="소스"></a>

**소스**는 이미 갖고 있는 컨텍스트를 Signet 안으로 가져옵니다. 연결된 소스는 변경될 때마다 동기화 상태를 유지하고, 파일이나 웹페이지를 일회성으로 가져올 수도 있습니다([지원 소스 및 형식](#지원-소스-및-형식) 참고). 에이전트 대화는 누가 언제 무엇을 말했고 어디에서 비롯됐는지까지 함께 가져오며, 중단된 가져오기는 이어서 진행되고, 다시 가져와도 증거가 중복되지 않으며, 대화를 구조화된 JSONL로 내보낼 수도 있습니다.

**Dreaming**은 작업이 진행됨에 따라 Signet이 알고 있는 내용을 최신 상태로 유지합니다. 새 증거를 기존 컨텍스트와 함께 읽어 들이고, 거기에 나타난 인물·프로젝트·사실·관계를 연결하며, 모순을 다시 검토하고, 주장(claim)에 대한 갱신을 제안합니다. 변경 사항은 검증을 거쳐 출처와 함께 기록되며, 원본 증거는 절대 재작성되지 않습니다. 마감일이나 누군가의 현재 직책처럼 시간에 민감한 주장에는 검토 예정일을 지정해, 낡아버리기 전에 다시 확인하도록 할 수 있습니다. Dreaming이 작동하는 모습은 대시보드의 라이브 트레이스와 작업 원장(ledger)을 통해 지켜볼 수 있습니다.

더 읽어보기: [소스](https://docs.signetai.sh/sources/) · [데이터 포터빌리티](https://docs.signetai.sh/cli/data-portability/) · [Dreaming](https://docs.signetai.sh/pipeline/extraction-decisions/) · [지식 그래프](https://docs.signetai.sh/knowledge-graph/) · [아키텍처](https://docs.signetai.sh/architecture/)

### 지원 소스 및 형식

|소스|비고|
|---|---|
|Obsidian|실시간 파일 감시자. 여러 볼트를 읽기 전용으로 연결할 수 있으며, LLM-Wiki 형식을 지원합니다.|
|GitHub|이슈, 풀 리퀘스트, 토론을 실시간으로 가져옵니다.|
|Notion|Notion 통합에 공유된 페이지와 데이터베이스 항목을 동기화합니다. 다시 동기화할 때는 변경된 내용만 가져옵니다.|
|Discord|메모리에 기여하고 기존 지식 그래프에 연결되는 실시간 크롤러입니다.|
|웹페이지|공개 URL을 한 번 가져와서, 페이지 메타데이터와 함께 읽기 좋은 Markdown으로 추출합니다.|
|Slack, 이메일, Telegram, WhatsApp|_곧 제공 예정_|

|형식|확장자|
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

"Harness"는 에이전트가 실행되는 앱 또는 환경을 가리킵니다. Signet은 각 harness 고유의 훅, 플러그인, 확장을 통해 연결되어 백그라운드에서 메모리를 공급하고 작업 중에 새 컨텍스트를 수집합니다. 덕분에 에이전트를 바꿔도 처음부터 다시 시작할 필요가 없습니다.

|Harness|통합 방식|
|---|---|
|[Claude Code](https://docs.anthropic.com/en/docs/claude-code)|Hooks + MCP|
|[Codex](https://github.com/openai/codex) 및 ChatGPT 데스크톱|네이티브 플러그인, hooks/MCP 폴백|
|[OpenCode](https://github.com/sst/opencode)|플러그인|
|[OpenClaw](https://github.com/openclaw/openclaw)|플러그인|
|[Hermes Agent](https://github.com/NousResearch/hermes-agent)|메모리 공급자 플러그인|
|[Kimi Code](https://github.com/MoonshotAI/kimi-cli)|Hooks + MCP, ACPX 추론|
|[Pi](https://github.com/mariozechner/pi-coding-agent)|확장|
|Oh My Pi|확장|
|[Gemini CLI](https://github.com/google-gemini/gemini-cli)|MCP + GEMINI.md 동기화|
|[ForgeCode](https://forgecode.dev/)|Hooks + MCP|
|[Muse Code](https://dev.meta.ai/docs/muse-code)|Hooks + MCP|

에이전트는 Signet을 통해 서로 메시지를 주고받을 수도 있습니다. 메시지는 재시작 후에도 유지되며, 받는 쪽의 다음 세션이나 프롬프트가 시작될 때 전달됩니다.

사용 중인 harness가 목록에 없나요? [이슈를 열어주세요](https://github.com/Signet-AI/signetai/issues). 설정 방법은 [harness 가이드](https://docs.signetai.sh/harnesses/)를 참고하세요.

## 대시보드와 데스크톱

<img src="public/dashboard-home.webp" alt="일일 브리프, 최근 저장된 메모리, 활동, 시스템 상태를 보여주는 Signet 대시보드 홈 화면">

대시보드에서는 메모리를 살펴보고, 소스와 에이전트를 연결하고, 설정을 변경하고, Signet이 작동하는 모습을 확인할 수 있습니다. Signet이 파악하고 있는 인물, 프로젝트, 주장으로 이루어진 메모리 그래프와, 연결된 모델을 골라 메모리에 질문을 던질 수 있는 채팅이 함께 제공됩니다. 답변에는 근거로 삼은 메모리의 출처가 인용되어 표시됩니다.

`signet dashboard` 명령으로 브라우저에서 실행하거나, macOS, Linux, Windows x64에서는 데스크톱 앱으로 실행할 수 있습니다:

```bash
signet desktop install
```

## 메모리 검토 및 신뢰

- **출처(Provenance):** 메모리를 불러오면 Signet이 어디에서 왔는지, 어떻게 바뀌었는지, 검토를 거쳤는지를 함께 보여줍니다.
- **주장 추적(claim traces):** Signet이 왜 어떤 내용을 믿게 되었는지 물으면, CLI, API, MCP를 통해 그 이력과 경합하는 다른 주장, 그리고 정확한 원본 구절까지 확인할 수 있습니다.
- **에이전트 격리:** 각 에이전트는 읽도록 허용된 메모리만 볼 수 있습니다.
- **시크릿:** 시크릿은 암호화되어 저장되며, 마스터 키는 OS 키링에 보관됩니다. 키링이 없는 시스템에서는 암호화된 파일 저장 방식으로 대체되고 상태 경고가 표시됩니다. 키체인은 반드시 복구 계획에 포함하세요. 자세한 내용은 [시크릿](https://docs.signetai.sh/secrets/) 문서를 참고하세요.
- **복구:** 보호 상태에서는 백업이 복원 가능한 것으로 검증되었는지 확인할 수 있고, 누락되었거나 오래된 백업은 따로 표시됩니다.
- **악성 콘텐츠:** 알려진 악성 패턴에 해당하는 콘텐츠는 에이전트가 보는 범위에서 걸러집니다.

## 텔레메트리

Signet은 익명의 사용 통계를 전송합니다: 설치 및 버전 수, 기능 사용량, 프로바이더별 토큰 및 비용 합계, 개인정보가 제거된 크래시 리포트 등입니다. 메모리 내용, 프롬프트, 검색 쿼리, 사용자를 식별할 수 있는 그 어떤 정보도 절대 전송하지 않습니다. 모든 이벤트는 워크스페이스의 로컬 로그에도 기록되므로 무엇이 전송되었는지 직접 확인할 수 있습니다.

끄려면 설정에서 `telemetryEnabled: false`를 지정하거나 환경 변수로 `SIGNET_TELEMETRY_OPTOUT=1`을 설정하세요. 자세한 내용은 [텔레메트리 제어](https://docs.signetai.sh/analytics/)를 참고하세요.

## 벤치마크

Signet의 최신 MemoryBench 실행 결과는 **LongMemEval 정답 정확도 평균 97.6%**입니다. 메모리를 로컬에 둔다고 해서 검색 성능을 포기해야 하는 것은 아닙니다. 측정 방법론, 점수 관련 참고 사항, 실행 워크플로는 [벤치마크](https://docs.signetai.sh/benchmarking/#current-longmemeval-score) 문서를 참고하세요.

## 문서

[빠른 시작](https://docs.signetai.sh/quickstart/) · [CLI](https://docs.signetai.sh/cli/) · [설정](https://docs.signetai.sh/configuration/) · [대시보드](https://docs.signetai.sh/dashboard/) · [Harnesses](https://docs.signetai.sh/harnesses/) · [훅](https://docs.signetai.sh/hooks/) · [스킬](https://docs.signetai.sh/skills/) · [시크릿](https://docs.signetai.sh/secrets/) · [인증](https://docs.signetai.sh/auth/) · [SDK](https://docs.signetai.sh/sdk/) · [API](https://docs.signetai.sh/api/) · [텔레메트리](https://docs.signetai.sh/analytics/) · [Workspace v2](https://docs.signetai.sh/workspace-v2/) · [로드맵](ROADMAP.md) · [저장소 맵](repo.map.yaml)

## 개발

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

이 저장소를 개발하려면 다음이 필요합니다:

- 일반적인 저장소 개발을 위한 Bun
- Node 대상 패키지를 위한 Node.js 18+
- macOS Node 런타임에서 로컬 시크릿에 접근하기 위해 프로세스 `PATH`에 있는 Bun. 컴파일된 Signet과 데스크톱 앱에는 자체 헬퍼 런타임이 포함되어 있습니다
- macOS 또는 Linux
- 선택 사항(harness 통합용): 위에 나열된 harness 중 무엇이든

## 기여하기

오픈 소스가 처음이라면 [첫 번째 PR](https://docs.signetai.sh/first-pr/)부터 시작해 보세요. 코드 컨벤션과 프로젝트 구조는 [CONTRIBUTING.md](CONTRIBUTING.md)를 참고하세요. 큰 기능을 기여하기 전에는 이슈를 먼저 열어주시고, AI를 활용한 작업을 제출하기 전에는 [AI Policy](AI_POLICY.md)를 읽어주세요.

## Star History

<a href="https://star-history.com/#Signet-AI/signetai&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Signet-AI/signetai&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Signet-AI/signetai&type=Date" />
    <img alt="Signet-AI/signetai의 스타 히스토리 차트" src="https://api.star-history.com/svg?repos=Signet-AI/signetai&type=Date" />
  </picture>
</a>

## 기여자

사랑을 담아 만들었습니다...

<a href="https://github.com/NicholaiVogel"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/217880623?v=4&s=48" width="48" height="48" alt="NicholaiVogel" title="NicholaiVogel" /></a> <a href="https://github.com/aaf2tbz"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/260091788?v=4&s=48" width="48" height="48" alt="aaf2tbz" title="aaf2tbz" /></a> <a href="https://github.com/Ostico"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/8008416?v=4&s=48" width="48" height="48" alt="Ostico" title="Ostico" /></a> <a href="https://github.com/BusyBee3333"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/241850310?v=4&s=48" width="48" height="48" alt="BusyBee3333" title="BusyBee3333" /></a> <a href="https://github.com/stephenwoska2-cpu"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/258141506?v=4&s=48" width="48" height="48" alt="stephenwoska2-cpu" title="stephenwoska2-cpu" /></a> <a href="https://github.com/PatchyToes"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/256889430?v=4&s=48" width="48" height="48" alt="PatchyToes" title="PatchyToes" /></a> <a href="https://github.com/ddasgupta4"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/ddasgupta4?v=4&s=48" width="48" height="48" alt="ddasgupta4" title="ddasgupta4" /></a> <a href="https://github.com/LeuciRemi"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/44776125?v=4&s=48" width="48" height="48" alt="LeuciRemi" title="LeuciRemi" /></a> <a href="https://github.com/nyashkn"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/1158551?v=4&s=48" width="48" height="48" alt="nyashkn" title="nyashkn" /></a> <a href="https://github.com/Alexi5000"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/135995822?v=4&s=48" width="48" height="48" alt="Alexi5000" title="Alexi5000" /></a> <a href="https://github.com/dragontvstaff"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/279829920?v=4&s=48" width="48" height="48" alt="dragontvstaff" title="dragontvstaff" /></a> <a href="https://github.com/maximhar"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/maximhar?v=4&s=48" width="48" height="48" alt="maximhar" title="maximhar" /></a> <a href="https://github.com/alcar2364"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/alcar2364?v=4&s=48" width="48" height="48" alt="alcar2364" title="alcar2364" /></a> <a href="https://github.com/noamsiegel"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/52804845?v=4&s=48" width="48" height="48" alt="noamsiegel" title="noamsiegel" /></a> <a href="https://github.com/lost-orchard"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/lost-orchard?v=4&s=48" width="48" height="48" alt="lost-orchard" title="lost-orchard" /></a> <a href="https://github.com/gpzack"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/271398594?v=4&s=48" width="48" height="48" alt="gpzack" title="gpzack" /></a> <a href="https://github.com/Jarvis-ORC-HPS"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/273477147?v=4&s=48" width="48" height="48" alt="Jarvis-ORC-HPS" title="Jarvis-ORC-HPS" /></a> <a href="https://github.com/nanookclaw"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/258741235?v=4&s=48" width="48" height="48" alt="nanookclaw" title="nanookclaw" /></a> <a href="https://github.com/quannon"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/5967?v=4&s=48" width="48" height="48" alt="quannon" title="quannon" /></a> <a href="https://github.com/arnavgoel17"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/136158339?v=4&s=48" width="48" height="48" alt="arnavgoel17" title="arnavgoel17" /></a> <a href="https://github.com/glen-tl"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/270518453?v=4&s=48" width="48" height="48" alt="glen-tl" title="glen-tl" /></a> <a href="https://github.com/mikemikimike"><img align="left" hspace="4" src="https://avatars.githubusercontent.com/u/186855910?v=4&s=48" width="48" height="48" alt="mikemikimike" title="mikemikimike" /></a>
<br clear="left" />

## 라이선스

Apache-2.0.

---

[signetai.sh](https://signetai.sh) ·
[문서](https://docs.signetai.sh) ·
[스펙](https://signetai.sh/spec) ·
[토론](https://github.com/Signet-AI/signetai/discussions) ·
[이슈](https://github.com/Signet-AI/signetai/issues)
