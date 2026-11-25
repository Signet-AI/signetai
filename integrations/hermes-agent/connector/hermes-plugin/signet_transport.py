import contextlib
from collections.abc import Callable
import dataclasses
import datetime
import hashlib
import http.client
import ipaddress
import json
import math
import os
from pathlib import Path
import random
import queue
import re
import socket
import stat
import subprocess
import time
import threading
import urllib.parse
import unicodedata
import uuid


def _json_dump(value, *, ensure_ascii=True):
    return json.dumps(value, ensure_ascii=ensure_ascii, allow_nan=False)


def _invalid_json_constant(value):
    raise ValueError("Invalid JSON numeric constant")


def _json_load(text):
    return json.loads(text, parse_constant=_invalid_json_constant)


class SignetApiError(Exception):
    def __init__(self, status, body):
        self.status = status
        self.body = body
        super().__init__(body.get("error", "API error %s" % status) if isinstance(body, dict) else "API error %s" % status)


class SignetUnauthorizedError(SignetApiError):
    def __init__(self, reason, body=None, *, cause=None):
        self.reason = reason
        self.cause = cause
        super().__init__(401, body or {"error": "Signet session expired, run `signet login`", "reason": reason})


class SignetForbiddenError(SignetApiError):
    def __init__(self, reason, required=None, body=None):
        self.reason = reason
        self.required = required
        super().__init__(403, body or {"error": "Forbidden", "reason": reason, "required": required})


class SignetOutboxAdmissionError(Exception):
    code = "outbox_admission_failed"

    def __init__(self, cause):
        self.__cause__ = cause
        super().__init__("Delivery was not admitted to the durable outbox; no request was sent")


class SignetNetworkError(Exception):
    pass


class SignetTimeoutError(SignetNetworkError):
    pass


def _api_error(status, body):
    reason = body.get("reason", "unknown") if isinstance(body, dict) else "unknown"
    if status == 401:
        return SignetUnauthorizedError(reason, body)
    if status == 403:
        return SignetForbiddenError(reason, body.get("required") if isinstance(body, dict) else None, body)
    return SignetApiError(status, body)


def _ipv4_number(part):
    if not part:
        raise ValueError("Empty IPv4 component")
    base = 16 if part.startswith("0x") else 8 if len(part) > 1 and part.startswith("0") else 10
    digits = part[2:] if base == 16 else part[1:] if base == 8 else part
    if not digits:
        return 0
    alphabet = "0123456789abcdef"[:base]
    if any(c not in alphabet for c in digits):
        raise ValueError("Invalid IPv4 component")
    return int(digits, base)


def _ascii_host(host):
    host = urllib.parse.unquote(host, encoding="utf-8", errors="strict")
    labels = []
    for label in host.replace("。", ".").replace("．", ".").replace("｡", ".").split("."):
        if label.isascii():
            labels.append(label.lower())
            continue
        mapped = unicodedata.normalize("NFKC", label)
        mapped = unicodedata.normalize("NFC", "".join("ß" if c == "ẞ" else c if c in "ßς" else c.casefold() for c in mapped))
        for value in (label, mapped):
            if any(unicodedata.category(c)[0] in "CZ" or unicodedata.category(c).startswith("M") and not unicodedata.combining(c) or "FILLER" in unicodedata.name(c, "") or 0x2FF0 <= ord(c) <= 0x2FFF or ord(c) in (0x31EF, 0xFFFC, 0xFFFD) for c in value):
                raise ValueError("Use an ASCII/punycode hostname for unsupported Unicode formats")
        if "." in mapped or not mapped or unicodedata.category(mapped[0]).startswith("M"):
            raise ValueError("Invalid Unicode hostname label")
        mapped.encode("idna")
        labels.append(mapped if mapped.isascii() else "xn--" + mapped.encode("punycode").decode("ascii"))
    host = ".".join(labels)
    if not host or any(ord(c) <= 32 or ord(c) == 127 or c in "#%/:<>?@[\\]^|" for c in host):
        raise ValueError("Invalid daemon hostname")
    parts = host.split(".")
    if parts[-1] == "":
        parts.pop()
    last = parts[-1] if parts else ""
    numeric = bool(re.fullmatch(r"[0-9]+", last))
    try:
        _ipv4_number(last)
        numeric = True
    except ValueError:
        pass
    if numeric:
        numbers = [_ipv4_number(part) for part in parts]
        if len(numbers) > 4 or any(n > 255 for n in numbers[:-1]) or numbers[-1] >= 256 ** (5 - len(numbers)):
            raise ValueError("Invalid IPv4 daemon host")
        host = str(ipaddress.IPv4Address(numbers[-1] + sum(n * 256 ** (3 - i) for i, n in enumerate(numbers[:-1]))))
    return host


