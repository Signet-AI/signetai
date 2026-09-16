---
title: "MCP server"
description: "Developer reference for Signet's stateless Model Context Protocol server."
---

Signet is a local-first memory and context layer for AI agents. Its MCP server exposes the daemon's current memory, ontology, session, secret, and code operations as on-demand tools.

Hooks and MCP are complementary:

| Surface | Ownership | Use |
|---|---|---|
| Hooks | Harness lifecycle | Start/end, prompt, compaction, and notification delivery |
| MCP | Agent initiated | Search, inspect, write, coordinate, and run bounded operations |

## Setup and transport

Start the daemon before using either transport:

```sh
signet daemon start
```

The daemon mounts one stateless Streamable HTTP endpoint at `/mcp` for `POST`, `GET`, and `DELETE`. `GET` is the server-notification stream and `DELETE` terminates the transport; each request creates a fresh server and transport. The `signet-mcp` executable uses the MCP stdio transport and calls the daemon over HTTP.

```sh
signet-mcp
```

| Variable | Default | Meaning |
|---|---|---|
| `SIGNET_DAEMON_URL` | `http://localhost:3850` | Daemon origin used by the stdio bridge |
| `SIGNET_HOST` | `localhost` | Daemon bind host |
| `SIGNET_PORT` | `3850` | Daemon port |

Use `signet setup --harness <name>` or the harness connector to install the MCP registration. For a remote daemon, set `SIGNET_DAEMON_URL` to the origin only; paths, queries, fragments, credentials, and non-HTTP schemes are rejected. MCP inherits daemon authentication: local mode is unauthenticated, team mode requires a bearer token for HTTP, and hybrid mode trusts localhost while requiring a token remotely.

The Streamable HTTP server is stateless. Requests are bounded to eight in flight and JSON request bodies to 512 KiB. HTTP requests inherit the daemon's authorization context; standalone stdio uses its configured daemon URL and authorization context. Tool failures are returned as MCP errors with `isError: true`.

## Tool groups

The names below are registered by `platform/daemon/src/mcp/tools.ts`. Parameters use the exact camel/snake case shown by the schemas.

### Memory and evidence

| Tool | Required fields | Purpose |
|---|---|---|
| `memory_search` | `query` | Hybrid vector/keyword recall. Optional filters include `limit`, `project`, `type`, `tags`, `who`, `since`, `until`, `time`, `scope`, `agent_id`, `session_key`, `score_min`, `aggregate`, and `save_aggregate`. |
| `signet_recall` | `query` | Explicit Signet recall surface for clients whose generic memory tool would collide. |
| `signet_source_search` | `query` | Search source-backed artifacts, including imported documents and transcripts. |
| `memory_store` | `content`, `hints` | Store immutable episodic evidence. `structured` data is retained as evidence; it is not applied directly to ontology. |
| `signet_save_note` | note fields | Save an explicit Codex native-memory note; it does not edit generated `MEMORY.md`. |
| `memory_get` | `id` | Read one memory and its history. |
| `memory_list` | none | List memories with optional `limit`, `offset`, and `type`. |
| `memory_modify` | `id`, `reason` | Edit a memory with an auditable reason. |
| `memory_forget` | `id`, `reason` | Soft-delete a memory; the audit history remains. |
| `memory_feedback` | `session_key`, `ratings` | Record relevance scores from `-1` to `1` for the current session. |

`memory_store` writes evidence first. Dreaming is the semantic writer that derives ontology state from eligible evidence. `memory_search` is not transcript search; use `session_search` or `signet_session_search` for transcript evidence.

The recall `time` object accepts `start`, `end`, `facets` (`captured`, `session`, `source`, `observed`, `occurred`, `valid`), and `mode` (`auto`, `timeline`, `filter`). `min_score` is a deprecated compatibility alias for `importance_min`.

### Ontology and evidence explanation

| Tool | Required fields | Purpose |
|---|---|---|
| `knowledge_expand` | `entity_name` | Expand an entity's connected ontology context. |
| `knowledge_tree` | optional `entity` | Traverse entities, aspects, groups, and claims. |
| `knowledge_list_entities` | none | List known entities. |
| `knowledge_get_entity` | entity identifier | Read one entity. |
| `knowledge_list_aspects` | entity | List an entity's aspects. |
| `knowledge_list_groups` | entity, aspect | List groups in an aspect. |
| `knowledge_list_claims` | entity, aspect, group | List claims in a group. |
| `knowledge_list_attributes` | entity, aspect, group, claim | List attribute history; use `status=all` for superseded rows. |
| `signet_explain_claim` | `entity`, `aspect`, `group`, `claim` | Return bounded versions, competing values, source spans, premise integrity, authorization, and reverse lineage. |
| `knowledge_hygiene_report` | scope fields | Report hygiene candidates without mutating the graph. |
| `apply_ontology_ops` | operations and cited evidence | Apply ontology operations. Evidence must contain `source_ref`, `source_kind`, `source_id`, and an exact quote from scoped episodic evidence. |
| `entity_list` | none | Compatibility entity listing. |
| `entity_get` | entity | Compatibility entity read. |
| `entity_aspects` | entity | Compatibility aspect listing. |
| `entity_groups` | entity, aspect | Compatibility group listing. |
| `entity_claims` | entity, aspect, group | Compatibility claim listing. |
| `entity_attributes` | entity, aspect, group, claim | Compatibility attribute listing. |
| `knowledge_expand_session` | session context | Expand ontology context from session-linked evidence. |
| `lcm_expand` | memory/entity context | Expand a record with optional transcript context. |

