export interface MigrationDb {
	exec(sql: string): void;
	prepare(sql: string): {
		run(...args: unknown[]): void;
		get(...args: unknown[]): Record<string, unknown> | undefined;
		all(...args: unknown[]): Record<string, unknown>[];
		finalize?: () => void;
	};
}
export interface MigrationArtifacts {
	readonly tables?: readonly string[];
	readonly indexes?: readonly string[];
	readonly columns?: readonly {
		readonly table: string;
		readonly column: string;
		readonly optional?: boolean;
	}[];
}
export interface Migration {
	readonly version: number;
	readonly name: string;
	readonly up: (db: MigrationDb) => void;
	readonly artifacts?: MigrationArtifacts;
}
