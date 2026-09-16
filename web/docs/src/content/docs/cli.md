---
title: "CLI reference"
description: "The registered Signet command tree and automation contract."
---

Use `signet --help` for the installed build. This reference follows the command registrations in `surfaces/cli`; compatibility and implementation-status notes are not working instructions.

- [Setup and workspace](/cli/getting-started/): `install`, `setup`, `workspace`, `configure` (`config`), `status`, `doctor`, `dashboard` (`ui`), `sync`.
- [Memory and search](/cli/memory-search/): `remember`, `recall`, `session search`, `bypass`.
- [Runtime](/cli/operations/): `daemon`, `update`, `route` (`inference`), `mcp`, `desktop`, `browse`.
- [Data and imports](/cli/data-portability/): `export`, `import`, `sources`, `embed`, `migrate-schema`, `migrate-vectors`, `repair`.
- [Integrations and security](/cli/integrations-security/): `secret`, `api-key`, connectors, hooks, Git, skills.
- [Knowledge and agents](/cli/knowledge-agents/): `agent`, `knowledge`, `ontology`, `dream`, `context`.
- [Developer diagnostics](/cli/profiling/): profiling, [environment and exit codes](/cli/environment/).

Run `signet <group> --help` for release-specific flags. Exact aliases include `config`, `ui`, `op`, `bw`, `inference`, and `skill remove`.