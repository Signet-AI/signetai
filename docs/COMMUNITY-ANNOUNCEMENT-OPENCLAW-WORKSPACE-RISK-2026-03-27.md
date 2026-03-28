# Community Announcement: Critical OpenClaw Workspace Risk

OpenClaw uninstall can delete your configured agent workspace.

If your OpenClaw workspace points to your Signet `.agents` directory, an
uninstall may remove:

- Signet identity files
- memory database and session history
- local git history

If you do not have a remote repository or external backup, recovery may be
impossible.

## What to do right now

Before uninstalling OpenClaw:

1. Configure `origin` on your Signet workspace git repo (private repo
   recommended), or
2. Create a full backup of your workspace outside that directory.

## What we are shipping now

Immediate hardening is being added to setup and diagnostics:

- setup soft-gates unprotected OpenClaw-linked workspaces
- setup supports local snapshot backup creation
- status/doctor flags warn when workspace is unprotected

Until upstream uninstall behavior is changed, treat this as critical data-loss
risk.
