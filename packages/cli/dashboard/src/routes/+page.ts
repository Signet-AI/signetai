/**
 * Client-side page load for the dashboard
 * All data is fetched from the daemon API
 */

import {
	type ConfigFile,
	type Harness,
	type Identity,
	type Memory,
	type MemoryStats,
	getConfigFiles,
	getHarnesses,
	getIdentity,
	getMemories,
} from "$lib/api";
import type { PageLoad } from "./$types";

export const ssr = false; // Disable SSR - this is a client-side app
export const prerender = false;

export interface PageData {
	identity: Identity;
	configFiles: ConfigFile[];
	memories: Memory[];
	memoryStats: MemoryStats;
	harnesses: Harness[];
}

async function getAllMemories(): Promise<{
	memories: Memory[];
	stats: MemoryStats;
}> {
	// Do not block initial dashboard render on a full-table memory scan.
	// The memory tab can search against the daemon, and the home tab only
	// needs a recent slice for summaries/insights.
	return getMemories(250, 0);
}

export const load: PageLoad = async (): Promise<PageData> => {
	const [identity, configFiles, memoryData, harnesses] = await Promise.all([
		getIdentity(),
		getConfigFiles(),
		getAllMemories(),
		getHarnesses(),
	]);

	return {
		identity,
		configFiles,
		memories: memoryData.memories,
		memoryStats: memoryData.stats,
		harnesses,
	};
};
