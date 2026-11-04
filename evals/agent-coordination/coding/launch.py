#!/usr/bin/env python3
"""Launch native Pi coding trials with the Coding credential from Signet.

The credential is resolved through Signet and passed only in the runner's
environment. There is no wrapper timeout: the run ends when both agents settle
or when it is stopped with `run-live.mjs --teardown <runDir>`.
"""
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
code = (
    "import {getLocalSecretValue} from './platform/core/src/secrets.ts';"
    "import {spawn} from 'node:child_process';"
    "const key = await getLocalSecretValue('SIGNET_KEY_ZAI_CODING_CN');"
    "if (!key) { console.error('SIGNET_KEY_ZAI_CODING_CN is empty'); process.exit(1); }"
    f"const child = spawn({json.dumps(args[0])}, {json.dumps(args[1:])}, {{ stdio: 'inherit', env: {{ ...process.env, ZAI_CODING_CN_API_KEY: key }} }});"
    "for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));"
    "child.on('exit', (c) => process.exit(c ?? 1));"
)
os.chdir(root)
os.execvpe("bun", ["bun", "-e", code], env)
