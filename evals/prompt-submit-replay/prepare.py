import argparse
import fcntl
import glob
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys

import yaml

HOME = os.path.expanduser("~")
HERMES_HARNESS = "hermes-agent"
DATASET_NAME = re.compile(r"[0-9a-f]{64}|\.staging-\d+")
LAYOUT_MODULE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "platform", "core", "src", "workspace-layout.ts"
)
LAYOUT_SCRIPT = """
import { findExistingWorkspaceDatabase, resolveWorkspaceLayout } from %s;
const root = process.argv[1];
const layout = resolveWorkspaceLayout(root);
const paths = [layout.database, layout.transcripts, layout.runtime, layout.cache, layout.files, layout.imports, layout.secrets, layout.skills, layout.data, layout.layoutFile];
console.log(JSON.stringify({ database: findExistingWorkspaceDatabase(root), runtime: layout.runtime, paths }));
"""
SKIP_PREFIXES = (
    "<environment_context",
    "<user_instructions",
    "<command-",
    "<local-command",
    "Caveat:",
    "<system-reminder",
    "[Request interrupted",
    "<turn_aborted",
    "# AGENTS.md",
    "<permissions",
    "<task-notification",
    "The following is the Codex agent history",
    "[Image #",
    "<subagent_notification",
    "<user_action",
)


def parse_args():
    parser = argparse.ArgumentParser(description="Snapshot a Signet workspace and extract real prompts for replay.")
    parser.add_argument("--dir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "runs"))
    parser.add_argument("--agents", default=os.path.join(HOME, ".agents"))
    parser.add_argument("--agent-id", default="default")
    parser.add_argument("--turns", type=int, default=12)
    parser.add_argument("--hermes-sessions", type=int, default=2)
    parser.add_argument("--hermes-session", action="append", default=[])
    parser.add_argument("--skip-snapshot", action="store_true")
    args = parser.parse_args()
    if args.turns < 1:
        parser.error("--turns must be at least 1")
    if args.hermes_sessions < 0:
        parser.error("--hermes-sessions must be 0 or more")
    return args


def source_layout(args):
    script = LAYOUT_SCRIPT % json.dumps(os.path.realpath(LAYOUT_MODULE))
    result = subprocess.run(["bun", "-e", script, args.agents], capture_output=True, text=True, check=True)
    layout = json.loads(result.stdout)
    if not layout["database"]:
        raise SystemExit(f"no workspace database found under {args.agents}")
    return layout


def snapshot(args, layout, stage):
    source = layout["database"]
    target = os.path.join(stage, "pristine.db")
    con = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    con.execute("VACUUM INTO ?", (target,))
    con.close()
    print(f"snapshot: {target} ({os.path.getsize(target) // 1_000_000} MB)", file=sys.stderr)


def record_source(layout, stage):
    with open(os.path.join(stage, "source.json"), "w") as handle:
        json.dump({"database": os.path.realpath(layout["database"])}, handle)


def reuse_snapshot(layout, args, stage):
    current = os.path.join(args.dir, "dataset")
    if not os.path.exists(os.path.join(current, "pristine.db")):
        sys.exit("--skip-snapshot needs a prepared dataset; run prepare.py without it first")
    try:
        with open(os.path.join(current, "source.json")) as handle:
            source = json.load(handle)["database"]
    except (OSError, ValueError, KeyError):
        sys.exit("the current dataset does not record its source workspace; run prepare.py without --skip-snapshot")
    if source != os.path.realpath(layout["database"]):
        sys.exit(f"the current snapshot came from {source}, not {layout['database']}; run prepare.py without --skip-snapshot")
    os.link(os.path.join(current, "pristine.db"), os.path.join(stage, "pristine.db"))


def workspace_config(args, layout, stage):
    with open(os.path.join(args.agents, "agent.yaml")) as handle:
        config = yaml.safe_load(handle)
    config["harnesses"] = []
    config.setdefault("network", {})["mode"] = "localhost"
    updates = config.setdefault("updates", {})
    updates.pop("auto_install", None)
    updates["autoInstall"] = False
    memory = config.setdefault("memory", {})
    memory.setdefault("pipelineV2", {})["paused"] = True
    memory.setdefault("dreaming", {})["enabled"] = False
    config.pop("auth", None)
    with open(os.path.join(stage, "agent.yaml"), "w") as handle:
        yaml.safe_dump(config, handle, sort_keys=False)
    with open(os.path.join(stage, "workspace-layout.json"), "w") as handle:
        json.dump({"version": 2, "overrides": {}}, handle, indent=2)
    registry = os.path.join(layout["runtime"], "plugins", "registry-v1.json")
    if os.path.exists(registry):
        shutil.copyfile(registry, os.path.join(stage, "plugin-registry.json"))


def entity_pattern(args, stage):
    con = sqlite3.connect(f"file:{os.path.join(stage, 'pristine.db')}?mode=ro", uri=True)
    names = [
        row[0]
        for row in con.execute(
            "SELECT name FROM entities WHERE agent_id = ? AND LOWER(entity_type) IN ('person', 'project') "
            "AND COALESCE(status, 'active') = 'active' AND LENGTH(name) >= 4",
            (args.agent_id,),
        )
    ]
    if not names:
        return None
    ordered = sorted(names, key=len, reverse=True)
    return re.compile(r"\b(" + "|".join(re.escape(name) for name in ordered) + r")\b", re.I)


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            part["text"]
            for part in content
            if isinstance(part, dict) and part.get("type") in ("text", "input_text") and isinstance(part.get("text"), str)
        )
    return ""


