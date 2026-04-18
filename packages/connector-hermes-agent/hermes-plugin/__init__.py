"""Signet memory plugin — MemoryProvider for Signet persistent memory.

Bridges Hermes Agent's memory provider interface to the Signet daemon
(localhost:3850), providing hybrid search (BM25 + vector + knowledge graph),
predictive recall, cross-session memory, and the full Signet pipeline
(extraction, knowledge graph, retention decay, synthesis).

Canonical Signet memory tools (memory_search, memory_store, memory_get,
memory_list, memory_modify, memory_forget, plus recall/remember aliases) are
exposed through the MemoryProvider interface. The daemon handles all heavy
lifting: embedding, reranking, knowledge graph traversal, and predictive
scoring.

Config:
  - SIGNET_HOST / SIGNET_PORT env vars (default: localhost:3850)
  - SIGNET_DAEMON_URL env var for full URL override
  - SIGNET_AGENT_ID env var for agent scoping (default: "hermes-agent")
  - SIGNET_AGENT_WORKSPACE env var for the active named-agent workspace
"""

from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider

try:
    from plugins.memory.signet.client import SignetClient
except ImportError:  # pragma: no cover — only missing during Hermes bootstrap
    SignetClient = None  # type: ignore[assignment,misc]

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tool schemas
# ---------------------------------------------------------------------------

MEMORY_SEARCH_SCHEMA = {
    "name": "memory_search",
    "description": "Search Signet memories using hybrid vector + keyword search.",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search query text."},
            "limit": {"type": "integer", "description": "Max results to return (default 10, max 50)."},
            "project": {"type": "string", "description": "Optional project path filter."},
            "expand": {"type": "boolean", "description": "Include lossless session transcripts as sources."},
            "type": {"type": "string", "description": "Filter by memory type."},
            "tags": {"type": "string", "description": "Filter by tags, comma-separated."},
            "who": {"type": "string", "description": "Filter by author."},
            "since": {"type": "string", "description": "Only include memories created after this date."},
            "until": {"type": "string", "description": "Only include memories created before this date."},
            "keyword_query": {"type": "string", "description": "Override the keyword/FTS query used for recall."},
            "pinned": {"type": "boolean", "description": "Only return pinned memories."},
            "importance_min": {"type": "number", "description": "Minimum memory importance threshold."},
            "min_score": {
                "type": "number",
                "description": "Deprecated compatibility alias for importance_min; ignored when importance_min is set.",
            },
            "score_min": {"type": "number", "description": "Minimum recall score threshold, applied client-side."},
            "agent_scoped": {
                "type": "boolean",
                "description": "When true, scope recall to SIGNET_AGENT_ID instead of searching shared effective memory.",
            },
        },
        "required": ["query"],
    },
}

STRUCTURED_ENTITY_SCHEMA = {
    "type": "object",
    "properties": {
        "source": {"type": "string", "description": "Source entity name."},
        "sourceType": {"type": "string", "description": "Optional source entity type."},
        "relationship": {"type": "string", "description": "Relationship from source to target."},
        "target": {"type": "string", "description": "Target entity name."},
        "targetType": {"type": "string", "description": "Optional target entity type."},
        "confidence": {"type": "number", "description": "Optional confidence score 0-1."},
    },
    "required": ["source", "relationship", "target"],
}

STRUCTURED_ATTRIBUTE_SCHEMA = {
    "type": "object",
    "properties": {
        "content": {"type": "string", "description": "Attribute or constraint text."},
        "confidence": {"type": "number", "description": "Optional confidence score 0-1."},
        "importance": {"type": "number", "description": "Optional importance score 0-1."},
    },
    "required": ["content"],
}

STRUCTURED_ASPECT_SCHEMA = {
    "type": "object",
    "properties": {
        "entityName": {"type": "string", "description": "Entity the aspect belongs to."},
        "aspect": {"type": "string", "description": "Aspect name, e.g. preference, workflow, constraint."},
        "attributes": {
            "type": "array",
            "items": STRUCTURED_ATTRIBUTE_SCHEMA,
            "description": "Facts, constraints, or attributes for this aspect.",
        },
    },
    "required": ["entityName", "aspect", "attributes"],
}

