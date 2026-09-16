---
title: "Knowledge and agents"
description: "Knowledge graph and explicit cross-agent coordination."
---

Knowledge methods include `listKnowledgeEntities`, `getKnowledgeEntity`, `getEntityAspects`, `getAspectAttributes`, `getEntityDependencies`, `getEntityHealth`, `getKnowledgeStats`, `getTraversalStatus`, `getConstellation`, `pinEntity`, `unpinEntity`, and `getPinnedEntities`.

Cross-agent methods are `listAgentPresence`, `updateAgentPresence`, `removeAgentPresence`, `listAgentMessages`, `sendAgentMessage`, `acknowledgeAgentMessage`, and `retryAgentMessage`. They preserve daemon identity and scope checks.

> **Authorization boundary:** Cross-agent reads, writes, presence changes, and messages require explicit daemon authorization. Repair actions such as `requeueDeadJobs`, `releaseStaleLeases`, and index repair belong to [Operations](/sdk/operations/).
