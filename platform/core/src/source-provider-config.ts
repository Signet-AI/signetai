import { homedir, platform } from "node:os";
import { basename, resolve } from "node:path";

export type SignetSourceProviderSettings = Readonly<Record<string, unknown>>;

export interface WebSourceSettings {
	readonly url: string;
}

export interface AddWebSourceInput {
	readonly url: string;
	readonly name?: string;
	readonly now?: string;
}

export type DiscordSourceSyncMode = "rest" | "gateway-tail" | "desktop-cache";
export type GitHubSourceResourceType = "issues" | "pulls" | "discussions" | "docs";
export type GitHubSourceState = "open" | "closed" | "all";

export interface DiscordSourceSettings {
	readonly guildIds: readonly string[];
	readonly tokenRef: string;
	readonly desktopCachePath?: string;
	readonly desktopCacheFullScan: boolean;
	readonly channelFilter?: readonly string[];
	readonly maxMessagesPerChannel: number;
	readonly includeThreads: boolean;
	readonly includeArchivedThreads: boolean;
	readonly includePrivateArchivedThreads: boolean;
	readonly includeMembers: boolean;
	readonly includeAttachments: boolean;
	readonly includeAttachmentText: boolean;
	readonly maxAttachmentTextBytes: number;
	readonly includeEmbeds: boolean;
	readonly includePolls: boolean;
	readonly includeThreadMembers: boolean;
	readonly since?: string;
	readonly syncMode: DiscordSourceSyncMode;
}

export interface AddDiscordSourceInput {
	readonly guildIds?: readonly string[];
	readonly tokenRef?: string;
	readonly desktopCachePath?: string;
	readonly desktopCacheFullScan?: boolean;
	readonly name?: string;
	readonly channelFilter?: readonly string[];
	readonly maxMessagesPerChannel?: number;
	readonly includeThreads?: boolean;
	readonly includeArchivedThreads?: boolean;
	readonly includePrivateArchivedThreads?: boolean;
	readonly includeMembers?: boolean;
	readonly includeAttachments?: boolean;
	readonly includeAttachmentText?: boolean;
	readonly maxAttachmentTextBytes?: number;
	readonly includeEmbeds?: boolean;
	readonly includePolls?: boolean;
	readonly includeThreadMembers?: boolean;
	readonly since?: string;
	readonly syncMode?: DiscordSourceSyncMode;
	readonly now?: string;
}

export interface GitHubSourceSettings {
	readonly repos: readonly string[];
	readonly tokenRef?: string;
	readonly resourceTypes: readonly GitHubSourceResourceType[];
	readonly state: GitHubSourceState;
	readonly includeComments: boolean;
	readonly labels?: readonly string[];
	readonly docPaths: readonly string[];
	readonly maxItemsPerRepo: number;
}

export interface AddGitHubSourceInput {
	readonly repos: readonly string[];
	readonly tokenRef?: string;
	readonly name?: string;
	readonly resourceTypes?: readonly GitHubSourceResourceType[];
	readonly state?: GitHubSourceState;
	readonly includeComments?: boolean;
	readonly labels?: readonly string[];
	readonly docPaths?: readonly string[];
	readonly maxItemsPerRepo?: number;
	readonly now?: string;
}

export const DEFAULT_DISCORD_MAX_MESSAGES_PER_CHANNEL = 1000;
export const MAX_DISCORD_MAX_MESSAGES_PER_CHANNEL = 10_000;
export const DEFAULT_DISCORD_MAX_ATTACHMENT_TEXT_BYTES = 262_144;
export const MAX_DISCORD_MAX_ATTACHMENT_TEXT_BYTES = 1_048_576;
export const DEFAULT_DISCORD_DESKTOP_CACHE_PATH = defaultDiscordDesktopCachePath();
export const DEFAULT_GITHUB_RESOURCE_TYPES = ["issues", "pulls", "discussions", "docs"] as const;
export const DEFAULT_GITHUB_RESOURCE_TYPES_NO_TOKEN = ["issues", "pulls", "docs"] as const;
export const DEFAULT_GITHUB_DOC_PATHS = ["README.md", "CHANGELOG.md"] as const;
export const DEFAULT_GITHUB_MAX_ITEMS_PER_REPO = 500;
export const MAX_GITHUB_MAX_ITEMS_PER_REPO = 10_000;
const VALID_GITHUB_RESOURCE_TYPES = new Set<string>(DEFAULT_GITHUB_RESOURCE_TYPES);

