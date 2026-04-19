import type { PluginRegistryRecord } from "$lib/api";

export function mergePluginRecord(
	current: PluginRegistryRecord,
	update: Partial<PluginRegistryRecord> & Pick<PluginRegistryRecord, "id">,
): PluginRegistryRecord {
	return current.id === update.id ? { ...current, ...update } : current;
}
