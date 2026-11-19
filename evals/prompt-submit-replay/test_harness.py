import fcntl
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import analyze

SLICE = "Incremental database integrity slice complete"
COMPLETE = (SLICE, {"phase": "complete", "failedObjects": 0})


class Scratch(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="replay-test-")
        os.chmod(self.root, 0o700)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)


class SettledTest(Scratch):
    def settled(self, records):
        path = os.path.join(self.root, "daemon.ndjson")
        with open(path, "w") as handle:
            for message, data in records:
                handle.write(json.dumps({"message": message, "data": data}) + "\n")
        return subprocess.run([sys.executable, os.path.join(HERE, "settled.py"), path], capture_output=True).returncode

    def test_completed_incremental_check_without_migration_settles(self):
        self.assertEqual(self.settled([(SLICE, {"phase": "running", "failedObjects": 0}), COMPLETE]), 0)

    def test_retry_delay_is_still_pending(self):
        self.assertEqual(self.settled([(SLICE, {"phase": "timed_out", "failedObjects": 0})]), 1)

    def test_migration_must_pass_once_it_starts(self):
        started = ("Migration integrity verify setup rejected; retry scheduled", {})
        self.assertEqual(self.settled([started, COMPLETE]), 1)
        self.assertEqual(self.settled([started, ("Global integrity check passed; rollback backup pruned", {}), COMPLETE]), 0)

    def test_integrity_problems_fail(self):
        self.assertEqual(self.settled([("Migration integrity verify setup rejected; retry cap reached", {}), COMPLETE]), 2)
        self.assertEqual(self.settled([(SLICE, {"phase": "running", "failedObjects": 2})]), 2)
        self.assertEqual(self.settled([(SLICE, {"phase": "degraded", "failedObjects": 0})]), 2)


class MemoryItemsTest(unittest.TestCase):
    def test_markdown_inside_a_memory_stays_in_its_item(self):
        text = (
            "## Relevant Memory: Project\n\n"
            "- Deployment checklist (draft)\n## Notes\n- Restart service\n"
            "Details (a0c1be71-d81e-4714-a1a9-3eb310985cd6)\n"
            "- Rollback plan\n- Restart service (b1c1be71-d81e-4714-a1a9-3eb310985cd6)\n"
            "</signet-memory>\nCurrent date/time: now (America/Denver)"
        )
        self.assertEqual(
            analyze.memory_items(text)[1],
            [
                "- Deployment checklist (draft)\n## Notes\n- Restart service\nDetails (a0c1be71-d81e-4714-a1a9-3eb310985cd6)",
                "- Rollback plan\n- Restart service (b1c1be71-d81e-4714-a1a9-3eb310985cd6)",
            ],
        )

    def test_entity_context_lines_end_at_their_source(self):
        text = (
            "## Relevant Entity Context\n\n"
            "- [attribute] A / b / general / c: one (memory:x1)\n"
            "- [attribute] A / b / general / d: two (v3)\n\n## Other\n- not memory (memory:x2)"
        )
        self.assertEqual(
            analyze.memory_items(text)[1],
            ["- [attribute] A / b / general / c: one (memory:x1)", "- [attribute] A / b / general / d: two (v3)"],
        )


