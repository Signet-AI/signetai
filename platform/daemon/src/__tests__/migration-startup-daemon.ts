import { mock } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { prepareOwnerDaemonFixture } from "./isolated-owner-daemon-fixture";

const { root } = await prepareOwnerDaemonFixture();
const db = new Database(join(root, "data", "signet.db"));
db.exec("DELETE FROM schema_migrations WHERE version=183");
db.close();
const client = await import("../db-owner-client");
const createClient = client.createDbOwnerClient;
mock.module("../db-owner-client", () => ({
	...client,
	createDbOwnerClient: (options: Parameters<typeof createClient>[0]) =>
		createClient({ ...options, workerPath: join(import.meta.dir, "migration-progress-worker.ts") }),
}));
await import("../daemon");