export function parseDiscordSettings(raw?: SignetSourceProviderSettings): DiscordSourceSettings {
	const guildIds = Array.isArray(raw?.guildIds) ? cleanStringArray(raw.guildIds) : [];
	const tokenRef = typeof raw?.tokenRef === "string" ? raw.tokenRef.trim() : "";
	const desktopCachePath = typeof raw?.desktopCachePath === "string" ? cleanLocalPath(raw.desktopCachePath) : undefined;
	const channelFilter = Array.isArray(raw?.channelFilter) ? cleanStringArray(raw.channelFilter) : undefined;
	const maxMessagesPerChannel =
		cleanPositiveInteger(raw?.maxMessagesPerChannel, MAX_DISCORD_MAX_MESSAGES_PER_CHANNEL) ??
		DEFAULT_DISCORD_MAX_MESSAGES_PER_CHANNEL;
	const since = typeof raw?.since === "string" ? cleanIsoDate(raw.since) : undefined;
	return {
		guildIds,
		tokenRef,
		...(desktopCachePath ? { desktopCachePath } : {}),
		desktopCacheFullScan: raw?.desktopCacheFullScan === true,
		...(channelFilter ? { channelFilter } : {}),
		maxMessagesPerChannel,
		includeThreads: raw?.includeThreads !== false,
		includeArchivedThreads: raw?.includeArchivedThreads !== false,
		includePrivateArchivedThreads: raw?.includePrivateArchivedThreads === true,
		includeMembers: raw?.includeMembers !== false,
		includeAttachments: raw?.includeAttachments !== false,
		includeAttachmentText: raw?.includeAttachmentText === true,
		maxAttachmentTextBytes:
			cleanPositiveInteger(raw?.maxAttachmentTextBytes, MAX_DISCORD_MAX_ATTACHMENT_TEXT_BYTES) ??
			DEFAULT_DISCORD_MAX_ATTACHMENT_TEXT_BYTES,
		includeEmbeds: raw?.includeEmbeds !== false,
		includePolls: raw?.includePolls !== false,
		includeThreadMembers: raw?.includeThreadMembers !== false,
		...(since ? { since } : {}),
		syncMode: isDiscordSyncMode(raw?.syncMode) ? raw.syncMode : "rest",
	};
}

export function parseGitHubSettings(raw?: SignetSourceProviderSettings): GitHubSourceSettings {
	const repos = Array.isArray(raw?.repos) ? cleanStringArray(raw.repos) : [];
	const tokenRef = typeof raw?.tokenRef === "string" ? raw.tokenRef.trim() || undefined : undefined;
	const resourceTypes =
		Array.isArray(raw?.resourceTypes) && raw.resourceTypes.every((type) => typeof type === "string")
			? raw.resourceTypes.filter((type): type is GitHubSourceResourceType => isGitHubResourceType(type))
			: tokenRef
				? [...DEFAULT_GITHUB_RESOURCE_TYPES]
				: [...DEFAULT_GITHUB_RESOURCE_TYPES_NO_TOKEN];
	const labels = Array.isArray(raw?.labels) ? cleanStringArray(raw.labels) : undefined;
	const docPaths = Array.isArray(raw?.docPaths)
		? cleanStringArray(raw.docPaths).filter(isSafeGitHubDocPath)
		: [...DEFAULT_GITHUB_DOC_PATHS];
	return {
		repos,
		...(tokenRef ? { tokenRef } : {}),
		resourceTypes: resourceTypes.length > 0 ? resourceTypes : [...DEFAULT_GITHUB_RESOURCE_TYPES_NO_TOKEN],
		state: isGitHubState(raw?.state) ? raw.state : "all",
		includeComments: raw?.includeComments !== false,
		...(labels && labels.length > 0 ? { labels } : {}),
		docPaths: docPaths.length > 0 ? docPaths : [...DEFAULT_GITHUB_DOC_PATHS],
		maxItemsPerRepo:
			cleanPositiveInteger(raw?.maxItemsPerRepo, MAX_GITHUB_MAX_ITEMS_PER_REPO) ?? DEFAULT_GITHUB_MAX_ITEMS_PER_REPO,
	};
}

