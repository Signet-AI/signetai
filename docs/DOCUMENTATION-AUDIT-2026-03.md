---
title: "Documentation Audit — March 25, 2026"
description: "Repo-wide audit of Signet documentation for positioning drift, shipped-vs-roadmap confusion, and technical contradictions."
order: 999
section: "Internal"
---

# Documentation Audit — March 25, 2026

This document is a point-in-time audit snapshot taken before the
follow-up remediation pass in this PR was complete. Treat contradiction
lists below as audit findings captured at review time, not as a claim
that every item still remains unresolved in the current branch state.

## Scope

This audit covers the highest-impact documentation surfaces in the
repository, with emphasis on:

1. Product positioning accuracy
2. Shipped-vs-roadmap clarity
3. Consistency with current implementation
4. Whether Signet's actual thesis is being described correctly

Primary files reviewed:

- `README.md`
- `docs/WHAT-IS-SIGNET.md`
- `docs/QUICKSTART.md`
- `docs/AUTH.md`
- `docs/CONFIGURATION.md`
- `docs/PIPELINE.md`
- `docs/DASHBOARD.md`
- `docs/ARCHITECTURE.md`
- `docs/MEMORY.md`
- `docs/KNOWLEDGE-GRAPH.md`
- `docs/KNOWLEDGE-ARCHITECTURE.md`
- `docs/ROADMAP.md`
- `docs/CONTRIBUTING.md`
- `packages/daemon/src/memory-config.ts`
- `packages/cli/templates/agent.yaml.template`

---

## Executive Summary

At audit start, the docs had three major failure modes.

### P0-1. Core positioning drift

A large portion of the public docs describe Signet as if its defining
innovation is:

- a knowledge graph
- graph traversal
- structured long-term memory
- hybrid retrieval

These are important components, but they are not the actual thesis.
They are substrate.

The real thesis is:

**Signet is a learned context-selection system.**

Structured memory, distillation, graph traversal, and retrieval exist to
produce the data, constraints, and candidate pool needed to train and
run a predictor that learns what context is actually useful to inject
into the agent at the moment of use.

If a doc makes Signet sound like “a knowledge graph for agents” or
“better storage/retrieval,” it is describing the wrong product.

### P0-2. Predictor status contradictions

The docs disagree with each other and with the codebase about whether the
predictor is enabled by default.

Contradictions found at audit time:

- `docs/PIPELINE.md` says: predictor disabled by default
- `docs/DASHBOARD.md` says: predictor disabled by default
- `packages/daemon/src/memory-config.ts` defaults `predictor.enabled` to `true`
- `packages/cli/templates/agent.yaml.template` sets `predictor.enabled: true`

This is a straight factual contradiction and must be resolved.

### P0-3. Auth / identity contradictions

The docs disagree about current auth architecture.

Contradictions found at audit time:

- `docs/AUTH.md` describes current auth as HMAC-signed bearer tokens
- `docs/QUICKSTART.md` claims current ERC-8128 wallet-based identity/signatures
- `docs/CONTRIBUTING.md` also refers to ERC-8128 wallet-based auth
- `docs/CONFIGURATION.md` says ERC-8128 verification is reserved for the future
- `docs/WHAT-IS-SIGNET.md` frames EIP-8004 as a future identity direction
- `docs/ROADMAP.md` also frames wallet/EIP identity as future work

Current behavior and future roadmap are being mixed together.

---

## The Correct Product Thesis

This wording should become the internal test for all explanation,
marketing, and high-level docs:

> Signet is not novel because it structures knowledge. Structured memory,
> knowledge graphs, graph-augmented retrieval, and transcript
> distillation are established primitives. Signet's novelty is in using
> those primitives to build a training and inference loop for predictive
> context selection. The goal is not simply to store or retrieve
> knowledge, but to learn, from agent behavior itself, which context is
> actually useful at the moment of use, then outperform heuristic
> retrieval over time.

Short form:

> The graph is not the product. The retrieval stack is not the product.
> The distillation layer is not the product. They are data-generation and
> constraint machinery for a learned context-selection system.

---

## Global Guardrails For Future Docs

### 1. Never claim novelty in the graph layer

Do not frame the following as Signet's core novelty:

- knowledge graphs
- graph traversal
- entity-aspect-attribute storage
- hybrid vector + keyword retrieval
- distillation by itself

Those are implementation primitives and substrate.

### 2. Lead with context selection, not storage

High-level docs should answer this question first:

**Given everything an agent knows, what should enter the context window right now?**

That is the product problem.

### 3. Separate present tense from roadmap tense

Use clear language distinctions:

