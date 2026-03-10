# @signet/connector-ghl

Connect your GoHighLevel account to Signet. On first OAuth connect, your agent is bootstrapped with full account context: every pipeline, workflow, tag, calendar, funnel, contact count, and user — ingested into Signet memory so the agent can navigate, manage, and improve your GHL account immediately.

## What It Does

1. **OAuth Connect** — user clicks "Connect GHL", approves in GHL, gets redirected back
2. **Entity Discovery** — full X-Ray of the location: pipelines, workflows, contacts, tags, calendars, funnels, custom fields, users, opportunities
3. **Gap Analysis** — detects structural gaps (missing workflows, empty pipelines, inactive calendars) with auto-fixable and human-review buckets
4. **Memory Ingestion** — writes ~50-100 structured Signet memories so the agent wakes up knowing the account
5. **Health Score** — 0-100 score based on account completeness
6. **Re-Sync** — call `/api/ghl/accounts/:id/sync` to refresh (runs on a 24h schedule automatically)

## Setup

### 1. Create a GHL Marketplace App

1. Go to [marketplace.gohighlevel.com](https://marketplace.gohighlevel.com)
2. Create a new app (or use an existing private integration)
3. Set redirect URI to: `http://localhost:3850/api/ghl/callback`
4. Enable these scopes:
   - `contacts.readonly` + `contacts.write`
   - `opportunities.readonly` + `opportunities.write`
   - `workflows.readonly`
   - `locations/tags.readonly` + `locations/tags.write`
   - `calendars.readonly`
   - `funnels.readonly`
   - `users.readonly`
   - `businesses.readonly`
   - `locations.readonly`

### 2. Set Environment Variables

```bash
export GHL_CLIENT_ID="your-client-id"
export GHL_CLIENT_SECRET="your-client-secret"
# Optional — defaults to http://localhost:3850/api/ghl/callback
export GHL_REDIRECT_URI="http://localhost:3850/api/ghl/callback"
```

Or store via Signet secrets:
```bash
signet secret put GHL_CLIENT_ID
signet secret put GHL_CLIENT_SECRET
```

### 3. Connect

Open your browser and visit:
```
http://localhost:3850/api/ghl/connect
```

You'll be redirected to GHL's OAuth consent screen. After approving, you'll be sent back to Signet which will run the full bootstrap and show you a success page with the health score.

## API Endpoints (provided by daemon)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/ghl/config` | Check if GHL OAuth is configured |
| `GET` | `/api/ghl/connect` | Start OAuth flow (redirect to GHL) |
| `GET` | `/api/ghl/callback` | OAuth callback (auto-called by GHL) |
| `GET` | `/api/ghl/accounts` | List connected accounts |
| `GET` | `/api/ghl/accounts/:id` | Account details + gap analysis |
| `POST` | `/api/ghl/accounts/:id/sync` | Re-run discovery + re-ingest |
| `POST` | `/api/ghl/accounts/:id/fix` | Execute auto-fixable gaps |
| `DELETE` | `/api/ghl/accounts/:id` | Disconnect account |

## Programmatic Usage

```typescript
import { GHLConnector, REQUIRED_SCOPES } from '@signet/connector-ghl';

const connector = new GHLConnector({
  oauth: {
    clientId: process.env.GHL_CLIENT_ID!,
    clientSecret: process.env.GHL_CLIENT_SECRET!,
    redirectUri: 'http://localhost:3850/api/ghl/callback',
    scopes: [...REQUIRED_SCOPES],
  },
});

// Start OAuth (get URL, redirect user)
const authUrl = connector.getAuthorizationUrl();

// Handle callback (called from your route handler)
const account = await connector.handleCallback(code, {
  onProgress: console.log,
  runGapAnalysis: true,
});

console.log(`${account.locationName} — health: ${account.healthScore}/100`);
console.log(`Gaps: ${account.gapAnalysis?.totalGaps} total`);
```

## Memory Schema

After bootstrap, the agent has these memory types:

| Type | Count | Description |
|------|-------|-------------|
| `ghl_account_overview` | 1 | Full account summary (critical, pinned) |
| `ghl_pipeline` | N | One per pipeline with stages + stats |
| `ghl_workflows_published` | 1 | Batch of all published workflows |
| `ghl_workflows_draft` | 1 | Batch of all draft/archived workflows |
| `ghl_tags` | N | Tags in batches of 50 |
| `ghl_calendars` | 1 | All calendars + active status |
| `ghl_funnels` | 1 | All funnels/sites + published status |
| `ghl_users` | 1 | All team members + roles |
| `ghl_behavioral` | 2+ | Inferred patterns (automation maturity, pipeline health) |
| `ghl_gap_analysis` | 1 | Gap analysis results + action plan |
| `ghl_audit` | 1 | Timestamped snapshot |

## Gap Analysis

Detects and categorizes issues across:

- **Workflows** — missing published workflows, untriggered drafts, missing core automation patterns (lead nurture, appointment reminders, review requests)
- **Pipelines** — empty stages, stalled opportunities, single-stage pipelines
- **Calendars** — no calendars, all inactive
- **Funnels** — no published pages
- **Contacts** — no contacts, high untagged ratio
- **Tags** — no tags configured (auto-fixable: creates foundational tags)
- **Users** — missing roles

Auto-fixable gaps are executed via `/api/ghl/accounts/:id/fix`. Human-review gaps come with detailed instructions.
