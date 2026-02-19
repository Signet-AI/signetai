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

async function getAllMemories(): Promise<{
	memories: Memory[];
	stats: MemoryStats;
}> {
	const pageSize = 250;
	const firstPage = await getMemories(pageSize, 0);
	const total = firstPage.stats.total;

	if (total <= firstPage.memories.length) {
		return firstPage;
	}

	const memories = [...firstPage.memories];
	let offset = firstPage.memories.length;

	while (offset < total) {
		const page = await getMemories(pageSize, offset);
		if (page.memories.length === 0) {
			break;
		}

		memories.push(...page.memories);
		offset += page.memories.length;
	}

	return {
		memories,
		stats: firstPage.stats,
	};
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
