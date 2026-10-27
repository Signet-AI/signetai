# LongMemEval on Signet Dreaming, local model, RunPod

One command line (`lme`) that takes a funded RunPod account to a scored LongMemEval run, with exact per-system token and cache numbers and no idle GPU time.

What it runs: Signet's Dreaming memory profile through `scripts/bench-memory.ts` + memorybench, with Qwen3.8-27B INT4 served by vLLM on the same pod for Dreaming, answering and judging. Optionally Supermemory Local on the same GPU as a baseline.

## Prerequisites

- A RunPod account with credit, and your SSH public key added under Settings > SSH Public Keys. `lme` reaches pods through `ssh.runpod.io` with `~/.ssh/id_ed25519`; set `SSH_KEY` to use another key.
- A RunPod API key, either exported as `RUNPOD_API_KEY` or stored in Signet's secret store (`signet secret put RUNPOD_API_KEY`). It is only used locally and never copied to a pod.
- `bash`, `python3`, `ssh`, `git` and `base64` on the machine you run `lme` from.
- The commit you launch from must be pushed. The pod builds exactly that commit (`git rev-parse HEAD`) unless `SIGNET_REF` names a branch, tag or SHA.

Local state (pod aliases, pulled evidence) lives in `$LME_HOME`, default `~/.local/share/signet-lme`.

## Cost before you top up

Measured on one H200 (2026-10 run) (INT4 + fp8 KV + MTP3, Dreaming concurrency 12, thinking budget 2000 per turn):

| | per question | 500 questions |
|---|---|---|
| Dreaming prompt tokens | ~13.4M (about 80% prefix-cache hits) | ~6.7B |
| Dreaming generated tokens | ~0.24M | ~120M |
| H200 time | ~0.25 GPU-hours | ~125 GPU-hours |
| Cost at $5.29/h (secure) | ~$1.35 | ~$680 |
| Cost at $3.59/h | ~$0.90 | ~$450 |

Answering and judging are negligible (about 2K tokens per question). Dreaming is the whole bill: about 100 prompt tokens per evidence token. Making Dreaming cheaper per evidence token cuts this table proportionally. That is the highest-value fix before a full run.

Wall time divides by pods: 4 H200 pods take ~31 h, 8 take ~16 h, and the total cost is the same. Always run the 12-question pilot first. It prints the projection for your current code and hardware, so check it against this table before launching 500.

## Commands

```
lme balance                       balance and running pods
lme gpus                          price and stock for H200/B200/H100/L40S...
lme up NAME                       create pod (rejecting hosts whose GPU fails a CUDA call or that download slowly), push kit, start bootstrap (~10-25 min)
lme ready NAME                    bootstrap progress
lme serve NAME                    start vLLM + usage proxies + telemetry + watchdog, run smoke test
lme pilot NAME                    12 questions (2 per type); then: lme tokens NAME pilot12
lme run NAME RUN SELECTION        SELECTION: --full | --sample K | --limit N | --shard I/N | --ids FILE | --resume
          [--dream-conc N] [--max-hours H]
lme supermemory NAME RUN SEL      Supermemory baseline (SEL: --sample K | --shard I/N | --ids FILE; max ~200 questions)
lme status NAME [RUN] [--backlog] progress, passes, vLLM rates, per-system usage, RAM, watchdog
lme tokens NAME RUN [--pods N]    token/cache/cost report per system + 500-question projection
lme pull NAME RUN                 collect evidence on the pod and copy it to $LME_HOME/evidence/RUN (sha256 checked)
lme watch NAME                    foreground loop: pull each finished run; ends when the watchdog stops the pod
lme merge RUN...                  combine shard scores and tokens
lme hold|unhold NAME              disable/enable watchdog auto-stop
lme stop|start NAME               stop pod (archives + collects first) / resume pod and bring the stack back up
lme rm NAME                       terminate pod and delete its volume (asks for the name)
lme exec NAME [script]            run a script on the pod (stdin if no file)
lme ls                            local pod aliases
```

## Full run, start to finish

