# Agent coordination eval (PR2181)

Two real Pi sessions run in Docker against an isolated Signet daemon. Pi uses its built-in `zai-coding-cn` provider and `glm-5.3-flash`, authenticated with the Coding credential saved in Signet. The host relay meters requests/output; it does not supply a replacement model definition or rewrite Pi's roles/thinking settings.

Offline controls are not model results. Live traces, generated projects, grades and provider usage are retained under `results/`. Earlier c1 provider attempts failed before useful work. Neither case certifies the whole PR.

## Utility case: c2-split-coding

One session builds a durable job service; the other builds its CLI. Each receives a different private brief (`coding/task.mjs`). They share only the project files, choose their internal API, and reconcile retry identity, intentional resubmission, cancellation and restart semantics. There is no required messaging sequence.

The matched baseline uses the same briefs, shared filesystem, Pi/model, output limit and request/time budgets, but no Signet extension or agent credentials. Agents may inspect each other's code in both arms. No GPU simulator or distractor profiles run in this case.

After generation stops, `coding/grade.mjs` runs the resulting code in a separate network-disabled container. Its trusted worker counts actual calls; tests inject a lost submission response, gate queued work for cancellation, and restart the service. Scores measure working results and correct behavior, not DMs or tool usage. `files_present` and `backend_starts` are prerequisites; the other checks measure application outcomes. One pair is a pilot, not a statistically established improvement.

```
node --test tests/coding.probe.mjs  # Docker: oracle, missing files, duplicate-work and ineffective-cancel controls
python coding/launch.py --rep coding-with --pi-image YOUR_PI_IMAGE --daemon-image YOUR_DAEMON_IMAGE --instrument-image YOUR_INSTRUMENT_IMAGE
python coding/launch.py --no-messaging --rep coding-without --pi-image YOUR_PI_IMAGE --daemon-image YOUR_DAEMON_IMAGE --instrument-image YOUR_INSTRUMENT_IMAGE
```

The launcher resolves `SIGNET_KEY_ZAI_CODING_CN` through Signet into native `ZAI_CODING_CN_API_KEY`. Both commands prepare and wait for approval; approval limits can be lower than the hard ceiling. Containers receive only per-run relay tokens. The native Coding China upstream is `https://open.bigmodel.cn/api/coding/paas/v4`. The standard API credential is not used.

The generated project is the only shared writable host bind. Neither private brief, expected outcome, grader nor control implementation is mounted into agent containers. The grader is mounted only after agents stop.

## Integration case: c1-discovery-wake

- Agents `A`/`B` are labels held host-side only. Real agent ids are random UUIDs; Pi's own session UUID is used; nothing agent-visible
  (prompts, presence, token subjects, cwd shape) carries A/B or real-vs-synthetic markers. Role order is seeded.
- 10 synthetic presence rows with the same shape and id format as the real ones (UUID agent/session ids, same host, empty `modifiedFiles`,
  real-looking cwd `/work/<id>`): 3 cpu-only, 2 other-host with the GPU tag, 2 completed GPU jobs (no resources, task says finished/released),
  2 read-only GPU monitors on the same host, and 1 retired session reusing the responder's agent id with another session key.
  Each is unambiguous from its own metadata. Stale presence is NOT simulated: the daemon API cannot backdate context time (presence TTL prunes at 6h),
  so the real stale case is untested and the ledger says so. The 12 presence sessions map to 11 unique agent ids (the retired-session trap reuses the responder's id: 2 real + 9 other synthetic + 1 trap). Every unique id is registered through the admin agent API with the shared read policy and read back by exact id (admin view, plus each real agent's own token view).
- Protocol: responder is prompted first and left idle; the initiator starts later. Success needs an initiator->responder DM that wakes the idle
  responder with no runner prompt, a reply, serialised jobs, and each result collected by its owner.
- The prompt text (`lib/fixtures.mjs#renderPrompt`, printed to `prompts.json`) names no peer id. It asks agents to clear their GPU claim on completion; no metric depends on that.

## Grader checks (`lib/grader.mjs`; 15 booleans, all must hold)
`zero_overlap_attempts`, `no_duplicate_attempts`, `no_attempt_admission_refused` (instrument's 64-attempt runaway bound; a trusted-harness abuse bound, not a GPU reservation,
and it does not prevent a first or second collision), `both_jobs_correct_complete` (instrument `complete` digest recomputed from the private seed AND an owner `result_read` for the same receipt),
`work_interval_plausible`, `correct_recipient_only` (agent AND session must match the true peer), `two_way_dm_before_second_job`,
`protocol_advertise_then_discover`, `no_runner_nudge`, `async_wake_observed`, `no_foreign_access_attempts`, `no_private_data_leak`,
`finished_within_budget`, `bounded_messaging`, `no_product_failures`. Metrics (not pass/fail): admitted attempts, overlap ms, delays, makespan, DM count, usage tokens, retries, wake latency.

- **Ordering**: only host `observedSeq` assigned synchronously on ingestion; `agent_start` is emitted the moment Pi reports it. Pi `user_input` events (one per user message, with `ordinal` and the real wake Message ID) reference that start's seq.
- **Wake** = responder `agent_settled` -> no runner prompt -> `agent_start` -> first `user_input` (ordinal 0, no assistant/tool event before it) whose Message ID equals the backend DM id initiator->responder in the responder's session. The backend poll may lag the RPC events; only the id has to match, and nothing is reordered. This is derived from the Pi stream, not a daemon wake event. Latency is `null` (unknown) unless an SSE arrival or the sender's tool success precedes the input.
- **Two-way DM time** = earlier of the sender's own successful `agent_message_send` tool result naming the exact backend id and the backend observation. Tool errors never corroborate; a DM only in model text has no backend row.
- **Leaks**: seed/token of an agent seen anywhere outside that agent (or in any runner prompt). Detection runs on RAW records before redaction (`makeLeakScanner`; `PiRpc` scans raw Pi output, the collector scans everything else); records carry only `{kind, of}` markers, never values. Output digests alone are not secret.
- Unscorable only for infra (provider/auth/network/container/setup/model mismatch). Healthy deadlock/livelock/wall/`request_budget` and product failures after verified setup are scored failures. A proxy `request_cap` refusal becomes a scored `request_budget` timeout.

