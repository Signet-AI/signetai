import { spawn } from "node:child_process";

export const BITWARDEN_SESSION_SECRET = "BITWARDEN_SESSION";
export const BITWARDEN_ACTIVE_PROVIDER_SECRET = "SIGNET_SECRETS_ACTIVE_PROVIDER";
export const BITWARDEN_MANAGED_FOLDER_SECRET = "BITWARDEN_MANAGED_FOLDER_ID";

const SECRET_REF_PREFIX = "bw://";
const DEFAULT_BW_TIMEOUT_MS = 30_000;
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface BitwardenFolder {
	readonly id: string;
	readonly name: string;
}

export interface BitwardenItemSummary {
	readonly id: string;
	readonly name: string;
	readonly folderId?: string | null;
}

export interface BitwardenItemDetails extends BitwardenItemSummary {
	readonly login?: {
		readonly username?: string | null;
		readonly password?: string | null;
	};
	readonly notes?: string | null;
	readonly fields?: readonly BitwardenField[] | null;
}

export interface BitwardenField {
	readonly name?: string | null;
	readonly value?: string | null;
	readonly type?: number | null;
}

export interface BitwardenClient {
	status(): Promise<{ readonly status?: string; readonly userEmail?: string; readonly serverUrl?: string }>;
	listFolders(): Promise<readonly BitwardenFolder[]>;
	listItems(): Promise<readonly BitwardenItemSummary[]>;
	getItem(id: string): Promise<BitwardenItemDetails>;
	putSecret(
		name: string,
		value: string,
		options?: { readonly folderId?: string; readonly overwrite?: boolean },
	): Promise<BitwardenItemDetails>;
	deleteSecret(name: string): Promise<boolean>;
	resolveSecret(ref: string): Promise<string>;
}

export type BitwardenClientFactory = (session: string) => Promise<BitwardenClient>;

let bitwardenClientFactoryOverride: BitwardenClientFactory | null = null;

export function setBitwardenClientFactoryForTests(factory: BitwardenClientFactory | null): void {
	bitwardenClientFactoryOverride = factory;
}

function getBitwardenClientFactory(explicitFactory?: BitwardenClientFactory): BitwardenClientFactory {
	return explicitFactory ?? bitwardenClientFactoryOverride ?? defaultBitwardenClientFactory;
}

export interface BitwardenStatus {
	readonly configured: boolean;
	readonly connected: boolean;
	readonly activeProvider: boolean;
	readonly userEmail?: string;
	readonly serverUrl?: string;
	readonly folders?: readonly BitwardenFolder[];
	readonly error?: string;
}

export interface BitwardenMigrationSecretResult {
	readonly name: string;
	readonly action: "migrated" | "skipped" | "deleted-local";
	readonly itemId?: string;
	readonly error?: string;
}

export interface BitwardenMigrationResult {
	readonly dryRun: boolean;
	readonly deleteLocal: boolean;
	readonly migratedCount: number;
	readonly skippedCount: number;
	readonly deletedLocalCount: number;
	readonly errorCount: number;
	readonly results: readonly BitwardenMigrationSecretResult[];
}

export function isBitwardenReference(secretName: string): boolean {
	return secretName.startsWith(SECRET_REF_PREFIX);
}

export function isBitwardenActiveProvider(value: string | undefined): boolean {
	return value?.trim().toLowerCase() === "bitwarden";
}

