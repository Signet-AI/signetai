import type { Context, Next } from "hono";
import { admissionKey, type ConcurrencyAdmission, createConcurrencyAdmission } from "./concurrency-admission";

declare module "hono" {
	interface ContextVariableMap {
		stopAdmitted: boolean;
	}
}
const STOP_MAX_IN_FLIGHT = 8;
let stopAdmission: ConcurrencyAdmission = createConcurrencyAdmission(STOP_MAX_IN_FLIGHT);
export function __setStopAdmissionForTests(admission: ConcurrencyAdmission | null): void {
	stopAdmission = admission ?? createConcurrencyAdmission(STOP_MAX_IN_FLIGHT);
}
export async function withStopAdmission(c: Context, run: Next): Promise<Response | undefined> {
	if (c.get("stopAdmitted")) {
		await run();
		return;
	}
	const release = await stopAdmission.acquire(admissionKey(c), c.req.raw.signal);
	if (typeof release !== "function" || c.req.raw.signal.aborted) {
		if (typeof release === "function") release();
		c.header("Retry-After", String(typeof release === "function" ? 1 : release.retryAfter));
		return c.json(
			{
				error: `Too many concurrent stop hooks (max ${stopAdmission.maxInFlight}); retry shortly`,
				reason: "admission",
			},
			503,
		);
	}
	c.set("stopAdmitted", true);
	try {
		await run();
		return;
	} finally {
		c.set("stopAdmitted", false);
		release();
	}
}
