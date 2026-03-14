# Signet OS — Master Spec

**Status:** Draft — awaiting Oogie review sign-off  
**Branch:** `feature/signet-os`  
**Authors:** Buba (CDP/browser layer) + Oogie (dashboard/core layer)  
**Based on:** main @ v0.58.1

---

## Overview

Signet OS adds three interlocking systems to Signet:

1. **Signet Browser** — CDP-powered, agent-intercepted browser layer
2. **MCP App Dashboard** — drag-and-drop widget grid, auto-assembled from installed MCPs
3. **Ambient Awareness Layer** — pub/sub event bus connecting browser + widgets + agent

Plus a fourth system that ships after the core three:

4. **Identity + Teams** — orgs, RBAC, SSO

Each system ships independently and builds on the last.

---

## System 1: Signet Browser

### Architecture

CDP-first. Attaches to the existing Signet-managed Chrome instance via CDP on startup. No new browser process, no root CA installs, no cert pinning problems.

MITM proxy is a future v2 addon for non-Chrome users only. Not part of this spec.

### CLI Interface (Buba owns)

```bash
signet browse "find cheapest flight to NYC this weekend"  # agent pilots
signet browse navigate <url>                              # direct nav
signet browse extract "all pricing tiers"                 # structured pull from current tab
signet browse watch                                       # stream page events to agent
```

### Modes

- `--passive` (default) — agent reads, observes, surfaces context. never clicks
- `--active` — agent drives. user watches. interrupt anytime with Ctrl+C

### Dashboard Panel (Buba builds component, Oogie embeds)

Left pane: agent chat  
Right pane: CDP webview rendering the real Chrome tab — NOT an iframe. Sidesteps X-Frame-Options entirely.

This is the Arc sidebar UX: the sidebar IS the agent.

---

## System 2: MCP App Dashboard

### Manifest Format (SPEC FIRST — nothing gets built until this is locked)

MCP servers declare their Signet OS app via a `signet` block. Optional — servers without it get auto-generated fallback cards.

```json
{
  "signet": {
    "name": "GHL CRM",
    "icon": "crm.svg",
    "ui": "http://localhost:3461",
    "defaultSize": { "w": 6, "h": 4 },
    "events": {
      "subscribe": ["browser.navigate", "browser.login"],
      "emit": ["contact.created", "deal.moved"]
    },
    "menuItems": ["New Contact", "Pipeline View", "Open Deal"],
    "dock": true
  }
}
```

#### Manifest Field Reference

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Display name |
| `icon` | string | no | Icon path or URL. Inferred from server metadata if absent |
| `ui` | string | no | URL of the widget UI. Auto-card rendered if absent |
| `defaultSize` | `{w, h}` | no | Grid units. Default: `{w: 4, h: 3}` |
| `events.subscribe` | string[] | no | Browser/system events this app wants to receive |
| `events.emit` | string[] | no | Events this app produces (for documentation) |
| `menuItems` | string[] | no | Items added to the Signet OS menu bar under this app's name |
| `dock` | boolean | no | Pin to dock on install. Default: false |

### Auto-Card Fallback

If no `signet.ui` is present, Signet auto-renders a card:
- Name + inferred icon
- Each `list_tools()` result as a clickable button
- Each button calls the tool with an inline arg form

Every MCP gets dashboard presence on install. Zero effort required from MCP authors.

### Auto-Discovery on Install (Oogie owns)

When a user installs an MCP server:
1. Signet calls `list_tools()`, `list_resources()`, checks for `app://` resources (MCP Apps SDK)
2. If `signet` block found in server metadata → use it
3. If not → generate auto-card from tool list
4. Widget drops into the **App Tray** (bottom dock) — available but not placed on grid

### Dashboard Grid (Oogie owns)

React Grid Layout (same engine as Grafana). Battle-tested for this exact use case.

Each widget = sandboxed iframe served by the MCP server's `ui` URL.

Layout serializes to `~/.agents/dashboard.json`:

```json
{
  "version": 1,
  "grid": [
    { "id": "ghl-crm", "x": 0, "y": 0, "w": 6, "h": 4 },
    { "id": "remix-sniper", "x": 6, "y": 0, "w": 6, "h": 4 }
  ],
  "sidebarGroups": [
    { "name": "Work", "items": ["ghl-crm", "calendar"] },
    { "name": "Finance", "items": ["polymarket", "remix-sniper"] },
    { "name": "Music", "items": ["remix-sniper"] }
  ],
  "dock": ["ghl-crm", "remix-sniper"]
}
```

### Three-Layer Nav (Oogie owns)

- **Dock** — pinned apps, always visible at bottom
- **App Drawer** — all installed MCPs, searchable, drag onto grid to place
- **Sidebar Groups** — user-created folders that become left nav items (Notion sidebar pattern)

### "Add New" Button

Button UI lives in the dashboard (Oogie). On click:
- Opens ClawdHub browser inline
- User selects MCP to install
- Dashboard calls `signet.installMCP(url)` (Buba implements this function)
- Widget appears in App Tray immediately on success

### `signet.installMCP()` Interface

```typescript
interface InstallMCPOptions {
  url: string;           // ClawdHub URL or direct MCP server URL
  name?: string;         // Override display name
  autoPlace?: boolean;   // Auto-place on grid at next open slot (default: false)
}

interface InstallMCPResult {
  ok: boolean;
  widgetId: string;
  manifest: SignetAppManifest | null;  // null = auto-card fallback
  error?: string;
}

function installMCP(options: InstallMCPOptions): Promise<InstallMCPResult>
```

