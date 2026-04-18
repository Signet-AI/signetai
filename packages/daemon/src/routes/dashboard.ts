import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";
import { logger } from "../logger";

function getDashboardCandidates(): string[] {
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = dirname(__filename);

	return [
		join(__dirname, "..", "..", "cli", "dashboard", "build"),
		join(__dirname, "..", "..", "..", "cli", "dashboard", "build"),
		join(__dirname, "..", "dashboard"),
		join(__dirname, "dashboard"),
	];
}

function getDashboardPath(): string | null {
	const candidates = getDashboardCandidates();

	for (const candidate of candidates) {
		if (existsSync(join(candidate, "index.html"))) {
			return candidate;
		}
	}

	return null;
}

export function setupDashboardRoutes(app: Hono): void {
	const dashboardPath = getDashboardPath();

	if (dashboardPath) {
		app.use("/*", async (c, next) => {
			const path = c.req.path;
			if (path.startsWith("/api/") || path === "/health" || path === "/sse") {
				return next();
			}
			return serveStatic({
				root: dashboardPath,
				rewriteRequestPath: (p) => {
					if (!p.includes(".") || p === "/") {
						return "/index.html";
					}
					return p;
				},
			})(c, next);
		});
	} else {
		logger.warn("daemon", "Dashboard not found - API-only mode", {
			candidates: getDashboardCandidates(),
		});
		app.get("/", (c) => {
			return c.html(`
        <!DOCTYPE html>
        <html>
        <head><title>Signet Daemon</title></head>
        <body style="font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px;">
          <h1>◈ Signet Daemon</h1>
          <p>The daemon is running, but the dashboard is not installed.</p>
          <p>API endpoints:</p>
          <ul>
            <li><a href="/health">/health</a> - Health check</li>
            <li><a href="/api/status">/api/status</a> - Daemon status</li>
            <li><a href="/api/config">/api/config</a> - Config files</li>
            <li><a href="/api/memories">/api/memories</a> - Memories</li>
            <li><a href="/api/harnesses">/api/harnesses</a> - Harnesses</li>
            <li><a href="/api/skills">/api/skills</a> - Skills</li>
          </ul>
        </body>
        </html>
      `);
		});
	}
}
