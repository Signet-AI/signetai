import { readFile } from "node:fs/promises";
import { ConnectorRegistry, NodeTransport, resolveTarget, writeKeyFile } from "../../libs/sdk/src/node";
const path = process.argv[2];
if (!path) throw new Error("Client configuration required");
const raw: unknown = JSON.parse(await readFile(path, "utf8"));
if (
	typeof raw !== "object" ||
	raw === null ||
	!("url" in raw) ||
	typeof raw.url !== "string" ||
	!("key" in raw) ||
	typeof raw.key !== "string" ||
	!("source" in raw) ||
	typeof raw.source !== "string" ||
	!("agentId" in raw) ||
	typeof raw.agentId !== "string"
)
	throw new Error("Invalid client configuration");
const keyFile = await writeKeyFile(raw.url, "codex", raw.key);
await new ConnectorRegistry().set("codex", { url: raw.url, keyFile, agentId: raw.agentId });
const target = await resolveTarget({ harness: "codex" });
if (!target.remote || target.url !== raw.url) throw new Error("Registry target was not remote");
const transport = new NodeTransport(target, { timeoutMs: 60_000, retries: 0 });
if (process.argv[3] === "resume") {
	const result = await transport.flush({ force: true, timeoutMs: 60_000 });
	if ("retained" in raw && raw.retained === true) {
		if (result.state !== "failed" || result.pending !== 1 || result.sent !== 0)
			throw new Error("Rejected source evidence was not retained");
	} else if (result.state !== "complete" || result.sent !== 1)
		throw new Error(`Resumed delivery did not complete: ${JSON.stringify(result)}`);
} else
	await transport.request("POST", "/api/hooks/session-end", {
		body: {
			harness: "codex",
			agentId: raw.agentId,
			sessionKey: "a21-resume-conformance",
			reason: "session_shutdown",
			transcriptPath: raw.source,
			transcript: "",
		},
	});
