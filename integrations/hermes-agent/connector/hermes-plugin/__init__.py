"""Signet memory plugin — MemoryProvider for Signet persistent memory.

Bridges Hermes Agent's memory provider interface to the Signet daemon
(localhost:3850), providing hybrid search (BM25 + vector + knowledge graph),
predictive recall, cross-session memory, and the full Signet pipeline
(extraction, knowledge graph, retention decay, synthesis).

Canonical Signet memory tools (memory_search, signet_session_search, memory_store,
memory_get, memory_list, memory_modify, memory_forget, plus recall/remember aliases) are
exposed through the MemoryProvider interface. The daemon handles all heavy
lifting: embedding, reranking, knowledge graph traversal, and predictive
scoring.

Config:
  - SIGNET_HOST / SIGNET_PORT env vars (default: localhost:3850)
  - SIGNET_DAEMON_URL env var for full URL override
  - SIGNET_AGENT_ID env var for agent scoping (unset: daemon's configured agent, usually "default")
  - SIGNET_AGENT_WORKSPACE env var for the active named-agent workspace
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
import time
from pathlib import Path
from queue import Empty, Queue
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider

try:
    from .client import SignetClient
except ImportError:  # pragma: no cover — only missing during Hermes bootstrap
    try:
        from plugins.memory.signet.client import SignetClient
    except ImportError:
        SignetClient = None  # type: ignore[assignment,misc]

logger = logging.getLogger(__name__)

_INTERNAL_MEMORY_BLOCK_RE = re.compile(
    r"<\\?\s*(?:signet-memory-context|signet-memory|memory-context)(?=[\s/>])(?:[^>\"']|\"[^\"]*\"|'[^']*')*>.*?(?:<\\?\s*/\s*(?:signet-memory-context|signet-memory|memory-context)\s*>|$)",
    re.IGNORECASE | re.DOTALL,
)
_INTERNAL_MEMORY_CLOSE_RE = re.compile(
    r"<\\?\s*/\s*(?:signet-memory-context|signet-memory|memory-context)\s*>",
    re.IGNORECASE,
)


def _strip_internal_memory_context(value: str) -> str:
    """Keep provider-only memory wrappers out of Hermes transcript state."""
    return _INTERNAL_MEMORY_CLOSE_RE.sub("", _INTERNAL_MEMORY_BLOCK_RE.sub("", value))


# ---------------------------------------------------------------------------
# Tool schemas
# ---------------------------------------------------------------------------

MEMORY_SEARCH_SCHEMA = {
    "name": "memory_search",
    "description": (
        "Search Signet memories using hybrid vector + keyword search. "
        "Ask a natural-language question with entity, event, and timeframe when possible. "
        "Avoid bag-of-keywords queries; use keyword_query only when you intentionally need exact lexical matching."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": (
                    "Natural-language recall question. Include the relevant entity/person/project, event or decision, "
                    "and timeframe when known; avoid diagnostic keyword soup."
                ),
            },
            "limit": {"type": "integer", "description": "Max results to request (default 10, request max 100)."},
            "project": {"type": "string", "description": "Optional project path filter."},
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
            "score_min": {"type": "number", "description": "Minimum recall score threshold."},
            "aggregate": {
                "type": "boolean",
                "description": "Synthesize an aggregate answer from bounded recall evidence.",
            },
            "aggregate_budget": {
                "type": "string",
                "enum": ["small", "medium", "large"],
                "description": "Aggregate recall budget.",
            },
            "save_aggregate": {
                "type": "boolean",
                "description": "Save aggregate answers as memories.",
            },
            "agent_scoped": {
                "type": "boolean",
                "description": "When true, scope recall to SIGNET_AGENT_ID instead of searching shared effective memory.",
            },
        },
        "required": ["query"],
    },
}

SESSION_SEARCH_SCHEMA = {
    # Hermes reserves `session_search` as a built-in core tool name;
    # registering under that name would be silently dropped by
    # `MemoryManager.add_provider`. The Signet provider exposes the
    # transcript-search tool under the `signet_` namespace instead.
    "name": "signet_session_search",
    "description": "Search active or completed Signet session transcripts.",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Natural language or keyword query."},
            "session_key": {"type": "string", "description": "Specific transcript session key to search."},
            "current_session_key": {
                "type": "string",
                "description": "Current session key; sub-agent lineage may resolve this to the parent session.",
            },
            "agent_id": {"type": "string", "description": "Agent scope, default default."},
            "project": {"type": "string", "description": "Optional project path filter."},
            "limit": {"type": "integer", "description": "Max results to return (default 10, max 20)."},
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
            "review_after": {"type": "string", "description": "ISO timestamp after which Dreaming should surface this memory for temporal review."},
            "hints": {
                "type": "array",
                "items": {"type": "string"},
                "minItems": 1,
                "description": "Required agent-provided prospective recall hints and alternate phrasings for retrieving this memory later.",
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
        "required": ["content", "hints"],
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
    "description": "Alias for memory_search. Use the same natural-language query discipline; avoid bag-of-keywords queries.",
    "parameters": MEMORY_SEARCH_SCHEMA["parameters"],
}

REMEMBER_ALIAS_SCHEMA = {
    "name": "remember",
    "description": "Alias for memory_store.",
    "parameters": MEMORY_STORE_SCHEMA["parameters"],
}

ALL_TOOL_SCHEMAS = [
    MEMORY_SEARCH_SCHEMA,
    SESSION_SEARCH_SCHEMA,
    MEMORY_STORE_SCHEMA,
    MEMORY_GET_SCHEMA,
    MEMORY_LIST_SCHEMA,
    MEMORY_MODIFY_SCHEMA,
    MEMORY_FORGET_SCHEMA,
    RECALL_ALIAS_SCHEMA,
    REMEMBER_ALIAS_SCHEMA,
]

HERMES_MEMORY_SOURCE_TYPE = "hermes-memory-write"
HERMES_MEMORY_TAG = "hermes-builtin"
MIRROR_SEARCH_LIMIT = 100


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
    if agent_id and agent_id not in ("default",):
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
        self._agent_id = ""
        self._session_key = ""
        self._project = ""
        self._inject_cache = ""
        self._inject_lock = threading.Lock()
        # Session-start dynamic context is kept separate from the ordinary
        # per-turn result. queue_prefetch() clears the latter before starting
        # a new recall, but must not erase the first API-only context block.
        self._session_prefetch_result = ""
        self._prefetch_result = ""
        self._notification_result = ""
        self._prefetch_lock = threading.Lock()
        self._prefetch_thread: Optional[threading.Thread] = None
        self._prefetch_generation = 0
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
        # Hermes calls on_memory_write once per committed operation, including
        # once for each operation in an atomic batch. Keep one FIFO worker so
        # replace/remove cannot overtake the add that established their target.
        self._mirror_queue: Queue = Queue()
        self._mirror_worker: Optional[threading.Thread] = None
        self._mirror_state_lock = threading.Lock()
        self._mirror_shutdown = False

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
                "description": "Agent scope identifier. Leave empty to use the daemon's configured agent.",
                "default": "",
                "env_var": "SIGNET_AGENT_ID",
            },
        ]

    def initialize(self, session_id: str, **kwargs) -> None:
        """Connect to the Signet daemon and call session-start hook.

        Retrieves identity, memories, and the cache-stable prompt contract
        from the daemon. The stable prefix is cached for system_prompt_block;
        dynamic session context is staged for Hermes' API-only prefetch path.
        """
        if SignetClient is None:
            logger.warning("Signet plugin: SignetClient not importable — skipping initialization")
            return

        agent_id = os.environ.get("SIGNET_AGENT_ID", "").strip()
        if agent_id == "hermes-agent":
            # The harness name is provenance, never an agent scope. A stale
            # value from an older connector install is healed by letting the
            # daemon resolve the workspace's configured agent instead.
            logger.warning(
                "SIGNET_AGENT_ID='hermes-agent' is the harness name, not an agent scope; "
                "the daemon's configured agent will be used instead."
            )
            agent_id = ""
        if not agent_id:
            # No explicit agent id: the daemon resolves its configured agent
            # (its own SIGNET_AGENT_ID, or 'default' for the default workspace).
            logger.debug("SIGNET_AGENT_ID is not set; the daemon's configured agent scope applies.")

        self._agent_id = agent_id
        with self._mirror_state_lock:
            self._mirror_shutdown = False

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

        # Call session-start hook — get identity + memories + split context
        result = self._client.session_start(
            self._session_key,
            project=self._project,
        )
        if result:
            raw_stable_prompt = result.get("stableSystemPrompt") or result.get("inject", "")
            stable_prompt = raw_stable_prompt if isinstance(raw_stable_prompt, str) else ""
            dynamic_context = result.get("dynamicContext", "")
            if stable_prompt:
                with self._inject_lock:
                    self._inject_cache = stable_prompt
            with self._prefetch_lock:
                self._prefetch_generation += 1
                self._session_prefetch_result = dynamic_context if isinstance(dynamic_context, str) else ""
                self._prefetch_result = ""
                self._notification_result = ""
            # Capture identity and warnings for downstream consumers
            self._identity = result.get("identity")
            self._warnings = result.get("warnings", [])
            self._session_initialized = True
            logger.debug(
                "Signet session-start: %d chars inject, %d memories",
                len(stable_prompt) + (len(dynamic_context) if isinstance(dynamic_context, str) else 0),
                len(result.get("memories", [])),
            )
        else:
            logger.debug("Signet session-start returned no data")

    def system_prompt_block(self) -> str:
        """Return the Signet system prompt injection.

        On the first call, returns only the deterministic session-start
        prefix. Dynamic context is returned by prefetch(), where Hermes can
        attach it to its API-only copy of the user message. Subsequent calls
        return a minimal header.
        """
        if not self._client:
            return ""

        with self._inject_lock:
            if self._inject_cache:
                # First call — return the stable prefix and clear the cache.
                block = self._inject_cache
                self._inject_cache = ""
                return block

        # Subsequent calls — minimal header
        return (
            "# Signet Memory\n"
            "Active. Memories are auto-recalled each turn via hybrid search. "
            "Use memory_search to query memory, memory_store to save facts, "
            "and memory_get/memory_list/memory_modify/memory_forget for direct "
            "memory management. If Hermes reports Unknown tool for these names, "
            "run `signet doctor hermes` and restart Hermes."
        )

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Return prefetched recall results from background thread."""
        if not self._client:
            return ""

        if self._prefetch_thread and self._prefetch_thread.is_alive():
            self._prefetch_thread.join(timeout=3.0)

        client = self._client
        if client:
            try:
                notification = client.notifications(
                    self._session_key,
                    "prefetch",
                    project=self._project,
                )
                if notification is not None:
                    notification_inject = notification.get("inject", "")
                    with self._prefetch_lock:
                        self._notification_result = notification_inject if isinstance(notification_inject, str) else ""
            except Exception as e:
                logger.debug("Signet notification prefetch failed: %s", e)

        with self._prefetch_lock:
            parts = [self._session_prefetch_result, self._prefetch_result, self._notification_result]
            self._session_prefetch_result = ""
            self._prefetch_result = ""
            self._notification_result = ""

        return "\n".join(part for part in parts if part and part.strip())

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
            self._transcript_lines.append(f"user: {_strip_internal_memory_context(query)}")

        # Capture mutable state before spawning the thread to avoid
        # data races: sync_turn() can update _last_assistant_message
        # concurrently, and shutdown() can null _client.
        client = self._client
        last_assistant = self._last_assistant_message
        with self._prefetch_lock:
            self._prefetch_generation += 1
            self._prefetch_result = ""
            self._notification_result = ""
            session_key = self._session_key
            project = self._project
            prefetch_generation = self._prefetch_generation

        def _run():
            try:
                result = client.user_prompt_submit(
                    session_key,
                    query,
                    last_assistant_message=last_assistant,
                    project=project,
                )
                if result:
                    # Handle daemon restart detection by restoring only the runtime
                    # claim. The initial system prompt is already part of this
                    # conversation; injecting session-start context again would mutate
                    # the cached prefix mid-conversation.
                    if not result.get("sessionKnown", True) and self._session_initialized:
                        logger.debug("Signet daemon restarted mid-session, restoring session claim")
                        with self._prefetch_lock:
                            # Do not replay a pre-restart session-start block
                            # into an already-running Hermes conversation.
                            self._session_prefetch_result = ""
                        reinit = client.session_start(
                            session_key, project=project, claim_only=True,
                        )
                        if not reinit:
                            logger.warning(
                                "Signet session-claim recovery after daemon restart returned no data; "
                                "the next prompt may be treated as a new session"
                            )
                        return
                    inject = result.get("dynamicContext") or result.get("inject", "")
                    notification = result.get("notifications")
                    notification_inject = notification.get("inject", "") if isinstance(notification, dict) else ""
                    recall_inject = inject
                    if notification_inject and inject.rstrip().endswith(notification_inject.strip()):
                        recall_inject = inject.rstrip()[: -len(notification_inject.strip())].rstrip()
                    if (recall_inject and recall_inject.strip()) or (notification_inject and notification_inject.strip()):
                        with self._prefetch_lock:
                            if prefetch_generation == self._prefetch_generation and session_key == self._session_key:
                                self._prefetch_result = recall_inject
                                self._notification_result = notification_inject
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
                self._transcript_lines.append(f"assistant: {_strip_internal_memory_context(assistant_content)}")
        self._queue_notification_refresh("sync_turn")

    def _queue_notification_refresh(self, hook: str) -> None:
        """Fetch peer notifications without blocking the current Hermes callback."""
        client = self._client
        if not client:
            return
        session_key = self._session_key
        project = self._project
        with self._prefetch_lock:
            generation = self._prefetch_generation

        def _run():
            try:
                result = client.notifications(session_key, hook, project=project)
                inject = (result or {}).get("inject", "")
                with self._prefetch_lock:
                    if generation == self._prefetch_generation and session_key == self._session_key:
                        self._notification_result = inject if isinstance(inject, str) else ""
            except Exception as e:
                logger.debug("Signet %s notification refresh failed: %s", hook, e)

        threading.Thread(target=_run, daemon=True, name=f"signet-notify-{hook}").start()

    def on_session_switch(
        self,
        new_session_id: str,
        *,
        parent_session_id: str = "",
        reset: bool = False,
        **kwargs: Any,
    ) -> None:
        """Refresh cached session state when Hermes rotates session_id.

        Hermes Agent keeps memory providers alive across /new, /resume,
        /branch, and compression. Signet caches the active session key and a
        transcript buffer, so update the target session and clear stale buffered
        lines before subsequent writes land in the wrong session.
        """
        if not new_session_id:
            return
        self._session_key = new_session_id
        self._session_initialized = False
        self._turn_count = 0
        self._last_checkpoint_turn = 0
        self._last_user_message = ""
        self._last_assistant_message = ""
        with self._transcript_lock:
            self._transcript_lines = []
        with self._inject_lock:
            self._inject_cache = ""
        with self._prefetch_lock:
            self._prefetch_generation += 1
            self._session_prefetch_result = ""
            self._prefetch_result = ""
            self._notification_result = ""

        agent_id = self._agent_id
        self._project = _resolve_agent_workspace(agent_id, kwargs)
        client = self._client
        if not client:
            return

        try:
            result = client.session_start(
                self._session_key,
                project=self._project,
            )
            if result:
                stable_prompt = result.get("stableSystemPrompt") or result.get("inject", "")
                dynamic_context = result.get("dynamicContext", "")
                if stable_prompt and isinstance(stable_prompt, str) and stable_prompt.strip():
                    with self._inject_lock:
                        self._inject_cache = stable_prompt
                with self._prefetch_lock:
                    self._session_prefetch_result = dynamic_context if isinstance(dynamic_context, str) else ""
                self._identity = result.get("identity")
                self._warnings = result.get("warnings", [])
                self._session_initialized = True
        except Exception as e:
            logger.debug("Signet session switch failed: %s", e)

    @staticmethod
    def _mirror_tags(raw: Any) -> set[str]:
        if isinstance(raw, list):
            return {str(tag).strip() for tag in raw if str(tag).strip()}
        if isinstance(raw, str):
            return {tag.strip() for tag in raw.split(",") if tag.strip()}
        return set()

    @staticmethod
    def _mirror_tag(prefix: str, value: str) -> str:
        clean = value.replace("\n", " ").replace("\r", " ").strip()
        return f"{prefix}:{clean[:80]}" if clean else ""

    def _mirror_operation_details(
        self,
        action: str,
        target: str,
        content: str,
        metadata: Dict[str, Any],
    ) -> Dict[str, str]:
        """Derive durable, retry-stable identity for one Hermes write."""
        old_text = str(metadata.get("old_text", "") or "").strip()
        session_id = str(
            metadata.get("session_id", "")
            or metadata.get("_mirror_session_key", "")
            or self._session_key
        ).strip()
        parent_session_id = str(metadata.get("parent_session_id", "") or "").strip()
        tool_call_id = str(metadata.get("tool_call_id", "") or "").strip()
        project = str(metadata.get("_mirror_project", self._project) or "").strip()
        agent_id = str(metadata.get("_mirror_agent_id", self._agent_id) or "").strip()
        seed = "\0".join(
            (
                agent_id,
                project,
                session_id,
                parent_session_id,
                target,
                action,
                old_text,
                content,
                tool_call_id,
            )
        )
        digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()
        operation_key = f"hermes-memory-write:{digest}"

        # Preserve Hermes's tool-call id as the source id for the common add
        # path. Replacements get an operation-specific suffix because every
        # operation in a Hermes batch shares one tool-call id.
        if tool_call_id and action == "add":
            source_id = tool_call_id
        elif tool_call_id:
            source_id = f"{tool_call_id}:{action}:{digest[:16]}"
        else:
            source_id = f"hermes-memory-write:{digest}"

        return {
            "old_text": old_text,
            "session_id": session_id,
            "request_id": operation_key,
            "source_id": source_id,
            "idempotency_key": operation_key,
            "mirror_tag": f"mirror:{digest[:24]}",
            "project": project,
            "agent_id": agent_id,
        }

    def _mirror_write_tags(
        self,
        target: str,
        metadata: Dict[str, Any],
        operation_tag: str,
        session_id: str,
    ) -> List[str]:
        tags = [HERMES_MEMORY_TAG, target, operation_tag]
        for tag in (
            self._mirror_tag(
                "origin",
                str(metadata.get("write_origin", "") or metadata.get("source", "")),
            ),
            self._mirror_tag("context", str(metadata.get("execution_context", "") or "")),
            self._mirror_tag("platform", str(metadata.get("platform", "") or "")),
            self._mirror_tag("session", session_id),
            self._mirror_tag("parent-session", str(metadata.get("parent_session_id", "") or "")),
            self._mirror_tag("tool", str(metadata.get("tool_name", "") or "")),
        ):
            if tag:
                tags.append(tag)
        return tags

    def _find_mirrored_entries(
        self,
        query: str,
        target: str,
        *,
        client: Any = None,
        project: str = "",
        source_id: str = "",
        operation_tag: str = "",
    ) -> List[Dict[str, Any]]:
        """Find active Hermes rows without crossing project/agent boundaries."""
        client = client or self._client
        if not client:
            return []
        scoped_project = project or self._project
        rows = client.search(
            query,
            limit=MIRROR_SEARCH_LIMIT,
            tags=HERMES_MEMORY_TAG,
            project=scoped_project,
        )

        matches: List[Dict[str, Any]] = []
        for row in rows or []:
            if not isinstance(row, dict):
                continue
            content = str(row.get("content", "") or "")
            tags = self._mirror_tags(row.get("tags"))
            row_source_id = str(row.get("source_id", "") or row.get("sourceId", "") or "")
            if HERMES_MEMORY_TAG not in tags or target not in tags:
                continue
            if source_id and row_source_id != source_id and operation_tag not in tags:
                continue
            if operation_tag and operation_tag not in tags:
                continue
            if query and query not in content:
                continue
            matches.append(row)
        return matches

    def _remember_mirror(
        self,
        content: str,
        *,
        client: Any = None,
        tags: List[str],
        project: str,
        source_id: str,
        operation_key: str,
        visibility: str = "global",
        supersedes: str = "",
        reason: str = "",
        session_id: str = "",
        request_id: str = "",
    ) -> Optional[Dict[str, Any]]:
        """Write one mirror row, retrying a source-id collision safely."""
        client = client or self._client
        if not client:
            return None
        result = client.remember(
            content,
            importance=0.6,
            tags=tags,
            project=project,
            visibility=visibility,
            source_type=HERMES_MEMORY_SOURCE_TYPE,
            source_id=source_id,
            idempotency_key=operation_key,
            supersedes=supersedes,
            reason=reason,
            session_id=session_id,
            request_id=request_id,
        )
        if not result or not isinstance(result, dict):
            return result

        # A tool-call id is shared by every operation in a Hermes batch. If an
        # earlier add claimed that source id, retry the new operation with its
        # content-derived id rather than accepting a false dedupe.
        returned_content = str(result.get("content", "") or "").strip()
        if result.get("deduped") is True and returned_content and returned_content != content.strip():
            fallback_source_id = f"{source_id}:{operation_key[-16:]}"
            return client.remember(
                content,
                importance=0.6,
                tags=tags,
                project=project,
                visibility=visibility,
                source_type=HERMES_MEMORY_SOURCE_TYPE,
                source_id=fallback_source_id,
                idempotency_key=operation_key,
                supersedes=supersedes,
                reason=reason,
                session_id=session_id,
                request_id=request_id,
            )
        return result

    def _mirror_operation(
        self,
        client: Any,
        action: str,
        target: str,
        content: str,
        metadata: Dict[str, Any],
    ) -> None:
        if not client:
            return

        details = self._mirror_operation_details(action, target, content, metadata)
        old_text = details["old_text"]
        session_id = details["session_id"]
        source_id = details["source_id"]
        operation_key = details["idempotency_key"]
        operation_tag = details["mirror_tag"]
        tags = self._mirror_write_tags(target, metadata, operation_tag, session_id)
        request_id = details["request_id"]
        project = details["project"]

        if action == "add":
            result = self._remember_mirror(
                content,
                client=client,
                tags=tags,
                project=project,
                source_id=source_id,
                operation_key=operation_key,
                session_id=session_id,
                request_id=request_id,
            )
            if result is None:
                logger.warning("Signet Hermes add mirror returned no response")
            return

        if not old_text:
            logger.warning("Signet Hermes %s mirror skipped: old_text was not supplied", action)
            return

        if action == "replace":
            if not content:
                logger.warning("Signet Hermes replace mirror skipped: content was empty")
                return

            # A completed replace is found by its operation tag/source id. This
            # makes a retry a no-op even though the old row is no longer in the
            # current recall view.
            completed = self._find_mirrored_entries(
                content,
                target,
                client=client,
                project=project,
                source_id=source_id,
                operation_tag=operation_tag,
            )
            if completed:
                return

            matches = self._find_mirrored_entries(old_text, target, client=client, project=project)
            distinct_contents = {str(row.get("content", "")) for row in matches}
            if len(distinct_contents) > 1:
                logger.warning(
                    "Signet Hermes replace mirror skipped: old_text matched multiple mirrored entries"
                )
                return
            if not matches:
                # The old row may already have been superseded by a prior
                # delivery. No current stale row can be reintroduced.
                logger.debug("Signet Hermes replace mirror found no active source row")
                return

            old_id = str(matches[0].get("id", "") or "").strip()
            if not old_id:
                logger.warning("Signet Hermes replace mirror skipped: matched row had no id")
                return
            result = self._remember_mirror(
                content,
                client=client,
                tags=tags,
                project=project,
                source_id=source_id,
                operation_key=operation_key,
                supersedes=old_id,
                reason="Hermes built-in memory replacement",
                session_id=session_id,
                request_id=request_id,
            )
            if not result:
                logger.warning("Signet Hermes replace mirror returned no response")
                return

            # A content/source dedupe can return an existing current row before
            # the daemon sees `supersedes`. Link that row explicitly so the old
            # Hermes entry still cannot remain current.
            if result.get("deduped") is True:
                replacement_id = str(result.get("id", "") or "").strip()
                if replacement_id and replacement_id != old_id and hasattr(client, "supersede_memory"):
                    linked = client.supersede_memory(
                        old_id,
                        replacement_id,
                        reason="Hermes built-in memory replacement",
                        session_id=session_id,
                        request_id=request_id,
                    )
                    if linked is None:
                        logger.warning("Signet Hermes replace mirror could not link a deduped replacement")
            return

        if action == "remove":
            matches = self._find_mirrored_entries(old_text, target, client=client, project=project)
            distinct_contents = {str(row.get("content", "")) for row in matches}
            if len(distinct_contents) > 1:
                logger.warning(
                    "Signet Hermes remove mirror skipped: old_text matched multiple mirrored entries"
                )
                return
            if not matches:
                # Soft-delete is idempotent from the current-view perspective:
                # a prior delivery already removed this row, or it was never
                # mirrored. In neither case should a stale row be recreated.
                return
            memory_id = str(matches[0].get("id", "") or "").strip()
            if not memory_id:
                logger.warning("Signet Hermes remove mirror skipped: matched row had no id")
                return
            result = client.forget_memory(
                memory_id,
                reason="Hermes built-in memory removal",
                session_id=session_id,
                request_id=request_id,
            )
            if result is None:
                logger.warning("Signet Hermes remove mirror returned no response")

    def _mirror_worker_loop(self) -> None:
        while True:
            try:
                client, action, target, content, metadata = self._mirror_queue.get(timeout=0.1)
            except Empty:
                with self._mirror_state_lock:
                    if self._mirror_shutdown or self._mirror_queue.empty():
                        self._mirror_worker = None
                        return
                continue
            try:
                self._mirror_operation(client, action, target, content, metadata)
            except Exception as e:
                logger.warning(
                    "Signet Hermes memory mirror failed for %s/%s: %s",
                    action,
                    target,
                    e,
                )
            finally:
                self._mirror_queue.task_done()

    def flush_mirror_writes(self, timeout: float = 5.0) -> bool:
        """Wait for queued mirror operations, primarily for shutdown/tests."""
        deadline = time.monotonic() + max(0.0, timeout)
        while self._mirror_queue.unfinished_tasks > 0 and time.monotonic() < deadline:
            time.sleep(0.01)
        return self._mirror_queue.unfinished_tasks == 0

    def on_memory_write(
        self,
        action: str,
        target: str,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Mirror committed Hermes memory writes in FIFO order.

        Hermes only calls this after the built-in memory tool commits. The
        single daemon worker therefore preserves the order of atomic batch
        operations without blocking the agent turn on a network request.
        """
        if not isinstance(action, str) or not isinstance(target, str) or not isinstance(content, str):
            logger.warning("Signet Hermes memory mirror skipped malformed operation")
            return
        action = action.strip()
        target = target.strip()
        content = content.strip()
        if action not in {"add", "replace", "remove"}:
            return
        if action in {"add", "replace"} and not content:
            return
        if target not in {"memory", "user"}:
            logger.warning("Signet Hermes memory mirror skipped unknown target: %s", target)
            return
        client = self._client
        if not client:
            return
        snapshot = dict(metadata) if isinstance(metadata, dict) else {}
        snapshot["_mirror_project"] = self._project
        snapshot["_mirror_agent_id"] = self._agent_id or str(
            getattr(client, "_agent_id", "") or ""
        )
        snapshot["_mirror_session_key"] = self._session_key
        with self._mirror_state_lock:
            if self._mirror_shutdown:
                logger.debug("Signet Hermes memory mirror rejected after shutdown")
                return
            self._mirror_queue.put((client, action, target, content, snapshot))
            if self._mirror_worker is None or not self._mirror_worker.is_alive():
                self._mirror_worker = threading.Thread(
                    target=self._mirror_worker_loop,
                    daemon=True,
                    name="signet-memwrite-serial",
                )
                self._mirror_worker.start()

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        """Call session-end hook to trigger memory extraction from transcript."""
        with self._prefetch_lock:
            self._session_prefetch_result = ""
            self._prefetch_result = ""
            self._notification_result = ""
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
                    transcript_lines.append(f"{role}: {_strip_internal_memory_context(str(content))}")
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
        project = self._project

        content = f"Delegated task: {task[:200]}\nResult: {result[:500]}"

        def _run():
            try:
                client.remember(
                    content,
                    importance=0.6,
                    tags=["delegation", "subagent"],
                    project=project,
                )
            except Exception as e:
                logger.debug("Signet delegation memory failed: %s", e)

        t = threading.Thread(target=_run, daemon=True, name="signet-delegation")
        t.start()
        self._queue_notification_refresh("on_delegation")

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
        """Return Signet tool schemas.

        Hermes indexes memory-provider tool dispatch before provider
        initialization. Keep schemas stable even while the daemon is offline;
        handle_tool_call() returns the runtime connectivity error.
        """
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
                limit=search_args.get("limit"),
                project=str(search_args.get("project", "") or ""),
                memory_type=str(search_args.get("type", "") or ""),
                tags=str(search_args.get("tags", "") or ""),
                who=str(search_args.get("who", "") or ""),
                pinned=search_args.get("pinned") if isinstance(search_args.get("pinned"), bool) else None,
                importance_min=importance_min,
                since=str(search_args.get("since", "") or ""),
                until=str(search_args.get("until", "") or ""),
                keyword_query=str(search_args.get("keyword_query", "") or ""),
                score_min=_as_float(search_args.get("score_min")),
                aggregate=bool(search_args.get("aggregate", False)),
                aggregate_budget=str(search_args.get("aggregate_budget", "") or ""),
                save_aggregate=search_args.get("save_aggregate")
                if isinstance(search_args.get("save_aggregate"), bool)
                else None,
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
            hints = _string_list(store_args.get("hints"))
            if not hints:
                return json.dumps({"error": "Missing required parameter: hints"})
            result = self._client.remember(
                content,
                importance=importance,
                tags=_tags(store_args.get("tags")),
                memory_type=str(store_args.get("type", "") or ""),
                pinned=store_args.get("pinned") if isinstance(store_args.get("pinned"), bool) else None,
                project=str(store_args.get("project", "") or self._project),
                hints=hints,
                transcript=str(store_args.get("transcript", "") or ""),
                structured=structured,
                review_after=str(store_args.get("review_after", "") or ""),
                who="hermes-agent",
            )
            if not result:
                return json.dumps({"error": "Failed to store memory."})
            return json.dumps({"result": "Memory saved.", "id": result.get("id", result.get("memoryId", ""))})

        try:
            if tool_name in ("memory_search", "recall", "signet_search"):
                return _search(args)

            if tool_name == "signet_session_search":
                query = str(args.get("query", "")).strip()
                if not query:
                    return json.dumps({"error": "Missing required parameter: query"})
                result = self._client.session_search(
                    query,
                    session_key=str(args.get("session_key", "") or ""),
                    current_session_key=str(args.get("current_session_key", "") or ""),
                    agent_id=str(args.get("agent_id", "") or ""),
                    project=str(args.get("project", "") or ""),
                    limit=_as_int(args.get("limit"), 10, minimum=1, maximum=20),
                )
                return json.dumps(result if result else {"error": "Session search failed.", "hits": []})

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
        with self._mirror_state_lock:
            self._mirror_shutdown = True
            mirror_worker = self._mirror_worker
        self.flush_mirror_writes(timeout=5.0)
        if mirror_worker and mirror_worker.is_alive():
            mirror_worker.join(timeout=0.1)
        if self._prefetch_thread and self._prefetch_thread.is_alive():
            self._prefetch_thread.join(timeout=5.0)


# ---------------------------------------------------------------------------
# Plugin entry point
# ---------------------------------------------------------------------------

def register(ctx) -> None:
    """Register Signet as a memory provider plugin."""
    ctx.register_memory_provider(SignetMemoryProvider())
