import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OrgDaemon, repo } from "./daemon";
import { Fixture } from "./fixture";
import { request, success } from "./http";

test("device login offers detected harnesses individually and keeps personal files and declined targets", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const fixture = await Fixture.create(daemon, "personal", false);
		const alice = fixture.user("alice");
		const personal = join(daemon.root, "personal");
		await mkdir(personal);
		const original = "agent:\n  name: Personal\n";
		await writeFile(join(personal, "agent.yaml"), original);
		await writeFile(join(personal, "AGENTS.md"), "Personal instructions\n");
		for (const [folder, file, value] of [
			[".claude", "settings.json", "{}"],
			[".codex", "config.toml", "model = 'fixture'\n"],
		]) {
			await mkdir(join(daemon.home, folder), { recursive: true });
			await writeFile(join(daemon.home, folder, file), value);
		}
		const script = join(daemon.root, "onboarding.ts");
		await writeFile(
			script,
			`
 import {Command} from ${JSON.stringify(Bun.resolveSync("commander", join(repo, "surfaces/cli")))};
 import {registerAuthCommands} from ${JSON.stringify(join(repo, "surfaces/cli/src/commands/auth.ts"))};
 import {onboardOrganizationHarnesses} from ${JSON.stringify(join(repo, "surfaces/cli/src/features/organization-onboarding.ts"))};
 import {saveDaemonLoginUrl,readDaemonUrlConfig} from ${JSON.stringify(join(repo, "surfaces/cli/src/lib/daemon.ts"))};
 import {ConnectorRegistry} from ${JSON.stringify(join(repo, "libs/sdk/src/node.ts"))};
 import {request,success} from ${JSON.stringify(join(repo, "tests/integration/org-mode/http.ts"))};
 const registry=new ConnectorRegistry();await registry.set("claude-code",{url:"http://127.0.0.1:1"});
 const printed=[];const questions=[];let report;let code="";
 const program=new Command();registerAuthCommands(program,{flagUrl:process.env.SIGNET_DAEMON_URL,keyring:{get:async()=>({state:"unsupported"}),set:async()=>({state:"unsupported"})},saveUrl:saveDaemonLoginUrl,print:value=>{printed.push(value);const match=value.match(/Enter code: ([A-Z0-9-]+)/);if(match)code=match[1];},openBrowser:async()=>{success(await request(process.env.SIGNET_DAEMON_URL,"/api/auth/device/approve",JSON.parse(process.env.APPROVAL),"POST",{userCode:code,decision:"approve"}),"approve");},afterLogin:async(context)=>{report=await onboardOrganizationHarnesses(context,{agentsDir:process.env.PERSONAL,interactive:true,print:value=>printed.push(value),confirm:async(question)=>{questions.push(question);return question.includes("Connect codex ");}});return report;}});
 await program.parseAsync(["login"],{from:"user"});
 console.log("PROOF:"+JSON.stringify({report,questions,printed,entries:await registry.read(),stored:readDaemonUrlConfig(process.env.PERSONAL)}));
 `,
		);
		const env = {
			...daemon.env,
			PERSONAL: personal,
			APPROVAL: JSON.stringify(alice.browser),
			SIGNET_API_KEY: "unrelated-fixture",
		};
		delete env.SIGNET_DAEMON_ENTRYPOINT;
		const child = Bun.spawn([process.execPath, script], { env, cwd: repo, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code, stderr).toBe(0);
		const proof = JSON.parse(
			stdout
				.split("\n")
				.find((line) => line.startsWith("PROOF:"))
				?.slice(6) ?? "null",
		);
		expect(proof).toMatchObject({ report: { state: "complete" } });
		expect(proof.report.agents.defaultWrite).toBe(alice.agentId);
		expect(proof.report.harnesses).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ harness: "claude-code", state: "kept-personal" }),
				expect.objectContaining({ harness: "codex", state: "connected" }),
			]),
		);
		expect(proof.questions.some((question: string) => question.includes("http://127.0.0.1:1"))).toBe(true);
		expect(proof.printed.some((line: string) => line.includes("organization can read it"))).toBe(true);
		expect(proof.entries["claude-code"].url).toBe("http://127.0.0.1:1");
		expect(proof.entries.codex.url).toBe(daemon.origin);
		expect(proof.stored).toBe(daemon.origin);
		expect(await readFile(join(personal, "agent.yaml"), "utf8")).toBe(original);
		expect(await readFile(join(daemon.home, ".claude/settings.json"), "utf8")).toBe("{}");
		const keys = success(await request(daemon.origin, "/api/auth/connector-keys", alice.session), "connector issuance");
		expect(Array.isArray(keys.keys)).toBe(true);
		expect(JSON.stringify(keys.keys)).toContain(proof.entries.codex.keyId);
	} finally {
		await daemon.dispose();
	}
}, 90_000);
