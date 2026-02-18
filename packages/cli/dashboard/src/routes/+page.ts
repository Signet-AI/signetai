/**
 * Client-side page load for the dashboard
 * All data is fetched from the daemon API
 */

import type { PageLoad } from "./$types";
import {
	getConfigFiles,
	getIdentity,
	getMemories,
	getHarnesses,
	type ConfigFile,
	type Memory,
	type MemoryStats,
	type Identity,
	type Harness,
} from "$lib/api";

export const ssr = false; // Disable SSR - this is a client-side app
export const prerender = false;

export interface PageData {
	identity: Identity;
	configFiles: ConfigFile[];
	memories: Memory[];
	memoryStats: MemoryStats;
	harnesses: Harness[];
}

export const load: PageLoad = async (): Promise<PageData> => {
	const [identity, configFiles, memoryData, harnesses] = await Promise.all([
		getIdentity(),
		getConfigFiles(),
		getMemories(),
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
