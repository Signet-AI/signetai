import argparse
import glob
import json
import os
import re
import shutil
import sqlite3
import sys

import yaml

HOME = os.path.expanduser("~")
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
    return parser.parse_args()


def snapshot(args):
    source = os.path.join(args.agents, "data", "signet.db")
    target = os.path.join(args.dir, "pristine.db")
    if os.path.exists(target):
        os.remove(target)
    con = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    con.execute("VACUUM INTO ?", (target,))
    con.close()
    print(f"snapshot: {target} ({os.path.getsize(target) // 1_000_000} MB)", file=sys.stderr)


def workspace_config(args):
    with open(os.path.join(args.agents, "agent.yaml")) as handle:
        config = yaml.safe_load(handle)
    config["harnesses"] = []
    config.setdefault("network", {})["mode"] = "localhost"
    memory = config.setdefault("memory", {})
    memory.setdefault("pipelineV2", {})["paused"] = True
    memory.setdefault("dreaming", {})["enabled"] = False
    config.pop("auth", None)
    with open(os.path.join(args.dir, "agent.yaml"), "w") as handle:
        yaml.safe_dump(config, handle, sort_keys=False)
    shutil.copyfile(os.path.join(args.agents, "workspace-layout.json"), os.path.join(args.dir, "workspace-layout.json"))
    registry = os.path.join(args.agents, "runtime", "plugins", "registry-v1.json")
    if os.path.exists(registry):
        shutil.copyfile(registry, os.path.join(args.dir, "plugin-registry.json"))


def entity_pattern(args):
    con = sqlite3.connect(f"file:{os.path.join(args.dir, 'pristine.db')}?mode=ro", uri=True)
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


def extract(args):
    pattern = entity_pattern(args)
    sources = [
        ("claude-code", claude_sessions(), 1),
        ("codex", codex_sessions(), 1),
        ("pi", pi_sessions(), 1),
        ("opencode", opencode_sessions(), 1),
        ("hermes-agent", hermes_sessions(), args.hermes_sessions),
    ]
    transcripts = {}
    for harness, sessions, top in sources:
        for index, (_, hits, source, turns) in enumerate(pick(sessions, pattern, args.turns, top, args.hermes_session)):
            key = harness if index == 0 else f"{harness}#{index + 1}"
            transcripts[key] = {"harness": harness, "source": source, "entityTurns": hits, "turns": turns}
            print(f"{key}: {len(turns)} turns, {hits} name an entity", file=sys.stderr)
    with open(os.path.join(args.dir, "transcripts.json"), "w") as handle:
        json.dump(transcripts, handle, indent=1, ensure_ascii=False)


def main():
    args = parse_args()
    os.makedirs(args.dir, exist_ok=True)
    if not args.skip_snapshot:
        snapshot(args)
    workspace_config(args)
    extract(args)


main()
