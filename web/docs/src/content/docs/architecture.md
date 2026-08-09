---
title: "Architecture"
description: "Full technical architecture documentation."
---

Full technical architecture documentation.

Technical reference for the Signet [Daemon](/daemon/) and supporting packages.
This document covers the full system — from package boundaries through
database schema — with enough detail to reason about correctness,
performance, and failure modes.

This is a substrate document. It explains how Signet stores, structures,
and routes memory today. It should not be read as a claim that the graph
or retrieval stack is the product by itself. Those layers exist to
support bounded, high-quality context selection.

---

## In this section

- [Packages and data flow](/architecture/packages-data-flow/)
  Repository package boundaries and Signet end-to-end data flow.
- [Pipeline and storage](/architecture/pipeline-storage/)
  Pipeline, queue, graph, document, and database architecture.
- [Platform services](/architecture/platform-services/)
  Authentication, analytics, connectors, diagnostics, and repair architecture.
- [Data lifecycle](/architecture/data-lifecycle/)
  Normalization, projection, retention, and user-data layout.
- [Interfaces and agents](/architecture/interfaces-agents/)
  HTTP interfaces, key implementation files, and multi-agent support.
