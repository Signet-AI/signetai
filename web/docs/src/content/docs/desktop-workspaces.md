---
title: "Desktop workspaces"
description: "Switch between personal local memory and an organization instance."
---

Signet Desktop opens your local workspace by default. Local mode does not require an account or a browser sign-in, and keeps its existing daemon and tray controls.

## Connect to your organization

1. Open the Signet tray menu and choose **Workspaces…**.
2. Select **Organization**, enter your instance's HTTPS URL, and choose **Use workspace**. The app reopens in organization mode. HTTP is accepted only for a loopback instance used for development.
3. Choose **Sign in through your browser**. Check that the code on the workspace screen matches the code in your system browser, then approve the device.
4. Return to Signet and choose **Open organization dashboard**.

Organization mode never starts a local daemon. Requests go to the selected instance through the desktop main process. Neither the access token nor the refresh credential is exposed to the dashboard renderer. Your organization instance must run in `team` mode; hybrid loopback trust is not an organization security boundary.

The app remembers the workspace selection, not credentials, in its desktop profile. The SDK stores the shared login in the OS keychain under service `signet-login` and account equal to the instance origin. If the keychain is unavailable, the SDK uses its protected login-file fallback. Desktop and `signet login` use the same entry: signing in or signing out in either surface affects both. Connector keys have their own revocation lifecycle.

The `signet://auth/complete` link only focuses the desktop app. It cannot contain a token, authorization code, query, or fragment. Signet polls the instance to complete the approved device flow; the deep link does not authenticate you.

## Session status

The workspace screen shows your organization name and session expiration time, including the time zone. When you are signed in, **Open organization dashboard** is the primary action and **Sign out** is secondary. Signed-out workspaces show browser sign-in instead.

Signed out, waiting for approval, expired or revoked, unreachable, and not permitted (403) states share the same status panel. A 403 names the missing requirement when the instance provides one; it is not an empty result. Choose **Retry connection** after restoring connectivity or access, or **Sign in again** for an expired session. A remembered expiration time is labeled **Last session expiry** when it is no longer a live session confirmation. A network failure never silently switches to local mode.

Choose **Sign out** to revoke the session and remove the shared CLI/desktop login. If the instance cannot confirm revocation, sign-out reports failure and retains the login so you can retry. If an administrator has already revoked or expired the session, sign in again to establish a new one.

## Return to local memory

Open **Workspaces…**, select **Local**, and choose **Use workspace**. The app reopens on your personal local dashboard. This does not copy organization memory into your local workspace, or sign you out of the organization.