def _url(raw):
    if not isinstance(raw, str) or len(raw) > 4096:
        raise ValueError("Invalid daemon URL")
    parsed = urllib.parse.urlsplit(raw)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise ValueError("Daemon URL must be an http(s) origin without credentials")
    authority = parsed.netloc.rsplit("@", 1)[-1]
    if authority.startswith("["):
        address = authority[1:authority.index("]")]
        if "%" in address:
            raise ValueError("IPv6 zone identifiers are not supported")
        parsed_address = ipaddress.IPv6Address(address)
        address = parsed_address.compressed
        if parsed_address.ipv4_mapped is not None:
            mapped = int(parsed_address.ipv4_mapped)
            address = "::ffff:%x:%x" % (mapped >> 16, mapped & 65535)
        host = "127.0.0.1" if address == "::1" else "[%s]" % address
    else:
        host = _ascii_host(authority.rsplit(":", 1)[0] if ":" in authority else authority)
        if host == "localhost":
            host = "127.0.0.1"
    port = parsed.port
    return "%s://%s%s" % (parsed.scheme, host, ":%s" % port if port is not None and port != (443 if parsed.scheme == "https" else 80) else "")


def config_directory(env=None):
    env = os.environ if env is None else env
    if os.name == "nt":
        if not env.get("APPDATA"):
            raise ValueError("APPDATA is required for Signet credential storage")
        return Path(env["APPDATA"]) / "signet"
    return Path(env.get("HOME") or Path.home()) / ".config" / "signet"


def origin_hash(origin):
    return hashlib.sha256(_url(origin).encode()).hexdigest()


def _identifier(value):
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}", value):
        raise ValueError("Invalid connector identifier")
    return value


def _protect(path, directory=False):
    if os.name != "nt":
        os.chmod(path, 0o700 if directory else 0o600)
    else:
        script = "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); $v=[Console]::In.ReadToEnd()|ConvertFrom-Json; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; if($v.directory){$acl=[System.Security.AccessControl.DirectorySecurity]::new(); $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')}else{$acl=[System.Security.AccessControl.FileSecurity]::new(); $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow')}; $acl.SetAccessRuleProtection($true,$false); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $v.path -AclObject $acl -ErrorAction Stop"
        subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], input=_json_dump({"path": str(path), "directory": directory}), text=True, timeout=5, check=True, capture_output=True)


def _directory(path):
    path = Path(path)
    missing = []
    parent = path
    while not parent.exists():
        missing.append(parent)
        parent = parent.parent
    for parent in reversed(missing):
        parent.mkdir(mode=0o700, exist_ok=True)
        _protect(parent, True)
    _protect(path, True)


def _read_private(path, maximum=1024 * 1024):
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except FileNotFoundError:
        return None
    with os.fdopen(fd, "r", encoding="utf8") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
            raise ValueError("Invalid credential file size or type")
        if os.name != "nt" and (info.st_mode & 0o077 or info.st_uid != os.getuid()):
            raise PermissionError("Unsafe permissions on credential file: %s; require mode 0600 and current owner" % path)
        return handle.read(maximum + 1)


def _atomic_write(path, value):
    path = Path(path)
    _directory(path.parent)
    temporary = path.with_name(path.name + "." + str(uuid.uuid4()) + ".tmp")
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf8") as handle:
            _protect(temporary)
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    finally:
        temporary.unlink(missing_ok=True)


def _alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _lock_record(text):
    try:
        value = _json_load(text)
        return value if isinstance(value, dict) else {}
    except ValueError:
        return {}


def _participants(directory, end, cancel):
    paths = list(directory.iterdir())
    if len(paths) > 256:
        raise SignetNetworkError("Signet lock participant admission limit reached")
    result = []
    for path in paths:
        _check_control(end, cancel)
        if not re.fullmatch(r"[a-f0-9-]{36}\.json", path.name):
            continue
        text = _read_private(path, 4096)
        if text is None:
            continue
        value = _lock_record(text)
        if type(value.get("pid")) is not int or value["pid"] <= 0 or not isinstance(value.get("token"), str) or value["token"] + ".json" != path.name or not isinstance(value.get("choosing"), bool) or type(value.get("ticket")) is not int or not 0 <= value["ticket"] < 9007199254740991:
            raise ValueError("Corrupt Signet lock participant")
        try:
            if time.time() - path.stat().st_mtime > 1 and not _alive(value["pid"]):
                path.unlink(missing_ok=True)
                continue
        except FileNotFoundError:
            continue
        result.append(value)
    return result


def _legacy_lock_released(path):
    text = _read_private(path, 4096)
    if text is None:
        return True
    owner = _lock_record(text)
    valid = type(owner.get("pid")) is int and owner["pid"] > 0 and isinstance(owner.get("token"), str)
    try:
        if time.time() - path.stat().st_mtime <= (1 if valid else 30) or valid and _alive(owner["pid"]):
            return False
        path.unlink(missing_ok=True)
        return True
    except FileNotFoundError:
        return True


