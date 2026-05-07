---
title: "North Star Ontology"
description: "How Signet should turn sources, memories, and transcripts into an operational world model."
section: "Core Concepts"
---

North Star Ontology
===================

Signet should treat source truth as the spine of memory.

A source can be an Obsidian note, a Git repository, a transcript, an email
thread, a CSV file, a browser history item, or a memory saved by an agent. The
source is the thing that happened or the document that exists. The ontology is
Signet's working interpretation of that source.

That distinction is the whole design.

A memory should not disappear into the graph as one more anonymous fact. A long
saved memory often contains many details: a preference, a decision, a project
state, a warning, a date, a relationship, and a reason. The memory itself should
remain as a document-like artifact. Then Signet should extract observations from
it, update claim slots, supersede older values when appropriate, and keep a
lineage back to the original saved memory.

The graph should become smarter because memories were saved. The saved memories
should not be mistaken for the graph itself.

The plain model
---------------

Signet has two layers.

The first layer is source truth. This is the raw material: files, notes,
transcripts, messages, memories, documents, rows, commits, issues, emails, and
other artifacts. These objects should be preserved with provenance. Where did it
come from? Who wrote it? When was it seen? What path, URL, session, line range,
or source system produced it? What permissions apply?

The second layer is the operational ontology. This is the compact surface agents
use to work: people, projects, sources, tasks, policies, actions, claims,
current values, conflicts, evidence, and reviewable proposals. Agents should be
able to ask what is true enough to act on, what evidence supports it, what is
uncertain, and what actions are allowed.

The source layer is allowed to be messy. The ontology layer should be useful.

A simple flow looks like this:

```text
Source
  -> SourceArtifact
  -> Observation
  -> ClaimSlot
  -> ClaimValue
  -> Reducer
  -> CurrentView
  -> Proposal or Question
  -> User or agent review
  -> Audited update
```

This flow should apply whether the source is an Obsidian document, a transcript,
a GitHub PR, or an agent-saved memory.

Why documents matter
--------------------

The important lesson from Supermemory is not that Signet should copy their
product. It is that document-shaped source truth gives the system a strong
spine.

A document is easy to reason about. It has a boundary. It has authorship. It has
time. It can be reprocessed. It can be cited. It can supersede another document.
It can contain many facts without forcing the system to decide all of them at
write time.

That is valuable for Signet because agents often save rich memories. For
example, an agent may save:

```text
Nicholai prefers Signet announcement scripts to sound like Daily Digest posts:
direct, product-forward, lightly narrative, and not first-person from Ant's
perspective.
```

That saved memory is a source artifact. It should remain retrievable as the
thing the agent wrote. But it should also update the ontology:

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

What Signet already has
-----------------------

Signet is not starting from zero.

It already has entities, aspects, attributes, constraints, dependencies,
claim keys, group keys, source-aware recall, source chunks, provenance columns,
and structured remember behavior. Obsidian Sources already project a vault into
a graph: vaults become source objects, folders contain documents, documents
link to other documents, headings become aspects, and body content becomes
source-derived claims.

That is the right direction.

The current seam is that source-derived claims and memory-derived structured
claims still behave like different worlds. Source-derived attributes can exist
without a `memory_id`, while structured recall and currentness paths often
expect memory-backed attributes. The result is that a source document can
produce useful graph rows, but those rows do not always participate in the same
claim lifecycle as facts saved through ordinary memory.

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

- `Source`: a connected origin of truth, such as a vault, repo, mailbox,
  transcript store, or memory store.
- `SourceArtifact`: one document-like unit from a source, such as a note,
  transcript, saved memory, email thread, issue, file, or row set.
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
- source-of-truth document beats summary;
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

This is where Supermemory's product lesson is strongest. Their graph feels
useful because uncertainty becomes a user-facing loop. Signet should do the
same, but with stronger provenance and agent-operational structure.

The question is not a random chatbot prompt. It is an ontology maintenance
object.

```text
Question: Which launch-post style should Signet use now?
Why: two claim values conflict
Evidence: memory A from March, memory B from May
Possible answer: prefer May style for product announcements, keep March style
for security notices
Result: user answer becomes a new source artifact and updates the reducer
```

The user's answer is also source truth. It should be saved as an artifact,
linked to the question, and used to update the relevant claim slot.

Proposals before mutation
-------------------------

Extraction and consolidation should produce proposals before they mutate the
ontology.

This matters because LLMs are useful but not sacred. A model can extract the
wrong entity, over-merge two projects, summarize away an important caveat, or
mark a value superseded when it is only context-specific. If raw artifacts are
preserved and mutations are proposals, Signet can rerun extraction with a better
model, inspect the diff, and apply only what makes sense.

The daemon should stay boring where reliability matters. It should capture,
persist, index, expose APIs, track lineage, and keep recall fast. Semantic
maintenance can happen through agents, CLI tools, scheduled jobs, or explicit
user actions.

A practical command shape might look like this:

```text
signet ontology extract --from artifact:<id> --dry-run
signet ontology consolidate --entity Nicholai --since 30d --dry-run
signet ontology proposals list
signet ontology proposal show <id>
signet ontology apply <proposal-id>
signet ontology reject <proposal-id>
signet ontology evidence <claim-slot-id>
```

The important part is not the exact CLI. The important part is that ontology
changes are inspectable operations, not invisible side effects.

How this fits existing Signet
-----------------------------

This direction should fit inside Signet as it already exists.

The current `memories` table can keep storing user and agent memory artifacts.
Long memories do not need to become perfect atomic facts at save time. They can
be source artifacts first, then feed extraction.

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
It should reason over source artifacts, observations, old claim values, current
reducers, conflicts, and user answers. Its output should be proposals and
questions first.

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

A user connects sources. Signet indexes them as source truth. The ontology shows
people, projects, documents, tasks, policies, and claims. Agents operate through
current views, not raw chunks. When evidence changes, Signet proposes updates.
When evidence conflicts, Signet asks targeted questions. When the user answers,
that answer becomes a new source artifact with lineage.

This also gives Signet a cleaner engineering path.

The first implementation does not need every ontology primitive. It can start by
making saved memories, transcripts, and source documents participate in the same
claim lifecycle:

1. Treat each saved memory as a source artifact.
2. Extract observations from memory artifacts without discarding the original.
3. Map observations to existing entity/aspect/group/claim slots.
4. Store multiple claim values per slot with provenance.
5. Use reducers to choose current values.
6. Emit proposals when a new value should supersede or conflict with an old one.
7. Emit questions when the system needs user judgment.
8. Show evidence lineage from current value back to source artifact.

That is the north star: Signet as a source-backed operational ontology.

Not a memory pile. Not a decorative graph. Not a filesystem trend with better
marketing.

A world model agents can act through, with source truth underneath and reviewable
change on top.
