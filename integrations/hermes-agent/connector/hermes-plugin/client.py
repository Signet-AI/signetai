"""Signet daemon HTTP client.

Communicates with the Signet daemon on 127.0.0.1:3850 (default) for
memory operations: search, store, hooks, and session lifecycle.

Configuration resolution:
  1. SIGNET_HOST + SIGNET_PORT env vars
  2. SIGNET_DAEMON_URL env var (full URL override)
  3. Default: http://127.0.0.1:3850
"""

from __future__ import annotations

import json
import hashlib
import logging
import math
import os
import threading
import urllib.parse
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

if __package__:
    from .signet_transport import ConnectorRegistry, NodeTransport, resolve_target, SignetApiError, SignetUnauthorizedError, SignetNetworkError
else:
    from signet_transport import ConnectorRegistry, NodeTransport, resolve_target, SignetApiError, SignetUnauthorizedError, SignetNetworkError

logger = logging.getLogger(__name__)

_DEFAULT_HOST = "127.0.0.1"
_DEFAULT_PORT = 3850
_TIMEOUT_SECS = 5
_LONG_TIMEOUT_SECS = 15
_RECALL_TIMEOUT_SECS = 30
_TRUSTED_ORIGINS_ENV = "SIGNET_TRUSTED_DAEMON_ORIGINS"


def _sanitize(value: str) -> str:
    """Strip leading/trailing whitespace and embedded newlines from env values."""
    return value.strip().replace("\r", "").replace("\n", "")


