// @1password/sdk is lazy-loaded in defaultOnePasswordClientFactory to avoid
// WASM ENOENT crash when the package isn't properly installed.

export const ONEPASSWORD_SERVICE_ACCOUNT_SECRET = "OP_SERVICE_ACCOUNT_TOKEN";

const SECRET_REF_PREFIX = "op://";
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const INTEGRATION_NAME = "signet-daemon";
const INTEGRATION_VERSION = "0.1.0";

export interface OnePasswordVault {
	readonly id: string;
	readonly name: string;
}

export interface ImportedOnePasswordSecret {
	readonly secretName: string;
	readonly baseSecretName: string;
	readonly vaultId: string;
	readonly vaultName: string;
	readonly itemId: string;
	readonly itemTitle: string;
	readonly fieldId: string;
	readonly fieldLabel: string;
	readonly renamed: boolean;
}

export interface SkippedOnePasswordImport {
	readonly vaultId: string;
	readonly vaultName: string;
	readonly itemId: string;
	readonly itemTitle: string;
	readonly reason: string;
}

export interface OnePasswordImportError {
	readonly vaultId: string;
	readonly vaultName: string;
	readonly itemId: string;
	readonly itemTitle: string;
	readonly error: string;
}

export interface OnePasswordImportResult {
	readonly vaultsScanned: number;
	readonly itemsScanned: number;
	readonly importedCount: number;
	readonly skippedCount: number;
	readonly errorCount: number;
	readonly imported: readonly ImportedOnePasswordSecret[];
	readonly skipped: readonly SkippedOnePasswordImport[];
	readonly errors: readonly OnePasswordImportError[];
}

export interface OnePasswordField {
	readonly id: string;
	readonly label: string;
	readonly value: string;
	readonly type: string;
	readonly purpose: string;
}

interface OnePasswordItemSummary {
	readonly id: string;
	readonly title: string;
	readonly vaultId: string;
}

interface OnePasswordItemDetails {
	readonly id: string;
	readonly title: string;
	readonly fields: readonly OnePasswordField[];
}

interface OnePasswordClient {
	resolveSecret(reference: string): Promise<string>;
	listVaults(): Promise<readonly OnePasswordVault[]>;
	listItems(vaultId: string): Promise<readonly OnePasswordItemSummary[]>;
	getItem(vaultId: string, itemId: string): Promise<OnePasswordItemDetails>;
}

export type OnePasswordClientFactory = (token: string) => Promise<OnePasswordClient>;

export interface ImportOnePasswordSecretsOptions {
	readonly token: string;
	readonly vaults?: readonly string[];
	readonly prefix?: string;
	readonly overwrite?: boolean;
	readonly hasSecret: (name: string) => boolean;
	readonly putSecret: (name: string, value: string) => Promise<void>;
	readonly clientFactory?: OnePasswordClientFactory;
}

export function isOnePasswordReference(secretName: string): boolean {
	return secretName.startsWith(SECRET_REF_PREFIX);
}

export async function readOnePasswordReference(
	reference: string,
	token: string,
	clientFactory: OnePasswordClientFactory = defaultOnePasswordClientFactory,
): Promise<string> {
	if (!isOnePasswordReference(reference)) {
		throw new Error(`Invalid 1Password reference '${reference}'. Expected format: op://vault/item/field`);
	}

	const client = await clientFactory(token);
	return client.resolveSecret(reference);
}

export async function listOnePasswordVaults(
	token: string,
	clientFactory: OnePasswordClientFactory = defaultOnePasswordClientFactory,
): Promise<readonly OnePasswordVault[]> {
	const client = await clientFactory(token);
	return client.listVaults();
}

export function buildImportedSecretName(
	prefix: string,
	vaultName: string,
	itemTitle: string,
	fieldLabel: string,
): string {
	const safePrefix = sanitizeSegment(prefix) || "OP";
	const safeVault = sanitizeSegment(vaultName) || "VAULT";
	const safeItem = sanitizeSegment(itemTitle) || "ITEM";
	const safeField = sanitizeSegment(fieldLabel) || "PASSWORD";

	const candidate = [safePrefix, safeVault, safeItem, safeField].filter((segment) => segment.length > 0).join("_");

	if (SECRET_NAME_RE.test(candidate)) return candidate;
	return `_${candidate}`;
}

export function extractSecretFieldsFromItem(fields: readonly OnePasswordField[]): readonly OnePasswordField[] {
	const scored = fields
		.map((field) => ({
			field,
			score: fieldScore(field),
		}))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score);

	return scored.map((entry) => entry.field);
}

