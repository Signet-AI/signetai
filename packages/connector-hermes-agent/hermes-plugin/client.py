"""Signet daemon HTTP client.

Communicates with the Signet daemon on localhost:3850 (default) for
memory operations: search, store, hooks, and session lifecycle.

Configuration resolution:
  1. SIGNET_HOST + SIGNET_PORT env vars
  2. SIGNET_DAEMON_URL env var (full URL override)
  3. Default: http://localhost:3850
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_DEFAULT_HOST = "localhost"
_DEFAULT_PORT = 3850
_TIMEOUT_SECS = 5
_LONG_TIMEOUT_SECS = 15
_RECALL_TIMEOUT_SECS = 30


def _sanitize(value: str) -> str:
    """Strip leading/trailing whitespace and embedded newlines from env values."""
    return value.strip().replace("\r", "").replace("\n", "")


def _resolve_base_url() -> str:
    """Resolve the Signet daemon base URL."""
    explicit = _sanitize(os.environ.get("SIGNET_DAEMON_URL", ""))
    if explicit:
        return explicit.rstrip("/")
    host = _sanitize(os.environ.get("SIGNET_HOST", _DEFAULT_HOST))
    port = _sanitize(os.environ.get("SIGNET_PORT", str(_DEFAULT_PORT)))
    return f"http://{host}:{port}"


def _read_json_response(resp) -> Dict[str, Any]:
    """Read a daemon response, treating empty successful bodies as an empty object."""
    body = resp.read()
    if not body:
        return {}
    return json.loads(body.decode("utf-8"))


def _safe_score(value: Any) -> float:
    """Coerce daemon result scores without failing recall on malformed rows."""
    try:
        return float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0


class SignetClient:
    """HTTP client for the Signet daemon API."""

    def __init__(self, agent_id: str = "", harness: str = "hermes-agent"):
        self._base_url = _resolve_base_url()
        self._agent_id = agent_id
        self._harness = harness

    @property
    def base_url(self) -> str:
        return self._base_url

    def _headers(self, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        h: Dict[str, str] = {
            "Content-Type": "application/json",
            "x-signet-runtime-path": "plugin",
            "x-signet-agent-id": self._agent_id,
            "x-signet-actor": "hermes-memory-plugin",
        }
        # Include auth token when present (required for remote/non-localhost mode).
        # In the default hybrid mode the daemon allows unauthenticated localhost
        # requests, so this is optional but included when available.
        token = _sanitize(os.environ.get("SIGNET_TOKEN", ""))
        if token:
            h["Authorization"] = f"Bearer {token}"
        if extra:
            h.update(extra)
        return h

    def _post(
        self,
        path: str,
        body: Dict[str, Any],
        *,
        timeout: float = _TIMEOUT_SECS,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> Optional[Dict[str, Any]]:
        """POST JSON to the daemon. Returns parsed response or None on failure."""
        url = f"{self._base_url}{path}"
        data = json.dumps(body).encode("utf-8")
        headers = self._headers(extra_headers)
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return _read_json_response(resp)
        except urllib.error.HTTPError as e:
            body_text = ""
            try:
                body_text = e.read().decode("utf-8", errors="replace")[:200]
            except Exception as read_err:
                logger.debug("Signet POST %s: failed to read error body: %s", path, read_err)
            logger.debug("Signet POST %s returned %d: %s", path, e.code, body_text)
            return None
        except (urllib.error.URLError, OSError, TimeoutError, ValueError) as e:
            logger.debug("Signet POST %s failed: %s", path, e)
            return None

    def _get(
        self,
        path: str,
        *,
        timeout: float = _TIMEOUT_SECS,
    ) -> Optional[Dict[str, Any]]:
        """GET from the daemon. Returns parsed response or None on failure."""
        url = f"{self._base_url}{path}"
        req = urllib.request.Request(url, headers=self._headers(), method="GET")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return _read_json_response(resp)
        except (urllib.error.HTTPError, urllib.error.URLError, OSError, TimeoutError, ValueError) as e:
            logger.debug("Signet GET %s failed: %s", path, e)
            return None

    def _patch(
        self,
        path: str,
        body: Dict[str, Any],
        *,
        timeout: float = _TIMEOUT_SECS,
    ) -> Optional[Dict[str, Any]]:
        """PATCH JSON to the daemon. Returns parsed response or None on failure."""
        url = f"{self._base_url}{path}"
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=self._headers(), method="PATCH")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return _read_json_response(resp)
        except (urllib.error.HTTPError, urllib.error.URLError, OSError, TimeoutError, ValueError) as e:
            logger.debug("Signet PATCH %s failed: %s", path, e)
            return None

    def _delete(
        self,
        path: str,
        *,
        timeout: float = _TIMEOUT_SECS,
    ) -> Optional[Dict[str, Any]]:
        """DELETE from the daemon. Returns parsed response or None on failure."""
        url = f"{self._base_url}{path}"
        req = urllib.request.Request(url, headers=self._headers(), method="DELETE")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return _read_json_response(resp)
        except (urllib.error.HTTPError, urllib.error.URLError, OSError, TimeoutError, ValueError) as e:
            logger.debug("Signet DELETE %s failed: %s", path, e)
            return None

    # -- Health ---------------------------------------------------------------

    def is_available(self) -> bool:
        """Check if the Signet daemon is reachable. No credentials needed."""
        result = self._get("/health", timeout=2)
        return result is not None

    # -- Hooks ----------------------------------------------------------------

    def session_start(
        self,
        session_key: str,
        *,
        project: str = "",
    ) -> Optional[Dict[str, Any]]:
        """Call session-start hook. Returns identity + memories + inject text."""
        return self._post(
            "/api/hooks/session-start",
            {
                "harness": self._harness,
                "sessionKey": session_key,
                "project": project,
                "agentId": self._agent_id,
            },
            timeout=_LONG_TIMEOUT_SECS,
        )

    def user_prompt_submit(
        self,
        session_key: str,
        user_message: str,
        *,
        last_assistant_message: str = "",
        project: str = "",
    ) -> Optional[Dict[str, Any]]:
        """Call user-prompt-submit hook. Returns recall inject text."""
        return self._post(
            "/api/hooks/user-prompt-submit",
            {
                "harness": self._harness,
                "sessionKey": session_key,
                "userMessage": user_message,
                "lastAssistantMessage": last_assistant_message,
                "agentId": self._agent_id,
                "project": project,
            },
            timeout=_RECALL_TIMEOUT_SECS,
        )

    def session_end(
        self,
        session_key: str,
        transcript: str,
        *,
        project: str = "",
        reason: str = "",
    ) -> Optional[Dict[str, Any]]:
        """Call session-end hook. Triggers memory extraction from transcript."""
        body: Dict[str, Any] = {
            "harness": self._harness,
            "sessionKey": session_key,
            "transcript": transcript,
            "agentId": self._agent_id,
            "cwd": project,
        }
        if reason:
            body["reason"] = reason
        return self._post(
            "/api/hooks/session-end",
            body,
            timeout=_LONG_TIMEOUT_SECS,
        )

    def pre_compaction(
        self,
        session_key: str,
        *,
        session_context: str = "",
        message_count: int = 0,
    ) -> Optional[Dict[str, Any]]:
        """Call pre-compaction hook. Returns summary prompt and guidelines."""
        body: Dict[str, Any] = {
            "harness": self._harness,
            "sessionKey": session_key,
        }
        if session_context:
            body["sessionContext"] = session_context
        if message_count > 0:
            body["messageCount"] = message_count
        return self._post("/api/hooks/pre-compaction", body)

    def compaction_complete(
        self,
        session_key: str,
        summary: str,
        *,
        project: str = "",
    ) -> Optional[Dict[str, Any]]:
        """Call compaction-complete hook. Saves summary as session memory."""
        return self._post(
            "/api/hooks/compaction-complete",
            {
                "harness": self._harness,
                "sessionKey": session_key,
                "summary": summary,
                "agentId": self._agent_id,
                "project": project,
            },
            timeout=_LONG_TIMEOUT_SECS,
        )

    def checkpoint_extract(
        self,
        session_key: str,
        transcript: str,
        *,
        project: str = "",
    ) -> Optional[Dict[str, Any]]:
        """Call checkpoint-extract for long-running sessions.

        Extracts only the delta since last extraction. Does not
        release the session claim.
        """
        return self._post(
            "/api/hooks/session-checkpoint-extract",
            {
                "harness": self._harness,
                "sessionKey": session_key,
                "transcript": transcript,
                "agentId": self._agent_id,
                "project": project,
            },
            timeout=_LONG_TIMEOUT_SECS,
        )

    # -- Memory API -----------------------------------------------------------

    def remember(
        self,
        content: str,
        *,
        importance: float = 0.5,
        tags: Optional[List[str]] = None,
        memory_type: str = "",
        pinned: Optional[bool] = None,
        project: str = "",
        hints: Optional[List[str]] = None,
        transcript: str = "",
        structured: Optional[Dict[str, Any]] = None,
        who: str = "hermes-agent",
    ) -> Optional[Dict[str, Any]]:
        """Store a memory via the daemon API."""
        body: Dict[str, Any] = {
            "content": content,
            "importance": importance,
            "who": who,
        }
        if self._agent_id:
            body["agentId"] = self._agent_id
        if memory_type:
            body["type"] = memory_type
        if tags:
            body["tags"] = tags
        if pinned is not None:
            body["pinned"] = pinned
        if project:
            body["project"] = project
        if hints:
            body["hints"] = hints
        if transcript:
            body["transcript"] = transcript
        if structured:
            body["structured"] = structured
        return self._post("/api/memory/remember", body, timeout=_LONG_TIMEOUT_SECS)

    def recall(
        self,
        query: str,
        *,
        limit: int = 10,
        project: str = "",
        memory_type: str = "",
        tags: str = "",
        who: str = "",
        pinned: Optional[bool] = None,
        importance_min: Optional[float] = None,
        since: str = "",
        until: str = "",
        keyword_query: str = "",
        expand: bool = False,
        score_min: Optional[float] = None,
        agent_scoped: bool = False,
    ) -> Optional[Dict[str, Any]]:
        """Search memories via hybrid recall."""
        body: Dict[str, Any] = {
            "query": query,
            "limit": limit,
        }
        if project:
            body["project"] = project
        if memory_type:
            body["type"] = memory_type
        if tags:
            body["tags"] = tags
        if who:
            body["who"] = who
        if pinned is not None:
            body["pinned"] = pinned
        if importance_min is not None:
            body["importance_min"] = importance_min
        if since:
            body["since"] = since
        if until:
            body["until"] = until
        if keyword_query:
            body["keywordQuery"] = keyword_query
        if expand:
            body["expand"] = True
        if agent_scoped and self._agent_id:
            body["agentId"] = self._agent_id

        result = self._post("/api/memory/recall", body, timeout=_RECALL_TIMEOUT_SECS)
        if (
            result
            and score_min is not None
            and isinstance(result.get("results"), list)
        ):
            kept = [
                row for row in result["results"]
                if not isinstance(row, dict) or _safe_score(row.get("score")) >= score_min
            ]
            result = dict(result)
            result["results"] = kept
            meta = result.get("meta")
            if isinstance(meta, dict):
                result["meta"] = {**meta, "totalReturned": len(kept), "noHits": len(kept) == 0}
        return result

    def get_memory(self, memory_id: str) -> Optional[Dict[str, Any]]:
        """Retrieve a single memory by ID."""
        return self._get(f"/api/memory/{urllib.parse.quote(memory_id)}")

    def list_memories(
        self,
        *,
        limit: int = 100,
        offset: int = 0,
        memory_type: str = "",
    ) -> Optional[Dict[str, Any]]:
        """List memories with optional filters."""
        params = f"?limit={limit}&offset={offset}"
        if memory_type:
            params += f"&type={urllib.parse.quote(memory_type)}"
        return self._get(f"/api/memories{params}")

    def modify_memory(
        self,
        memory_id: str,
        *,
        content: str = "",
        memory_type: str = "",
        importance: Optional[float] = None,
        tags: str = "",
        pinned: Optional[bool] = None,
        reason: str,
    ) -> Optional[Dict[str, Any]]:
        """Edit an existing memory by ID."""
        body: Dict[str, Any] = {"reason": reason}
        if content:
            body["content"] = content
        if memory_type:
            body["type"] = memory_type
        if importance is not None:
            body["importance"] = importance
        if tags:
            body["tags"] = tags
        if pinned is not None:
            body["pinned"] = pinned
        return self._patch(f"/api/memory/{urllib.parse.quote(memory_id)}", body)

    def forget_memory(
        self,
        memory_id: str,
        *,
        reason: str,
    ) -> Optional[Dict[str, Any]]:
        """Soft-delete a memory by ID."""
        params = urllib.parse.urlencode({"reason": reason})
        return self._delete(f"/api/memory/{urllib.parse.quote(memory_id)}?{params}")

    def search(
        self,
        query: str,
        *,
        limit: int = 10,
        memory_type: str = "",
    ) -> List[Dict[str, Any]]:
        """Search memories. Returns list of memory objects."""
        params = f"?q={urllib.parse.quote(query)}&limit={limit}"
        if memory_type:
            params += f"&type={urllib.parse.quote(memory_type)}"
        result = self._get(f"/api/memory/search{params}")
        if result and isinstance(result, dict):
            return result.get("results", result.get("memories", []))
        if isinstance(result, list):
            return result
        return []

    def feedback(
        self,
        ratings: Dict[str, float],
        *,
        session_key: str = "",
    ) -> Optional[Dict[str, Any]]:
        """Rate memory relevance for predictor training."""
        body: Dict[str, Any] = {"ratings": ratings}
        if session_key:
            body["session_key"] = session_key
        return self._post("/api/memory/feedback", body)
