import { afterEach, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { DbOwnerAdmissionError, DbOwnerDeadlineError } from "./db-owner-client";
import { logger } from "./logger";
import { registerGlobalMiddleware } from "./middleware";

const spies: { mockRestore(): void }[] = [];
afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
});

function appThrowing(error: Error): Hono {
	const app = new Hono();
	registerGlobalMiddleware(app);
	app.post("/api/dream/trigger", () => {
		throw error;
	});
	return app;
}

test("an unavailable DB owner is a logged, retryable 503", async () => {
	const warn = spyOn(logger, "warn").mockImplementation(() => {});
	spies.push(warn);
	const error = new DbOwnerDeadlineError("db-owner-1-7", "dreaming.trigger was queued behind maintenance.slow");
	const response = await appThrowing(error).request("/api/dream/trigger", { method: "POST" });
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({ error: error.message, code: "DB_OWNER_DEADLINE" });
	expect(warn).toHaveBeenCalledWith(
		"api",
		"Request failed because the DB owner could not serve it",
		expect.objectContaining({ method: "POST", path: "/api/dream/trigger", code: "DB_OWNER_DEADLINE" }),
	);
});

test("other unhandled request errors are logged and stay 500", async () => {
	const failure = spyOn(logger, "error").mockImplementation(() => {});
	spies.push(failure);
	const budget = new DbOwnerAdmissionError("DB_OWNER_WORK_BUDGET", "over budget");
	const budgetResponse = await appThrowing(budget).request("/api/dream/trigger", { method: "POST" });
	expect(budgetResponse.status).toBe(500);
	expect(await budgetResponse.json()).toEqual({ error: "Internal server error" });
	const response = await appThrowing(new Error("boom")).request("/api/dream/trigger", { method: "POST" });
	expect(response.status).toBe(500);
	expect(await response.json()).toEqual({ error: "Internal server error" });
	expect(failure).toHaveBeenCalledTimes(2);
	expect(failure).toHaveBeenLastCalledWith("api", "Unhandled request error", expect.any(Error), {
		method: "POST",
		path: "/api/dream/trigger",
	});
});

test("an HTTPException keeps its own response", async () => {
	const failure = spyOn(logger, "error").mockImplementation(() => {});
	spies.push(failure);
	const response = await appThrowing(new HTTPException(401, { message: "token expired" })).request(
		"/api/dream/trigger",
		{ method: "POST", headers: { origin: "http://localhost:3850" } },
	);
	expect(response.status).toBe(401);
	expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3850");
	expect(await response.text()).toBe("token expired");
	expect(failure).not.toHaveBeenCalled();
});