export async function importOnePasswordSecrets(
	options: ImportOnePasswordSecretsOptions,
): Promise<OnePasswordImportResult> {
	const token = options.token.trim();
	if (!token) {
		throw new Error("1Password service account token is required");
	}

	const clientFactory = options.clientFactory ?? defaultOnePasswordClientFactory;
	const client = await clientFactory(token);

	const overwrite = options.overwrite === true;
	const prefix = options.prefix?.trim() || "OP";

	const allVaults = await client.listVaults();
	const selectedVaults = selectVaults(allVaults, options.vaults);

	const imported: ImportedOnePasswordSecret[] = [];
	const skipped: SkippedOnePasswordImport[] = [];
	const errors: OnePasswordImportError[] = [];
	const usedNames = new Set<string>();

	let itemsScanned = 0;

	for (const vault of selectedVaults) {
		const items = await client.listItems(vault.id);

		for (const item of items) {
			itemsScanned += 1;
			try {
				const details = await client.getItem(vault.id, item.id);
				const secretFields = extractSecretFieldsFromItem(details.fields);

				if (secretFields.length === 0) {
					skipped.push({
						vaultId: vault.id,
						vaultName: vault.name,
						itemId: item.id,
						itemTitle: item.title,
						reason: "No password-like fields found",
					});
					continue;
				}

				for (const field of secretFields) {
					const baseSecretName = buildImportedSecretName(prefix, vault.name, details.title, field.label);

					const secretName = resolveSecretName({
						baseName: baseSecretName,
						overwrite,
						hasSecret: options.hasSecret,
						usedNames,
					});

					await options.putSecret(secretName, field.value);
					imported.push({
						secretName,
						baseSecretName,
						vaultId: vault.id,
						vaultName: vault.name,
						itemId: item.id,
						itemTitle: details.title,
						fieldId: field.id,
						fieldLabel: field.label,
						renamed: secretName !== baseSecretName,
					});
				}
			} catch (error) {
				errors.push({
					vaultId: vault.id,
					vaultName: vault.name,
					itemId: item.id,
					itemTitle: item.title,
					error: errorMessage(error),
				});
			}
		}
	}

	return {
		vaultsScanned: selectedVaults.length,
		itemsScanned,
		importedCount: imported.length,
		skippedCount: skipped.length,
		errorCount: errors.length,
		imported,
		skipped,
		errors,
	};
}

export async function defaultOnePasswordClientFactory(token: string): Promise<OnePasswordClient> {
	if (!token.trim()) {
		throw new Error("OP_SERVICE_ACCOUNT_TOKEN is required");
	}

	// Dynamic import — avoids loading WASM at daemon startup
	const { createClient } = await import("@1password/sdk");

	const rawClient = await createClient({
		auth: token,
		integrationName: INTEGRATION_NAME,
		integrationVersion: INTEGRATION_VERSION,
	});

	const client = toObject(rawClient);
	if (!client) {
		throw new Error("1Password SDK returned invalid client object");
	}

	const secrets = toObject(client.secrets);
	const vaults = toObject(client.vaults);
	const items = toObject(client.items);

	if (!secrets || !vaults || !items) {
		throw new Error("1Password SDK client is missing expected APIs");
	}

	const resolveSecretFn = readMethod(secrets, "resolve");
	const listVaultsFn = readMethod(vaults, "list") ?? readMethod(vaults, "listAll");
	const listItemsFn = readMethod(items, "list") ?? readMethod(items, "listAll");
	const getItemFn = readMethod(items, "get");

	if (!resolveSecretFn || !listVaultsFn || !listItemsFn || !getItemFn) {
		throw new Error("1Password SDK does not expose required methods");
	}

	return {
		async resolveSecret(reference: string): Promise<string> {
			const resolved = await resolveSecretFn(reference);
			if (typeof resolved !== "string") {
				throw new Error("1Password SDK resolve returned non-string secret value");
			}
			return resolved;
		},

		async listVaults(): Promise<readonly OnePasswordVault[]> {
			const result = await listVaultsFn();
			if (!Array.isArray(result)) {
				throw new Error("Unexpected response from 1Password SDK vault list");
			}

			const parsed: OnePasswordVault[] = [];
			for (const entry of result) {
				const obj = toObject(entry);
				if (!obj) continue;
				const id = readString(obj.id);
				const name = readString(obj.name);
				if (!id || !name) continue;
				parsed.push({ id, name });
			}

			return parsed;
		},

		async listItems(vaultId: string): Promise<readonly OnePasswordItemSummary[]> {
			const result = await listItemsFn(vaultId);
			if (!Array.isArray(result)) {
				throw new Error(`Unexpected response from 1Password SDK item list for vault '${vaultId}'`);
			}

			const parsed: OnePasswordItemSummary[] = [];
			for (const entry of result) {
				const obj = toObject(entry);
				if (!obj) continue;
				const id = readString(obj.id);
				if (!id) continue;
				const title = readString(obj.title) ?? id;
				const itemVaultId = readString(obj.vaultId) ?? vaultId;
				parsed.push({ id, title, vaultId: itemVaultId });
			}

			return parsed;
		},

		async getItem(vaultId: string, itemId: string): Promise<OnePasswordItemDetails> {
			const result = await getItemFn(vaultId, itemId);
			const obj = toObject(result);
			if (!obj) {
				throw new Error(`Unexpected response from 1Password SDK item get for item '${itemId}'`);
			}

			const fieldsRaw = Array.isArray(obj.fields) ? obj.fields : [];
			const fields: OnePasswordField[] = [];

			for (const fieldRaw of fieldsRaw) {
				const field = toObject(fieldRaw);
				if (!field) continue;

				const value = readString(field.value);
				if (!value) continue;

				const id = readString(field.id) ?? "field";
				const title = readString(field.title);
				const label = readString(field.label) ?? title ?? id;
				const type = readString(field.type) ?? "";
				const purpose = readString(field.purpose) ?? "";

				fields.push({ id, label, value, type, purpose });
			}

			return {
				id: readString(obj.id) ?? itemId,
				title: readString(obj.title) ?? itemId,
				fields,
			};
		},
	};
}

