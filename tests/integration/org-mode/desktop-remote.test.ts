import { expect, test } from "bun:test";
import { LoginStore, type LoginKeyring } from "@signet/sdk/node";
import { DesktopWorkspace, RemoteWorkspace } from "../../../surfaces/desktop/src/remote-workspace";
import { OrgDaemon } from "./daemon";
import { browser, request, success, until } from "./http";

test("desktop main-process remote boundary completes device login, shares CLI credentials and revokes without starting a local daemon", async () => {
	const daemon = await OrgDaemon.create();
	let localStarts = 0;
	let keyringValue: string | null = null;
	const keyring: LoginKeyring = {
		async get() {
			return keyringValue === null ? { state: "missing" } : { state: "found", value: keyringValue };
		},
		async set(value) {
			keyringValue = value;
			return { state: "found" };
		},
	};
	try {
		const claimed = await request(daemon.origin, "/api/org/claim", {}, "POST", {
			setupToken: await daemon.setupToken(),
			organizationName: "Desktop Fixture",
			admin: { username: "alice", displayName: "Alice", password: "disposable integration password" },
		});
		success(claimed, "Claim desktop fixture");
		const admin = browser(claimed);
		const workspace = new DesktopWorkspace(
			{ mode: "organization", origin: daemon.origin },
			{
				async ensureStarted() {
					localStarts++;
					throw new Error("Local daemon must not start");
				},
			},
		);
		await workspace.prepare();
		const options = { env: daemon.env, keyring };
		const cli = new LoginStore(daemon.origin, options);
		let verification = "";
		const desktop = new RemoteWorkspace(daemon.origin, {
			login: new LoginStore(daemon.origin, options),
			async openExternal(url) {
				verification = url;
			},
		});
		expect(await desktop.sessionStatus()).toMatchObject({ state: "signed-out" });
		const flow = await desktop.signIn();
		expect(flow.status.state).toBe("pending");
		expect(new URL(verification).searchParams.get("user_code")).toBe(flow.userCode);
		expect(JSON.stringify(flow)).not.toMatch(/deviceCode|accessToken|refreshToken/);
		success(
			await request(daemon.origin, "/api/auth/device/approve", admin, "POST", {
				userCode: flow.userCode,
				decision: "approve",
			}),
			"Approve desktop device",
		);
		await until(async () => (await desktop.pollSignIn()).state === "signed-in", "Desktop approved session", 15_000);
		const shared = await cli.load();
		expect(shared?.source).toBe("keychain");
		if (!shared) throw new Error("CLI did not observe desktop login");
		const response = await desktop.proxy(new Request("app://signet/api/auth/whoami"));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ authenticated: true, user: { displayName: "Alice" } });
		expect(localStarts).toBe(0);
		expect(() => workspace.assertLocal()).toThrow();
		expect(await desktop.signOut()).toMatchObject({ state: "signed-out" });
		expect(await cli.load()).toBeNull();
		expect((await request(daemon.origin, "/api/auth/sessions", { bearer: shared.credential.accessToken })).status).toBe(
			401,
		);
		expect(
			(await request(daemon.origin, "/api/auth/refresh", {}, "POST", { refreshToken: shared.credential.refreshToken }))
				.status,
		).toBe(401);
		console.log(
			JSON.stringify({
				probe: "desktop-remote",
				deviceApproved: true,
				proxyStatus: response.status,
				cliSharesLogin: true,
				localDaemonStarts: localStarts,
				revoked: true,
			}),
		);
	} finally {
		await daemon.dispose();
	}
}, 120_000);
