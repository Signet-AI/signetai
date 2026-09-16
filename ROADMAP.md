# Roadmap

This page describes direction, not a release contract. Current behavior belongs in the product and reference documentation; an item here is not shipped merely because it is named.

Current priorities
------------------

- Reliability and operability: keep the daemon, retention, diagnostics, repair, and lifecycle boundaries observable and safe.
- Product clarity: improve the dashboard, desktop workflows, onboarding, and source inspection without turning the dashboard into a second runtime.
- One evidence-to-ontology path: keep episodic evidence distinct from derived indexes and current structured knowledge; Dreaming remains the only automatic semantic writer.
- Retrieval quality: continue measuring bounded recall, provenance, authorization, and context selection against reproducible evaluations.

Longer-term directions
----------------------

- Better cross-device and team workflows while preserving local ownership and explicit access control.
- More source connectors and better inspection of evidence lineage.
- Stronger workflow support around current knowledge, reviewable ontology maintenance, and agent continuity.

These directions may change. They should not be cited as evidence that an interface, source type, policy, or automation is available today.

Recently established architecture
---------------------------------

The current daemon has one canonical state layer: user-owned workspace artifacts plus agent-scoped SQLite rows. Derived indexes and projections support that state but do not replace it. Dreaming owns automatic semantic writes; document ingestion, retention, maintenance, synthesis/projection, and optional hints remain separate non-semantic services.
