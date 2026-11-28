import contextlib
import errno
from collections.abc import Callable
from typing import Literal, TypedDict
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
import shutil
import stat
import sys
import subprocess
import time
import threading
import urllib.parse
import unicodedata
import uuid


def _upload_state(value):
    if not isinstance(value,dict) or value.get("uploadId") is not None and (not isinstance(value.get("uploadId"),str) or not re.fullmatch(r"[a-f0-9-]{36}",value["uploadId"])) or any(type(value.get(k)) is not int for k in ("receivedBytes","totalBytes")) or not 0 <= value["receivedBytes"] <= value["totalBytes"] <= 64*1024**3 or value["totalBytes"] < 1 or not isinstance(value.get("sha256"),str) or not re.fullmatch(r"[a-f0-9]{64}",value["sha256"]) or not isinstance(value.get("fingerprint"),str) or len(value["fingerprint"]) > 200:
        raise ValueError("Invalid upload checkpoint")
    return {k:value[k] for k in ("uploadId","receivedBytes","totalBytes","sha256","fingerprint")}


def _capture_remote_session_end(body,state,checkpoint,request,end,cancel):
    if not isinstance(body,dict) or not isinstance(body.get("transcriptPath"),str) or not body["transcriptPath"]:
        return body
    _check_control(end,cancel)
    fd=os.open(body["transcriptPath"],os.O_RDONLY|getattr(os,"O_NONBLOCK",0))
    try:
        before=os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("Transcript capture requires a regular file")
        def fingerprint(info):
            return ":".join(str(v) for v in (info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns))
        def read_at(length,offset):
            _check_control(end,cancel)
            if hasattr(os,"pread"):
                return os.pread(fd,length,offset)
            os.lseek(fd,offset,os.SEEK_SET)
            return os.read(fd,length)
        if state is not None and (_upload_state(state)["totalBytes"] != before.st_size or state["fingerprint"] != fingerprint(before)):
            raise ValueError("Transcript changed since upload admission")
        if before.st_size <= 4*1024*1024:
            data=bytearray()
            while len(data)<before.st_size:
                block=read_at(before.st_size-len(data),len(data))
                if not block: raise ValueError("Transcript changed during capture")
                data.extend(block)
            if fingerprint(os.fstat(fd)) != fingerprint(before):
                raise ValueError("Transcript changed during capture")
            return {**{k:v for k,v in body.items() if k != "transcriptPath"},"transcript":data.decode("utf-8",errors="replace")}
        if before.st_size>64*1024**3:
            raise ValueError("Transcript exceeds upload byte limit")
        identity=fingerprint(before)
        if state is not None:
            state=_upload_state(state)
            if state["fingerprint"] != identity or state["totalBytes"] != before.st_size:
                raise ValueError("Transcript changed since upload admission")
        def hash_state(previous=None):
            digest=hashlib.sha256()
            offset=0
            while offset<before.st_size:
                block=read_at(min(256*1024,before.st_size-offset),offset)
                if not block: raise ValueError("Transcript changed during hashing")
                digest.update(block)
                offset+=len(block)
            if fingerprint(os.fstat(fd)) != identity:
                raise ValueError("Transcript changed during hashing")
            sha256=digest.hexdigest()
            if previous is not None and previous["sha256"] != sha256:
                raise ValueError("Transcript changed since upload admission")
            current={"uploadId":None,"receivedBytes":0,"totalBytes":before.st_size,"sha256":sha256,"fingerprint":identity}
            checkpoint(current)
            return current
        if state is None or state["uploadId"] is None:
            state=hash_state(state)
        session=body.get("sessionKey") or body.get("sessionId")
        if not isinstance(session,str) or not isinstance(body.get("harness"),str):
            raise ValueError("Staged session-end requires harness and session identity")
        base="/api/hooks/session-end/uploads"
        def declare(saved):
            return request("POST",base,body={"sessionKey":session,"harness":body["harness"],"totalBytes":saved["totalBytes"],"sha256":saved["sha256"],**({"agentId":body["agentId"]} if "agentId" in body else {})})
        try:
            current=request("GET",base+"/"+state["uploadId"]) if state["uploadId"] else declare(state)
        except SignetApiError as error:
            if state["uploadId"] is None or error.status not in (404,410):
                raise
            checkpoint({**state,"uploadId":None,"receivedBytes":0})
            state=hash_state(state)
            current=declare(state)
        if not isinstance(current,dict) or not isinstance(current.get("uploadId"),str) or not re.fullmatch(r"[a-f0-9-]{36}",current["uploadId"]) or type(current.get("receivedBytes")) is not int or not 0<=current["receivedBytes"]<=state["totalBytes"] or type(current.get("chunkBytes")) is not int or not 65536<=current["chunkBytes"]<=1024*1024 or current["chunkBytes"]%65536:
            raise ValueError("Invalid upload progress")
        if state["uploadId"] and state["uploadId"]!=current["uploadId"]:
            raise ValueError("Upload identity changed")
        state={**state,"uploadId":current["uploadId"],"receivedBytes":current["receivedBytes"]}
        checkpoint(state)
        while state["receivedBytes"]<state["totalBytes"]:
            block=bytearray()
            length=min(current["chunkBytes"],state["totalBytes"]-state["receivedBytes"])
            while len(block)<length:
                part=read_at(length-len(block),state["receivedBytes"]+len(block))
                if not part: raise ValueError("Transcript changed during upload")
                block.extend(part)
            if fingerprint(os.fstat(fd)) != identity:
                raise ValueError("Transcript changed during upload")
            reply=request("PATCH",base+"/"+state["uploadId"],raw_body=bytes(block),headers={"upload-offset":str(state["receivedBytes"]),"upload-checksum":hashlib.sha256(block).hexdigest()})
            if not isinstance(reply,dict) or type(reply.get("receivedBytes")) is not int or not state["receivedBytes"]+len(block)<=reply["receivedBytes"]<=state["totalBytes"]:
                raise ValueError("Invalid upload acknowledgement")
            state={**state,"receivedBytes":reply["receivedBytes"]}
            checkpoint(state)
        return {**{k:v for k,v in body.items() if k not in ("transcriptPath","transcript")},"transcriptUpload":{"uploadId":state["uploadId"]}}
    finally:
        os.close(fd)


def _json_dump(value, *, ensure_ascii=True):
    return json.dumps(value, ensure_ascii=ensure_ascii, allow_nan=False)


def _invalid_json_constant(value):
    raise ValueError("Invalid JSON numeric constant")


def _json_load(text):
    return json.loads(text, parse_constant=_invalid_json_constant)


class SignetUploadChecksumError(ValueError):
    code = "transcript_upload_checksum_failed"


class SignetApiError(Exception):
    def __init__(self, status, body):
        self.status = status
        self.body = body
        message = body.get("error") if isinstance(body, dict) else None
        super().__init__(message[:4096] if isinstance(message, str) else "API error %s" % status)


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
        super().__init__("Delivery did not reach foreground dispatch; inspect the outbox before retrying")


