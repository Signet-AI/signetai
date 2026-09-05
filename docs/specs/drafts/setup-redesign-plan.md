---
title: "Setup and Onboarding"
id: setup-redesign-plan
status: draft
section: "CLI"
depends_on:
  - "portable-remote-connectors"
success_criteria:
  - "Interactive setup opens one guided dashboard modal"
  - "Existing daemon operations own connection, source import, and memory transitions"
  - "Headless plans remain validated and non-interactive"
scope_boundary: "Onboarding presentation and CLI bootstrap; no new memory or source executor"
---

# Setup and onboarding

The grouped terminal wizard proposal is superseded by the accepted modal flow.
The public behavior is maintained in [Set up Signet](../../../web/docs/src/content/docs/getting-started/setup.md).

Interactive CLI setup bootstraps the workspace and opens `/#setup`. It does not
collect a second configuration plan or run OAuth. The modal progresses through
welcome, agents, connection, optional sources, first memory, and readiness.

Sources reuse the existing connection/import form and daemon jobs. A registered
source or accepted upload is distinct from completed indexing and semantic work.
The user can continue while imports run and inspect or cancel them in Sources.

Headless `SetupPlan` remains the schema for existing CLI automation. It is not
an API contract for the modal. The retired `extractionConnect` field must fail
explicitly rather than revive terminal OAuth. Existing config is preserved until
an explicit dashboard action or non-interactive flag changes it.

A UI checkpoint is never runtime readiness. Configuration writes must complete
before a model test, and the test must succeed before enabling processing. The
first-memory check must retrieve the saved ID under the resolved agent scope.
Agent integration installation must finish and release its worker before success.
