---
title: "Marketplace Official Skills Featuring"
id: marketplace-official-skills
status: planning
informed_by:
  - docs/research/technical/RESEARCH-MARKETPLACE-OFFICIAL-SKILLS.md
section: "Marketplace"
depends_on:
  - procedural-memory-plan
success_criteria:
  - "Dashboard marketplace browse view shows a dedicated featured section for official Signet skills when users are exploring the skills catalog"
  - "Marketplace filter controls can explicitly narrow the skills catalog to the Signet provider"
  - "Featured official skills do not render as duplicate cards again in the same initial catalog viewport"
scope_boundary: "Dashboard marketplace discoverability for official Signet skills. Does not change marketplace publishing, install protocols, or external registry ranking logic."
draft_quality: "implementation-ready stub"
---

# Marketplace Official Skills Featuring

## Problem Statement

Signet already ships and catalogs official skills, but the marketplace
experience does not clearly present them as first-party capabilities.
They appear inside the broader catalog, yet the embedded marketplace
filter controls cannot explicitly switch to the `signet` provider, and
there is no dedicated featured section that makes the official starting
point obvious.

The result is a weak first-run experience. Users can browse the catalog,
but they are not clearly shown, "here are the official skills Signet
ships and stands behind."

## Goals

1. Feature official Signet skills prominently in the marketplace browse
   experience.
2. Preserve the broader community catalog instead of replacing it.
3. Keep official featured cards aligned with existing install/detail
   flows and existing daemon catalog metadata.
4. Prevent duplicate rendering of featured skills in the initial browse
   layout.

## Proposed Capability Set

### A. Featured official strip

When the marketplace is in skills browse mode and no active search is
running, the dashboard renders a dedicated featured section above the
main grid. The section sources its entries from catalog items where:

- `provider = 'signet'`, or
- `official = true`

Ordering contract:

1. built-in official skills first
2. within the built-in and non-built-in groups, prefer explicit featured or usage signals when present
3. fall back to existing popularity score
4. stable name tie-break

The section is capped to a small number of cards so it stays curated and
scan-friendly.

### B. Provider filter parity

Any marketplace-owned provider selector that proxies the shared skills
browser must expose `signet` alongside `skills.sh` and `clawhub`.

### C. No duplicate cards in the initial browse viewport

If an item is shown in the featured official strip, the same browse
payload should not immediately repeat that card again in the primary
catalog grid beneath it.

## Non-Goals

- New daemon endpoints or catalog schema changes
- Marketplace publishing workflow changes
- Community ranking changes
- Review, trust, or package-signing changes

## Integration Contracts

- **Procedural Memory**: uses the existing skills browse/search catalog
  surfaces and official metadata already emitted by the skills routes.
- **Git Marketplace Monorepo**: complementary. This spec improves local
  dashboard discoverability and does not define remote registry
  publishing.
- **Dashboard IA Refactor**: if the marketplace layout changes later,
  the official featured contract still holds as a browse-surface
  requirement.

## Validation and Tests

- Add a focused test for featured-skill partitioning and ordering.
- Verify the embedded marketplace provider selector can choose
  `Signet`.
- Verify the browse grid hides featured items from the immediate main
  grid list.
