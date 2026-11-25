import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspaceLayout } from "@signet/core";
import { closeDbAccessor, initDbAccessor } from "../db-accessor";
import { closeDbOwner } from "../db-owner-runtime";
import { logger } from "../logger";
import { settleOffboardPurge } from "./organization-admin";
import { organizationQuery, organizationWrite, statement } from "./organization-store";

let dir = "";
beforeEach(async () => {
	await closeDbOwner();
	await closeDbAccessor();
	dir = mkdtempSync(join(tmpdir(), "org-purge-failure-"));
	initDbAccessor(resolveWorkspaceLayout(dir).database);
});
afterEach(async () => {
	await closeDbOwner();
	await closeDbAccessor();
	rmSync(dir, { recursive: true, force: true });
});
test("R5 offboarding failure persistence cannot escape as an unhandled rejection", async () => {
	await organizationWrite([statement("DROP TABLE org_jobs")]);
	const log = spyOn(logger, "error").mockImplementation(() => {});
	try {
		await expect(
			settleOffboardPurge(Promise.reject(new Error("owner unavailable")), "job_fixture"),
		).resolves.toBeUndefined();
		expect(log).toHaveBeenCalledWith("auth", "Offboarding failure could not be persisted", expect.any(Error), {
			jobId: "job_fixture",
		});
	} finally {
		log.mockRestore();
	}
});
test("R5 a healthy owner persists the offboarding failure without logging persistence failure", async () => {
	await organizationWrite([
		statement("INSERT INTO org_jobs(id,kind,status) VALUES ('job_fixture','offboard','running')"),
	]);
	const log = spyOn(logger, "error").mockImplementation(() => {});
	try {
		await settleOffboardPurge(Promise.reject(new Error("owner unavailable")), "job_fixture");
		expect(
			await organizationQuery(statement("SELECT status,error FROM org_jobs WHERE id='job_fixture'", [], "get")),
		).toEqual({ status: "failed", error: "owner unavailable" });
		expect(log).not.toHaveBeenCalled();
	} finally {
		log.mockRestore();
	}
});

test("R5 a missing job is a persistence failure even when a previous file left a healthy owner", async () => {
	const log = spyOn(logger, "error").mockImplementation(() => {});
	try {
		await expect(
			settleOffboardPurge(Promise.reject(new Error("owner unavailable")), "job_missing"),
		).resolves.toBeUndefined();
		expect(log).toHaveBeenCalledWith("auth", "Offboarding failure could not be persisted", expect.any(Error), {
			jobId: "job_missing",
		});
	} finally {
		log.mockRestore();
	}
});
