/**
 * GHL API Routes
 *
 * Mounts the GoHighLevel OAuth connect flow and account management
 * endpoints onto the Signet daemon.
 *
 * Endpoints:
 *   GET  /api/ghl/connect          → redirect to GHL OAuth
 *   GET  /api/ghl/callback         → handle OAuth callback, bootstrap agent
 *   GET  /api/ghl/accounts         → list connected GHL accounts
 *   GET  /api/ghl/accounts/:id     → get specific account status
 *   POST /api/ghl/accounts/:id/sync → re-run discovery + re-ingest
 *   DELETE /api/ghl/accounts/:id   → disconnect account
 *   POST /api/ghl/accounts/:id/fix → execute auto-fixable gaps
 *
 * Config (via signet secrets or env):
 *   GHL_CLIENT_ID      — from GHL Marketplace App
 *   GHL_CLIENT_SECRET  — from GHL Marketplace App
 *   GHL_REDIRECT_URI   — e.g. http://localhost:3850/api/ghl/callback
 */

import type { Hono } from "hono";
import { GHLConnector, MemoryStorage, REQUIRED_SCOPES } from "@signet/connector-ghl";
import type { GHLConnectorConfig } from "@signet/connector-ghl";

// ============================================================================
// Singleton connector (lazy-initialized when first route is called)
// ============================================================================

let _connector: GHLConnector | null = null;
let _storage: MemoryStorage | null = null;

function getConnector(daemonPort: number): GHLConnector {
	if (_connector) return _connector;

	const clientId = process.env["GHL_CLIENT_ID"];
	const clientSecret = process.env["GHL_CLIENT_SECRET"];
	const redirectUri =
		process.env["GHL_REDIRECT_URI"] ?? `http://localhost:${daemonPort}/api/ghl/callback`;

	if (!clientId || !clientSecret) {
		throw new Error(
			"GHL OAuth not configured. Set GHL_CLIENT_ID and GHL_CLIENT_SECRET in your environment or Signet secrets."
		);
	}

	const config: GHLConnectorConfig = {
		oauth: {
			clientId,
			clientSecret,
			redirectUri,
			scopes: [...REQUIRED_SCOPES],
		},
		daemonPort,
		syncIntervalHours: 24,
		ingestOnBootstrap: true,
	};

	_storage = new MemoryStorage();
	_connector = new GHLConnector(config, _storage);
	return _connector;
}

// ============================================================================
// Route Registration
// ============================================================================

