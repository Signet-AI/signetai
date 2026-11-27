import { createRequire } from "node:module";
import { attempt } from "@signet/core";
const require = createRequire(import.meta.url);
import { materializeEmbeddedNativeAddon } from "./native-runtime-assets";
let admittedScan: typeof import("@signet/native").scanAdmittedVectors | null | undefined;
export function ownerAdmittedScan(): typeof import("@signet/native").scanAdmittedVectors | undefined {
	if (admittedScan === undefined) {
		admittedScan =
			attempt(() => {
				const path = materializeEmbeddedNativeAddon("signet-native");
				const addon: typeof import("@signet/native") = require(path ?? "@signet/native");
				return typeof addon.scanAdmittedVectors === "function" ? addon.scanAdmittedVectors : null;
			}) ?? null;
	}
	return admittedScan ?? undefined;
}
