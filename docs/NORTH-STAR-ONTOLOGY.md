---
title: "North Star Ontology"
description: "How Signet should turn artifacts and derived memory into an operational world model."
section: "Core Concepts"
---

North Star Ontology
===================

Signet should treat artifacts as the spine of memory.

An artifact is the raw thing Signet saw: a saved memory, transcript, Obsidian
note, email thread, GitHub issue, browser history item, source file, CSV row
set, or any other document-like unit. Different sources may need different
adapters, parsers, permissions, and metadata, but once they enter Signet they
should share the same artifact lifecycle.

That distinction is the whole design.

A memory should not disappear into the graph as one more anonymous fact. A long
saved memory often contains many details: a preference, a decision, a project
state, a warning, a date, a relationship, and a reason. The memory itself should
remain as an artifact. Then Signet should extract observations from it, update
claim slots, supersede older values when appropriate, and keep a lineage back to
the original saved memory.

The graph should become smarter because memories were saved. The saved memories
should not be mistaken for the graph itself.

The plain model
---------------

Signet has three layers.

The first layer is the evidence layer. This is the raw material: artifacts. A
transcript, saved memory, Obsidian note, email thread, GitHub issue, browser
history item, source file, and CSV row set are all artifacts. They differ by
kind and metadata, but not by ontology machinery. Each artifact should preserve
where it came from, who wrote it, when it was seen, what path, URL, session,
line range, or source system produced it, and what permissions apply.

The second layer is the interpretation layer. This is what Signet thinks it
noticed in the artifacts: observations, derived memories, attributes, claim
values, links, policies, and proposals. This layer is where raw text becomes
queryable structure.

The third layer is the operating layer. This is the compact surface agents use
to work: current values, task context, recall results, conflicts, permitted
actions, and evidence expansion tools. Agents should be able to ask what is true
enough to act on, what evidence supports it, what is uncertain, and what actions
are allowed.

The evidence layer is allowed to be messy. The interpretation layer should be
structured. The operating layer should be useful.

A simple flow looks like this:

```text
Artifact
  -> Observation or Proposal
  -> ClaimSlot
  -> ClaimValue
  -> Reducer
  -> CurrentView
  -> Question when needed
  -> User or agent review
  -> Audited update
```

This flow should apply whether the artifact came from Obsidian, a transcript,
GitHub, email, browser history, source code, or `remember(...)`.

Why artifacts matter
--------------------

An artifact is easy to reason about. It has a boundary. It has authorship. It
has time. It can be reprocessed. It can be cited. It can supersede another
artifact. It can contain many facts without forcing the system to decide all of
them at write time.

That is valuable for Signet because agents often save rich memories. For
example, an agent may save:

```text
Nicholai prefers Signet announcement scripts to sound like Daily Digest posts:
direct, product-forward, lightly narrative, and not first-person from Ant's
perspective.
```

That saved memory is an artifact. It should remain retrievable as the thing the
agent wrote. But it should also update the ontology:

```text
Entity: Nicholai
Aspect: communication preferences
ClaimSlot: signet_announcement_voice
ClaimValue: Daily Digest style, direct, product-forward, lightly narrative,
not first-person from Ant
Evidence: saved memory <id>, timestamp, author agent, project context
Reducer: explicit durable preference wins over older weaker style guesses
```

If a future memory says Nicholai now wants launch posts to be more formal, that
new memory should not simply sit next to the old one. Signet should detect that
it touches the same claim slot, preserve both values, mark the relationship
between them, and choose the current value through a reducer.

The user should be able to inspect the evidence and see why Signet believes the
newer preference applies.

Artifacts are the primary source object
---------------------------------------

Signet should not create separate ontology machinery for every raw source kind.
An Obsidian note, transcript, saved memory, email thread, GitHub issue, source
file, browser history item, and CSV row set should all enter the system as
artifacts.

Source-specific code belongs at the ingestion boundary. The Obsidian adapter can
read frontmatter, wikilinks, folders, headings, and line ranges. A transcript
adapter can read speakers, turns, harness, project, and session ids. An email
adapter can read sender, recipients, subject, thread, and timestamps. But after
that boundary, the shared ontology pipeline should operate on artifacts.

That gives Signet one simple rule:

```text
Adapters produce artifacts.
Ontology logic interprets artifacts.
Recall returns useful interpretations.
Evidence tools expand back to artifacts.
```

This avoids duplicating extraction, proposal, evidence, recall, and reducer
logic for every new source kind. New sources should add new artifact kinds and
metadata, not a new ontology.

The word "memory" needs to stay precise here. A saved memory is first an
artifact: the raw note an agent or user saved. It may also produce derived
memories, attributes, claim values, links, policies, or questions. Those derived
objects are interpretations of the artifact, not replacements for it.