export function buildBitwardenManagedSecretName(name: string): string {
	const trimmed = name.trim();
	if (SECRET_NAME_RE.test(trimmed)) return trimmed;
	const candidate = trimmed
		.replace(/[^A-Za-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toUpperCase();
	if (SECRET_NAME_RE.test(candidate)) return candidate;
	return `SECRET_${candidate || "VALUE"}`;
}

export async function readBitwardenReference(
	reference: string,
	session: string,
	clientFactory?: BitwardenClientFactory,
): Promise<string> {
	if (!isBitwardenReference(reference)) {
		throw new Error(
			`Invalid Bitwarden reference '${reference}'. Expected bw://item/<id>/password or bw://name/<secretName>`,
		);
	}
	const client = await getBitwardenClientFactory(clientFactory)(session);
	return client.resolveSecret(reference);
}

export async function listBitwardenFolders(
	session: string,
	clientFactory?: BitwardenClientFactory,
): Promise<readonly BitwardenFolder[]> {
	const client = await getBitwardenClientFactory(clientFactory)(session);
	return client.listFolders();
}

export async function listBitwardenSecretNames(
	session: string,
	clientFactory?: BitwardenClientFactory,
): Promise<readonly string[]> {
	const client = await getBitwardenClientFactory(clientFactory)(session);
	const items = await client.listItems();
	return items
		.map((item) => item.name)
		.filter((name) => name.length > 0)
		.sort((a, b) => a.localeCompare(b));
}

export async function putBitwardenSecret(
	name: string,
	value: string,
	session: string,
	options: {
		readonly folderId?: string;
		readonly overwrite?: boolean;
		readonly clientFactory?: BitwardenClientFactory;
	} = {},
): Promise<BitwardenItemDetails> {
	const client = await getBitwardenClientFactory(options.clientFactory)(session);
	return client.putSecret(buildBitwardenManagedSecretName(name), value, {
		folderId: options.folderId,
		overwrite: options.overwrite,
	});
}

export async function deleteBitwardenSecret(
	name: string,
	session: string,
	clientFactory?: BitwardenClientFactory,
): Promise<boolean> {
	const client = await getBitwardenClientFactory(clientFactory)(session);
	return client.deleteSecret(buildBitwardenManagedSecretName(name));
}

export async function getBitwardenStatus(options: {
	readonly configured: boolean;
	readonly activeProvider: boolean;
	readonly session?: string;
	readonly clientFactory?: BitwardenClientFactory;
}): Promise<BitwardenStatus> {
	if (!options.configured || !options.session) {
		return { configured: false, connected: false, activeProvider: options.activeProvider };
	}
	try {
		const client = await getBitwardenClientFactory(options.clientFactory)(options.session);
		const [status, folders] = await Promise.all([client.status(), client.listFolders()]);
		return {
			configured: true,
			connected: status.status === "unlocked",
			activeProvider: options.activeProvider,
			userEmail: status.userEmail,
			serverUrl: status.serverUrl,
			folders,
		};
	} catch (error) {
		return {
			configured: true,
			connected: false,
			activeProvider: options.activeProvider,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function migrateLocalSecretsToBitwarden(options: {
	readonly session: string;
	readonly localNames: readonly string[];
	readonly getLocalSecret: (name: string) => Promise<string>;
	readonly deleteLocalSecret?: (name: string) => boolean;
	readonly folderId?: string;
	readonly overwrite?: boolean;
	readonly dryRun?: boolean;
	readonly deleteLocal?: boolean;
	readonly clientFactory?: BitwardenClientFactory;
}): Promise<BitwardenMigrationResult> {
	const client = await getBitwardenClientFactory(options.clientFactory)(options.session);
	const dryRun = options.dryRun === true;
	const deleteLocal = options.deleteLocal === true;
	const overwrite = options.overwrite === true;
	const results: BitwardenMigrationSecretResult[] = [];
	let migratedCount = 0;
	let skippedCount = 0;
	let deletedLocalCount = 0;
	let errorCount = 0;

	for (const localName of options.localNames) {
		const name = buildBitwardenManagedSecretName(localName);
		try {
			if (dryRun) {
				results.push({ name, action: "skipped" });
				skippedCount += 1;
				continue;
			}
			const value = await options.getLocalSecret(localName);
			const item = await client.putSecret(name, value, { folderId: options.folderId, overwrite });
			results.push({ name, action: "migrated", itemId: item.id });
			migratedCount += 1;
			if (deleteLocal && options.deleteLocalSecret?.(localName)) {
				results.push({ name: localName, action: "deleted-local" });
				deletedLocalCount += 1;
			}
		} catch (error) {
			errorCount += 1;
			results.push({ name, action: "skipped", error: error instanceof Error ? error.message : String(error) });
		}
	}

	return { dryRun, deleteLocal, migratedCount, skippedCount, deletedLocalCount, errorCount, results };
}

export async function defaultBitwardenClientFactory(session: string): Promise<BitwardenClient> {
	const trimmedSession = session.trim();
	if (!trimmedSession)
		throw new Error(
			"Bitwarden session token is required. Run `bw login` then `bw unlock --raw` and connect the session to Signet.",
		);
	return new BwCliClient(trimmedSession);
}

class BwCliClient implements BitwardenClient {
	constructor(private readonly session: string) {}

	async status(): Promise<{ readonly status?: string; readonly userEmail?: string; readonly serverUrl?: string }> {
		return parseJson(await runBw(["status"], { session: this.session })) as {
			status?: string;
			userEmail?: string;
			serverUrl?: string;
		};
	}

	async listFolders(): Promise<readonly BitwardenFolder[]> {
		const folders = parseJson(await runBw(["list", "folders"], { session: this.session })) as unknown[];
		return folders.map((folder) => toFolder(folder)).filter((folder): folder is BitwardenFolder => folder !== null);
	}

	async listItems(): Promise<readonly BitwardenItemSummary[]> {
		const items = parseJson(await runBw(["list", "items"], { session: this.session })) as unknown[];
		return items.map((item) => toItemSummary(item)).filter((item): item is BitwardenItemSummary => item !== null);
	}

	async getItem(id: string): Promise<BitwardenItemDetails> {
		return toItemDetails(parseJson(await runBw(["get", "item", id], { session: this.session })));
	}

	async putSecret(
		name: string,
		value: string,
		options: { readonly folderId?: string; readonly overwrite?: boolean } = {},
	): Promise<BitwardenItemDetails> {
		const existing = await this.findItemByName(name);
		if (existing && options.overwrite !== true) {
			throw new Error(`Bitwarden item '${name}' already exists; pass overwrite to replace it`);
		}
		const item = existing ? await this.getItem(existing.id) : buildNewLoginItem(name, options.folderId);
		const updated = {
			...item,
			name,
			folderId: options.folderId ?? item.folderId ?? null,
			login: { ...(item.login ?? {}), username: item.login?.username ?? "signet", password: value },
			notes: item.notes ?? "Managed by Signet secrets",
		};
		const encoded = await runBw(["encode"], { input: JSON.stringify(updated), session: this.session });
		// Bitwarden CLI vault commands declare encodedJson as optional for create/edit and read it from
		// stdin when omitted. Keep secret-bearing item payloads off argv and write them to stdin instead.
		if (existing) {
			return toItemDetails(
				parseJson(await runBw(["edit", "item", existing.id], { input: encoded.trim(), session: this.session })),
			);
		}
		return toItemDetails(parseJson(await runBw(["create", "item"], { input: encoded.trim(), session: this.session })));
	}

	async deleteSecret(name: string): Promise<boolean> {
		const existing = await this.findItemByName(name);
		if (!existing) return false;
		await runBw(["delete", "item", existing.id], { session: this.session });
		return true;
	}

	async resolveSecret(ref: string): Promise<string> {
		const parsed = parseBitwardenReference(ref);
		const item = parsed.kind === "item" ? await this.getItem(parsed.id) : await this.getItemByName(parsed.name);
		return readField(item, parsed.field);
	}

	private async getItemByName(name: string): Promise<BitwardenItemDetails> {
		const summary = await this.findItemByName(name);
		if (!summary) throw new Error(`Bitwarden item '${name}' not found`);
		return this.getItem(summary.id);
	}

	private async findItemByName(name: string): Promise<BitwardenItemSummary | null> {
		const items = await this.listItems();
		return items.find((item) => item.name === name) ?? null;
	}
}

function buildNewLoginItem(name: string, folderId?: string): BitwardenItemDetails & { type: number } {
	return {
		id: "",
		name,
		folderId: folderId ?? null,
		type: 1,
		login: { username: "signet", password: "" },
		notes: "Managed by Signet secrets",
	};
}

function parseBitwardenReference(
	ref: string,
): { kind: "item"; id: string; field: string } | { kind: "name"; name: string; field: string } {
	const withoutPrefix = ref.slice(SECRET_REF_PREFIX.length);
	const parts = withoutPrefix.split("/").filter(Boolean).map(decodeURIComponent);
	if (parts[0] === "item" && parts[1]) return { kind: "item", id: parts[1], field: parts[2] ?? "password" };
	if (parts[0] === "name" && parts[1]) return { kind: "name", name: parts[1], field: parts[2] ?? "password" };
	if (parts.length === 1) return { kind: "name", name: parts[0], field: "password" };
	throw new Error(`Invalid Bitwarden reference '${ref}'. Expected bw://item/<id>/password or bw://name/<secretName>`);
}

function readField(item: BitwardenItemDetails, field: string): string {
	const normalized = field.toLowerCase();
	if (normalized === "password") {
		const value = item.login?.password;
		if (typeof value === "string") return value;
	}
	if (normalized === "username") {
		const value = item.login?.username;
		if (typeof value === "string") return value;
	}
	const custom = item.fields?.find((entry) => entry.name?.toLowerCase() === normalized)?.value;
	if (typeof custom === "string") return custom;
	throw new Error(`Bitwarden item '${item.name}' does not contain field '${field}'`);
}

function toFolder(value: unknown): BitwardenFolder | null {
	const obj = toRecord(value);
	const id = readString(obj.id);
	const name = readString(obj.name);
	if (!id || !name) return null;
	return { id, name };
}

function toItemSummary(value: unknown): BitwardenItemSummary | null {
	const obj = toRecord(value);
	const id = readString(obj.id);
	const name = readString(obj.name);
	if (!id || !name) return null;
	return { id, name, folderId: readString(obj.folderId) ?? null };
}

function toItemDetails(value: unknown): BitwardenItemDetails {
	const summary = toItemSummary(value);
	if (!summary) throw new Error("Bitwarden returned invalid item payload");
	const obj = toRecord(value);
	const login = toRecordOrUndefined(obj.login);
	const fields = Array.isArray(obj.fields)
		? obj.fields.map(toRecord).map((field) => ({
				name: readString(field.name),
				value: readOptionalString(field.value),
				type: readNumber(field.type),
			}))
		: null;
	return {
		...summary,
		login: login
			? { username: readOptionalString(login.username), password: readOptionalString(login.password) }
			: undefined,
		notes: readOptionalString(obj.notes) ?? null,
		fields,
	};
}

function toRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toRecordOrUndefined(value: unknown): Record<string, unknown> | undefined {
	const record = toRecord(value);
	return Object.keys(record).length > 0 ? record : undefined;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readOptionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseJson(stdout: string): unknown {
	try {
		return JSON.parse(stdout);
	} catch (error) {
		throw new Error(`Bitwarden CLI returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function runBw(
	args: readonly string[],
	options: { readonly session: string; readonly input?: string; readonly timeoutMs?: number },
): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn("bw", [...args], {
			stdio: "pipe",
			windowsHide: true,
			env: { ...process.env, BW_SESSION: options.session },
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			proc.kill("SIGTERM");
			reject(new Error(`Bitwarden CLI timed out running bw ${args.join(" ")}`));
		}, options.timeoutMs ?? DEFAULT_BW_TIMEOUT_MS);
		timer.unref();
		proc.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		proc.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error.message.includes("ENOENT") ? new Error("Bitwarden CLI `bw` was not found on PATH") : error);
		});
		proc.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code === 0) resolve(stdout.trim());
			else reject(new Error((stderr || stdout || `bw exited with code ${code}`).trim()));
		});
		if (options.input !== undefined) proc.stdin?.end(options.input);
		else proc.stdin?.end();
	});
}
