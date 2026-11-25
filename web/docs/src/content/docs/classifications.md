---
title: Classifications
description: Limit organization content to an explicit audience.
---

In an organization, agents organize work; classifications control who can read
it. Unclassified work is visible across the organization. A classification names
an audience of people and groups, such as HR or Legal. Administrators and
compliance officers do not automatically belong to that audience.

## Create a classification

A compliance officer creates the definition with a name, an optional color and
description, and its audience. An empty audience means nobody can read the
classified material in organization mode. Local mode remains trusted.

An optional appliers list limits who may apply the classification. When that list
is empty, the author of the material, its personal-agent owner, or a team-agent
group owner may apply it. Compliance officers may apply any classification.
Only compliance officers may remove one. An archived definition cannot be
applied to new material.

## Apply it to work

Use a memory, session, managed source, or agent as the target. A session or source
classification also covers its evidence and directly derived claims. A claim's
materialized memory, hints, and embeddings move with it. This changes access,
not the source text or the claim's meaning.

Preview the transition before applying it. Preview counts include only rows you
can read. Applying or removing a classification returns a tracked job. A `202`
response means the job was accepted, not that the transition finished. Add
`?wait=1` to wait for completion. Large transitions commit bounded batches, with
each evidence row and its directly derived copies moving together. Other reads
can run between batches. A failed batch rolls back its moves and cursor without
undoing earlier committed batches. Pending and running jobs resume from their
durable cursor after a daemon restart; jobs for the same agent never run concurrently.
After five consecutive batch failures, a job fails with a recorded error and audit
event, allowing queued jobs to proceed. Its applied restriction remains in place;
retry the classification or have a compliance officer remove it.

Matching content hides as soon as apply is accepted, before the batches finish.
Search rankings and result counts can still be affected by those newly hidden
rows until they move into separate indexes. That ranking-statistics window
closes when the job completes.

## Multiple classifications

A reader must belong to the audience of **every** classification on a row. For
example, material carrying both HR and Legal is visible only to people in both
audiences. Group membership and audience changes take effect on the next read.
There is no administrator or compliance bypass for reading content.

People outside an audience cannot discover its definition through the list or
get endpoint. Compliance officers can manage every definition and inspect
assigned target identifiers, but cannot read content outside their audience.

See the [classification API](/api/#classifications) for request bodies and routes.