- **today / currently / in the current implementation** for shipped behavior
- **planned / building toward / roadmap / target architecture** for future behavior

Do not blur them.

### 4. Reference docs must describe current behavior only

Files like `AUTH.md`, `API.md`, `CONFIGURATION.md`, `PIPELINE.md`, and
`MEMORY.md` must reflect actual current implementation, not aspiration.

### 5. Explanation docs must not accidentally become hype docs

Files like `README.md`, `WHAT-IS-SIGNET.md`, and `QUICKSTART.md` should
explain the system's direction clearly, but must not imply that roadmap
components are fully mature if they are not.

---

## Priority Findings

## P0 Findings

### P0-1. `README.md` frames the machinery more clearly than the thesis

**Problem:**

The README is better than some of the other docs, but the “How it works”
section still reads like a pipeline of graph/storage behaviors with the
predictor as one step among many:

- extraction
- graph linking
- constraints
- transcripts
- predictive scorer
- dampening
- injection

This sequencing hides the real claim: the earlier stages exist in order
to support predictive context selection.

**Why it matters:**

For many readers, the README is the product definition.
If the README makes Signet sound like a graph-memory system with a
predictor attached, that becomes the public understanding.

**Fix direction:**

Reframe the README around:

- the problem is context selection
- storage/retrieval are support layers
- Signet's endgame is learned relevance from agent-in-the-loop signal

---

### P0-2. `docs/WHAT-IS-SIGNET.md` over-centers knowledge architecture

**Problem:**

This file spends a large amount of explanatory surface area on:

- how knowledge is extracted
- entities and the knowledge graph
- search-to-traversal framing

The predictive scorer is presented later as something Signet is
“building toward.” That makes the graph feel like the main event and the
predictor feel optional or secondary.

**Why it matters:**

This is the canonical “what is Signet” explanation doc. It should state
what the system fundamentally is, not merely how one substrate layer
works.

**Fix direction:**

Move to this shape:

1. Signet solves context selection, not just storage
2. Structured memory and graph traversal are substrate
3. The predictor is the convergence point of the architecture
4. The system's goal is ambient, high-precision context injection

---

### P0-3. `docs/QUICKSTART.md` teaches the wrong mental model

**Problems:**

1. The “Why Signet” section gives equal conceptual weight to:
   - distillation
   - knowledge graph
   - predictive scorer
   - retrieval

   This implies the product is a bundle of memory features, rather than a
   system aimed at learned context selection.

2. The line “The agent is not in the loop” is too absolute. It may be
   trying to say explicit remember/recall tool calls are not required,
   but it is misleading given the broader architecture depends on agent
   behavior and session outcomes as relevance signal.

3. The quickstart auth section is factually wrong. It says Signet uses
   ERC-8128 wallet-based signatures for identity verification, while
   `docs/AUTH.md` describes current auth as HMAC token-based.

4. The distillation description says the pipeline can “update something
   existing” or “replace something outdated,” which overstates current
   destructive mutation behavior.

**Fix direction:**

Quickstart should teach:

- Signet's goal is automatic, ambient context selection
- the graph and retrieval layers improve candidate quality
- the predictor is what is supposed to make the system improve over time
- current auth is token-based
- current destructive pipeline behavior is limited and should be described precisely

---

### P0-4. Predictor default status is contradictory across docs and code

**Files involved:**

- `docs/PIPELINE.md`
- `docs/DASHBOARD.md`
- `packages/daemon/src/memory-config.ts`
- `packages/cli/templates/agent.yaml.template`

**Problem:**

The code says the predictor is enabled by default.
The docs say the predictor is disabled by default.

**Code evidence:**

- `packages/daemon/src/memory-config.ts`
  - default config sets `predictor.enabled: true`
- `packages/cli/templates/agent.yaml.template`
  - template sets `predictor.enabled: true`

**Docs evidence:**

- `docs/PIPELINE.md`
  - says predictor disabled by default
- `docs/DASHBOARD.md`
  - says predictor disabled by default

**Fix direction:**

Decide the truth, then sync all of these:

- runtime default
- config template
- pipeline docs
- dashboard docs
- quickstart wording
- README wording

---

### P0-5. Auth docs are internally inconsistent

**Current truth according to reference docs at audit time:**

`docs/AUTH.md` says auth is simple HMAC-signed bearer tokens with roles
and scopes.

**Contradictory claims elsewhere:**

- `docs/QUICKSTART.md` claims current ERC-8128 wallet auth/signatures
- `docs/CONTRIBUTING.md` refers to ERC-8128 wallet-based auth
- `docs/CONFIGURATION.md` says ERC-8128 verification is future/reserved
- `docs/WHAT-IS-SIGNET.md` frames EIP-8004 as a future identity layer
- `docs/ROADMAP.md` frames wallet/EIP identity as next-stage roadmap

