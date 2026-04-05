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
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body_text = ""
            try:
                body_text = e.read().decode("utf-8", errors="replace")[:200]
            except Exception as read_err:
                logger.debug("Signet POST %s: failed to read error body: %s", path, read_err)
            logger.debug("Signet POST %s returned %d: %s", path, e.code, body_text)
            return None
        except (urllib.error.URLError, OSError, TimeoutError) as e:
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
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.HTTPError, urllib.error.URLError, OSError, TimeoutError) as e:
            logger.debug("Signet GET %s failed: %s", path, e)
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
    ) -> Optional[Dict[str, Any]]:
        """Store a memory via the daemon API."""
        body: Dict[str, Any] = {
            "content": content,
            "importance": importance,
            "agentId": self._agent_id,
        }
        if tags:
            body["tags"] = tags
        return self._post("/api/memory/remember", body)

    def recall(
        self,
        query: str,
        *,
        limit: int = 10,
        min_score: float = 0.0,
    ) -> Optional[Dict[str, Any]]:
        """Search memories via hybrid recall."""
        body: Dict[str, Any] = {
            "query": query,
            "limit": limit,
            "agentId": self._agent_id,
        }
        if min_score > 0.0:
            body["minScore"] = min_score
        return self._post("/api/memory/recall", body)

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
