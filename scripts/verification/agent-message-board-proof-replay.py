#!/usr/bin/env python3
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import z3 as z

ROOT = Path(__file__).resolve().parents[2]
FORMAL = ROOT / "docs/proofs/agent-message-board/formal"
MAIN = ROOT / "scripts/verification/agent-message-board-proof.py"


def main():
    results = json.loads((FORMAL / "results.json").read_text())
    runner_hash = hashlib.sha256(MAIN.read_bytes()).hexdigest()
    if results["runner_sha256"] != runner_hash:
        raise RuntimeError("Regenerate formal results with the current model runner before replay")
    spec = importlib.util.spec_from_file_location("board_proof", MAIN)
    if spec is None or spec.loader is None:
        raise RuntimeError("Cannot load the model runner")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    scratch = Path(os.environ.get("TMPDIR", Path.home() / ".cache/signet-verification"))
    scratch.mkdir(parents=True, exist_ok=True)
    git_dir = subprocess.check_output(["git", "rev-parse", "--absolute-git-dir"], cwd=ROOT, text=True).strip()
    with tempfile.TemporaryDirectory(prefix="board-source-guard-", dir=scratch) as name:
        fixture = Path(name)
        (fixture / ".git").write_text(f"gitdir: {git_dir}\n")
        for relative in module.SOURCE_FILES:
            target = fixture / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((ROOT / relative).read_bytes())
        setattr(module, "ROOT", fixture)
        manifest = module.source_manifest(results["implementation_sha"])
        if manifest != results["source_manifest"]:
            raise RuntimeError("Source manifest differs from the results being replayed")
        changed = fixture / "platform/daemon/src/board.ts"
        changed.write_bytes(changed.read_bytes() + b"\n")
        rejected = False
        try:
            module.source_manifest(results["implementation_sha"])
        except RuntimeError as error:
            rejected = "differs from pinned implementation" in str(error)
        if not rejected:
            raise RuntimeError("Source guard accepted the modified disposable copy")
    expected = {row["name"] + ".proof.smt2" for row in results["obligations"]}
    paths = sorted((FORMAL / "smt").glob("*.proof.smt2"))
    if {path.name for path in paths} != expected:
        raise RuntimeError("Exported property queries differ from the reported obligation set")
    replays = []
    for path in paths:
        solver = z.Solver()
        solver.set(timeout=20_000)
        solver.from_string(path.read_text())
        verdict = str(solver.check())
        if verdict != "unsat":
            raise RuntimeError(f"Replay failed: {path.name}: {verdict}")
        replays.append({"query": path.name, "result": verdict})
    report = {
        "implementation_sha": results["implementation_sha"],
        "guard_fixture": "copies of named source files, with read-only git-object lookup; only a disposable copy was mutated",
        "source_files_matched": len(manifest),
        "changed_copy_rejected": rejected,
        "main_runner_sha256": runner_hash,
        "replay_runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "fresh_solver_property_replays": replays,
        "note": "same-solver replay, not an independent proof kernel",
    }
    (FORMAL / "independent-replay.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"matched": len(manifest), "drift_rejected": rejected, "fresh_solver_replays": len(replays)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
