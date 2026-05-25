# Signet Unreal

Signet Unreal is a UE5.4-5.6 code plugin for using Signet as the persistent
memory backend for AI-driven NPC agents.

## Install In A Project

1. Start the local Signet daemon.
2. Copy `SignetUnreal/` into your Unreal project's `Plugins/` directory.
3. Open the project and enable `Signet Unreal`.
4. Configure `Project Settings > Plugins > Signet Unreal`.
5. Add `Signet Agent Component` to an NPC actor.

Default daemon URL:

```text
http://127.0.0.1:3850
```

## Blueprint Nodes

- `Signet Health Check`
- `Register Signet NPC Agent`
- `Observe NPC Event`
- `Recall NPC Context`

## v001 NPC Flow

1. Build an identity from the `Signet Agent Component`.
2. Call `Register Signet NPC Agent`.
3. Call `Observe NPC Event` whenever the NPC experiences a relevant player or
   world event.
4. Call `Recall NPC Context` before dialogue or behavior selection.
5. Feed `Prompt Context` into your dialogue model, dialogue graph, behavior
   tree, or debug UI.

## Scoping

The plugin maps Unreal NPCs to Signet agents:

```text
AgentId = NPC identity
scope = world:{WorldId}
scope = world:{WorldId}:player:{PlayerId}
```

World-scoped memories are recalled for the NPC in that world. Player-scoped
memories are recalled only when a `PlayerId` is provided.

## Event IDs

If `EventId` is supplied, it becomes the stable source/idempotency key for that
event. Use this for retryable authored events.

If `EventId` is empty, the plugin generates a GUID so repeated similar player
interactions do not collapse into one memory.

## Runtime Boundary

The game remains the source of truth for save data, combat, quests, inventory,
animation, pathfinding, and replication. Signet supplies continuity context:
identity, memory, recall, source evidence, and scoped behavior history.