def keep(text):
    stripped = text.strip()
    return bool(stripped) and len(stripped) <= 6000 and not stripped.startswith(SKIP_PREFIXES)


def jsonl(path):
    with open(path, errors="ignore") as handle:
        for line in handle:
            try:
                yield json.loads(line)
            except ValueError:
                continue


def claude_sessions():
    for path in glob.glob(os.path.join(HOME, ".claude", "projects", "*", "*.jsonl")):
        turns = []
        for row in jsonl(path):
            message = row.get("message") or {}
            content = message.get("content")
            if row.get("type") != "user" or row.get("isMeta"):
                continue
            if isinstance(content, list) and any(isinstance(p, dict) and p.get("type") == "tool_result" for p in content):
                continue
            text = text_of(content)
            if keep(text):
                turns.append(text)
        yield path, turns


def codex_sessions():
    for path in glob.glob(os.path.join(HOME, ".codex", "sessions", "**", "*.jsonl"), recursive=True):
        turns = []
        for row in jsonl(path):
            payload = row.get("payload") or {}
            if row.get("type") == "response_item" and payload.get("role") == "user":
                text = text_of(payload.get("content"))
                if keep(text):
                    turns.append(text)
        yield path, turns


def pi_sessions():
    for path in glob.glob(os.path.join(HOME, ".pi", "agent", "sessions", "*", "*.jsonl")):
        turns = []
        for row in jsonl(path):
            message = row.get("message") or {}
            if row.get("type") == "message" and message.get("role") == "user":
                text = text_of(message.get("content"))
                if keep(text):
                    turns.append(text)
        yield path, turns


def opencode_sessions():
    path = os.path.join(HOME, ".local", "share", "opencode", "opencode.db")
    if not os.path.exists(path):
        return
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    for (session_id,) in db.execute("SELECT id FROM session"):
        turns = []
        for message_id, data in db.execute(
            "SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id", (session_id,)
        ):
            if json.loads(data).get("role") != "user":
                continue
            parts = []
            for (part_data,) in db.execute("SELECT data FROM part WHERE message_id = ? ORDER BY id", (message_id,)):
                part = json.loads(part_data)
                if part.get("type") == "text" and not part.get("synthetic") and isinstance(part.get("text"), str):
                    parts.append(part["text"])
            text = "\n".join(parts)
            if keep(text):
                turns.append(text)
        yield f"opencode:{session_id}", turns


def hermes_sessions():
    path = os.path.join(os.environ.get("HERMES_HOME", os.path.join(HOME, ".hermes")), "state.db")
    if not os.path.exists(path):
        return
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    for session_id, source in db.execute(
        "SELECT id, source FROM sessions WHERE started_at > strftime('%s', 'now', '-45 days') AND message_count >= 6"
    ):
        turns = [
            row[0]
            for row in db.execute(
                "SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id", (session_id,)
            )
            if row[0] and keep(row[0])
        ]
        yield f"hermes:{source}:{session_id}", turns


