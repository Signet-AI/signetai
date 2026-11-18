# Prompt-submit replay eval

This eval replays real user prompts from your own harness sessions through the installed Signet connectors against two daemon builds. It measures what `user-prompt-submit` injects on each turn. Both daemons run on the same read-only snapshot of your workspace database.

It reports:

- memory lines delivered more than once in a session;
- prompt turns that carry plugin guidance targeted at `user-prompt-submit`, and whether each session received guidance targeted at `session-start` (some connectors deliver session-start context with the first prompt);
- injected characters per prompt;
- dedupe-ledger claims and duplicates;
- per-turn engine decisions and prompt-submit latency from the daemon log.

## Privacy

Every input and output is your private data: the database snapshot, the extracted prompts, and the injected memories. All of it is written to `runs/`, which is gitignored. If you pass `--dir` or `REPLAY_DIR`, choose a directory outside the repository. Do not commit or share the output.

## Requirements

- Python 3 with PyYAML, Bun, `sqlite3`, `curl`, `ss`, and `setsid`.
- The connectors you want to replay, installed as usual: `signet` on `PATH` for Claude Code and Codex, the Hermes Signet plugin, the Pi extension, and the OpenCode plugin.
- Two compiled daemon binaries, for example a baseline and a branch built with `bun scripts/build-native-bun.ts`. Use compiled binaries for both sides: only the compiled build loads the native ONNX runtime and the CUDA accelerator.

## Run

```bash
cd evals/prompt-submit-replay
python3 prepare.py
./run.sh base 3871 /path/to/signet-base
./run.sh branch 3872 /path/to/signet-branch
python3 analyze.py base branch
```

`prepare.py` finds your workspace database and runtime directory with Signet's own layout resolver, opens the database read-only, and takes a `VACUUM INTO` snapshot of it. It writes a scratch `agent.yaml` from yours, with localhost networking, no harness sync, the memory pipeline paused, and Dreaming disabled, plus a default workspace layout with no path overrides. It copies your plugin registry, then picks the session window per harness that names the most known people and projects. Use `--hermes-session <id>` to force a specific Hermes session and `--dir` to write elsewhere.

`run.sh` copies the snapshot into a fresh, writable workspace. The daemon and every driver run with `HOME`, `XDG_*`, `HERMES_HOME`, and `SIGNET_PATH` pointed inside `runs/`, and without any inherited Signet, Hermes, Pi, OpenCode, Claude, or Codex environment variables. Every connector and the warm-up run as the agent in `REPLAY_AGENT_ID` (default `default`), so no connector has to infer an identity. Connector code loads from your installation; the drivers refuse a connector bundle that sets its own Signet environment at import, such as an OpenCode plugin installed with a baked daemon URL or API key. It then waits for startup integrity maintenance to settle. It warms recall, then replays every session through its connector. When the replay finishes, it exports the daemon log and the dedupe ledger and stops the daemon. Set `PROBE=1` to also record the top direct recall candidates per turn with `probe.py`. Each run starts from the same snapshot, so runs never see each other's writes.

`analyze.py` prints the per-session table and totals, and writes `per-turn-evidence.md` and `summary.json` to `runs/`.

Recall scores near `hooks.userPromptSubmit.minScore` can move between runs, because delivering a memory updates its access statistics. Compare the dedupe and plugin-guidance results across runs; treat single deliveries at the threshold as noise.