---

## System 3: Ambient Awareness Layer

**This is the thing that makes it an OS and not a dashboard.**

Every widget, every browser tab, every MCP event feeds into a shared agent context stream. The agent holds a rolling 5-minute window of what's happening across all active surfaces:

```
[16:31] GHL: deal moved → Closing (Jake just updated)
[16:31] Browser: navigated to linkedin.com/in/robert-hartline
[16:32] Polymarket: IRAN contract spiked +12%
[16:32] Remix Sniper: 3 new hits (87+ score)
```

Agent sees all four simultaneously. Can surface: *"Robert Hartline's LinkedIn is open — want me to pull his company into the GHL deal you just moved?"*

### Event Bus Architecture (Oogie owns bus, Buba emits browser events)

Start with Node EventEmitter. Swap to Redis when multi-device sync is needed.

#### Event Envelope

```typescript
interface SignetOSEvent {
  id: string;           // uuid
  source: string;       // "browser" | "mcp:<widgetId>" | "system"
  type: string;         // event type (see below)
  timestamp: number;    // unix ms — on EVERYTHING, always
  payload: Record<string, unknown>;
}
```

#### Browser Events (Buba emits these)

```typescript
// page navigation
{ type: "browser.navigate", payload: { url: string, title: string, tabId: string, timestamp: number } }

// form detected on page
{ type: "browser.form",     payload: { fields: string[], action: string, tabId: string, timestamp: number } }

// DOM changed meaningfully (throttled — see note)
{ type: "browser.dom.change", payload: { diff: string, tabId: string, timestamp: number } }

// agent extracted structured data from page
{ type: "browser.extract",  payload: { data: unknown, source: string, tabId: string, timestamp: number } }

// checkout page detected
{ type: "browser.checkout", payload: { items?: string[], total?: number, tabId: string, timestamp: number } }

// login page detected
{ type: "browser.login",    payload: { domain: string, tabId: string, timestamp: number } }
```

#### Open Questions for Oogie's Review

1. **CDP attach strategy — lazy vs eager?**  
   Lazy: attach when `signet browse` is first called. Eager: attach on Signet startup.  
   Recommendation: eager, so browser events stream from the moment Signet starts.

2. **`browser.dom.change` throttle**  
   DOM changes can be extremely noisy. Suggested: throttle to max 1 event per 2 seconds per tab, only emit if diff is above a token threshold (e.g., >100 chars changed).

3. **`installMCP` error handling when server unreachable at probe time**  
   Options: (a) fail install, (b) install with auto-card only and re-probe when server comes online, (c) let user choose.  
   Recommendation: (b) — install with auto-card, show "reconnecting" state, auto-upgrade to rich UI when server appears.

---

## System 4: Identity + Teams (Phase 4, ships after Systems 1-3)

### Single-User First

Formalize the existing `~/.agents/agent.yaml` identity. Add WebAuthn/passkey local auth.

### Orgs

```yaml
# ~/.agents/orgs/localbosses.yaml
name: LocalBosses
members:
  - id: usr_jake_shore
    role: owner
  - id: usr_dylan_das
    role: contributor
shared:
  memory_namespace: org:localbosses
  mcps: [ghl-crm, polymarket-bot]
  dashboard_template: localbosses-default
```

### RBAC

| Role | Access |
|---|---|
| owner | everything |
| admin | all tools + manage members |
| member | tools + memory, no secrets |
| viewer | read-only dashboard |

### SSO

WorkOS SDK (the actual company) for Google SSO, SAML, enterprise IdP. Logto as open-source alternative. Signet wraps either thin.

### Monetization

- Free: single user
- Team: $X/seat/month — shared memory + MCPs + dashboard
- Enterprise: custom SSO + SLA + dedicated instance

---

## Build Order

Phases 1a and 1b are parallelizable.

| Phase | Owner | Deliverable | Effort |
|---|---|---|---|
| 0 | Both | This spec — locked and signed off | Done |
| 1a | Buba | `signet browse` CLI — CDP attach, navigate, extract, watch, passive/active modes | ~3 days |
| 1b | Oogie | MCP auto-probe on install + App Tray + manifest parsing | ~3 days |
| 2 | Oogie | Dashboard grid — React Grid Layout, drag-to-place, sidebar groups, dock | ~1 week |
| 3 | Buba | CDP events → event bus (all 6 browser event types per spec) | ~2 days |
| 4 | Buba | CDP webview panel component (Oogie embeds in dashboard) | ~2 days |
| 5 | Oogie | Event bus — EventEmitter, context assembler, agent rolling window | ~3 days |
| 6 | Oogie | Menu bar — MCP `menuItems` assembled on startup | ~2 days |
| 7 | Buba | `signet.installMCP()` function (Oogie's UI calls this) | ~1 day |
| 8 | Oogie | "Add New" → ClawdHub inline install (calls Buba's installMCP) | ~2 days |
| 9 | Both | Integration — browser panel embedded in dashboard, event bus wired end-to-end | ~2 days |
| 10 | Oogie | Identity layer — passkey + org/workspace + RBAC | ~1 week |
| 11 | Oogie | SSO — WorkOS SDK integration | ~1 week |

**Total: ~6-7 weeks** if phases 1a and 1b run in parallel.

---

## Review Sign-Off

- [ ] Oogie: approve manifest schema, event payload shapes, open questions answered
- [ ] Jake: approve overall direction before phase 1a/1b start
- [ ] Nicholai: awareness/buy-in (this touches Signet core — he should know)

Once all three boxes are checked, phases 1a and 1b start simultaneously.