```
cd scripts/bench-runpod
./lme balance
./lme up h1 && ./lme ready h1            # repeat ready until it shows ALL
./lme serve h1                           # must end with SMOKE_OK (checks cached-token reporting)
./lme pilot h1
./lme status h1 pilot12                  # ~3 h; or: ./lme watch h1
./lme tokens h1 pilot12                  # projection for 500: check it fits the balance
```

One pod, all 500 questions:

```
./lme run h1 lme500 --full --max-hours 140
./lme watch h1                           # leave running; pulls the evidence when the run ends
```

Four pods in parallel (same total cost, a quarter of the wall time):

```
for i in 1 2 3 4; do ./lme up h$i; done   # then ready + serve each
for i in 1 2 3 4; do ./lme run h$i lme500-s$i --shard $i/4 --max-hours 40; done
./lme watch h1 & ./lme watch h2 & ./lme watch h3 & ./lme watch h4 &
./lme merge lme500-s1 lme500-s2 lme500-s3 lme500-s4
```

Pod died or hit `--max-hours`? Runs are resumable: `./lme start h1 && ./lme run h1 lme500 --resume`.

## What gets measured (and where)

- Per-system tokens, exact: every system talks to vLLM through its own `usage_proxy.py` port, which writes one JSONL row per request (prompt, cached, completion, reasoning) to `/workspace/usage/<tag>.jsonl`. Tags: `signet-dream` :8091, `signet-qa` :8092, `supermemory-extract` :8093, `supermemory-qa` :8094.
- Cache hits per request: vLLM runs with `--enable-prompt-tokens-details`. Signet's own `dreaming_passes.tokens_cache_read` also fills in now, since pi-ai reads `prompt_tokens_details.cached_tokens`.
- Whole-GPU counters, GPU, RAM (cgroup + per-process RSS): `telemetry.py` every 10 s into `/workspace/telemetry/telemetry.jsonl`.
- Score, answer/judge usage, retrieved context per question: memorybench `report.json`.
- `lme pull` brings all of it home as `$LME_HOME/evidence/<run>/<run>/`: logs, checkpoint, report, results, a DB snapshot (`dreaming_passes`, `memories`, evidence consumption, history nodes), usage, telemetry, vLLM log head/tail, `tokens.txt`/`tokens.json`.

## Idle-spend protection

`watchdog.sh` starts with bootstrap and with every serve, and only one instance runs. Idle time counts from the latest of these: a run exit, bootstrap, serve, a run start, or an `lme pull` chunk. A restarted pod therefore gets a fresh grace period instead of being stopped for runs that ended days ago. With no run active, it stops the pod:

- `IDLE_MAX_MIN` (90) after boot or serve if no run started. This also covers a failed bootstrap or serve.
- `HOLD_AFTER_PULL_MIN` (10) after the last run ended, once every finished run has been pulled.
- `GRACE_MIN` (30) after the last run ended, if something was not pulled. The evidence stays in `/workspace/evidence`.

While a run is active:

- `--max-hours H` sets a deadline for that run only. At the deadline the watchdog stops just that run's processes; the run stays resumable, is collected, and then the rules above apply. The pilot gets a 6 h cap.
- A stall stops the Signet runs, which stay resumable with `--resume`. A stall means that for `STALL_MIN` (120) there was no vLLM generation, no model call in flight on any proxy, and no write to the run log or the run's database. If telemetry itself is stale or failing, liveness counts as unknown and the stall check does not fire; only `--max-hours` bounds a hung run then, so set it on long runs.
- On pods whose `/workspace` is a network filesystem, run workspaces (SQLite) live on the container disk. The watchdog archives them to `/workspace/evidence/<run>_ws.tgz` every hour and before any stop, and `--resume` restores from there. If an archive fails while unfinished runs still have their workspace only on the container disk, the watchdog skips the stop up to 3 times (10 minutes apart, `stop_failed: true` in `lme status`), then stops anyway to end the spend. `lme stop` also archives and collects before it stops.