MEMORY_STORE_SCHEMA = {
    "name": "memory_store",
    "description": "Save a new memory to Signet.",
    "parameters": {
        "type": "object",
        "properties": {
            "content": {"type": "string", "description": "Memory content to save."},
            "type": {"type": "string", "description": "Memory type, e.g. fact, preference, decision."},
            "importance": {"type": "number", "description": "Importance score 0-1."},
            "tags": {"type": "string", "description": "Comma-separated tags for categorization."},
            "pinned": {"type": "boolean", "description": "Pin this memory so it does not decay."},
            "project": {"type": "string", "description": "Optional project path. Defaults to the active Hermes Signet workspace."},
            "hints": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Prospective recall hints and alternate phrasings for retrieving this memory later.",
            },
            "transcript": {
                "type": "string",
                "description": "Raw source text or conversation transcript to preserve alongside this memory.",
            },
            "structured": {
                "type": "object",
                "description": "Pre-extracted structured data. When provided, Signet can persist graph links and hints directly.",
                "properties": {
                    "entities": {
                        "type": "array",
                        "items": STRUCTURED_ENTITY_SCHEMA,
                        "description": "Entity relationships to link to this memory.",
                    },
                    "aspects": {
                        "type": "array",
                        "items": STRUCTURED_ASPECT_SCHEMA,
                        "description": "Entity aspects and attributes to persist for graph recall.",
                    },
                    "hints": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Prospective recall hints and alternate phrasings.",
                    },
                },
            },
        },
        "required": ["content"],
    },
}

MEMORY_GET_SCHEMA = {
    "name": "memory_get",
    "description": "Get a single memory by its ID.",
    "parameters": {
        "type": "object",
        "properties": {"id": {"type": "string", "description": "Memory ID to retrieve."}},
        "required": ["id"],
    },
}

MEMORY_LIST_SCHEMA = {
    "name": "memory_list",
    "description": "List memories with optional filters.",
    "parameters": {
        "type": "object",
        "properties": {
            "limit": {"type": "integer", "description": "Max results to return, default 100."},
            "offset": {"type": "integer", "description": "Pagination offset."},
            "type": {"type": "string", "description": "Filter by memory type."},
        },
        "required": [],
    },
}

MEMORY_MODIFY_SCHEMA = {
    "name": "memory_modify",
    "description": "Edit an existing memory by ID.",
    "parameters": {
        "type": "object",
        "properties": {
            "id": {"type": "string", "description": "Memory ID to modify."},
            "content": {"type": "string", "description": "New content."},
            "type": {"type": "string", "description": "New memory type."},
            "importance": {"type": "number", "description": "New importance score 0-1."},
            "tags": {"type": "string", "description": "New tags, comma-separated."},
            "pinned": {"type": "boolean", "description": "Pin or unpin this memory."},
            "reason": {"type": "string", "description": "Why this edit is being made."},
        },
        "required": ["id", "reason"],
    },
}

MEMORY_FORGET_SCHEMA = {
    "name": "memory_forget",
    "description": "Soft-delete a memory by ID.",
    "parameters": {
        "type": "object",
        "properties": {
            "id": {"type": "string", "description": "Memory ID to forget."},
            "reason": {"type": "string", "description": "Why this memory should be forgotten."},
        },
        "required": ["id", "reason"],
    },
}

RECALL_ALIAS_SCHEMA = {
    "name": "recall",
    "description": "Alias for memory_search.",
    "parameters": MEMORY_SEARCH_SCHEMA["parameters"],
}

REMEMBER_ALIAS_SCHEMA = {
    "name": "remember",
    "description": "Alias for memory_store.",
    "parameters": MEMORY_STORE_SCHEMA["parameters"],
}

ALL_TOOL_SCHEMAS = [
    MEMORY_SEARCH_SCHEMA,
    MEMORY_STORE_SCHEMA,
    MEMORY_GET_SCHEMA,
    MEMORY_LIST_SCHEMA,
    MEMORY_MODIFY_SCHEMA,
    MEMORY_FORGET_SCHEMA,
    RECALL_ALIAS_SCHEMA,
    REMEMBER_ALIAS_SCHEMA,
]

def _sanitize_env(value: str) -> str:
    return value.strip().replace("\r", "").replace("\n", "")