`signet_explain_claim` fails closed for fabricated, stale, deleted, cross-agent, or cross-session source references. Check the response integrity status before treating a claim as current truth.

### Sessions and coordination

| Tool | Required fields | Purpose |
|---|---|---|
| `session_search` | `query` | Search active or completed transcripts. `current_session_key` can resolve sub-agent lineage. |
| `signet_session_search` | `query` | Namespaced transcript search for harnesses that already own `session_search`. |
| `agent_peers` | none | List active peer sessions; filter with `agent_id`, `session_key`, `project`, and `limit`. |
| `agent_message_send` | `content` | Send local or ACP-routed coordination messages. Use `to_session_key`, `to_agent_id`, or `broadcast`. |
| `agent_message_retry` | `message_id` | Retry an indeterminate ACP delivery within the bounded retry limit. |
| `agent_message_inbox` | none | Read bounded inbound messages with `agent_id`, `session_key`, `since`, `unread_only`, and pagination fields. |
| `agent_message_ack` | `message_id` | Acknowledge a visible message for the receiving agent. |

Message delivery is durable and agent-scoped. An ACP result may be `pending`, `in_flight`, `indeterminate`, `delivered`, or `failed`; Signet does not resend automatically.

### Secrets and operations

| Tool | Required fields | Purpose |
|---|---|---|
| `secret_list` | none | List secret names only; values are never returned. |
| `secret_exec` | `command`, `secrets` | Queue a command with referenced secrets in its environment. Output is redacted. Optional `timeoutSeconds` is bounded to 1,800 seconds. |
| `secret_exec_status` | `jobId` | Poll a queued command for redacted `stdout`, `stderr`, `code`, and timeout state. |

Secret references may be Signet names, `local://NAME`, `bw://...`, or `op://...`. Do not put raw secret values in MCP arguments.

### Hook control and optional code tools

| Tool | Required fields | Purpose |
|---|---|---|
| `session_bypass` | `session_key`, `enabled` | Toggle automatic hook processing for one session. MCP tools continue to work. |
| `signet_code_search` | `query` | Search the active GraphIQ project. |
| `signet_code_context` | `symbol` | Read source and structural context for a symbol. |
| `signet_code_blast` | `symbol` | Analyze impact; optional `depth` and `direction`. |
| `signet_code_status` | none | Show active GraphIQ status. |
| `signet_code_doctor` | none | Diagnose GraphIQ artifacts. |
| `signet_code_constants` | query fields | Find shared constants. |
| `signet_code_clear` | `confirm: true` | Destructively remove the active GraphIQ index. Rebuild with `signet index <path>`. |
| `signet_code_briefing` | optional `compact` | Summarize the active project's architecture. |

`signet_code_dead_code` is also registered by the GraphIQ plugin. The plugin's compatibility aliases are `code_search`, `code_context`, `code_blast`, `code_status`, `code_doctor`, `code_constants`, `code_dead_code`, `code_clear`, and `code_briefing`.

Code tools are available only when the optional GraphIQ plugin is enabled and a project has been indexed. The active index is shared by the workspace.

### External MCP tool servers

When marketplace proxying is enabled, the server also registers these tools for installed external MCP/Tool Servers: `mcp_server_list`, `mcp_server_search`, `mcp_server_enable`, `mcp_server_disable`, `mcp_server_scope_get`, `mcp_server_scope_set`, `mcp_server_policy_get`, `mcp_server_policy_set`, and `mcp_server_call`. Search may promote a bounded set of routed tools into the tool list; promoted names are generated from the server and tool identifiers and are not a stable built-in API. These tools call the daemon's `/api/marketplace/mcp/*` routes and are subject to their scope and exposure policy.

## Compatibility boundaries

`memory_search`, `session_search`, and the `entity_*` tools remain compatibility names. Prefer the `signet_*` names where a harness has a colliding native tool. Compatibility names translate into the same daemon operations; they do not own separate storage or semantics. `knowledge_expand_session` and `lcm_expand` are current registered tools, not extraction or marketplace aliases.

MCP does not run lifecycle work. It does not replace session-start context, prompt-submit behavior, compaction handling, transcript capture, or notification delivery. Use the HTTP hook routes documented in [Hooks](/hooks/).
