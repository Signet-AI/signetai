import assert from "node:assert/strict";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Credential {
	bearer?: string;
	cookie?: string;
	csrf?: string;
}
export interface Reply {
	status: number;
	body: Json;
	headers: Headers;
}
export function record(value: unknown): Record<string, unknown> {
	assert(value !== null && typeof value === "object" && !Array.isArray(value), "Expected an object");
	return Object.fromEntries(Object.entries(value));
}
export function text(value: unknown): string {
	assert.equal(typeof value, "string", "Expected a string");
	return String(value);
}
export function id(value: unknown): string {
	const row = record(value);
	return text(row.id);
}
export async function request(
	origin: string,
	path: string,
	credential: Credential = {},
	method = "GET",
	body?: object,
	extraHeaders: Record<string, string> = {},
): Promise<Reply> {
	const headers = new Headers(extraHeaders);
	headers.set("accept", "application/json, text/event-stream");
	if (body) headers.set("content-type", "application/json");
	if (credential.bearer) headers.set("authorization", `Bearer ${credential.bearer}`);
	if (credential.cookie) headers.set("cookie", credential.cookie);
	if (credential.csrf) headers.set("x-signet-csrf", credential.csrf);
	const response = await fetch(`${origin}${path}`, {
		method,
		headers,
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(30_000),
	});
	const raw = await response.text();
	let parsed: Json;
	if (response.headers.get("content-type")?.includes("application/json")) parsed = JSON.parse(raw);
	else if (raw.startsWith("event:") || raw.startsWith("data:")) {
		parsed = raw
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => JSON.parse(line.slice(5)));
	} else if (response.headers.get("content-type")?.includes("ndjson")) {
		parsed = raw
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} else parsed = raw;
	return { status: response.status, body: parsed, headers: response.headers };
}
export function success(reply: Reply, endpoint: string): Record<string, unknown> {
	assert(
		reply.status >= 200 && reply.status < 300,
		`${endpoint}: expected success, received HTTP ${reply.status}; ${typeof reply.body === "object" && reply.body !== null && !Array.isArray(reply.body) ? String(reply.body.error ?? reply.body.reason ?? "") : ""}`,
	);
	return record(reply.body);
}
export function browser(reply: Reply): Credential {
	const cookies = reply.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ");
	assert(cookies.includes("signet_session="), "Browser response must set signet_session");
	return { cookie: cookies, csrf: text(record(reply.body).csrf) };
}
export async function until(check: () => Promise<boolean>, label: string, timeout = 30_000): Promise<void> {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (await check()) return;
		await Bun.sleep(100);
	}
	throw new Error(`Timed out: ${label}`);
}