def _resolve_agent_workspace(agent_id: str, kwargs: Dict[str, Any]) -> str:
    """Resolve the project/workspace path sent to Signet hooks.

    Named Signet agents can have their own workspace at
    $SIGNET_PATH/agents/{agent_id}. Prefer that workspace so daemon
    session-start can load the agent's scoped identity files.
    """
    explicit = _sanitize_env(os.environ.get("SIGNET_AGENT_WORKSPACE", ""))
    if explicit:
        return str(Path(explicit).expanduser())

    signet_path = _sanitize_env(os.environ.get("SIGNET_PATH", ""))
    agents_root = Path(signet_path).expanduser() if signet_path else Path.home() / ".agents"
    if agent_id and agent_id not in ("default", "hermes-agent"):
        candidate = agents_root / "agents" / agent_id
        if candidate.exists():
            return str(candidate)

    fallback = kwargs.get("cwd", kwargs.get("project", os.getcwd()))
    return str(Path(str(fallback)).expanduser())


# ---------------------------------------------------------------------------
# MemoryProvider implementation
# ---------------------------------------------------------------------------

class SignetMemoryProvider(MemoryProvider):
    """Signet persistent memory with hybrid search and knowledge graph."""

    def __init__(self):
        self._client = None  # SignetClient
        self._session_key = ""
        self._project = ""
        self._inject_cache = ""
        self._inject_lock = threading.Lock()
        self._prefetch_result = ""
        self._prefetch_lock = threading.Lock()
        self._prefetch_thread: Optional[threading.Thread] = None
        self._turn_count = 0
        self._last_user_message = ""
        self._last_assistant_message = ""
        self._transcript_lines: List[str] = []
        self._transcript_lock = threading.Lock()
        self._identity: Optional[Dict[str, Any]] = None
        self._warnings: List[str] = []
        self._session_initialized = False
        # Checkpoint: extract mid-session every N turns
        _CHECKPOINT_INTERVAL = 30
        self._checkpoint_interval = _CHECKPOINT_INTERVAL
        self._last_checkpoint_turn = 0

    @property
    def name(self) -> str:
        return "signet"

    def is_available(self) -> bool:
        """Check if the Signet daemon is reachable. No credentials needed."""
        if SignetClient is None:
            logger.debug("Signet is_available(): SignetClient not importable")
            return False
        try:
            return SignetClient().is_available()
        except Exception as err:
            logger.debug("Signet is_available() check failed: %s", err)
            return False

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        """Write config to $HERMES_HOME/signet.json."""
        config_path = Path(hermes_home) / "signet.json"
        existing: Dict[str, Any] = {}
        if config_path.exists():
            try:
                existing = json.loads(config_path.read_text())
            except Exception as err:
                logger.warning("Failed to parse %s, overwriting: %s", config_path, err)
        existing.update(values)
        config_path.write_text(json.dumps(existing, indent=2))

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {
                "key": "daemon_url",
                "description": "Signet daemon URL",
                "default": "http://localhost:3850",
                "env_var": "SIGNET_DAEMON_URL",
            },
            {
                "key": "agent_id",
                "description": "Agent scope identifier",
                "default": "hermes-agent",
                "env_var": "SIGNET_AGENT_ID",
            },
        ]

    def initialize(self, session_id: str, **kwargs) -> None:
        """Connect to the Signet daemon and call session-start hook.

        Retrieves identity, memories, and system prompt injection from
        the daemon. Caches the inject text for system_prompt_block().
        """
        if SignetClient is None:
            logger.warning("Signet plugin: SignetClient not importable — skipping initialization")
            return

        agent_id = os.environ.get("SIGNET_AGENT_ID", "").strip()
        if not agent_id:
            logger.warning(
                "SIGNET_AGENT_ID is not set; memory will be stored under the 'hermes-agent' "
                "scope. Set SIGNET_AGENT_ID to scope memories to a specific agent."
            )
            agent_id = "hermes-agent"

        # Skip for cron/flush contexts — no memory injection needed
        agent_context = kwargs.get("agent_context", "")
        platform = kwargs.get("platform", "cli")
        if agent_context in ("cron", "flush") or platform == "cron":
            logger.debug("Signet skipped: cron/flush context")
            return

        self._client = SignetClient(agent_id=agent_id, harness="hermes-agent")

        if not self._client.is_available():
            logger.debug("Signet daemon not reachable at %s", self._client.base_url)
            self._client = None
            return

        self._session_key = session_id or "hermes-default"
        self._project = _resolve_agent_workspace(agent_id, kwargs)

        # Call session-start hook — get identity + memories + inject
        result = self._client.session_start(
            self._session_key,
            project=self._project,
        )
        if result:
            inject = result.get("inject", "")
            if inject:
                with self._inject_lock:
                    self._inject_cache = inject
            # Capture identity and warnings for downstream consumers
            self._identity = result.get("identity")
            self._warnings = result.get("warnings", [])
            self._session_initialized = True
            logger.debug(
                "Signet session-start: %d chars inject, %d memories",
                len(inject),
                len(result.get("memories", [])),
            )
        else:
            logger.debug("Signet session-start returned no data")

    def system_prompt_block(self) -> str:
        """Return the Signet system prompt injection.

        On the first call, returns the full session-start inject
        (identity, memories, context). Subsequent calls return a
        minimal header since per-turn recall is handled by prefetch().
        """
        if not self._client:
            return ""

        with self._inject_lock:
            if self._inject_cache:
                # First call — return full inject and clear cache
                block = self._inject_cache
                self._inject_cache = ""
                return block

        # Subsequent calls — minimal header
        return (
            "# Signet Memory\n"
            "Active. Memories are auto-recalled each turn via hybrid search. "
            "Use memory_search to query memory, memory_store to save facts, "
            "and memory_get/memory_list/memory_modify/memory_forget for direct "
            "memory management."
        )

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Return prefetched recall results from background thread."""
        if not self._client:
            return ""

        if self._prefetch_thread and self._prefetch_thread.is_alive():
            self._prefetch_thread.join(timeout=3.0)

        with self._prefetch_lock:
            result = self._prefetch_result
            self._prefetch_result = ""

        return result

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        """Fire a background recall via user-prompt-submit hook.

        Also accumulates transcript and sends it for per-turn recall.
        If the daemon reports sessionKnown=false (daemon restarted),
        re-initializes the session.
        """
        if not self._client or not query:
            return

        # Accumulate transcript for checkpoint/session-end
        with self._transcript_lock:
            self._transcript_lines.append(f"user: {query}")

        # Capture mutable state before spawning the thread to avoid
        # data races: sync_turn() can update _last_assistant_message
        # concurrently, and shutdown() can null _client.
        client = self._client
        session_key = self._session_key
        project = self._project
        last_assistant = self._last_assistant_message

        def _run():
            try:
                result = client.user_prompt_submit(
                    session_key,
                    query,
                    last_assistant_message=last_assistant,
                    project=project,
                )
                if result:
                    # Handle daemon restart detection: re-initialize and refresh context.
                    # Always return after this branch — result came from a session the
                    # daemon no longer recognizes, so its inject would be stale/wrong.
                    if not result.get("sessionKnown", True) and self._session_initialized:
                        logger.debug("Signet daemon restarted mid-session, re-initializing")
                        reinit = client.session_start(
                            session_key, project=project,
                        )
                        if reinit:
                            inject_from_reinit = reinit.get("inject", "")
                            if inject_from_reinit and inject_from_reinit.strip():
                                with self._prefetch_lock:
                                    self._prefetch_result = inject_from_reinit
                        else:
                            logger.warning(
                                "Signet re-initialization after daemon restart returned no data; "
                                "session context will be missing until next turn"
                            )
                        return
                    inject = result.get("inject", "")
                    if inject and inject.strip():
                        with self._prefetch_lock:
                            self._prefetch_result = inject
            except Exception as e:
                logger.debug("Signet prefetch failed: %s", e)

        # Join the previous prefetch thread before starting a new one to prevent
        # a stale turn-N result from overwriting a turn-N+1 cleared prefetch.
        prev_thread = self._prefetch_thread
        if prev_thread and prev_thread.is_alive():
            prev_thread.join(timeout=2.0)

        self._prefetch_thread = threading.Thread(
            target=_run, daemon=True, name="signet-prefetch"
        )
        self._prefetch_thread.start()

    def on_turn_start(self, turn_number: int, message: str, **kwargs) -> None:
        """Track turn count and trigger periodic checkpoint extraction."""
        self._turn_count = turn_number
        self._last_user_message = message

        # Periodic checkpoint extraction for long-running sessions
        if (
            self._client
            and self._turn_count > 0
            and self._checkpoint_interval > 0
            and (self._turn_count - self._last_checkpoint_turn) >= self._checkpoint_interval
        ):
            self._last_checkpoint_turn = self._turn_count
            self._fire_checkpoint()

    def sync_turn(
        self, user_content: str, assistant_content: str, *, session_id: str = ""
    ) -> None:
        """Track assistant response and accumulate transcript."""
        self._last_assistant_message = assistant_content
        # Accumulate assistant side of transcript
        if assistant_content:
            with self._transcript_lock:
                self._transcript_lines.append(f"assistant: {assistant_content}")

    def on_memory_write(self, action: str, target: str, content: str) -> None:
        """Mirror built-in memory writes to Signet."""
        if action != "add" or not content:
            return
        client = self._client
        if not client:
            return

        def _write():
            try:
                client.remember(
                    content,
                    importance=0.6,
                    tags=["hermes-builtin", target],
                )
            except Exception as e:
                logger.debug("Signet memory mirror failed: %s", e)

        t = threading.Thread(target=_write, daemon=True, name="signet-memwrite")
        t.start()

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        """Call session-end hook to trigger memory extraction from transcript."""
        if not self._client:
            return

        # Prefer accumulated transcript (captures tool calls, etc.),
        # fall back to rebuilding from messages argument
        with self._transcript_lock:
            transcript = "\n\n".join(self._transcript_lines)

        if not transcript:
            transcript_lines = []
            for msg in messages:
                role = msg.get("role", "unknown")
                content = msg.get("content", "")
                if content:
                    transcript_lines.append(f"{role}: {content}")
            transcript = "\n\n".join(transcript_lines)

        if not transcript:
            return

        # Truncate to ~100k chars, snapping to the nearest message boundary so
        # the extraction pipeline never receives a partial user/assistant line.
        if len(transcript) > 100_000:
            cutoff = len(transcript) - 100_000
            # Scan forward from the cutoff to the next message boundary
            boundary = transcript.find("\n\nuser: ", cutoff)
            if boundary == -1:
                boundary = transcript.find("\n\nassistant: ", cutoff)
            if boundary != -1:
                transcript = transcript[boundary + 2:]  # skip leading \n\n
            else:
                # No boundary found after cutoff; drop the leading fragment
                transcript = transcript[cutoff:]

        try:
            result = self._client.session_end(
                self._session_key,
                transcript,
                project=self._project,
            )
            if result:
                saved = result.get("memoriesSaved", 0)
                queued = result.get("queued", False)
                job_id = result.get("jobId", "")
                logger.info(
                    "Signet session-end: %d saved, queued=%s, jobId=%s",
                    saved,
                    queued,
                    job_id,
                )
        except Exception as e:
            logger.warning("Signet session-end failed: %s", e)

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        """Called before context compression. Calls the pre-compaction hook
        to get summary guidance, then returns instructions for the compressor."""
        if not self._client:
            return ""

        try:
            result = self._client.pre_compaction(
                self._session_key,
                session_context=self._last_user_message,
                message_count=len(messages),
            )
            if result:
                prompt = result.get("summaryPrompt", "")
                guidelines = result.get("guidelines", "")
                parts = []
                if prompt:
                    parts.append(prompt)
                if guidelines:
                    parts.append(guidelines)
                if parts:
                    return "\n\n".join(parts)
        except Exception as e:
            logger.debug("Signet pre-compaction failed: %s", e)

        return (
            "Preserve any explicitly remembered facts, user preferences, "
            "project decisions, and technical context that Signet's memory "
            "system would benefit from retaining."
        )

    def on_compaction_complete(self, summary: str) -> None:
        """Called after context compression with the generated summary.

        Forwards to the compaction-complete hook so the daemon can save
        the summary as a session memory and trigger MEMORY.md synthesis.
        """
        if not self._client or not summary:
            return

        def _run():
            try:
                result = self._client.compaction_complete(
                    self._session_key,
                    summary,
                    project=self._project,
                )
                if result:
                    logger.debug(
                        "Signet compaction-complete: memoryId=%s",
                        result.get("memoryId", ""),
                    )
            except Exception as e:
                logger.debug("Signet compaction-complete failed: %s", e)

        t = threading.Thread(target=_run, daemon=True, name="signet-compact")
        t.start()

    def on_delegation(self, task: str, result: str, *,
                      child_session_id: str = "", **kwargs) -> None:
        """Observe subagent delegation results — store as a memory."""
        client = self._client
        if not client or not result:
            return

        content = f"Delegated task: {task[:200]}\nResult: {result[:500]}"

        def _run():
            try:
                client.remember(
                    content,
                    importance=0.6,
                    tags=["delegation", "subagent"],
                )
            except Exception as e:
                logger.debug("Signet delegation memory failed: %s", e)

        t = threading.Thread(target=_run, daemon=True, name="signet-delegation")
        t.start()

    def _fire_checkpoint(self) -> None:
        """Fire a checkpoint-extract for long-running sessions."""
        client = self._client
        if not client:
            return

        with self._transcript_lock:
            transcript = "\n\n".join(self._transcript_lines)

        if not transcript or len(transcript) < 500:
            return

        session_key = self._session_key
        project = self._project

        def _run():
            try:
                result = client.checkpoint_extract(
                    session_key,
                    transcript,
                    project=project,
                )
                if result:
                    logger.debug(
                        "Signet checkpoint: queued=%s, jobId=%s",
                        result.get("queued", False),
                        result.get("jobId", ""),
                    )
            except Exception as e:
                logger.debug("Signet checkpoint failed: %s", e)

        t = threading.Thread(target=_run, daemon=True, name="signet-checkpoint")
        t.start()

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        """Return Signet tool schemas."""
        if not self._client:
            return []
        return list(ALL_TOOL_SCHEMAS)

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        """Handle a Signet tool call."""
        if not self._client:
            return json.dumps({"error": "Signet daemon is not connected."})

        def _as_int(value: Any, default: int, *, minimum: int = 0, maximum: int = 10_000) -> int:
            try:
                parsed = int(value)
            except (TypeError, ValueError):
                parsed = default
            return max(minimum, min(maximum, parsed))

        def _as_float(value: Any) -> Optional[float]:
            if value is None or value == "":
                return None
            try:
                return float(value)
            except (TypeError, ValueError):
                return None

        def _tags(value: Any) -> Optional[List[str]]:
            if value is None or value == "":
                return None
            if isinstance(value, list):
                return [str(t).strip() for t in value if str(t).strip()]
            if isinstance(value, str):
                return [t.strip() for t in value.split(",") if t.strip()]
            return [str(value).strip()] if str(value).strip() else None

        def _string_list(value: Any) -> Optional[List[str]]:
            if value is None or value == "":
                return None
            if isinstance(value, list):
                items = [str(item).strip() for item in value if str(item).strip()]
                return items or None
            if isinstance(value, str):
                stripped = value.strip()
                return [stripped] if stripped else None
            return None

        def _search(search_args: Dict[str, Any]) -> str:
            query = str(search_args.get("query", "")).strip()
            if not query:
                return json.dumps({"error": "Missing required parameter: query"})

            importance_min = _as_float(search_args.get("importance_min"))
            if importance_min is None:
                importance_min = _as_float(search_args.get("min_score"))

            result = self._client.recall(
                query,
                limit=_as_int(search_args.get("limit"), 10, minimum=1, maximum=50),
                project=str(search_args.get("project", "") or ""),
                memory_type=str(search_args.get("type", "") or ""),
                tags=str(search_args.get("tags", "") or ""),
                who=str(search_args.get("who", "") or ""),
                pinned=search_args.get("pinned") if isinstance(search_args.get("pinned"), bool) else None,
                importance_min=importance_min,
                since=str(search_args.get("since", "") or ""),
                until=str(search_args.get("until", "") or ""),
                keyword_query=str(search_args.get("keyword_query", "") or ""),
                expand=bool(search_args.get("expand", False)),
                score_min=_as_float(search_args.get("score_min")),
                agent_scoped=bool(search_args.get("agent_scoped", False)),
            )
            if not result:
                return json.dumps({"error": "Search failed or Signet daemon returned no response.", "results": []})
            return json.dumps(result)

        def _store(store_args: Dict[str, Any]) -> str:
            content = str(store_args.get("content", "")).strip()
            if not content:
                return json.dumps({"error": "Missing required parameter: content"})
            importance = _as_float(store_args.get("importance"))
            if importance is None:
                importance = 0.5
            importance = max(0.0, min(1.0, importance))
            structured = store_args.get("structured")
            if not isinstance(structured, dict):
                structured = None
            result = self._client.remember(
                content,
                importance=importance,
                tags=_tags(store_args.get("tags")),
                memory_type=str(store_args.get("type", "") or ""),
                pinned=store_args.get("pinned") if isinstance(store_args.get("pinned"), bool) else None,
                project=str(store_args.get("project", "") or self._project),
                hints=_string_list(store_args.get("hints")),
                transcript=str(store_args.get("transcript", "") or ""),
                structured=structured,
                who="hermes-agent",
            )
            if not result:
                return json.dumps({"error": "Failed to store memory."})
            return json.dumps({"result": "Memory saved.", "id": result.get("id", result.get("memoryId", ""))})

        try:
            if tool_name in ("memory_search", "recall", "signet_search"):
                return _search(args)

            if tool_name in ("memory_store", "remember", "signet_store"):
                return _store(args)

            if tool_name == "signet_profile":
                return _search({"query": "user profile preferences context", "limit": 15})

            if tool_name == "memory_get":
                memory_id = str(args.get("id", "")).strip()
                if not memory_id:
                    return json.dumps({"error": "Missing required parameter: id"})
                result = self._client.get_memory(memory_id)
                return json.dumps(result if result else {"error": "Memory not found."})

            if tool_name == "memory_list":
                result = self._client.list_memories(
                    limit=_as_int(args.get("limit"), 100, minimum=1, maximum=500),
                    offset=_as_int(args.get("offset"), 0, minimum=0, maximum=1_000_000),
                    memory_type=str(args.get("type", "") or ""),
                )
                return json.dumps(result if result else {"memories": [], "result": "No memories found."})

            if tool_name == "memory_modify":
                memory_id = str(args.get("id", "")).strip()
                reason = str(args.get("reason", "")).strip()
                if not memory_id:
                    return json.dumps({"error": "Missing required parameter: id"})
                if not reason:
                    return json.dumps({"error": "Missing required parameter: reason"})
                result = self._client.modify_memory(
                    memory_id,
                    content=str(args.get("content", "") or ""),
                    memory_type=str(args.get("type", "") or ""),
                    importance=_as_float(args.get("importance")),
                    tags=str(args.get("tags", "") or ""),
                    pinned=args.get("pinned") if isinstance(args.get("pinned"), bool) else None,
                    reason=reason,
                )
                return json.dumps(result if result else {"error": "Failed to modify memory."})

            if tool_name == "memory_forget":
                memory_id = str(args.get("id", "")).strip()
                reason = str(args.get("reason", "")).strip()
                if not memory_id:
                    return json.dumps({"error": "Missing required parameter: id"})
                if not reason:
                    return json.dumps({"error": "Missing required parameter: reason"})
                result = self._client.forget_memory(
                    memory_id,
                    reason=reason,
                )
                return json.dumps(result if result else {"error": "Failed to forget memory."})

            return json.dumps({"error": f"Unknown tool: {tool_name}"})

        except Exception as e:
            logger.error("Signet tool %s failed: %s", tool_name, e)
            return json.dumps({"error": f"Signet {tool_name} failed: {e}"})

    def shutdown(self) -> None:
        """Clean shutdown — wait for background threads."""
        if self._prefetch_thread and self._prefetch_thread.is_alive():
            self._prefetch_thread.join(timeout=5.0)


# ---------------------------------------------------------------------------
# Plugin entry point
# ---------------------------------------------------------------------------

def register(ctx) -> None:
    """Register Signet as a memory provider plugin."""
    ctx.register_memory_provider(SignetMemoryProvider())
