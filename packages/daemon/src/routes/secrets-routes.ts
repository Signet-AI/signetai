import type { Hono } from "hono";
import { logger } from "../logger.js";
import { ONEPASSWORD_SERVICE_ACCOUNT_SECRET, importOnePasswordSecrets, listOnePasswordVaults } from "../onepassword.js";
import { deleteSecret, execWithSecrets, getSecret, hasSecret, listSecrets, putSecret } from "../secrets.js";
import { parseOptionalBoolean, parseOptionalString, readOptionalJsonObject } from "./utils.js";

function parseOptionalStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const values = value
		.map((entry) => parseOptionalString(entry))
		.filter((entry): entry is string => typeof entry === "string");
	return values.length > 0 ? values : undefined;
}

async function resolveOnePasswordToken(explicitToken?: string): Promise<string> {
	if (explicitToken && explicitToken.length > 0) {
		return explicitToken;
	}

	if (!hasSecret(ONEPASSWORD_SERVICE_ACCOUNT_SECRET)) {
		throw new Error(
			"1Password service account token not configured. Set secret OP_SERVICE_ACCOUNT_TOKEN or call /api/secrets/1password/connect.",
		);
	}

	return getSecret(ONEPASSWORD_SERVICE_ACCOUNT_SECRET);
}

export function registerSecretRoutes(app: Hono): void {
	app.get("/api/secrets", (c) => {
		try {
			const names = listSecrets();
			return c.json({ secrets: names });
		} catch (e) {
			logger.error("secrets", "Failed to list secrets", e as Error);
			return c.json({ error: "Failed to list secrets" }, 500);
		}
	});

	app.get("/api/secrets/1password/status", async (c) => {
		const configured = hasSecret(ONEPASSWORD_SERVICE_ACCOUNT_SECRET);
		if (!configured) {
			return c.json({ configured: false, connected: false, vaults: [] });
		}

		try {
			const token = await resolveOnePasswordToken();
			const vaults = await listOnePasswordVaults(token);
			return c.json({
				configured: true,
				connected: true,
				vaultCount: vaults.length,
				vaults,
			});
		} catch (e) {
			const err = e as Error;
			logger.warn("secrets", "1Password status check failed", { error: err.message });
			return c.json({
				configured: true,
				connected: false,
				error: err.message,
				vaults: [],
			});
		}
	});

	app.post("/api/secrets/1password/connect", async (c) => {
		try {
			const body = await readOptionalJsonObject(c);
			if (!body) {
				return c.json({ error: "Invalid JSON body" }, 400);
			}

			const token = parseOptionalString(body.token);
			if (!token) {
				return c.json({ error: "token is required" }, 400);
			}

			const vaults = await listOnePasswordVaults(token);
			await putSecret(ONEPASSWORD_SERVICE_ACCOUNT_SECRET, token);

			logger.info("secrets", "Connected 1Password service account", {
				vaultCount: vaults.length,
			});

			return c.json({
				success: true,
				connected: true,
				vaultCount: vaults.length,
				vaults,
			});
		} catch (e) {
			const err = e as Error;
			logger.error("secrets", "Failed to connect 1Password service account", err);
			return c.json({ error: err.message }, 400);
		}
	});

	app.delete("/api/secrets/1password/connect", (c) => {
		try {
			const deleted = deleteSecret(ONEPASSWORD_SERVICE_ACCOUNT_SECRET);
			return c.json({ success: true, disconnected: true, existed: deleted });
		} catch (e) {
			const err = e as Error;
			logger.error("secrets", "Failed to disconnect 1Password service account", err);
			return c.json({ error: err.message }, 500);
		}
	});

	app.get("/api/secrets/1password/vaults", async (c) => {
		try {
			const token = await resolveOnePasswordToken();
			const vaults = await listOnePasswordVaults(token);
			return c.json({ vaults, count: vaults.length });
		} catch (e) {
			const err = e as Error;
			logger.error("secrets", "Failed to list 1Password vaults", err);
			return c.json({ error: err.message }, 400);
		}
	});

	app.post("/api/secrets/1password/import", async (c) => {
		try {
			const body = await readOptionalJsonObject(c);
			if (!body) {
				return c.json({ error: "Invalid JSON body" }, 400);
			}

			const token = await resolveOnePasswordToken(parseOptionalString(body.token));
			const vaults = parseOptionalStringArray(body.vaults);
			const prefix = parseOptionalString(body.prefix) ?? "OP";
			const overwrite = parseOptionalBoolean(body.overwrite) ?? false;

			const result = await importOnePasswordSecrets({
				token,
				vaults,
				prefix,
				overwrite,
				hasSecret,
				putSecret,
			});

			logger.info("secrets", "Imported secrets from 1Password", {
				vaultsScanned: result.vaultsScanned,
				itemsScanned: result.itemsScanned,
				importedCount: result.importedCount,
				errorCount: result.errorCount,
			});

			return c.json({ success: true, ...result });
		} catch (e) {
			const err = e as Error;
			logger.error("secrets", "Failed to import 1Password secrets", err);
			return c.json({ error: err.message }, 400);
		}
	});

	app.post("/api/secrets/exec", async (c) => {
		try {
			const body = (await c.req.json()) as {
				command?: string;
				secrets?: Record<string, string>;
			};

			if (!body.command) {
				return c.json({ error: "command is required" }, 400);
			}
			if (!body.secrets || Object.keys(body.secrets).length === 0) {
				return c.json({ error: "secrets map is required" }, 400);
			}

			const result = await execWithSecrets(body.command, body.secrets);
			logger.info("secrets", "exec_with_secrets completed", {
				secretCount: Object.keys(body.secrets).length,
				code: result.code,
			});
			return c.json(result);
		} catch (e) {
			const err = e as Error;
			logger.error("secrets", "exec_with_secrets failed", err);
			return c.json({ error: err.message }, 500);
		}
	});

	app.post("/api/secrets/:name/exec", async (c) => {
		const { name } = c.req.param();
		try {
			const body = (await c.req.json()) as {
				command?: string;
				secrets?: Record<string, string>;
			};

			if (!body.command) {
				return c.json({ error: "command is required" }, 400);
			}

			const secretRefs: Record<string, string> = body.secrets ?? { [name]: name };

			const result = await execWithSecrets(body.command, secretRefs);
			logger.info("secrets", "exec_with_secrets completed", {
				name,
				code: result.code,
			});
			return c.json(result);
		} catch (e) {
			const err = e as Error;
			logger.error("secrets", "exec_with_secrets failed", err, { name });
			return c.json({ error: err.message }, 500);
		}
	});

	app.post("/api/secrets/:name", async (c) => {
		const { name } = c.req.param();
		try {
			const body = (await c.req.json()) as { value?: string };
			if (typeof body.value !== "string" || body.value.length === 0) {
				return c.json({ error: "value is required" }, 400);
			}
			await putSecret(name, body.value);
			logger.info("secrets", "Secret stored", { name });
			return c.json({ success: true, name });
		} catch (e) {
			const err = e as Error;
			logger.error("secrets", "Failed to store secret", err, { name });
			return c.json({ error: err.message }, 400);
		}
	});

	app.delete("/api/secrets/:name", (c) => {
		const { name } = c.req.param();
		try {
			const deleted = deleteSecret(name);
			if (!deleted) return c.json({ error: `Secret '${name}' not found` }, 404);
			logger.info("secrets", "Secret deleted", { name });
			return c.json({ success: true, name });
		} catch (e) {
			logger.error("secrets", "Failed to delete secret", e as Error, { name });
			return c.json({ error: (e as Error).message }, 500);
		}
	});
}