def best_window(turns, pattern, size):
    best = (0, 0)
    for start in range(max(1, len(turns) - size + 1)):
        hits = sum(1 for turn in turns[start : start + size] if pattern and pattern.search(turn))
        if hits > best[0]:
            best = (hits, start)
    return best


def pick(sessions, pattern, size, top, forced):
    scored = []
    for source, turns in sessions:
        if len(turns) < 4:
            continue
        hits, start = best_window(turns, pattern, size)
        priority = 1 if any(key in source for key in forced) else 0
        scored.append((priority, hits, source, turns[start : start + size]))
    scored.sort(key=lambda item: (-item[0], -item[1]))
    return scored[:top]


def extract(args, stage):
    pattern = entity_pattern(args, stage)
    sources = [
        ("claude-code", claude_sessions(), 1),
        ("codex", codex_sessions(), 1),
        ("pi", pi_sessions(), 1),
        ("opencode", opencode_sessions(), 1),
        (HERMES_HARNESS, hermes_sessions(), args.hermes_sessions),
    ]
    transcripts = {}
    for harness, sessions, top in sources:
        for index, (_, hits, source, turns) in enumerate(pick(sessions, pattern, args.turns, top, args.hermes_session)):
            key = harness if index == 0 else f"{harness}#{index + 1}"
            transcripts[key] = {"harness": harness, "source": source, "entityTurns": hits, "turns": turns}
            print(f"{key}: {len(turns)} turns, {hits} name an entity", file=sys.stderr)
    with open(os.path.join(stage, "transcripts.json"), "w") as handle:
        json.dump(transcripts, handle, indent=1, ensure_ascii=False)


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def publish(args, stage):
    files = {name: sha256(os.path.join(stage, name)) for name in sorted(os.listdir(stage))}
    dataset = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
    with open(os.path.join(stage, "manifest.json"), "w") as handle:
        json.dump({"dataset": dataset, "files": files}, handle, indent=1)
    datasets = os.path.join(args.dir, "datasets")
    target = os.path.join(datasets, dataset)
    if os.path.exists(target):
        shutil.rmtree(stage)
    else:
        os.rename(stage, target)
    link = os.path.join(args.dir, ".dataset.next")
    if os.path.lexists(link):
        os.remove(link)
    os.symlink(os.path.join("datasets", dataset), link)
    os.replace(link, os.path.join(args.dir, "dataset"))
    for name in os.listdir(datasets):
        if name != dataset and DATASET_NAME.fullmatch(name):
            shutil.rmtree(os.path.join(datasets, name))
    print(f"dataset {dataset[:12]} published in {target}", file=sys.stderr)


def contains(parent, child):
    return os.path.commonpath([parent, child]) == parent


def check_dirs(args, layout):
    replay = os.path.realpath(args.dir)
    for path in [args.agents, layout["database"], *layout["paths"]]:
        owned = os.path.realpath(path)
        if contains(owned, replay) or contains(replay, owned):
            sys.exit(f"{args.dir} overlaps workspace path {path}; choose a separate replay directory")
    agents = os.path.realpath(args.agents)
    os.makedirs(replay, mode=0o700, exist_ok=True)
    info = os.stat(replay)
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        sys.exit(f"{args.dir} must be owned by you and closed to other users (chmod 700)")
    live = os.stat(agents)
    if (info.st_dev, info.st_ino) == (live.st_dev, live.st_ino):
        sys.exit(f"{args.dir} is the workspace {args.agents}; choose a separate replay directory")
    args.dir = replay


def main():
    args = parse_args()
    os.umask(0o077)
    layout = source_layout(args)
    check_dirs(args, layout)
    lock = open(os.path.join(args.dir, ".replay.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit(f"a replay or analysis is using {args.dir}")
    os.makedirs(os.path.join(args.dir, "datasets"), exist_ok=True)
    stage = os.path.join(args.dir, "datasets", f".staging-{os.getpid()}")
    shutil.rmtree(stage, ignore_errors=True)
    os.mkdir(stage)
    try:
        if args.skip_snapshot:
            reuse_snapshot(layout, args, stage)
        else:
            snapshot(args, layout, stage)
        record_source(layout, stage)
        workspace_config(args, layout, stage)
        extract(args, stage)
        publish(args, stage)
    finally:
        shutil.rmtree(stage, ignore_errors=True)


main()
