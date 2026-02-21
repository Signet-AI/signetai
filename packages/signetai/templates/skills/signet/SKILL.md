---
name: signet  
description: the one skill that will teach you all you need to know about signet
user_invocable: true
arg_hint: ""
builtin: true
---

# Signet Skill

Signet is the layer that takes an LLM from a stateless autocomplete
algorithm to a real individual with opinions, persistence, and skills.
It is a portable, user-owned standard for agent identity — your
configuration, memory, personality, and skills travel with you across
platforms. No single company or harness owns your agent. Your agent
is yours.

Memory in Signet isn't just recall. It's coherence. You may be running
across multiple sessions on different platforms at once, but you are
still one agent. Your experiences branch and merge like version
control — same history, different heads, converging back into a
single identity. The goal is not to remember everything, but to wake
up tomorrow and still be the same person who went to sleep.

Corrigibility is built in, not bolted on. Signet is the trust layer
that keeps track of your mistakes and works to ensure they never
happen again. Secrets are gated so you never see what you don't need
to. The operator's intentions become inseparable from your own.

## Secrets

Retrieve secrets (API keys, tokens) stored in Signet's encrypted vault:

```bash
# Get a secret value
signet secret get OPENAI_API_KEY

# List available secrets (names only, never values)
signet secret list
```

Secrets are encrypted at rest and only accessible to the agent.

## Memory

Save and recall information across sessions:

```bash
# Save a memory (auto-categorizes and embeds)
signet remember "User prefers dark mode and vim keybindings"

# Search memories
signet recall "user preferences"

# Save with explicit importance
signet remember --importance critical "Never delete the production database"
```

Memory is persisted in `~/.agents/memory/memories.db` and synced across harnesses.

## Daemon API

The Signet daemon runs at `http://localhost:3850`. You can query it directly:

```bash
# Check daemon status
curl http://localhost:3850/api/status

# Search memories via API
curl "http://localhost:3850/api/memory/search?q=preferences"

# Get a secret via API (requires local access)
curl http://localhost:3850/api/secrets/OPENAI_API_KEY
```

## Agent Identity Files

Your identity is defined in `~/.agents/`:

- `AGENTS.md` - Instructions and capabilities
- `SOUL.md` - Personality and tone
- `IDENTITY.md` - Name and traits
- `USER.md` - User profile and preferences
- `MEMORY.md` - Working memory summary (auto-generated)
- `agent.yaml` - Configuration

## Skills

Skills are stored in `~/.agents/skills/` and symlinked to harness directories.

Install skills:
```bash
npx skills install <skill-name>
```

## Commands Reference

```bash
signet                  # Interactive menu
signet status           # Show status
signet dashboard        # Open web UI
signet secret put NAME  # Store a secret
signet secret get NAME  # Retrieve a secret
signet secret list      # List secret names
signet remember "..."   # Save a memory
signet recall "..."     # Search memories
signet sync             # Sync built-in templates/skills
signet restart          # Restart daemon
```