export function mountGHLRoutes(app: Hono, daemonPort = 3850): void {
	// ── GET /api/ghl/config ─────────────────────────────────────────────────
	// Check if GHL OAuth is configured
	app.get("/api/ghl/config", (c) => {
		const configured = !!(process.env["GHL_CLIENT_ID"] && process.env["GHL_CLIENT_SECRET"]);
		return c.json({
			configured,
			requiredEnvVars: ["GHL_CLIENT_ID", "GHL_CLIENT_SECRET"],
			optionalEnvVars: ["GHL_REDIRECT_URI"],
			requiredScopes: REQUIRED_SCOPES,
		});
	});

	// ── GET /api/ghl/connect ────────────────────────────────────────────────
	// Redirect the user to GHL OAuth consent screen
	app.get("/api/ghl/connect", (c) => {
		let connector: GHLConnector;
		try {
			connector = getConnector(daemonPort);
		} catch (e) {
			return c.json({ error: String(e) }, 400);
		}

		// Use a random state for CSRF protection
		const state = Math.random().toString(36).slice(2);
		// In production, save state to session/DB for validation

		const authUrl = connector.getAuthorizationUrl(state);
		return c.redirect(authUrl);
	});

	// ── GET /api/ghl/callback ───────────────────────────────────────────────
	// OAuth callback — exchange code, run bootstrap, redirect to dashboard
	app.get("/api/ghl/callback", async (c) => {
		const code = c.req.query("code");
		const error = c.req.query("error");

		if (error) {
			return c.html(buildErrorPage(`GHL OAuth error: ${error}`));
		}

		if (!code) {
			return c.html(buildErrorPage("No authorization code received from GHL."));
		}

		let connector: GHLConnector;
		try {
			connector = getConnector(daemonPort);
		} catch (e) {
			return c.html(buildErrorPage(String(e)));
		}

		const logs: string[] = [];
		try {
			const account = await connector.handleCallback(code, {
				onProgress: (msg) => {
					logs.push(msg);
					console.log(`[GHL] ${msg}`);
				},
				runGapAnalysis: true,
				autoFix: false, // never auto-fix on first connect — user reviews first
			});

			return c.html(
				buildSuccessPage(account.locationName, account.healthScore ?? 0, logs)
			);
		} catch (e) {
			console.error("[GHL] Callback error:", e);
			return c.html(buildErrorPage(String(e), logs));
		}
	});

	// ── GET /api/ghl/accounts ───────────────────────────────────────────────
	app.get("/api/ghl/accounts", async (c) => {
		let connector: GHLConnector;
		try {
			connector = getConnector(daemonPort);
		} catch {
			return c.json({ accounts: [], configured: false });
		}

		const accounts = await connector.getAllAccounts();
		return c.json({
			accounts: accounts.map((a) => ({
				id: a.id,
				locationName: a.locationName,
				connectedAt: a.connectedAt,
				lastSyncAt: a.lastSyncAt,
				healthScore: a.healthScore,
				gapCount: a.gapAnalysis?.totalGaps ?? null,
				autoFixable: a.gapAnalysis?.autoFixable ?? null,
			})),
		});
	});

	// ── GET /api/ghl/accounts/:id ───────────────────────────────────────────
	app.get("/api/ghl/accounts/:id", async (c) => {
		const locationId = c.req.param("id");
		let connector: GHLConnector;
		try {
			connector = getConnector(daemonPort);
		} catch (e) {
			return c.json({ error: String(e) }, 400);
		}

		const account = await connector.getAccount(locationId);
		if (!account) return c.json({ error: "Account not found" }, 404);

		// Return without raw tokens
		const { tokens: _tokens, ...safe } = account;
		return c.json(safe);
	});

	// ── POST /api/ghl/accounts/:id/sync ────────────────────────────────────
	app.post("/api/ghl/accounts/:id/sync", async (c) => {
		const locationId = c.req.param("id");
		let connector: GHLConnector;
		try {
			connector = getConnector(daemonPort);
		} catch (e) {
			return c.json({ error: String(e) }, 400);
		}

		const logs: string[] = [];
		try {
			const account = await connector.syncAccount(locationId, {
				onProgress: (msg) => {
					logs.push(msg);
					console.log(`[GHL] ${msg}`);
				},
			});
			return c.json({
				ok: true,
				locationName: account.locationName,
				healthScore: account.healthScore,
				gapCount: account.gapAnalysis?.totalGaps ?? 0,
				logs,
			});
		} catch (e) {
			return c.json({ ok: false, error: String(e), logs }, 500);
		}
	});

	// ── POST /api/ghl/accounts/:id/fix ─────────────────────────────────────
	app.post("/api/ghl/accounts/:id/fix", async (c) => {
		const locationId = c.req.param("id");
		const body = (await c.req.json().catch(() => ({}))) as { dryRun?: boolean };

		let connector: GHLConnector;
		try {
			connector = getConnector(daemonPort);
		} catch (e) {
			return c.json({ error: String(e) }, 400);
		}

		const account = await connector.getAccount(locationId);
		if (!account) return c.json({ error: "Account not found" }, 404);
		if (!account.gapAnalysis) return c.json({ error: "No gap analysis available — run sync first" }, 400);

		const { executeAutoFixes } = await import("@signet/connector-ghl");
		const results = await executeAutoFixes(
			account.gapAnalysis,
			{ access_token: account.tokens.access_token, locationId },
			{ dryRun: body.dryRun ?? false }
		);

		const fixed = results.filter((r) => r.success).length;
		return c.json({
			ok: true,
			fixed,
			total: results.length,
			dryRun: body.dryRun ?? false,
			results,
		});
	});

	// ── DELETE /api/ghl/accounts/:id ───────────────────────────────────────
	app.delete("/api/ghl/accounts/:id", async (c) => {
		const locationId = c.req.param("id");
		let connector: GHLConnector;
		try {
			connector = getConnector(daemonPort);
		} catch (e) {
			return c.json({ error: String(e) }, 400);
		}

		const account = await connector.getAccount(locationId);
		if (!account) return c.json({ error: "Account not found" }, 404);

		await connector.disconnectAccount(locationId);
		return c.json({ ok: true, disconnected: locationId });
	});
}