**Why it matters:**

This is not a nuance problem. It is a direct contradiction about how the
system authenticates requests today.

**Fix direction:**

Use one model consistently:

- **Current implementation:** token-based auth, HMAC-signed, local/team/hybrid modes
- **Future roadmap:** cryptographic/wallet-based identity, if still desired

Do not describe future auth as current auth.

---

## P1 Findings

### P1-1. Destructive mutation docs are muddy

**Problem:**

Some docs describe the pipeline as if update/delete/replace flows are
available in practice, while other docs clarify they are still blocked or
not implemented in the current implementation.

Examples:

- `docs/QUICKSTART.md` suggests replacement/update behavior in the
  high-level pitch
- `docs/PIPELINE.md` says destructive mutations are recognized but blocked
- `docs/MEMORY.md` explains that update/delete proposals are still not yet applied
- `docs/CONFIGURATION.md` describes `allowUpdateDelete` without enough
  explicit warning that destructive writes remain gated by implementation status

**Fix direction:**

All user-facing docs should say:

- the pipeline can propose destructive actions
- explicit forget/delete flows exist for users/operators
- automatic destructive mutation remains limited / gated / partially implemented

---

### P1-2. Explanation docs overstate “search to traversal” as the key leap

**Problem:**

Files like `docs/WHAT-IS-SIGNET.md` and
`docs/KNOWLEDGE-ARCHITECTURE.md` describe the shift from search to
traversal as if this is the core conceptual breakthrough.

It is not.

Traversal is a retrieval improvement and a useful candidate-shaping
mechanism. It is not the main differentiator.

**Fix direction:**

Reframe traversal as:

- a way to improve the structural quality of candidate context
- a substrate that gives the predictor better material to work with
- not the core product thesis

---

### P1-3. Reference vs explanation boundaries are blurry

**Problem:**

Some explanation docs drift into future architecture, and some reference
docs drift into aspirational framing.

Examples:

- `docs/WHAT-IS-SIGNET.md` mixes current implementation with future identity layers
- `docs/QUICKSTART.md` mixes installed behavior with roadmap-quality claims
- `docs/CONFIGURATION.md` includes future identity references that are not actionable for current config behavior

**Fix direction:**

Apply a harder Diátaxis separation:

- `README.md`, `WHAT-IS-SIGNET.md`, `QUICKSTART.md` explain the product clearly
- `AUTH.md`, `PIPELINE.md`, `CONFIGURATION.md`, `API.md` document only what exists now
- roadmap/spec files carry future design

---

## P2 Findings

### P2-1. Terminology drift around identity standards

The docs currently mention both `ERC-8128` and `EIP-8004` in different
places. Even if both terms came from legitimate planning history, the
current docs surface them as if they describe one coherent live feature.
They do not.

This needs one canonical story:

- what exists now
- what standard, if any, is planned
- where that plan is documented

---

### P2-2. Some docs imply more system maturity than is healthy

This shows up in phrases that read as if the system is already clean,
coherent, and fully self-correcting. The implementation reality is more
conditional.

This is less about honesty theater and more about operator trust. The
docs should reflect where the system still depends on guardrails,
partial implementations, and comparison-based validation.

---

## File-by-File Notes

## `README.md`

**Status:** Needs rewrite

**Problems:**

- still presents graph/storage/retrieval machinery too prominently
- predictor is present but not clearly established as the actual point
- architecture section reads like a feature stack instead of a thesis-led system

**Action:** Rewrite headline explanation around learned context selection.

---

## `docs/WHAT-IS-SIGNET.md`

**Status:** Needs rewrite

**Problems:**

- overweights knowledge graph and traversal framing
- predictor feels like a later add-on instead of architectural destination
- mixes current system description with future identity/trust roadmap

**Action:** Rebuild around “what enters context, when, and why.”

---

## `docs/QUICKSTART.md`

**Status:** Needs rewrite + factual correction

**Problems:**

- teaches the wrong product mental model
- contains current/future auth contradiction
- overstates destructive pipeline behavior
- wording around “agent is not in the loop” is too absolute

**Action:** Rewrite the intro and correct auth + mutation claims.

---

## `docs/AUTH.md`

**Status:** Likely correct anchor

**Problems:**

- not wrong itself, but contradicted by multiple higher-level docs

**Action:** Treat this as source of truth unless auth implementation changes.

---

## `docs/CONFIGURATION.md`

**Status:** Needs sync pass

**Problems:**

