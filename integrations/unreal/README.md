# Unreal Integration

Signet Unreal v001 is a UE5 code plugin that lets a game treat an NPC as a
Signet agent. The game owns canonical simulation state; Signet owns persistent
agent memory, scoped recall, and source-backed continuity.

## What It Does

- Adds a `Signet Agent Component` for NPC actors.
- Records NPC identity and player/world events into the local Signet daemon.
- Recalls scoped context for the NPC from Signet memory.
- Exposes the v001 flow through Blueprint async nodes.

## Backend

v001 targets a local daemon:

```text
http://127.0.0.1:3850
```

No hosted Signet Cloud, billing, or game-specific daemon schema is required for
v001. The plugin uses existing daemon routes:

- `GET /health`
- `POST /api/memory/remember`
- `POST /api/memory/recall`

## Unreal Plugin

The plugin lives at:

```text
integrations/unreal/plugin/SignetUnreal
```

Copy or symlink that directory into a UE5.4-5.6 project's `Plugins/` directory,
enable `Signet Unreal`, and restart the editor.

## Blueprint Flow

1. Add `Signet Agent Component` to an NPC actor.
2. Set `Agent Id`, `World Id`, `Display Name`, and `Role`.
3. Call `Register Signet NPC Agent`.
4. Call `Observe NPC Event` when the player interacts with the NPC.
5. Call `Recall NPC Context` before dialogue or behavior selection.

Scoped memory conventions:

- `world:{WorldId}` for NPC/world facts.
- `world:{WorldId}:player:{PlayerId}` for player-specific memory.

## Package

| Field | Value |
|-------|-------|
| Plugin | `SignetUnreal` |
| Runtime module | `SignetUnrealRuntime` |
| License | Apache-2.0 |
