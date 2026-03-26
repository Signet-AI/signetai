# Slash Commands, Skills, and MCP

Forge supports both built-in slash commands and dynamically discovered commands from Signet.

## Built-in slash commands

Forge includes built-in commands such as:

- `/model`
- `/recall`
- `/remember`
- `/mcp`

These are available directly in the terminal UI and participate in autocomplete and command-palette flows.

## Dynamic Signet skills

Forge can load installed Signet skills and expose user-invocable ones as slash commands.

### Behavior

If a skill is installed and marked as user-invocable, it can appear as:

- `/skill-name`

Usage patterns:

- `/skill-name`
  - arms the next prompt with that skill
- `/skill-name <prompt>`
  - runs immediately with the skill applied

### Source of truth

Forge can derive skill commands from the Signet skill layer rather than requiring hardcoded command entries.

That keeps installed Signet skills feeling native inside Forge.

## Dynamic MCP commands

Forge can also expose installed MCP servers and tools through slash commands.

### Supported forms

- `/mcp`
- `/mcp-<server-id> <tool> [json args]`
- `/mcp-<server-id>-<tool-name> [json args]`

### Why namespacing matters

Flattening every MCP tool into a single global slash-command namespace would create collisions.

Namespacing by server keeps commands predictable and avoids conflicts between similarly named tools.

## Autocomplete and picker behavior

Dynamic commands should participate in the same UX surfaces as built-ins:

- slash autocomplete
- tab completion
- command picker

The point is that a skill or MCP tool installed through Signet should feel immediately available inside Forge.

## Signet-backed discovery

The intended pipeline is:

1. install or enable a skill/server in Signet
2. Forge discovers it
3. the command appears in Forge automatically

That keeps Signet as the system of record while letting Forge surface the functionality directly in the terminal.