class SignetCredentialError(Exception):
    def __init__(self, cause, reason="credential_provider_error"):
        super().__init__("Signet refresh persistence is in doubt" if reason == "refresh_in_doubt" else "Signet credential provider failed")
        self.code = self.reason = reason
        self.__cause__ = cause


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


_WINDOWS = os.name == "nt"
_ACL_CACHE = {}


def _security_change_time(path, info):
    if os.name != "nt":
        return info.st_ctime_ns
    import ctypes
    from ctypes import wintypes
    class BasicInfo(ctypes.Structure):
        _fields_ = [("creation",ctypes.c_longlong),("access",ctypes.c_longlong),("write",ctypes.c_longlong),("change",ctypes.c_longlong),("attributes",wintypes.DWORD)]
    kernel = ctypes.WinDLL("kernel32",use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR,wintypes.DWORD,wintypes.DWORD,ctypes.c_void_p,wintypes.DWORD,wintypes.DWORD,wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.GetFileInformationByHandleEx.argtypes = [wintypes.HANDLE,ctypes.c_int,ctypes.c_void_p,wintypes.DWORD]
    kernel.GetFileInformationByHandleEx.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.CreateFileW(str(path),0x80,7,None,3,0x02000000,None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        value = BasicInfo()
        if not kernel.GetFileInformationByHandleEx(handle,0,ctypes.byref(value),ctypes.sizeof(value)):
            raise ctypes.WinError(ctypes.get_last_error())
        return value.change
    finally:
        kernel.CloseHandle(handle)


def _fingerprint(path):
    info = Path(path).stat()
    return info.st_dev,info.st_ino,_security_change_time(path,info) if _WINDOWS else info.st_ctime_ns,info.st_mtime_ns,info.st_size


def _remember_private(path):
    _ACL_CACHE.pop(str(path), None)


def _remember_directory_mutation(path):
    _remember_private(path)


class _PrivateStateChangedError(OSError):
    pass


def _is_link(info):
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


_ACL_SCRIPT = """[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; while($null -ne ($line=[Console]::ReadLine())){try{$v=$line|ConvertFrom-Json; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $item=Get-Item -LiteralPath $v.path -Force; if(($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -and -not $v.allowSymlink){throw 'link'}; $p=$item.FullName; for($i=0;($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -and $i -lt 32;$i++){$p=$item.Target[0]; if(-not [System.IO.Path]::IsPathRooted($p)){$p=Join-Path $item.DirectoryName $p}; $item=Get-Item -LiteralPath $p -Force}; if($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint){throw 'link'}; if($v.write){if($v.directory){$acl=[System.Security.AccessControl.DirectorySecurity]::new(); $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')}else{$acl=[System.Security.AccessControl.FileSecurity]::new(); $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow')}; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl}; $acl=Get-Acl -LiteralPath $p; if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'owner'}; foreach($r in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -ne $sid.Value){throw 'acl'}}; if($v.directory -and -not $acl.AreAccessRulesProtected){throw 'inheritance'}; [Console]::WriteLine('{"ok":true}')}catch{[Console]::WriteLine('{"ok":false}')}; [Console]::Out.Flush()}"""


class _AclWorker:
    def __init__(self):
        self.requests = queue.Queue(maxsize=1)
        self.process = None
        self.closed = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def close(self):
        self.closed.set()
        process = self.process
        if process is not None and process.poll() is None:
            try:
                process.kill()
            except OSError:
                pass

    def _run(self):
        try:
            while not self.closed.is_set():
                try:
                    value, response = self.requests.get(timeout=_ACL_IDLE_SECONDS)
                except queue.Empty:
                    return
                try:
                    if self.closed.is_set():
                        raise OSError()
                    if self.process is None:
                        self.process = subprocess.Popen(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", _ACL_SCRIPT], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8", bufsize=1)
                    if self.closed.is_set():
                        raise OSError()
                    stdin, stdout = self.process.stdin, self.process.stdout
                    if stdin is None or stdout is None:
                        raise OSError("ACL worker pipes unavailable")
                    stdin.write(_json_dump(value)+"\n")
                    stdin.flush()
                    line = stdout.readline(128)
                    if len(line) >= 128 or not line.endswith("\n"):
                        raise OSError()
                    result = _json_load(line)
                    if not isinstance(result, dict) or set(result) != {"ok"} or type(result["ok"]) is not bool:
                        raise OSError()
                    response.put_nowait(result["ok"])
                except Exception:
                    response.put_nowait(None)
                    return
        finally:
            self.close()
            if self.process is not None:
                try:
                    self.process.wait(timeout=0.1)
                except (OSError, subprocess.SubprocessError):
                    pass
                for stream in (self.process.stdin, self.process.stdout):
                    if stream:
                        stream.close()


_ACL_IDLE_SECONDS = 5
_ACL_WORKER = None
_ACL_WORKER_LOCK = threading.Lock()


def _acl_operation(path, directory=False, write=False, allow_symlink=False):
    global _ACL_WORKER
    end = time.monotonic()+1
    if not _ACL_WORKER_LOCK.acquire(timeout=1):
        raise PermissionError("Signet ACL worker busy")
    try:
        if _ACL_WORKER is None or _ACL_WORKER.closed.is_set():
            _ACL_WORKER = _AclWorker()
        worker = _ACL_WORKER
        response = queue.Queue(maxsize=1)
        try:
            worker.requests.put_nowait(({"path":str(path), "directory":directory, "write":write, "allowSymlink":allow_symlink},response))
            result = response.get(timeout=max(0,end-time.monotonic()))
        except (queue.Empty, queue.Full):
            worker.close()
            raise PermissionError("Signet ACL verification timed out") from None
        if result is not True:
            if result is None:
                worker.close()
            raise PermissionError("Unsafe permissions on Signet private state")
    finally:
        _ACL_WORKER_LOCK.release()


def _windows_acl(path, directory=False, write=False, allow_symlink=False):
    if not allow_symlink and _is_link(Path(path).lstat()):
        raise ValueError("Invalid credential file type")
    before = _fingerprint(path)
    if not write and _ACL_CACHE.get(str(path)) == before:
        return
    _remember_private(path)
    _acl_operation(path, directory, write, allow_symlink)
    if not allow_symlink and _is_link(Path(path).lstat()):
        raise ValueError("Invalid credential file type")
    if before[:2] != _fingerprint(path)[:2]:
        raise _PrivateStateChangedError("Credential changed during ACL verification")
    if not write:
        if before != _fingerprint(path):
            raise _PrivateStateChangedError("Credential changed during ACL verification")
        _ACL_CACHE[str(path)] = before
        if len(_ACL_CACHE) > 512:
            _ACL_CACHE.pop(next(iter(_ACL_CACHE)))


def _protect(path, directory=False):
    if not _WINDOWS:
        os.chmod(path,0o700 if directory else 0o600)
    else:
        _windows_acl(path,directory,True)


def _reject_directory_links(path):
    path = Path(path).absolute()
    for candidate in (path, *path.parents):
        try:
            if _is_link(candidate.lstat()):
                raise ValueError("Private state directories cannot contain links")
        except FileNotFoundError:
            continue


def _directory(path):
    path = Path(path)
    _reject_directory_links(path)
    missing = []
    parent = path
    while not parent.exists():
        missing.append(parent)
        parent = parent.parent
    for parent in reversed(missing):
        parent.mkdir(mode=0o700, exist_ok=True)
        _protect(parent, True)
        _remember_directory_mutation(parent.parent)
    _reject_directory_links(path)
    _protect(path, True)


def _read_private(path, maximum=1024 * 1024, allow_symlink=False):
    if not allow_symlink:
        _reject_directory_links(Path(path).parent)
    try:
        before = Path(path).lstat()
        if not allow_symlink and _is_link(before):
            raise ValueError("Invalid credential file type")
        fd=os.open(path,os.O_RDONLY|getattr(os,"O_NONBLOCK",0)|(0 if allow_symlink else getattr(os,"O_NOFOLLOW",0)))
    except FileNotFoundError:
        return None
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise ValueError("Invalid credential file type") from error
        raise
    try:
        info=os.fstat(fd)
        after = Path(path).lstat()
        if not allow_symlink and _is_link(after):
            raise ValueError("Invalid credential file type")
        if not allow_symlink and ((before.st_dev,before.st_ino) != (info.st_dev,info.st_ino) or (after.st_dev,after.st_ino) != (info.st_dev,info.st_ino)):
            raise _PrivateStateChangedError("Private state changed while opening")
        if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
            raise ValueError("Invalid credential file size or type")
        if not _WINDOWS and (stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid()):
            raise PermissionError("Unsafe permissions on credential file: %s; require mode 0600 and current owner" % path)
        if _WINDOWS:
            _windows_acl(path, allow_symlink=allow_symlink)
            if not allow_symlink and _is_link(Path(path).lstat()):
                raise ValueError("Invalid credential file type")
            current=Path(path).stat()
            if (info.st_dev,info.st_ino,info.st_ctime_ns) != (current.st_dev,current.st_ino,current.st_ctime_ns):
                raise _PrivateStateChangedError("Credential changed during ACL verification")
        with os.fdopen(fd,"r",encoding="utf8",closefd=False) as handle:
            return handle.read(maximum+1)
    except FileNotFoundError:
        return None
    finally:
        os.close(fd)


def _sync_directory(path):
    if os.name != "nt":
        fd=os.open(path,os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def _rename_private(source,target,durable=True):
    source,target=Path(source),Path(target)
    _reject_directory_links(source.parent)
    _reject_directory_links(target.parent)
    _remember_private(source)
    _remember_private(target)
    source.replace(target)
    if durable:
        _sync_directory(source.parent)
    _remember_directory_mutation(source.parent)
    if source.parent != target.parent:
        if durable:
            _sync_directory(target.parent)
        _remember_directory_mutation(target.parent)


def _remove_private(path,recursive=False,durable=True):
    path=Path(path)
    _reject_directory_links(path.parent)
    _remember_private(path)
    if recursive and path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)
    if durable:
        _sync_directory(path.parent)
    _remember_directory_mutation(path.parent)


def _atomic_write(path, value, durable=True):
    path = Path(path)
    _directory(path.parent)
    temporary = path.with_name(path.name + "." + str(uuid.uuid4()) + ".tmp")
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf8") as handle:
            if _WINDOWS:
                _remember_directory_mutation(path.parent)
                _protect(temporary)
                opened = os.fstat(handle.fileno())
                current = temporary.lstat()
                if _is_link(current) or (opened.st_dev,opened.st_ino) != (current.st_dev,current.st_ino):
                    raise PermissionError("Private file changed during ACL protection")
            else:
                _protect(temporary)
            handle.write(value)
            handle.flush()
            if durable:
                os.fsync(handle.fileno())
        _rename_private(temporary,path,durable)
        _remember_directory_mutation(path.parent)
        _remember_private(path)
    finally:
        _remove_private(temporary,durable=False)


_PROCESS_IDENTITIES = {}


def _process_start(pid):
    cached = _PROCESS_IDENTITIES.get(pid)
    if pid == os.getpid() and cached and cached[1] > time.time():
        return cached[0]
    try:
        if sys.platform.startswith("linux"):
            text = Path("/proc/%d/stat" % pid).read_text()
            value = "linux:" + text.rsplit(")", 1)[1].split()[19]
        elif sys.platform == "darwin":
            value = "darwin:" + subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True, timeout=1, check=True,env={**os.environ,"LC_ALL":"C","TZ":"UTC"}).stdout.strip()
        elif os.name == "nt":
            value = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; $p=Get-Process -Id %d -ErrorAction SilentlyContinue; if($null -ne $p){$p.StartTime.ToUniversalTime().Ticks}" % pid], capture_output=True, text=True, timeout=1, check=True,env={**os.environ,"LC_ALL":"C","TZ":"UTC"}).stdout.strip()
            value = "win32:"+value if value else None
        else:
            raise RuntimeError("Unsupported Signet lock platform")
    except (OSError,subprocess.SubprocessError) as error:
        if pid == os.getpid():
            raise
        if isinstance(error,FileNotFoundError) and sys.platform.startswith("linux"):
            return None
        if sys.platform == "darwin" and isinstance(error,subprocess.CalledProcessError) and error.returncode == 1 and not error.stdout.strip() and not error.stderr.strip():
            return None
        raise
    if pid == os.getpid():
        _PROCESS_IDENTITIES[pid] = (value,float("inf"))
    return value


def _owner(token=None):
    return {"pid":os.getpid(), "token":token or str(uuid.uuid4()), "startTime":_process_start(os.getpid()), "createdAt":int(time.time()*1000)}


def _owner_alive(value):
    return isinstance(value, dict) and type(value.get("pid")) is int and value["pid"] > 0 and isinstance(value.get("startTime"), str) and type(value.get("createdAt")) in (int, float) and -1000 <= time.time()*1000-value["createdAt"] < 120000 and _process_start(value["pid"]) == value["startTime"]


def _lock_record(text):
    try:
        value = _json_load(text)
        return value if isinstance(value, dict) else {}
    except ValueError:
        return {}


def _lock_text(path, retries=3):
    try:
        return _read_private(path,4096)
    except _PrivateStateChangedError:
        if retries > 0:
            return _lock_text(path,retries-1)
        raise


def _participants(directory, end, cancel, legacy=False):
    paths = list(directory.iterdir())
    result = []
    for path in paths:
        _check_control(end, cancel)
        if not re.fullmatch(r"[a-f0-9-]{36}\.json", path.name):
            continue
        try:
            text = _lock_text(path)
        except (ValueError,PermissionError):
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
            else:
                _remove_private(path)
            continue
        if text is None:
            continue
        value = _lock_record(text)
        if type(value.get("pid")) is not int or value["pid"] <= 0 or not isinstance(value.get("token"), str) or value["token"] + ".json" != path.name or not isinstance(value.get("choosing"), bool) or type(value.get("ticket")) is not int or not 0 <= value["ticket"] < 9007199254740991:
            _remove_private(path)
            continue
        legacy_alive = legacy and "startTime" not in value and type(value.get("createdAt")) in (int,float) and -1000 <= time.time()*1000-value["createdAt"] < 120000 and _process_start(value["pid"]) is not None
        if not legacy_alive and not _owner_alive(value):
            _remove_private(path)
            continue
        result.append(value)
    if len(result)>256:
        raise SignetNetworkError("Signet lock participant admission limit reached")
    return result


@contextlib.contextmanager
def _lock(path,deadline=None,cancel=None,legacy=False):
    path=Path(path)
    _check_control(deadline,cancel)
    _directory(path.parent)
    directory=Path(str(path)+".tickets")
    _directory(directory)
    end=min(deadline if deadline is not None else time.time()+10,time.time()+10)
    owner=_owner()
    participant=directory/(owner["token"]+".json")
    try:
        _check_control(end,cancel)
        _atomic_write(participant,_json_dump({**owner,"choosing":True,"ticket":0}),durable=False)
        ticket=max([0,*(value["ticket"] for value in _participants(directory,end,cancel,legacy))])+1
        if ticket>=9007199254740991:
            raise ValueError("Signet lock ticket limit reached")
        _atomic_write(participant,_json_dump({**owner,"choosing":False,"ticket":ticket}),durable=False)
        while True:
            _check_control(end,cancel)
            participants=_participants(directory,end,cancel,legacy)
            if not any(other["token"]==owner["token"] and other["ticket"]==ticket and not other["choosing"] for other in participants):
                raise ValueError("Signet lock generation expired")
            blocked=any(other["token"]!=owner["token"] and (other["choosing"] or (other["ticket"],other["token"])<(ticket,owner["token"])) for other in participants)
            if not blocked:
                yield
                return
            wait=min(0.015+random.random()*0.02,max(0,end-time.time()))
            if cancel:
                cancel.wait(wait)
            else:
                time.sleep(wait)
    finally:
        _remove_private(participant,durable=False)


def read_key_file(path):
    value = _read_private(path, 64 * 1024, allow_symlink=True)
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
        self.pending_rotation = None
        self.pending_previous_refresh = None

    def load(self, deadline=None, cancel=None):
        end = deadline if deadline is not None else time.time() + 10
        _check_control(end, cancel)
        dead_reason=None
        marker = _read_private(str(self.path) + ".state")
        if marker is not None:
            dead_reason = _json_load(marker)["reason"]
        if dead_reason:
            raise SignetUnauthorizedError(dead_reason)
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
        self.reason = "python_file_store" if source == "login-file" else None
        return {"source": source, "credential": credential}

    def _write(self, credential):
        encoded = _json_dump(credential)
        if self.keyring and self.keyring.set("signet-login", self.origin, encoded):
            _remove_private(self.path)
            self.source = "keychain" if credential is not None else "none"
            self.reason=None
            return "keychain"
        self.reason = "python_file_store"
        _atomic_write(self.path, _json_dump({**credential, "fallbackReason": self.reason}) if credential is not None else "null")
        self.source = "login-file" if credential is not None else "none"
        return "login-file"

    def save(self, credential):
        with _lock(str(self.path) + ".lock"):
            result = self._write(_login(credential))
            _remove_private(Path(str(self.path) + ".state"))
            self.pending_rotation = None
            return result

    def clear(self):
        with _lock(str(self.path) + ".lock"):
            self._write(None)
            _atomic_write(self.path,"null")
            _remove_private(Path(str(self.path)+".state"))
            self.pending_rotation=self.pending_previous_refresh=None

    def get(self, deadline=None, cancel=None):
        end = deadline if deadline is not None else time.time() + 10
        if self.pending_rotation:
            return self.refresh(None, end, cancel)
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
            if self.pending_rotation:
                persisted=self._persist_rotation(end,cancel)
                if persisted is not None:
                    return persisted
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
            except (SignetUnauthorizedError, SignetForbiddenError) as error:
                if error.reason in ("revoked", "refresh_reuse", "user_deactivated"):
                    _atomic_write(str(self.path) + ".state", _json_dump({"state":"dead", "reason":error.reason}))
                raise
            self.pending_rotation = _login(value)
            self.pending_previous_refresh=credential["refreshToken"]
            persisted = self._persist_rotation(end,cancel)
            if persisted is None:
                raise SignetCredentialError(RuntimeError("Credential changed during refresh"))
            return persisted

    def _persist_rotation(self,end,cancel):
        rotated=self.pending_rotation
        if not isinstance(rotated,dict):
            raise RuntimeError("No refresh rotation pending")
        try:
            saved=self.load(end,cancel)
        except SignetUnauthorizedError:
            self.pending_rotation=self.pending_previous_refresh=None
            raise
        except Exception as error:
            self.reason="refresh_in_doubt"
            raise SignetCredentialError(error,"refresh_in_doubt") from error
        if saved is None and self.reason is not None:
            self.reason="refresh_in_doubt"
            raise SignetCredentialError(RuntimeError("Cannot verify current login credential"),"refresh_in_doubt")
        if saved is None and self.reason is None:
            self.pending_rotation=self.pending_previous_refresh=None
            raise SignetUnauthorizedError("missing_credential")
        if saved and saved["credential"]["refreshToken"] not in (self.pending_previous_refresh,rotated["refreshToken"]):
            self.pending_rotation=self.pending_previous_refresh=None
            return saved["credential"]["accessToken"] if _timestamp(saved["credential"]["accessExpiresAt"])>time.time() else None
        try:
            self._write(rotated)
        except Exception as error:
            self.reason = "refresh_in_doubt"
            raise SignetCredentialError(error, "refresh_in_doubt") from error
        value = rotated["accessToken"]
        self.pending_rotation = self.pending_previous_refresh = None
        return value


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
    harness: str = "cli"


def resolve_target(*, harness=None, flag_url=None, flag_key=None, config_url=None, env=None, keyring=None, timeout: float = 10, deadline=None, cancel=None):
    end = _request_end(10, timeout, deadline)
    _check_control(end, cancel)
    selected_harness=_identifier(harness if harness is not None else "cli")
    env = os.environ if env is None else env
    flag_url = flag_url.strip() if flag_url is not None else None
    if flag_url is not None and not flag_url:
        raise ValueError("flag_url cannot be empty")
    env_url = env.get("SIGNET_DAEMON_URL", "").strip()
    entry = ConnectorRegistry(env=env).read().get(harness) if harness and not (flag_url and flag_key is not None) else None
    environment_binding = bool(env.get("SIGNET_HOST", "").strip() or env.get("SIGNET_PORT", "").strip())
    explicit = (flag_url or (entry or {}).get("url") or env_url or (config_url if not environment_binding else None) or "").strip()
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
    environment_credential = bool(env.get("SIGNET_API_KEY", "").strip() or env.get("SIGNET_API_KEY_FILE", "").strip())
    environment_credential_applies = flag_key is not None or not environment_credential or (not env_url and not flag_url) or bool(env_url and _url(env_url) == url)
    if flag_key is not None:
        if not flag_key.strip():
            raise ValueError("flag_key cannot be empty")
        credential = Credential("flag", lambda deadline, cancel: flag_key.strip())
    elif environment_credential_applies and env.get("SIGNET_API_KEY", "").strip():
        key = env["SIGNET_API_KEY"].strip()
        credential = Credential("env", lambda deadline, cancel: key)
    else:
        key_file = (env.get("SIGNET_API_KEY_FILE", "").strip() if environment_credential_applies else None) or (entry.get("keyFile") if entry and _url(entry["url"]) == url else None)
        if key_file:
            read_key_file(key_file)
            credential = Credential("key-file", lambda deadline, cancel: read_key_file(key_file))
        else:
            store = LoginStore(url, env=env, keyring=keyring)
            saved = _bounded(lambda: store.load(end, cancel), end, cancel, workers=_CREDENTIAL_WORKERS)
            credential = Credential(saved["source"] if saved else "none", store.get, store.refresh, lambda: store.source, lambda: store.reason)
    _check_control(end, cancel)
    host = urllib.parse.urlsplit(url).hostname
    if host is None:
        raise ValueError("Resolved target has no hostname")
    loopback = host == "localhost"
    if host != "localhost":
        try:
            address = ipaddress.ip_address(host)
            mapped = getattr(address, "ipv4_mapped", None)
            loopback = address.is_loopback or bool(mapped and mapped.is_loopback)
        except ValueError:
            loopback = False
    return ResolvedTarget(url, url, credential, credential.source != "none" or not loopback, selected_harness)


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
    if end is not None and time.time() >= end:
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

    def request(self, method, path, body=None, *, headers=None, timeout=None, deadline=None, cancel=None, raw_body=None):
        if not path.startswith("/") or path.startswith("//") or any(c in path for c in "\\\r\n"):
            raise ValueError("Request path must be daemon-relative")
        method = method.upper()
        headers = {k.lower(): v for k, v in {**self.headers, **(headers or {})}.items() if k.lower() not in ("x-signet-actor", "x-signet-actor-type")}
        end = _request_end(self.timeout, timeout, deadline)
        retryable = method in ("GET", "HEAD", "OPTIONS", "PUT", "DELETE") or method == "POST" and bool(headers.get("idempotency-key"))
        if body is not None and raw_body is not None:
            raise ValueError("Use JSON or raw body, not both")
        if raw_body is not None and not isinstance(raw_body,bytes):
            raise ValueError("Raw body must be bytes")
        data = raw_body if raw_body is not None else _json_dump(body, ensure_ascii=False).encode() if body is not None else None
        if data is not None:
            headers["content-type"] = "application/octet-stream" if raw_body is not None else "application/json"
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
            fetching = False
            try:
                if self.credential_provider:
                    try:
                        token = _bounded(self.credential_provider, end, cancel, workers=_CREDENTIAL_WORKERS)
                    except (SignetApiError, SignetCredentialError, SignetNetworkError):
                        raise
                    except Exception as error:
                        _check_control(end, cancel)
                        raise SignetCredentialError(error) from error
                    if token is not None and (not isinstance(token,str) or len(token)>65536 or any(ord(char)<33 or ord(char)>126 for char in token)):
                        raise SignetCredentialError(ValueError("Credential provider returned an invalid bearer credential"))
                    if token:
                        headers["authorization"] = "Bearer " + token
                    else:
                        headers.pop("authorization", None)
                fetching = True
                return self._exchange(method, path, data, headers, end, cancel)
            except (socket.timeout, TimeoutError) as error:
                raise SignetTimeoutError("Request deadline exceeded") from error
            except (OSError, http.client.HTTPException, SignetApiError, SignetNetworkError) as error:
                if not fetching:
                    raise
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


class FlushFailure(TypedDict):
    code: str
    status: int | None
    reason: str | None


class _FlushResult(TypedDict):
    state: Literal["complete", "deferred", "failed"]
    pending: int | None
    sent: int
    failure: FlushFailure | None


class OutboxFlushResult(_FlushResult, total=False):
    quarantined: int
    dropped: int


_CLAIM_RUNTIME = str(uuid.uuid4())
_ACTIVE_CLAIMS = set()
_ACTIVE_CLAIMS_LOCK = threading.Lock()


@contextlib.contextmanager
def _claim_execution(owner):
    try:
        yield
    finally:
        with _ACTIVE_CLAIMS_LOCK:
            _ACTIVE_CLAIMS.discard(owner["token"])


class DurableOutbox:
    MAX_ENTRIES = 200
    MAX_BYTES = 64 * 1024 * 1024

    def __init__(self, origin, *, env=None, harness="cli"):
        self.origin = _url(origin)
        self.harness = _identifier(harness)
        self.directory = config_directory(env) / "outbox" / origin_hash(self.origin) / self.harness

    @contextlib.contextmanager
    def _locked(self, deadline=None, cancel=None):
        end = deadline if deadline is not None else time.time()+10
        _check_control(end,cancel)
        root = self.directory.parent
        with _lock(self.directory/".lock",end,cancel):
            with _lock(root/".lock",end,cancel,legacy=True):
                self._migrate_legacy(end,cancel)
                _check_control(end,cancel)
                yield

    def _legacy_pending(self):
        for path in self._names(self.directory.parent):
            if not path.name.endswith(".json"):
                continue
            try:
                info = path.lstat()
            except FileNotFoundError:
                continue
            if not stat.S_ISDIR(info.st_mode) or _is_link(info):
                return True
        return False

    def _migrate_legacy(self, end, cancel):
        root = self.directory.parent
        quarantine = root/".legacy-quarantine"
        for path in self._names(root):
            _check_control(end,cancel)
            if not path.name.endswith(".json"):
                continue
            try:
                info = path.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISDIR(info.st_mode) and not _is_link(info):
                continue
            _directory(quarantine)
            reason = "legacy_metadata" if path.name == ".status.json" else "legacy_unattributed"
            target = quarantine/(path.name+"."+reason+"."+str(uuid.uuid4())+".json")
            _check_control(end,cancel)
            _rename_private(path,target)

    def recover_legacy(self, file: str, harness: str):
        if harness != self.harness or not isinstance(file,str) or Path(file).name != file or not file.endswith(".json") or file.startswith("."):
            raise ValueError("Invalid legacy recovery selection")
        with self._locked():
            source = self.directory.parent/".legacy-quarantine"/file
            text = _read_private(source,self.MAX_BYTES)
            if text is None:
                raise FileNotFoundError("Legacy record not found")
            value = _json_load(text)
            if not isinstance(value,dict):
                raise ValueError("Invalid legacy record")
            fields = {"origin","headers","id","idempotencyKey","method","path","body","createdAt","attempts","lastError"}
            if "version" in value or "harness" in value:
                if set(value) != fields|{"version","harness"} or type(value["version"]) is not int or value["version"] != 1 or value["harness"] != harness:
                    raise ValueError("Legacy record belongs to another harness")
            elif set(value) not in (fields,fields-{"headers"}):
                raise ValueError("Invalid legacy record")
            selected = {**value,"headers":value.get("headers",{}),"version":1,"harness":harness}
            self._validate_entry(selected)
            if selected["origin"] != self.origin:
                raise ValueError("Legacy origin mismatch")
            target = self._file(selected["id"])
            if target.exists() or any(p.name.startswith(selected["id"]+".") for p in self._names(self.directory/".claims")):
                raise ValueError("Legacy recovery collision")
            entries = self._entries()
            reserved = self._reserved()
            encoded = _json_dump(selected,ensure_ascii=False)
            total = reserved["bytes"]+sum(self._file(e["id"]).stat().st_size+512 for e in entries)-source.stat().st_size+len(encoded.encode())
            if reserved["count"]+len(entries) > self.MAX_ENTRIES or total > self.MAX_BYTES:
                raise ValueError("Legacy recovery exceeds outbox capacity")
            _atomic_write(source,encoded)
            _rename_private(source,target)
            return selected

    def _validate_entry(self, value):
        fields = {"version","harness","origin","headers","id","idempotencyKey","method","path","body","createdAt","attempts","lastError"}
        if not isinstance(value,dict) or set(value) not in (fields,fields|{"upload"}) or type(value["version"]) is not int or value["version"] != 1 or not isinstance(value["origin"],str) or not isinstance(value["createdAt"],str) or not isinstance(value["id"],str) or not isinstance(value["idempotencyKey"],str) or not re.fullmatch(r"[\x21-\x7e]{1,512}",value["idempotencyKey"]) or value["method"] != "POST" or type(value["attempts"]) is not int or value["attempts"] < 0 or value["lastError"] is not None and not isinstance(value["lastError"],str):
            raise ValueError("Corrupt Signet outbox entry")
        self._file(value["id"])
        _identifier(value["harness"])
        if _url(value["origin"]) != value["origin"] or _delivery_headers(value["headers"]) != value["headers"]:
            raise ValueError("Invalid outbox origin or scope")
        _timestamp(value["createdAt"])
        _delivery_path(value["path"])

        if "upload" in value:
            _upload_state(value["upload"])

    def _file(self, entry_id):
        if not re.fullmatch(r"[a-f0-9-]{36}", entry_id):
            raise ValueError("Invalid outbox id")
        return self.directory / (entry_id + ".json")

    def _meta(self):
        try:
            return self._parse_meta()
        except (ValueError,PermissionError):
            self._quarantine(self.directory/".status.json","bad_status")
            meta={"admitting":False,"evicted":0,"dropped":0,"lastDrop":None,"removing":[],"countersLost":True}
            self._save_meta(meta)
            return meta

    def _parse_meta(self):
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
        self._reap()
        self._recover_claims()
        if meta["removing"]:
            for entry_id in meta["removing"]:
                _remove_private(self._file(entry_id))
                for path in self._names(self.directory/".claims"):
                    if path.name.startswith(entry_id+"."):
                        _remove_private(path,durable=not path.name.endswith(".owner"))
            meta["removing"] = []
            self._save_meta(meta)
        if not meta["admitting"]:
            return
        entries = self._entries()
        reserved = self._reserved()
        total = reserved["bytes"] + sum(self._file(e["id"]).stat().st_size + 512 for e in entries)
        evictions = []
        while entries and (len(entries)+reserved["count"] > self.MAX_ENTRIES or total > self.MAX_BYTES):
            oldest = entries.pop(0)
            total -= self._file(oldest["id"]).stat().st_size + 512
            evictions.append(oldest["id"])
        meta["admitting"] = False
        meta["evicted"] += len(evictions)
        meta["removing"] = evictions
        self._save_meta(meta)
        self._recover(meta)

    def _names(self, directory=None):
        try:
            return list((directory or self.directory).iterdir())
        except FileNotFoundError:
            return []

    def _quarantine(self, path, reason):
        directory = self.directory / ".quarantine"
        _directory(directory)
        target = directory / (path.name+"."+reason+"."+str(uuid.uuid4())+".json")
        try:
            _rename_private(path,target)
        except FileNotFoundError:
            return
        info = target.lstat()
        if os.name != "nt" and stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid():
            target.chmod(0o600)

    def _reap(self):
        for directory in (self.directory, self.directory/".claims", self.directory/".quarantine", self.directory/".lock.tickets"):
            for path in self._names(directory):
                try:
                    if path.name.endswith(".tmp") and time.time()-path.lstat().st_mtime > 300:
                        _remove_private(path)
                except FileNotFoundError:
                    continue

    def _recover_claims(self):
        for path in self._names(self.directory/".claims"):
            parts=re.fullmatch(r"([a-f0-9-]{36})\.([a-f0-9-]{36})\.json",path.name)
            if parts is None:
                if path.name.endswith(".json"):
                    self._quarantine(path,"bad_claim")
                continue
            entry_id,generation=parts.groups()
            try:
                text = _read_private(str(path)+".owner", 4096)
                owner = _lock_record(text) if text else None
            except (ValueError, PermissionError):
                owner = None
            with _ACTIVE_CLAIMS_LOCK:
                ended_here = owner and owner.get("runtime") == _CLAIM_RUNTIME and generation not in _ACTIVE_CLAIMS
            if not owner or owner.get("token")!=generation or ended_here or not _owner_alive(owner):
                _rename_private(path,self._file(entry_id))
                _remove_private(Path(str(path)+".owner"))

    def _reserved(self):
        result = {"count":0, "bytes":0, "claimed":0, "quarantine":[]}
        for directory in (".claims", ".quarantine", "legacy"):
            for path in self._names(self.directory.parent/".legacy-quarantine" if directory == "legacy" else self.directory/directory):
                if not path.name.endswith(".json"):
                    continue
                try:
                    size = path.lstat().st_size
                except FileNotFoundError:
                    continue
                metadata = directory == "legacy" and path.name.startswith(".status.json")
                result["count"] += 0 if metadata else 1
                result["bytes"] += size+(0 if metadata else 512)
                if directory == ".claims":
                    result["claimed"] += 1
                else:
                    result["quarantine"].append({"file":path.name,"reason":("legacy_metadata" if path.name.startswith(".status.json") else "legacy_unattributed") if directory == "legacy" else path.name.split(".")[-3]})
        return result

    def _entries(self):
        entries = []
        for path in self._names():
            if path.name.startswith(".") or not path.name.endswith(".json"):
                continue
            try:
                text = _read_private(path, self.MAX_BYTES)
                if text is None:
                    continue
                value = _json_load(text)
                self._validate_entry(value)
                if self._file(value["id"]) != path:
                    raise ValueError("Invalid outbox filename")
                entries.append(value)
            except (ValueError, TypeError, KeyError, PermissionError):
                self._quarantine(path,"bad_file")
        return sorted(entries,key=lambda entry:(entry["createdAt"],entry["id"]))

    def _claim_locked(self, entry, force=False):
        if entry["origin"] != self.origin or entry["harness"] != self.harness:
            return None
        path = self._file(entry["id"])
        if entry["attempts"] >= 20 or time.time()-_timestamp(entry["createdAt"]) >= 7*86400:
            self._quarantine(path,"poison_attempts" if entry["attempts"] >= 20 else "poison_age")
            return None
        if not force and entry["attempts"] and time.time()-path.stat().st_mtime < min(60,2**min(entry["attempts"],6)):
            return None
        entry = {**entry,"attempts":entry["attempts"]+1}
        owner = {**_owner(), "runtime":_CLAIM_RUNTIME}
        claimed = self.directory/".claims"/(entry["id"]+"."+owner["token"]+".json")
        _directory(claimed.parent)
        _atomic_write(path,_json_dump(entry,ensure_ascii=False))
        _atomic_write(str(claimed)+".owner",_json_dump(owner),durable=False)
        _rename_private(path,claimed)
        with _ACTIVE_CLAIMS_LOCK:
            _ACTIVE_CLAIMS.add(owner["token"])
        return entry,owner

    def checkpoint_upload(self, entry, state, *, end=None, cancel=None):
        state=_upload_state(state)
        with self._locked(end,cancel):
            for path in self._names(self.directory/".claims"):
                if not path.name.startswith(entry["id"]+".") or not path.name.endswith(".json"):
                    continue
                owner_text=_read_private(str(path)+".owner",4096)
                owner=_json_load(owner_text) if owner_text is not None else None
                with _ACTIVE_CLAIMS_LOCK:
                    active=isinstance(owner,dict) and owner.get("token") in _ACTIVE_CLAIMS
                if not active:
                    continue
                _atomic_write(path,_json_dump({**entry,"upload":state},ensure_ascii=False))
                entry["upload"]=state
                return
            raise ValueError("Upload claim ownership changed")

    def _settle(self, claim, error=None, *, end=None, cancel=None):
        entry,owner = claim
        with self._locked(end,cancel):
            _check_control(end,cancel)
            path = self.directory/".claims"/(entry["id"]+"."+owner["token"]+".json")
            text = _read_private(str(path)+".owner",4096)
            if text is None or _lock_record(text).get("token") != owner["token"]:
                return
            _check_control(end,cancel)
            marker = Path(str(path)+".owner")
            if error is None:
                _remove_private(path)
                _remove_private(marker,durable=False)
                return
            status,reason = getattr(error,"status",None),getattr(error,"reason",None)
            if status == 403 and reason in ("agent_not_permitted","agent_binding_conflict","actor_conflict","project_not_permitted","permission"):
                self._quarantine(path,"scope_"+reason)
                _remove_private(marker,durable=False)
            elif entry["attempts"] >= 20:
                self._quarantine(path,"poison_attempts")
                _remove_private(marker,durable=False)
            elif isinstance(status,int) and 400 <= status < 500 and status not in (401,408,429):
                self._remove(self._meta(),entry,status)
            else:
                _rename_private(path,self._file(entry["id"]))
                _remove_private(marker,durable=False)
                _atomic_write(self._file(entry["id"]),_json_dump({**entry,"lastError":"http_%s" % status if status else getattr(error,"reason",None) or type(error).__name__},ensure_ascii=False))

    def _remove(self, meta, entry, disposition):
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
        entry = {"version":1, "harness":self.harness, "origin": self.origin, "headers": headers, "id": str(uuid.uuid4()), "idempotencyKey": str(uuid.uuid4()) if idempotency_key is None else idempotency_key, "method": method, "path": path, "body": body, "createdAt": _iso(created), "attempts": 0, "lastError": None}
        encoded = _json_dump(entry, ensure_ascii=False)
        size = len(encoded.encode()) + 512
        if size > self.MAX_BYTES:
            raise ValueError("Outbox entry exceeds 64 MiB")
        reserved = self._reserved()
        if reserved["count"] >= self.MAX_ENTRIES or reserved["bytes"]+size > self.MAX_BYTES:
            raise ValueError("Outbox capacity reserved by claims or quarantined evidence")
        total = reserved["bytes"]+sum(self._file(e["id"]).stat().st_size+512 for e in entries)
        if len(entries)+reserved["count"] >= self.MAX_ENTRIES or total+size > self.MAX_BYTES:
            meta["admitting"] = True
            self._save_meta(meta)
        _atomic_write(self._file(entry["id"]), encoded)
        self._recover(meta)
        return entry

    def enqueue(self, method, path, body, *, idempotency_key=None, deadline=None, cancel=None, headers=None):
        body = _json_load(_json_dump(body, ensure_ascii=False))
        headers = _delivery_headers(headers or {})
        end = deadline / 1000 if deadline is not None else time.time() + 10
        with self._locked(end,cancel):
            _check_control(end, cancel)
            return self._admit(method, path, body, idempotency_key, self._meta(), headers)

    def deliver(self, method, path, body, send, *, idempotency_key=None, deadline=None, cancel=None, headers=None):
        end = deadline/1000 if deadline is not None else time.time()+10
        try:
            body = _json_load(_json_dump(body,ensure_ascii=False))
            headers = _delivery_headers(headers or {})
            with self._locked(end,cancel):
                entry = self._admit(method,path,body,idempotency_key,self._meta(),headers)
                claim = self._claim_locked(entry,True)
                if claim is None:
                    raise ValueError("Delivery was not claimed")
        except Exception as error:
            raise SignetOutboxAdmissionError(error) from error
        with _claim_execution(claim[1]):
            try:
                _check_control(end,cancel)
                value = send(claim[0],end*1000)
            except Exception as error:
                if cancel is None or not cancel.is_set():
                    if time.time() < end:
                        try:
                            self._settle(claim,error,end=end,cancel=cancel)
                        except Exception as cleanup:
                            raise error from cleanup
                raise
            try:
                self._settle(claim,end=end,cancel=cancel)
                return value,None
            except Exception as error:
                return value,error

    def entries(self, *, end=None, cancel=None):
        with self._locked(end,cancel):
            meta = self._meta()
            self._recover(meta)
            return self._entries()

    def status(self):
        with self._locked():
            meta = self._meta()
            self._recover(meta)
            entries = self._entries()
            reserved = self._reserved()
            return {"countersLost":meta.get("countersLost",False), "pending":len(entries)+reserved["claimed"], "claimed":reserved["claimed"], "quarantined":len(reserved["quarantine"]), "quarantine":reserved["quarantine"], "lastFlush":meta.get("lastFlush"), "bytes":reserved["bytes"]-reserved["count"]*512+sum(self._file(e["id"]).stat().st_size for e in entries), "evicted":meta["evicted"], "dropped":meta["dropped"], "lastDrop":meta["lastDrop"]}

    def flush(self, send, *, timeout=5, deadline=None, force=False, cancel=None, origin=None, harness=None) -> OutboxFlushResult:
        end = _request_end(5,timeout,deadline)
        try:
            _check_control(end,cancel)
        except (SignetNetworkError,SignetTimeoutError) as error:
            return {"state":"failed","pending":None,"sent":0,"failure":{"code":type(error).__name__,"status":None,"reason":None}}
        if origin is not None and origin != self.origin or harness is not None and harness != self.harness:
            return {"state":"deferred","pending":None,"sent":0,"failure":{"code":"partition_mismatch","status":None,"reason":None}}
        legacy = self._legacy_pending()
        if legacy:
            try:
                with self._locked(end,cancel):
                    pass
            except (SignetNetworkError,SignetTimeoutError) as error:
                return {"state":"failed","pending":None,"sent":0,"failure":{"code":type(error).__name__,"status":None,"reason":None}}
        if not any(not p.name.startswith(".") and p.name.endswith(".json") for p in self._names()) and not any(p.name.endswith(".json") for p in self._names(self.directory/".claims")):
            quarantined=len(self._reserved()["quarantine"])
            return {"state":"deferred" if quarantined else "complete","pending":0,"sent":0,"failure":None,"quarantined":quarantined}
        sent=0
        failure:FlushFailure|None=None
        try:
            ids = [entry["id"] for entry in self.entries(end=end,cancel=cancel)]
            for entry_id in ids:
                _check_control(end,cancel)
                with self._locked(end,cancel):
                    self._recover(self._meta())
                    entry = next((entry for entry in self._entries() if entry["id"] == entry_id),None)
                    claim = self._claim_locked(entry,force) if entry else None
                if claim is None:
                    continue
                with _claim_execution(claim[1]):
                    try:
                        _check_control(end,cancel)
                        send(claim[0],min(end,time.time()+60)*1000)
                        self._settle(claim,end=end,cancel=cancel)
                        sent += 1
                    except Exception as error:
                        if (cancel is None or not cancel.is_set()) and time.time() < end:
                            try:
                                self._settle(claim,error,end=end,cancel=cancel)
                            except Exception as cleanup:
                                raise error from cleanup
                        status = getattr(error,"status",None)
                        if isinstance(status,int) and 400 <= status < 500 and status not in (401,408,429):
                            failure = {"code":type(error).__name__,"status":status,"reason":getattr(error,"reason",None)}
                            continue
                        raise

        except Exception as error:
            failure = {"code":type(error).__name__,"status":getattr(error,"status",None),"reason":getattr(error,"reason",None)}
        try:
            with self._locked(end,cancel):
                _check_control(end,cancel)
                meta = self._meta()
                self._recover(meta)
                pending = len(self._entries())+self._reserved()["claimed"]
                result:OutboxFlushResult = {"state":"failed" if failure else "deferred" if pending or self._reserved()["quarantine"] else "complete","pending":pending,"sent":sent,"failure":failure,"quarantined":len(self._reserved()["quarantine"]),"dropped":meta["dropped"]}
                _check_control(end,cancel)
                meta["lastFlush"] = result
                self._save_meta(meta)
                return result
        except (SignetNetworkError,SignetTimeoutError) as error:
            return {"state":"failed","pending":None,"sent":sent,"failure":failure or {"code":type(error).__name__,"status":None,"reason":None}}

    def purge(self, include_legacy=False):
        with self._locked():
            if include_legacy:
                _remove_private(self.directory.parent/".legacy-quarantine",recursive=True)
            for path in self._names():
                if path.name == ".lock.tickets":
                    continue
                _remove_private(path,recursive=True)



def _iso(timestamp):
    return datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class NodeTransport(SignetTransport):
    def __init__(self, target, *, env=None, delivery_paths=(), **options):
        super().__init__(target.url, **options)
        if _url(target.url) != _url(target.origin):
            raise ValueError("Target origin does not match URL")
        self.target = dataclasses.replace(target, url=_url(target.url), origin=_url(target.origin))
        self.outbox = DurableOutbox(target.origin, env=env, harness=target.harness)
        self.delivery_paths = {"/api/hooks/session-end", *delivery_paths}
        for path in self.delivery_paths:
            _delivery_path(path)

    def _send_entry(self, entry, deadline, **options):
        if not self.target.remote or entry["path"] != "/api/hooks/session-end":
            return self._send(entry["method"],entry["path"],entry["body"],captured_headers=entry["headers"],deadline=deadline,**options)
        upload=entry.get("upload")
        end=deadline/1000
        def checkpoint(state):
            nonlocal upload
            self.outbox.checkpoint_upload(entry,state,end=end,cancel=options.get("cancel"))
            upload=state
        for recovering in (False,True):
            try:
                body=_capture_remote_session_end(entry["body"],upload,checkpoint,lambda method,path,**step:self._send(method,path,captured_headers=entry["headers"],deadline=deadline,cancel=options.get("cancel"),timeout=options.get("timeout"),**step),end,options.get("cancel"))
                return self._send(entry["method"],entry["path"],body,captured_headers=entry["headers"],deadline=deadline,**options)
            except SignetApiError as error:
                if error.status != 422 or upload is None:
                    raise
                if recovering:
                    raise SignetUploadChecksumError("Upload checksum failed after recovery; original transcript retained") from error
                checkpoint({**upload,"uploadId":None,"receivedBytes":0})

    def _send(self, method, path, body=None, *, captured_headers=None, **options):
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
            return client.request(method, path, body, **options)
        except SignetUnauthorizedError as error:
            if not acquired[0] or used[0] is None or error.reason != "expired" or not self.target.credential.refresh_provider:
                raise
            end = deadline / 1000 if deadline is not None else time.time() + self.timeout
            try:
                _bounded(lambda: self.target.credential.refresh(used[0], end, options.get("cancel")), end, options.get("cancel"), workers=_CREDENTIAL_WORKERS)
            except (SignetApiError,SignetNetworkError,SignetTimeoutError,SignetCredentialError):
                raise
            except Exception as failure:
                raise SignetCredentialError(failure) from failure
            return client.request(method, path, body, **options)

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
            result, cleanup_error = self.outbox.deliver("POST", path, body, lambda entry, end: self._send_entry(entry,end,headers=headers,cancel=options.get("cancel"),timeout=options.get("timeout")), idempotency_key=headers["idempotency-key"], deadline=deadline, cancel=options.get("cancel"), headers=_delivery_headers({**{k.lower(): v for k, v in self.headers.items()}, **headers}))
            value = result
            if cleanup_error:
                return value
        else:
            value = self._send(method, path, body, headers=headers, **options)
        if delivery:
            self.flush(deadline=deadline,cancel=options.get("cancel"))
        return value

    def flush(self, **options) -> OutboxFlushResult:
        try:
            return self.outbox.flush(lambda entry, deadline: self._send_entry(entry,deadline,headers={"Idempotency-Key":entry["idempotencyKey"]},cancel=options.get("cancel")),**{**options,"origin":self.target.origin,"harness":self.target.harness})
        except Exception as error:
            return {"state":"failed","pending":None,"sent":0,"failure":{"code":type(error).__name__,"status":getattr(error,"status",None),"reason":getattr(error,"reason",None)}}