export function parseWebSettings(raw?: SignetSourceProviderSettings): WebSourceSettings {
	const value = raw?.url;
	if (typeof value !== "string") throw new Error("Web source has no URL");
	const url = normalizePublicWebUrl(value);
	if (!url) throw new Error("Web source URL must be a public http(s) URL");
	return { url };
}

export function buildDiscordSettings(input: AddDiscordSourceInput): DiscordSourceSettings | { readonly error: string } {
	if (input.syncMode && !isDiscordSyncMode(input.syncMode))
		return { error: `Unsupported Discord sync mode: ${input.syncMode}` };
	const syncMode = input.syncMode ?? "rest";
	const guildIds = cleanStringArray(input.guildIds ?? []);
	if (syncMode !== "desktop-cache" && guildIds.length === 0)
		return { error: "At least one Discord guild ID is required" };
	for (const guildId of guildIds) {
		if (!isDiscordSnowflake(guildId)) return { error: `Invalid Discord guild ID: ${guildId}` };
	}
	const tokenRef = input.tokenRef?.trim() ?? "";
	if (syncMode !== "desktop-cache" && !tokenRef) return { error: "Discord tokenRef is required" };
	if (looksLikeRawDiscordToken(tokenRef))
		return { error: "Discord tokenRef must be a secret reference, not a raw token" };
	const desktopCachePath = cleanLocalPath(input.desktopCachePath) ?? DEFAULT_DISCORD_DESKTOP_CACHE_PATH;
	if (syncMode === "desktop-cache" && !looksLikeDiscordDesktopCacheRoot(desktopCachePath)) {
		return { error: "Discord desktopCachePath must point at a Discord Desktop data directory" };
	}
	const channelFilter = cleanStringArray(input.channelFilter ?? []);
	const maxMessagesPerChannel =
		cleanPositiveInteger(input.maxMessagesPerChannel, MAX_DISCORD_MAX_MESSAGES_PER_CHANNEL) ??
		DEFAULT_DISCORD_MAX_MESSAGES_PER_CHANNEL;
	if (input.maxMessagesPerChannel !== undefined && maxMessagesPerChannel !== input.maxMessagesPerChannel) {
		return {
			error: `Discord maxMessagesPerChannel must be an integer between 1 and ${MAX_DISCORD_MAX_MESSAGES_PER_CHANNEL}`,
		};
	}
	const maxAttachmentTextBytes =
		cleanPositiveInteger(input.maxAttachmentTextBytes, MAX_DISCORD_MAX_ATTACHMENT_TEXT_BYTES) ??
		DEFAULT_DISCORD_MAX_ATTACHMENT_TEXT_BYTES;
	if (input.maxAttachmentTextBytes !== undefined && maxAttachmentTextBytes !== input.maxAttachmentTextBytes) {
		return {
			error: `Discord maxAttachmentTextBytes must be an integer between 1 and ${MAX_DISCORD_MAX_ATTACHMENT_TEXT_BYTES}`,
		};
	}
	if (input.includeAttachmentText === true && input.includeAttachments === false)
		return { error: "Discord includeAttachmentText requires includeAttachments" };
	const since = cleanIsoDate(input.since);
	if (input.since !== undefined && since === undefined) return { error: "Discord since must be a valid ISO date" };

	return parseDiscordSettings({
		...input,
		guildIds,
		tokenRef,
		desktopCachePath: syncMode === "desktop-cache" ? desktopCachePath : undefined,
		channelFilter: channelFilter.length > 0 ? channelFilter : undefined,
		maxMessagesPerChannel,
		maxAttachmentTextBytes,
		since,
		syncMode,
	});
}

