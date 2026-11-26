import { z } from "zod";
import { attemptAsync } from "@signet/core";
import { oidcSchema } from "./auth/organization-settings-contract";
import { updateSettings, settings } from "./auth/organization-admin";
import { IdentityError } from "./auth/organization-store";
import type { Principal } from "./auth/principal";
import { operatorActor, operatorRequest } from "./operator-jobs";
import { putSecret, getSecret, deleteSecretFromActiveProvider } from "./secrets";
const inputSchema = oidcSchema
	.extend({ clientSecret: z.string().min(1).max(16384).optional() })
	.superRefine((value, context) => {
		if (Boolean(value.clientSecret) === Boolean(value.clientSecretRef))
			context.addIssue({ code: "custom", message: "Provide a secret reference or stdin secret, not both" });
	});
export async function setOrganizationSso(p: Principal, input: unknown) {
	const actor = operatorActor(p);
	await operatorRequest({ op: "authorize-global", actor });
	const { clientSecret, ...data } = inputSchema.parse(input);
	const generated = clientSecret ? `SIGNET_OIDC_${crypto.randomUUID().replaceAll("-", "")}` : undefined;
	const reference = generated ?? data.clientSecretRef;
	if (!reference) throw new IdentityError(400, "invalid_request");
	try {
		const stored = await attemptAsync(async () => {
			if (clientSecret)
				await putSecret(reference, clientSecret, {
					allowInteraction: false,
					signal: AbortSignal.timeout(10_000),
					onKeyringAuthorization: async () => {
						await operatorRequest({ op: "authorize-global", actor });
					},
				});
			const value = await getSecret(reference);
			if (!value || (clientSecret && value !== clientSecret)) throw new Error("verification_failed");
			return true;
		});
		if (!stored)
			throw new IdentityError(
				503,
				"secret_store_unavailable",
				"SSO secret storage is unavailable; unlock or configure the instance secret store on its host",
			);
		return await updateSettings(p, { oidc: { ...data, clientSecretRef: reference } });
	} catch (error) {
		if (generated) {
			const current = await attemptAsync(() => settings(p));
			if (!current)
				throw new IdentityError(
					503,
					"sso_publication_uncertain",
					"SSO configuration could not be verified; its staged secret was retained. Inspect the instance settings before retrying",
				);
			if (current.oidc?.clientSecretRef === generated) throw error;
			const removed = await attemptAsync(async () => {
				await deleteSecretFromActiveProvider(generated);
				return true;
			});
			if (!removed)
				throw new IdentityError(
					503,
					"sso_cleanup_incomplete",
					"SSO configuration failed and its staged secret could not be removed; inspect the instance secret store",
				);
		}
		throw error;
	}
}