- predictor defaults likely out of sync with runtime/docs elsewhere
- identity/auth references blur future and present
- `allowUpdateDelete` should be documented more carefully if destructive pipeline writes remain blocked/partial

**Action:** Sync against runtime defaults and current implementation.

---

## `docs/PIPELINE.md`

**Status:** Mostly strong, but fact sync needed

**Problems:**

- predictor default claim conflicts with runtime defaults/template
- good on destructive mutation nuance, but other docs do not match it

**Action:** Resolve predictor default truth and propagate to other docs.

---

## `docs/DASHBOARD.md`

**Status:** Fact sync needed

**Problems:**

- predictor tab description says disabled by default, contradicting runtime/template

**Action:** Sync to runtime truth.

---

## `docs/ARCHITECTURE.md`

**Status:** Mostly reference-appropriate, but should avoid accidentally becoming positioning copy

**Problems:**

- some traversal-primary language is fine for reference, but should not be copied into high-level explanation docs as the main Signet thesis

**Action:** Keep as technical reference, but ensure explanatory docs do not mirror its emphasis uncritically.

---

## `docs/MEMORY.md`

**Status:** Mostly solid

**Problems:**

- current mutation limitations are explained better here than in higher-level docs
- other docs need to inherit this nuance

**Action:** Use as source material when correcting Quickstart/README.

---

## `docs/KNOWLEDGE-GRAPH.md`

**Status:** Technically fine as reference

**Problems:**

- none major as a graph reference doc
- danger is not in the file itself, but in treating this layer as the product story elsewhere

**Action:** Keep as reference. Do not use as public-facing product framing.

---

## `docs/KNOWLEDGE-ARCHITECTURE.md`

**Status:** Needs reframing or stricter scope definition

**Problems:**

- repeatedly makes traversal and structure feel like the core breakthrough
- the predictor appears as a later optimization over a graph-centric worldview

**Action:** Either explicitly mark this as a substrate doc, or revise the opening sections so they state that the architecture exists to support learned context selection.

---

## `docs/ROADMAP.md`

**Status:** Needs terminology sync

**Problems:**

- identity/auth roadmap terminology should not conflict with current docs
- predictor roadmap language should be consistent with actual defaults/current state

**Action:** Align identity terminology and predictor status notes.

---

## `docs/CONTRIBUTING.md`

**Status:** Factual correction needed

**Problems:**

- current auth description refers to ERC-8128 wallet-based auth, which conflicts with `AUTH.md`

**Action:** Correct to token-based auth unless/until implementation changes.

---

## Recommended Rewrite Order

### Wave 1: Immediate, high-risk

1. `README.md`
2. `docs/WHAT-IS-SIGNET.md`
3. `docs/QUICKSTART.md`
4. `docs/PIPELINE.md`
5. `docs/DASHBOARD.md`
6. `docs/CONTRIBUTING.md`
7. `docs/CONFIGURATION.md`

### Wave 2: Positioning cleanup / substrate clarification

8. `docs/KNOWLEDGE-ARCHITECTURE.md`
9. `docs/ROADMAP.md`
10. market-facing research/positioning docs that reuse the wrong framing

### Wave 3: Consistency sweep

11. grep-based pass for:
    - `ERC-8128`
    - `EIP-8004`
    - `disabled by default`
    - `knowledge graph`
    - `search to traversal`
    - `predictive scorer`
    - `state-space`

---

## Proposed Documentation Rules

Add these as durable process rules after remediation:

1. **No novelty claims at the graph layer.**
   Never position Signet as novel because it structures memory into a
   graph, uses graph traversal, or extracts entities.

2. **High-level docs must lead with context selection.**
   If a user-facing explanation does not clearly say that Signet's aim is
   to learn what context is useful and inject it automatically, it is incomplete.

3. **Reference docs must describe current behavior only.**
   No roadmap features in `AUTH.md`, `PIPELINE.md`, `CONFIGURATION.md`,
   or `API.md` unless clearly marked as future/non-implemented.

4. **Future identity/auth work must be isolated.**
   Keep wallet/EIP/cryptographic identity in roadmap/spec docs until it is real.

5. **Predictor status must be single-source-of-truth.**
   Default state, enablement conditions, cold start behavior, and current
   maturity should be documented once and reused consistently.

---

## Bottom Line

Right now, the docs are better at describing Signet's substrate than
Signet's point.

They explain how Signet stores, structures, and traverses knowledge.
They do not consistently explain that these layers exist to support a
learned context-selection system that improves via agent-in-the-loop
relevance signals.

That is the correction.

Not “less graph.”

More truth about what the graph is for.