What Signet already has
-----------------------

Signet is not starting from zero.

It already has entities, aspects, attributes, constraints, dependencies,
claim keys, group keys, source-aware recall, source chunks, provenance columns,
and structured remember behavior. Obsidian Sources already project a vault into
a graph: vaults become source objects, folders contain artifact-like document
objects, documents link to other documents, headings become aspects, and body
content becomes source-derived claims.

That is the right direction.

The current seam is that source-derived claims and memory-derived structured
claims still behave like different worlds. Source-derived attributes can exist
without a `memory_id`, while structured recall and currentness paths often
expect memory-backed attributes. The result is that an artifact can produce
useful graph rows, but those rows do not always participate in the same claim
lifecycle as facts saved through ordinary memory.

The north star is to make those one lifecycle.

A memory, transcript, Obsidian note, email, and GitHub issue should all be able
to produce observations. Observations should produce claim values. Claim values
should live under claim slots. Claim slots should have reducers. Reducers should
produce current views. Current views should be what agents normally use.
Evidence should always remain inspectable.

The upper ontology
------------------

The first stable ontology should stay small. It should name the objects agents
need in order to work safely.

- `Source`: a connected origin of artifacts, such as a vault, repo, mailbox,
  transcript store, memory store, browser history, or API.
- `Artifact`: one raw unit from a source, such as a saved memory, note,
  transcript, email thread, issue, source file, browser item, or row set.
- `Observation`: something Signet noticed in an artifact before deciding whether
  it should become durable operational knowledge.
- `ClaimSlot`: the named place where an updateable fact lives, such as a current
  address, preferred tone, project status, package manager, or allowed action.
- `ClaimValue`: one observed value for a claim slot, with source, time,
  confidence, visibility, and review state.
- `Reducer`: the policy that chooses the current value from multiple claim
  values.
- `CurrentView`: the value an agent should use right now, under the current
  permission and task context.
- `Proposal`: a reviewable candidate change to the ontology.
- `Question`: a request for user input when the evidence is missing,
  conflicting, stale, or high-impact.
- `EvidenceLineage`: the path from a current value back to observation,
  artifact, source, extraction run, and original text.
- `Action`: something Signet or an agent may do to an object.
- `Policy`: a rule that governs visibility, mutation, disclosure, or approval.
- `Event`: something that happened, such as a source changing, a proposal being
  applied, or a user answering a question.

This is not meant to replace domain objects like `Person`, `Project`, `Task`,
`GitRepository`, or `ObsidianVault`. Those are object types built on top of the
same primitives. The upper ontology should provide the verbs and guarantees.
Domain objects provide the local shape.

Reducers are current-truth policy
---------------------------------

A claim slot should not pretend there is only one value.

A person can have old addresses. A project can have old goals. A source can
have multiple indexing runs. A preference can be updated. A policy can be
different for public Discord than for a local terminal. Signet should keep the
values, then choose the operational value with an explicit reducer.

Reducers can be simple at first:

- explicit user statement beats inferred extraction;
- reviewed value beats unreviewed value;
- newer value beats older value when they clearly touch the same claim slot;
- original artifact beats summary;
- higher-confidence extraction beats lower-confidence extraction;
- visible value must be allowed under the current permission context.

The reducer should not erase the losing values. It should mark them as older,
superseded, conflicting, hidden, or still valid in a narrower context.

This gives agents a clear answer without destroying history.

Questions make the ontology useful
----------------------------------

A good ontology should not only store answers. It should know when to ask.

When Signet sees a new artifact, it should extract observations and compare
them to existing claim slots. Most changes should be quiet. Some should produce
reviewable proposals. A smaller number should become questions for the user.

Questions should appear when:

- two good sources disagree;
- a source implies an important fact but confidence is low;
- a claim is stale and agents keep using it;
- a new memory appears to supersede an old preference;
- a policy or permission boundary is unclear;
- an action depends on a claim that lacks evidence.

This is where uncertainty should become a user-facing loop. Signet should ask
targeted questions with provenance and agent-operational structure instead of
letting unclear evidence silently harden into current truth.

The question is not a random chatbot prompt. It is an ontology maintenance
object.

```text
Question: Which launch-post style should Signet use now?
Why: two claim values conflict
Evidence: memory A from March, memory B from May
Possible answer: prefer May style for product announcements, keep March style
for security notices
Result: user answer becomes a new artifact and updates the reducer
```

The user's answer is also an artifact. It should be saved, linked to the
question, and used to update the relevant claim slot.

Audited mutation and review queues
----------------------------------

Explicit, bounded ontology maintenance should apply through audited operation
handlers. That is the default path for ordinary dreaming and graph cleanup:
validate selectors, preserve evidence, write an applied operation record, and
update the graph in one controlled transaction.