@contextlib.contextmanager
def _lock(path, deadline=None, cancel=None):
    path = Path(path)
    _directory(path.parent)
    directory = Path(str(path) + ".tickets")
    _directory(directory)
    end = min(deadline or time.time() + 10, time.time() + 10)
    token = str(uuid.uuid4())
    participant = directory / (token + ".json")
    acquired = False
    try:
        _check_control(end, cancel)
        owner = {"pid": os.getpid(), "token": token, "createdAt": int(time.time() * 1000)}
        _atomic_write(participant, _json_dump({**owner, "choosing": True, "ticket": 0}))
        ticket = max([0, *(value["ticket"] for value in _participants(directory, end, cancel))]) + 1
        _atomic_write(participant, _json_dump({**owner, "choosing": False, "ticket": ticket}))
        while True:
            _check_control(end, cancel)
            participants = _participants(directory, end, cancel)
            blocked = any(other["token"] != token and (other["choosing"] or (other["ticket"], other["token"]) < (ticket, token)) for other in participants)
            if not blocked and _legacy_lock_released(Path(str(path) + ".reap")) and _legacy_lock_released(path):
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                acquired = True
                with os.fdopen(fd, "w") as handle:
                    json.dump(owner, handle)
                _check_control(end, cancel)
                yield
                return
            wait = min(0.015 + random.random() * 0.02, max(0, end - time.time()))
            if cancel:
                cancel.wait(wait)
            else:
                time.sleep(wait)
    finally:
        try:
            if acquired:
                path.unlink(missing_ok=True)
        finally:
            participant.unlink(missing_ok=True)


def read_key_file(path):
    value = _read_private(path, 64 * 1024)
    if value is None:
        raise FileNotFoundError("Credential key file is missing: %s" % path)
    value = value.strip()
    if not value or "\n" in value or "\r" in value:
        raise ValueError("Invalid credential key file")
    return value


def write_key_file(origin, harness, credential, *, env=None):
    if not credential.strip() or "\n" in credential or "\r" in credential:
        raise ValueError("Invalid connector credential")
    path = config_directory(env) / "keys" / origin_hash(origin) / (_identifier(harness) + ".key")
    _atomic_write(path, credential)
    return path


class ConnectorRegistry:
    def __init__(self, *, env=None):
        self.path = config_directory(env) / "connectors.json"

    @staticmethod
    def _entry(value):
        if not isinstance(value, dict) or not isinstance(value.get("url"), str):
            raise ValueError("Invalid connector registry entry")
        entry = {"url": _url(value["url"])}
        for key in ("keyFile", "agentId", "deviceId", "keyId"):
            if key in value:
                if not isinstance(value[key], str):
                    raise ValueError("Invalid connector " + key)
                entry[key] = value[key]
        return entry

    def read(self):
        text = _read_private(self.path)
        if text is None:
            return {}
        value = _json_load(text)
        if not isinstance(value, dict):
            raise ValueError("Invalid connector registry")
        return {_identifier(k): self._entry(v) for k, v in value.items()}

    def set(self, harness, value):
        _identifier(harness)
        entry = self._entry(value)
        with _lock(str(self.path) + ".lock"):
            entries = self.read()
            entries[harness] = entry
            _atomic_write(self.path, _json_dump(entries))

    def remove(self, harness):
        _identifier(harness)
        with _lock(str(self.path) + ".lock"):
            entries = self.read()
            entries.pop(harness, None)
            _atomic_write(self.path, _json_dump(entries))


def _timestamp(value):
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def _login(value):
    if not isinstance(value, dict) or not all(isinstance(value.get(k), str) and value[k] for k in ("accessToken", "refreshToken", "accessExpiresAt", "refreshExpiresAt")):
        raise ValueError("Invalid Signet login credential")
    _timestamp(value["accessExpiresAt"])
    _timestamp(value["refreshExpiresAt"])
    return {k: value[k] for k in ("accessToken", "refreshToken", "accessExpiresAt", "refreshExpiresAt")}


