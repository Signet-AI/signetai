/** Minimal database surface available to every schema migration. */
export interface MigrationDb {
	exec(sql: string): void;
	prepare(sql: string): {
		run(...args: unknown[]): void;
		get(...args: unknown[]): Record<string, unknown> | undefined;
		all(...args: unknown[]): Record<string, unknown>[];
		finalize?: () => void;
	};
}

/** Schema artifacts used to detect migrations recorded without their effects. */
export interface MigrationArtifacts {
	readonly tables?: readonly string[];
	readonly columns?: readonly {
		readonly table: string;
		readonly column: string;
		/** Skip verification when the table itself does not exist. */
		readonly optional?: boolean;
	}[];
}

/** One ordered, append-only schema migration. */
export interface Migration {
	readonly version: number;
	readonly name: string;
	readonly up: (db: MigrationDb) => void;
	readonly artifacts?: MigrationArtifacts;
}
