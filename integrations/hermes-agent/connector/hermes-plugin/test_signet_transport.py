import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import threading
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import signet_transport as transport


class TransportTests(unittest.TestCase):
    def test_scope_disposition_survives_exit_after_first_settlement_move(self):
        module_dir = str(Path(transport.__file__).parent)
        code = '''import os,sys
from pathlib import Path
import signet_transport as t
box=t.DurableOutbox("https://remote.example",env={"HOME":sys.argv[1]},harness="hermes")
box.enqueue("POST","/api/hooks/session-end",{"evidence":"retained"})
original=t._rename_private
def rename(source,target,*args,**kwargs):
 result=original(source,target,*args,**kwargs)
 if Path(source).parent==box.directory/".claims" and Path(source).suffix==".json":os._exit(77)
 return result
t._rename_private=rename
def denied(*args):raise t.SignetForbiddenError("permission")
box.flush(denied,force=True)
sys.exit(78)
'''
        result = subprocess.run([sys.executable,"-c",code,self.home],cwd=module_dir,capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,77,result.stderr)
        box = transport.DurableOutbox("https://remote.example",env=self.env,harness="hermes")
        sent = []
        box.flush(lambda entry,end:sent.append(entry),force=True)
        self.assertEqual(sent,[])
        status=box.status()
        self.assertEqual(status["pending"],0)
        self.assertEqual(status["quarantined"],1)
        self.assertEqual(status["dropped"],0)

    def test_newer_expired_login_after_rotation_never_dispatches_without_bearer(self):
        old = {"accessToken":"old","refreshToken":"old-refresh","accessExpiresAt":transport._iso(time.time()-60),"refreshExpiresAt":transport._iso(time.time()+120)}
        rotated = {**old,"accessToken":"rotated","refreshToken":"rotated-refresh","accessExpiresAt":transport._iso(time.time()+60)}
        newer = {**old,"accessToken":"newer-expired","refreshToken":"newer-refresh"}
        saved = [json.dumps(old)]
        class Keyring:
            def get(self,*args):
                return saved[0]
            def set(self,*args):
                saved[0] = args[-1]
                return True
        original = transport.SignetTransport.request
        def request(client,method,path,body=None,**options):
            if path == "/api/auth/refresh":
                saved[0] = json.dumps(newer)
                return rotated
            return original(client,method,path,body,**options)
        client = transport.NodeTransport(transport.resolve_target(flag_url=self.url,env=self.env,keyring=Keyring()),env=self.env)
        with patch.object(transport.SignetTransport,"request",request):
            with self.assertRaises(transport.SignetCredentialError):
                client.request("GET","/protected")
        self.assertEqual(self.received,[])
        self.assertEqual(json.loads(saved[0]),newer)

    def test_settlement_failure_does_not_replace_credential_failure(self):
        box = transport.DurableOutbox(self.url,env=self.env)
        held, release = threading.Event(), threading.Event()
        thread = None
        failure = transport.SignetCredentialError(OSError("provider unavailable"))
        def holder():
            with transport._lock(box.directory/".lock"):
                held.set()
                release.wait(1)
        def send(*args):
            nonlocal thread
            thread = threading.Thread(target=holder)
            thread.start()
            self.assertTrue(held.wait(1))
            raise failure
        try:
            with self.assertRaises(transport.SignetCredentialError) as caught:
                box.deliver("POST","/api/hooks/session-end",{},send,deadline=(time.time()+0.25)*1000)
            self.assertIs(caught.exception,failure)
        finally:
            release.set()
            if thread:
                thread.join(2)

    def test_new_login_and_clear_confirm_durable_marker_deletion(self):
        store = transport.LoginStore(self.url,env=self.env)
        value = {"accessToken":"fixture","refreshToken":"fixture-refresh","accessExpiresAt":transport._iso(time.time()+60),"refreshExpiresAt":transport._iso(time.time()+120)}
        original_unlink, original_sync = Path.unlink, transport._sync_directory
        for operation in ("save","clear"):
            with self.subTest(operation=operation):
                store.save(value)
                marker = Path(str(store.path)+".state")
                transport._atomic_write(marker,json.dumps({"state":"dead","reason":"revoked"}))
                removed = []
                def unlink(path,*args,**kwargs):
                    result = original_unlink(path,*args,**kwargs)
                    if path == marker:
                        removed.append(True)
                    return result
                def sync(path):
                    if removed and Path(path) == store.path.parent:
                        raise OSError("marker deletion unconfirmed")
                    return original_sync(path)
                with patch.object(Path,"unlink",unlink),patch.object(transport,"_sync_directory",side_effect=sync):
                    with self.assertRaisesRegex(OSError,"marker deletion unconfirmed"):
                        store.save(value) if operation == "save" else store.clear()

    def test_private_directory_links_cannot_redirect_state(self):
        for nested in (False, True):
            with self.subTest(nested=nested):
                root = Path(self.home)/str(nested)
                root.mkdir()
                outside = root/"outside"
                outside.mkdir(mode=0o755)
                link = root/"private"
                link.symlink_to(outside, target_is_directory=True)
                path = link/"nested"/"state.json" if nested else link/"state.json"
                with self.assertRaises((ValueError,PermissionError)):
                    transport._atomic_write(path,"data")
                self.assertEqual(list(outside.iterdir()),[])
                self.assertEqual(outside.stat().st_mode & 0o777,0o755)

    def test_untyped_explicit_refresh_provider_is_a_credential_error(self):
        calls = []
        def refresh(*args):
            calls.append(True)
            raise OSError("Storage unavailable")
        credential = transport.Credential("flag",lambda *args:"fixture",refresh)
        target = transport.ResolvedTarget(self.url,self.url,credential,False)
        client = transport.NodeTransport(target,env=self.env)
        with self.assertRaises(transport.SignetCredentialError):
            client.request("GET","/protected")
        self.assertEqual(len(calls),1)

    def test_another_module_instance_cannot_reclaim_an_active_delivery(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("second_signet_transport", transport.__file__)
        if spec is None or spec.loader is None:
            raise AssertionError("Transport module cannot be loaded")
        other = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(other)
        box = transport.DurableOutbox("https://remote.example", env=self.env, harness="hermes")
        box.enqueue("POST", "/api/hooks/session-end", {"original": True})
        entered, release = threading.Event(), threading.Event()
        results = []
        def send(entry, deadline):
            entered.set()
            release.wait(2)
        thread = threading.Thread(target=lambda: results.append(box.flush(send, force=True)))
        thread.start()
        try:
            self.assertTrue(entered.wait(2))
            replayed = []
            second = other.DurableOutbox(box.origin, env=self.env, harness="hermes")
            second.flush(lambda entry, deadline: replayed.append(entry), force=True)
            self.assertEqual(replayed, [])
        finally:
            release.set()
            thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(results[0]["state"], "complete")

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

    @unittest.skipUnless(sys.platform.startswith("linux"),"Linux ownership race")
    def test_stale_lock_cleanup_preserves_replacement_generation(self):
        path=Path(self.home)/"mutex"
        state={"armed":False,"swapped":False}
        replacement={"pid":os.getpid(),"token":"replacement","startTime":"linux:"+Path("/proc/self/stat").read_text().rsplit(")",1)[1].split()[19],"createdAt":int(time.time()*1000)}
        original_read=transport._read_private
        original_unlink=Path.unlink
        def swap():
            if not state["swapped"]:
                state["swapped"]=True
                path.replace(Path(str(path)+".previous"))
                path.write_text(json.dumps(replacement))
                path.chmod(0o600)
        def read(candidate,*args,**kwargs):
            text=original_read(candidate,*args,**kwargs)
            if Path(candidate)==path and state["armed"] and not state["swapped"]:
                swap()
            return text
        def unlink(candidate,*args,**kwargs):
            if candidate==path and state["armed"] and not state["swapped"]:
                swap()
            return original_unlink(candidate,*args,**kwargs)
        with patch.object(transport,"_read_private",side_effect=read),patch.object(Path,"unlink",unlink):
            with transport._lock(path):
                if path.exists():
                    state["armed"]=True
                else:
                    path.write_text(json.dumps(replacement))
                    path.chmod(0o600)
                    state["swapped"]=True
        self.assertEqual(json.loads(path.read_text())["token"],"replacement")

    def test_injected_keyring_successful_writes_and_clear(self):
        class Adapter:
            value=None
            def get(self,service,origin):
                return self.value
            def set(self,service,origin,value):
                self.value=value
                return True
        store=transport.LoginStore(self.url,env=self.env,keyring=Adapter())
        credential={"accessToken":"fixture","refreshToken":"fixture-refresh","accessExpiresAt":"2099-01-01T00:00:00Z","refreshExpiresAt":"2099-01-01T00:00:00Z"}
        self.assertEqual(store.save(credential),"keychain")
        self.assertFalse(store.path.exists())
        self.assertEqual(store.get(),credential["accessToken"])
        store.clear()
        self.assertIsNone(store.load())

    def test_existing_store_observes_another_store_new_login(self):
        first=transport.LoginStore(self.url,env=self.env)
        credential={"accessToken":"fixture","refreshToken":"fixture-refresh","accessExpiresAt":"2020-01-01T00:00:00Z","refreshExpiresAt":"2099-01-01T00:00:00Z"}
        first.save(credential)
        self.refresh_status=401
        self.refresh_response={"reason":"revoked"}
        with self.assertRaises(transport.SignetUnauthorizedError):
            first.get()
        transport.LoginStore(self.url,env=self.env).save({**credential,"accessToken":"new-login-fixture","refreshToken":"new-login-refresh","accessExpiresAt":"2099-01-01T00:00:00Z"})
        self.assertEqual(first.get(),"new-login-fixture")

    def test_post_rotation_reread_failure_is_in_doubt(self):
        store=transport.LoginStore(self.url,env=self.env)
        store.save({"accessToken":"fixture","refreshToken":"fixture-refresh","accessExpiresAt":"2020-01-01T00:00:00Z","refreshExpiresAt":"2099-01-01T00:00:00Z"})
        self.refresh_response={"accessToken":"new-pair-fixture","refreshToken":"new-pair-refresh","accessExpiresAt":"2099-01-01T00:00:00Z","refreshExpiresAt":"2099-01-01T00:00:00Z"}
        original=transport._read_private
        def unreadable(path,*args,**kwargs):
            if Path(path)==store.path and any(row[0]=="/api/auth/refresh" for row in self.received):
                raise PermissionError("credential store unreadable")
            return original(path,*args,**kwargs)
        with patch.object(transport,"_read_private",side_effect=unreadable):
            try:
                store.get()
            except Exception as error:
                self.assertEqual(getattr(error,"reason",None),"refresh_in_doubt")
            else:
                self.fail("post-rotation storage error was swallowed")
        self.assertEqual(store.get(),"new-pair-fixture")
        self.assertEqual(len([row for row in self.received if row[0]=="/api/auth/refresh"]),1)

    def test_python_file_store_does_not_claim_keyring_unavailable(self):
        store = transport.LoginStore(self.url,env=self.env)
        store.save({"accessToken":"fixture", "refreshToken":"fixture", "accessExpiresAt":"2099-01-01T00:00:00Z", "refreshExpiresAt":"2099-01-01T00:00:00Z"})
        self.assertEqual(store.reason,"python_file_store")
        saved=transport.LoginStore(self.url,env=self.env).load()
        self.assertIsNotNone(saved)
        if saved is not None:
            self.assertEqual(saved["source"],"login-file")

    @unittest.skipUnless(sys.platform.startswith("linux"),"Linux descriptor accounting")
    def test_directory_key_is_rejected_without_leaking_a_handle(self):
        directory=Path(self.home)/"not-a-key"
        directory.mkdir(mode=0o700)
        before=len(os.listdir("/proc/self/fd"))
        for unused in range(20):
            with self.assertRaisesRegex(ValueError,"type"):
                transport.read_key_file(directory)
        self.assertEqual(len(os.listdir("/proc/self/fd")),before)

    def test_windows_acl_cache_tracks_security_change_time(self):
        key = Path(self.home)/"change.key"
        key.write_text("fixture")
        key.chmod(0o600)
        state = {"revision":1,"private":True}
        def helper(*args,**options):
            if not state["private"]:
                raise PermissionError("Unsafe permissions")
            return None
        with patch.object(transport,"_WINDOWS",True,create=True), patch.object(transport,"_security_change_time",side_effect=lambda path,info:state["revision"],create=True), patch.object(transport,"_acl_operation",side_effect=helper):
            self.assertEqual(transport.read_key_file(key),"fixture")
            state.update({"revision":2,"private":False})
            with self.assertRaises(PermissionError):
                transport.read_key_file(key)

    def test_windows_acl_read_validation_is_cached(self):
        key = Path(self.home)/"fixture.key"
        key.write_text("fixture")
        key.chmod(0o600)
        def helper(*args, **options):
            path = args[0]
            if Path(path).stat().st_mode & 0o077:
                raise PermissionError("Unsafe permissions")
            return None
        with patch.object(transport,"_WINDOWS",True,create=True), patch.object(transport,"_acl_operation",side_effect=helper) as calls:
            for unused in range(20):
                self.assertEqual(transport.read_key_file(key),"fixture")
            self.assertEqual(calls.call_count,1)
            key.chmod(0o644)
            with self.assertRaises(PermissionError):
                transport.read_key_file(key)
            self.assertEqual(calls.call_count,2)

    def legacy_file(self, box, entry):
        return next(q["file"] for q in box.status()["quarantine"] if q["file"].startswith(entry["id"]+".json"))

    def seed_legacy(self, box, **changes):
        value = {"origin":box.origin,"headers":{},"id":str(uuid.uuid4()),"idempotencyKey":"original-key","method":"POST","path":"/api/hooks/session-end","body":{"evidence":"original"},"createdAt":transport._iso(time.time()),"attempts":3,"lastError":"http_401"}
        value.update(changes)
        root = box.directory.parent
        transport._atomic_write(root/(value["id"]+".json"), json.dumps(value))
        return value

    def test_legacy_quarantine_recovery_and_explicit_purge(self):
        box = transport.DurableOutbox(self.url, env=self.env, harness="hermes")
        old = self.seed_legacy(box)
        transport._atomic_write(box.directory.parent/".status.json", json.dumps({"evicted":7,"dropped":2,"lastDrop":None,"removing":[]}))
        transport._directory(box.directory.parent/"other.json")
        status = box.status()
        self.assertEqual(status["quarantined"], 2)
        record = next(q for q in status["quarantine"] if q["file"].startswith(old["id"]+".json"))
        self.assertEqual(record["reason"], "legacy_unattributed")
        self.assertEqual(box.flush(lambda *args:self.fail("legacy sent"))["state"], "deferred")
        box.purge()
        self.assertEqual(box.status()["quarantined"], 2)
        with self.assertRaises(ValueError):
            box.recover_legacy(record["file"], "claude")
        restored = box.recover_legacy(record["file"], "hermes")
        self.assertEqual(restored, {**old,"version":1,"harness":"hermes","headers":{}})
        self.assertEqual(box.entries(), [restored])
        metadata = next(q["file"] for q in status["quarantine"] if q["reason"] == "legacy_metadata")
        self.assertEqual(json.loads((box.directory.parent/".legacy-quarantine"/metadata).read_text())["evicted"],7)
        self.assertFalse((box.directory.parent/".legacy-quarantine"/record["file"]).exists())
        box.purge(include_legacy=True)
        self.assertEqual(box.status()["quarantined"], 0)
        self.assertTrue((box.directory.parent/"other.json").is_dir())

    def test_legacy_capacity_foreign_origin_and_failed_move_binding(self):
        box = transport.DurableOutbox(self.url, env=self.env, harness="hermes")
        old = self.seed_legacy(box)
        box.status()
        with patch.object(box,"MAX_ENTRIES",1):
            with self.assertRaises(ValueError):
                box.enqueue("POST","/api/hooks/session-end",{})
        original = transport._rename_private
        def fail_move(source, target, durable=True):
            if Path(target).parent == box.directory:
                raise OSError("move unavailable")
            return original(source,target,durable)
        with patch.object(transport,"_rename_private",side_effect=fail_move):
            with self.assertRaises(OSError):
                box.recover_legacy(self.legacy_file(box,old),"hermes")
        other = transport.DurableOutbox(self.url,env=self.env,harness="claude")
        with self.assertRaises(ValueError):
            other.recover_legacy(self.legacy_file(box,old),"claude")
        self.assertEqual(box.recover_legacy(self.legacy_file(box,old),"hermes")["id"],old["id"])
        foreign = self.seed_legacy(box, origin="https://foreign.example")
        with self.assertRaises(ValueError):
            box.recover_legacy(self.legacy_file(box,foreign),"hermes")

    def test_windows_mutation_cannot_bless_changed_directory_acl(self):
        directory = Path(self.home)/"private"
        directory.mkdir(mode=0o700)
        state = {"private":True,"revision":1}
        def verify(*args, **kwargs):
            if not state["private"]:
                raise PermissionError("Unsafe permissions")
        with patch.object(transport,"_WINDOWS",True), patch.object(transport,"_security_change_time",side_effect=lambda *args:state["revision"]), patch.object(transport,"_acl_operation",side_effect=verify,create=True), patch.object(transport.subprocess,"run",side_effect=verify):
            transport._windows_acl(directory,True)
            state.update(private=False,revision=2)
            (directory/"child").touch()
            transport._remember_directory_mutation(directory)
            with self.assertRaises(PermissionError):
                transport._windows_acl(directory,True)

    def test_windows_temp_is_verified_before_payload_write(self):
        target = Path(self.home)/"private"/"value"
        checks = []
        def verify(path, directory=False, write=False, **kwargs):
            if not directory:
                checks.append(Path(path).read_bytes())
                raise PermissionError("ACL protection failed")
        with patch.object(transport,"_WINDOWS",True),patch.object(transport,"_windows_acl",side_effect=verify):
            with self.assertRaises(PermissionError):
                transport._atomic_write(target,"payload")
        self.assertEqual(checks,[b""])
        self.assertFalse(target.exists())

    def test_windows_nonkey_links_refused_secure_key_link_allowed(self):
        target = Path(self.home)/"target"
        target.write_text("fixture")
        target.chmod(0o600)
        link = Path(self.home)/"link"
        link.symlink_to(target)
        with patch.object(transport,"_WINDOWS",True),patch.object(transport,"_acl_operation",return_value=None,create=True),patch.object(transport.subprocess,"run"),patch.object(transport.os,"O_NOFOLLOW",0):
            with self.assertRaises(ValueError):
                transport._read_private(link)
            self.assertEqual(transport.read_key_file(link),"fixture")

    def test_cancelled_claim_settlement_and_status_do_not_wait(self):
        box = transport.DurableOutbox(self.url, env=self.env)
        box.enqueue("POST","/api/hooks/session-end",{})
        cancel = threading.Event()
        held = threading.Event()
        release = threading.Event()
        cancelled_at = []
        self.delay = 0.4
        def holder():
            with transport._lock(box.directory/".lock"):
                held.set()
                until = time.time()+1
                while not self.received and time.time() < until and not release.is_set():
                    release.wait(0.001)
                cancelled_at.append(time.time())
                cancel.set()
                release.wait(0.6)
        thread = None
        def send(entry, end):
            nonlocal thread
            thread = threading.Thread(target=holder)
            thread.start()
            self.assertTrue(held.wait(1))
            return transport.SignetTransport(self.url,retries=0).request("POST",entry["path"],entry["body"],deadline=end,cancel=cancel)
        try:
            result = box.flush(send,cancel=cancel,force=True)
            self.assertLess(time.time()-cancelled_at[0],0.2)
            self.assertEqual(result["state"],"failed")
            self.assertEqual(self.received[0][0],"/api/hooks/session-end")
            self.assertEqual(len(list((box.directory/".claims").glob("*.json"))),1)
        finally:
            release.set()
            if thread:
                thread.join()
        sent = []
        retried = box.flush(lambda entry,end:sent.append(entry),force=True)
        self.assertEqual(retried["state"],"complete")
        self.assertEqual(len(sent),1)

    def test_windows_acl_worker_reuses_process_and_expires_idle(self):
        real_popen = subprocess.Popen
        children = []
        script = "import sys,json\nfor line in sys.stdin:\n value=json.loads(line); print(json.dumps({'ok':True}),flush=True)"
        def spawn(args, **kwargs):
            self.assertNotIn(self.home," ".join(args))
            process = real_popen([sys.executable,"-u","-c",script],**kwargs)
            children.append(process)
            return process
        previous = transport._ACL_WORKER
        if previous:
            previous.close()
        paths = [Path(self.home)/str(index) for index in range(5)]
        for path in paths:
            path.write_text("fixture")
        with patch.object(transport,"_WINDOWS",True),patch.object(transport,"_ACL_WORKER",None),patch.object(transport,"_ACL_IDLE_SECONDS",0.15),patch.object(transport.subprocess,"Popen",side_effect=spawn):
            try:
                for path in paths:
                    transport._windows_acl(path)
                self.assertEqual(len(children),1)
                worker = transport._ACL_WORKER
                self.assertTrue(worker.thread.daemon)
                worker.thread.join(0.8)
                self.assertTrue(worker.closed.is_set())
                self.assertIsNotNone(children[0].poll())
                transport._acl_operation(Path(self.home)/"restart")
                self.assertEqual(len(children),2)
            finally:
                worker = transport._ACL_WORKER
                if worker:
                    worker.close()
                    worker.thread.join(0.8)

    def test_legacy_recovery_preserves_captured_scope_and_checks_collision(self):
        box = transport.DurableOutbox(self.url,env=self.env,harness="hermes")
        headers = {"x-signet-agent-id":"captured-agent","x-signet-session-key":"captured-session"}
        old = self.seed_legacy(box,headers=headers)
        restored = box.recover_legacy(self.legacy_file(box,old),"hermes")
        self.assertEqual(restored,{**old,"version":1,"harness":"hermes"})
        second = self.seed_legacy(box,**old)
        with self.assertRaisesRegex(ValueError,"collision"):
            box.recover_legacy(self.legacy_file(box,second),"hermes")
        self.assertEqual(box.entries(),[restored])

    def test_windows_nonkey_reparse_attribute_is_refused(self):
        from types import SimpleNamespace
        path = Path(self.home)/"reparse"
        path.write_text("fixture")
        original = Path.lstat
        def reparse(candidate, *args, **kwargs):
            info = original(candidate,*args,**kwargs)
            if candidate == path:
                return SimpleNamespace(st_mode=info.st_mode,st_file_attributes=0x400)
            return info
        with patch.object(transport,"_WINDOWS",True),patch.object(Path,"lstat",reparse):
            with self.assertRaisesRegex(ValueError,"type"):
                transport._read_private(path)

    def test_windows_acl_worker_bounds_output_and_timeout(self):
        real_popen = subprocess.Popen
        for script in ("import time; time.sleep(3)","print('x'*256,flush=True)"):
            children = []
            def spawn(args, **kwargs):
                process = real_popen([sys.executable,"-u","-c",script],**kwargs)
                children.append(process)
                return process
            with self.subTest(script=script),patch.object(transport,"_ACL_WORKER",None),patch.object(transport.subprocess,"Popen",side_effect=spawn):
                start = time.monotonic()
                with self.assertRaises(PermissionError) as caught:
                    transport._acl_operation(Path(self.home)/"private")
                self.assertLess(time.monotonic()-start,1.15)
                self.assertNotIn(self.home,str(caught.exception))
                worker = transport._ACL_WORKER
                worker.thread.join(0.8)
                self.assertTrue(worker.closed.is_set())
                self.assertTrue(all(child.poll() is not None for child in children))

    def test_outbox_same_origin_is_partitioned_by_harness(self):
        a = transport.NodeTransport(transport.resolve_target(harness="hermes", flag_url=self.url, flag_key="fixture", env=self.env), env=self.env)
        b = transport.NodeTransport(transport.resolve_target(harness="claude", flag_url=self.url, flag_key="fixture", env=self.env), env=self.env)
        a.outbox.enqueue("POST", "/api/hooks/session-end", {})
        self.assertNotEqual(a.outbox.directory, b.outbox.directory)
        self.assertEqual(b.outbox.status()["pending"], 0)

    def test_scope_403_quarantines_and_purges(self):
        box = transport.DurableOutbox(self.url, env=self.env)
        box.enqueue("POST", "/api/hooks/session-end", {})
        def send(entry, deadline=None):
            raise transport.SignetForbiddenError("permission")
        box.flush(send, force=True)
        self.assertEqual(box.status()["quarantined"], 1)
        self.assertEqual(box.status()["dropped"], 0)
        box.purge()
        self.assertEqual(box.status()["quarantined"], 0)

    def test_empty_flush_honors_cancel_and_expired_deadline(self):
        cancelled = threading.Event()
        cancelled.set()
        for cancel, deadline, code in ((cancelled,None,"SignetNetworkError"),(None,0,"SignetTimeoutError")):
            with self.subTest(code=code):
                box = transport.DurableOutbox(self.url,env=self.env)
                result = box.flush(lambda *_: self.fail("empty flush dispatched"),cancel=cancel,deadline=deadline)
                self.assertEqual(result["state"],"failed")
                failure = result["failure"]
                if failure is None:
                    self.fail("cancelled flush has no failure")
                self.assertEqual(failure["code"],code)
                self.assertFalse(box.directory.exists())

    def test_get_and_empty_flush_do_not_create_storage(self):
        self.authorized = True
        target = transport.resolve_target(flag_url=self.url, flag_key="fixture", env=self.env)
        client = transport.NodeTransport(target, env=self.env)
        client.request("GET", "/health")
        self.assertFalse(transport.config_directory(self.env).exists())
        client.flush()
        self.assertFalse(transport.config_directory(self.env).exists())

    def test_send_does_not_hold_outbox_lock(self):
        box = transport.DurableOutbox(self.url, env=self.env)
        box.enqueue("POST", "/api/hooks/session-end", {})
        entered, release = threading.Event(), threading.Event()
        def send(entry, deadline=None):
            entered.set()
            release.wait(2)
        thread = threading.Thread(target=lambda: box.flush(send, force=True))
        thread.start()
        self.assertTrue(entered.wait(1))
        try:
            box.enqueue("POST", "/api/hooks/session-end", {"second":True}, deadline=(time.time()+0.2)*1000)
        finally:
            release.set()
            thread.join(2)
        self.assertEqual(box.status()["pending"], 1)

    def test_poison_and_bad_records_are_quarantined_not_fatal(self):
        for case in ("attempts", "age", "parse", "version", "mode"):
            box = transport.DurableOutbox(self.url, env=self.env)
            entry = box.enqueue("POST", "/api/hooks/session-end", {})
            path = box.directory / (entry["id"]+".json")
            entry.update({"attempts":20 if case == "attempts" else 0, "createdAt":"2020-01-01T00:00:00Z" if case == "age" else entry["createdAt"]})
            if case == "version":
                entry["version"] = 999
            path.write_text("{" if case == "parse" else json.dumps(entry))
            path.chmod(0o644 if case == "mode" else 0o600)
            calls = []
            with self.subTest(case=case):
                box.flush(lambda entry, deadline=None: calls.append(entry), force=True)
                self.assertEqual(calls, [])
                self.assertEqual(box.status()["quarantined"], 1)
            box.purge()

    def test_purge_scans_corrupt_records_and_reaps_stale_tmp(self):
        box = transport.DurableOutbox(self.url, env=self.env)
        entry = box.enqueue("POST", "/api/hooks/session-end", {})
        temporary = box.directory / "stale.tmp"
        temporary.write_text("temporary")
        os.utime(temporary, (0,0))
        box.entries()
        self.assertFalse(temporary.exists())
        (box.directory / (entry["id"]+".json")).write_text("{")
        box.purge()
        self.assertEqual(box.status()["pending"], 0)

    def test_lock_recovers_corrupt_reused_and_aged_participants(self):
        path = Path(self.home) / ".lock"
        participants = Path(str(path) + ".tickets")
        participants.mkdir(mode=0o700)
        for case in ("corrupt", "reused", "aged"):
            token = str(uuid.uuid4())
            participant = participants / (token + ".json")
            participant.write_text("{" if case == "corrupt" else json.dumps({"pid":os.getpid(), "token":token, "startTime":"reused", "createdAt":0 if case == "aged" else int(time.time()*1000), "choosing":True, "ticket":0}))
            participant.chmod(0o600)
            with self.subTest(case=case):
                with transport._lock(path, time.time()+0.2):
                    pass
            participant.unlink(missing_ok=True)

    def test_refresh_preserves_non_auth_failure(self):
        store = transport.LoginStore(self.url, env=self.env)
        store.save({"accessToken":"access-fixture", "refreshToken":"refresh-fixture", "accessExpiresAt":"2020-01-01T00:00:00Z", "refreshExpiresAt":"2099-01-01T00:00:00Z"})
        for failure in (transport.SignetApiError(503, {}), transport.SignetForbiddenError("permission"), transport.SignetNetworkError("offline"), transport.SignetTimeoutError("deadline")):
            with self.subTest(error=type(failure).__name__):
                with patch.object(transport.SignetTransport, "request", side_effect=failure):
                    with self.assertRaises(type(failure)) as result:
                        store.get()
                    self.assertIs(result.exception, failure)

    def test_refresh_dead_login_persists_across_stores(self):
        store = transport.LoginStore(self.url, env=self.env)
        store.save({"accessToken":"access-fixture", "refreshToken":"refresh-fixture", "accessExpiresAt":"2020-01-01T00:00:00Z", "refreshExpiresAt":"2099-01-01T00:00:00Z"})
        with patch.object(transport.SignetTransport, "request", side_effect=transport.SignetUnauthorizedError("refresh_reuse")) as refresh:
            for instance in (store, transport.LoginStore(self.url, env=self.env)):
                with self.assertRaises(transport.SignetUnauthorizedError):
                    instance.get()
            self.assertEqual(refresh.call_count, 1)

    def test_refresh_in_doubt_retries_pair_without_http(self):
        store = transport.LoginStore(self.url, env=self.env)
        store.save({"accessToken":"access-fixture", "refreshToken":"refresh-fixture", "accessExpiresAt":"2020-01-01T00:00:00Z", "refreshExpiresAt":"2099-01-01T00:00:00Z"})
        rotated = {"accessToken":"rotated-fixture", "refreshToken":"rotated-refresh-fixture", "accessExpiresAt":"2099-01-01T00:00:00Z", "refreshExpiresAt":"2099-01-01T00:00:00Z"}
        with patch.object(transport.SignetTransport, "request", return_value=rotated) as refresh:
            with patch.object(store, "_write", side_effect=OSError("disk unavailable")):
                try:
                    store.get()
                except Exception as error:
                    self.assertEqual(getattr(error, "reason", None), "refresh_in_doubt")
            self.assertEqual(store.get(), rotated["accessToken"])
            self.assertEqual(refresh.call_count, 1)

    def test_provider_error_is_terminal_and_not_network(self):
        calls = []
        def provider():
            calls.append(1)
            raise OSError("credential unavailable")
        client = transport.SignetTransport(self.url, credential_provider=provider, retry_delay=0)
        try:
            client.request("GET", "/health")
        except Exception as error:
            self.assertFalse(isinstance(error, transport.SignetNetworkError))
            self.assertEqual(getattr(error, "code", None), "credential_provider_error")
        else:
            self.fail("provider error was swallowed")
        self.assertEqual(len(calls), 1)

    @unittest.skipIf(os.name == "nt", "POSIX file handles")
    def test_symlink_key_checks_opened_target(self):
        key = Path(self.home) / "key"
        key.write_text("fixture")
        key.chmod(0o600)
        link = Path(self.home) / "link"
        link.symlink_to(key)
        self.assertEqual(transport.read_key_file(link), "fixture")
        key.chmod(0o644)
        with self.assertRaises(PermissionError):
            transport.read_key_file(link)

    @unittest.skipIf(os.name == "nt", "POSIX FIFO")
    def test_fifo_key_cannot_block_open(self):
        fifo = Path(self.home) / "fifo"
        os.mkfifo(fifo)
        code = "import signet_transport as t,sys;\ntry:t.read_key_file(sys.argv[1])\nexcept ValueError:sys.exit(0)\nsys.exit(2)"
        result = subprocess.run([sys.executable, "-c", code, str(fifo)], cwd=Path(__file__).parent, timeout=0.5, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)

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
        client.flush(force=True)
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
            raise transport.SignetApiError(400,{"reason":"invalid_payload"})

        for bounded_pass in range(6):
            result=box.flush(denied,timeout=10,force=True)
            if result["pending"]==0:
                break
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

        failure = box.flush(busy)["failure"]
        if failure is None:
            self.fail("Replay failure not reported")
        self.assertEqual(failure["status"],429)
        self.assertEqual(box.entries()[0]["attempts"], 1)
        self.assertEqual(box.flush(busy)["pending"],1)
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
        self.assertEqual(client.flush()["state"],"deferred")
        self.assertEqual(client.outbox.status()["quarantined"],1)
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
        with self.assertRaises(transport.SignetForbiddenError) as caught:
            client.request("GET", "/protected")
        self.assertEqual(caught.exception.reason, "org_policy")
        self.assertEqual(caught.exception.status,403)
        self.assertEqual(caught.exception.required,"operator")

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
        cancelled_at = []
        client = transport.NodeTransport(transport.resolve_target(flag_url=self.url, flag_key="valid", env=self.env), env=self.env,delivery_paths=("/foreground-delivery",))
        client.outbox.enqueue("POST", "/api/hooks/session-end", {"transcript": "pending"})
        def stop():
            entered.wait(1)
            time.sleep(0.025)
            cancelled_at.append(time.time())
            cancel.set()
            time.sleep(0.3)
            release.set()
        helper = threading.Thread(target=stop)
        helper.start()
        start = time.time()
        try:
            self.assertEqual(client.request("POST", "/foreground-delivery", {}, cancel=cancel, timeout=1), {"ok": True})
            self.assertTrue(self.replay_entered.is_set())
            self.assertTrue(cancelled_at)
            self.assertLess(time.time()-cancelled_at[0],0.15)
            self.assertIsNone(client.outbox.status()["lastFlush"])
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
            self.assertEqual(client.outbox.flush(lambda entry,end:delivered.append(entry),deadline=0)["state"],"failed")
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
        self.assertIsNone(client.outbox.status()["lastFlush"])
        failure = client.flush(force=True)["failure"]
        if failure is None:
            self.fail("Replay failure not reported")
        self.assertEqual(failure["status"],503)
        self.assertEqual(client.outbox.status()["lastFlush"]["failure"]["status"],503)
        self.assertEqual(client.flush()["state"],"deferred")
        self.busy_status=200
        self.assertEqual(client.flush(force=True)["state"],"complete")
        self.assertIsNone(client.outbox.status()["lastFlush"]["failure"])
        self.assertEqual(client.outbox.status()["pending"],0)

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
        self.assertEqual(replay.flush(force=True)["pending"],0)
        self.assertEqual(self.received[0], self.received[1])

    def test_foreign_origin_entries_are_never_replayed(self):
        first = transport.DurableOutbox("https://first.example", env=self.env)
        second = transport.DurableOutbox("https://second.example", env=self.env)
        entry = first.enqueue("POST", "/api/hooks/session-end", {})
        second.status()
        transport._atomic_write(second.directory / (entry["id"] + ".json"), json.dumps(entry))
        sent = []
        self.assertEqual(second.flush(lambda entry,end:sent.append(entry))["pending"],1)
        self.assertEqual(sent, [])
        self.assertEqual(second.entries(), [entry])

    def test_failed_replacement_admission_preserves_queued_evidence(self):
        box = transport.DurableOutbox(self.url, env=self.env)
        for i in range(200):
            box.enqueue("POST", "/api/hooks/session-end", {"i": i})
        original = os.replace
        def full(source, destination):
            if Path(destination).parent == box.directory and transport.re.fullmatch(r"[a-f0-9-]{36}\.json", Path(destination).name):
                raise OSError(28, "No space left on device")
            return original(source, destination)
        with patch.object(os, "replace", full):
            with self.assertRaises(OSError):
                box.enqueue("POST", "/api/hooks/session-end", {"replacement": True})
        self.assertEqual(box.status()["pending"], 200)
        self.assertEqual(box.status()["evicted"], 0)
        self.assertEqual([entry["body"] for entry in box.entries()], [{"i": i} for i in range(200)])

    def test_cross_process_registry_updates_do_not_overwrite(self):
        script = "from signet_transport import ConnectorRegistry; import sys; r=ConnectorRegistry(); r.set(sys.argv[1], {'url':'https://org.example'})"
        children = [subprocess.Popen([sys.executable, "-c", script, "h%s" % i], env={**os.environ, "HOME": self.home, "PYTHONPATH": str(Path(__file__).parent)}, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for i in range(6)]
        for child in children:
            _, err = child.communicate(timeout=15)
            self.assertEqual(child.returncode, 0, err)
        self.assertEqual(len(transport.ConnectorRegistry(env=self.env).read()), 6)


if __name__ == "__main__":
    unittest.main()
