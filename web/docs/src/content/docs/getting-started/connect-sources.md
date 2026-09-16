---
title: "Connect sources"
description: "Choose a source connection or import local documents into Signet."
---

Use Sources in the dashboard when you want Signet to index context beyond explicit memories. Choose the path that matches where the material lives:

- **Connect a source** when another system remains canonical, such as an Obsidian vault, GitHub repository, or Discord guild.
- **Import files** when you want Signet to create a durable, read-only source artifact from local documents.

Both paths preserve provenance. Signet indexes source-owned artifacts for retrieval and does not write back to connected sources.

## Open Sources

Start the daemon and open the dashboard:

```bash
signet daemon start
signet dashboard
```

Choose **Sources**, then select **Connect a source** or **Import files**.

## Connect a source

1. Choose **Connect a source**.
2. Select the connector.
3. Enter its configuration, using a secret name or reference where requested.
4. Choose **Connect & index**.
5. Monitor the source card until indexing finishes or reports an error.

The current dashboard supports Obsidian, GitHub, and Discord. Obsidian uses an absolute vault path. GitHub uses `owner/repo` and can accept a token reference for protected resources. Discord uses a guild ID and a token reference. The [Sources reference](/sources/) documents connector options and the [Documents and sources API](/api/documents-sources/) documents programmatic access.

## Import files

1. Choose **Import files**.
2. Select one or more files through the browser, or choose files from the local desktop picker.
3. Choose the duplicate policy.
4. Select **Import & index**.
5. Review the per-file results and source card.

The browser upload works with a remote dashboard. The desktop picker reads paths on the daemon's machine, so use browser upload when the daemon is remote. Supported formats and size limits are listed in the [Sources reference](/sources/).

## Read the result

A source card shows indexing progress, counts, health, errors, and the latest index time. After indexing, source-backed material is available to recall with the normal `signet recall` command.

Use **Re-index** to queue a fresh run or **Remove** to remove Signet's source configuration and derived artifacts. Removing a source does not modify the original files. For endpoint-level diagnostics, see the [HTTP API reference](/api/documents-sources/).