Pending proposals are still important, but they are not the default for every
small update. They belong where review is valuable: broad graph refactors,
risky or destructive changes, duplicate merge campaigns, low-confidence
generated maintenance, and cases where the operator explicitly asks for a
review queue.

This matters because LLMs are useful but not sacred. A model can extract the
wrong entity, over-merge two projects, summarize away an important caveat, or
mark a value superseded when it is only context-specific. If raw artifacts are
preserved and risky generated changes can become proposals, Signet can rerun
extraction with a better model, inspect the diff, and apply only what makes
sense.

The daemon should stay boring where reliability matters. It should capture,
persist, index, expose APIs, track lineage, and keep recall fast. Semantic
maintenance can happen through agents, CLI tools, scheduled jobs, or explicit
user actions.

The current command shape is:

```text
signet ontology extract --from artifact:<id> --json
signet ontology extract --from transcript:<id> --write-proposals --json
signet ontology consolidate --proposals pending --json
signet ontology proposals --status pending --json
signet ontology proposal <id>
signet ontology apply <proposal-id>
signet ontology reject <proposal-id> --reason "weak evidence"
signet ontology claim-evidence <entity> <aspect> <group> <claim> --status all --json
signet ontology entity merge-plan "Canonical Entity" "Duplicate Entity" --propose --json
signet ontology stream apply ops.jsonl --json
```

The important part is not the exact CLI. The important part is that ontology
changes are inspectable operations, not invisible side effects.

How this fits existing Signet
-----------------------------

This direction should fit inside Signet as it already exists.

The current `memories` table can keep storing user and agent memory artifacts.
Long memories do not need to become perfect atomic facts at save time. They can
be artifacts first, then feed extraction.

The current entity, aspect, group, claim key, and attribute model can remain the
first claim-slot implementation. A claim slot maps naturally to:

```text
entity + aspect + group_key + claim_key
```

The current `entity_attributes` rows can evolve toward claim values. Instead of
only meaning "the fact," an attribute row can mean "one value observed for this
slot." Its status, confidence, importance, source metadata, and supersession
fields become part of the reducer input.

Source projection should keep doing what it does well. Obsidian structure,
folder hierarchy, wikilinks, headings, line ranges, source paths, and source
ownership should remain mechanical and deterministic where possible. That gives
Signet a clean evidence floor before any model tries to interpret meaning.

Structured remember should become one input to the same lifecycle. If an agent
writes a structured memory, Signet can place the claim value directly into a
slot. If an agent writes a long unstructured memory, Signet can save it as an
artifact, then extract observations and propose updates.

Dreaming should become consolidation over evidence, not hidden direct mutation.
It should reason over artifacts, observations, old claim values, current
reducers, conflicts, and user answers. Its normal output should be audited
operations with provenance, epistemic assertions for attributed statements, and
questions where evidence is weak. Pending proposals remain the right output for
large refactors, risky generated maintenance, or explicit review queues.

The low-touch path stays
------------------------

The ontology must not turn normal agent work into paperwork.

Agents still need simple tools:

```text
recall("what matters here?")
remember("Nicholai prefers X")
get_context_for_task(...)
show_evidence_for(claim)
what_can_i_do_with(object)
```

The deeper ontology should run underneath those tools. An agent should be able
to save a memory quickly and trust Signet to preserve it, index it, and later
consolidate it. When the agent needs more control, the proposal and evidence
surfaces should be available.

The rule is simple: ordinary use should feel low-touch. Maintenance should be
explicit when it changes what agents believe or may do.

What this unlocks
-----------------

This gives Signet a cleaner product shape.

A user connects sources. Signet indexes their artifacts as evidence. The
ontology shows people, projects, artifacts, tasks, policies, and claims. Agents
operate through current views, not raw chunks. When evidence changes, Signet
applies clear source-backed updates through the control plane and proposes
risky updates for review. When evidence conflicts, Signet asks targeted
questions. When the user answers, that answer becomes a new artifact with
lineage.

This also gives Signet a cleaner engineering path.

The first implementation does not need every ontology primitive. It can start by
making saved memories, transcripts, and documents participate in the same
artifact-derived claim lifecycle:

1. Treat each saved memory as an artifact.
2. Extract observations from artifacts without discarding the original.
3. Map observations to existing entity/aspect/group/claim slots.
4. Store multiple claim values per slot with provenance.
5. Use reducers to choose current values.
6. Apply clear source-backed updates with audit metadata.
7. Emit proposals when a risky new value should supersede or conflict with an
   old one.
8. Emit questions when the system needs user judgment.
9. Show evidence lineage from current value back to the original artifact.

That is the north star: Signet as an artifact-backed operational ontology.

Not a memory pile. Not a decorative graph. Not a trend with better marketing.

A world model agents can act through, with artifacts underneath and reviewable
change on top.
