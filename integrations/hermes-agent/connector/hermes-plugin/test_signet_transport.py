import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import signet_transport as transport


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.home = self.enterContext(tempfile.TemporaryDirectory())
        self.env = {"HOME": self.home, "APPDATA": str(Path(self.home) / "AppData" / "Roaming")}
        self.enterContext(patch.dict(os.environ, self.env))
        self.received = []
        self.authorized = False
        self.refresh_response = None
        self.refresh_status = 200
        self.delay = 0
        self.busy_status = 503
        self.replay_entered = None
        self.replay_release = None
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.do_POST()

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                owner.received.append((self.path, dict(self.headers), json.loads(body) if body else None))
                if self.path == "/api/hooks/session-end" and owner.replay_entered is not None:
                    owner.replay_entered.set()
                    if owner.replay_release is not None:
                        owner.replay_release.wait(1)
                if owner.delay:
                    time.sleep(owner.delay)
                if self.path == "/api/auth/refresh" and owner.refresh_response:
                    status, value = owner.refresh_status, owner.refresh_response
                elif self.path == "/busy":
                    status, value = owner.busy_status, {"error": "busy"}
                elif self.path == "/forbidden":
                    status, value = 403, {"error": "denied", "reason": "permission", "required": "audit"}
                elif not owner.authorized:
                    status, value = 401, {"error": "expired", "reason": "expired"}
                else:
                    status, value = 200, {"ok": True}
                encoded = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                try:
                    self.wfile.write(encoded)
                except BrokenPipeError:
                    pass

            def log_message(self, format, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:%s" % self.server.server_port
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.thread.join)
        self.addCleanup(self.server.shutdown)

    def test_registry_key_permissions_and_precedence(self):
        key = transport.write_key_file(self.url, "hermes", "connector", env=self.env)
        registry = transport.ConnectorRegistry(env=self.env)
        registry.set("hermes", {"url": self.url, "keyFile": str(key)})
        target = transport.resolve_target(harness="hermes", env=self.env)
        self.assertEqual(target.url, self.url)
        self.assertEqual(target.credential.get(), "connector")
        override = transport.resolve_target(harness="hermes", flag_url="https://other.example", flag_key="flag", env=self.env)
        self.assertEqual(override.credential.get(), "flag")
        self.assertEqual(transport.resolve_target(harness="hermes", flag_url="https://other.example", env=self.env).credential.source, "none")
        if os.name != "nt":
            self.assertEqual(Path(key).stat().st_mode & 0o777, 0o600)
            Path(key).chmod(0o644)
            with self.assertRaisesRegex(PermissionError, "permissions"):
                transport.read_key_file(key)
        registry.remove("hermes")
        self.assertEqual(registry.read(), {})

    def test_typed_auth_errors_and_no_actor_headers(self):
        client = transport.SignetTransport(self.url, credential_provider=lambda: "current")
        with self.assertRaises(transport.SignetUnauthorizedError) as error:
            client.request("GET", "/protected", headers={"X-Signet-Actor": "spoof", "x-signet-actor-type": "spoof"})
        self.assertEqual(error.exception.reason, "expired")
        self.assertEqual(error.exception.status, 401)
        with self.assertRaises(transport.SignetForbiddenError) as error:
            client.request("POST", "/forbidden", {})
        self.assertEqual(error.exception.required, "audit")
        for _, headers, _ in self.received:
            self.assertNotIn("x-signet-actor", {k.lower() for k in headers})
            self.assertNotIn("x-signet-actor-type", {k.lower() for k in headers})
            self.assertEqual(headers.get("Authorization"), "Bearer current")

    def test_session_end_outbox_replays_with_current_credential(self):
        target = transport.resolve_target(flag_url=self.url, flag_key="current", env=self.env)
        client = transport.NodeTransport(target, env=self.env)
        with self.assertRaises(transport.SignetUnauthorizedError):
            client.request("POST", "/api/hooks/session-end", {"transcript": "evidence"})
        entry = client.outbox.entries()[0]
        self.authorized = True
        client.request("GET", "/success")
        self.assertEqual(client.outbox.status()["pending"], 0)
        deliveries = [r for r in self.received if r[0] == "/api/hooks/session-end"]
        self.assertEqual(deliveries[-1][1]["Idempotency-Key"], entry["idempotencyKey"])
        self.assertEqual(deliveries[-1][2], {"transcript": "evidence"})

    def test_outbox_eviction_is_persisted_and_permanent_failures_drop(self):
        box = transport.DurableOutbox(self.url, env=self.env)
        for i in range(201):
            box.enqueue("POST", "/api/hooks/session-end", {"i": i})
        self.assertEqual(box.status()["pending"], 200)
        self.assertEqual(transport.DurableOutbox(self.url, env=self.env).status()["evicted"], 1)
        self.assertEqual(box.entries()[0]["body"], {"i": 1})

        def denied(entry, deadline):
            raise transport.SignetForbiddenError("permission", "modify")

        box.flush(denied, timeout=30)
        self.assertEqual(box.status()["pending"], 0)
        self.assertEqual(box.status()["dropped"], 200)

    def test_retry_eligibility_and_deadline(self):
        client = transport.SignetTransport(self.url, retry_delay=0.001)
        for method, headers, count in (("GET", {}, 3), ("POST", {}, 1), ("POST", {"Idempotency-Key": "stable"}, 3)):
            self.received.clear()
            with self.assertRaises(transport.SignetApiError):
                client.request(method, "/busy", {}, headers=headers)
            self.assertEqual(len(self.received), count)
        self.delay = 0.2
        start = time.time()
        with self.assertRaises(transport.SignetTimeoutError):
            client.request("GET", "/slow", timeout=0.02)
        self.assertLess(time.time() - start, 0.15)

    def test_login_refresh_rotates_and_reuses_the_new_token(self):
        store = transport.LoginStore(self.url, env=self.env)
        store.save({"accessToken": "old", "refreshToken": "old-refresh", "accessExpiresAt": transport._iso(time.time() - 1), "refreshExpiresAt": transport._iso(time.time() + 120)})
        self.refresh_response = {"accessToken": "new", "refreshToken": "new-refresh", "accessExpiresAt": transport._iso(time.time() + 60), "refreshExpiresAt": transport._iso(time.time() + 120)}
        self.authorized = True
        client = transport.NodeTransport(transport.resolve_target(flag_url=self.url, env=self.env), env=self.env)
        self.assertEqual(client.request("GET", "/protected"), {"ok": True})
        saved = store.load()
        if saved is None:
            self.fail("Rotated login was not persisted")
        self.assertEqual(saved["credential"]["refreshToken"], "new-refresh")
        self.assertEqual(transport.resolve_target(flag_url=self.url, env=self.env).credential.get(), "new")
        self.assertEqual(len([r for r in self.received if r[0] == "/api/auth/refresh"]), 1)

    def test_proactive_refresh_failure_is_not_refreshed_twice(self):
        store = transport.LoginStore(self.url, env=self.env)
        store.save({"accessToken": "old", "refreshToken": "refresh", "accessExpiresAt": transport._iso(time.time() - 1), "refreshExpiresAt": transport._iso(time.time() + 120)})
        client = transport.NodeTransport(transport.resolve_target(flag_url=self.url, env=self.env), env=self.env)
        with self.assertRaises(transport.SignetUnauthorizedError):
            client.request("GET", "/protected")
        self.assertEqual(len([r for r in self.received if r[0] == "/api/auth/refresh"]), 1)

    def test_outbox_byte_limit_backoff_and_stale_lock_recovery(self):
        box = transport.DurableOutbox(self.url, env=self.env)
        with self.assertRaisesRegex(ValueError, "64 MiB"):
            box.enqueue("POST", "/api/hooks/session-end", "x" * (64 * 1024 * 1024))
        for _ in range(3):
            box.enqueue("POST", "/api/hooks/session-end", "x" * (24 * 1024 * 1024))
        self.assertEqual(box.status()["pending"], 2)
        self.assertLessEqual(box.status()["bytes"], 64 * 1024 * 1024)
        self.assertEqual(box.status()["evicted"], 1)
        box.purge()
        box.enqueue("POST", "/api/hooks/session-end", {})

        def busy(entry, deadline):
            raise transport.SignetApiError(429, {})

        with self.assertRaises(transport.SignetApiError):
            box.flush(busy)
        self.assertEqual(box.entries()[0]["attempts"], 1)
        self.assertEqual(box.flush(busy), {"pending": 1})
        self.assertEqual(box.entries()[0]["attempts"], 1)
        lock = box.directory / ".lock"
        transport._atomic_write(lock, json.dumps({"pid": 2147483647, "token": "dead", "createdAt": 0}))
        os.utime(lock, (0, 0))
        self.assertEqual(box.status()["pending"], 1)

    def test_completed_request_does_not_fail_when_automatic_replay_is_corrupt(self):
        self.authorized = True
        client = transport.NodeTransport(transport.resolve_target(flag_url=self.url, flag_key="valid", env=self.env), env=self.env)
        client.outbox.status()
        transport._atomic_write(client.outbox.directory / "00000000-0000-4000-8000-000000000000.json", "broken")
        self.assertEqual(client.request("POST", "/non-idempotent", {}), {"ok": True})
        self.assertIsNotNone(client.last_replay_error)
        self.assertEqual(len(self.received), 1)

    def test_credential_lookup_and_network_waits_respect_cancellation(self):
        self.authorized = True
        event = threading.Event()
        done = threading.Event()
        release = threading.Timer(0.25, done.set)
        release.start()
        self.addCleanup(release.join)
        client = transport.SignetTransport(self.url, credential_provider=lambda: (done.wait(), "valid")[1])
        start = time.time()
        with self.assertRaises(transport.SignetTimeoutError):
            client.request("GET", "/protected", timeout=0.025)
        self.assertLess(time.time() - start, 0.15)
        self.assertEqual(len(self.received), 0)
        self.delay = 0.25
        client = transport.SignetTransport(self.url, credential_provider=lambda: "valid")
        timer = threading.Timer(0.025, event.set)
        timer.start()
        self.addCleanup(timer.join)
        start = time.time()
        with self.assertRaises(transport.SignetNetworkError):
            client.request("GET", "/slow", cancel=event)
        self.assertLess(time.time() - start, 0.15)

    def test_stale_reaper_is_recovered(self):
        box = transport.DurableOutbox(self.url, env=self.env)
        box.status()
        for name in (".lock", ".lock.reap"):
            path = box.directory / name
            transport._atomic_write(path, json.dumps({"pid": 2147483647, "token": "dead", "createdAt": 0}))
            os.utime(path, (0, 0))
        release = threading.Timer(0.25, lambda: (box.directory / ".lock.reap").unlink(missing_ok=True))
        release.start()
        self.addCleanup(release.join)
        start = time.time()
        self.assertEqual(box.status()["pending"], 0)
        self.assertLess(time.time() - start, 0.18)

    def test_refresh_failure_preserves_policy_reason_and_cause(self):
        self.refresh_status = 403
        self.refresh_response = {"error": "policy", "reason": "org_policy", "required": "operator"}
        transport.LoginStore(self.url, env=self.env).save({"accessToken": "old", "refreshToken": "refresh", "accessExpiresAt": transport._iso(time.time() - 1), "refreshExpiresAt": transport._iso(time.time() + 120)})
        client = transport.NodeTransport(transport.resolve_target(flag_url=self.url, env=self.env), env=self.env)
        with self.assertRaises(transport.SignetUnauthorizedError) as caught:
            client.request("GET", "/protected")
        self.assertEqual(caught.exception.reason, "org_policy")
        self.assertEqual(caught.exception.status, 401)
        cause = caught.exception.cause
        if not isinstance(cause, transport.SignetApiError):
            self.fail("Refresh failure lost its original HTTP cause")
        self.assertEqual(cause.status, 403)

    def test_cancelled_keychain_read_cannot_start_a_late_refresh(self):
        self.authorized = True
        expired = {"accessToken": "old", "refreshToken": "refresh", "accessExpiresAt": transport._iso(time.time() - 1), "refreshExpiresAt": transport._iso(time.time() + 120)}
        release = threading.Event()
        class Keyring:
            calls = 0
            def get(self, service, origin):
                self.calls += 1
                if self.calls > 1:
                    release.wait()
                return json.dumps(expired)
            def set(self, service, origin, value):
                return True
        target = transport.resolve_target(flag_url=self.url, env=self.env, keyring=Keyring())
        client = transport.NodeTransport(target, env=self.env)
        cancel = threading.Event()
        stop = threading.Timer(0.025, cancel.set)
        unblock = threading.Timer(0.2, release.set)
        stop.start(); unblock.start()
        self.addCleanup(stop.join); self.addCleanup(unblock.join)
        with self.assertRaises(transport.SignetNetworkError):
            client.request("GET", "/protected", cancel=cancel, timeout=1)
        self.assertTrue(release.wait(1))
        time.sleep(0.15)
        self.assertEqual(self.received, [])

    def test_reactive_refresh_keychain_waits_are_bounded(self):
        original = {"accessToken": "old", "refreshToken": "refresh", "accessExpiresAt": transport._iso(time.time() + 60), "refreshExpiresAt": transport._iso(time.time() + 120)}
        self.refresh_response = {**original, "accessToken": "rotated", "refreshToken": "rotated-refresh"}
        for phase in ("get", "set"):
            for limit in ("cancel", "deadline"):
                with self.subTest(phase=phase, limit=limit):
                    entered = threading.Event()
                    release = threading.Event()
                    cancel = threading.Event()
                    class Keyring:
                        calls = 0
                        def get(self, service, origin):
                            self.calls += 1
                            if phase == "get" and self.calls == 3:
                                entered.set()
                                release.wait()
                            return json.dumps(original)
                        def set(self, service, origin, value):
                            if phase == "set":
                                entered.set()
                                release.wait()
                            return True
                    client = transport.NodeTransport(transport.resolve_target(flag_url=self.url, env=self.env, keyring=Keyring()), env=self.env)
                    def unblock():
                        entered.wait(1)
                        if limit == "cancel":
                            time.sleep(0.025)
                            cancel.set()
                        time.sleep(0.3)
                        release.set()
                    helper = threading.Thread(target=unblock)
                    helper.start()
                    start = time.time()
                    try:
                        error_type = transport.SignetNetworkError if limit == "cancel" else transport.SignetTimeoutError
                        with self.assertRaises(error_type):
                            client.request("GET", "/protected", cancel=cancel, timeout=1 if limit == "cancel" else 0.12)
                        self.assertTrue(entered.is_set())
                        self.assertLess(time.time() - start, 0.22)
                    finally:
                        release.set()
                        helper.join()

    def test_automatic_replay_cancellation_preserves_completed_result(self):
        self.authorized = True
        entered = self.replay_entered = threading.Event()
        release = self.replay_release = threading.Event()
        cancel = threading.Event()
        client = transport.NodeTransport(transport.resolve_target(flag_url=self.url, flag_key="valid", env=self.env), env=self.env)
        client.outbox.enqueue("POST", "/api/hooks/session-end", {"transcript": "pending"})
        def stop():
            entered.wait(1)
            time.sleep(0.025)
            cancel.set()
            time.sleep(0.3)
            release.set()
        helper = threading.Thread(target=stop)
        helper.start()
        start = time.time()
        try:
            self.assertEqual(client.request("GET", "/success", cancel=cancel, timeout=1), {"ok": True})
            self.assertTrue(self.replay_entered.is_set())
            self.assertLess(time.time() - start, 0.22)
            self.assertIsInstance(client.last_replay_error, transport.SignetNetworkError)
        finally:
            release.set()
            helper.join()
        self.assertEqual(client.outbox.status()["pending"], 1)

    def test_deadlines_are_validated_before_dispatch(self):
        self.authorized = True
        client = transport.NodeTransport(transport.resolve_target(flag_url=self.url, flag_key="valid", env=self.env), env=self.env)
        with self.subTest(operation="request"):
            with self.assertRaises(transport.SignetTimeoutError):
                client.request("GET", "/protected", deadline=0)
            self.assertEqual(self.received, [])
        with self.subTest(operation="replay"):
            client.outbox.enqueue("POST", "/api/hooks/session-end", {})
            delivered = []
            with self.assertRaises(transport.SignetTimeoutError):
                client.outbox.flush(lambda entry, end: delivered.append(entry), deadline=0)
            self.assertEqual(delivered, [])
            self.assertEqual(client.outbox.status()["pending"], 1)
        for selected in (client, transport.SignetTransport(self.url)):
            for invalid in (float("inf"), float("-inf"), float("nan")):
                with self.subTest(client=type(selected).__name__, deadline=str(invalid)):
                    with self.assertRaises(ValueError):
                        selected.request("GET", "/protected", deadline=invalid)

    def test_failed_replay_is_observable_until_a_complete_flush(self):
        self.authorized = True
        client = transport.NodeTransport(transport.resolve_target(flag_url=self.url, flag_key="valid", env=self.env), env=self.env, retries=0)
        client.outbox.enqueue("POST", "/busy", {})
        self.assertEqual(client.request("GET", "/success"), {"ok": True})
        error = client.last_replay_error
        if not isinstance(error, transport.SignetApiError):
            self.fail("Automatic replay lost its original HTTP failure")
        self.assertEqual(error.status, 503)
        self.assertEqual(client.flush(), {"pending": 1})
        self.assertIs(client.last_replay_error, error)
        self.busy_status = 200
        self.assertEqual(client.flush(force=True), {"pending": 0})
        self.assertIsNone(client.last_replay_error)
        self.assertEqual(client.outbox.status()["pending"], 0)

    def test_target_resolution_admission_bounds_blocked_keychains(self):
        entered = threading.Event()
        release = threading.Event()
        mutex = threading.Lock()
        failures = []
        class Keyring:
            calls = 0
            def get(self, service, origin):
                with mutex:
                    self.calls += 1
                    if self.calls == 4:
                        entered.set()
                release.wait()
                return None
        keyring = Keyring()
        def resolve():
            try:
                transport.resolve_target(flag_url=self.url, env=self.env, keyring=keyring)
            except Exception as error:
                failures.append(error)
        callers = [threading.Thread(target=resolve) for _ in range(4)]
        for caller in callers:
            caller.start()
        unblock = threading.Timer(0.35, release.set)
        unblock.start()
        try:
            self.assertTrue(entered.wait(1))
            start = time.time()
            with self.assertRaises(transport.SignetNetworkError):
                transport.resolve_target(flag_url=self.url, env=self.env, keyring=keyring)
            self.assertLess(time.time() - start, 0.2)
            self.assertEqual(keyring.calls, 4)
        finally:
            release.set()
            unblock.join()
            for caller in callers:
                caller.join()
        self.assertEqual(failures, [])

    def test_target_resolution_honors_deadline_and_cancellation(self):
        for limit in ("cancel", "deadline"):
            with self.subTest(limit=limit):
                entered = threading.Event()
                release = threading.Event()
                cancel = threading.Event()
                class Keyring:
                    def get(self, service, origin):
                        entered.set()
                        release.wait()
                        return None
                def stop():
                    entered.wait(1)
                    if limit == "cancel":
                        time.sleep(0.025)
                        cancel.set()
                    time.sleep(0.3)
                    release.set()
                helper = threading.Thread(target=stop)
                helper.start()
                start = time.time()
                try:
                    error_type = transport.SignetNetworkError if limit == "cancel" else transport.SignetTimeoutError
                    with self.assertRaises(error_type):
                        transport.resolve_target(flag_url=self.url, env=self.env, keyring=Keyring(), cancel=cancel, timeout=1 if limit == "cancel" else 0.1)
                    self.assertTrue(entered.is_set())
                    self.assertLess(time.time() - start, 0.2)
                finally:
                    release.set()
                    helper.join()

    def test_unsupported_origins_fail_instead_of_splitting_storage(self):
        invalid = ["https://a\u200db.example", "https://a\u034fb.example", "https://a\u3164b.example", "https://a\ufe52b.example", "http://[fe80::1%25eth0]", "http://example..123", "https://" + "a" * 4100 + ".example"]
        for raw in invalid:
            with self.subTest(origin=raw[:80]):
                with self.assertRaises(ValueError):
                    transport.resolve_target(flag_url=raw, flag_key="fixture", env=self.env)

    def test_environment_hosts_follow_core_resolver_validation(self):
        for host in ("bücher.example", "host_name", "example.com.", "host-"):
            with self.subTest(host=host):
                with self.assertRaises(ValueError):
                    transport.resolve_target(flag_key="fixture", env={**self.env, "SIGNET_HOST": host})
                self.assertEqual(transport.resolve_target(flag_url=self.url, flag_key="fixture", env={**self.env, "SIGNET_HOST": host}).url, self.url)

    def test_non_json_numbers_cannot_be_dispatched_or_admitted(self):
        self.authorized = True
        client = transport.NodeTransport(transport.resolve_target(flag_url=self.url, flag_key="fixture", env=self.env), env=self.env)
        plain = transport.SignetTransport(self.url)
        for value in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(value=str(value)):
                with self.assertRaises(ValueError):
                    plain.request("POST", "/ordinary", {"value": value})
                with self.assertRaises(transport.SignetOutboxAdmissionError):
                    client.request("POST", "/api/hooks/session-end", {"value": value})
        self.assertEqual(self.received, [])
        self.assertEqual(client.outbox.status()["pending"], 0)

    def test_replay_uses_captured_scope_not_current_transport_headers(self):
        target = transport.resolve_target(flag_url=self.url, flag_key="fixture", env=self.env)
        original = transport.NodeTransport(target, env=self.env, headers={"X-Signet-Agent-Id": "alpha", "x-signet-runtime-path": "/original", "x-signet-harness": "hermes"})
        with self.assertRaises(transport.SignetUnauthorizedError):
            original.request("POST", "/api/hooks/session-end", {"agentId": "alpha", "harness": "hermes", "sessionKey": "session", "transcript": "evidence"})
        entry = original.outbox.entries()[0]
        self.assertEqual(entry["origin"], target.origin)
        self.assertEqual(entry["headers"]["x-signet-agent-id"], "alpha")
        self.authorized = True
        replay = transport.NodeTransport(target, env=self.env, headers={"x-signet-agent-id": "beta", "x-signet-session-key": "wrong", "x-signet-runtime-path": "/other", "x-signet-harness": "codex"})
        self.assertEqual(replay.flush(force=True), {"pending": 0})
        self.assertEqual(self.received[0], self.received[1])

    def test_foreign_origin_entries_are_never_replayed(self):
        first = transport.DurableOutbox("https://first.example", env=self.env)
        second = transport.DurableOutbox("https://second.example", env=self.env)
        entry = first.enqueue("POST", "/api/hooks/session-end", {})
        second.status()
        transport._atomic_write(second.directory / (entry["id"] + ".json"), json.dumps(entry))
        sent = []
        self.assertEqual(second.flush(lambda entry, end: sent.append(entry)), {"pending": 1})
        self.assertEqual(sent, [])
        self.assertEqual(second.entries(), [entry])

    def test_cross_process_registry_updates_do_not_overwrite(self):
        script = "from signet_transport import ConnectorRegistry; import sys; r=ConnectorRegistry(); r.set(sys.argv[1], {'url':'https://org.example'})"
        children = [subprocess.Popen([sys.executable, "-c", script, "h%s" % i], env={**os.environ, "HOME": self.home, "PYTHONPATH": str(Path(__file__).parent)}, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for i in range(6)]
        for child in children:
            _, err = child.communicate(timeout=15)
            self.assertEqual(child.returncode, 0, err)
        self.assertEqual(len(transport.ConnectorRegistry(env=self.env).read()), 6)


if __name__ == "__main__":
    unittest.main()
