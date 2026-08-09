---
title: "Knowledge and agents"
description: "Use knowledge graph, cross-agent messaging, predictor, and timeline APIs."
---

## Knowledge Graph

Query the knowledge graph (entities, aspects, attributes).

**`listEntities()`** — List knowledge entities.

```typescript
const entities = await signet.listEntities({
  limit: 50,
  type: "person",  // Optional: filter by entity type
});
// entities[n].id — entity identifier
// entities[n].name — entity name
// entities[n].type — entity type
// entities[n].mention_count — number of times mentioned
```

**`getEntity(id)`** — Get entity details.

```typescript
const entity = await signet.getEntity("ent-abc-123");
// entity.id — entity identifier
// entity.name — entity name
// entity.type — entity type
// entity.created_at — when entity was created
// entity.metadata — entity-specific metadata
```

**`pinEntity(id)`** — Pin an entity (keep in working context).

```typescript
await signet.pinEntity("ent-abc-123");
```

**`unpinEntity(id)`** — Unpin an entity.

```typescript
await signet.unpinEntity("ent-abc-123");
```

**`listPinnedEntities()`** — List all pinned entities.

```typescript
const pinned = await signet.listPinnedEntities();
// pinned[n].id — entity ID
// pinned[n].name — entity name
// pinned[n].pinned_at — when pinned
```

**`getEntityHealth()`** — Get entity graph health metrics.

```typescript
const health = await signet.getEntityHealth();
// health.total_entities — total entity count
// health.singleton_entities — entities with single mention
// health.orphaned_entities — entities with no relationships
// health.avg_mentions — average mentions per entity
```

**`getEntityAspects(id)`** — Get aspects for an entity.

```typescript
const aspects = await signet.getEntityAspects("ent-abc-123");
// aspects[n].id — aspect identifier
// aspects[n].name — aspect name
// aspects[n].mention_count — times this aspect mentioned
```

**`getEntityAttributes(entityId, aspectId)`** — Get attributes for an aspect.

```typescript
const attrs = await signet.getEntityAttributes("ent-abc", "asp-xyz");
// attrs[n].key — attribute key
// attrs[n].value — attribute value
// attrs[n].confidence — confidence score
```

**`getEntityDependencies(id)`** — Get entity dependency graph.

```typescript
const deps = await signet.getEntityDependencies("ent-abc-123");
// deps.related — related entities
// deps.depends_on — entities this depends on
// deps.depended_by — entities depending on this
```

**`getKnowledgeStats()`** — Get knowledge graph statistics.

```typescript
const stats = await signet.getKnowledgeStats();
// stats.total_entities — entity count
// stats.total_aspects — aspect count
// stats.total_attributes — attribute count
// stats.total_mentions — mention count
```

**`getTraversalStatus()`** — Get graph traversal cache status.

```typescript
const status = await signet.getTraversalStatus();
// status.last_update — when cache was last updated
// status.cache_size — cache size in bytes
// status.hit_rate — cache hit rate
```

**`getConstellation()`** — Get constellation visualization data.

```typescript
const constellation = await signet.getConstellation({
  dimensions: 2,  // 2D or 3D projection
  limit: 100,  // Max entities to include
});
// constellation.nodes — entity nodes
// constellation.edges — relationship edges
// constellation.positions — UMAP positions
```

## Cross-Agent Messaging

Presence and messaging for multi-agent coordination.

**`listPresence()`** — List active agent sessions.

```typescript
const presence = await signet.listPresence();
// presence[n].agent_id — agent identifier
// presence[n].session_key — session key
// presence[n].project — current project
// presence[n].last_seen — last activity timestamp
```

**`updatePresence(opts)`** — Update agent presence.

```typescript
await signet.updatePresence({
  agent_id: "agent-abc",
  session_key: "sess-123",
  project: "/home/user/myapp",
});
```

**`removePresence(sessionKey)`** — Remove agent presence.

```typescript
await signet.removePresence("sess-123");
```

**`listMessages(opts)`** — List cross-agent messages.

```typescript
const messages = await signet.listMessages({
  agent_id: "agent-abc",
  limit: 20,
  include_sent: true,
});
// messages[n].from_agent_id — sender
// messages[n].to_agent_id — recipient
// messages[n].type — message type
// messages[n].content — message content
// messages[n].timestamp — when sent
```

**`sendMessage(opts)`** — Send message to another agent.

```typescript
await signet.sendMessage({
  from_agent_id: "agent-abc",
  to_agent_id: "agent-xyz",
  type: "question",
  content: "Have you seen the latest architecture decisions?",
});
```

**`streamEvents()`** — SSE stream of cross-agent events.

```typescript
const stream = await signet.streamEvents();
stream.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  console.log(`[${msg.type}] ${msg.from_agent_id}: ${msg.content}`);
};
```

## Predictor Training

Train and query the predictive memory scorer.

**`getPredictorStatus()`** — Get predictor status.

```typescript
const status = await signet.getPredictorStatus();
// status.enabled — whether predictor is enabled
// status.model_loaded — whether model is loaded
// status.training_runs — number of training runs
// status.last_training — last training timestamp
```

**`getPredictorComparisons()`** — Get recent comparisons.

```typescript
const comparisons = await signet.getPredictorComparisons({
  limit: 50,
});
// comparisons[n].entity_id — entity compared
// comparisons[n].baseline_score — baseline relevance
// comparisons[n].predictor_score — predicted relevance
// comparisons[n].actual_relevance — ground truth
```

**`getComparisonsByProject(project)`** — Get comparisons for a project.

```typescript
const comparisons = await signet.getComparisonsByProject("/home/user/myapp");
```

**`getComparisonsByEntity(entityId)`** — Get comparisons for an entity.

```typescript
const comparisons = await signet.getComparisonsByEntity("ent-abc-123");
```

**`listTrainingRuns()`** — List training runs.

```typescript
const runs = await signet.listTrainingRuns();
// runs[n].id — run identifier
// runs[n].timestamp — when run occurred
// runs[n].epochs — number of epochs
// runs[n].final_loss — training loss
// runs[n].accuracy — validation accuracy
```

**`getTrainingPairsCount()`** — Count available training pairs.

```typescript
const count = await signet.getTrainingPairsCount();
// count.total — total training pairs
// count.positive — positive examples
// count.negative — negative examples
```

**`trainPredictor(opts)`** — Trigger training run.

```typescript
const run = await signet.trainPredictor({
  epochs: 10,
  learning_rate: 0.001,
  batch_size: 32,
});
// run.id — training run ID
// run.status — "running" | "completed" | "failed"
```

**`exportTrainingTelemetry()`** — Export training telemetry.

```typescript
const data = await signet.exportTrainingTelemetry({
  since: "2025-01-01T00:00:00Z",
});
// data — NDJSON telemetry events
```

## Timeline Export

Export entity event timelines.

**`getTimeline(id)`** — Get entity timeline.

```typescript
const events = await signet.getTimeline("ent-abc-123");
// events[n].timestamp — event timestamp
// events[n].event_type — event type
// events[n].description — event description
// events[n].metadata — event metadata
```

**`exportTimeline(id)`** — Export timeline with metadata.

```typescript
const exported = await signet.exportTimeline("ent-abc-123", {
  format: "json",  // "json" | "csv"
  include_metadata: true,
});
// exported.data — exported timeline data
// exported.format — export format
// exported.generated_at — export timestamp
```
