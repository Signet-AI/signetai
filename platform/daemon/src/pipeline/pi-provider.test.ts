import { describe, expect, test } from "bun:test";
import { type Api, type Model, getModels } from "@earendil-works/pi-ai";
import { githubCopilotOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { resolvePiModel } from "./pi-provider";

describe("pi provider catalog models", () => {
	test("preserves the Codex responses API and registry metadata", () => {
		const model = getModels("openai-codex").find((candidate) => candidate.id === "gpt-5.4");
		expect(model).toBeDefined();
		const resolved = resolvePiModel({
			executor: "openai-codex",
			providerFamily: "openai-codex",
			model: "gpt-5.4",
			piModel: model as Model<Api>,
			apiKey: "oauth-access",
		});

		expect(resolved.piModel.api).toBe("openai-codex-responses");
		expect(resolved.piModel.baseUrl).toBe("https://chatgpt.com/backend-api");
		expect(resolved.apiKey).toBe("oauth-access");
	});

	test("preserves Copilot headers and applies credential-dependent model changes", () => {
		const models = getModels("github-copilot") as Model<Api>[];
		const modified = githubCopilotOAuthProvider.modifyModels?.(models, {
			refresh: "refresh",
			access: "tid=1;proxy-ep=proxy.enterprise.example.com;exp=9999999999",
			expires: Date.now() + 60_000,
		});
		const model = modified?.[0];
		expect(model).toBeDefined();
		if (!model) throw new Error("Copilot catalog model missing");
		const resolved = resolvePiModel({
			executor: "github-copilot",
			providerFamily: "github-copilot",
			model: model.id,
			piModel: model,
			apiKey: "copilot-access",
		});

		expect(resolved.piModel.baseUrl).toBe("https://api.enterprise.example.com");
		expect(resolved.piModel.headers?.["Copilot-Integration-Id"]).toBe("vscode-chat");
	});
});
