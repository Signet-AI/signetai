import { expect, test, spyOn } from "bun:test";
import { settleOffboardPurge } from "./organization-admin";
import { logger } from "../logger";
test("R5 offboarding failure persistence cannot escape as an unhandled rejection", async () => {
	const log = spyOn(logger, "error").mockImplementation(() => {});
	try {
		await expect(
			settleOffboardPurge(Promise.reject(new Error("owner unavailable")), "job_fixture"),
		).resolves.toBeUndefined();
		expect(log).toHaveBeenCalled();
	} finally {
		log.mockRestore();
	}
});
