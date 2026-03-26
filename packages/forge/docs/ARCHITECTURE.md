# Forge Architecture

Forge is a Rust workspace that acts as a terminal-native client on top of the Signet daemon.

## High-level shape

```text
User
  -> Forge terminal UI
  -> agent loop
  -> provider execution and tool calls
  -> Signet daemon for memory, identity, secrets, skills, MCP, and extraction
```

## Main responsibilities

### Forge

Forge handles:

- terminal UI
- chat/session interaction
- provider selection and execution
- command handling
- local credential storage
- integration with Signet daemon endpoints

### Signet daemon

The daemon handles persistent and shared system concerns:

- memory storage and recall
- session lifecycle hooks
- transcript extraction pipeline
- identity loading and config support
- secret storage
- skill and MCP discovery surfaces
- model registry support

## Why this split exists

Forge should be the terminal-native harness.

Signet should remain the source of truth for persistent and cross-session concerns.

That separation keeps the client simpler and avoids duplicating long-term state in multiple places.

## Runtime flow

A typical interaction looks like this:

1. user opens Forge
2. Forge loads config, provider state, and Signet connectivity
3. user sends a prompt
4. Forge performs recall through Signet when enabled
5. Forge runs the selected model and tools
6. Forge displays the result in the terminal
7. session data is submitted back through the Signet pipeline

## Dynamic command flow

Forge now supports dynamic commands sourced from Signet-managed layers.

That includes:

- installed Signet skills
- installed MCP servers and tools

This means the terminal command surface can evolve with the Signet installation instead of staying fully hardcoded.

## Design direction

The architectural direction is:

- keep Signet as the source of truth
- keep Forge fast and native in the terminal
- reduce duplicated auth and model config
- make installed Signet capabilities immediately visible in Forge
