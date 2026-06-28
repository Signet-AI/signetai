// @ts-nocheck
import { describe, expect, it } from "bun:test";
import { skillIdentityKey, skillRenderKey } from "./skill-identity";

describe("skill identity keys", () => {
	it("uses server catalog keys when present", () => {
		expect(
			skillIdentityKey({
				name: "remember",
				fullName: "Signet-AI/signetai",
				catalogKey: "signet:Signet-AI/signetai:remember",
				installs: "built-in",
				description: "Save memories",
				installed: true,
				provider: "signet",
			}),
		).toBe("signet:Signet-AI/signetai:remember");
	});

	it("separates cached official skills that share the same install source", () => {
		const recall = {
			name: "recall",
			fullName: "Signet-AI/signetai",
			installs: "built-in",
			description: "Recall memories",
			installed: true,
			provider: "signet" as const,
		};
		const remember = { ...recall, name: "remember", description: "Save memories" };

		expect(skillIdentityKey(recall)).toBe("signet:Signet-AI/signetai:recall");
		expect(skillIdentityKey(remember)).toBe("signet:Signet-AI/signetai:remember");
	});

	it("adds the render index so exact duplicate rows cannot crash keyed each blocks", () => {
		const duplicate = {
			name: "web-search",
			fullName: "someone/skills@web-search",
			installs: "10",
			description: "Search",
			installed: false,
			provider: "skills.sh" as const,
		};

		expect(skillRenderKey(duplicate, 0)).not.toBe(skillRenderKey(duplicate, 1));
	});
});
