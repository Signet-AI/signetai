import argparse
import importlib
import json
import os
import shutil
import subprocess
import sys


def parse_args():
    parser = argparse.ArgumentParser(description="Replay prompts through the installed Claude Code, Codex, and Hermes connectors.")
    parser.add_argument("run")
    parser.add_argument("port")
    parser.add_argument("session", help="transcripts.json key, for example claude-code, codex, or hermes-agent#2")
    parser.add_argument("--dir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "runs"))
    parser.add_argument("--signet", default=shutil.which("signet") or "signet")
    parser.add_argument("--hermes-home", default=os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes")))
    return parser.parse_args()


args = parse_args()
SANDBOX_HOME = os.path.join(args.dir, "home")
SANDBOXED = ("SIGNET_", "HERMES_", "XDG_", "PI_", "OPENCODE_", "CLAUDE_", "CODEX_")
ENV = {
    **{key: value for key, value in os.environ.items() if not key.startswith(SANDBOXED)},
    "HOME": SANDBOX_HOME,
    "XDG_CONFIG_HOME": os.path.join(SANDBOX_HOME, ".config"),
    "XDG_DATA_HOME": os.path.join(SANDBOX_HOME, ".local", "share"),
    "XDG_STATE_HOME": os.path.join(SANDBOX_HOME, ".local", "state"),
    "XDG_CACHE_HOME": os.path.join(SANDBOX_HOME, ".cache"),
    "HERMES_HOME": os.path.join(SANDBOX_HOME, ".hermes"),
    "SIGNET_DAEMON_URL": f"http://127.0.0.1:{args.port}",
    "SIGNET_PATH": os.path.join(args.dir, "ws"),
    "SIGNET_TELEMETRY_OPTOUT": "1",
}
with open(os.path.join(args.dir, "transcripts.json")) as handle:
    transcripts = json.load(handle)
output = open(os.path.join(args.dir, f"results-{args.run}.jsonl"), "a")


def record(session, key, turn, kind, text):
    row = {"run": args.run, "harness": session, "sessionKey": key, "turn": turn, "kind": kind, "text": text}
    output.write(json.dumps(row, ensure_ascii=False) + "\n")
    output.flush()


def hook(command, payload):
    result = subprocess.run(
        [args.signet, "hook", *command],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env=ENV,
        timeout=60,
        cwd=SANDBOX_HOME,
    )
    if result.returncode != 0:
        raise RuntimeError(f"{command} exit {result.returncode}: {result.stderr[-500:]}")
    return result.stdout


def codex_context(stdout):
    if not stdout.strip():
        return ""
    return (json.loads(stdout).get("hookSpecificOutput") or {}).get("additionalContext") or ""


def run_cli(session, harness):
    key = f"{args.run}-{session}"
    extra = ["--codex-json"] if harness == "codex" else ["--project", SANDBOX_HOME]
    start = hook(
        ["session-start", "-H", harness, *extra],
        {"session_id": key, "cwd": SANDBOX_HOME, "source": "startup", "hook_event_name": "SessionStart"},
    )
    record(session, key, 0, "session-start", codex_context(start) if harness == "codex" else start)
    for index, turn in enumerate(transcripts[session]["turns"], 1):
        payload = {"session_id": key, "cwd": SANDBOX_HOME, "prompt": turn, "hook_event_name": "UserPromptSubmit"}
        stdout = hook(["user-prompt-submit", "-H", harness, *extra], payload)
        record(session, key, index, "prompt", codex_context(stdout) if harness == "codex" else stdout)


def run_hermes(session):
    sys.path.insert(0, os.path.join(args.hermes_home, "hermes-agent"))
    sys.path.insert(0, os.path.join(args.hermes_home, "plugins"))
    os.environ.clear()
    os.environ.update(ENV)
    provider = importlib.import_module("signet").SignetMemoryProvider()
    key = f"{args.run}-{session.replace('#', '-')}"
    turns = transcripts[session]["turns"]
    provider.initialize(key, platform="discord", agent_context="subagent")
    record(session, key, 0, "session-start", provider.system_prompt_block())
    for index, turn in enumerate(turns, 1):
        record(session, key, index, "prompt", provider.prefetch(turn, session_id=key))
        provider.queue_prefetch(turn, session_id=key)
    if provider._prefetch_thread:
        provider._prefetch_thread.join(timeout=30)
    record(session, key, len(turns) + 1, "prompt", provider.prefetch("", session_id=key))
    if hasattr(provider, "shutdown"):
        provider.shutdown()


os.makedirs(SANDBOX_HOME, exist_ok=True)
harness = transcripts[args.session]["harness"]
if harness in ("claude-code", "codex"):
    run_cli(args.session, harness)
elif harness == "hermes-agent":
    run_hermes(args.session)
else:
    raise SystemExit(f"{args.session}: {harness} is driven by drive.ts")
print(f"{args.run} {args.session} done", file=sys.stderr)
