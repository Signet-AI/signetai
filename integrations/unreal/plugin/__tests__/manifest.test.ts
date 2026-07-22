import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pluginRoot = join(root, "SignetUnreal");
const recallContract = JSON.parse(
	readFileSync(join(root, "../../../platform/core/contracts/recall-request-v1.json"), "utf8"),
);

function read(relativePath: string): string {
	return readFileSync(join(pluginRoot, relativePath), "utf8");
}

describe("Signet Unreal plugin", () => {
	it("has a valid code plugin descriptor", () => {
		const descriptor = JSON.parse(read("SignetUnreal.uplugin"));
		expect(descriptor.FriendlyName).toBe("Signet Unreal");
		expect(descriptor.CanContainContent).toBe(true);
		expect(descriptor.Modules).toContainEqual({
			Name: "SignetUnrealRuntime",
			Type: "Runtime",
			LoadingPhase: "Default",
		});
	});

	it("keeps required Unreal source files in place", () => {
		for (const relativePath of [
			"Source/SignetUnrealRuntime/SignetUnrealRuntime.Build.cs",
			"Source/SignetUnrealRuntime/Public/SignetAgentComponent.h",
			"Source/SignetUnrealRuntime/Public/SignetAsyncActions.h",
			"Source/SignetUnrealRuntime/Public/SignetUnrealClient.h",
			"Source/SignetUnrealRuntime/Public/SignetUnrealSettings.h",
			"Source/SignetUnrealRuntime/Public/SignetUnrealTypes.h",
			"Source/SignetUnrealRuntime/Private/SignetAgentComponent.cpp",
			"Source/SignetUnrealRuntime/Private/SignetAsyncActions.cpp",
			"Source/SignetUnrealRuntime/Private/SignetRecallRequest.cpp",
			"Source/SignetUnrealRuntime/Private/SignetRecallRequest.h",
			"Source/SignetUnrealRuntime/Private/Tests/SignetRecallRequestTest.cpp",
			"Source/SignetUnrealRuntime/Private/SignetUnrealClient.cpp",
			"Source/SignetUnrealRuntime/Private/SignetUnrealRuntimeModule.cpp",
		]) {
			expect(existsSync(join(pluginRoot, relativePath))).toBe(true);
		}
	});

	it("keeps intentional NPC recall overrides aligned with the shared contract", () => {
		const requestHeader = read("Source/SignetUnrealRuntime/Private/SignetRecallRequest.h");
		const unreal = recallContract.overrides.unreal;
		expect(requestHeader).toContain(`DefaultNpcLimit = ${unreal.defaultLimit}`);
		expect(requestHeader).toContain(`MinimumNpcLimit = ${unreal.minimumLimit}`);
		expect(requestHeader).toContain(`MaximumNpcLimit = ${unreal.maximumLimit}`);
		expect(read("Source/SignetUnrealRuntime/Private/SignetRecallRequest.cpp")).toContain(
			'Body->SetBoolField(TEXT("includeRecalled"), true)',
		);
	});

	it("uses the existing Signet daemon API surface", () => {
		const client = read("Source/SignetUnrealRuntime/Private/SignetUnrealClient.cpp");
		const actions = read("Source/SignetUnrealRuntime/Private/SignetAsyncActions.cpp");
		expect(client).toContain("http://127.0.0.1:3850");
		expect(actions).toContain("/health");
		expect(actions).toContain("/api/memory/remember");
		expect(actions).toContain("/api/memory/recall");
		expect(actions).toContain("FGuid::NewGuid()");
		expect(client).toContain("world:");
		expect(client).toContain(":player:");
	});
});
