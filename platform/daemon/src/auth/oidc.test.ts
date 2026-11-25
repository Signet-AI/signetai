import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { initDbAccessor, closeDbAccessor } from "../db-accessor";
import {
	ensureSetupToken,
	claimOrganization,
	organizationWrite,
	organizationQuery,
	statement,
} from "./organization-store";
import { oidcStart, oidcCallback } from "./oidc";
let dir = "";
beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "org-oidc-"));
	initDbAccessor(join(dir, "data.db"), { agentsDir: dir });
	const token = await ensureSetupToken();
	await claimOrganization({
		setupToken: token ?? "",
		organizationName: "Acme",
		admin: { username: "admin", displayName: "Admin", password: "test" },
	});
});
afterEach(async () => {
	await (await import("../db-owner-runtime")).closeDbOwner();
	Bun.gc(true);
	await closeDbAccessor();
	rmSync(dir, { recursive: true, force: true });
});
describe("OIDC identity", () => {
	test("PKCE, signed identity, domain JIT, nonce, one-use state, and idp groups", async () => {
		const { privateKey, publicKey } = await generateKeyPair("RS256");
		const jwk = await exportJWK(publicKey);
		let nonce = "";
		let verifier = "";
		let claimsGroups = ["engineering"];
		let issuer = "";
		let badNonce = false;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/.well-known/openid-configuration")
					return Response.json({
						issuer,
						authorization_endpoint: `${issuer}/authorize`,
						token_endpoint: `${issuer}/token`,
						jwks_uri: `${issuer}/jwks`,
					});
				if (url.pathname === "/jwks")
					return Response.json({ keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] });
				if (url.pathname === "/token") {
					const form = new URLSearchParams(await req.text());
					verifier = form.get("code_verifier") ?? "";
					return Response.json({
						id_token: await new SignJWT({
							email: "alice@acme.test",
							email_verified: true,
							name: "Alice",
							nonce: badNonce ? "wrong" : nonce,
							groups: claimsGroups,
						})
							.setProtectedHeader({ alg: "RS256", kid: "test-key" })
							.setIssuer(issuer)
							.setAudience("client")
							.setSubject("alice-subject")
							.setIssuedAt()
							.setExpirationTime("5m")
							.sign(privateKey),
					});
				}
				return new Response(null, { status: 404 });
			},
		});
		issuer = `http://127.0.0.1:${server.port}`;
		try {
			await organizationWrite([
				statement("UPDATE organization SET oidc_json = ?", [
					JSON.stringify({
						issuer,
						clientId: "client",
						allowedDomains: ["acme.test"],
						groupClaim: "groups",
						groupMap: { engineering: "grp_eng" },
					}),
				]),
				statement(
					"INSERT INTO groups (id,name,managed_by,idp_group) VALUES ('grp_eng','Engineering','idp','engineering')",
				),
			]);
			const start = await oidcStart("http://signet.test");
			const auth = new URL(start.url);
			nonce = auth.searchParams.get("nonce") ?? "";
			expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
			const session = await oidcCallback(
				{ state: start.state, code: "code", cookieState: start.state },
				"http://signet.test",
			);
			expect(session.user.username).toContain("alice");
			expect(verifier.length).toBeGreaterThan(40);
			expect(
				await organizationQuery(
					statement("SELECT group_id FROM group_members WHERE user_id = ?", [session.user.id], "all"),
				),
			).toEqual([{ group_id: "grp_eng" }]);
			await expect(
				oidcCallback({ state: start.state, code: "code", cookieState: start.state }, "http://signet.test"),
			).rejects.toThrow();
			claimsGroups = [];
			const again = await oidcStart("http://signet.test");
			nonce = new URL(again.url).searchParams.get("nonce") ?? "";
			const login = await oidcCallback(
				{ state: again.state, code: "code", cookieState: again.state },
				"http://signet.test",
			);
			expect(login.user.id).toBe(session.user.id);
			expect(
				await organizationQuery(
					statement("SELECT group_id FROM group_members WHERE user_id = ?", [session.user.id], "all"),
				),
			).toEqual([]);
			badNonce = true;
			const rejected = await oidcStart("http://signet.test");
			await expect(
				oidcCallback({ state: rejected.state, code: "code", cookieState: rejected.state }, "http://signet.test"),
			).rejects.toThrow();
		} finally {
			await server.stop(true);
		}
	});
});
