export class SignetError extends Error {
	constructor(
		message: string,
		readonly code: string,
	) {
		super(message);
		this.name = "SignetError";
	}
}

export class SignetApiError extends SignetError {
	constructor(
		readonly status: number,
		readonly body: unknown,
	) {
		super(
			typeof body === "object" && body !== null && "error" in body ? String(body.error) : `API error ${status}`,
			"api_error",
		);
		this.name = "SignetApiError";
	}
}

export class SignetOutboxAdmissionError extends SignetError {
	override readonly cause: unknown;
	constructor(cause: unknown) {
		super("Delivery was not admitted to the durable outbox; no request was sent", "outbox_admission_failed");
		this.name = "SignetOutboxAdmissionError";
		this.cause = cause;
	}
}

export type UnauthorizedReason =
	| "missing_credential"
	| "invalid_credential"
	| "expired"
	| "revoked"
	| "user_deactivated"
	| "device_revoked"
	| "legacy_token"
	| "legacy_key_expired"
	| "empty_scope"
	| "refresh_reuse";
export type ForbiddenReason =
	| "permission"
	| "agent_not_permitted"
	| "agent_binding_conflict"
	| "actor_conflict"
	| "project_not_permitted"
	| "csrf"
	| "not_owner"
	| "org_policy";

export class SignetUnauthorizedError extends SignetApiError {
	constructor(
		readonly reason: string,
		body: unknown = { error: "Signet session expired, run `signet login`", reason },
		options?: ErrorOptions,
	) {
		super(401, body);
		this.name = "SignetUnauthorizedError";
		if (options) this.cause = options.cause;
	}
}

export class SignetForbiddenError extends SignetApiError {
	constructor(
		readonly reason: string,
		readonly required?: string,
		body: unknown = { error: "Forbidden", reason, required },
	) {
		super(403, body);
		this.name = "SignetForbiddenError";
	}
}

export class SignetNetworkError extends SignetError {
	override readonly cause: Error;
	constructor(message: string, cause: Error) {
		super(message, "network_error");
		this.name = "SignetNetworkError";
		this.cause = cause;
	}
}

export class SignetTimeoutError extends SignetNetworkError {
	constructor(timeoutMs: number) {
		super(`Request timed out after ${timeoutMs}ms`, new Error("timeout"));
		this.name = "SignetTimeoutError";
	}
}

export function apiError(status: number, body: unknown): SignetApiError {
	const reason =
		typeof body === "object" && body !== null && "reason" in body && typeof body.reason === "string"
			? body.reason
			: "unknown";
	if (status === 401) return new SignetUnauthorizedError(reason, body);
	if (status === 403) {
		const required =
			typeof body === "object" && body !== null && "required" in body && typeof body.required === "string"
				? body.required
				: undefined;
		return new SignetForbiddenError(reason, required, body);
	}
	return new SignetApiError(status, body);
}