export function buildGitHubSettings(
	input: AddGitHubSourceInput,
	existing?: GitHubSourceSettings,
): GitHubSourceSettings | { readonly error: string } {
	const repos = input.repos !== undefined ? cleanStringArray(input.repos) : (existing?.repos ?? []);
	if (repos.length === 0) return { error: "At least one GitHub repo pattern is required" };
	for (const repo of repos) {
		if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_*.-]+$/.test(repo)) {
			return { error: `Invalid GitHub repo pattern: ${repo}. Expected owner/repo or owner/*` };
		}
	}
	const tokenRef = input.tokenRef !== undefined ? input.tokenRef.trim() || undefined : existing?.tokenRef;
	if (tokenRef && looksLikeRawGitHubToken(tokenRef)) {
		return { error: "GitHub tokenRef must be a secret reference, not a raw token" };
	}
	const resourceTypes = input.resourceTypes
		? [...input.resourceTypes]
		: existing?.resourceTypes?.length
			? [...existing.resourceTypes]
			: tokenRef
				? [...DEFAULT_GITHUB_RESOURCE_TYPES]
				: [...DEFAULT_GITHUB_RESOURCE_TYPES_NO_TOKEN];
	if (resourceTypes.length === 0) return { error: "GitHub resourceTypes must include at least one resource type" };
	const invalidTypes = resourceTypes.filter((type) => !isGitHubResourceType(type));
	if (invalidTypes.length > 0) {
		return {
			error: `Invalid GitHub resource types: ${invalidTypes.join(", ")}. Must be one of: ${[...DEFAULT_GITHUB_RESOURCE_TYPES].join(", ")}`,
		};
	}
	if (!tokenRef && resourceTypes.includes("discussions")) {
		return { error: "GitHub discussions require tokenRef because they use the GitHub GraphQL API" };
	}
	if (input.state !== undefined && !isGitHubState(input.state)) {
		return { error: "GitHub state must be one of: open, closed, all" };
	}
	if (input.includeComments !== undefined && typeof input.includeComments !== "boolean") {
		return { error: "GitHub includeComments must be a boolean" };
	}
	if (input.labels !== undefined && !isStringArray(input.labels)) {
		return { error: "GitHub labels must be an array of strings" };
	}
	if (input.docPaths !== undefined) {
		if (!isStringArray(input.docPaths)) return { error: "GitHub docPaths must be an array of strings" };
		const invalid = cleanStringArray(input.docPaths).filter((path) => !isSafeGitHubDocPath(path));
		if (invalid.length > 0) return { error: `Invalid GitHub docPaths: ${invalid.join(", ")}` };
	}
	if (input.maxItemsPerRepo !== undefined) {
		const maxItemsPerRepo = cleanPositiveInteger(input.maxItemsPerRepo, MAX_GITHUB_MAX_ITEMS_PER_REPO);
		if (maxItemsPerRepo !== input.maxItemsPerRepo) {
			return {
				error: `GitHub maxItemsPerRepo must be an integer between 1 and ${MAX_GITHUB_MAX_ITEMS_PER_REPO}`,
			};
		}
	}
	const labels = input.labels !== undefined ? cleanStringArray(input.labels) : existing?.labels;
	const docPaths =
		input.docPaths !== undefined
			? cleanStringArray(input.docPaths)
			: (existing?.docPaths ?? [...DEFAULT_GITHUB_DOC_PATHS]);
	return {
		repos,
		...(tokenRef ? { tokenRef } : {}),
		resourceTypes,
		state: input.state ?? existing?.state ?? "all",
		includeComments: input.includeComments ?? existing?.includeComments ?? true,
		...(labels && labels.length > 0 ? { labels } : {}),
		docPaths,
		maxItemsPerRepo: input.maxItemsPerRepo ?? existing?.maxItemsPerRepo ?? DEFAULT_GITHUB_MAX_ITEMS_PER_REPO,
	};
}

export function discordSettingsProviderSettings(settings: DiscordSourceSettings): SignetSourceProviderSettings {
	const { desktopCacheFullScan, ...providerSettings } = settings;
	return {
		...providerSettings,
		...(settings.syncMode === "desktop-cache" || desktopCacheFullScan ? { desktopCacheFullScan } : {}),
	};
}

export function githubSettingsProviderSettings(settings: GitHubSourceSettings): SignetSourceProviderSettings {
	return { ...settings };
}

export function normalizePublicWebUrl(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 2048) return null;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
	if (parsed.username || parsed.password || !parsed.hostname) return null;
	const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host === "local" ||
		host === "broadcasthost" ||
		host.endsWith(".local") ||
		host.endsWith(".internal") ||
		host.endsWith(".home.arpa") ||
		host.endsWith(".test") ||
		host.endsWith(".invalid") ||
		host === "metadata.google.internal" ||
		host === "metadata.google.com" ||
		isUnsafeWebIp(host)
	)
		return null;
	parsed.hostname = host;
	parsed.hash = "";
	return parsed.toString();
}

