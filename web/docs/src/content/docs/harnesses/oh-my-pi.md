---
title: "Oh My Pi"
description: "Connect Signet to Oh My Pi."
---

## Oh My Pi (`oh-my-pi`)

Oh My Pi uses a managed Signet runtime extension installed by
`@signetai/connector-oh-my-pi`. The extension forwards lifecycle events
to the daemon and injects hidden Signet context into the session when
needed.

### Files managed by Signet

| File | Description |
|------|-------------|
| `PI_CODING_AGENT_DIR/extensions/signet-oh-my-pi.js` | Managed extension bundle when `PI_CODING_AGENT_DIR` is set |
| `~/.omp/agent/extensions/signet-oh-my-pi.js` | Managed extension bundle in the default Oh My Pi agent directory |

### Managed extension

During setup or connect, the connector writes a bundled
`signet-oh-my-pi.js` file into the Oh My Pi extensions directory. If
`PI_CODING_AGENT_DIR` is set, Signet uses that agent directory.
Otherwise it writes to `~/.omp/agent/extensions/`.

The install path is idempotent and only manages `signet-oh-my-pi.js`.
Older Signet-managed `.mjs` installs are removed automatically on the
next setup or sync run.

### Runtime behavior

- Existing unrelated Oh My Pi extensions are left untouched.
- Signet refuses to overwrite a colliding unmanaged `signet-oh-my-pi.js`.
- Daemon or network failures are fail-open, so prompt handling, compaction, session switches, and shutdown continue even if Signet is unavailable.
- The extension persists hidden session-context and recall injections through `before_agent_start`, marks them with `attribution: "agent"`, and keeps them out of transcript reconstruction so memory-backed answers remain attributable without consuming user-attributed Copilot requests.
- It does not currently add `/remember` or `/recall` tools, and it does not sync `AGENTS.md` into Oh My Pi.

### Supported hooks

| Hook | Supported |
|------|-----------|
| session-start | yes |
| user-prompt-submit | yes |
| pre-compaction | yes |
| compaction-complete | yes |
| session-end | yes |

---
