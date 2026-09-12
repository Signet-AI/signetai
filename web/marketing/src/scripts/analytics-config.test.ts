import { describe, expect, test } from "bun:test";
import {
	MARKETING_DEPLOYMENT,
	MARKETING_PRODUCTION_HOSTNAMES,
	isProductionMarketingHost,
	shouldEnableMarketingAnalytics,
} from "./analytics-config";

describe("marketing analytics host gate", () => {
	test("allows only the canonical production hosts", () => {
		expect(MARKETING_PRODUCTION_HOSTNAMES).toEqual(["signetai.sh", "www.signetai.sh"]);
		expect(isProductionMarketingHost("signetai.sh")).toBe(true);
		expect(isProductionMarketingHost("WWW.SIGNETAI.SH.")).toBe(true);
		expect(isProductionMarketingHost("localhost")).toBe(false);
		expect(isProductionMarketingHost("127.0.0.1")).toBe(false);
		expect(isProductionMarketingHost("preview.signetai.sh")).toBe(false);
		expect(isProductionMarketingHost("signetai.sh.example.com")).toBe(false);
	});

	test("requires both a production host and a configured API key", () => {
		expect(shouldEnableMarketingAnalytics("signetai.sh", "phc_test", "production")).toBe(true);
		expect(shouldEnableMarketingAnalytics("signetai.sh", "phc_test", "preview")).toBe(false);
		expect(shouldEnableMarketingAnalytics("signetai.sh", "   ", "production")).toBe(false);
		expect(shouldEnableMarketingAnalytics("localhost", "phc_test", "production")).toBe(false);
		expect(shouldEnableMarketingAnalytics("preview.signetai.sh", "phc_test", "production")).toBe(false);
	});

	test("marks captured events as production deployment", () => {
		expect(MARKETING_DEPLOYMENT).toBe("production");
	});
});
