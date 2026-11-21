# Workspace layout and storage

## The persisted layout version decides paths

Readers and writers resolve storage paths from the persisted workspace layout version. They never infer the layout from which directories exist. Custom database, transcript, runtime, cache, inbox, import, secret, skills, and data paths always win. An unknown or newer version fails closed.

Why: directory existence is ambiguous during upgrades and after partial copies, and guessing can point two layouts at the same data.

Owner: `platform/core/src/workspace-layout.ts`.

## Layout upgrades are journaled by identity

Before the first rename, the daemon records the planned moves and each source item's filesystem identity in `.workspace-layout-upgrade.json`. `.daemon/` moves last. After an interruption, an already-moved item is accepted only when its destination matches the recorded identity, and layout v2 is written only after no v1 storage path remains. If a journal lacks enough identity to verify a completed move, the daemon stays on v1 and refuses to start rather than guess; the journal lists the planned moves for manual recovery.

Owner: `platform/daemon/src/workspace/layout-upgrade.ts`.

## Existing secret stores stay valid

Existing `$SIGNET_WORKSPACE/.secrets/secrets.enc` files must keep working without migration, re-encryption, relocation, or user action.

Why: a failed secret migration locks users out of credentials that Signet cannot regenerate.

Owner: `platform/daemon/src/secrets/secrets.ts`.