// ============================================================================
// HTML Helpers
// ============================================================================

function buildSuccessPage(locationName: string, healthScore: number, logs: string[]): string {
	const color = healthScore >= 70 ? "#22c55e" : healthScore >= 40 ? "#f59e0b" : "#ef4444";
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GHL Connected — Signet</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f0f0f; color: #e4e4e7; max-width: 600px; margin: 60px auto; padding: 0 24px; }
    .card { background: #1a1a1a; border: 1px solid #27272a; border-radius: 12px; padding: 32px; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    .subtitle { color: #71717a; margin: 0 0 24px; }
    .score { display: inline-flex; align-items: center; gap: 10px; background: #09090b; border-radius: 8px; padding: 12px 20px; margin-bottom: 24px; }
    .score-value { font-size: 36px; font-weight: 700; color: ${color}; }
    .score-label { color: #a1a1aa; font-size: 13px; }
    .logs { background: #09090b; border-radius: 8px; padding: 16px; font-family: monospace; font-size: 12px; color: #71717a; max-height: 200px; overflow-y: auto; }
    .cta { margin-top: 24px; }
    a { color: #a78bfa; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .badge { display: inline-block; background: #16a34a22; color: #4ade80; border-radius: 4px; padding: 2px 8px; font-size: 12px; font-weight: 600; margin-left: 8px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>GHL Connected <span class="badge">✓</span></h1>
    <p class="subtitle">${locationName}</p>
    <div class="score">
      <div class="score-value">${healthScore}</div>
      <div class="score-label">Account<br>Health Score</div>
    </div>
    <p style="color:#a1a1aa;font-size:14px;">Your agent has been bootstrapped with full account context. You can now ask it to navigate, manage, or improve your GHL account.</p>
    <div class="logs">${logs.map((l) => `<div>${l}</div>`).join("")}</div>
    <div class="cta">
      <a href="http://localhost:3850">← Back to Signet Dashboard</a>
    </div>
  </div>
</body>
</html>`;
}

function buildErrorPage(error: string, logs: string[] = []): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>GHL Connect Error — Signet</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f0f0f; color: #e4e4e7; max-width: 600px; margin: 60px auto; padding: 0 24px; }
    .card { background: #1a1a1a; border: 1px solid #27272a; border-radius: 12px; padding: 32px; }
    h1 { margin: 0 0 8px; color: #f87171; }
    .error { background: #1c0a0a; border: 1px solid #7f1d1d; border-radius: 8px; padding: 16px; font-family: monospace; font-size: 13px; color: #fca5a5; margin: 16px 0; }
    .logs { background: #09090b; border-radius: 8px; padding: 16px; font-family: monospace; font-size: 12px; color: #71717a; max-height: 200px; overflow-y: auto; }
    a { color: #a78bfa; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Connection Failed</h1>
    <div class="error">${error}</div>
    ${logs.length > 0 ? `<div class="logs">${logs.map((l) => `<div>${l}</div>`).join("")}</div>` : ""}
    <p><a href="/api/ghl/connect">Try again</a> · <a href="http://localhost:3850">Back to Dashboard</a></p>
  </div>
</body>
</html>`;
}