const NON_GLOBAL_IPV4_RANGES: readonly (readonly [number, number])[] = [
	[0x00000000, 0x00ffffff],
	[0x0a000000, 0x0affffff],
	[0x64400000, 0x647fffff],
	[0x7f000000, 0x7fffffff],
	[0xa9fe0000, 0xa9feffff],
	[0xac100000, 0xac1fffff],
	[0xc0000000, 0xc00000ff],
	[0xc0000200, 0xc00002ff],
	[0xc01fc400, 0xc01fc4ff],
	[0xc034c100, 0xc034c1ff],
	[0xc0586300, 0xc05863ff],
	[0xc0a80000, 0xc0a8ffff],
	[0xc0af3000, 0xc0af30ff],
	[0xc6120000, 0xc613ffff],
	[0xc6336400, 0xc63364ff],
	[0xcb007100, 0xcb0071ff],
	[0xe0000000, 0xffffffff],
];

const NON_GLOBAL_IPV6_RANGES: readonly (readonly [string, number])[] = [
	["::", 96],
	["::ffff:0:0", 96],
	["100::", 64],
	["100:0:0:1::", 64],
	["2001::", 23],
	["2001:0::", 32],
	["2001:1::", 32],
	["2001:2::", 48],
	["2001:3::", 32],
	["2001:4:112::", 48],
	["2001:8::", 32],
	["2001:10::", 28],
	["2001:20::", 28],
	["2001:30::", 28],
	["2001:db8::", 32],
	["3fff::", 20],
	["64:ff9b::", 96],
	["64:ff9b:1::", 48],
	["2620:4f:8000::", 48],
	["fc00::", 7],
	["fe80::", 10],
	["fec0::", 10],
	["ff00::", 8],
];

function isUnsafeWebIp(host: string): boolean {
	if (/^[0-9.]+$/.test(host)) {
		const address = parseIpv4Address(host);
		return address === null || isNonGlobalIpv4(address);
	}
	if (host.includes(":")) {
		const address = parseIpv6Address(host);
		return address === null || isNonGlobalIpv6(address);
	}
	return false;
}

function parseIpv4Address(host: string): number | null {
	const octets = host.split(".");
	if (octets.length !== 4) return null;
	let address = 0;
	for (const octet of octets) {
		if (!/^\d{1,3}$/.test(octet)) return null;
		const value = Number(octet);
		if (value > 255) return null;
		address = address * 256 + value;
	}
	return address;
}

function isNonGlobalIpv4(address: number): boolean {
	return NON_GLOBAL_IPV4_RANGES.some(([start, end]) => address >= start && address <= end);
}

function parseIpv6Address(host: string): bigint | null {
	const normalized = host.toLowerCase();
	if (normalized.includes("%")) return null;
	const sections = normalized.split("::");
	if (sections.length > 2) return null;
	const head = sections[0] ? parseIpv6Sections(sections[0].split(":"), sections.length === 1) : [];
	const tail = sections.length === 2 && sections[1] ? parseIpv6Sections(sections[1].split(":"), true) : [];
	if (head === null || tail === null) return null;
	const words =
		sections.length === 2
			? [...head, ...Array.from({ length: 8 - head.length - tail.length }, () => 0), ...tail]
			: [...head];
	if (words.length !== 8) return null;
	return words.reduce((address, word) => address * 0x10000n + BigInt(word), 0n);
}

function parseIpv6Sections(sections: readonly string[], allowIpv4Tail: boolean): number[] | null {
	const words: number[] = [];
	for (const [index, section] of sections.entries()) {
		if (section.includes(".")) {
			if (!allowIpv4Tail || index !== sections.length - 1) return null;
			const ipv4 = parseIpv4Address(section);
			if (ipv4 === null) return null;
			words.push(Math.floor(ipv4 / 0x10000), ipv4 % 0x10000);
			continue;
		}
		if (!/^[0-9a-f]{1,4}$/.test(section)) return null;
		words.push(Number.parseInt(section, 16));
	}
	return words;
}

