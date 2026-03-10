import { parse, stringify } from "yaml";
import { SCHEMA_ID, SPEC_VERSION } from "./constants";
import type { AgentManifest } from "./types";

export function parseManifest(yaml: string): AgentManifest {
	return parse(yaml) as AgentManifest;
}

export function generateManifest(manifest: AgentManifest): string {
	const doc = {
		version: manifest.version || SPEC_VERSION,
		schema: manifest.schema || SCHEMA_ID,
		agent: manifest.agent,
		...(manifest.owner && { owner: manifest.owner }),
		...(manifest.auth && { auth: manifest.auth }),
		...(manifest.capabilities && { capabilities: manifest.capabilities }),
		...(manifest.harnessCompatibility && {
			harness_compatibility: manifest.harnessCompatibility,
		}),
		...(manifest.trust && { trust: manifest.trust }),
	};

	return stringify(doc);
}
