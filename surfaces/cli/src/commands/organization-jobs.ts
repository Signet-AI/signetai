import { cliAgent, cliTarget, cliTransport } from "../lib/organization-target.js";
import { waitForOrganizationJob } from "./organization.js";

export async function runOrganizationOperatorJob(
	input: Readonly<{ action: string; options?: Readonly<Record<string, unknown>> }>,
	options: Readonly<{ wait?: unknown; json?: unknown }>,
): Promise<boolean> {
	if (!cliTarget()?.remote) return false;
	const transport = cliTransport();
	if (!transport) throw new Error("Organization transport is unavailable");
	const started = await transport.post<{ jobId: string }>("/api/org/operator/jobs", { ...input, agentId: cliAgent() });
	if (!/^job_[a-zA-Z0-9_-]{1,200}$/.test(started.jobId)) throw new Error("The instance returned an invalid job ID");
	const result = options.wait === true ? await waitForOrganizationJob(transport, started.jobId) : started;
	console.log(JSON.stringify(result, null, options.json === true ? undefined : 2));
	return true;
}