class PrepareTest(Scratch):
    def setUp(self):
        super().setUp()
        self.home = os.path.join(self.root, "home")
        os.mkdir(self.home)
        self.ws = self.workspace("ws")

    def workspace(self, name):
        ws = os.path.join(self.root, name)
        os.makedirs(os.path.join(ws, "data"))
        with open(os.path.join(ws, "agent.yaml"), "w") as handle:
            handle.write("updates:\n  auto_install: true\nharnesses: [claude-code]\n")
        con = sqlite3.connect(os.path.join(ws, "data", "signet.db"))
        con.execute("CREATE TABLE entities (name TEXT, entity_type TEXT, agent_id TEXT, status TEXT)")
        con.commit()
        con.close()
        return ws

    def prepare(self, replay, agents=None, *extra):
        env = {**os.environ, "HOME": self.home, "HERMES_HOME": self.home}
        command = [sys.executable, os.path.join(HERE, "prepare.py"), "--dir", replay, "--agents", agents or self.ws, *extra]
        return subprocess.run(command, env=env, capture_output=True, text=True)

    def test_refuses_the_workspace_and_its_aliases(self):
        alias = os.path.join(self.root, "alias")
        os.symlink(self.ws, alias)
        for replay in (self.ws, alias, os.path.join(self.ws, "replay")):
            self.assertNotEqual(self.prepare(replay).returncode, 0)
        self.assertEqual(sorted(os.listdir(self.ws)), ["agent.yaml", "data"])

    def test_refuses_when_a_layout_path_is_inside_the_replay_directory(self):
        replay = os.path.join(self.root, "out")
        moved = os.path.join(replay, "datasets", "live")
        os.makedirs(moved)
        os.rename(os.path.join(self.ws, "data", "signet.db"), os.path.join(moved, "signet.db"))
        with open(os.path.join(self.ws, "workspace-layout.json"), "w") as handle:
            json.dump({"version": 2, "overrides": {"database": os.path.join(moved, "signet.db")}}, handle)
        result = self.prepare(replay)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("overlaps workspace path", result.stderr)
        self.assertTrue(os.path.exists(os.path.join(moved, "signet.db")))

    def test_refuses_a_symlinked_datasets_directory(self):
        replay = os.path.join(self.root, "out")
        os.makedirs(replay, mode=0o700)
        elsewhere = os.path.join(self.root, "elsewhere")
        victim = os.path.join(elsewhere, "a" * 64)
        os.makedirs(victim)
        with open(os.path.join(victim, "keep.txt"), "w") as handle:
            handle.write("user data")
        os.symlink(elsewhere, os.path.join(replay, "datasets"))
        result = self.prepare(replay)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("is a symlink", result.stderr)
        self.assertTrue(os.path.exists(os.path.join(victim, "keep.txt")))

    def test_publication_prunes_only_harness_datasets(self):
        replay = os.path.join(self.root, "out")
        self.assertEqual(self.prepare(replay).returncode, 0)
        keep = os.path.join(replay, "datasets", "notes")
        os.mkdir(keep)
        con = sqlite3.connect(os.path.join(self.ws, "data", "signet.db"))
        con.execute("INSERT INTO entities VALUES ('Heron', 'project', 'default', 'active')")
        con.commit()
        con.close()
        self.assertEqual(self.prepare(replay).returncode, 0)
        names = sorted(os.listdir(os.path.join(replay, "datasets")))
        self.assertEqual(len(names), 2)
        self.assertIn("notes", names)

    def test_publishes_a_dataset_with_updates_off(self):
        replay = os.path.join(self.root, "out")
        self.assertEqual(self.prepare(replay).returncode, 0, self.prepare)
        with open(os.path.join(replay, "dataset", "agent.yaml")) as handle:
            self.assertEqual(yaml.safe_load(handle)["updates"], {"autoInstall": False})
        with open(os.path.join(self.ws, "agent.yaml")) as handle:
            self.assertIn("auto_install: true", handle.read())

    def test_failed_preparation_keeps_the_previous_dataset(self):
        replay = os.path.join(self.root, "out")
        self.assertEqual(self.prepare(replay).returncode, 0)
        current = os.readlink(os.path.join(replay, "dataset"))
        with open(os.path.join(self.home, "state.db"), "w") as handle:
            handle.write("not a database")
        self.assertNotEqual(self.prepare(replay, None, "--skip-snapshot").returncode, 0)
        self.assertEqual(os.readlink(os.path.join(replay, "dataset")), current)
        self.assertEqual(os.listdir(os.path.join(replay, "datasets")), [os.path.basename(current)])

    def test_skip_snapshot_refuses_another_workspace(self):
        replay = os.path.join(self.root, "out")
        self.assertEqual(self.prepare(replay).returncode, 0)
        other = self.workspace("other")
        result = self.prepare(replay, other, "--skip-snapshot")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("came from", result.stderr)

    def test_refuses_while_the_directory_is_locked(self):
        replay = os.path.join(self.root, "out")
        os.mkdir(replay, 0o700)
        with open(os.path.join(replay, ".replay.lock"), "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            self.assertNotEqual(self.prepare(replay).returncode, 0)


class AnalyzeTest(Scratch):
    def run_dir(self, run, dataset):
        path = os.path.join(self.root, f"run-{run}")
        os.mkdir(path)
        with open(os.path.join(path, "transcripts.json"), "w") as handle:
            json.dump({"t": {"harness": "pi", "turns": ["a"]}}, handle)
        with open(os.path.join(path, f"results-{run}.jsonl"), "w") as handle:
            handle.write(json.dumps({"harness": "t", "kind": "prompt", "turn": 1, "sessionKey": f"{run}-t", "text": ""}) + "\n")
        with open(os.path.join(path, "complete.json"), "w") as handle:
            json.dump({"run": run, "records": 1, "dataset": dataset, "transcriptsSha256": "x"}, handle)
        with open(os.path.join(path, f"daemon-log-{run}.ndjson"), "w") as handle:
            if run == "branch":
                handle.write(json.dumps({"message": "User prompt submit failed", "data": {}}) + "\n")

    def analyze(self):
        command = [sys.executable, os.path.join(HERE, "analyze.py"), "--dir", self.root, "base", "branch"]
        return subprocess.run(command, capture_output=True, text=True)

    def test_reports_failed_prompt_submits(self):
        self.run_dir("base", "d")
        self.run_dir("branch", "d")
        self.assertEqual(self.analyze().returncode, 0)
        with open(os.path.join(self.root, "summary.json")) as handle:
            self.assertEqual(json.load(handle)["failedPromptSubmits"], {"base": 0, "branch": 1})

    def test_refuses_runs_from_different_datasets(self):
        self.run_dir("base", "d1")
        self.run_dir("branch", "d2")
        result = self.analyze()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("different prepared datasets", result.stderr)

    def test_refuses_while_the_directory_is_locked(self):
        self.run_dir("base", "d")
        self.run_dir("branch", "d")
        with open(os.path.join(self.root, ".replay.lock"), "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            self.assertNotEqual(self.analyze().returncode, 0)


if __name__ == "__main__":
    unittest.main()