class LoginStore:
    def __init__(self, origin, *, env=None, keyring=None):
        self.origin = _url(origin)
        self.path = config_directory(env) / "login" / (origin_hash(self.origin) + ".json")
        self.keyring = keyring
        self.source = "none"
        self.reason = None

    def load(self, deadline=None, cancel=None):
        end = deadline if deadline is not None else time.time() + 10
        _check_control(end, cancel)
        self.source = "none"
        self.reason = None
        text = _read_private(self.path)
        source = "login-file"
        if text is None and self.keyring:
            text = self.keyring.get("signet-login", self.origin)
            source = "keychain"
        _check_control(end, cancel)
        if text is None or _json_load(text) is None:
            return None
        credential = _login(_json_load(text))
        self.source = source
        value = _json_load(text)
        reason = value.get("fallbackReason", "")
        self.reason = (reason if isinstance(reason, str) and re.fullmatch(r"keyring_(unchecked|missing|locked|unavailable|permission-denied|corrupt|unsupported)", reason) else "protected_login_file") if source == "login-file" else None
        return {"source": source, "credential": credential}

    def _write(self, credential):
        encoded = _json_dump(credential)
        if self.keyring and self.keyring.set("signet-login", self.origin, encoded):
            self.path.unlink(missing_ok=True)
            self.source = "keychain" if credential is not None else "none"
            return "keychain"
        self.reason = "keyring_unavailable"
        _atomic_write(self.path, _json_dump({**credential, "fallbackReason": self.reason}) if credential is not None else "null")
        self.source = "login-file" if credential is not None else "none"
        return "login-file"

    def save(self, credential):
        with _lock(str(self.path) + ".lock"):
            return self._write(_login(credential))

    def clear(self):
        with _lock(str(self.path) + ".lock"):
            self._write(None)

    def get(self, deadline=None, cancel=None):
        end = deadline if deadline is not None else time.time() + 10
        saved = self.load(end, cancel)
        _check_control(end, cancel)
        if not saved:
            return None
        credential = saved["credential"]
        if _timestamp(credential["accessExpiresAt"]) > time.time():
            return credential["accessToken"]
        return self.refresh(credential["accessToken"], end, cancel)

    def refresh(self, rejected=None, deadline=None, cancel=None):
        end = deadline if deadline is not None else time.time() + 10
        _check_control(end, cancel)
        with _lock(str(self.path) + ".lock", end, cancel):
            saved = self.load(end, cancel)
            _check_control(end, cancel)
            if not saved:
                raise SignetUnauthorizedError("missing_credential")
            credential = saved["credential"]
            if credential["accessToken"] != rejected and _timestamp(credential["accessExpiresAt"]) > time.time():
                return credential["accessToken"]
            if _timestamp(credential["refreshExpiresAt"]) <= time.time():
                raise SignetUnauthorizedError("expired")
            try:
                value = SignetTransport(self.origin, retries=0).request("POST", "/api/auth/refresh", {"refreshToken": credential["refreshToken"]}, deadline=end * 1000, cancel=cancel)
                self._write(_login(value))
                return value["accessToken"]
            except Exception as error:
                body = error.body if isinstance(error, SignetApiError) else None
                reason = error.reason if isinstance(error, SignetUnauthorizedError) else body.get("reason", "expired") if isinstance(body, dict) else "expired"
                raise SignetUnauthorizedError(reason, body, cause=error) from error


@dataclasses.dataclass(frozen=True)
class Credential:
    _source: str
    provider: Callable = dataclasses.field(repr=False)
    refresh_provider: Callable | None = dataclasses.field(default=None, repr=False)

    source_provider: Callable | None = dataclasses.field(default=None, repr=False)
    reason_provider: Callable | None = dataclasses.field(default=None, repr=False)

    @property
    def reason(self):
        return self.reason_provider() if self.reason_provider else None

    @property
    def source(self):
        return self.source_provider() if self.source_provider else self._source

    def get(self, deadline=None, cancel=None):
        end = deadline if deadline is not None else time.time() + 10
        _check_control(end, cancel)
        value = self.provider(end, cancel)
        _check_control(end, cancel)
        return value

    def refresh(self, rejected, deadline=None, cancel=None):
        if not self.refresh_provider:
            raise SignetUnauthorizedError("expired")
        return self.refresh_provider(rejected, deadline, cancel)


@dataclasses.dataclass(frozen=True)
class ResolvedTarget:
    url: str
    origin: str
    credential: Credential
    remote: bool


def resolve_target(*, harness=None, flag_url=None, flag_key=None, config_url=None, env=None, keyring=None, timeout: float = 10, deadline=None, cancel=None):
    end = _request_end(10, timeout, deadline)
    _check_control(end, cancel)
    env = os.environ if env is None else env
    flag_url = flag_url.strip() if flag_url is not None else None
    if flag_url is not None and not flag_url:
        raise ValueError("flag_url cannot be empty")
    env_url = env.get("SIGNET_DAEMON_URL", "").strip()
    has_credential = flag_key is not None or bool(env.get("SIGNET_API_KEY", "").strip()) or bool(env.get("SIGNET_API_KEY_FILE", "").strip())
    entry = ConnectorRegistry(env=env).read().get(harness) if harness and not ((flag_url or env_url) and has_credential) else None
    explicit = (flag_url or env_url or (entry or {}).get("url") or config_url or "").strip()
    if explicit:
        url = _url(explicit)
    else:
        host = env.get("SIGNET_HOST", "127.0.0.1").strip() or "127.0.0.1"
        plain_host = host[1:-1] if host.startswith("[") and host.endswith("]") else host
        if not (re.fullmatch(r"[0-9A-Fa-f:.]+", plain_host) if ":" in plain_host else re.fullmatch(r"[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?", plain_host)):
            raise ValueError("SIGNET_HOST must be a hostname or IP address")
        port = env.get("SIGNET_PORT", "3850").strip() or "3850"
        if not re.fullmatch(r"[0-9]+", port) or not 1 <= int(port) <= 65535:
            raise ValueError("SIGNET_PORT must be between 1 and 65535")
        url = _url("http://%s:%s" % ("[%s]" % host if ":" in host and not host.startswith("[") else host, int(port)))
    if flag_key is not None:
        if not flag_key.strip():
            raise ValueError("flag_key cannot be empty")
        credential = Credential("flag", lambda deadline, cancel: flag_key.strip())
    elif env.get("SIGNET_API_KEY", "").strip():
        key = env["SIGNET_API_KEY"].strip()
        credential = Credential("env", lambda deadline, cancel: key)
    else:
        key_file = env.get("SIGNET_API_KEY_FILE", "").strip() or (entry.get("keyFile") if entry and _url(entry["url"]) == url else None)
        if key_file:
            read_key_file(key_file)
            credential = Credential("key-file", lambda deadline, cancel: read_key_file(key_file))
        else:
            store = LoginStore(url, env=env, keyring=keyring)
            saved = _bounded(lambda: store.load(end, cancel), end, cancel, workers=_CREDENTIAL_WORKERS)
            credential = Credential(saved["source"] if saved else "none", store.get, store.refresh, lambda: store.source, lambda: store.reason)
    _check_control(end, cancel)
    return ResolvedTarget(url, url, credential, bool(explicit) or urllib.parse.urlsplit(url).hostname not in ("localhost", "127.0.0.1", "::1"))


