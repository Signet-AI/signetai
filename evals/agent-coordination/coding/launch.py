#!/usr/bin/env python3
"""Launch native Pi coding trials with the Coding credential from Signet."""
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[3]
env = dict(os.environ)
try:
    desktop = subprocess.run(["systemctl", "--user", "show-environment"], capture_output=True, text=True, timeout=5)
    for line in desktop.stdout.splitlines():
        name, sep, value = line.partition("=")
        if sep and name in {"DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"}:
            env[name] = value
except (OSError, subprocess.TimeoutExpired):
    pass
args = ["node", str(root / "evals/agent-coordination/runner/run-live.mjs"), "--coding", "--prepare", *sys.argv[1:]]
command = " ".join(json.dumps(arg) for arg in args)
code = "import {execWithSecrets} from './platform/core/src/secrets.ts'; const r = await execWithSecrets(" + json.dumps(command) + ", {ZAI_CODING_CN_API_KEY:'SIGNET_KEY_ZAI_CODING_CN'}, {timeoutMs:1800000}); process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exitCode=r.code;"
os.chdir(root)
os.execvpe("bun", ["bun", "-e", code], env)