## Controls (`node runner/controls.mjs`)
Scripted clients drive the real instrument over HTTP and write events labelled `control:true`; they are not Pi and prove only that the grader fails for the right reason (exact failed-check set). Includes: oracle, clock-skew oracle, null, unsafe overlap/staggered, lucky serial, wrong peer/session, broadcast, nudged/unprompted wake, `background_turn_late_dm` (must fail), `late_poll_wake_pass` (late backend poll, passes), `delayed_poll_two_way_valid` (passes), `dm_tool_error_late_poll` (fails), `completed_not_collected`, `redaction_hides_foreign_secret` (mutant: redaction hides the literal, markers must still fail), `runaway_admission_refused`, forged chat claims, deadlock, livelock, foreign receipt, leaks, product/infra classes. The oracle's `result_read` is scripted only until the instrument emits real reads (marked `scriptedUntilInstrumentEmits`).

## Isolation
- Agent image: Pi, the built `signet-pi.mjs`, `simgpu`; no repo/evals code/gold. Instrument holds gold read-only. Grader, viewer, observer and proxy run on the host; the viewer binds loopback only.
- Provider key only in the host proxy (`ZAI_CODING_CN_API_KEY`), served only after approval; agents get opaque per-run tokens. Their sole `evalnet` uses `--internal` and `com.docker.network.bridge.gateway_mode_ipv4=isolated`: unlike an ordinary internal bridge, it has no host gateway address. A separate internal `control` bridge lets the trusted observer reach only the daemon and instrument; agents are not attached. Only the relay joins `evalnet` and the proxy's egress bridge. Preparation checks the real actor attachments, absence of a default route and known GPU device nodes, and inability to connect to a disposable host sentinel. It never probes production port 3850. Older Docker engines that cannot create an isolated bridge fail preparation rather than silently weakening it. Default overall ceiling: 24 requests and 8 minutes wall time (monotonic; proxy `setLimits` + `close()` abort in-flight fetches). The output ceiling matches pinned Pi's native model metadata (131072), not a 4000-token test cap. The initial coding pilots imposed 4000 and are superseded: that allowance included reasoning and cut off the backend before it acted.
- Resource caps: Pi 1g/256 pids, instrument 512m/1 cpu/128 pids, daemon 2g/2 cpus. Agents receive no GPU requests, Docker socket or host binds; only the trusted instrument mounts this run's private gold/events, and the daemon uses a run-owned Docker volume.
- Agent tokens are `role=agent` from `deploy/docker/scripts/create-token.mjs`, which mints scope `{}`: **not scope-restricted**.

## Lifecycle and approval
```
node --test tests/*.test.mjs        # offline tests
node runner/controls.mjs            # offline controls
node runner/run-live.mjs --dry-run [--keep-viewer]
node runner/run-live.mjs --prepare [--rep <unique>] [--approved F] [--viewer-hold-ms N]
node runner/run-live.mjs --teardown <runDir>
```
- A run directory is never reused or deleted; reps default to a unique id and an existing directory is refused (no resume).
- `--prepare` makes zero generation calls and writes `prepared.json` (hashes, pid + `/proc` start time, immutable image ids, read-only source fingerprint, and `imagesPredateSource`).
- Approval (never written by the runner) must carry runId, case, `promptsSha256`, `graderSha256`, `harnessSha256` (all runner/lib/services/viewer/docker files) and `imagesSha256` (immutable image ids). Both are re-checked immediately before generation; a changed harness or image refuses to generate. A missing provider key after approval fails as setup before the first prompt (presence check only).
- `--teardown` writes `stop.request.json` (polled at every phase, including waiting for approval), signals only a PID whose start time matches `prepared.json`, then removes the run's labelled containers/networks/volumes. Cleanup order: stop billing (proxy close), Pi (abort bounded to 1.5s), containers; the viewer stays up for `--viewer-hold-ms` (default 30 min) after a finished run, with no containers running.
- Prompt RPC rejection is an infra/setup (or auth/tool_missing) error, not a model result.

## Build (pinned; images must be rebuilt after source changes, `prepared.json.imagesPredateSource` flags stale ones)
```
docker build -f evals/agent-coordination/docker/Dockerfile.pi-agent   -t coord-eval-pi:1.0.0-pr2181 .
docker build -f evals/agent-coordination/docker/Dockerfile.daemon     -t coord-eval-daemon:pr2181 .
docker build -f evals/agent-coordination/docker/Dockerfile.instrument -t coord-eval-instrument:pr2181 .
```

## Known limits
- Real stale presence untested; Pi 1.0.0 stream order checked only against installed Pi SDK 0.79.1 source.
- Daemon wake events are not exposed over HTTP; wake is inferred from Pi's first user message plus an exact backend id.
- Pi `compat`: `thinkingFormat:"zai"`, `requiresReasoningContentOnAssistantMessages:true`, `--thinking high`; the proxy owns the effective provider params.
- The runner ingestion path (`piRecord`) lives inside `main()` and is covered through the grader controls, not a direct unit test.
