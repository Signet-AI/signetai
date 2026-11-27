import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { upgradePlanSchema } from "../organization-upgrade-contract";
import type { registerMcpTool } from "./tools";

export function registerOrganizationUpgradeTools(
	server: McpServer,
	register: typeof registerMcpTool,
	transport: (path: string, method?: string, body?: unknown) => Promise<unknown>,
): void {
	const jobId = z.string().min(1).max(200);
	const revision = z.string().min(1).max(100);
	register(
		server,
		"signet_org_upgrade",
		{
			title: "Upgrade a Legacy Team Workspace",
			description:
				"Preview and revise a legacy organization upgrade without changing ownership. Confirmation accepts only the saved revision and starts a bounded, audited, restart-resumable owner job. Evidence and authorship are retained. Requires unrestricted organization admin. Poll read until complete; acceptance is not completion.",
			inputSchema: z.discriminatedUnion("action", [
				z.object({ action: z.literal("inventory") }).strict(),
				z.object({ action: z.literal("read"), jobId }).strict(),
				z.object({ action: z.literal("preview"), plan: upgradePlanSchema }).strict(),
				z.object({ action: z.literal("revise"), jobId, revision, plan: upgradePlanSchema }).strict(),
				z.object({ action: z.literal("confirm"), jobId, revision, confirm: z.literal(true) }).strict(),
				z.object({ action: z.literal("cancel"), jobId, revision }).strict(),
				z.object({ action: z.literal("resume"), jobId, revision }).strict(),
			]),
		},
		async (input) => {
			if (input.action === "inventory") return transport("/api/org/upgrade");
			if (input.action === "preview") return transport("/api/org/upgrade/preview", "POST", input.plan);
			const path = `/api/org/upgrade/${encodeURIComponent(input.jobId)}`;
			if (input.action === "read") return transport(path);
			if (input.action === "revise") return transport(path, "PUT", { revision: input.revision, plan: input.plan });
			return transport(`${path}/${input.action}`, "POST", { revision: input.revision });
		},
	);
}