function isNonGlobalIpv6(address: bigint): boolean {
	const globalUnicastStart = 0x20000000000000000000000000000000n;
	const globalUnicastEnd = 0x3fffffffffffffffffffffffffffffffn;
	if (address < globalUnicastStart || address > globalUnicastEnd) return true;
	if (NON_GLOBAL_IPV6_RANGES.some(([network, prefix]) => matchesIpv6Cidr(address, network, prefix))) return true;
	if (matchesIpv6Cidr(address, "2002::", 16)) {
		const embeddedIpv4 = Number((address >> 80n) & 0xffffffffn);
		if (isNonGlobalIpv4(embeddedIpv4)) return true;
	}
	return false;
}

function matchesIpv6Cidr(address: bigint, network: string, prefix: number): boolean {
	const parsedNetwork = parseIpv6Address(network);
	if (parsedNetwork === null) return false;
	const hostBits = 128 - prefix;
	const mask = ((1n << 128n) - 1n) ^ ((1n << BigInt(hostBits)) - 1n);
	return (address & mask) === (parsedNetwork & mask);
}

function cleanLocalPath(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? resolve(trimmed.replace(/^~(?=$|\/|\\)/, homedir())) : undefined;
}

function cleanStringArray(values: readonly unknown[]): readonly string[] {
	return Array.from(
		new Set(
			values
				.filter((value): value is string => typeof value === "string")
				.map((value) => value.trim())
				.filter(Boolean),
		),
	);
}

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isDiscordSnowflake(value: string): boolean {
	return /^\d{17,20}$/.test(value);
}

function looksLikeRawDiscordToken(value: string): boolean {
	const trimmed = value.trim();
	const withoutHeaderPrefix = trimmed.replace(/^authorization:\s*/i, "").trim();
	const withoutAuthScheme = withoutHeaderPrefix.replace(/^(bot|bearer)\s+/i, "").trim();
	if (withoutAuthScheme !== trimmed) return true;
	return (
		/^mfa\.[A-Za-z0-9_-]{20,}$/.test(withoutAuthScheme) ||
		/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}$/.test(withoutAuthScheme)
	);
}

function looksLikeRawGitHubToken(value: string): boolean {
	const trimmed = value.trim();
	const withoutHeaderPrefix = trimmed.replace(/^authorization:\s*/i, "").trim();
	const withoutAuthScheme = withoutHeaderPrefix.replace(/^(bearer|token)\s+/i, "").trim();
	if (withoutAuthScheme !== trimmed) return true;
	return (
		/^github_pat_[A-Za-z0-9_]{20,}$/.test(withoutAuthScheme) || /^gh[opsru]_[A-Za-z0-9_]{20,}$/.test(withoutAuthScheme)
	);
}

function cleanPositiveInteger(value: unknown, max: number): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) return undefined;
	return value;
}

function cleanIsoDate(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const ms = Date.parse(trimmed);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function isDiscordSyncMode(value: unknown): value is DiscordSourceSyncMode {
	return value === "rest" || value === "gateway-tail" || value === "desktop-cache";
}

function defaultDiscordDesktopCachePath(): string {
	switch (platform()) {
		case "darwin":
			return resolve(homedir(), "Library", "Application Support", "discord");
		case "win32":
			return resolve(process.env.APPDATA || resolve(homedir(), "AppData", "Roaming"), "discord");
		default:
			return resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config"), "discord");
	}
}

function looksLikeDiscordDesktopCacheRoot(value: string): boolean {
	const base = basename(value)
		.toLowerCase()
		.replace(/[\s_-]+/g, "");
	return ["discord", "discordcanary", "discordptb", "discorddevelopment", "vesktop"].includes(base);
}

function isGitHubResourceType(value: unknown): value is GitHubSourceResourceType {
	return typeof value === "string" && VALID_GITHUB_RESOURCE_TYPES.has(value);
}

function isGitHubState(value: unknown): value is GitHubSourceState {
	return value === "open" || value === "closed" || value === "all";
}

function isMarkdownDocPath(path: string): boolean {
	return path.toLowerCase().endsWith(".md");
}

function isMarkdownDocGlob(path: string): boolean {
	const lowered = path.toLowerCase();
	return lowered.endsWith("/*.md") || lowered.endsWith("/**/*.md");
}

function isSafeGitHubDocPath(value: string): boolean {
	const path = value.trim();
	if (!path) return false;
	if (path.startsWith("/") || path.includes("\\") || path.includes("?") || path.includes("#")) return false;
	if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return false;
	return isMarkdownDocPath(path) || isMarkdownDocGlob(path);
}