_CREDENTIAL_WORKERS = threading.BoundedSemaphore(4)
_HTTP_WORKERS = threading.BoundedSemaphore(8)


def _request_end(default_timeout, timeout=None, deadline=None):
    duration = default_timeout if timeout is None else timeout
    if not math.isfinite(duration) or duration < 0:
        raise ValueError("Invalid request timeout")
    if deadline is not None and not math.isfinite(deadline):
        raise ValueError("Invalid request deadline")
    return min(time.time() + duration, deadline / 1000 if deadline is not None else float("inf"))


def _check_control(end, cancel):
    if cancel and cancel.is_set():
        raise SignetNetworkError("Request cancelled")
    if time.time() >= end:
        raise SignetTimeoutError("Request deadline exceeded")


def _bounded(call, end, cancel, on_cancel=None, workers=_HTTP_WORKERS):
    _check_control(end, cancel)
    if not workers.acquire(blocking=False):
        raise SignetNetworkError("Signet request worker admission limit reached")
    result = queue.Queue(maxsize=1)

    def run():
        try:
            result.put((True, call()))
        except Exception as error:
            result.put((False, error))
        finally:
            workers.release()

    threading.Thread(target=run, daemon=True, name="signet-transport").start()
    while True:
        try:
            _check_control(end, cancel)
        except SignetNetworkError:
            if on_cancel:
                on_cancel()
            raise
        try:
            ok, value = result.get(timeout=min(0.01, max(0.001, end - time.time())))
        except queue.Empty:
            continue
        _check_control(end, cancel)
        if ok:
            return value
        raise value


class SignetTransport:
    def __init__(self, base_url, *, credential_provider=None, timeout=10, retries=2, retry_delay=0.5, headers=None):
        self.base_url = _url(base_url)
        if not isinstance(retries, int) or not 0 <= retries <= 2 or not math.isfinite(timeout) or timeout < 0 or not math.isfinite(retry_delay) or retry_delay < 0:
            raise ValueError("Invalid transport limits")
        self.credential_provider = credential_provider
        self.timeout = timeout
        self.retries = retries
        self.retry_delay = retry_delay
        self.headers = headers or {}

    def _exchange(self, method, path, data, headers, end, cancel):
        stopped = threading.Event()
        state = {}

        def interrupt():
            stopped.set()
            sock = state.get("socket")
            if sock:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    return

        def wire():
            parsed = urllib.parse.urlsplit(self.base_url)
            connection_type = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
            if parsed.hostname is None:
                raise ValueError("Invalid daemon host")
            connection = connection_type(parsed.hostname, parsed.port, timeout=max(0.001, end - time.time()))
            try:
                connection.connect()
                connection.auto_open = 0
                state["socket"] = connection.sock
                _check_control(end, stopped)
                _check_control(end, cancel)
                if connection.sock:
                    connection.sock.settimeout(max(0.001, end - time.time()))
                connection.request(method, path, body=data, headers={k.title(): v for k, v in headers.items()})
                with connection.getresponse() as response:
                    chunks = []
                    while True:
                        _check_control(end, stopped)
                        _check_control(end, cancel)
                        chunk = response.read1(64 * 1024)
                        if not chunk:
                            break
                        chunks.append(chunk)
                    text = b"".join(chunks).decode("utf8")
                    try:
                        value = _json_load(text) if "json" in response.headers.get("content-type", "") else text or None
                    except ValueError:
                        value = text
                    if not 200 <= response.status < 300:
                        raise _api_error(response.status, value)
                    return value
            finally:
                connection.close()

        return _bounded(wire, end, cancel, interrupt)

    def request(self, method, path, body=None, *, headers=None, timeout=None, deadline=None, cancel=None):
        if not path.startswith("/") or path.startswith("//") or any(c in path for c in "\\\r\n"):
            raise ValueError("Request path must be daemon-relative")
        method = method.upper()
        headers = {k.lower(): v for k, v in {**self.headers, **(headers or {})}.items() if k.lower() not in ("x-signet-actor", "x-signet-actor-type")}
        end = _request_end(self.timeout, timeout, deadline)
        retryable = method in ("GET", "HEAD", "OPTIONS", "PUT", "DELETE") or method == "POST" and bool(headers.get("idempotency-key"))
        data = _json_dump(body, ensure_ascii=False).encode() if body is not None else None
        if data is not None:
            headers["content-type"] = "application/json"
        for attempt in range(self.retries + 1 if retryable else 1):
            _check_control(end, cancel)
            if attempt:
                delay = self.retry_delay * 2 ** (attempt - 1) * (0.5 + random.random())
                wait = min(delay, max(0, end - time.time()))
                if cancel:
                    cancel.wait(wait)
                else:
                    time.sleep(wait)
            _check_control(end, cancel)
            try:
                if self.credential_provider:
                    token = _bounded(self.credential_provider, end, cancel, workers=_CREDENTIAL_WORKERS)
                    if token:
                        headers["authorization"] = "Bearer " + token
                    else:
                        headers.pop("authorization", None)
                return self._exchange(method, path, data, headers, end, cancel)
            except (socket.timeout, TimeoutError) as error:
                raise SignetTimeoutError("Request deadline exceeded") from error
            except (OSError, http.client.HTTPException, SignetApiError, SignetNetworkError) as error:
                if isinstance(error, SignetApiError) and error.status not in (408, 429, 500, 502, 503, 504):
                    raise
                if isinstance(error, SignetTimeoutError):
                    raise
                if not retryable or attempt >= self.retries or cancel and cancel.is_set():
                    if isinstance(error, (SignetApiError, SignetNetworkError)):
                        raise
                    raise SignetNetworkError("Signet network request failed") from error
        raise SignetNetworkError("Signet request failed")


