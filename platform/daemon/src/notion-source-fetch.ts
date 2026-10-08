export const NOTION_API_BASE = "https://api.notion.com/v1";
export const NOTION_API_VERSION = "2026-03-11";
export const NOTION_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;
const SEARCH_PAGE_SIZE = 100;
const MAX_PROPERTY_VALUE_CHARS = 2_000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

const CANCEL_POLL_MS = 250;

type Sleep = (ms: number, shouldContinue: () => boolean) => Promise<void>;
type ShouldContinue = () => boolean;

let notionSleep: Sleep = cancellableSleep;

export function setNotionSleepForTest(sleep: Sleep | null): void {
	notionSleep = sleep ?? cancellableSleep;
}

async function cancellableSleep(ms: number, shouldContinue: ShouldContinue): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline && shouldContinue()) {
		await new Promise((resolve) => setTimeout(resolve, Math.min(CANCEL_POLL_MS, deadline - Date.now())));
	}
}

export class NotionRequestError extends Error {
	readonly status: number;
	readonly code: string;
	readonly retryable: boolean;
	readonly retryAfterMs: number | null;

	constructor(
		message: string,
		options: {
			readonly status: number;
			readonly code: string;
			readonly retryable: boolean;
			readonly retryAfterMs?: number;
		},
	) {
		super(message);
		this.name = "NotionRequestError";
		this.status = options.status;
		this.code = options.code;
		this.retryable = options.retryable;
		this.retryAfterMs = options.retryAfterMs ?? null;
	}
}

export interface NotionPageProperty {
	readonly name: string;
	readonly value: string;
}

export interface NotionPage {
	readonly id: string;
	readonly url: string;
	readonly title: string;
	readonly createdTime: string;
	readonly lastEditedTime: string;
	readonly parentType: string;
	readonly parentId: string | null;
	readonly properties: readonly NotionPageProperty[];
}

export interface NotionSearchResult {
	readonly pages: readonly NotionPage[];
	readonly partialIds: readonly string[];
	readonly capped: boolean;
	readonly incomplete: boolean;
}

export type NotionPageLookup = { readonly status: "live"; readonly page: NotionPage } | { readonly status: "gone" };

export interface NotionPageMarkdown {
	readonly markdown: string;
	readonly truncated: boolean;
	readonly unknownBlockIds: readonly string[];
	readonly servedAtMs: number;
}

interface NotionResponse {
	readonly body: unknown;
	readonly servedAtMs: number;
}

export async function searchNotionPages(
	token: string,
	maxPages: number,
	shouldContinue: ShouldContinue,
): Promise<NotionSearchResult> {
	const pages: NotionPage[] = [];
	const partialIds: string[] = [];
	let cursor: string | undefined;
	let incomplete = false;
	while (pages.length < maxPages && shouldContinue()) {
		const body = asRecord(
			(
				await notionRequest(
					token,
					"POST",
					"/search",
					{
						filter: { property: "object", value: "page" },
						sort: { timestamp: "last_edited_time", direction: "descending" },
						page_size: Math.min(SEARCH_PAGE_SIZE, maxPages - pages.length),
						...(cursor ? { start_cursor: cursor } : {}),
					},
					shouldContinue,
				)
			).body,
		);
		const results = Array.isArray(body.results) ? body.results : [];
		for (const result of results) {
			const page = parseNotionPage(result);
			if (page && pages.length < maxPages) pages.push(page);
			else if (!page && isPartialPage(result)) partialIds.push(asRecord(result).id as string);
		}
		if (asRecord(body.request_status).type === "incomplete") incomplete = true;
		const next = typeof body.next_cursor === "string" && body.next_cursor ? body.next_cursor : undefined;
		if (body.has_more !== true || !next) return { pages, partialIds, capped: false, incomplete };
		cursor = next;
	}
	return { pages, partialIds, capped: pages.length >= maxPages, incomplete };
}

export async function fetchNotionPage(
	token: string,
	pageId: string,
	shouldContinue: ShouldContinue,
): Promise<NotionPageLookup> {
	try {
		const page = parseNotionPage(
			(await notionRequest(token, "GET", `/pages/${encodeURIComponent(pageId)}`, undefined, shouldContinue)).body,
		);
		return page ? { status: "live", page } : { status: "gone" };
	} catch (err) {
		if (err instanceof NotionRequestError && err.status === 404) return { status: "gone" };
		throw err;
	}
}

