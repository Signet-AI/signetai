import {
	deleteLocalSecret,
	execWithSecrets,
	listLocalSecretNames,
	normalizeSecretExecTimeoutMs,
	parseLocalSecretName,
	putLocalSecret,
	type DaemonApiCall,
} from "@signet/core";

function errorResponse(error: string): { readonly ok: false; readonly data: { readonly error: string } } {
	return { ok: false, data: { error } };
}

function routeName(path: string): string | null {
	const prefix = "/api/secrets/";
	if (!path.startsWith(prefix)) return null;
	const encoded = path.slice(prefix.length);
	if (!encoded || encoded.includes("/")) return null;
	try {
		return parseLocalSecretName(decodeURIComponent(encoded));
	} catch {
		return null;
	}
}

function bodyRecord(body: unknown): Record<string, unknown> | null {
	if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
	return Object.fromEntries(Object.entries(body));
}

function stringRecord(value: unknown): Record<string, string> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const result: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== "string") return null;
		result[key] = item;
	}
	return result;
}

/** Use @signet/core directly for local secrets when the daemon is unavailable. */
export function createOfflineSecretApiCall(): DaemonApiCall {
	return async (method, path, body) => {
		if (method === "GET" && path === "/api/secrets") {
			return { ok: true, data: { secrets: listLocalSecretNames(), provider: "local" } };
		}

		if (method === "POST" && path === "/api/secrets/exec") {
			const request = bodyRecord(body);
			const command = request?.command;
			const secrets = stringRecord(request?.secrets);
			if (typeof command !== "string" || secrets === null) {
				return errorResponse("Command and secret references are required");
			}
			try {
				const result = await execWithSecrets(command, secrets, {
					timeoutMs: normalizeSecretExecTimeoutMs(request?.timeoutMs),
				});
				return { ok: true, data: { id: null, status: "completed", result } };
			} catch (error) {
				return errorResponse(error instanceof Error ? error.message : String(error));
			}
		}

		const name = routeName(path);
		if (name !== null && method === "POST") {
			const value = bodyRecord(body)?.value;
			if (typeof value !== "string" || value.length === 0) return errorResponse("Secret value cannot be empty");
			try {
				await putLocalSecret(name, value);
				return { ok: true, data: { success: true, name } };
			} catch (error) {
				return errorResponse(error instanceof Error ? error.message : String(error));
			}
		}

		if (name !== null && method === "DELETE") {
			try {
				const deleted = await deleteLocalSecret(name);
				return deleted ? { ok: true, data: { success: true, name } } : errorResponse(`Secret '${name}' not found`);
			} catch (error) {
				return errorResponse(error instanceof Error ? error.message : String(error));
			}
		}

		return errorResponse("This secret operation requires a running Signet daemon");
	};
}
