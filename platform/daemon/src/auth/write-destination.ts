import { attempt, type CompartmentWriteScope } from "@signet/core";
import type { LogSubject } from "../log-subject";
import { IdentityError } from "./organization-store";
import { classificationRequest } from "../classifications";

export async function admitWriteDestination(
	agentId: string,
	body: Readonly<Record<string, unknown>>,
	path: string,
	headerSession: string | undefined,
	routePattern?: string,
): Promise<LogSubject> {
	const scopes: CompartmentWriteScope[] = [{ agentId }];
	const add = (key: "sessionKey" | "sourceId", value: unknown) => {
		if (typeof value === "string" && value) scopes.push({ agentId, [key]: value });
	};
	add("sessionKey", headerSession);
	const provenance = typeof body.provenance === "object" && body.provenance !== null ? body.provenance : {};
	for (const item of [body, provenance]) {
		for (const key of ["sessionKey", "session_key", "sessionId", "session_id", "fromSessionKey"])
			add("sessionKey", Reflect.get(item, key));
		for (const key of ["sourceId", "source_id", "sourcePath", "source_path"]) add("sourceId", Reflect.get(item, key));
	}
	if (routePattern) {
		const index = routePattern.split("/").indexOf(":sourceId");
		const value = path.split("/")[index];
		if (value) {
			const decoded = attempt(() => decodeURIComponent(value));
			if (decoded === undefined) throw new IdentityError(400, "invalid_request");
			add("sourceId", decoded);
		}
	}
	return classificationRequest<LogSubject>({ op: "admit-write", scopes });
}