_DELIVERY_SCOPE_HEADERS = {"x-signet-agent-id", "x-signet-session-key", "x-signet-session-id", "x-signet-runtime-path", "x-signet-harness"}


def _delivery_headers(headers):
    if not isinstance(headers, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in headers.items()):
        raise ValueError("Invalid delivery headers")
    return {k.lower(): v for k, v in headers.items() if k.lower() in _DELIVERY_SCOPE_HEADERS}


def _delivery_path(path):
    if not isinstance(path, str) or not path.startswith("/") or path.startswith("//") or any(c in path for c in "\\\r\n?#"):
        raise ValueError("Outbox path must be daemon-relative without query or fragment")


class DurableOutbox:
    MAX_ENTRIES = 200
    MAX_BYTES = 64 * 1024 * 1024

    def __init__(self, origin, *, env=None):
        self.origin = _url(origin)
        self.directory = config_directory(env) / "outbox" / origin_hash(self.origin)

    def _file(self, entry_id):
        if not re.fullmatch(r"[a-f0-9-]{36}", entry_id):
            raise ValueError("Invalid outbox id")
        return self.directory / (entry_id + ".json")

    def _meta(self):
        text = _read_private(self.directory / ".status.json")
        value = _json_load(text) if text else {"evicted": 0, "dropped": 0, "lastDrop": None, "removing": []}
        if not isinstance(value, dict) or not all(isinstance(value.get(k), int) and value[k] >= 0 for k in ("evicted", "dropped")) or not isinstance(value.get("removing"), list):
            raise ValueError("Corrupt Signet outbox status")
        value.setdefault("admitting", False)
        if not isinstance(value["admitting"], bool):
            raise ValueError("Invalid outbox admission marker")
        for entry_id in value["removing"]:
            self._file(entry_id)
        return value

    def _save_meta(self, value):
        _atomic_write(self.directory / ".status.json", _json_dump(value))

    def _recover(self, meta):
        if meta["removing"]:
            for entry_id in meta["removing"]:
                self._file(entry_id).unlink(missing_ok=True)
            meta["removing"] = []
            self._save_meta(meta)
        if not meta["admitting"]:
            return
        entries = self._entries()
        total = sum(self._file(e["id"]).stat().st_size + 512 for e in entries)
        evictions = []
        while len(entries) > self.MAX_ENTRIES or total > self.MAX_BYTES:
            oldest = entries.pop(0)
            total -= self._file(oldest["id"]).stat().st_size + 512
            evictions.append(oldest["id"])
        meta["admitting"] = False
        meta["evicted"] += len(evictions)
        meta["removing"] = evictions
        self._save_meta(meta)
        self._recover(meta)

    def _entries(self):
        paths = list(self.directory.iterdir())
        if len(paths) > 1000:
            raise ValueError("Signet outbox directory exceeds scan bound")
        entries = []
        for path in paths:
            if not re.fullmatch(r"[a-f0-9-]{36}\.json", path.name):
                continue
            text = _read_private(path, self.MAX_BYTES)
            if text is None:
                raise ValueError("Outbox entry disappeared while locked")
            value = _json_load(text)
            if not isinstance(value, dict) or set(value) != {"origin", "headers", "id", "idempotencyKey", "method", "path", "body", "createdAt", "attempts", "lastError"} or self._file(value["id"]) != path or not isinstance(value["idempotencyKey"], str) or not re.fullmatch(r"[\x21-\x7e]{1,512}", value["idempotencyKey"]) or value["method"] != "POST" or not isinstance(value["attempts"], int) or value["attempts"] < 0 or value["lastError"] is not None and not isinstance(value["lastError"], str):
                raise ValueError("Corrupt Signet outbox entry")
            if _url(value["origin"]) != value["origin"] or _delivery_headers(value["headers"]) != value["headers"]:
                raise ValueError("Invalid outbox origin or scope")
            _timestamp(value["createdAt"])
            _delivery_path(value["path"])
            entries.append(value)
        return sorted(entries, key=lambda entry: (entry["createdAt"], entry["id"]))

    def _remove(self, meta, entry, disposition):
        if isinstance(disposition, int):
            meta["dropped"] += 1
            meta["lastDrop"] = {"id": entry["id"], "status": disposition, "at": _iso(time.time())}
        meta["removing"] = [entry["id"]]
        self._save_meta(meta)
        self._recover(meta)

    def _admit(self, method, path, body, idempotency_key, meta, headers):
        _delivery_path(path)
        if method != "POST":
            raise ValueError("Only designated POST delivery calls belong in the outbox")
        if idempotency_key is not None and not re.fullmatch(r"[\x21-\x7e]{1,512}", idempotency_key):
            raise ValueError("Invalid idempotency key")
        self._recover(meta)
        entries = self._entries()
        created = max(time.time(), _timestamp(entries[-1]["createdAt"]) + 0.001 if entries else 0)
        entry = {"origin": self.origin, "headers": headers, "id": str(uuid.uuid4()), "idempotencyKey": str(uuid.uuid4()) if idempotency_key is None else idempotency_key, "method": method, "path": path, "body": body, "createdAt": _iso(created), "attempts": 0, "lastError": None}
        encoded = _json_dump(entry, ensure_ascii=False)
        size = len(encoded.encode()) + 512
        if size > self.MAX_BYTES:
            raise ValueError("Outbox entry exceeds 64 MiB")
        total = sum(self._file(e["id"]).stat().st_size + 512 for e in entries)
        if len(entries) >= self.MAX_ENTRIES or total + size > self.MAX_BYTES:
            meta["admitting"] = True
            self._save_meta(meta)
        _atomic_write(self._file(entry["id"]), encoded)
        self._recover(meta)
        return entry

    def enqueue(self, method, path, body, *, idempotency_key=None, deadline=None, cancel=None, headers=None):
        body = _json_load(_json_dump(body, ensure_ascii=False))
        headers = _delivery_headers(headers or {})
        end = deadline / 1000 if deadline is not None else time.time() + 10
        with _lock(self.directory / ".lock", end, cancel):
            _check_control(end, cancel)
            return self._admit(method, path, body, idempotency_key, self._meta(), headers)

    def deliver(self, method, path, body, send, *, idempotency_key=None, deadline=None, cancel=None, headers=None):
        end = deadline / 1000 if deadline is not None else time.time() + 10
        admitted = False
        committed = []
        try:
            body = _json_load(_json_dump(body, ensure_ascii=False))
            headers = _delivery_headers(headers or {})
            with _lock(self.directory / ".lock", end, cancel):
                _check_control(end, cancel)
                meta = self._meta()
                entry = self._admit(method, path, body, idempotency_key, meta, headers)
                admitted = True
                try:
                    value = send(entry, end * 1000)
                except Exception as error:
                    status = getattr(error, "status", None)
                    if isinstance(status, int) and 400 <= status < 500 and status not in (401, 408, 429):
                        self._remove(meta, entry, status)
                    else:
                        entry["lastError"] = "http_%s" % status if status else "network_or_deadline"
                        _atomic_write(self._file(entry["id"]), _json_dump(entry, ensure_ascii=False))
                    raise
                committed.append(value)
                self._remove(meta, entry, "delivered")
            return value, None
        except Exception as error:
            if committed:
                return committed[0], error
            if not admitted:
                raise SignetOutboxAdmissionError(error) from error
            raise

    def entries(self):
        with _lock(self.directory / ".lock"):
            meta = self._meta()
            self._recover(meta)
            return self._entries()

    def status(self):
        with _lock(self.directory / ".lock"):
            meta = self._meta()
            self._recover(meta)
            entries = self._entries()
            return {"pending": len(entries), "bytes": sum(self._file(e["id"]).stat().st_size for e in entries), "evicted": meta["evicted"], "dropped": meta["dropped"], "lastDrop": meta["lastDrop"]}

    def flush(self, send, *, timeout=5, deadline=None, force=False, cancel=None, origin=None):
        end = _request_end(5, timeout, deadline)
        with _lock(self.directory / ".lock", end, cancel):
            meta = self._meta()
            self._recover(meta)
            entries = self._entries()
            pending = len(entries)
            for entry in entries:
                if entry["origin"] != self.origin or origin is not None and entry["origin"] != origin:
                    continue
                _check_control(end, cancel)
                path = self._file(entry["id"])
                if not force and entry["attempts"] and time.time() - path.stat().st_mtime < min(60, 2 ** min(entry["attempts"], 6)):
                    break
                try:
                    send(entry, end * 1000)
                except (SignetApiError, SignetNetworkError) as error:
                    status = getattr(error, "status", None)
                    if status and 400 <= status < 500 and status not in (401, 408, 429):
                        self._remove(meta, entry, status)
                        pending -= 1
                        continue
                    entry["attempts"] += 1
                    entry["lastError"] = "http_%s" % status if status else "network_or_deadline"
                    _atomic_write(path, _json_dump(entry, ensure_ascii=False))
                    raise
                self._remove(meta, entry, "delivered")
                pending -= 1
            return {"pending": pending}

    def purge(self):
        with _lock(self.directory / ".lock"):
            for entry in self._entries():
                self._file(entry["id"]).unlink()
            (self.directory / ".status.json").unlink(missing_ok=True)


