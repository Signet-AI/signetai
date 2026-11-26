import { AsyncLocalStorage } from "node:async_hooks";

interface RecallCatalogue {
	names?: Promise<readonly string[]>;
}

const catalogue = new AsyncLocalStorage<RecallCatalogue>();

export function withRecallShardCatalogue<T>(read: () => Promise<T>): Promise<T> {
	return catalogue.getStore() ? read() : catalogue.run({}, read);
}

export function cachedRecallShardNames(load: () => Promise<readonly string[]>): Promise<readonly string[]> {
	const current = catalogue.getStore();
	if (!current) return load();
	return (current.names ??= load());
}
