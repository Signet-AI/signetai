import { select, text, isCancel } from "@clack/prompts";
import { SignetError } from "../../../../libs/sdk/src/index.js";
export async function chooseSetupEntry(): Promise<{ host?: boolean; publicUrl?: string; join?: string }> {
	const choice = await select({
		message: "How would you like to use Signet?",
		options: [
			{ value: "personal", label: "Personal workspace", hint: "Set up Signet for yourself" },
			{ value: "host", label: "Host an organization", hint: "Create a team instance on this machine" },
			{ value: "join", label: "Join an organization", hint: "Sign in without changing your personal workspace" },
		],
	});
	if (isCancel(choice)) throw new SignetError("Setup cancelled; no workspace was changed", "cancelled");
	if (choice === "personal") return {};
	const url = await text({
		message: choice === "host" ? "Public URL for this organization instance" : "Organization instance URL",
		placeholder: "https://signet.example.com",
		validate: (value) => (value?.trim() ? undefined : "Enter an instance URL"),
	});
	if (isCancel(url)) throw new SignetError("Setup cancelled; no workspace was changed", "cancelled");
	return choice === "host" ? { host: true, publicUrl: url } : { join: url };
}