export async function fetchNotionPageMarkdown(
	token: string,
	pageId: string,
	shouldContinue: ShouldContinue,
): Promise<NotionPageMarkdown> {
	const response = await notionRequest(
		token,
		"GET",
		`/pages/${encodeURIComponent(pageId)}/markdown`,
		undefined,
		shouldContinue,
	);
	const body = asRecord(response.body);
	if (typeof body.markdown !== "string") {
		throw new NotionRequestError("Notion page markdown response had no markdown", {
			status: 200,
			code: "invalid_response",
			retryable: false,
		});
	}
	return {
		markdown: body.markdown,
		truncated: body.truncated === true,
		unknownBlockIds: Array.isArray(body.unknown_block_ids)
			? body.unknown_block_ids.filter((id): id is string => typeof id === "string")
			: [],
		servedAtMs: response.servedAtMs,
	};
}

async function notionRequest(
	token: string,
	method: "GET" | "POST",
	path: string,
	payload: unknown,
	shouldContinue: ShouldContinue,
): Promise<NotionResponse> {
	let lastError: NotionRequestError | null = null;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		if (lastError) await notionSleep(retryDelay(lastError, attempt), shouldContinue);
		if (!shouldContinue()) throw cancelledRequest();
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		const cancelPoll = setInterval(() => {
			if (!shouldContinue()) controller.abort();
		}, CANCEL_POLL_MS);
		try {
			const response = await fetch(`${NOTION_API_BASE}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					"Notion-Version": NOTION_API_VERSION,
					Accept: "application/json",
					...(payload === undefined ? {} : { "Content-Type": "application/json" }),
				},
				body: payload === undefined ? undefined : JSON.stringify(payload),
				signal: controller.signal,
			});
			const text = await readBoundedText(response);
			if (response.ok) {
				const served = Date.parse(response.headers.get("date") ?? "");
				return { body: parseJson(text, response.status), servedAtMs: Number.isFinite(served) ? served : Date.now() };
			}
			const error = responseError(response, parseErrorBody(text));
			if (!error.retryable) throw error;
			lastError = error;
		} catch (err) {
			if (err instanceof NotionRequestError && !err.retryable) throw err;
			if (!shouldContinue()) throw cancelledRequest();
			lastError =
				err instanceof NotionRequestError
					? err
					: new NotionRequestError(
							controller.signal.aborted
								? `Notion request timed out after ${REQUEST_TIMEOUT_MS}ms`
								: `Notion request failed: ${err instanceof Error ? err.message : String(err)}`,
							{ status: 0, code: controller.signal.aborted ? "timeout" : "network", retryable: true },
						);
		} finally {
			clearTimeout(timeout);
			clearInterval(cancelPoll);
		}
	}
	throw lastError ?? new NotionRequestError("Notion request failed", { status: 0, code: "network", retryable: true });
}

function responseError(response: Response, body: unknown): NotionRequestError {
	const record = asRecord(body);
	const code = typeof record.code === "string" ? record.code : `http_${response.status}`;
	const detail = typeof record.message === "string" ? record.message : response.statusText;
	const retryAfter = Number(response.headers.get("retry-after") ?? Number.NaN);
	return new NotionRequestError(`Notion API ${response.status} ${code}: ${detail}`.trim(), {
		status: response.status,
		code,
		retryable: RETRYABLE_STATUSES.has(response.status),
		...(Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfterMs: retryAfter * 1_000 } : {}),
	});
}

function retryDelay(error: NotionRequestError, attempt: number): number {
	const backoff = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
	return Math.min(MAX_RETRY_DELAY_MS, Math.max(error.retryAfterMs ?? 0, backoff));
}

function cancelledRequest(): NotionRequestError {
	return new NotionRequestError("Notion request cancelled", { status: 0, code: "cancelled", retryable: false });
}

async function readBoundedText(response: Response): Promise<string> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > NOTION_MAX_RESPONSE_BYTES) {
		await response.body?.cancel();
		throw oversizedResponse(response.status);
	}
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const next = await reader.read();
		if (next.done) break;
		total += next.value.byteLength;
		if (total > NOTION_MAX_RESPONSE_BYTES) {
			await reader.cancel();
			throw oversizedResponse(response.status);
		}
		chunks.push(next.value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

function parseJson(text: string, status: number): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new NotionRequestError(`Notion API ${status} returned invalid JSON`, {
			status,
			code: "invalid_response",
			retryable: false,
		});
	}
}

function parseErrorBody(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function oversizedResponse(status: number): NotionRequestError {
	return new NotionRequestError(`Notion API response exceeded ${NOTION_MAX_RESPONSE_BYTES} bytes`, {
		status,
		code: "response_too_large",
		retryable: false,
	});
}

function isPartialPage(value: unknown): boolean {
	const page = asRecord(value);
	return page.object === "page" && typeof page.id === "string" && page.id.length > 0 && page.properties === undefined;
}

export function parseNotionPage(value: unknown): NotionPage | null {
	const page = asRecord(value);
	if (page.object !== "page" || typeof page.id !== "string" || !page.id) return null;
	if (page.in_trash === true || page.archived === true) return null;
	if (typeof page.last_edited_time !== "string") return null;
	const parent = asRecord(page.parent);
	const parentType = typeof parent.type === "string" ? parent.type : "unknown";
	const parentValue = parent[parentType];
	const properties = asRecord(page.properties);
	let title = "";
	const rendered: NotionPageProperty[] = [];
	for (const [name, raw] of Object.entries(properties)) {
		const property = asRecord(raw);
		if (property.type === "title") {
			title = plainText(property.title);
			continue;
		}
		const value = renderPropertyValue(property);
		if (value) rendered.push({ name, value: value.slice(0, MAX_PROPERTY_VALUE_CHARS) });
	}
	return {
		id: page.id,
		url: typeof page.url === "string" ? page.url : "",
		title: title.trim() || "Untitled",
		createdTime: typeof page.created_time === "string" ? page.created_time : page.last_edited_time,
		lastEditedTime: page.last_edited_time,
		parentType,
		parentId: typeof parentValue === "string" ? parentValue : null,
		properties: rendered,
	};
}

function renderPropertyValue(property: Record<string, unknown>): string {
	const type = typeof property.type === "string" ? property.type : "";
	const value = property[type];
	switch (type) {
		case "rich_text":
			return plainText(value);
		case "number":
			return typeof value === "number" ? String(value) : "";
		case "checkbox":
			return value === true ? "Yes" : value === false ? "No" : "";
		case "select":
		case "status":
			return optionName(value);
		case "multi_select":
			return Array.isArray(value) ? value.map(optionName).filter(Boolean).join(", ") : "";
		case "date":
			return dateRange(value);
		case "url":
		case "email":
		case "phone_number":
		case "created_time":
		case "last_edited_time":
			return typeof value === "string" ? value : "";
		case "people":
			return Array.isArray(value) ? value.map(personName).filter(Boolean).join(", ") : "";
		case "created_by":
		case "last_edited_by":
			return personName(value);
		case "files":
			return Array.isArray(value)
				? value
						.map((file) => asRecord(file).name)
						.filter((name): name is string => typeof name === "string" && name.length > 0)
						.join(", ")
				: "";
		case "unique_id": {
			const id = asRecord(value);
			if (typeof id.number !== "number") return "";
			return typeof id.prefix === "string" && id.prefix ? `${id.prefix}-${id.number}` : String(id.number);
		}
		case "formula":
			return formulaValue(asRecord(value));
		default:
			return "";
	}
}

function formulaValue(formula: Record<string, unknown>): string {
	const type = typeof formula.type === "string" ? formula.type : "";
	const value = formula[type];
	if (type === "string") return typeof value === "string" ? value : "";
	if (type === "number") return typeof value === "number" ? String(value) : "";
	if (type === "boolean") return value === true ? "Yes" : value === false ? "No" : "";
	if (type === "date") return dateRange(value);
	return "";
}

function plainText(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return value
		.map((item) => asRecord(item).plain_text)
		.filter((text): text is string => typeof text === "string")
		.join("");
}

function optionName(value: unknown): string {
	const name = asRecord(value).name;
	return typeof name === "string" ? name : "";
}

function personName(value: unknown): string {
	const person = asRecord(value);
	return typeof person.name === "string" ? person.name : "";
}

function dateRange(value: unknown): string {
	const date = asRecord(value);
	if (typeof date.start !== "string") return "";
	return typeof date.end === "string" && date.end ? `${date.start} → ${date.end}` : date.start;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
