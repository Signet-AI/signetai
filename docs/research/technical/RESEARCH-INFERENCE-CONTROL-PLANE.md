---
title: "Inference Control Plane Research"
question: "How should Signet centralize model routing across heterogeneous harnesses and provider backends without giving up privacy controls, per-agent policy, or local-first execution?"
last_updated: 2026-04-09
---

# Inference Control Plane Research

## Summary

Signet currently owns memory, identity, secrets, and daemon APIs, but it does
not own inference routing. OpenClaw, Hermes, OpenCode, Pi, and daemon-side
workloads each make their own model decisions. That fragments policy,
observability, privacy controls, and fallback behavior.

The practical operator need is not "pick one provider." It is:

- one agent preferring a Claude subscription-backed account,
- another agent preferring GPT 5.4,
- sensitive work forced to local inference,
- extraction/synthesis sharing the same routing rules,
- and harnesses treating Signet as the inference authority instead of owning
  their own routing stacks.

## Findings

1. A compatibility gateway is necessary, because not every harness can adopt a
   rich native RPC immediately.
2. A richer native RPC is also necessary, because compatibility APIs do not
   carry enough policy context for subtask-aware routing.
3. Privacy tier must be a hard deny gate, not a soft ranking input.
4. Subscription-backed sessions and CLI-authenticated tools must be modeled as
   first-class accounts, not as "just another API key."
5. The daemon is the right control-plane owner because it already owns agent
   config, secrets, auth, observability, and long-lived runtime state.

## Prior art and Signet implications

### Competitive systems

`RESEARCH-COMPETITIVE-SYSTEMS` already identified "smart model routing" as a
meaningful gap in Signet's current architecture. The important lesson is not
just cheap-vs-strong routing, but that routing becomes more valuable when it is
policy-aware and workload-aware.

### Runtime architecture

`signet-runtime` established that external harnesses should be thin adapters over
one daemon-owned contract. Extending that principle to inference means harnesses
should ask Signet for execution decisions, not privately choose models.

### Local-first privacy

Signet's broader architecture repeatedly treats privacy and local ownership as
first-class constraints. That argues against a router that merely optimizes for
latency or cost. Sensitive work needs an enforceable local-only path.

## Research conclusion

Signet should become an inference control plane with two surfaces:

- an OpenAI-compatible gateway for compatibility,
- a Signet-native inference RPC for first-party integrations.

The daemon should own:

- provider/account/session registry,
- policy evaluation,
- route explanation and telemetry,
- and execution wherever the harness can delegate it.

That routing layer should also front daemon-internal workloads such as memory
extraction and session synthesis so policy lives in one place.