The pod stops itself with `runpodctl` and its own pod-scoped key, so no account key goes onto the pod. If that fails, `lme status NAME` shows `stop_failed: true`; stop it with `lme stop NAME`. `lme hold NAME` turns auto-stop off while you work interactively.

`lme pull` on a running run gives a partial snapshot and does not mark the run pulled. The final evidence is still fetched after it exits, either by `lme watch` or by another `lme pull`.

`tokens.py` costs only the time a run actually executed, summed over its segments (stops and resumes excluded). It does not include bootstrap, serve or idle time, so the balance will drop a little more than the run cost.

A stopped pod keeps `/workspace` (model, venv, repo, run DBs, evidence) and costs storage only, about $0.06/h for 200 GB. Its GPU can be re-rented by someone else in the meantime. RunPod then refuses to start the pod (`not enough free GPUs on the host machine`) until that GPU frees up. That is why evidence is pulled to this machine instead of being left on the volume.

## Recipe and decisions (why these defaults)

- vLLM 0.32.0 cu129 pinned by `pod/freeze.txt` (triton 3.6.0, torchcodec removed). Full launch recipe and decode matrix: `docs/inference-recipes/qwen3.8-27b-vllm-blackwell.md`.
- Weights: `RedHatAI/Qwen3.8-27B-INT4` + fp8 KV + MTP 3. At 32 agents it kept 92% cache hits, against 77% for FP8 weights. TurboQuant KV ran 9-15x slower in vLLM 0.32 on Hopper.
- Context 262,144. Dreaming needs at least 200K; the window comes from the server's `/v1/models`, not from a Signet cap.
- Dreaming concurrency 12 per H200. Concurrency is limited by the pass deadline, not request slots: at 24 passes each got ~25 tok/s and most died at the 30-minute deadline. Past the KV knee (~32-48 agents), cache hits fall to 0% and every turn re-prefills. On bigger GPUs, raise `--dream-conc` only while per-pass decode stays at or above ~50 tok/s.
- Thinking stays on: 2000 tokens per Dreaming turn, 4000 for answer and judge, sent per request.
- The pod builds the commit you launch from. The kit needs the fixes from the first LongMemEval run (ingest retries, capture backlog 503s, transcript append, session-claim paging, Dreaming pass budget and deadline), which land together with it.

## Supermemory baseline notes

- The Lite license caps it at 10,000 documents (~200 LongMemEval questions). `supermemory.sh` refuses bigger selections.
- It runs tuned: ingest concurrency 8 and 8 embedding workers x 4 threads. The defaults are 2 and 1x1, which ingest about 6x slower.
- Documents report `done` long before their memories exist: extraction kept going for about 3 hours after `done` on 12 questions. The script searches only after extraction has made no LLM call for 5 minutes.
- Its LLM calls get the same thinking budget as Signet's Dreaming, injected by the proxy, since it can't send one itself.

## Files

```
lme, config.env          local CLI and defaults
rp.py, rpx.sh            RunPod GraphQL client; key from RUNPOD_API_KEY or `signet secret exec --secret RUNPOD_API_KEY`
pod.sh                   run a script on a pod over the ssh.runpod.io PTY proxy (no public IP needed)
merge_reports.py         shard merge
pod/bootstrap.sh         one-time setup on /workspace (idempotent)
pod/serve.sh             vLLM + proxies + telemetry + watchdog + smoke
pod/start_run.sh         Signet run launcher (fresh, shard, resume)
pod/supermemory.sh       Supermemory baseline
pod/usage_proxy.py       per-system usage logging proxy
pod/tokens.py            per-system token/cache/cost report + projection
pod/status.py            live status
pod/collect.sh           evidence bundle
pod/watchdog.sh          idle-spend protection
pod/stop_run.sh          stop Signet runs (resumable)
pod/archive_ws.sh        consistent workspace archive (SQLite backup API) for network-fs pods
pod/telemetry.py         vLLM/GPU/RAM sampler
pod/smoke.py             answer, thinking budget, cached-token reporting, tool call
pod/bench_agents.py      synthetic Dreaming load for sizing concurrency on new hardware
pod/freeze.txt           pinned vLLM environment
```
