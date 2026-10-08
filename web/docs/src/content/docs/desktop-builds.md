---
title: "Desktop builds"
description: "Build and install the Signet desktop app from source."
---

Most people should install the desktop app from a release. Build it from source when you are developing Signet or testing an unreleased change.

```bash
signet desktop build
signet desktop install
```

## Requirements

Source builds need Bun 1.4.2 or newer. Before syncing source or installing dependencies, `signet desktop build` and `signet desktop install` check the installed Bun version.

- In an interactive terminal, an older version prompts you to run `bun upgrade --stable`. Declining stops the command. The version is checked again after upgrading.
- If you installed Bun with a package manager, decline and upgrade through that package manager.
- In a non-interactive terminal, upgrade Bun manually before retrying.
- `--skip-build` installs an existing artifact and does not need Bun.

## Source checkout

Setup, `signet workspace set`, and the workspace layout upgrade do not clone the Signet repository. Saving and recalling memories use the installed application. `signet sync` and application updates maintain an existing workspace checkout but do not create one.

`signet desktop build` and `signet desktop install` create a managed checkout at `<workspace>/signetai` when one is needed.

- Generated build output does not block updates to the managed default-branch checkout.
- Real local changes on that checkout are saved in a named Git stash when an update is needed. They stay stashed after success, and the command prints the stash name and the restore command.
- If the checkout is already current, local changes stay in place.
- Other branches and unresolved merge conflicts stop the managed update and are left untouched.
- If the managed checkout was removed, rerun `signet desktop install` to restore it before the next automatic desktop update.

To build from your own clone instead, pass `--repo <path>` or set `SIGNET_SOURCE_DIR`. Either one uses that checkout as it is, without managed synchronization.

`--skip-build` also skips synchronization. It neither creates nor updates the managed checkout, so it needs an existing one: the managed path, `--repo`, `SIGNET_SOURCE_DIR`, or a Signet checkout containing the current directory.

## Install locations

| Platform | Location |
|---|---|
| macOS | `~/Applications/Signet.app` |
| Windows | `%LOCALAPPDATA%\Programs\Signet Desktop` |
| Linux | A user AppImage launcher |

On Windows, the install also runs the uninstaller for the legacy `%LOCALAPPDATA%\Programs\@signetdesktop` app. It keeps the desktop profile and any unrelated files in that directory, and points the Signet Start Menu shortcut at the current executable.

These locations are separate from the native CLI installation.