function fieldScore(field: OnePasswordField): number {
	let score = 0;
	const purpose = field.purpose.toUpperCase();
	const type = field.type.toUpperCase();
	const label = field.label.toLowerCase();

	if (purpose === "PASSWORD") score += 4;
	if (type === "CONCEALED") score += 3;

	if (
		label.includes("password") ||
		label.includes("passphrase") ||
		label.includes("secret") ||
		label.includes("token") ||
		label.includes("api key") ||
		label.includes("apikey")
	) {
		score += 2;
	}

	return score;
}

function sanitizeSegment(value: string): string {
	return value
		.trim()
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, "_")
		.replace(/_{2,}/g, "_")
		.replace(/^_+|_+$/g, "");
}

function toObject(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function readMethod(
	target: Record<string, unknown>,
	methodName: string,
): ((...args: readonly unknown[]) => Promise<unknown>) | null {
	const method = target[methodName];
	if (typeof method !== "function") return null;

	return async (...args: readonly unknown[]) => {
		const result = Reflect.apply(method, target, args);
		return Promise.resolve(result);
	};
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function selectVaults(
	allVaults: readonly OnePasswordVault[],
	requestedVaults: readonly string[] | undefined,
): readonly OnePasswordVault[] {
	if (!requestedVaults || requestedVaults.length === 0) {
		return allVaults;
	}

	const selected: OnePasswordVault[] = [];
	const seen = new Set<string>();

	for (const requested of requestedVaults) {
		const needle = requested.trim();
		if (!needle) continue;

		const match = allVaults.find((vault) => vault.id === needle || vault.name.toLowerCase() === needle.toLowerCase());

		if (!match) {
			throw new Error(`1Password vault not found: '${needle}'`);
		}

		if (!seen.has(match.id)) {
			selected.push(match);
			seen.add(match.id);
		}
	}

	if (selected.length === 0) {
		throw new Error("No matching 1Password vaults selected");
	}

	return selected;
}

function resolveSecretName(options: {
	readonly baseName: string;
	readonly overwrite: boolean;
	readonly hasSecret: (name: string) => boolean;
	readonly usedNames: Set<string>;
}): string {
	const { baseName, overwrite, hasSecret, usedNames } = options;

	if (!usedNames.has(baseName) && (overwrite || !hasSecret(baseName))) {
		usedNames.add(baseName);
		return baseName;
	}

	let suffix = 2;
	while (true) {
		const candidate = `${baseName}_${suffix}`;
		if (!usedNames.has(candidate) && !hasSecret(candidate)) {
			usedNames.add(candidate);
			return candidate;
		}
		suffix += 1;
	}
}
