---
title: "Marketplace Official Skills Featuring"
question: "How should the dashboard marketplace spotlight Signet official skills without hiding the broader community catalog?"
date: "2026-03-30"
status: "complete"
---

# Marketplace official skills featuring

## What this research answers

This note captures the current marketplace behavior and the smallest
product contract needed to make Signet's official skills feel like a
first-party offering instead of just another provider in the list.

## Current state

1. The daemon already exposes Signet-maintained skills through the
   `/api/skills/browse` and `/api/skills/search` endpoints with
   `provider = "signet"`, `official = true`, and optional `builtin`
   metadata.
2. The browse API already de-duplicates by skill name so official
   Signet skills win over duplicate third-party entries.
3. The dashboard marketplace embeds the shared skills browser, but the
   marketplace-specific provider filter omits the `signet` provider.
   That means official skills exist in the catalog but cannot be
   explicitly filtered from the main marketplace rail.
4. The current browse grid treats official skills the same as every
   other result. They may sort near the top, but there is no clear
   first-party featured section.

## Product direction

The marketplace should do two things simultaneously:

1. Preserve the open catalog. Signet official skills should be featured,
   not turned into a walled garden.
2. Make the first-party path obvious. Official skills need a dedicated,
   high-visibility section in the browse experience plus an explicit
   Signet provider filter in the marketplace rail.

## Recommended contract

- Add a dedicated featured strip for official Signet skills at the top
  of the browse view when the user is not actively searching.
- Cap the featured strip so it highlights a handful of curated skills,
  with built-in skills ordered first, then usage-aware ordering
  inside the built-in and non-built-in groups, with popularity as the
  fallback.
- Keep the main catalog below the strip and remove duplicate cards so
  featured entries are not shown twice in the same viewport.
- Expose `Signet` as a provider filter anywhere the marketplace embeds
  skills browsing controls.
- Preserve existing install and detail flows. This is a presentation and
  discoverability change, not a backend distribution change.
