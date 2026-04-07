export interface BaseAgentMessage extends Record<string, unknown> {
	readonly role?: string;
	readonly customType?: string;
	readonly display?: boolean;
	readonly content?: unknown;
	readonly timestamp?: number;
}

export interface BaseSessionEntry extends Record<string, unknown> {
	readonly type?: string;
	readonly customType?: string;
	readonly content?: unknown;
	readonly message?: {
		readonly role?: string;
		readonly content?: unknown;
		readonly parts?: unknown;
	};
}

export interface BaseSessionHeader extends Record<string, unknown> {
	readonly id?: unknown;
	readonly cwd?: unknown;
	readonly project?: unknown;
	readonly workspace?: unknown;
}

export interface BaseReadonlySessionManager {
	getBranch(): ReadonlyArray<BaseSessionEntry> | undefined;
	getEntries(): ReadonlyArray<BaseSessionEntry> | undefined;
	getHeader(): BaseSessionHeader | undefined;
	getSessionFile(): string | undefined;
	getSessionId(): string | undefined;
}

export interface BaseExtensionContext {
	readonly cwd?: string;
	readonly sessionManager: BaseReadonlySessionManager;
}