def _iso(timestamp):
    return datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class NodeTransport(SignetTransport):
    def __init__(self, target, *, env=None, delivery_paths=(), **options):
        super().__init__(target.url, **options)
        if _url(target.url) != _url(target.origin):
            raise ValueError("Target origin does not match URL")
        self.target = dataclasses.replace(target, url=_url(target.url), origin=_url(target.origin))
        self.last_replay_error = None
        self.outbox = DurableOutbox(target.origin, env=env)
        self.delivery_paths = {"/api/hooks/session-end", *delivery_paths}
        for path in self.delivery_paths:
            _delivery_path(path)

    def _send(self, method, path, body, *, captured_headers=None, **options):
        used = [None]
        acquired = [False]
        deadline = options.get("deadline")

        def credential():
            used[0] = self.target.credential.get(deadline / 1000 if deadline is not None else None, options.get("cancel"))
            acquired[0] = True
            return used[0]

        fixed = {k.lower(): v for k, v in self.headers.items()}
        if captured_headers is not None:
            fixed = {k: v for k, v in fixed.items() if k not in _DELIVERY_SCOPE_HEADERS}
            fixed.update(captured_headers)
            options["headers"] = {k: v for k, v in options.get("headers", {}).items() if k.lower() not in _DELIVERY_SCOPE_HEADERS}
        client = SignetTransport(self.target.url, credential_provider=credential, timeout=self.timeout, retries=self.retries, retry_delay=self.retry_delay, headers=fixed)
        try:
            return client.request(method, path, body, **options), used[0] is not None
        except SignetUnauthorizedError as error:
            if not acquired[0] or used[0] is None or error.reason != "expired" or not self.target.credential.refresh_provider:
                raise
            end = deadline / 1000 if deadline is not None else time.time() + self.timeout
            _bounded(lambda: self.target.credential.refresh(used[0], end, options.get("cancel")), end, options.get("cancel"), workers=_CREDENTIAL_WORKERS)
            return client.request(method, path, body, **options), used[0] is not None

    def request(self, method, path, body=None, **options):
        deadline = _request_end(self.timeout, options.get("timeout"), options.get("deadline")) * 1000
        options["deadline"] = deadline
        headers = {k.lower(): v for k, v in options.pop("headers", {}).items()}
        delivery = method.upper() == "POST" and path in self.delivery_paths
        if method.upper() == "POST" and path.split("?", 1)[0] in self.delivery_paths and not delivery:
            raise ValueError("Durable delivery scope must be in the JSON body")
        if delivery:
            if set(headers) - {"idempotency-key"} - _DELIVERY_SCOPE_HEADERS:
                raise ValueError("Durable delivery scope and provenance must be in the JSON body or fixed transport headers")
            headers.setdefault("idempotency-key", str(uuid.uuid4()))
            result, cleanup_error = self.outbox.deliver("POST", path, body, lambda entry, end: self._send(method, path, entry["body"], headers=headers, captured_headers=entry["headers"], **options), idempotency_key=headers["idempotency-key"], deadline=deadline, cancel=options.get("cancel"), headers=_delivery_headers({**{k.lower(): v for k, v in self.headers.items()}, **headers}))
            value, authenticated = result
            if cleanup_error:
                self.last_replay_error = cleanup_error
                return value
        else:
            value, authenticated = self._send(method, path, body, headers=headers, **options)
        if authenticated:
            try:
                self.flush(deadline=deadline, cancel=options.get("cancel"))
            except Exception as error:
                self.last_replay_error = error
        return value

    def flush(self, **options):
        try:
            result = self.outbox.flush(lambda entry, deadline: self._send(entry["method"], entry["path"], entry["body"], headers={"Idempotency-Key": entry["idempotencyKey"]}, deadline=deadline, cancel=options.get("cancel"), captured_headers=entry["headers"]), **{**options, "origin": self.target.origin})
            if result["pending"] == 0:
                self.last_replay_error = None
            return result
        except Exception as error:
            self.last_replay_error = error
            raise

