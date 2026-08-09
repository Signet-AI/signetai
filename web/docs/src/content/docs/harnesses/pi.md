---
title: "Pi"
description: "Connect Signet to Pi."
---

## pi (`pi`)

pi uses a managed Signet runtime extension installed by
`@signetai/connector-pi`. The extension forwards lifecycle events
to the daemon and injects hidden Signet context into the session when
needed.

### Files managed by Signet

| File | Description |
|------|-------------|
| `PI_CODING_AGENT_DIR/extensions/signet-pi.js` | Managed extension bundle when `PI_CODING_AGENT_DIR` is set |
| `~/.pi/agent/extensions/signet-pi.js` | Managed extension bundle in the default pi agent directory |

### Managed extension

During setup or connect, the connector writes a bundled
`signet-pi.js` file into the pi extensions directory. If
`PI_CODING_AGENT_DIR` is set, Signet uses that agent directory.
Otherwise it writes to `~/.pi/agent/extensions/`.

### Runtime behavior

- Existing unrelated pi extensions are left untouched.
- Signet refuses to overwrite a colliding unmanaged `signet-pi.js`.
- Daemon or network failures are fail-open, so prompt handling, compaction, session switches, and shutdown continue even if Signet is unavailable.
- **Automatic recall**: On every user prompt, the extension automatically fetches relevant memories from the daemon and injects them as hidden messages (`display: false`) into the agent's context. These injections are kept out of transcript reconstruction.
- **Manual commands**: `/recall <query>` and `/remember <content>` let users explicitly search and store memories. The `/recall` command **displays results in the UI only** — it does not inject them into the conversation context. `/signet-status` shows connection and memory stats.
  - `/remember <content>` — save a memory
  - `/remember critical: <content>` — save as pinned (never decays)
  - `/remember [tag1, tag2]: <content>` — save with tags
  - `/remember critical: [tag1, tag2]: <content>` — pinned with tags (critical prefix must come first)
- **Agent tools**: `signet_recall`, `signet_source_search`, `signet_session_search`, and `signet_remember` are registered as LLM-callable tools. When the agent calls `signet_recall`, the results (including memory IDs) **are** returned into the conversation context via the tool response. `signet_source_search` searches provenance-backed artifacts separately from ordinary memory recall; `signet_session_search` searches active or completed session transcripts.
- Hidden inject messages use `display: false` and `role: "custom"`. Pi converts custom messages to `role: "user"` for the LLM, so the `X-Initiator` header (which determines Copilot billing attribution) is set based on the last message's role — extensions cannot override it via an `attribution` field as Oh My Pi can.
- Does not sync `AGENTS.md` into pi.

### Configuration

Configuration is optional and loaded from `~/.pi/agent/extensions/signet.json`
(or `$PI_CODING_AGENT_DIR/extensions/signet.json` if set). The `SIGNET_ENABLED`
environment variable overrides the file setting.

**Optional `~/.pi/agent/extensions/signet.json`:**

```json
{
  "enabled": false
}
```

| Option    | Description                                    | Default |
|-----------|------------------------------------------------|---------|
| `enabled` | Whether Signet is enabled by default           | `true`  |

**Environment Variable** (overrides file config):

| Variable         | Description                    |
|------------------|--------------------------------|
| `SIGNET_ENABLED` | Set to `false` to disable      |

Examples:

```bash
# Use config file defaults
pi

# Disable Signet for a single session
SIGNET_ENABLED=false pi

# Create a config file to disable by default
echo '{"enabled": false}' > ~/.pi/agent/extensions/signet.json
```

### Supported hooks

| Hook               | Supported |
|--------------------|-----------|
| session-start      | yes       |
| user-prompt-submit | yes       |
| pre-compaction     | yes       |
| compaction-complete| yes       |
| session-end        | yes       |

---