def _normalize_recall_limit(value: Any) -> int:
    """Match the versioned Signet recall request contract."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 10
    if isinstance(value, float) and not math.isfinite(value):
        return 10
    return min(100, max(1, math.trunc(value)))


def _build_recall_request_body(
    query: str,
    *,
    limit: Any = None,
    project: str = "",
    memory_type: str = "",
    tags: str = "",
    who: str = "",
    pinned: Optional[bool] = None,
    importance_min: Optional[float] = None,
    since: str = "",
    until: str = "",
    keyword_query: str = "",
    aggregate: bool = False,
    aggregate_budget: str = "",
    save_aggregate: Optional[bool] = None,
    min_score: Optional[float] = None,
    agent_id: str = "",
    recall_surface: str = "",
) -> Dict[str, Any]:
    """Build canonical daemon JSON for the options exposed by Hermes."""
    body: Dict[str, Any] = {"query": query, "limit": _normalize_recall_limit(limit)}
    optional_strings = {
        "project": project,
        "type": memory_type,
        "tags": tags,
        "who": who,
        "since": since,
        "until": until,
        "keywordQuery": keyword_query,
        "agentId": agent_id,
    }
    body.update({key: value for key, value in optional_strings.items() if value})
    if pinned is True:
        body["pinned"] = True
    if importance_min is not None:
        body["importance_min"] = importance_min
    if aggregate is True:
        body["aggregate"] = True
    if aggregate_budget in ("small", "medium", "large"):
        body["aggregateBudget"] = aggregate_budget
    if isinstance(save_aggregate, bool):
        body["saveAggregate"] = save_aggregate
    if isinstance(min_score, (int, float)) and not isinstance(min_score, bool) and math.isfinite(min_score):
        body["minScore"] = min_score
    if recall_surface in ("explicit_api", "tool_call", "prompt_injection", "dashboard", "other"):
        body["recallSurface"] = recall_surface
    return body


def _safe_score(value: Any) -> float:
    """Coerce daemon result scores without failing recall on malformed rows."""
    try:
        return float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0


class SignetClient:
    """HTTP client for the Signet daemon API."""

    def __init__(self, agent_id: str = "", harness: str = "hermes-agent", *, env=None):
        self._env = dict(env) if env is not None else {key: os.environ[key] for key in ("HOME", "APPDATA", "HERMES_HOME", "XDG_CONFIG_HOME", "SIGNET_DAEMON_URL", "SIGNET_HOST", "SIGNET_PORT", "SIGNET_API_KEY", "SIGNET_API_KEY_FILE") if key in os.environ}
        registry_harness = harness
        profile_home = self._env.get("HERMES_HOME")
        default_home = os.path.join(self._env.get("HOME") or os.path.expanduser("~"), ".hermes")
        if harness == "hermes-agent" and profile_home and os.path.abspath(profile_home) != os.path.abspath(default_home):
            registry_harness = harness + "." + hashlib.sha256(os.path.abspath(profile_home).encode()).hexdigest()[:16]
        target = resolve_target(harness=registry_harness, env=self._env)
        entry = ConnectorRegistry(env=self._env).read().get(registry_harness, {})
        self._base_url = target.url
        self._agent_id = entry.get("agentId") or agent_id
        self._harness = harness
        self._transport = NodeTransport(target, env=self._env, headers={"x-signet-runtime-path": "plugin"}, delivery_paths=("/api/hooks/stop",))

    @property
    def agent_id(self) -> str:
        return self._agent_id

    @property
    def base_url(self) -> str:
        return self._base_url

    @staticmethod
    def _mutation_context_headers(
        *,
        session_id: str = "",
        request_id: str = "",
    ) -> Optional[Dict[str, str]]:
        """Build optional audit headers for a mirrored memory mutation."""
        headers: Dict[str, str] = {}
        clean_session_id = _sanitize(session_id)
        clean_request_id = _sanitize(request_id)
        if clean_session_id:
            headers["x-signet-session-id"] = clean_session_id
        if clean_request_id:
            headers["x-signet-request-id"] = clean_request_id
        return headers or None

    def _call(self, method, path, body=None, *, timeout=_TIMEOUT_SECS, extra_headers=None):
        try:
            return self._transport.request(method, path, body, timeout=timeout, headers=extra_headers or {})
        except SignetUnauthorizedError:
            logger.warning("Signet session expired, run `signet login`")
            return None
        except (SignetApiError, SignetNetworkError, OSError, ValueError) as error:
            logger.warning("Signet %s %s failed: %s", method, path, type(error).__name__)
            return None

    def _post(self, path, body, *, timeout=_TIMEOUT_SECS, extra_headers=None):
        return self._call("POST", path, body, timeout=timeout, extra_headers=extra_headers)

    def _get(self, path, *, timeout=_TIMEOUT_SECS):
        return self._call("GET", path, timeout=timeout)

    def _patch(self, path, body, *, timeout=_TIMEOUT_SECS):
        return self._call("PATCH", path, body, timeout=timeout)

    def request_result(self, method, path, body=None, *, timeout=_TIMEOUT_SECS):
        try:
            return {"ok": True, "data": self._transport.request(method, path, body, timeout=timeout)}
        except SignetApiError as error:
            if error.status == 401:
                logger.warning("Signet session expired, run `signet login`")
            return {"ok": False, "status": error.status, "reason": getattr(error, "reason", None), "error": str(error)}
        except (SignetNetworkError, OSError, ValueError) as error:
            return {"ok": False, "status": None, "error": type(error).__name__}

    def _delete(self, path, *, timeout=_TIMEOUT_SECS, extra_headers=None):
        return self._call("DELETE", path, timeout=timeout, extra_headers=extra_headers)

    def is_available(self) -> bool:
        """Check if the Signet daemon is reachable. No credentials needed."""
        result = self._get("/health", timeout=2)
        return result is not None

    def session_start(
        self,
        session_key: str,
        *,
        project: str = "",
        claim_only: bool = False,
        context: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        """Call session-start hook, optionally recovering only the session claim."""
        body: Dict[str, Any] = {
            "harness": self._harness,
            "sessionKey": session_key,
            "project": project,
            "agentId": self._agent_id,
        }
        if claim_only:
            body["claimOnly"] = True
        if context:
            body["context"] = context
        return self._post(
            "/api/hooks/session-start",
            body,
            timeout=_LONG_TIMEOUT_SECS,
        )

    def user_prompt_submit(
        self,
        session_key: str,
        user_message: str,
        *,
        last_assistant_message: str = "",
        project: str = "",
        context: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        """Call user-prompt-submit hook. Returns recall inject text."""
        body: Dict[str, Any] = {
            "harness": self._harness,
            "sessionKey": session_key,
            "userMessage": user_message,
            "lastAssistantMessage": last_assistant_message,
            "agentId": self._agent_id,
            "project": project,
        }
        if context:
            body["context"] = context
        return self._post(
            "/api/hooks/user-prompt-submit",
            body,
            timeout=_RECALL_TIMEOUT_SECS,
        )

    def stop(
        self,
        session_key: str,
        last_assistant_message: str,
        *,
        project: str = "",
    ) -> Optional[Dict[str, Any]]:
        """Record a finished turn's assistant reply through the stop hook."""
        body: Dict[str, Any] = {
            "harness": self._harness,
            "sessionKey": session_key,
            "lastAssistantMessage": last_assistant_message,
            "agentId": self._agent_id,
        }
        if project:
            body["cwd"] = project
        return self._post("/api/hooks/stop", body)

    def notifications(
        self,
        session_key: str,
        hook: str,
        *,
        project: str = "",
        context: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        """Fetch pending peer notifications for a compatible Hermes hook."""
        body: Dict[str, Any] = {
            "harness": self._harness,
            "hook": hook,
            "sessionKey": session_key,
            "agentId": self._agent_id,
            "project": project,
        }
        if context:
            body["context"] = context
        return self._post(
            "/api/hooks/notifications",
            body,
            timeout=_RECALL_TIMEOUT_SECS,
        )

    def wake(
        self,
        session_key: str,
        *,
        project: str = "",
        wait_ms: int = 25000,
        on_connection: Optional[Any] = None,
        context: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        """Long-poll the direct-message wake endpoint; None on transport failure."""
        cancel = threading.Event()
        if on_connection:
            on_connection(SimpleNamespace(close=cancel.set))
        body = {"harness": self._harness, "sessionKey": session_key, "agentId": self._agent_id, "project": project, "waitMs": wait_ms}
        if context:
            body["context"] = context
        try:
            return self._transport.request("POST", "/api/cross-agent/wake", body, timeout=wait_ms / 1000 + 10, cancel=cancel)
        except SignetUnauthorizedError:
            logger.warning("Signet session expired, run `signet login`")
            return None
        except (SignetApiError, SignetNetworkError, OSError, ValueError) as error:
            logger.warning("Signet wake failed: %s", type(error).__name__)
            return None
        finally:
            if on_connection:
                on_connection(None)

    def release_wake(self, session_key: str, message_ids: List[str]) -> Optional[Dict[str, Any]]:
        """Return claimed wakes to the daemon after the host refused delivery."""
        return self._post(
            "/api/cross-agent/wake/release",
            {"sessionKey": session_key, "agentId": self._agent_id, "messageIds": message_ids},
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

    def remember(
        self,
        content: str,
        *,
        importance: float = 0.5,
        tags: Optional[List[str]] = None,
        memory_type: str = "",
        pinned: Optional[bool] = None,
        project: str = "",
        source_type: str = "",
        source_id: str = "",
        hints: Optional[List[str]] = None,
        transcript: str = "",
        structured: Optional[Dict[str, Any]] = None,
        review_after: str = "",
        who: str = "hermes-agent",
        visibility: str = "",
        supersedes: str = "",
        reason: str = "",
        idempotency_key: str = "",
        session_id: str = "",
        request_id: str = "",
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
        if source_type:
            body["sourceType"] = source_type
        if source_id:
            body["sourceId"] = source_id
        if hints:
            body["hints"] = hints
        if transcript:
            body["transcript"] = transcript
        if structured:
            body["structured"] = structured
        if review_after:
            body["reviewAfter"] = review_after
        if visibility in {"global", "private", "archived"}:
            body["visibility"] = visibility
        if supersedes:
            body["supersedes"] = supersedes
        if reason:
            body["reason"] = reason
        if idempotency_key:
            body["idempotencyKey"] = idempotency_key
        context_headers = self._mutation_context_headers(session_id=session_id, request_id=request_id)
        if context_headers:
            return self._post(
                "/api/memory/remember",
                body,
                timeout=_LONG_TIMEOUT_SECS,
                extra_headers=context_headers,
            )
        return self._post("/api/memory/remember", body, timeout=_LONG_TIMEOUT_SECS)

    def recall(
        self,
        query: str,
        *,
        limit: Any = None,
        project: str = "",
        memory_type: str = "",
        tags: str = "",
        who: str = "",
        pinned: Optional[bool] = None,
        importance_min: Optional[float] = None,
        since: str = "",
        until: str = "",
        keyword_query: str = "",
        score_min: Optional[float] = None,
        aggregate: bool = False,
        aggregate_budget: str = "",
        save_aggregate: Optional[bool] = None,
        agent_scoped: bool = False,
    ) -> Optional[Dict[str, Any]]:
        """Search memories via hybrid recall."""
        body = _build_recall_request_body(
            query,
            limit=limit,
            project=project,
            memory_type=memory_type,
            tags=tags,
            who=who,
            pinned=pinned,
            importance_min=importance_min,
            since=since,
            until=until,
            keyword_query=keyword_query,
            aggregate=aggregate,
            aggregate_budget=aggregate_budget,
            save_aggregate=save_aggregate,
            min_score=score_min,
            agent_id=self._agent_id if agent_scoped else "",
            recall_surface="tool_call",
        )

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

    def session_search(
        self,
        query: str,
        *,
        session_key: str = "",
        current_session_key: str = "",
        agent_id: str = "",
        project: str = "",
        limit: int = 10,
    ) -> Optional[Dict[str, Any]]:
        """Search active or completed session transcripts."""
        body: Dict[str, Any] = {
            "query": query,
            "limit": limit,
        }
        if session_key:
            body["sessionKey"] = session_key
        if current_session_key:
            body["currentSessionKey"] = current_session_key
        resolved_agent_id = agent_id or self._agent_id
        if resolved_agent_id:
            body["agentId"] = resolved_agent_id
        if project:
            body["project"] = project
        return self._post("/api/sessions/search", body, timeout=_RECALL_TIMEOUT_SECS)

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
        session_id: str = "",
        request_id: str = "",
    ) -> Optional[Dict[str, Any]]:
        """Soft-delete a memory by ID."""
        params = urllib.parse.urlencode({"reason": reason})
        path = f"/api/memory/{urllib.parse.quote(memory_id, safe='')}?{params}"
        context_headers = self._mutation_context_headers(session_id=session_id, request_id=request_id)
        if context_headers:
            return self._delete(path, extra_headers=context_headers)
        return self._delete(path)

    def supersede_memory(
        self,
        memory_id: str,
        superseded_by: str,
        *,
        reason: str,
        session_id: str = "",
        request_id: str = "",
    ) -> Optional[Dict[str, Any]]:
        """Mark one memory as superseded by another in an audited transaction."""
        path = f"/api/memories/{urllib.parse.quote(memory_id, safe='')}/supersede"
        body = {
            "superseded_by": superseded_by,
            "reason": reason,
        }
        context_headers = self._mutation_context_headers(session_id=session_id, request_id=request_id)
        if context_headers:
            return self._post(path, body, extra_headers=context_headers)
        return self._post(path, body)

    def search(
        self,
        query: str,
        *,
        limit: int = 10,
        memory_type: str = "",
        tags: str = "",
        project: str = "",
    ) -> List[Dict[str, Any]]:
        """Search memories. Returns list of memory objects."""
        params = f"?q={urllib.parse.quote(query, safe='')}&limit={limit}"
        if memory_type:
            params += f"&type={urllib.parse.quote(memory_type, safe='')}"
        if tags:
            params += f"&tags={urllib.parse.quote(tags, safe='')}"
        if project:
            params += f"&project={urllib.parse.quote(project, safe='')}"
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
